/**
 * AgentBridge — the control plane: a registry/router over {@link AgentHandle}s.
 *
 * Addresses agents by `sessionId` (canonical) and by `role` (organisational), spawns
 * and resumes them via the official SDK, and projects a control-board snapshot. This
 * is the SSOT seam: wire `onSnapshot` to mirror into CentralRegistry / SynqTask, and
 * use `addressByRole` so the wake-router / task assigner can deliver to a live agent.
 *
 * Transport-agnostic: the WebSocket/unix-socket exposure is a separate adapter
 * ({@link BridgeServer}) that drives this class.
 */
import { AgentHandle } from "./agent-handle.js";
import type {
  AgentSnapshot,
  Options,
  PermissionMode,
  SpawnAgentOptions,
} from "./types.js";

export interface AgentBridgeConfig {
  /** Default SDK options merged into every spawn (model, permissionMode, cwd, …). */
  defaultOptions?: Options;
  /** Called whenever any agent's state/snapshot changes (control-board / registry mirror). */
  onSnapshot?: (snapshot: AgentSnapshot) => void;
}

export class AgentBridge {
  private readonly agents = new Map<string, AgentHandle>(); // sessionId → handle
  private readonly config: AgentBridgeConfig;

  constructor(config: AgentBridgeConfig = {}) {
    this.config = config;
  }

  /** Spawn (or resume) an agent. Idempotent on sessionId — returns the existing one. */
  spawn(opts: SpawnAgentOptions): AgentHandle {
    const existing = this.agents.get(opts.sessionId);
    if (existing) return existing;

    const options: Options = {
      ...this.config.defaultOptions,
      ...opts.sdkOptions,
      // The SDK resolves session continuity from these; keep them authoritative.
      resume: opts.resume ? opts.sessionId : opts.sdkOptions?.resume,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    } as Options;

    const handle = new AgentHandle(
      { sessionId: opts.sessionId, role: opts.role, project: opts.project, cwd: opts.cwd },
      opts.resume ? undefined : opts.prompt,
      options,
    );
    this.agents.set(opts.sessionId, handle);
    // Emit snapshots on every output so the control board / registry stay fresh.
    handle.onMessage(() => this.config.onSnapshot?.(handle.snapshot()));
    this.config.onSnapshot?.(handle.snapshot());
    return handle;
  }

  /** Look up an agent by its canonical session id. */
  get(sessionId: string): AgentHandle | undefined {
    return this.agents.get(sessionId);
  }

  /** Resolve all live agents holding a given role (org-level addressing). */
  addressByRole(role: string): AgentHandle[] {
    return [...this.agents.values()].filter((a) => a.identity.role === role);
  }

  /** Deliver a message to a specific agent by session id. */
  send(sessionId: string, text: string): boolean {
    const a = this.agents.get(sessionId);
    if (!a) return false;
    a.send(text);
    return true;
  }

  /** Interrupt / set permission mode / set model — by session id. */
  async control(
    sessionId: string,
    op:
      | { kind: "interrupt" }
      | { kind: "permission"; mode: PermissionMode }
      | { kind: "model"; model?: string },
  ): Promise<boolean> {
    const a = this.agents.get(sessionId);
    if (!a) return false;
    if (op.kind === "interrupt") await a.interrupt();
    else if (op.kind === "permission") await a.setPermissionMode(op.mode);
    else await a.setModel(op.model);
    return true;
  }

  /** Stop and de-register an agent. */
  async stop(sessionId: string): Promise<void> {
    const a = this.agents.get(sessionId);
    if (!a) return;
    await a.stop();
    this.agents.delete(sessionId);
    this.config.onSnapshot?.(a.snapshot());
  }

  /** Control-board projection: every agent's identity + state. */
  board(): AgentSnapshot[] {
    return [...this.agents.values()].map((a) => a.snapshot());
  }

  /** Stop every agent (graceful shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.stop(id)));
  }
}
