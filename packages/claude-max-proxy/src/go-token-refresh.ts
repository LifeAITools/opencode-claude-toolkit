/**
 * Продление пропуска консоли OpenCode Go на нашей стороне — и ТОЛЬКО когда его явно включили.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. `go-credentials.ts` остаётся точкой выдачи, но пока пропуск продлевает
 * `litellm/go_refresher.py`, второй писатель того же файла обесценил бы первого: поставщик меняет
 * refresh-токен при КАЖДОМ продлении и гасит прежний (go_refresher.py, шапка: «REFRESH-ТОКЕН
 * МЕНЯЕТСЯ ПРИ КАЖДОМ ПРОДЛЕНИИ»). Поэтому продление здесь выключено по умолчанию
 * (`GO_TOKEN_REFRESH_ENABLED==='true'` — единственное, что его включает), а включается оно тем же
 * ходом, что остановка таймера Python-писателя (риск R8 архитектуры).
 *
 * КОГДА ВКЛЮЧЕНО — проверка ПЕРЕД КАЖДЫМ использованием: остаток меньше семи суток → продлить.
 * Семь суток — это DEFAULT_THRESHOLD_DAYS = 7.0 в go_refresher.py (строка 84), то же значение,
 * что у `--max-age-days`.
 *
 * СЕТЬ. `POST {account_url}/auth/device/token`, тело `{grant_type, refresh_token, client_id}`
 * (refresh_over_network, go_refresher.py:492), client_id `opencode-cli` (CONSOLE_CLIENT_ID,
 * строка 98). Срок берётся из ответа так же, как в apply_rotation (строки 397-420):
 * `expiry_ms = now_ms + int(expires_in * 1000)`, и отсутствие refresh_token в ответе — это
 * СЛОМАННЫЙ ответ, а не «оставим прежний».
 *
 * 🔴 ИМЯ КЛИЕНТА ОБЯЗАТЕЛЬНО. Замер 08.10.2026 (go_refresher.py:102-110): сервер входа ответил
 * 403 «browser_signature_banned», потому что python назывался `Python-urllib/3.12`. Имя задаётся
 * в каждом запросе; пустое имя не подставляем питоновским — падаем на безопасное `kiberos-chat/1.0`.
 *
 * 🔴 ОДИН СЕТЕВОЙ ПРОМЕН НА ОРГАНИЗАЦИЮ. Refresh-токен ротируется: два параллельных продления
 * одним и тем же refresh-токеном убьют организацию (первое погасит токен, второе получит отказ,
 * и сохранённый победитель может оказаться проигравшим). Поэтому вызовы одной организации
 * делят ОДИН promise (in-flight map), а не идут в сеть каждый.
 *
 * ЗАПИСЬ. Временный файл В ТОМ ЖЕ КАТАЛОГЕ → fsync → rename (новая индексация; потребители
 * монтируют КАТАЛОГ, поэтому rename виден им атомарно). Права 0600. Остальные организации и
 * все прочие поля файла сохраняются БАЙТ В БАЙТ: правится только JSON-значение своей записи.
 * Значения токенов не попадают ни в журнал, ни в текст ошибок.
 */

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  GoCredentialError, withGoCredential, type CredentialSources, type GoCredential,
} from './go-credentials.js'
import type { GoOrg } from './go-registry.js'

/** Единственный выключатель продления. Пока он не `'true'`, модуль только читает. */
export const GO_TOKEN_REFRESH_FLAG = 'GO_TOKEN_REFRESH_ENABLED'

/** Порог продления: 7 суток, как DEFAULT_THRESHOLD_DAYS = 7.0 в go_refresher.py:74. */
export const REFRESH_THRESHOLD_MS = 7 * 86_400_000

/** Имя приложения, которым opencode просит продление (CONSOLE_CLIENT_ID, go_refresher.py:98). */
const CONSOLE_CLIENT_ID = 'opencode-cli'

/** Безопасное имя клиента, если в конфиге пусто (USER_AGENT, go_refresher.py:108). */
const FALLBACK_USER_AGENT = 'kiberos-chat/1.0'

