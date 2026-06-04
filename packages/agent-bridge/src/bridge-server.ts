/**
 * BridgeServer — the SOCKET adapter over {@link AgentBridge}.
 *
 * A `ws` WebSocket server (bind to a TCP port OR a unix socket path). Each connection
 * is an agent control endpoint addressed by `?session=<id>`; the controller drives the
 * agent over the socket and receives its output stream. This is the socket control
 * plane: no tmux, addressing by session id, one connection per agent.
 *
 * Envelope (controller → bridge), one JSON object per WS message:
 *   { op:"attach" }                                  // subscribe to this session's output
 *   { op:"spawn", prompt?, role?, project?, cwd?, resume?, sdkOptions? }
 *   { op:"user", text }                              // feed a user turn
 *   { op:"interrupt" } | { op:"permission", mode } | { op:"model", model? }
 *   { op:"board" }                                   // request the control-board snapshot
 *
 * Envelope (bridge → controller):
 *   { event:"message", msg: SDKMessage }             // agent output (verbatim SDK msg)
 *   { event:"snapshot", snapshot } | { event:"board", board }
 *   { event:"ack", op } | { event:"error", error }
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { AgentBridge, type AgentBridgeConfig } from "./agent-bridge.js";

export interface BridgeServerOptions extends AgentBridgeConfig {
  /** Bind a TCP port (default 8790). */
  port?: number;
  /**
   * Attach to an existing http.Server. For a UNIX-SOCKET control plane, create
   * `http.createServer()` and `.listen(socketPath)`, then pass it here — that is the
   * "agent on a unix socket" deployment, addressed by `?session=<id>`.
   */
  server?: Server;
  /** Optional bearer token required on connect (mirrors the SDK's ingress-token auth). */
  authToken?: string;
}

export class BridgeServer {
  readonly bridge: AgentBridge;
  private wss: WebSocketServer;
  private readonly authToken?: string;

  constructor(opts: BridgeServerOptions = {}) {
    this.bridge = new AgentBridge(opts);
    this.authToken = opts.authToken;
    this.wss = new WebSocketServer(
      opts.server ? { server: opts.server } : { port: opts.port ?? 8790 },
    );
    this.wss.on("connection", (ws, req) =>
      this.onConnection(ws, req.url ?? "", this.authToken),
    );
  }

  private onConnection(ws: WebSocket, url: string, authToken?: string): void {
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    if (authToken && params.get("token") !== authToken) {
      ws.close(4401, "unauthorized");
      return;
    }
    const sessionId = params.get("session") ?? "";
    if (!sessionId) {
      ws.close(4400, "missing ?session=<id>");
      return;
    }
    const tx = (o: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
    };

    // Relay this agent's output stream to the socket (if/when it exists).
    let unsub: (() => void) | null = null;
    const attach = () => {
      const a = this.bridge.get(sessionId);
      if (a && !unsub) unsub = a.onMessage((msg) => tx({ event: "message", msg }));
    };
    attach();

    ws.on("message", async (raw) => {
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        return tx({ event: "error", error: "invalid json" });
      }
      try {
        switch (cmd.op) {
          case "attach":
            attach();
            return tx({ event: "ack", op: "attach" });
          case "spawn": {
            this.bridge.spawn({
              sessionId,
              prompt: cmd.prompt as string | undefined,
              role: cmd.role as string | undefined,
              project: cmd.project as string | undefined,
              cwd: cmd.cwd as string | undefined,
              resume: cmd.resume as boolean | undefined,
              sdkOptions: cmd.sdkOptions as never,
            });
            attach();
            return tx({ event: "ack", op: "spawn" });
          }
          case "user":
            this.bridge.send(sessionId, String(cmd.text ?? ""));
            return tx({ event: "ack", op: "user" });
          case "interrupt":
            await this.bridge.control(sessionId, { kind: "interrupt" });
            return tx({ event: "ack", op: "interrupt" });
          case "permission":
            await this.bridge.control(sessionId, { kind: "permission", mode: cmd.mode as never });
            return tx({ event: "ack", op: "permission" });
          case "model":
            await this.bridge.control(sessionId, { kind: "model", model: cmd.model as string | undefined });
            return tx({ event: "ack", op: "model" });
          case "board":
            return tx({ event: "board", board: this.bridge.board() });
          default:
            return tx({ event: "error", error: `unknown op: ${String(cmd.op)}` });
        }
      } catch (e) {
        tx({ event: "error", error: e instanceof Error ? e.message : String(e) });
      }
    });

    ws.on("close", () => unsub?.());
  }

  /** Hand a raw upgrade to the ws server (for the unix-socket / shared-server path). */
  handleUpgrade(...args: Parameters<WebSocketServer["handleUpgrade"]>): void {
    this.wss.handleUpgrade(...args);
  }

  async close(): Promise<void> {
    await this.bridge.stopAll();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
