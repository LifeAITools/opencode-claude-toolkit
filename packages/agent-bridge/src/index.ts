/**
 * @life-ai-tools/agent-bridge — reusable socket control plane for Claude Code agents,
 * built on the official @anthropic-ai/claude-agent-sdk. See PROTOCOL.md.
 */
export { AgentHandle } from "./agent-handle.js";
export { AgentBridge, type AgentBridgeConfig } from "./agent-bridge.js";
export { BridgeServer, type BridgeServerOptions } from "./bridge-server.js";
export { InputStream } from "./input-stream.js";
export type {
  AgentIdentity,
  AgentSnapshot,
  AgentState,
  SpawnAgentOptions,
  MessageListener,
  SDKMessage,
  SDKUserMessage,
  Options,
  PermissionMode,
} from "./types.js";