/**
 * fetch/часы/окружение можно подменить в испытаниях. `deps.now` и `deps.environ` сильнее
 * одноимённых полей `CredentialSources`: источник выдаёт значения по умолчанию, deps — решение.
 */
export interface GoRefreshDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  environ?: Record<string, string | undefined>
}

export interface ForceRefreshOptions {
  /** Пропуск, которым только что получен 401. Если в хранилище уже лежит ДРУГОЙ — его и отдаём. */
  failedToken: string
}

interface StoreEntry {
  access_token?: unknown
  refresh_token?: unknown
  expiry_ms?: unknown
  [key: string]: unknown
}

interface StoreDoc {
  orgs?: Record<string, StoreEntry>
  [key: string]: unknown
}

interface OpenedStore {
  /** Сырой текст файла — из него вырезается только наша запись, остальное не пересериализуется. */
  text: string
  doc: StoreDoc
  entry: StoreEntry
  accessToken: string
  expiryMs: number | null
}

/** Включено ли продление. Отдельной дверью, чтобы go-door проверял ТО ЖЕ условие, что и модуль. */
export function goTokenRefreshEnabled(environ: Record<string, string | undefined> | null | undefined): boolean {
  return environ?.[GO_TOKEN_REFRESH_FLAG] === 'true'
}

function environOf(src: CredentialSources, deps?: GoRefreshDeps): Record<string, string | undefined> {
  return deps?.environ ?? src.environ ?? {}
}

function nowOf(src: CredentialSources, deps?: GoRefreshDeps): number {
  return (deps?.now ?? src.now)()
}

function fetchOf(deps?: GoRefreshDeps): typeof fetch {
  return deps?.fetchImpl ?? fetch
}

function userAgentOf(src: CredentialSources): string {
  const ua = typeof src.userAgent === 'string' ? src.userAgent.trim() : ''
  return ua || FALLBACK_USER_AGENT
}

/**
 * Карта «одна организация — один сетевой промен». Ключ включает имя организации И путь
 * хранилища: в одном процессе могут жить несколько экземпляров с разными файлами (испытания,
 * второй профиль), и склеивать их продление нельзя.
 */
const inflight = new Map<string, Promise<GoCredential>>()

function flightKey(org: GoOrg, src: CredentialSources): string {
  return `${org.name}\u0000${src.tokensPath ?? ''}`
}

function singleFlight(org: GoOrg, src: CredentialSources, run: () => Promise<GoCredential>): Promise<GoCredential> {
  const key = flightKey(org, src)
  const existing = inflight.get(key)
  if (existing) return existing
  let p: Promise<GoCredential>
  p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}

/**
 * Точка выдачи, которой пользуется дверь Go.
 *
 * Флаг выключен → ЭТО РОВНО `withGoCredential`: синхронное чтение и прежние отказы, ни одной
 * записи и ни одного запроса в сеть.
 */
export async function withFreshGoCredential(
  org: GoOrg,
  src: CredentialSources,
  deps?: GoRefreshDeps,
): Promise<GoCredential> {
  if (!goTokenRefreshEnabled(environOf(src, deps))) return withGoCredential(org, src)
  // Ключ API не истекает — продлевать нечего, и путь остаётся прежним.
  if (org.auth !== 'console') return withGoCredential(org, src)
  // Новые входы вливаются ПЕРЕД чтением: иначе организация, только что заведённая на машине,
  // не будет найдена в хранилище до следующего отдельного прохода. Отказ вливания не валит дверь.
  await mergeIncomingTokens(src.tokensPath, deps)
  return singleFlight(org, src, () => refreshIfNeeded(org, src, deps))
}

/**
 * Продлить НЕСМОТРЯ на порог — ответ на 401 от поставщика.
 *
 * Если хранилище уже содержит пропуск, отличный от `failedToken`, значит продлил кто-то другой
 * (другой процесс / другой вызов): сеть не трогаем и отдаём новый. Это и есть защита от второго
 * продления тем же ротируемым refresh-токеном.
 */
