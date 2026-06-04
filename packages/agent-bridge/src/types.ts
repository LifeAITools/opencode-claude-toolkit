/**
 * Bridge types. We re-export the OFFICIAL SDK message/option types so consumers
 * speak exactly the SDK's protocol — never a parallel one.
 */
import type {
  SDKMessage,
  SDKUserMessage,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

export type { SDKMessage, SDKUserMessage, Options, PermissionMode };

/** Identity of a controlled agent. `sessionId` is the canonical address. */
export interface AgentIdentity {
  /** Claude Code session id (the SDK `--session-id`). Canonical routing key. */
  sessionId: string;
  /** Organisational role (e.g. SynqTask role). Optional control-plane metadata. */
  role?: string;
  /** Project / cwd this agent works in. */
  project?: string;
  /** Working directory the agent runs in. */
  cwd?: string;
}

/** Options to spawn/resume one agent. Forwarded verbatim to the SDK `query()`. */
export interface SpawnAgentOptions extends AgentIdentity {
  /** First prompt for a fresh agent. Omit when resuming. */
  prompt?: string;
  /** Resume an existing session (SDK `resume`). */
  resume?: boolean;
  /** Extra SDK options (model, permissionMode, canUseTool, hooks, mcpServers, …). */
  sdkOptions?: Options;
}

/** A subscriber to an agent's output message stream. */
export type MessageListener = (msg: SDKMessage) => void;

/** Lifecycle state of an AgentHandle. */
export type AgentState = "starting" | "running" | "idle" | "stopped" | "error";

/** Snapshot of an agent for the control board / registry projection. */
export interface AgentSnapshot extends AgentIdentity {
  state: AgentState;
  startedAt: number;
  lastMessageAt: number | null;
  lastError?: string;
}
