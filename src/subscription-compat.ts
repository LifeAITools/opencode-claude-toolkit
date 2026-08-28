/**
 * subscription-compat.ts — ЗНАНИЕ О ТОМ, ЧТО ДЕЛАЕТ ЗАПРОС ДЕЙСТВИТЕЛЬНЫМ ПО ПОДПИСКЕ.
 *
 * 🔴 ПОЧЕМУ ЭТО ЖИВЁТ ЗДЕСЬ, А НЕ В ПРОКСИ (решение фаундера 29.08.2026).
 *
 * До этого дня набор признаков подписки — какие beta-флаги, какие заголовки,
 * какое имя клиента и какая строка учёта делают чужой запрос неотличимым от
 * запроса родного Claude Code — лежал в ОТКРЫТОЙ части, в пакете, который мы
 * раздаём по публичной ссылке. Пока пакет ставили только свои, это было
 * незаметно; с 28.08 его читает любой, кто скачал.
 *
 * Это не ключ и не секрет: это ЗНАНИЕ, добытое опытом, и оно из тех трёх вещей,
 * которые в этом продукте вообще имеют цену (вторая — решения о прогреве кэша,
 * третья — расстановка меток кэша, она тоже здесь). Граница между открытым и
 * закрытым проведена по смыслу: сантехника (сервер, журнал, панель, учёт) —
 * снаружи, знание — внутри собранного движка.
 *
 * СОБЫТИЯ ВПРЫСКИВАЮТСЯ, А НЕ ИМПОРТИРУЮТСЯ. Раньше поправка effort писала в
 * шину прокси напрямую. Здесь шины нет и быть не должно: вызывающий передаёт
 * свой `emit` четвёртым доводом. Ничего не передал — правка молча делается, и
 * это осознанный выбор: движок не тащит за собой ничью шину событий.
 */

/** Куда движок сообщает о своих правках — шина вызывающего, если он её дал. */
export type CompatEmit = (
  event: { level: 'error' | 'info' | 'debug'; kind: string } & Record<string, unknown>,
) => void

// ═══ Smart Cache Marker Injection ════════════════════════════════════
//
// OpenAI clients and bare Anthropic SDK clients don't send cache_control
// markers. Without markers, Anthropic doesn't cache the prefix, and KA
// engine can't keep it warm → every request pays full input token cost.
//
// This function injects cache markers at the same 3 breakpoints the SDK
// uses (sdk.ts:1056-1087): last system block, last tool, last message.
// The marker uses `ttl:'1h'` which ProxyClient's upgradeCacheControlTtl
// will recognize (requires prompt-caching-scope-2026-01-05 beta — always
// injected by enrichAnthropicRequest).
//
// IMPORTANT: Only injects markers when the body carries NONE anywhere. A client
// that placed ANY cache_control is cache-AWARE and owns its breakpoint PLAN —
// Anthropic hard-caps 4 marks per request, so per-slot topping-up of a partially
// marked body can push it over the cap (live-hit 2026-07-04: kiberos-agent@0.3.1
// budgets exactly 4 marks [2×system + last-tool + moving messages mark]; the old
// per-slot logic added a 4th/5th onto the unmarked LAST message → API 400
// "A maximum of 4 blocks with cache_control may be provided. Found 5." on every
// multi-step turn). Marker-less bodies (OpenAI-compat, bare SDK) keep the full
// BP1-3 injection exactly as before.

const CACHE_MARKER = { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }

/** True when ANY cache_control mark exists in system ⊕ tools ⊕ messages. */
export function hasAnyCacheControl(body: Record<string, unknown>): boolean {
  const blockHas = (b: unknown): boolean =>
    b !== null && typeof b === 'object' && Boolean((b as Record<string, unknown>).cache_control)
  const sys = body.system
  if (Array.isArray(sys) && sys.some(blockHas)) return true
  const tools = body.tools
  if (Array.isArray(tools) && tools.some(blockHas)) return true
  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (blockHas(m)) return true
      const content = (m as Record<string, unknown> | null)?.content
      if (Array.isArray(content) && content.some(blockHas)) return true
    }
  }
  return false
}

