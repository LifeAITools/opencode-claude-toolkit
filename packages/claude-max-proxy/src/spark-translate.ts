/**
 * Spark-translate — Anthropic Messages ↔ OpenAI Responses translation layer
 * for the `spark-responses` proxy module (Muse Spark via opencode-go).
 *
 * Direction: our substrate speaks Anthropic Messages; the zen/go gateway
 * serves Muse Spark ONLY as Responses. This file is pure translation —
 * no network, no secrets, no config. The module does transport.
 *
 * MEASURED (live log 06.10.2026, POST zen/go/v1/responses → 200):
 *   output = [reasoning{encrypted_content ~3KB opaque, summary:[]},
 *             message{content:[{type:output_text, text}]}]
 *   of 208 output tokens 195 were reasoning. Consequences baked in below:
 *   - text is taken ONLY from message/output_text blocks;
 *   - encrypted reasoning is DROPPED (documented choice, see below);
 *   - max_output_tokens has a floor (50 + high effort → incomplete).
 *
 * WHY DROP (not echo-back): the agent is stateless per call — every request
 * carries full context, so cross-turn reasoning continuity buys nothing, while
 * each echoed opaque blob bills shared-ceiling input tokens on EVERY later
 * call of the turn (dozens of KB over a 35-call turn). effort=high on a fresh
 * call compensates. Revisit only with a spend measurement, not a hunch.
 */

export interface MessagesContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

export interface MessagesMessage {
  role: 'user' | 'assistant'
  content: string | MessagesContentBlock[]
}

export interface MessagesTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface MessagesRequest {
  model: string
  system?: string | MessagesContentBlock[]
  messages: MessagesMessage[]
  tools?: MessagesTool[]
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string } | 'auto' | 'any'
  max_tokens?: number
  stream?: boolean
  metadata?: unknown
}

export interface ResponsesRequest {
  model: string
  instructions?: string
  input: unknown[]
  tools?: unknown[]
  tool_choice?: unknown
  max_output_tokens: number
  stream: boolean
  reasoning?: { effort: ReasoningEffort }
}

/** Floor for max_output_tokens — measured: 50 + high effort → incomplete. */
export const SPARK_MIN_OUTPUT_TOKENS = 512
export const SPARK_DEFAULT_OUTPUT_TOKENS = 4096

/** Only Responses-dialect models may pass — others bill other buckets
 *  and speak other dialects this translator does not implement. */
export function isSparkModel(model: string): boolean {
  return /^muse-spark-/.test(model)
}

