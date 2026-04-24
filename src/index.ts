export { ClaudeCodeSDK, FileCredentialStore, MemoryCredentialStore } from './sdk.js'
export { Conversation } from './conversation.js'
export { saveSession, loadSession } from './session.js'
export type {
  ClaudeCodeSDKOptions,
  GenerateOptions,
  GenerateResponse,
  StreamEvent,
  TokenUsage,
  RateLimitInfo,
  CredentialsFile,
  MessageParam,
  ContentBlockParam,
  TextBlockParam,
  ToolDef,
  ToolChoice,
  SystemParam,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ConversationOptions,
  TurnOptions,
  CredentialStore,
  StoredCredentials,
  TokenStatusEvent,
} from './types.js'
export {
  ClaudeCodeSDKError,
  AuthError,
  APIError,
  RateLimitError,
  CacheRewriteBlockedError,
} from './types.js'
export type { SessionEntry } from './session.js'

// KeepaliveEngine — extracted from sdk.ts, reusable in claude-max-proxy
// and other consumers needing cache-keepalive without full SDK machinery.
export { KeepaliveEngine } from './keepalive-engine.js'
export type { KeepaliveEngineOptions } from './keepalive-engine.js'

// ═══ Proxy ports + default adapters (Hybrid Architecture / Hex) ═════
//
// ProxyClient (not yet exported — added in Step 3) is the core orchestrator
// of subscription-based Anthropic proxying with cache keepalive. It depends
// on INTERFACES (ports) declared here; default implementations (adapters)
// provide the common zero-config case.
//
// Consumers:
//   - @kiberos/claude-max-proxy — wraps ProxyClient in HTTP server
//   - @life-ai-tools/opencode-claude — uses ProxyClient in-process (thin)
//   - programmatic SDK users — construct directly with custom adapters
//
// See src/proxy-ports.ts for the full port interface documentation.
export type {
  // Ports (interfaces consumers may implement)
  ICredentialsProvider,
  IEventEmitter,
  ISessionStore,
  IUpstreamFetcher,
  ILivenessChecker,
  // Types used by ports
  ProxyEvent,
  Session,
  ProxyClientAdapters,
} from './proxy-ports.js'

// Default adapters — zero-config implementations
export {
  FileCredentialsProvider,
  ConsoleEventEmitter,
  NullEventEmitter,
  InMemorySessionStore,
  DefaultLivenessChecker,
  NativeFetchUpstream,
} from './proxy-adapters.js'
export type {
  FileCredentialsProviderOptions,
  ConsoleEventEmitterOptions,
} from './proxy-adapters.js'

// ProxyClient — the core orchestrator. Consumers construct this with
// adapters (credentials + event emitter + session store) and use
// handleRequest() to process /v1/messages requests end-to-end.
export { ProxyClient } from './proxy-client.js'
export type {
  ProxyClientConfig,
  ProxyClientOptions,
  HandleRequestContext,
  RateLimitSnapshot,
} from './proxy-client.js'
export type {
  KeepaliveConfig,
  KeepaliveStats,
  KeepaliveTick,
} from './types.js'
export { oauthLogin } from './auth.js'
export { getClaudeConfigDir, getDefaultCredentialsPath } from './auth.js'
export type { OAuthLoginOptions, OAuthResult } from './auth.js'

// Model metadata SSOT — all max_tokens / model caps live here.
// See src/models.ts for rationale and override semantics.
export {
  MAX_MODELS,
  FALLBACK_MODEL,
  resolveMaxTokens,
  getModelMetadata,
  supportsAdaptiveThinking,
} from './models.js'
export type { ModelMetadata } from './models.js'

// Voice STT — Speech-to-Text via Anthropic voice_stream WebSocket
export {
  connectVoiceStream,
  transcribeFile,
  transcribeAudioFile,
  startMicRecording,
  checkVoiceDeps,
} from './voice.js'
export type {
  VoiceStreamCallbacks,
  VoiceStreamConnection,
  VoiceStreamOptions,
  TranscribeFileOptions,
} from './voice.js'
