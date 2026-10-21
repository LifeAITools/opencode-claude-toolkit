/**
 * Единая точка выдачи пропуска Go — близнец `withFreshOrgToken` (proxy-client.ts) для OpenCode Go.
 *
 * 🔴 КАЖДЫЙ потребитель секрета Go (настоящий ход, прогрев, проба остатка) берёт его ТОЛЬКО здесь.
 * Строить Authorization из голого чтения файла или окружения мимо этой функции — красный флаг:
 * продление и проверка срока живут в одном месте или не живут нигде.
 *
 * ПОКА ПЕРЕНОС НЕ СДЕЛАН, эта точка ТОЛЬКО ЧИТАЕТ файл пропусков (GO_TOKENS_PATH) и НИЧЕГО
 * В НЕГО НЕ ПИШЕТ: пишет его litellm/go_refresher.py, а refresh-токен Go меняется при каждом
 * продлении — второй писатель обесценит первого и убьёт организацию (риск R8 архитектуры).
 * Продление на нашей стороне включается тем же ходом, что остановка таймера refresher'а.
 *
 * Значения секретов не логируются и не возвращаются в ошибках: только имя организации и причина.
 */

import { readFileSync } from 'node:fs'
import type { GoOrg } from './go-registry.js'

/**
 * Причина отказа. `no_*` и `expired` — прежняя точка выдачи (только чтение); `refresh_*`,
 * `no_account_url` и `write_failed` добавляет go-token-refresh.ts, когда продление включено.
 * Список расширен аддитивно: прежние значения и их сравнения не меняются.
 */
export type GoCredentialReason =
  | 'no_state' | 'no_token' | 'expired' | 'no_env_key'
  | 'no_account_url' | 'no_refresh_token'
  | 'refresh_network' | 'refresh_ua_banned' | 'refresh_http' | 'refresh_bad_body'
  | 'write_failed'

export class GoCredentialError extends Error {
  constructor(public readonly org: string, public readonly reason: GoCredentialReason, msg: string) {
    super(msg)
  }
}

export interface GoCredential {
  /** Значение для `Authorization: Bearer`. Не логировать. */
  secret: string
  /** Заголовки, без которых поставщик не примет запрос организации. */
  headers: Record<string, string>
  /** До какого момента годен пропуск консоли (мс), null у ключа API. */
  expiryMs: number | null
}

export interface CredentialSources {
  tokensPath: string | null
  environ: Record<string, string | undefined>
  now: () => number
  userAgent: string
}

/** Запас: пропуск с меньшим остатком считаем истёкшим для хода — продление не наша, пока перенос не сделан. */
const EXPIRY_MARGIN_MS = 60_000

export function withGoCredential(org: GoOrg, src: CredentialSources): GoCredential {
  const headers: Record<string, string> = { 'user-agent': src.userAgent }
  if (org.auth === 'api_key') {
    const v = org.env ? src.environ[org.env] : undefined
    if (!v) throw new GoCredentialError(org.name, 'no_env_key', `ключ API организации «${org.name}» не задан в окружении`)
    return { secret: v, headers, expiryMs: null }
  }
  // Пропуск консоли: без заголовка организации поставщик отвечает 403 (замер 09.10.2026).
  headers['x-opencode-org-id'] = org.workspace
  if (!src.tokensPath) throw new GoCredentialError(org.name, 'no_state', 'GO_TOKENS_PATH не задан')
  let state: any
  try { state = JSON.parse(readFileSync(src.tokensPath, 'utf8')) }
  catch { throw new GoCredentialError(org.name, 'no_state', 'хранилище пропусков Go не читается') }
  const entry = state?.orgs?.[org.name]
  const secret = entry?.access_token
  if (!secret) throw new GoCredentialError(org.name, 'no_token', `в хранилище нет пропуска организации «${org.name}»`)
  const expiryMs = Number(entry.expiry_ms) || null
  if (expiryMs !== null && expiryMs - src.now() < EXPIRY_MARGIN_MS) {
    throw new GoCredentialError(org.name, 'expired', `пропуск организации «${org.name}» истёк — продление идёт у go_refresher`)
  }
  return { secret: String(secret), headers, expiryMs }
}
