/**
 * Config — reads ~/.config/claude-max-proxy/.env with overrides from process.env.
 * Keeps Bun-side of everything simple: one import, one config object.
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ANTHROPIC_API_BASE } from '@life-ai-tools/claude-code-sdk'

export interface ProxyConfig {
  // Logging
  logLevel: 'error' | 'info' | 'debug'
  logFormat: 'human' | 'json' | 'both'
  logFile: string
  logJsonl: string
  // High-frequency heartbeat kinds (PROXY_KA_TICK, HEALTH_HEARTBEAT) go to their
  // OWN jsonl instead of the request journal. Measured 2026-08-18: 71 284 of
  // 91 595 lines (77.8%) were KA ticks, so the request journal — the one that
  // answers "did this session pass through, and how did it end" — covered only
  // ~4.5h before rotation dropped it. Splitting buys ~4.5x the depth for the
  // same disk budget. The HUMAN log is deliberately left whole: proxy-doctor
  // reads it for per-session tick liveness.
  logJsonlHeartbeat: string
  // Size-based rotation for the append-only human + JSONL streams.
  // logMaxMb = per-stream byte cap before rotating (0 = unbounded, never rotate).
  // logKeep  = number of rotated backups to retain (.1 … .<logKeep>).
  // logGzip  = gzip rotated backups (.N.gz) asynchronously after rotation.
  // Disk per stream is bounded at ~(logKeep + 1) × logMaxMb (uncompressed);
  // with logGzip the backups shrink ~10× (these logs are highly repetitive).
  logMaxMb: number
  logKeep: number
  logGzip: boolean

  // KA tuning. kaIntervalSec is OPTIONAL — when unset, KeepaliveEngine reads
  // its default from SSOT (~/.claude/keepalive.json) which auto-scales with
  // cacheTtlMs (legacy 5m → 150s, 1h → 1800s).
  kaIntervalSec: number | undefined
  // Per-consumer cache TTL pin in seconds. DEFAULT 3600 (1h): the SDK upgrades
  // native CC's `cache_control:ephemeral` markers to ttl:'1h' on the wire, so the
  // real cache lives 1h and KA fires every ~30min against a genuinely-1h cache.
  // The KeepaliveEngine wire-autoscan still downlocks any session to 300s if it
  // observes an un-upgraded marker. (Must match the deployed/live default — a
  // 300 default makes the engine over-fire a warm 1h cache ~12×.) See
  // ProxyClientConfig.kaCacheTtlSec docs. Override via KA_CACHE_TTL_SEC env.
  kaCacheTtlSec: number
  kaIdleTimeoutSec: number  // 0 = never stop
  kaMinTokens: number

  // Rewrite guard
  kaRewriteWarnIdleSec: number
  kaRewriteWarnTokens: number
  kaRewriteBlockIdleSec: number
  kaRewriteBlockEnabled: boolean

  // Network
  proxyPort: number
  proxyHost: string
  adminToken: string | null

  // Summary heartbeat
  healthHeartbeatSec: number  // 0 = disabled

  // Credentials
  credentialsPath: string

  // Upstream
  anthropicBaseUrl: string

  // OpenAI compat
  openaiCompatAuthToken: string | null
  openaiCompatThinking: 'strip' | 'field'

  // Spark responses (Muse Spark via opencode-go gateway)
  sparkApiKey: string | null
  sparkUpstreamUrl: string
  sparkUserAgent: string
  sparkReasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  // Organization id for the opencode console org. The NEW org serves Go at
  // /inference/go and REQUIRES header x-opencode-org-id (403 without it, measured
  // 2026-10-08). Empty = header not sent, so the legacy zen/go config is untouched.
  sparkOrgId: string | null

  // Go door (/go/*): registry of OpenCode Go orgs + the pass store. Both unset = door answers 503 loudly.
  goRegistryPath: string | null
  goTokensPath: string | null
  goUserAgent: string
  // Constant on purpose: the gateway scopes its cache by this header (architecture R6 — do NOT vary
  // it per conversation before measurement 5.4 says what changes).
  goProviderSession: string

  // Сторож переписи для двери Go. Замер 23.10 по 72 часам трафика Go: перезапись
  // из-за смены префикса — 2.8% токенов входа (517 млн из 18.2 млрд), и 92% из них
  // «промпт вырос, а кэша нет», то есть перепись при ЖИВОМ кэше. Сторож нужен ровно
  // для этого случая: остановить ход, который покупает заново уже оплаченный префикс,
  // и назвать место расхождения. По умолчанию ВЫКЛЮЧЕН: пока он не проверен на живом
  // трафике, включение — решение человека, а не следствие выката.
  goRewriteGuardEnabled: boolean
  // Порог в токенах: ниже него перепись дешевле разбирательства, чем отказ. Оценка
  // токенов — bodyBytes/4 (тот же способ, что у стожа Anthropic); 50000 — тот же
  // порядок, что у KA_REWRITE_WARN_TOKENS, и отсекает мелкие сессии.
  goRewriteGuardMinTokens: number
  // Метка согласия в ПОСЛЕДНЕМ сообщении пользователя — человек или агент может
  // напечатать её сам, без CLI и без файла. Та же метка, что у сторожа Anthropic.
  goRewriteGuardMarker: string
  // Файл одноразовых пропусков (consent), общий с SDK: срок жизни пропуска —
  // см. goRewriteGuardGrantTtlSec. Путь через expandHome, чтобы `~` работал.
  goRewriteGuardGrantPath: string
  // Сколько живёт кэш GO-маршрута. 2700 с (45 мин) — граница «кэш ещё жив» по
  // измеренной кривой этой двери (53 674 вызова / 72 ч): доля чтений падает
  // 95% (<5 мин) → 85% (15–20) → 37% (40–45), а после 45 мин медиана обваливается
  // до 0.5%, то есть кэша нет. Значение попадает и в решение, и в текст отказа.
  goRewriteGuardCacheTtlSec: number
  // Срок жизни одноразового пропуска согласия, секунды. 180 с — как у CLI-формы
  // Anthropic: пропуск должен дождаться ближайшего хода, но не пережить его.
  goRewriteGuardGrantTtlSec: number
  // 🔴 ХОЛОДНАЯ ПЕРЕПИСЬ — ОТДЕЛЬНЫЙ КЛЮЧ (фаундер 24.10.2026: «включай, если готово, но с
  // автоматическим откатом, если всё поплывёт»). Основной сторож останавливает только перепись
  // при ЖИВОМ кэше; этот ключ добавляет второй случай — кэш уже истёк, и ход покупает большой
  // префикс заново. Отдельный ключ, а не изменение поведения по умолчанию: у случаев разная
  // природа, и включать их надо по отдельности.
  goRewriteGuardColdEnabled: boolean
  // 🔴 ЯВНОЕ ЗНАЧЕНИЕ ОПЕРАТОРА ВЫШЕ РЕЕСТРА. Пороги живут у модели (24.10), но человеку нужен
  // способ проверить сторожа на живом, не правя реестр: если ключ задан В ФАЙЛЕ ИЛИ ОКРУЖЕНИИ —
  // он главный. Иначе порядок такой: значение модели → встроенное умолчание.
  goRewriteGuardCacheTtlSecExplicit: boolean
  goRewriteGuardMinTokensExplicit: boolean
  // 🔴 АВТО-ОТКАТ: сколько секунд наблюдать, прежде чем признать, что сторож всех остановил.
  // Условие откката — не время само по себе (иначе он выключится и при полном порядке), а
  // «были отказы И НИ ОДНОГО пропуска»: значит мы тормозим и ничего не доходит. 0 = выключено.
  goRewriteGuardAutoRevertSec: number
  // Экономическое колено: после какого простоя запись префикса считается дорогой. НЕ срок жизни
  // кэша — отдельное число (1200 с = 20 мин, слово фаундера и замер wake-router).
  goRewriteGuardColdAfterSec: number
  /**
   * 🔴 КОГО СТОРОЖ ХОЛОДНОЙ ЗАПИСИ НЕ ТРОГАЕТ — по `user-agent` (подстрока, без регистра).
   *
   * Заведено 30.10.2026 под ОДИН живой случай: разговор в чат-сервисе (`kiberos-chat`),
   * вернувшийся после 7 часов простоя, получил 10 отказов подряд — человеку сторож предлагал
   * «перезапусти сессию», а у человека нет другой сессии, есть только этот разговор.
   *
   * Сам список ПУСТ ПО УМОЛЧАНИЮ, то есть поведение не меняется ни для кого. Пустым он и должен
   * остаться, пока фаундер не скажет, платим ли мы такие записи для чата: это вопрос денег
   * (месячное окно), а не техники. Ключ даёт ответу быть ОДНОЙ СТРОКОЙ в `.env`, а не выкаткой.
   */
  goRewriteGuardExemptUas: string[]
  goRewriteGuardColdAfterSecExplicit: boolean

  // Subscription compat layer (hot-configurable for binary distribution)
  ccCompatVersion: string
  extraBetaFlags: string[]
}

