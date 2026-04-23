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