export function injectCacheMarkers(body: Record<string, unknown>): number {
  // Cache-aware client (≥1 own mark) ⇒ faithful pass-through, zero injection.
  if (hasAnyCacheControl(body)) return 0

  let injected = 0

  // BP1: last system block
  const sys = body.system
  if (typeof sys === 'string' && sys.length > 0) {
    body.system = [{ type: 'text', text: sys, ...CACHE_MARKER }]
    injected++
  } else if (Array.isArray(sys) && sys.length > 0) {
    const last = sys[sys.length - 1] as Record<string, unknown>
    if (last && typeof last === 'object' && !last.cache_control) {
      sys[sys.length - 1] = { ...last, ...CACHE_MARKER }
      injected++
    }
  }

  // BP2: last tool definition
  const tools = body.tools as Record<string, unknown>[] | undefined
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1]
    if (last && typeof last === 'object' && !last.cache_control) {
      tools[tools.length - 1] = { ...last, ...CACHE_MARKER }
      injected++
    }
  }

  // BP3: last message content block
  const messages = body.messages as { role: string; content: string | Record<string, unknown>[] }[]
  if (messages && messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    if (typeof lastMsg.content === 'string' && lastMsg.content.length > 0) {
      if (!(lastMsg as any).cache_control) {
        lastMsg.content = [{ type: 'text', text: lastMsg.content, ...CACHE_MARKER }] as any
        injected++
      }
    } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      // NEVER add cache_control to a thinking/redacted_thinking block: Anthropic
      // rejects ANY modification of thinking blocks in the latest assistant
      // message ("thinking blocks ... cannot be modified"). Inject onto the last
      // NON-thinking block instead; if the trailing blocks are all thinking,
      // skip BP3 (BP1 system + BP2 tools already provide the cache anchor).
      const isThinking = (b: unknown) => {
        const t = (b as Record<string, unknown> | null)?.type
        return t === 'thinking' || t === 'redacted_thinking'
      }
      let idx = lastMsg.content.length - 1
      while (idx >= 0 && isThinking(lastMsg.content[idx])) idx--
      const target = idx >= 0 ? lastMsg.content[idx] : null
      if (target && typeof target === 'object' && !target.cache_control) {
        lastMsg.content[idx] = { ...target, ...CACHE_MARKER }
        injected++
      }
    }
  }

  return injected
}

// ═══ Anthropic-Compatible Facade ════════════════════════════════════
//
// Enriches a raw Anthropic SDK request with subscription-required headers,
// metadata, betas, and billing attribution so that the standard `anthropic`
// Python/JS SDK "just works" against the proxy. Without this enrichment,
// non-haiku models return 429 (Anthropic rejects requests missing the
// claude-code beta + billing header for subscription-based accounts).

let CC_COMPAT_VERSION = '2.1.152'

/** Update compat version at runtime (called from config on boot). */
export function setCompatVersion(v: string): void { if (v) CC_COMPAT_VERSION = v }

const OAUTH_BETA = 'oauth-2025-04-20'
const CLAUDE_CODE_BETA = 'claude-code-20250219'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'
const EFFORT_BETA = 'effort-2025-11-24'
/** Effort levels the API refuses while thinking is disabled ("use 'high' or below"). */
const EFFORT_ABOVE_HIGH = new Set(['xhigh', 'max'])
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'
const TASK_BUDGETS_BETA = 'task-budgets-2026-03-13'
const REDACT_THINKING_BETA = 'redact-thinking-2026-02-12'
const PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'

export interface AnthropicEnrichResult {
  body: string
  headers: Record<string, string>
}

/**
 * Enrich a raw Anthropic API request so it works via subscription OAuth.
 *
 * Injects:
 *   - Required beta flags (claude-code, oauth, thinking, caching, etc.)
 *   - metadata.user_id with device_id + session_id
 *   - x-anthropic-billing-header in system prompt
 *   - Subscription-compatible User-Agent and x-app headers
 *   - anthropic-dangerous-direct-browser-access: true
 *
 * The consumer sends a standard `anthropic` SDK request; we make it
 * indistinguishable from a native Claude Code CLI request.
 */

/**
 * Lower `output_config.effort` to 'high' when thinking is disabled. Mutates `body`.
 * Returns the previous value when it clamped, else null.
 *
 * 🔴 MUST RUN ON EVERY REQUEST, INCLUDING NATIVE CLAUDE CODE. The first version of this
 * lived inside `enrichAnthropicRequest`, which `modules/anthropic.ts` calls only for
 * NON-native clients (`if (!isNativeCC)`). Native Claude Code forwards its raw body
 * untouched — and native Claude Code agents are exactly who run at xhigh and lose every
 * web search. So the clamp ran for nobody who had the bug, while my own curl (no
 * `claude-cli/` user-agent) took the enriched path and "verified" the fix.
 *
 * That is the fourth instance in one day of fixing a function the affected caller does not
 * call. This is a REQUEST-VALIDITY repair, not subscription enrichment: the API rejects the
 * pair outright, so it belongs on the shared path, unconditionally.
 */
export function clampEffortIfThinkingDisabled(
  body: Record<string, unknown>,
  emit?: CompatEmit,
): string | null {
  const carrier = body.output_config as { effort?: string } | undefined
  const thinkingOff =
    !body.thinking || (body.thinking as { type?: string } | null)?.type === 'disabled'
  if (!carrier?.effort || !thinkingOff || !EFFORT_ABOVE_HIGH.has(carrier.effort)) return null
  const was = carrier.effort
  carrier.effort = 'high'
  emit?.({
    level: 'info',
    kind: 'EFFORT_CLAMPED',
    msg: `effort ${was}->high (thinking disabled) — the API rejects '${was}' without thinking; clamped so the call succeeds`,
    model: String(body.model ?? ''),
    from: was,
    to: 'high',
  })
  return was
}