const DEFAULT_ENV_PATH = join(homedir(), '.config', 'claude-max-proxy', '.env')

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function read(key: string, fallback: string, fileEnv: Record<string, string>): string {
  return process.env[key] ?? fileEnv[key] ?? fallback
}

function readInt(key: string, fallback: number, fileEnv: Record<string, string>): number {
  const v = read(key, String(fallback), fileEnv)
  const parsed = parseInt(v, 10)
  return isNaN(parsed) ? fallback : parsed
}

function readBool(key: string, fallback: boolean, fileEnv: Record<string, string>): boolean {
  const v = read(key, String(fallback), fileEnv).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

let _cached: ProxyConfig | null = null

export function loadConfig(envPath: string = DEFAULT_ENV_PATH): ProxyConfig {
  if (_cached) return _cached

  const fileEnv = parseDotEnv(envPath)

  const logLevel = read('LOG_LEVEL', 'info', fileEnv) as ProxyConfig['logLevel']
  if (!['error', 'info', 'debug'].includes(logLevel)) {
    console.error(`[config] Invalid LOG_LEVEL="${logLevel}", falling back to info`)
  }
  const logFormat = read('LOG_FORMAT', 'human', fileEnv) as ProxyConfig['logFormat']

  _cached = {
    logLevel: ['error', 'info', 'debug'].includes(logLevel) ? logLevel : 'info',
    logFormat: ['human', 'json', 'both'].includes(logFormat) ? logFormat : 'human',
    logFile: expandHome(read('LOG_FILE', '~/.claude/claude-max-proxy.log', fileEnv)),
    logJsonl: expandHome(read('LOG_JSONL', '~/.claude/claude-max-proxy.jsonl', fileEnv)),
    logJsonlHeartbeat: expandHome(read(
      'LOG_JSONL_HEARTBEAT',
      read('LOG_JSONL', '~/.claude/claude-max-proxy.jsonl', fileEnv)
        .replace(/\.jsonl$/, '') + '-heartbeat.jsonl',
      fileEnv,
    )),
    // Default 100 MB × 5 backups per stream (~600 MB ceiling for the JSONL,
    // which was observed unbounded at ~196 MB). 0 disables rotation.
    logMaxMb: readInt('LOG_MAX_MB', 100, fileEnv),
    logKeep: readInt('LOG_KEEP', 5, fileEnv),
    // Default ON — parity with the prior system logrotate (compress) it replaced;
    // these streams compress ~10×. Async (node:zlib stream), never blocks the
    // request path. Set LOG_GZIP=false for plain .N backups.
    logGzip: readBool('LOG_GZIP', true, fileEnv),

    // KA_INTERVAL_SEC unset → defer to SSOT (~/.claude/keepalive.json).
    // Set explicitly only to override the SSOT-resolved interval for this proxy instance.
    kaIntervalSec: process.env.KA_INTERVAL_SEC || fileEnv.KA_INTERVAL_SEC
      ? readInt('KA_INTERVAL_SEC', 0, fileEnv) || undefined
      : undefined,
    // 5min default = native CC wire TTL. Wire-autoscan in KeepaliveEngine
    // will further lock down per-session if it observes shorter markers.
    kaCacheTtlSec: readInt('KA_CACHE_TTL_SEC', 3600, fileEnv),
    kaIdleTimeoutSec: readInt('KA_IDLE_TIMEOUT_SEC', 0, fileEnv),
    kaMinTokens: readInt('KA_MIN_TOKENS', 2000, fileEnv),

    kaRewriteWarnIdleSec: readInt('KA_REWRITE_WARN_IDLE_SEC', 300, fileEnv),
    kaRewriteWarnTokens: readInt('KA_REWRITE_WARN_TOKENS', 50000, fileEnv),
    kaRewriteBlockIdleSec: readInt('KA_REWRITE_BLOCK_IDLE_SEC', 0, fileEnv),
    kaRewriteBlockEnabled: readBool('KA_REWRITE_BLOCK_ENABLED', false, fileEnv),

    proxyPort: readInt('PROXY_PORT', 5050, fileEnv),
    proxyHost: read('PROXY_HOST', '127.0.0.1', fileEnv),
    // Control-plane bearer token (/mcp + /admin/*). Empty = remote control
    // plane DISABLED (loopback callers always allowed). See control-auth.ts.
    adminToken: read('ADMIN_TOKEN', '', fileEnv) || null,

    healthHeartbeatSec: readInt('HEALTH_HEARTBEAT_SEC', 30, fileEnv),

    credentialsPath: expandHome(read('CLAUDE_CREDENTIALS_PATH', '~/.claude/.credentials.json', fileEnv)),

    // Upstream URL — SSOT per REQ-12 / SSOT-01 (anthropic-endpoints.ts).
    // ANTHROPIC_UPSTREAM_URL env override stays available for test/dev pointing
    // at a local MITM proxy; default delegates to the SDK SSOT constant.
    anthropicBaseUrl: read('ANTHROPIC_UPSTREAM_URL', ANTHROPIC_API_BASE, fileEnv),

    openaiCompatAuthToken: read('OPENAI_COMPAT_AUTH_TOKEN', '', fileEnv) || null,
    openaiCompatThinking: (['strip', 'field'].includes(read('OPENAI_COMPAT_THINKING', 'strip', fileEnv))
      ? read('OPENAI_COMPAT_THINKING', 'strip', fileEnv)
      : 'strip') as 'strip' | 'field',

    // Spark responses — key via established order (process env → file env);
    // absent key is refused loudly by the module, never a silent fallback.
    sparkApiKey: read('SPARK_API_KEY', '', fileEnv) || null,
    sparkUpstreamUrl: read('SPARK_UPSTREAM_URL', 'https://opencode.ai/zen/go/v1', fileEnv),
    sparkUserAgent: read('SPARK_USER_AGENT', 'claude-max-proxy-spark/1.0', fileEnv),
    sparkOrgId: read('SPARK_ORG_ID', '', fileEnv) || null,
    goRegistryPath: read('GO_REGISTRY_PATH', '', fileEnv) || null,
    goTokensPath: read('GO_TOKENS_PATH', '', fileEnv) || null,
    goUserAgent: read('GO_USER_AGENT', 'kiberos-chat/1.0', fileEnv),
    goProviderSession: read('GO_PROVIDER_SESSION', 'kiberos-litellm-subagents', fileEnv),

    // Сторож переписи двери Go — выключен по умолчанию (см. комментарий у полей).
    goRewriteGuardEnabled: readBool('GO_REWRITE_GUARD_ENABLED', false, fileEnv),
    goRewriteGuardMinTokens: readInt('GO_REWRITE_GUARD_MIN_TOKENS', 50000, fileEnv),
    goRewriteGuardMarker: read('GO_REWRITE_GUARD_MARKER', '[%cache-rewrite-ok%]', fileEnv),
    goRewriteGuardGrantPath: expandHome(read(
      'GO_REWRITE_GUARD_GRANT_PATH', '~/.claude-local/cache-rewrite-grants.json', fileEnv,
    )),
    // 45 мин — измеренное колено кэша на маршруте Go (см. комментарий у поля).
    goRewriteGuardCacheTtlSec: readInt('GO_REWRITE_GUARD_CACHE_TTL_SEC', 2700, fileEnv),
    goRewriteGuardGrantTtlSec: readInt('GO_REWRITE_GUARD_GRANT_TTL_SEC', 180, fileEnv),
    goRewriteGuardColdEnabled: readBool('GO_REWRITE_GUARD_COLD_ENABLED', false, fileEnv),
    goRewriteGuardCacheTtlSecExplicit:
      process.env['GO_REWRITE_GUARD_CACHE_TTL_SEC'] !== undefined
      || Object.prototype.hasOwnProperty.call(fileEnv, 'GO_REWRITE_GUARD_CACHE_TTL_SEC'),
    goRewriteGuardMinTokensExplicit:
      process.env['GO_REWRITE_GUARD_MIN_TOKENS'] !== undefined
      || Object.prototype.hasOwnProperty.call(fileEnv, 'GO_REWRITE_GUARD_MIN_TOKENS'),
    goRewriteGuardAutoRevertSec: readInt('GO_REWRITE_GUARD_AUTOREVERT_SEC', 120, fileEnv),
    goRewriteGuardColdAfterSec: readInt('GO_REWRITE_GUARD_COLD_AFTER_SEC', 1200, fileEnv),
    goRewriteGuardExemptUas: read('GO_REWRITE_GUARD_EXEMPT_UAS', '', fileEnv)
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    goRewriteGuardColdAfterSecExplicit:
      process.env['GO_REWRITE_GUARD_COLD_AFTER_SEC'] !== undefined
      || Object.prototype.hasOwnProperty.call(fileEnv, 'GO_REWRITE_GUARD_COLD_AFTER_SEC'),
    sparkReasoningEffort: (['minimal', 'low', 'medium', 'high'].includes(read('SPARK_REASONING_EFFORT', 'minimal', fileEnv))
      ? read('SPARK_REASONING_EFFORT', 'minimal', fileEnv)
      : 'minimal') as 'minimal' | 'low' | 'medium' | 'high',

    // Floor only — the installed Claude Code wins when newer (cc-version.ts). Sidecars have
    // no Claude Code, so this default IS their version: 2.1.280 is the minimum for opus-5-5.
    ccCompatVersion: read('CC_COMPAT_VERSION', '2.1.280', fileEnv),
    extraBetaFlags: read('EXTRA_BETA_FLAGS', '', fileEnv)
      .split(',').map(s => s.trim()).filter(Boolean),
  }

  return _cached
}

/** For testing — reset cached config. */
export function _resetConfig(): void { _cached = null }
