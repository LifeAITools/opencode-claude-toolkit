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
import { dirname, join } from 'node:path'
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

/**
 * Запись организации для ЧТЕНИЯ: хранилище плюс очередь новых входов.
 *
 * 🔴 ЗАЧЕМ (замер 22.10, вход hello@sealform.dev). Вход в opencode попадает в очередь
 * `.go-tokens.incoming.json`, а не в само хранилище. Слить очередь имеет право только её
 * писатель (go_refresher.py) — иначе у файла окажется два писателя и первый же ротированный
 * refresh-токен убьёт организацию (риск R8). Но ЧИТАТЬ очередь никому не запрещено: сам
 * обновлятор давно читает проекцию «своё + входящее» (`effective_state`). Дверь читала только
 * основное хранилище, поэтому организация, заведённая минуту назад, была для неё НЕВИДИМА —
 * «в хранилище нет пропуска» на живую, только что оплаченную организацию. Это то же самое
 * молчание, что и `credential: no_token`, только с другой стороны.
 *
 * Побеждает запись с БОЛЬШИМ сроком: входящая могла быть свежее (вход после продления).
 * Срок не указан хотя бы у одной — тогда главное хранилище, потому что «неизвестно» не должно
 * вытеснять известное.
 */
function entryWithIncoming(state: any, tokensPath: string, orgName: string): any {
  const own = state?.orgs?.[orgName]
  const incomingPath = join(dirname(tokensPath), '.go-tokens.incoming.json')
  let incoming: any
  try { incoming = JSON.parse(readFileSync(incomingPath, 'utf8')) } catch { return own }
  const doc = incoming && typeof incoming === 'object' && incoming.orgs ? incoming.orgs : incoming
  const other = doc?.[orgName]
  if (!other || typeof other !== 'object' || typeof other.access_token !== 'string' || !other.access_token) return own
  if (!own?.access_token) return other
  const a = Number(own.expiry_ms) || null
  const b = Number(other.expiry_ms) || null
  if (a === null || b === null) return own
  return b > a ? other : own
}

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
  const entry = entryWithIncoming(state, src.tokensPath, org.name)
  const secret = entry?.access_token
  if (!secret) throw new GoCredentialError(org.name, 'no_token', `в хранилище нет пропуска организации «${org.name}»`)
  const expiryMs = Number(entry.expiry_ms) || null
  if (expiryMs !== null && expiryMs - src.now() < EXPIRY_MARGIN_MS) {
    throw new GoCredentialError(org.name, 'expired', `пропуск организации «${org.name}» истёк — продление идёт у go_refresher`)
  }
  return { secret: String(secret), headers, expiryMs }
}
