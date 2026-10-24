/**
 * models.ts — Single Source of Truth for claude-max model metadata
 *
 * All packages in this SDK chain consume their model metadata from this file:
 *   - src/sdk.ts                              uses resolveMaxTokens() for final HTTP body
 *   - packages/claude-max-provider/src/index.ts  uses resolveMaxTokens() for AI-SDK adapter defaults
 *   - packages/opencode-claude/provider.ts       uses MAX_MODELS + resolveMaxTokens()
 *   - packages/opencode-claude/index.ts          uses MAX_MODELS for provider registration
 *
 * Values chosen to mirror the native @anthropic-ai/claude-code CLI's wa() function
 * (per-model default + upperLimit). See audit at:
 *   ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js
 *
 * Rationale for mirroring the native CLI:
 *   1) Prevents the "max_tokens cut-off" retry loop we observed on pid=1660075
 *      (2026-04-11) — 12 consecutive max_tokens failures because we capped output
 *      at 16384 when the model could have emitted 64000.
 *   2) Anthropic's claude-max OAuth endpoint accepts the same max_tokens values as
 *      the regular API.
 *   3) max_tokens is a HARD ceiling (truncation), not a budget. Setting it too low
 *      causes truncated tool-call JSON → retries. Setting it to the model's real
 *      upperLimit is safe — the model stops naturally when done.
 *
 * Environment overrides (checked in order):
 *   1. Explicit user override passed to sdk.generate({ maxTokens })         — wins
 *   2. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var                                — per-process override
 *   3. Per-model default from MAX_MODELS[modelId].default                   — baseline
 */

export interface ModelMetadata {
  /** Display name shown in UI */
  name: string
  /** Input context window (tokens). 1_000_000 for 1M-context betas. */
  context: number
  /**
   * Default max_tokens to send on the HTTP request for this model.
   * Mirrors native CLI's wa(model).default.
   * This is the "happy path" cap — high enough that most generations
   * complete naturally without truncation.
   */
  defaultOutput: number
  /**
   * Absolute ceiling this model+subscription will accept.
   * Mirrors native CLI's wa(model).upperLimit.
   * User can bump default up to this via CLAUDE_CODE_MAX_OUTPUT_TOKENS env var.
   */
  maxOutput: number
  /** Whether this model supports adaptive thinking (SDK sets { type: 'adaptive' }) */
  adaptiveThinking: boolean
  /**
   * Whether this model still accepts sampling params (temperature/top_p/top_k).
   * Removed (400 if sent) on opus-4-7+, opus-4-8 and fable-5.
   */
  samplingParams: boolean
  /**
   * What an OMITTED `thinking` field means on this model. 'on' = the model runs
   * adaptive thinking by default (opus-5, sonnet-5, fable-5/5.1, opus-5-5);
   * 'off' = it runs without thinking (opus-4-8/4-7 and older).
   * Absent = 'off' (the historical behaviour).
   */
  thinkingDefault?: 'on' | 'off'
  /**
   * False when an explicit `thinking: {type: "disabled"}` is REJECTED with a 400
   * (fable-5, fable-5-1, opus-5-5) — thinking is always on and the field must be
   * omitted. Absent = true.
   */
  thinkingCanDisable?: boolean
  /** Equivalent API pricing (USD per million tokens) — for savings display on Max subscription */
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  /**
   * МАРШРУТ, который обслуживает модель. Отсутствие поля = `anthropic` (историческое
   * поведение, все записи до 24.10.2026).
   *
   * 🔴 ЗАЧЕМ (слово фаундера 24.10.2026: «разве нет реестра моделей и провайдеров, или мы
   * каждый раз хардкодим?»). До этого реестр знал ТОЛЬКО Claude, а модели Go жили в конфиге
   * посредника со своими ценами, подогнанными руками. Одна ось — одно место.
   *
   * Потребители, которые регистрируют МОДЕЛИ CLAUDE у провайдера, обязаны пропускать чужие
   * маршруты: `provider !== 'opencode-go'`. Иначе модели Go всплывут в списке Claude.
   */
  provider?: 'anthropic' | 'opencode-go'
  /**
   * Сколько живёт кэш префикса у ЭТОЙ модели (секунды). Отсутствие = глобальная настройка
   * (`GO_REWRITE_GUARD_CACHE_TTL_SEC`). Поле появилось 24.10.2026: порог был один на всех,
   * а у разных моделей и маршрутов срок кэша разный — «одно число на всех» это то же самое
   * «число без своего предмета», только в виде настройки.
   */
  cacheTtlSec?: number
  /**
   * Порог «сколько токенов ПЕРЕПИШЕТСЯ», выше которого сторож останавливает ход.
   * Отсутствие = глобальная настройка (`GO_REWRITE_GUARD_MIN_TOKENS`).
   */
  rewriteMinTokens?: number
  /**
   * 🔴 ЭКОНОМИЧЕСКОЕ КОЛЕНО: после какого простоя ЗАПИСЬ префикса считается дорогой (секунды).
   * Это НЕ срок жизни кэша — тот в `cacheTtlSec`. Кэш может быть ещё жив, но с этого момента
   * цена промаха и цена новой сессии сравниваются, и человеку пора предложить выбор.
   *
   * Замер владельца wake-router 24.10.2026: прогрев $0.00162 против холодного старта $0.0784 —
   * чтение дешевле в ~48 раз, безубыточность 16.2 ч при шаге 20 мин. Отсюда 1200 с у моделей Go;
   * это же число называл фаундер («обычно 20 минут»).
   */
  coldRewriteAfterSec?: number
}