function textOf(blocks: MessagesContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/**
 * Anthropic image block → Responses input_image part.
 * Anthropic: {type:'image', source:{type:'base64'|'url', media_type?, data?, url?}}.
 * Responses: {type:'input_image', image_url: 'data:<mime>;base64,<data>'}.
 * A block that names neither is rejected LOUDLY — an image the translator
 * cannot carry must refuse, never vanish (the silent-drop this fixes
 * cost a live turn its schematic on 06.10.2026).
 */
export function translateImageBlock(b: MessagesContentBlock): { type: 'input_image'; image_url: string } {
  const src = (b as any).source ?? {}
  if (src.type === 'base64' && src.data) {
    // media_type is usually present; when absent, sniff magic bytes instead
    // of guessing jpeg (a png sent as jpeg decodes wrong server-side).
    // base64 prefixes: PNG 'iVBORw0KGgo', JPEG '/9j/', GIF 'R0lGOD', WEBP 'UklGR'.
    let mime = src.media_type as string | undefined
    if (!mime) {
      const head: string = src.data.slice(0, 12)
      mime = head.startsWith('iVBORw0KGgo') ? 'image/png'
        : head.startsWith('/9j/') ? 'image/jpeg'
        : head.startsWith('R0lGOD') ? 'image/gif'
        : head.startsWith('UklGR') ? 'image/webp'
        : undefined
    }
    if (!mime) {
      throw new Error('image block without media_type and unrecognised payload — refusing instead of guessing')
    }
    return { type: 'input_image', image_url: `data:${mime};base64,${src.data}` }
  }
  if ((src.type === 'url' && src.url) || (b as any).url) {
    return { type: 'input_image', image_url: src.url ?? (b as any).url }
  }
  throw new Error(`image block without base64/url payload (media_type=${src.media_type ?? '?'})`)
}

function blocksOf(content: string | MessagesContentBlock[]): MessagesContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

export interface ToResponsesResult {
  body: ResponsesRequest
  /** True when the requested max was raised to the floor. */
  bumpedMaxTokens: boolean
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export function translateToResponsesBody(
  req: MessagesRequest,
  opts?: { reasoningEffort?: ReasoningEffort },
): ToResponsesResult {
  const systemBlocks = req.system === undefined ? [] : blocksOf(req.system)
  const instructions = textOf(systemBlocks) || undefined

  const input: unknown[] = []
  for (const m of req.messages) {
    const blocks = blocksOf(m.content)
    if (m.role === 'user') {
      const texts = blocks.filter(b => b.type === 'text')
      const results = blocks.filter(b => b.type === 'tool_result')
      const images = blocks.filter(b => b.type === 'image')
      if (texts.length || images.length) {
        input.push({
          type: 'message', role: 'user',
          content: [
            ...texts.map(b => ({ type: 'input_text', text: b.text ?? '' })),
            ...images.map(translateImageBlock),
          ],
        })
      }
      for (const r of results) {
        const c = r.content
        const output = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text ?? '').join('')
          : JSON.stringify(c ?? '')
        input.push({
          type: 'function_call_output',
          call_id: r.tool_use_id,
          output,
        })
        // function_call_output carries STRING only — image parts ride a
        // separate user message right after, or the model never sees pixels.
        if (Array.isArray(c)) {
          const imgs = (c as any[]).filter((x: any) => x?.type === 'image')
          if (imgs.length) {
            input.push({
              type: 'message', role: 'user',
              content: imgs.map(translateImageBlock),
            })
          }
        }
      }
      if (!texts.length && !results.length && !images.length && blocks.length) {
        throw new Error(`unsupported user content block: ${blocks.map(b => b.type).join(',')}`)
      }
      const unhandledU = blocks.filter(b => b.type !== 'text' && b.type !== 'tool_result' && b.type !== 'image')
      if (unhandledU.length) {
        throw new Error(`unsupported user content block rides with text and would vanish: ${unhandledU.map(b => b.type).join(',')}`)
      }
    } else {
      const texts = blocks.filter(b => b.type === 'text')
      const uses = blocks.filter(b => b.type === 'tool_use')
      if (texts.length) {
        input.push({
          type: 'message', role: 'assistant',
          content: texts.map(b => ({ type: 'output_text', text: b.text ?? '' })),
        })
      }
      for (const u of uses) {
        input.push({
          type: 'function_call',
          call_id: u.id,
          name: u.name,
          arguments: JSON.stringify(u.input ?? {}),
        })
      }
      if (!texts.length && !uses.length && blocks.length) {
        throw new Error(`unsupported assistant content block: ${blocks.map(b => b.type).join(',')}`)
      }
      const unhandledA = blocks.filter(b => b.type !== 'text' && b.type !== 'tool_use')
      if (unhandledA.length) {
        throw new Error(`unsupported assistant content block rides with text and would vanish: ${unhandledA.map(b => b.type).join(',')}`)
      }
    }
  }

  const tools = (req.tools ?? []).map(t => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.input_schema,
  }))

  let tool_choice: unknown
  const tc = req.tool_choice
  if (tc !== undefined) {
    if (tc === 'auto' || (typeof tc === 'object' && tc.type === 'auto')) tool_choice = 'auto'
    else if (tc === 'any' || (typeof tc === 'object' && tc.type === 'any')) tool_choice = 'required'
    else if (typeof tc === 'object' && tc.type === 'tool' && tc.name) {
      tool_choice = { type: 'function', name: tc.name }
    } else {
      throw new Error(`unsupported tool_choice: ${JSON.stringify(tc).slice(0, 120)}`)
    }
  }

  const requested = req.max_tokens ?? SPARK_DEFAULT_OUTPUT_TOKENS
  const bumpedMaxTokens = requested < SPARK_MIN_OUTPUT_TOKENS
  const max_output_tokens = bumpedMaxTokens ? SPARK_MIN_OUTPUT_TOKENS : requested

  const body: ResponsesRequest = {
    model: req.model,
    input,
    max_output_tokens,
    stream: req.stream === true,
    // Our cognition lives substrate-side (vault-driven PLAN/EXECUTE/REFLECT) —
    // model-internal reasoning is set to minimum, measured 06.10: 322→57 output
    // tokens on the same answer. Raised only with a spend measurement, not a hunch.
    reasoning: { effort: opts?.reasoningEffort ?? 'minimal' },
  }
  if (instructions) body.instructions = instructions
  if (tools.length) body.tools = tools
  if (tool_choice !== undefined) body.tool_choice = tool_choice
  return { body, bumpedMaxTokens }
}