export async function forceRefreshGoCredential(
  org: GoOrg,
  src: CredentialSources,
  opts: ForceRefreshOptions,
  deps?: GoRefreshDeps,
): Promise<GoCredential> {
  if (!goTokenRefreshEnabled(environOf(src, deps))) return withGoCredential(org, src)
  if (org.auth !== 'console') return withGoCredential(org, src)
  await mergeIncomingTokens(src.tokensPath, deps)
  return singleFlight(org, src, async () => {
    const store = openStore(org, src)
    if (store.accessToken !== opts.failedToken) {
      return credentialFrom(org, src, store.accessToken, store.expiryMs)
    }
    return doRefresh(org, src, deps, store)
  })
}

async function refreshIfNeeded(org: GoOrg, src: CredentialSources, deps?: GoRefreshDeps): Promise<GoCredential> {
  const store = openStore(org, src)
  const nowMs = nowOf(src, deps)
  // Срок неизвестен — судить не о чем; ведём себя как прежняя точка выдачи (только читаем).
  if (store.expiryMs === null) return credentialFrom(org, src, store.accessToken, null)
  if (store.expiryMs - nowMs >= REFRESH_THRESHOLD_MS) {
    return credentialFrom(org, src, store.accessToken, store.expiryMs)
  }
  return doRefresh(org, src, deps, store)
}

function openStore(org: GoOrg, src: CredentialSources): OpenedStore {
  if (!src.tokensPath) throw new GoCredentialError(org.name, 'no_state', 'GO_TOKENS_PATH не задан')
  let text: string
  try {
    text = readFileSync(src.tokensPath, 'utf8')
  } catch {
    throw new GoCredentialError(org.name, 'no_state', 'хранилище пропусков Go не читается')
  }
  let doc: StoreDoc
  try {
    doc = JSON.parse(text) as StoreDoc
  } catch {
    throw new GoCredentialError(org.name, 'no_state', 'хранилище пропусков Go не разбирается как JSON')
  }
  const entry = doc?.orgs?.[org.name]
  const token = entry?.access_token
  if (!entry || typeof entry !== 'object' || typeof token !== 'string' || !token) {
    throw new GoCredentialError(org.name, 'no_token', `в хранилище нет пропуска организации «${org.name}»`)
  }
  const rawExpiry = entry.expiry_ms
  const expiry = typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)
    ? rawExpiry
    : typeof rawExpiry === 'string' && rawExpiry.trim() !== '' && Number.isFinite(Number(rawExpiry))
      ? Number(rawExpiry)
      : null
  return { text, doc, entry, accessToken: token, expiryMs: expiry }
}

