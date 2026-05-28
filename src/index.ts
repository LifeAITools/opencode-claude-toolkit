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
// Pure cache-control transforms used on the live request path (ProxyClient.handleRequest).
// Exported so post-deploy smoke tests can probe the deployed bundle directly.
export { upgradeCacheControlTtl, detectCacheTtlFromBody } from './keepalive-engine.js'

// Keepalive SSOT — read/manage cache TTL + KA params from ~/.claude/keepalive.json.
// Consumers should NOT hardcode TTL or interval values; use this instead.
export {
  loadKeepaliveConfig,
  reloadKeepaliveConfig,
  getCacheTtlMs,
  getSafetyMarginMs,
  getConfigPath as getKeepaliveConfigPath,
  RECOMMENDED_1H_CONFIG,
} from './keepalive-config.js'
export type { ResolvedKeepaliveConfig } from './keepalive-config.js'

// Cache metrics + regression detector — rolling-window summary and alerts on
// hit-rate degradation (catches silent Anthropic-side cache changes).
export { CacheMetricsCollector } from './cache-metrics.js'
export type {
  RecordedRequest,
  MetricsSummary,
  RegressionInfo,
  CacheMetricsOptions,
} from './cache-metrics.js'

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
export { ProxyClient, extractSessionIdFromBody } from './proxy-client.js'
export type {
  ProxyClientConfig,
  ProxyClientOptions,
  HandleRequestContext,
  RateLimitSnapshot,
} from './proxy-client.js'

// Org-identity — resolves the current Anthropic org UUID for the rewrite
// guard's cross-org cache-replay detection (`anomalous:org-switch`).
export {
  FileOrgIdResolver,
  readOrgIdFromConfig,
  DEFAULT_ACCOUNT_CONFIG_PATH,
} from './org-identity.js'
export type { OrgIdResolver } from './org-identity.js'

// Rewrite-guard block dumps — the rejected request + prefix diff, persisted
// on every guard block for offline analysis.
export {
  writeRewriteBlockDump,
  diffPrefix,
  DEFAULT_REWRITE_DUMP_DIR,
} from './rewrite-dump.js'
export type {
  CachePrefix,
  PrefixDiff,
  RewriteBlockDumpInput,
} from './rewrite-dump.js'

// KA snapshot persistence — revive the keepalive registry across a proxy
// restart so idle sessions keep their prompt cache warm.
export {
  loadKaSnapshots,
  saveKaSnapshots,
  assessRevival,
  DEFAULT_KA_SNAPSHOT_PATH,
  KA_SNAPSHOT_MAX_AGE_MS,
} from './ka-snapshot-store.js'
export type {
  PersistedRegistryEntry,
  PersistedEngineState,
  PersistedSession,
  KaSnapshotFile,
  RevivalVerdict,
} from './ka-snapshot-store.js'
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

// ─── SSOT: Anthropic endpoint URLs ──────────────────────────────────
// REQ-12 / SSOT-01: every production caller imports endpoint URLs from
// here. NO inline literals allowed in production files (test fixtures
// exempt). See src/anthropic-endpoints.ts for the full rationale.
export {
  ANTHROPIC_API_HOST,
  ANTHROPIC_API_BASE,
  ANTHROPIC_API_MESSAGES,
  ANTHROPIC_API_MESSAGES_COUNT_TOKENS,
  ANTHROPIC_PLATFORM_BASE,
  ANTHROPIC_OAUTH_TOKEN_URL,
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI,
  ANTHROPIC_ENDPOINTS,
} from './anthropic-endpoints.js'

// ─── SSOT: Anthropic HTTP header names + API version ────────────────
// REQ-12 / SSOT-02: every production caller imports header names and
// the API version from here. NO inline 'anthropic-version' /
// 'Content-Type' / 'application/json' literals in production files
// (test fixtures exempt). See src/anthropic-headers.ts for rationale.
export {
  ANTHROPIC_API_VERSION,
  API_VERSION,
  HEADER_CONTENT_TYPE,
  HEADER_AUTHORIZATION,
  HEADER_ACCEPT,
  HEADER_USER_AGENT,
  HEADER_ANTHROPIC_VERSION,
  HEADER_ANTHROPIC_BETA,
  HEADER_ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS,
  HEADER_X_APP,
  HEADER_X_CLAUDE_CODE_SESSION_ID,
  CONTENT_TYPE_JSON,
  ACCEPT_JSON_SSE,
  CONTENT_TYPE_TEXT_HTML,
  ANTHROPIC_HEADERS,
} from './anthropic-headers.js'

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