// ─── Responses → Messages ────────────────────────────────────────────

export interface ResponsesOutputItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: { type: string; text?: string }[]
  status?: string
}

export interface ResponsesObject {
  id: string
  model: string
  status: string
  incomplete_details?: { reason?: string }
  output: ResponsesOutputItem[]
  usage?: { input_tokens: number; output_tokens: number }
}

export interface MessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  )[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: { input_tokens: number; output_tokens: number }
}

export interface FromResponsesResult {
  message: MessagesResponse
  /** Encrypted reasoning items seen and dropped (billable output, invisible answer). */
  droppedReasoning: number
}

export function translateFromResponsesObject(res: ResponsesObject): FromResponsesResult {
  const content: MessagesResponse['content'] = []
  let droppedReasoning = 0
  let sawFunctionCall = false
  for (const item of res.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          content.push({ type: 'text', text: part.text ?? '' })
        }
      }
    } else if (item.type === 'function_call') {
      sawFunctionCall = true
      let parsed: unknown
      try {
        parsed = JSON.parse(item.arguments ?? '{}')
      } catch {
        throw new Error(`function_call arguments not JSON (call_id=${item.call_id ?? '?'})`)
      }
      content.push({ type: 'tool_use', id: item.call_id ?? '', name: item.name ?? '', input: parsed })
    } else if (item.type === 'reasoning') {
      droppedReasoning++
    }
  }

  let stop_reason: MessagesResponse['stop_reason'] = 'end_turn'
  if (sawFunctionCall) stop_reason = 'tool_use'
  else if (res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens') {
    stop_reason = 'max_tokens'
  }

  return {
    message: {
      id: `msg_spark_${res.id}`,
      type: 'message',
      role: 'assistant',
      model: res.model,
      content,
      stop_reason,
      usage: {
        input_tokens: res.usage?.input_tokens ?? 0,
        output_tokens: res.usage?.output_tokens ?? 0,
      },
    },
    droppedReasoning,
  }
}

// ─── SSE: Responses stream → Anthropic SSE ───────────────────────────
// Responses events consumed: response.output_text.delta {item_id, delta},
// response.function_call_arguments.delta {item_id, delta},
// response.output_item.added {item:{type,id,name}},
// response.completed {response:{usage}}. Emitted: message_start,
// content_block_start/delta/stop, message_delta, message_stop.

export interface SparkSSEOpts {
  messageId: string
  model: string
  /**
   * Fired EXACTLY ONCE when the stream ends (usage arrives inside
   * response.completed; without it — zeros). The module turns this into
   * SPARK_COMPLETE: without the callback the ceiling metering is blind on
   * streamed traffic, which is nearly all of it.
   */
  onComplete?: (usage: { input_tokens: number; output_tokens: number }, durationMs: number) => void
}