/**
 * Single source of truth for all claude-max models.
 *
 * Keyed by the Anthropic model ID (as sent in the `model` field of the
 * /v1/messages request body). Add new models here as they ship on the
 * Max/Pro subscription.
 */
export const MAX_MODELS: Record<string, ModelMetadata> = {
  // 🔴 ORDER MATTERS: getModelMetadata() fuzzy-matches by substring in insertion
  // order, and 'claude-opus-5-5-…' also contains 'claude-opus-5'. Point releases
  // go ABOVE their base model.
  //
  // Fable 5.1 — successor to Fable 5, same tier and per-token price, but cache
  // reads are $0.25 (NOT the 0.1× convention). Thinking always on ({type:"disabled"}
  // → 400), forced tool_choice any/tool → 400.
  'claude-fable-5-1': {
    name: 'Claude Fable 5.1',
    context: 1_000_000,
    defaultOutput: 64_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',
    thinkingCanDisable: false,
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
  // Opus 5.5 — released 2026-09-22; successor to Opus 5 at a lower price.
  // Cache reads $0.20 (NOT 0.1× = 0.40). Thinking can't be disabled at any
  // effort ({type:"disabled"} → 400); effort defaults to 'medium'; forced
  // tool_choice any/tool → 400. Needs Claude Code ≥ 2.1.280 (server-side gate).
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    context: 1_000_000,
    defaultOutput: 64_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',
    thinkingCanDisable: false,
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  // Fable 5 — new tier above Opus. Adaptive-only thinking; sampling params
  // (temperature/top_p/top_k) and budget_tokens are REMOVED (400 if sent).
  // Quirk vs opus-4-7/4-8: an explicit thinking:{type:"disabled"} also 400s —
  // the thinking field must be OMITTED entirely when thinking is off.
  'claude-fable-5': {
    name: 'Claude Fable 5',
    context: 1_000_000,
    defaultOutput: 64_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',
    thinkingCanDisable: false,
    cost: { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  },
  // Opus 5 — released 2026-07-24; replaces Opus 4.8 as the flagship Opus tier.
  // Same adaptive-only class as Fable 5 / Opus 4.7-4.8: sampling params
  // (temperature/top_p/top_k) and budget_tokens are REMOVED (400 if sent);
  // adaptive thinking is the only on-mode (effort defaults to high).
  'claude-opus-5': {
    name: 'Claude Opus 5',
    context: 1_000_000,
    defaultOutput: 64_000,   // flagship happy-path cap (mirrors opus-4-8)
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',   // unlike opus-4-8/4-7, omitting `thinking` runs adaptive
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  // Sonnet 5.5 — shipped in Claude Code 2.1.284 (2026-09-30) as the default Sonnet.
  // Facts from the CLI's baked model catalog (2.1.286): 1M native, 128k output
  // default = upper, pricing tier_2_10 (cache_write_5m 2.5, cache_read 0.2 — the
  // 0.1× convention would say 0.2 here, it happens to hold), capability
  // `rejects_disabled_thinking` ({type:"disabled"} → 400, like opus-5-5), default
  // effort 'medium'. Must sit ABOVE claude-sonnet-5: the fuzzy matcher otherwise
  // lands it on Sonnet 5 — 3/15 price and a thinking repair that never fires.
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5',
    context: 1_000_000,
    defaultOutput: 128_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',
    thinkingCanDisable: false,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  // Sonnet 5 — released 2026-07-24; near-Opus quality in the Sonnet tier.
  // Adaptive thinking on by default; sampling params + budget_tokens REMOVED
  // (400 if sent). Standard price $3/$15 (intro $2/$10 through 2026-08-31 —
  // NOT encoded here to avoid a time-bomb in the savings display).
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    context: 1_000_000,
    defaultOutput: 64_000,   // Opus-tier quality now → generous cap vs 4.6's 32k
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: false,
    thinkingDefault: 'on',
    cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    context: 1_000_000,
    defaultOutput: 64_000,   // native CLI wa() default (mirrors 4.7 flagship)
    maxOutput: 128_000,      // native CLI wa() upperLimit
    adaptiveThinking: true,
    samplingParams: false,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    context: 1_000_000,
    defaultOutput: 64_000,   // native CLI wa() default
    maxOutput: 128_000,      // native CLI wa() upperLimit
    adaptiveThinking: true,
    samplingParams: false,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    context: 1_000_000,
    defaultOutput: 64_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    context: 1_000_000,
    defaultOutput: 32_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    samplingParams: true,
    cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'claude-haiku-4-5-20251001': {
    name: 'Claude Haiku 4.5',
    context: 200_000,
    defaultOutput: 32_000,
    maxOutput: 64_000,
    adaptiveThinking: false,
    samplingParams: true,
    cost: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },

  // ── МАРШРУТ OpenCode Go ────────────────────────────────────────────────────────────────
  // 🔴 ЭТИ ДВЕ ЗАПИСИ ЖИЛИ В КОНФИГЕ ПОСРЕДНИКА, а не в реестре (до 24.10.2026). Цены были
  // подогнаны там же по 998 замерам (`console-log-fit-998`), и выходило три места с числами о
  // моделях: здесь, в алиасах и в конфиге. Теперь цена и настройки сторожа — тут, а конфиг
  // посредника остаётся тем, что он есть: маршрут и учётные данные.
  //
  // `cacheWrite` у обеих — по цене входа: отдельной платы за запись кэша у Go нет
  // (комментарий владельца конфига).
  'deepseek-v4.1-flash-go': {
    name: 'DeepSeek V4.1 Flash (OpenCode Go)',
    context: 1_048_576,
    defaultOutput: 32_000,
    maxOutput: 64_000,
    adaptiveThinking: false,
    samplingParams: true,
    provider: 'opencode-go',
    cost: { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0.15 },
    // 🔴 35 МИНУТ — ТОЧКА ПЕРЕЛОМА, А НЕ «СРОК ЖИЗНИ» (замер 24.10.2026, 48 ч, 20 295 вызовов
    // Go с ИЗВЕСТНОЙ цифрой; строки с NULL `cached_tokens` исключены — они значат «поставщик не
    // отдал цифру», а не «кэш не прочитан»).
    //
    // простой → медиана чтения / доля ПОЛНЫХ попаданий (>90%) / ровно ноль:
    //   до 30 мин  99.8% / 96.8% / 0.8%   ← почти всё попадает
    //   30–40       0.8% / 48.1% / 7.4%   ← ПЕРЕЛОМ: половина попадает, половина нет
    //   40–45       0.5% / 37.5% / 0%
    //   45–50       0.5% /  0%   / 0%
    //   50–60       0.4% / 12.2% / 14.6%
    //   >180        0.5% /  0%   / 0%
    //
    // 🔴 ФОРМА ОТВЕТА ВАЖНЕЕ ЧИСЛА: попадание ВСЕ-ИЛИ-НИЧЕГО, а не постепенное угасание.
    // Так выглядит истечение записи (TTL/вытеснение), а не смена содержимого: смена префикса
    // была бы равномерной и на коротких простоях тоже. «Ровно ноль» при этом редок (0–15%) —
    // после промаха почти всегда приходит небольшой остаток, поэтому булев счёт «был/не был»
    // и врал.
    //
    // 45 минут — это край, где полных попаданий уже НОЛЬ; 35 — где их перестаёт быть больше
    // половины. Гейт спрашивает «должен ли был попасть», поэтому берём перелом.
    // ВЫБОРКА ЗА 30 МИНУТАМИ ТОНКАЯ (136 наблюдений) — число честное по направлению, но не по
    // секунде; пересчитать, когда трафик пойдёт через нашу дверь.
    cacheTtlSec: 2_100,
    rewriteMinTokens: 50_000,
    // 🔴 25 МИНУТ, И ЭТО ПАРА С ПРОГРЕВОМ, А НЕ САМОСТОЯТЕЛЬНОЕ ЧИСЛО (слово фаундера 24.10.2026).
    // Было 5 — и он поправил: «5 минут это прям нормальная живая ситуация, агента будет слишком
    // часто будить». Смысл пары: прогрев трогает сессию РАНЬШЕ сторожа (около 20), а сторож бьёт
    // только то, что не тронули и через 25. Так блокируется не «пауза», а «пауза, которую прогрев
    // не закрыл», и это уже настоящее событие, а не помеха работе.
    //
    // Замер за спиной: доля промахов по большим сессиям растёт с простоем — 1.8% до 30 c, 4.7% на
    // 2–5 мин, 10.4% на 5–10, 31.3% после 20. Но блокировать всё, где риск вырос, значит мешать
    // работе; поэтому порог стоит ТАМ, ГДЕ СВЯЗКА С ПРОГРЕВОМ УЖЕ ДОЛЖНА БЫЛА СРАБОТАТЬ.
    coldRewriteAfterSec: 1_500,
  },
  'muse-spark-1.3-contributor': {
    name: 'Muse Spark 1.3 Contributor (OpenCode Go)',
    context: 1_000_000,
    defaultOutput: 32_000,
    maxOutput: 64_000,
    adaptiveThinking: false,
    samplingParams: true,
    provider: 'opencode-go',
    cost: { input: 0.10, output: 0.20, cacheRead: 0.002, cacheWrite: 0.10 },
    cacheTtlSec: 1_800,
    rewriteMinTokens: 50_000,
    coldRewriteAfterSec: 1_500,
  },
}

/** Fallback for unknown/unlisted models — mirrors native CLI's else-branch in wa() */
export const FALLBACK_MODEL: Pick<ModelMetadata, 'defaultOutput' | 'maxOutput' | 'adaptiveThinking'> = {
  defaultOutput: 32_000,
  maxOutput: 128_000,
  adaptiveThinking: false,
}

/**
 * Resolve max_tokens for the final HTTP request body.
 *
 * Priority order:
 *   1. explicitOverride (user passed sdkOpts.maxTokens / maxOutputTokens)
 *   2. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (clamped to model.maxOutput)
 *   3. Per-model default (MAX_MODELS[modelId].defaultOutput)
 *   4. Global fallback (FALLBACK_MODEL.defaultOutput = 32000)
 *
 * @param modelId  Anthropic model id (e.g. "claude-opus-4-7")
 * @param explicitOverride  User-provided override (from generate/stream options)
 * @returns number of tokens to send as `max_tokens` in the HTTP request body
 */
export function resolveMaxTokens(modelId: string, explicitOverride?: number): number {
  if (typeof explicitOverride === 'number' && explicitOverride > 0) {
    return explicitOverride
  }

  const meta = getModelMetadata(modelId)
  const maxAllowed = meta?.maxOutput ?? FALLBACK_MODEL.maxOutput
  const defaultVal = meta?.defaultOutput ?? FALLBACK_MODEL.defaultOutput

  const envRaw = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (envRaw) {
    const parsed = parseInt(envRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      // Clamp to model's documented maxOutput to avoid 400 "max_tokens exceeds
      // model max" errors from Anthropic.
      return Math.min(parsed, maxAllowed)
    }
  }

  return defaultVal
}

/**
 * Lookup model metadata with fuzzy matching.
 * Matches on substring (so 'claude-opus-4-7' lookup matches 'claude-opus-4-7-20251115')
 * falling through to exact-match then prefix-match.
 */
export function getModelMetadata(modelId: string): ModelMetadata | undefined {
  if (MAX_MODELS[modelId]) return MAX_MODELS[modelId]
  const lower = modelId.toLowerCase()
  for (const [id, meta] of Object.entries(MAX_MODELS)) {
    if (lower.includes(id) || id.includes(lower)) return meta
  }
  // Substring match on model family (opus-4-7, sonnet-4-6, etc.)
  for (const [id, meta] of Object.entries(MAX_MODELS)) {
    const family = id.replace(/^claude-/, '').split('-').slice(0, 3).join('-')
    if (lower.includes(family)) return meta
  }
  return undefined
}

/**
 * Check whether a model supports adaptive thinking mode.
 * (The SDK sets thinking: { type: 'adaptive' } for these models instead of the
 * older { type: 'enabled', budgetTokens: N } format.)
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const meta = getModelMetadata(modelId)
  if (meta) return meta.adaptiveThinking
  // Legacy fuzzy checks for models not in the table (e.g. preview variants)
  const lower = modelId.toLowerCase()
  return (
    lower.includes('opus-5') ||
    lower.includes('sonnet-5') ||
    lower.includes('fable-5') ||
    lower.includes('opus-4-8') ||
    lower.includes('opus-4-7') ||
    lower.includes('opus-4-6') ||
    lower.includes('sonnet-4-6') ||
    lower.includes('sonnet-4-7')
  )
}

/**
 * Check whether a model still accepts sampling params (temperature/top_p/top_k).
 * Removed (400 if sent) on opus-4-7, opus-4-8 and fable-5 — and presumably on
 * every model after them, so unknown models default to the registry fallback
 * via fuzzy match, then to a conservative substring check.
 */
export function supportsSamplingParams(modelId: string): boolean {
  const meta = getModelMetadata(modelId)
  if (meta) return meta.samplingParams
  const lower = modelId.toLowerCase()
  // Unknown model: deny only for known sampling-removed families
  return !(
    lower.includes('opus-5') ||
    lower.includes('sonnet-5') ||
    lower.includes('fable-5') ||
    lower.includes('opus-4-8') ||
    lower.includes('opus-4-7')
  )
}