async function doRefresh(
  org: GoOrg,
  src: CredentialSources,
  deps: GoRefreshDeps | undefined,
  store: OpenedStore,
): Promise<GoCredential> {
  const refreshToken = typeof store.entry.refresh_token === 'string' ? store.entry.refresh_token : ''
  if (!refreshToken) {
    throw new GoCredentialError(org.name, 'no_refresh_token', `в хранилище нет refresh-токена организации «${org.name}» — продлевать нечем`)
  }
  const accountUrl = org.accountUrl
  if (!accountUrl) {
    throw new GoCredentialError(org.name, 'no_account_url', `у организации «${org.name}» не задан account_url — адрес сервера входа для продления неизвестен`)
  }

  const nowMs = nowOf(src, deps)
  const userAgent = userAgentOf(src)
  const url = `${accountUrl.replace(/\/+$/, '')}/auth/device/token`
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CONSOLE_CLIENT_ID,
  })

  let res: Response
  try {
    res = await fetchOf(deps)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent },
      body,
    })
  } catch (err: any) {
    throw new GoCredentialError(org.name, 'refresh_network', `сервер входа Go не ответил при продлении «${org.name}»: ${String(err?.message ?? err).slice(0, 160)}`)
  }

  const rawBody = await res.text().catch(() => '')
  if (res.status !== 200) {
    // Имя клиента — самая частая причина 403 (замер 08.10.2026). Называем её прямо, а не «403».
    const banned = res.status === 403 && /browser_signature_banned|Error 1010/i.test(rawBody)
    if (banned) {
      throw new GoCredentialError(
        org.name, 'refresh_ua_banned',
        `сервер входа Go запретил имя клиента (user-agent «${userAgent}») — продление отклонено как browser_signature_banned; задай безопасное GO_USER_AGENT`,
      )
    }
    throw new GoCredentialError(
      org.name, 'refresh_http',
      `сервер входа Go ответил ${res.status} на продление «${org.name}»: ${safeSnippet(rawBody, refreshToken)}`,
    )
  }

  let parsed: any
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new GoCredentialError(org.name, 'refresh_bad_body', `ответ на продление «${org.name}» не разбирается как JSON`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new GoCredentialError(org.name, 'refresh_bad_body', `ответ на продление «${org.name}» — не объект`)
  }

  const access = parsed.access_token
  const refresh = parsed.refresh_token
  const expiresIn = parsed.expires_in
  // Ровно правила apply_rotation (go_refresher.py:400-420): без нового refresh-токена продление
  // считается сломанным, потому что прежний уже погашен поставщиком.
  if (typeof access !== 'string' || !access) {
    throw new GoCredentialError(org.name, 'refresh_bad_body', `в ответе на продление «${org.name}» нет access_token`)
  }
  if (typeof refresh !== 'string' || !refresh) {
    throw new GoCredentialError(org.name, 'refresh_bad_body', `в ответе на продление «${org.name}» нет refresh_token — продлевать дальше будет нечем`)
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GoCredentialError(org.name, 'refresh_bad_body', `в ответе на продление «${org.name}» негодный expires_in`)
  }

  const expiryMs = nowMs + Math.trunc(expiresIn * 1000)
  const nextEntry: StoreEntry = {
    ...store.entry,
    access_token: access,
    refresh_token: refresh,
    expiry_ms: expiryMs,
    refreshed_at_ms: nowMs,
  }
  // `expires_iso` — человеческое зеркало срока; если оно было, оставлять старое значит врать.
  if (typeof store.entry.expires_iso === 'string') nextEntry.expires_iso = new Date(expiryMs).toISOString()

  writeStoreAtomic(src.tokensPath!, store.text, store.doc, org.name, nextEntry)
  return credentialFrom(org, src, access, expiryMs)
}

function credentialFrom(org: GoOrg, src: CredentialSources, secret: string, expiryMs: number | null): GoCredential {
  const headers: Record<string, string> = { 'user-agent': userAgentOf(src) }
  if (org.auth === 'console') headers['x-opencode-org-id'] = org.workspace
  return { secret, headers, expiryMs }
}

/**
 * Атомарная запись: временный файл в ТОМ ЖЕ каталоге → fsync → rename → 0600.
 *
 * Имя временного файла уникально (pid + счётчик), чтобы не столкнуться с `.tmp` Python-писателя,
 * пока оба живы в окне переноса.
 */
let tmpCounter = 0