export async function transformResponsesSSEToAnthropic(
  upstream: Response,
  opts: SparkSSEOpts,
): Promise<Response> {
  const reader = upstream.body?.getReader()
  if (!reader) throw new Error('upstream SSE body missing')

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buf = ''
  let blockIndex = -1
  // item_id → { index, kind: 'text' | 'tool', name, argBuf }
  const items = new Map<string, { index: number; kind: 'text' | 'tool'; name: string; argBuf: string }>()
  let started = false
  let sawToolBlock = false
  let usage = { input_tokens: 0, output_tokens: 0 }
  const t0 = Date.now()

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Anthropic SSE framing: bare `data:` lines, no `event:` prefix, no [DONE].
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }
      const ensureStart = () => {
        if (started) return
        started = true
        send({
          type: 'message_start',
          message: { id: opts.messageId, type: 'message', role: 'assistant', model: opts.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
        })
      }
      const closeBlock = (index: number) => {
        send({ type: 'content_block_stop', index })
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of chunk.split('\n')) {
              const payload = line.startsWith('data: ') ? line.slice(6) : line.startsWith('data:') ? line.slice(5) : null
              if (payload === null || payload === '[DONE]') continue
              let ev: any
              try { ev = JSON.parse(payload) } catch { continue }
              const t = ev.type as string
              if (t === 'response.output_text.delta') {
                ensureStart()
                let st = items.get(ev.item_id)
                if (!st) {
                  blockIndex++
                  st = { index: blockIndex, kind: 'text', name: '', argBuf: '' }
                  items.set(ev.item_id, st)
                  send({ type: 'content_block_start', index: st.index, content_block: { type: 'text', text: '' } })
                }
                send({ type: 'content_block_delta', index: st.index, delta: { type: 'text_delta', text: ev.delta ?? '' } })
              } else if (t === 'response.function_call_arguments.delta') {
                ensureStart()
                const st = items.get(ev.item_id)
                if (!st) continue // name arrives via output_item.added; unknown item → skip loudly below
                st.argBuf += ev.delta ?? ''
                send({ type: 'content_block_delta', index: st.index, delta: { type: 'input_json_delta', partial_json: ev.delta ?? '' } })
              } else if (t === 'response.output_item.added') {
                ensureStart()
                const item = ev.item ?? {}
                if (item.type === 'function_call') {
                  blockIndex++
                  sawToolBlock = true
                  const st = { index: blockIndex, kind: 'tool' as const, name: item.name ?? '', argBuf: '' }
                  items.set(item.id, st)
                  send({ type: 'content_block_start', index: st.index, content_block: { type: 'tool_use', id: item.call_id ?? item.id, name: item.name ?? '', input: {} } })
                }
              } else if (t === 'response.output_item.done') {
                const item = ev.item ?? {}
                const st = items.get(item.id)
                if (st) {
                  closeBlock(st.index)
                  items.delete(item.id)
                }
              } else if (t === 'response.completed') {
                const u = ev.response?.usage
                if (u) usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 }
              }
            }
          }
        }
      } finally {
        for (const st of items.values()) closeBlock(st.index)
        items.clear()
        send({ type: 'message_delta', delta: { stop_reason: sawToolBlock ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
        send({ type: 'message_stop' })
        try { opts.onComplete?.(usage, Date.now() - t0) } catch { /* metering must not break the stream tail */ }
        controller.close()
      }
    },
  })

  return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Buffered non-streaming assembly: parse upstream JSON → Messages Response. */
export async function bufferResponsesToMessages(upstream: Response): Promise<FromResponsesResult> {
  const text = await upstream.text()
  let parsed: ResponsesObject
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`upstream JSON unparseable: ${text.slice(0, 200)}`)
  }
  if ((parsed as any).error) {
    const e = (parsed as any).error
    throw new Error(`upstream error: ${e.message ?? JSON.stringify(e).slice(0, 200)}`)
  }
  return translateFromResponsesObject(parsed)
}

// ─── Error + models surface ──────────────────────────────────────────

export function sparkErrorResponse(status: number, message: string, type = 'api_error'): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

export function sparkCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-opencode-session, anthropic-version',
    },
  })
}

export function handleSparkModelsRequest(version: string): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [
        { id: 'muse-spark-1.3-contributor', object: 'model', owned_by: 'opencode-go' },
        { id: 'muse-spark-1.2-contributor', object: 'model', owned_by: 'opencode-go' },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-proxy': version } },
  )
}
