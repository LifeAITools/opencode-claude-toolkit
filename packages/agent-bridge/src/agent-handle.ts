/**
 * AgentHandle — ONE controlled Claude Code agent, built on the official SDK `query()`.
 *
 * - Input: a push-based {@link InputStream} (streaming-input mode) so we can feed
 *   user messages mid-session (send / wake / task assignment).
 * - Output: the `Query` async-generator of `SDKMessage` is consumed in the background
 *   and re-broadcast to subscribers (sockets, recorders, the control board).
 * - Control: `interrupt` / `setPermissionMode` / `setModel` are forwarded to the live
 *   `Query` — the SDK speaks the stream-json control protocol; we never hand-roll it.
 */
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { InputStream } from "./input-stream.js";
import type {
  AgentIdentity,
  AgentSnapshot,
  AgentState,
  MessageListener,
  Options,
  PermissionMode,
  SDKMessage,
} from "./types.js";

export class AgentHandle {
  readonly identity: AgentIdentity;
  private readonly input = new InputStream();
  private query: Query | null = null;
  private listeners = new Set<MessageListener>();
  private state: AgentState = "starting";
  private readonly startedAt = Date.now();
  private lastMessageAt: number | null = null;
  private lastError: string | undefined;
  private pump: Promise<void> | null = null;

  constructor(identity: AgentIdentity, prompt: string | undefined, options: Options) {
    this.identity = identity;
    if (prompt) this.input.pushText(prompt, identity.sessionId);
    // Streaming input mode: prompt is the async-iterable; control methods become available.
    this.query = query({ prompt: this.input, options });
    this.pump = this.consume();
  }

  /** Background: drain the SDK output stream → broadcast. */
  private async consume(): Promise<void> {
    if (!this.query) return;
    this.state = "running";
    try {
      for await (const msg of this.query) {
        this.lastMessageAt = Date.now();
        if (msg.type === "result") this.state = "idle";
        for (const l of this.listeners) {
          try {
            l(msg);
          } catch {
            /* a bad subscriber must not kill the pump */
          }
        }
      }
      this.state = "stopped";
    } catch (e) {
      this.state = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Feed a user message to the agent (mid-session). */
  send(text: string): void {
    this.input.pushText(text, this.identity.sessionId);
    this.state = "running";
  }

  /** Subscribe to the agent's output messages. Returns an unsubscribe fn. */
  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Control: stop the current turn (SDK control_request: interrupt). */
  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Control: change permission mode (SDK control_request: set_permission_mode). */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.query?.setPermissionMode(mode);
  }

  /** Control: change model (SDK control_request: set_model). */
  async setModel(model?: string): Promise<void> {
    await this.query?.setModel(model);
  }

  /** Full init result (supported commands, models, account info). */
  async initializationResult() {
    return this.query?.initializationResult();
  }

  /** Stop the agent: close input, let the current turn finish, drop the query. */
  async stop(): Promise<void> {
    this.input.close();
    try {
      await this.query?.return?.(undefined as never);
    } catch {
      /* already finished */
    }
    this.state = "stopped";
    await this.pump?.catch(() => {});
  }

  snapshot(): AgentSnapshot {
    return {
      ...this.identity,
      state: this.state,
      startedAt: this.startedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    };
  }

  /** Re-broadcast a raw SDK message (used by the server adapter when relaying). */
  get currentState(): AgentState {
    return this.state;
  }

  /** Last output message timestamp (idle detection). */
  get idleSince(): number | null {
    return this.state === "idle" ? this.lastMessageAt : null;
  }

  /** Type guard re-export for consumers filtering the output stream. */
  static isResult(m: SDKMessage): boolean {
    return m.type === "result";
  }
}