function writeStoreAtomic(path: string, text: string, doc: StoreDoc, orgName: string, entry: StoreEntry): void {
  const body = spliceEntry(text, doc, orgName, entry)
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${tmpCounter++}.tmp`)
  let fd: number | null = null
  try {
    mkdirSync(dir, { recursive: true })
    fd = openSync(tmp, 'w', 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch (err: any) {
    if (fd !== null) { try { closeSync(fd) } catch { /* уже закрыт */ } }
    try { unlinkSync(tmp) } catch { /* временного могло не быть */ }
    throw new GoCredentialError(orgName, 'write_failed', `не удалось записать хранилище пропусков Go: ${String(err?.message ?? err).slice(0, 160)}`)
  }
}

/**
 * Заменяет JSON-значение ОДНОЙ записи, не трогая ни один другой байт файла.
 * Не нашли запись (файл устроен иначе) — пересериализуем документ, сохраняя все значения.
 */
function spliceEntry(text: string, doc: StoreDoc, orgName: string, entry: StoreEntry): string {
  const span = findEntrySpan(text, orgName)
  if (span) return text.slice(0, span.start) + JSON.stringify(entry) + text.slice(span.end)
  const orgs = { ...(doc.orgs ?? {}), [orgName]: entry }
  return JSON.stringify({ ...doc, orgs }, null, 1)
}

function findEntrySpan(text: string, orgName: string): { start: number; end: number } | null {
  const orgs = findMemberValue(text, skipWs(text, 0), 'orgs')
  if (!orgs) return null
  return findMemberValue(text, orgs.start, orgName)
}

/** Значение члена `key` в объекте, начинающемся на `objStart` (там должен стоять `{`). */
function findMemberValue(text: string, objStart: number, key: string): { start: number; end: number } | null {
  if (text[objStart] !== '{') return null
  let i = objStart + 1
  while (i < text.length) {
    i = skipWs(text, i)
    if (text[i] === '}') return null
    if (text[i] !== '"') return null
    const keyEnd = scanString(text, i)
    if (keyEnd < 0) return null
    let name: string
    try { name = JSON.parse(text.slice(i, keyEnd)) as string } catch { return null }
    i = skipWs(text, keyEnd)
    if (text[i] !== ':') return null
    i = skipWs(text, i + 1)
    const end = scanValue(text, i)
    if (end < 0) return null
    if (name === key) return { start: i, end }
    i = skipWs(text, end)
    if (text[i] === ',') { i++; continue }
    return null
  }
  return null
}

function skipWs(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  return i
}

/** Возвращает индекс сразу ПОСЛЕ закрывающей кавычки. */
function scanString(text: string, i: number): number {
  let j = i + 1
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue }
    if (text[j] === '"') return j + 1
    j++
  }
  return -1
}

/** Возвращает индекс сразу ПОСЛЕ значения (объект/массив — после парной скобки). */
function scanValue(text: string, i: number): number {
  const c = text[i]
  if (c === '"') return scanString(text, i)
  if (c === '{' || c === '[') {
    let depth = 0
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (ch === '"') {
        const end = scanString(text, j)
        if (end < 0) return -1
        j = end - 1
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return j + 1
      }
    }
    return -1
  }
  let j = i
  while (j < text.length && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++
  return j
}

/** Обрывок ответа для ошибки: токенов в нём быть не должно. */
function safeSnippet(raw: string, refreshToken: string): string {
  let s = raw.slice(0, 200)
  if (refreshToken) s = s.split(refreshToken).join('[redacted]')
  return s || '(пустой ответ)'
}

// ───────────────────── новые входы: машина пишет, мы вливаем ─────────────────────

/**
 * Отдельный файл новых входов. Его пишет ТОЛЬКО машина (`watch`), вливает и очищает ТОЛЬКО
 * наш писатель — так у общего хранилища остаётся один писатель (иначе два read-modify-write
 * одного файла затирают друг друга: файл цел, JSON валиден, а пропуск уже мёртв).
 */
export const GO_INCOMING_FILE = '.go-tokens.incoming.json'

/**
 * Очередь записи хранилища: продление и вливание новых входов пишут ОДИН файл, поэтому идут
 * строго по одному даже внутри процесса. Без очереди два разных вызова могут прочитать один
 * снимок и записать его дважды, потеряв работу соседа.
 */
let storeChain: Promise<unknown> = Promise.resolve()

function withStoreLock<T>(fn: () => T): Promise<T> {
  const run = storeChain.then(fn, fn)
  storeChain = run.catch(() => undefined)
  return run
}

export interface MergeIncomingResult {
  /** Имена организаций, чьи записи влиты. Пусто — вливать было нечего. */
  merged: string[]
  /** Причина отказа, если вливание не удалось. Файл новых входов при отказе НЕ удаляется. */
  error?: string
}

/**
 * Вливает новые входы из `GO_INCOMING_FILE` в основное хранилище и очищает файл.
 *
 * ПОЧЕМУ ПО `expiry_ms`, А НЕ «входящий всегда прав»: вход мог пролежать, пока мы продлевали
 * ту же организацию. Побеждает запись с БОЛЬШИМ сроком — она и есть более свежая.
 *
 * Ничего не бросает: дверь не должна падать из-за неудавшегося вливания. Ошибка возвращается
 * текстом, файл остаётся на месте, следующий проход попробует снова.
 */
export async function mergeIncomingTokens(
  tokensPath: string | null,
  deps?: GoRefreshDeps,
): Promise<MergeIncomingResult> {
  if (!tokensPath) return { merged: [] }
  const incomingPath = join(dirname(tokensPath), GO_INCOMING_FILE)
  if (!existsSync(incomingPath)) return { merged: [] }
  return withStoreLock(() => {
    let incomingText: string
    try {
      incomingText = readFileSync(incomingPath, 'utf8')
    } catch (err: any) {
      return { merged: [], error: `файл новых входов не читается: ${String(err?.message ?? err).slice(0, 120)}` }
    }
    let incomingDoc: StoreDoc
    try {
      const parsed = JSON.parse(incomingText)
      // Допускаем обе формы: `{orgs:{...}}` и голую карту «имя → запись».
      incomingDoc = parsed && typeof parsed === 'object' && parsed.orgs && typeof parsed.orgs === 'object'
        ? parsed as StoreDoc
        : { orgs: (parsed ?? {}) as Record<string, StoreEntry> }
    } catch (err: any) {
      return { merged: [], error: `файл новых входов не разбирается как JSON: ${String(err?.message ?? err).slice(0, 120)}` }
    }
    const incoming = incomingDoc.orgs ?? {}
    if (Object.keys(incoming).length === 0) {
      // Пустой файл — не повод его держать: иначе он будет висеть вечно.
      try { unlinkSync(incomingPath) } catch { /* мог исчезнуть */ }
      return { merged: [] }
    }

    let text: string
    try {
      text = readFileSync(tokensPath, 'utf8')
    } catch (err: any) {
      return { merged: [], error: `хранилище пропусков не читается: ${String(err?.message ?? err).slice(0, 120)}` }
    }
    let doc: StoreDoc
    try {
      doc = JSON.parse(text) as StoreDoc
    } catch (err: any) {
      return { merged: [], error: `хранилище пропусков не разбирается как JSON: ${String(err?.message ?? err).slice(0, 120)}` }
    }

    const incomingEntries: Record<string, StoreEntry> = {}
    const merged: string[] = []
    for (const [name, raw] of Object.entries(incoming)) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as StoreEntry
      if (typeof entry.access_token !== 'string' || !entry.access_token) continue
      const inExpiry = numericExpiry(entry.expiry_ms)
      const curExpiry = numericExpiry(doc.orgs?.[name]?.expiry_ms)
      if (curExpiry !== null && (inExpiry === null || inExpiry <= curExpiry)) continue
      incomingEntries[name] = entry
      merged.push(name)
    }
    if (merged.length === 0) {
      // Вливать нечего (всё уже свежее) — файл всё равно убираем: он больше не нужен.
      try { unlinkSync(incomingPath) } catch { /* мог исчезнуть */ }
      return { merged: [] }
    }

    try {
      writeStoreAtomicMany(tokensPath, text, doc, incomingEntries)
    } catch (err: any) {
      return { merged: [], error: String(err?.message ?? err).slice(0, 160) }
    }
    try { unlinkSync(incomingPath) } catch { /* влито; оставшийся файл вольётся повторно без вреда */ }
    return { merged }
  })
}

function numericExpiry(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Запись НЕСКОЛЬКИХ записей за один проход: каждая вырезается из текста, соседи не пересериализуются. */
function writeStoreAtomicMany(path: string, text: string, doc: StoreDoc, entries: Record<string, StoreEntry>): void {
  let body = text
  for (const [name, entry] of Object.entries(entries)) {
    body = spliceEntry(body, doc, name, entry)
    // После первой вставки документ изменился — для следующего поиска пересобираем из нового текста.
    doc = JSON.parse(body) as StoreDoc
  }
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${tmpCounter++}.tmp`)
  let fd: number | null = null
  try {
    mkdirSync(dir, { recursive: true })
    fd = openSync(tmp, 'w', 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch (err: any) {
    if (fd !== null) { try { closeSync(fd) } catch { /* уже закрыт */ } }
    try { unlinkSync(tmp) } catch { /* временного могло не быть */ }
    throw new Error(`не удалось записать хранилище пропусков Go: ${String(err?.message ?? err).slice(0, 160)}`)
  }
}
