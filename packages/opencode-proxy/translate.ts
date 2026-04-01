/**
 * Translate between OpenAI chat format and claude-code-sdk format.
 *
 * OpenAI message roles: "system" | "user" | "assistant" | "tool"
 * Our SDK roles: "user" | "assistant"
 *
 * Tool flow in OpenAI format:
 *   assistant → { role: "assistant", tool_calls: [{id, type, function: {name, arguments}}] }
 *   tool result → { role: "tool", tool_call_id: "...", content: "..." }
 *
 * Tool flow in our SDK format:
 *   assistant → { role: "assistant", content: [{type:"tool_use", id, name, input}] }
 *   tool result → { role: "user", content: [{type:"tool_result", tool_use_id, content}] }
 */

// ============================================================
// OpenAI types (request side)
// ============================================================

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OAIContentPart[] | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string    // for role=tool
  name?: string
}

export interface OAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON string
  }
}

export interface OAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OAIChatRequest {
  model: string
  messages: OAIMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  tools?: OAITool[]
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  stop?: string | string[]
  /** OpenAI reasoning effort — opencode sends this for CanReason models */
  reasoning_effort?: 'low' | 'medium' | 'high'
}

// ============================================================
// Our SDK types (local import — path relative from proxy)
// ============================================================

export interface SDKMessageParam {
  role: 'user' | 'assistant'
  content: string | SDKContentBlock[]
}

export type SDKContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | SDKContentBlock[]; is_error?: boolean }

export interface SDKToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ============================================================
// Translate OpenAI messages → SDK messages
// ============================================================

export function toSDKMessages(messages: OAIMessage[]): SDKMessageParam[] {
  const result: SDKMessageParam[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'system') {
      // System messages are handled separately (sdk.system param)
      i++
      continue
    }

    if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: extractText(msg),
      })
      i++
      continue
    }

    if (msg.role === 'assistant') {
      const content: SDKContentBlock[] = []

      // Text content
      const text = extractText(msg)
      if (text) {
        content.push({ type: 'text', text })
      }

      // Tool calls
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let input: unknown = {}
          try { input = JSON.parse(tc.function.arguments) } catch { /* */ }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
      }

      result.push({ role: 'assistant', content: content.length > 0 ? content : '' })
      i++

      // Collect consecutive tool results that follow this assistant message
      const toolResults: SDKContentBlock[] = []
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i]
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolMsg.tool_call_id ?? '',
          content: extractText(toolMsg),
        })
        i++
      }

      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults })
      }
      continue
    }

    // Fallback
    i++
  }

  return result
}

/** Extract system prompt from messages array */
export function extractSystem(messages: OAIMessage[]): string | undefined {
  const systemMsgs = messages.filter(m => m.role === 'system')
  if (systemMsgs.length === 0) return undefined
  return systemMsgs.map(m => extractText(m)).join('\n')
}

function extractText(msg: OAIMessage): string {
  if (typeof msg.content === 'string') return msg.content ?? ''
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
  }
  return ''
}

// ============================================================
// Translate OpenAI tools → SDK tools
// ============================================================

export function toSDKTools(tools?: OAITool[]): SDKToolDef[] | undefined {
  if (!tools?.length) return undefined
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

export function toSDKToolChoice(
  toolChoice: OAIChatRequest['tool_choice'],
): 'auto' | 'any' | { type: 'tool'; name: string } | undefined {
  if (!toolChoice || toolChoice === 'none') return undefined
  if (toolChoice === 'auto') return 'auto'
  if (toolChoice === 'required') return 'any'
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', name: toolChoice.function.name }
  }
  return 'auto'
}

// ============================================================
// Map model names: OpenAI model string → our model string
// ============================================================

export function resolveModel(model: string): string {
  // Proxy IDs (from our /v1/models) → real API model names
  if (PROXY_MODEL_MAP[model]) return PROXY_MODEL_MAP[model]
  // Direct API model names (pass through)
  const DIRECT_MAP: Record<string, string> = {
    'claude-sonnet-4-6': 'claude-sonnet-4-6',
    'claude-opus-4-6': 'claude-opus-4-6',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
    'claude-opus-4-20250514': 'claude-opus-4-20250514',
  }
  return DIRECT_MAP[model] ?? model
}

// ============================================================
// Supported models list (for GET /v1/models)
// ============================================================

// IDs are designed so opencode's friendlyModelName() regex produces readable names:
//   "claude-sonnet-v4.6" → "Claude Sonnet V4.6"
//   "claude-opus-v4.6"   → "Claude Opus V4.6"
//   "claude-haiku-v4.5"  → "Claude Haiku V4.5"
// The real API model name is looked up in PROXY_MODEL_MAP.
// IDs use "claude-vVER-family" format so opencode's regex produces:
//   "claude-v4.6-sonnet" → "Claude V4.6 Sonnet"
//   "claude-v4.6-opus"   → "Claude V4.6 Opus"
//   "claude-v4.5-haiku"  → "Claude V4.5 Haiku"
export const SUPPORTED_MODELS = [
  { id: 'claude-v4.6-sonnet', name: 'Claude V4.6 Sonnet' },
  { id: 'claude-v4.6-opus',   name: 'Claude V4.6 Opus' },
  { id: 'claude-v4.5-haiku',  name: 'Claude V4.5 Haiku' },
]

// Maps proxy IDs → real API model names
export const PROXY_MODEL_MAP: Record<string, string> = {
  'claude-v4.6-sonnet': 'claude-sonnet-4-6',
  'claude-v4.6-opus':   'claude-opus-4-6',
  'claude-v4.5-haiku':  'claude-haiku-4-5-20251001',
}
