/**
 * Проход по ВСЕМ организациям Go по расписанию — продление не только «по требованию».
 *
 * 🔴 ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОХОД. Продление в `go-token-refresh.ts` срабатывает, когда пропуск
 * БЕРУТ: порог семь суток, проверка перед каждым использованием. Но у нас девять организаций,
 * и часть из них — запас, который неделями не вызывают. У такой организации проверка «перед
 * использованием» не наступит никогда, а пропуск истечёт — тихо, без единого отказа в журнале,
 * и всплывёт это в тот день, когда запас понадобится. То есть ленивая проверка защищает ровно
 * те организации, которые и так используются, и не защищает те, ради которых запас держат.
 *
 * Антропная сторона это уже знает: там proactive-loop обходит все организации. Здесь — то же
 * самое для Go.
 *
 * ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ вместе с самим продлением: без `GO_TOKEN_REFRESH_ENABLED='true'`
 * проход не делает ни одного запроса и не пишет ни байта. Пока в хранилище пишет Python-обновлятор
 * kiberos-app, второй писатель обесценил бы его (поставщик ротирует refresh-токен при каждом
 * продлении).
 *
 * Отказ по одной организации не останавливает проход по остальным: одна мёртвая орг не должна
 * лишать продления восемь живых.
 */

import { readFileSync } from 'node:fs'
import { loadRegistry } from './go-registry.js'
import type { GoOrg } from './go-registry.js'
import { goTokenRefreshEnabled, mergeIncomingTokens, withFreshGoCredential } from './go-token-refresh.js'
import type { CredentialSources } from './go-credentials.js'

/** Как часто обходим организации. Полчаса — много чаще порога семи суток, но и не шум. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60_000

export interface GoSweepConfig {
  registryPath: string | null
  tokensPath: string | null
  environ: Record<string, string | undefined>
  userAgent: string
}

export interface GoSweepDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  intervalMs?: number
  /** Куда сказать о результате. По умолчанию — ничего: проход, которому нечего сказать, молчит. */
  log?: (line: string) => void
}

export interface GoSweepOutcome {
  checked: number
  refreshed: number
  failed: Array<{ org: string; reason: string }>
  merged: string[]
}

/**
 * Один проход: влить новые входы, затем проверить каждую консольную организацию.
 * Возвращает сводку — её же печатает вызывающий, если ему есть куда.
 */
export async function sweepGoTokens(cfg: GoSweepConfig, deps: GoSweepDeps = {}): Promise<GoSweepOutcome> {
  const outcome: GoSweepOutcome = { checked: 0, refreshed: 0, failed: [], merged: [] }
  if (!goTokenRefreshEnabled(cfg.environ)) return outcome
  if (!cfg.tokensPath || !cfg.registryPath) return outcome

  // Новые входы вливаются ПЕРВЫМ делом: организация, заведённая на машине, иначе не будет
  // найдена в хранилище и попадёт в отчёт как отказ.
  const merge = await mergeIncomingTokens(cfg.tokensPath, deps)
  outcome.merged = merge.merged
  if (merge.error) outcome.failed.push({ org: '(incoming)', reason: merge.error })

  let orgs: GoOrg[]
  try {
    orgs = loadRegistry(cfg.registryPath).orgs
  } catch (err: any) {
    outcome.failed.push({ org: '(registry)', reason: String(err?.message ?? err).slice(0, 160) })
    return outcome
  }

  const src: CredentialSources = {
    tokensPath: cfg.tokensPath,
    environ: cfg.environ,
    now: deps.now ?? (() => Date.now()),
    userAgent: cfg.userAgent,
  }

  for (const org of orgs) {
    // Ключ API не истекает — продлевать нечего.
    if (org.auth !== 'console') continue
    outcome.checked++
    const before = readExpiry(cfg.tokensPath, org.name)
    try {
      const cred = await withFreshGoCredential(org, src, deps)
      const after = readExpiry(cfg.tokensPath, org.name)
      // Продлённым считаем только реальное движение срока: «вызов не бросил» ещё не значит «продлили».
      if (cred.expiryMs !== null && after !== null && before !== null && after > before) outcome.refreshed++
    } catch (err: any) {
      // Значение токена сюда не попадает: причина — поле ошибки, а не тело ответа.
      outcome.failed.push({ org: org.name, reason: String(err?.reason ?? err?.message ?? err).slice(0, 120) })
    }
  }
  return outcome
}

function readExpiry(tokensPath: string, org: string): number | null {
  try {
    // Читаем файл заново, а не из памяти: продление могло записать новое значение.
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
    const v = doc?.orgs?.[org]?.expiry_ms
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Запускает проход по расписанию. Возвращает функцию остановки.
 * Выключенный флаг — таймера нет вовсе (а не «таймер, который молчит»): так в `systemctl`/health
 * видно, что продление не включено, а не что оно «работает тихо».
 */
export function startGoProactiveRefresh(cfg: GoSweepConfig, deps: GoSweepDeps = {}): () => void {
  if (!goTokenRefreshEnabled(cfg.environ)) return () => {}
  const intervalMs = deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  let stopped = false
  const run = async () => {
    if (stopped) return
    const out = await sweepGoTokens(cfg, deps)
    if (deps.log && (out.refreshed > 0 || out.failed.length > 0 || out.merged.length > 0)) {
      const failed = out.failed.map((f) => `${f.org}:${f.reason}`).join(' ')
      deps.log(`GO_TOKEN_SWEEP checked=${out.checked} refreshed=${out.refreshed} merged=${out.merged.join(',') || '-'}${failed ? ` failed=${failed}` : ''}`)
    }
  }
  const timer = setInterval(() => { void run() }, intervalMs)
  ;(timer as any).unref?.()
  // Первый проход — сразу: сервер мог простоять ночь, и ждать полчаса незачем.
  void run()
  return () => { stopped = true; clearInterval(timer) }
}