export function enrichAnthropicRequest(
  rawBody: string,
  consumerHeaders: Record<string, string>,
  sessionId: string,
  emit?: CompatEmit,
): AnthropicEnrichResult {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { body: rawBody, headers: consumerHeaders }
  }

  const model = String(body.model ?? '').toLowerCase()
  const isHaiku = model.includes('haiku')

  // ── Build subscription-required betas ───────────────────────────
  const betas: string[] = []
  if (!isHaiku) betas.push(CLAUDE_CODE_BETA)
  betas.push(OAUTH_BETA)
  if (!isHaiku) betas.push(INTERLEAVED_THINKING_BETA)
  if (!isHaiku) betas.push(CONTEXT_MANAGEMENT_BETA)
  betas.push(TASK_BUDGETS_BETA)
  betas.push(REDACT_THINKING_BETA)
  betas.push(PROMPT_CACHING_SCOPE_BETA)
  betas.push(FINE_GRAINED_TOOL_STREAMING_BETA)
  if (body.thinking || body.output_config) betas.push(EFFORT_BETA)

  // ── Effort must not outrank thinking ────────────────────────────
  // A request carrying `output_config.effort` ABOVE 'high' while `thinking` is disabled is
  // rejected outright: "output_config.effort 'xhigh' is not supported when thinking is
  // disabled on this model." The client composes exactly that pair for its server-side
  // tool calls — WebSearch spawns a sub-request with `thinking: {type:'disabled'}` that
  // still INHERITS the session's effort — so on this machine every WebSearch issued by
  // any agent running at xhigh returned 400, twice (the client retries once), and the
  // tool simply did not work. Not "limited access": none, and only for high-effort
  // sessions, which is why it read as intermittent.
  //
  // Measured, not inferred: proxy body dumps of the failing 880-byte requests carry
  // `{"thinking":{"type":"disabled"},"output_config":{"effort":"xhigh"},"messages":[{...
  // "Perform a web search for the query: ..."}]}`.
  //
  // Clamping is the remedy the API itself names, and the alternative — switching thinking
  // on — would change the shape and cost of a request the client did not ask to think.
  // The repair is LOGGED rather than silent: a proxy that quietly rewrites requests is the
  // next invisible defect, and a rewrite nobody can see is one nobody can disprove.
  clampEffortIfThinkingDisabled(body, emit)

  // Merge with any betas the consumer already sent
  const existingBeta = consumerHeaders['anthropic-beta'] ?? ''
  const allBetas = new Set([...existingBeta.split(',').map(s => s.trim()).filter(Boolean), ...betas])

  // ── Build headers ──────────────────────────────────────────────
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(consumerHeaders)) {
    const lk = k.toLowerCase()
    if (lk === 'x-api-key' || lk === 'authorization') continue
    headers[k] = v
  }
  headers['content-type'] = 'application/json'
  headers['anthropic-version'] = '2023-06-01'
  headers['anthropic-beta'] = [...allBetas].join(',')
  headers['anthropic-dangerous-direct-browser-access'] = 'true'
  headers['x-app'] = 'cli'
  headers['user-agent'] = `claude-cli/${CC_COMPAT_VERSION}`
  headers['x-claude-code-session-id'] = sessionId

  // ── Inject metadata.user_id if absent ─────────────────────────
  if (!body.metadata || !(body.metadata as any).user_id) {
    const deviceId = randomHex(32)
    body.metadata = {
      ...(body.metadata as Record<string, unknown> ?? {}),
      user_id: JSON.stringify({
        device_id: deviceId,
        account_uuid: '',
        session_id: sessionId,
      }),
    }
  }

  // ── Inject billing attribution header in system ────────────────
  const billingHeader = `x-anthropic-billing-header: cc_version=${CC_COMPAT_VERSION}.0000000000; cc_entrypoint=cli; cch=00000;`
  if (body.system !== undefined) {
    const sysStr = typeof body.system === 'string' ? body.system : JSON.stringify(body.system)
    if (!sysStr.includes('x-anthropic-billing-header')) {
      if (typeof body.system === 'string') {
        body.system = billingHeader + '\n' + body.system
      } else if (Array.isArray(body.system)) {
        body.system = [{ type: 'text', text: billingHeader }, ...body.system]
      }
    }
  } else {
    body.system = billingHeader
  }

  // Inject cache markers if the client didn't provide any. Third-party
  // Anthropic SDK users rarely set cache_control — without markers, no
  // caching and no KA protection. injectCacheMarkers respects existing
  // markers (won't overwrite if client already set them).
  injectCacheMarkers(body)

  return { body: JSON.stringify(body), headers }
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

