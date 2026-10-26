/**
 * Go-door — POST /go/chat/completions и POST /go/responses: дверь к OpenCode Go с организациями.
 *
 * Стоит ЗА LiteLLM :4000 (рельс front-topology): записи моделей Go указывают api_base на
 * http://host.docker.internal:5050/go, как модели Claude на :5050. Диалект не переводим —
 * chat/completions и Responses идут к поставщику как пришли; меняются только пропуск и
 * заголовки организации. Поэтому дверь — прозрачный проход, а не переводчик (в отличие от
 * spark-responses.ts, где Anthropic↔Responses).
 *
 * Организация: заголовок `x-kiberos-go-org` (uid SynqTask или имя) → иначе рабочая из реестра.
 * Названная и не найденная — 400, НИКОГДА не подмена другой (no-live-account-migration).
 *
 * Секрет берётся только через withFreshGoCredential (единая точка выдачи; при выключенном
 * GO_TOKEN_REFRESH_ENABLED она ведёт себя РОВНО как withGoCredential — только читает);
 * значение нигде не логируется. Каждый вызов, включая отказ сети и отказ квоты, пишет ровно одну запись
 * provider-dump/v1 (контрольный вопрос 4 архитектуры).
 *
 * ПРОГРЕВА здесь нет и быть не может, пока warmQuotaShareMax = 0 (решение фаундера 15.10):
 * дверь только ходит и пишет дамп.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { loadRegistry, pickOrg, GoOrgError, GoRegistryError, type GoRegistry } from '../go-registry.js'
import { pickOrgByTimeToWall, isOrgUsable, readOrgQuotas, readStoreOrgNames } from '../go-org-pick.js'
import { QUOTA_STATUS_OPENCODE_GO_JSON } from '../opencode-go-quota.js'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, readFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { GoCredentialError } from '../go-credentials.js'
import { withFreshGoCredential, forceRefreshGoCredential, goTokenRefreshEnabled } from '../go-token-refresh.js'
import {
  newRecord, writeDump, redactHeaders, pickQuotaSeen, sha256, bodyField, classifyError,
  extractUsageChat, extractUsageResponses, usageFromSseText, type CallKind,
} from '../provider-dump.js'
import { resolveSessionIdentity, readCallerSession, CALLER_SESSION_HEADERS } from '../session-identity.js'
import { consumeConsent, getModelMetadata } from '@life-ai-tools/claude-code-sdk'
import type { ProxyConfig } from '../config.js'

const ORG_HEADER = 'x-kiberos-go-org'

/**
 * Кого обслуживать. Явно названную организацию берём как есть (рельс no-live-account-migration:
 * решение человека не оспариваем). Без заголовка — по ЗАПАСУ, а не по `active:` реестра: с момента,
 * когда дверь становится единственным путём, `active:` ведёт весь флот в одну организацию, и она
 * упирается молча. Замер 21.10: `active: hello` при 7д=0.91 против свежей 0/0/0 рядом.
 */
let warnedNoQuota = false

/**
 * Откуда взялась организация. Наружу отдаём заголовком `x-kiberos-org-source`: без этого
 * нельзя отличить «дверь выбирает» от «клиент прислал готовое имя» — а именно на этой
 * разнице ломалось правило фаундера 26.10 (агенты шлют `x-kiberos-go-org`, он перебивал
 * и запас, и запиненную сессию, и разброс по организациям выглядел как наша работа).
 */
type OrgSource = 'named' | 'pin' | 'quota' | 'active'

function selectOrg(reg: GoRegistry, wanted: string | null, cfg: any, stickyKey: string | null = null): { org: ReturnType<typeof pickOrg>; source: OrgSource } {
  const w = (wanted ?? '').trim()
  if (w) return { org: pickOrg(reg, w), source: 'named' }
  if (cfg.goTokensPath) {
    // 🔴 ОТЧЁТ КВОТЫ ЖИВЁТ РЯДОМ С РЕЕСТРОМ И ВХОДАМИ, А НЕ В `~/.claude-local`: на сервере его
    // привозит доставка в тот же смонтированный каталог (`/go/quota-status-opencode-go.json`).
    // Порядок: явная переменная → рядом с хранилищем пропусков → прежний домашний путь (машина).
    // 🔴 ДОМАШНИЙ ПУТЬ — ЭТО НЕ «ПРЕЖНИЙ», А НУЖНЫЙ (замер 22.10, сразу после выката 1.1.68):
    // на этой машине сборщик пишет отчёт в `~/.claude-local/`, а рядом с хранилищем его НЕТ
    // (`kiberos-app/litellm/quota-status-opencode-go.json` отсутствует). Дверь читала только
    // «рядом с хранилищем», получала ноль строк и молча возвращалась к `active:` — то есть
    // к организации, которая уже исчерпана. Живой ход без заголовка ушёл в hello@uniclowd.com
    // (5ч 1.00) и получил 429, хотя рядом стояла hello@sealform.dev с 0/0/0. Поэтому при
    // отсутствии файла рядом с хранилищем читаем домашний, и только потом уступаем `active:`.
    const besideStore = cfg.goTokensPath ? join(dirname(cfg.goTokensPath), 'quota-status-opencode-go.json') : null
    const quotaPath = process.env.GO_QUOTA_PATH
      ?? (besideStore && existsSync(besideStore) ? besideStore : QUOTA_STATUS_OPENCODE_GO_JSON)
    const quotas = readOrgQuotas(quotaPath)
    const haveToken = readStoreOrgNames(cfg.goTokensPath)
    const has = (n: string) => haveToken.has(n)
    const key = (stickyKey ?? '').trim()
    // «Сессию знаем — организация уже выдана»: переиспользуем выданную, пока она годна.
    if (key) {
      const pinned = pinLookup(key)
      if (pinned && isOrgUsable(reg.orgs, quotas, has, pinned)) {
        const org = reg.orgs.find((o) => o.name === pinned)
        if (org) {
          pinStore(key, org.name)
          return { org, source: 'pin' }
        }
      }
    }
    // Порядок двери: named (выше) → pin (выше) → модель «время до стены» → active (ниже).
    const picked = pickOrgByTimeToWall(reg.orgs, quotas, has, { sessionKey: key || null })
    if (picked.org) {
      if (key) pinStore(key, picked.org.name)
      return { org: picked.org, source: 'quota' }
    }
    // 🔴 ГРОМКО, А НЕ ТИХО: «замера нет» на сервере означает, что файл квоты не привезён.
    // Без этой строки выбор по запасу молча вырождается в `active:` — то есть в ровно ту беду,
    // ради которой он написан (весь флот в одну почти исчерпанную организацию).
    if (quotas.length === 0 && !warnedNoQuota) {
      warnedNoQuota = true
      console.warn('GO_ORG_PICK_NO_QUOTA файл отчёта квоты не прочитан — выбор организации вернулся к `active:` реестра; запас организаций НЕ учитывается')
    }
  }
  // Замера нет вовсе — ведём себя как раньше: `active:` реестра. «Нечего мерить» ≠ «нечего брать».
  return { org: pickOrg(reg, null), source: 'active' }
}
/**
 * СПУЛ ТЕЛА: последнее тело вызова на сессию — единственный источник ответа «что ИМЕННО
 * изменилось в префиксе», когда сессия промахнулась кэшем. Без тел видно только «доля чтения
 * упала», а не место.
 *
 * 🔴 ПЕРЕЕХАЛ СЮДА 26.10.2026 из `go_orgs.py` посредника: тот хук узнавал Go-модели по
 * `litellm_credential_name`, ключ у моделей убран — хук больше не выполняется, и спул вместе с
 * ним умирал. Пишет тот, кто видит факт: дверь видит тело и знает сессию.
 *
 * Контракт прежний: только поля ПРЕФИКСА (служебное и ключи не едут), TTL и потолок каталога.
 */
const SPOOL_FIELDS = ['model', 'system', 'messages', 'tools', 'tool_choice', 'max_tokens'] as const

export function spoolPayload(parsed: any): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const kept: Record<string, unknown> = {}
  for (const k of SPOOL_FIELDS) {
    const v = (parsed as any)[k]
    if (v !== undefined && v !== null) kept[k] = v
  }
  if (!kept.messages && !kept.system) return null
  return kept
}

let spoolWrites = 0

/** Записать последнее тело на сессию. Молча: любая беда — вызов не тронут. */
export function spoolWrite(dir: string, key: string, payload: Record<string, unknown>, now = Date.now()): void {
  try {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    if (!safe) return
    mkdirSync(dir, { recursive: true })
    const cur = `${dir}/${safe}.json`
    const prev = `${dir}/${safe}.prev.json`
    if (existsSync(cur)) {
      try { renameSync(cur, prev) } catch { /* не смогли — перезапишем текущий */ }
    }
    writeFileSync(cur, JSON.stringify(payload))
    if (++spoolWrites % 50 === 0) spoolSweep(dir, now)
  } catch { /* запись не смеет ломать вызов */ }
}

/** Убрать старое по TTL и, если каталог перерос потолок, самые старые из остатка. */
export function spoolSweep(dir: string, now = Date.now()): void {
  try {
    const ttlMs = Number(process.env.GO_SPOOL_TTL_SEC ?? 7200) * 1000
    const maxBytes = Number(process.env.GO_SPOOL_DIR_MAX_BYTES ?? 512 * 1024 * 1024)
    const rows: Array<{ p: string; m: number; s: number }> = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const p = `${dir}/${name}`
      try { const st = statSync(p); rows.push({ p, m: st.mtimeMs, s: st.size }) } catch { /* пропал */ }
    }
    let total = 0
    const alive: typeof rows = []
    for (const r of rows) {
      if (now - r.m > ttlMs) { try { unlinkSync(r.p) } catch { /* уже нет */ } } else { alive.push(r); total += r.s }
    }
    if (total > maxBytes) {
      alive.sort((a, b) => a.m - b.m)
      for (const r of alive) {
        if (total <= maxBytes) break
        try { unlinkSync(r.p); total -= r.s } catch { /* уже нет */ }
      }
    }
  } catch { /* уборка не смеет ломать вызов */ }
}

const CALL_KIND_HEADER = 'x-kiberos-call-kind'
const ACTOR_HEADER = 'x-kiberos-user'
/** Сколько текста потока держим для разбора usage и дампа. */
const STREAM_CAP_BYTES = 256 * 1024

let ctx: ModuleContext

function errorResponse(status: number, message: string, type = 'api_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status, headers: { 'content-type': 'application/json' },
  })
}

function hashActor(v: string | null): string | null {
  return v ? sha256(v).slice(0, 16) : null
}

/**
 * Ключ ЛИЧНОСТИ разговора, когда номер сессии не пришёл: системный промпт + набор инструментов.
 *
 * 🔴 ПОЧЕМУ НЕ «ПЕРВОЕ НЕ-СИСТЕМНОЕ СООБЩЕНИЕ» (первая версия 1.1.83, отменена в тот же час).
 * Оно МЕНЯЕТСЯ при уплотнении контекста: клиент присылает пересказ вместо истории, якорь
 * переезжает — и организация меняется ПОСРЕДИ разговора, то есть сессия платит холодной
 * перезаписью префикса. Правило фаундера (26.10, дословно): «прыгать между сессиями
 * категорически плохо… если сессию знаем, значит организация была уже выдана».
 *
 * Системный промпт и набор инструментов уплотнение НЕ меняет — они и дают устойчивый якорь.
 *
 * 🔴 ЧЕСТНАЯ ГРАНИЦА: якорь ОДИН на агента, а не на сессию. Новая сессия того же агента
 * получит ту же организацию, что и предыдущие, — это НЕ прыжок, но и не выдача новой
 * организации новой сессии. Для выдачи нужен настоящий номер сессии, то есть чтобы посредник
 * прокидывал `x-opencode-session-id`; пока не прокидывает (замер 26.10: `sessions=0`).
 */
export function agentKey(parsed: any): string | null {
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : null
  const sys = msgs ? msgs.filter((m: any) => m && m.role === 'system') : []
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : null
  if (sys.length === 0 && !tools) return null
  return sha256(JSON.stringify(sys) + '|' + JSON.stringify(tools ?? null)).slice(0, 16)
}

/**
 * Выданная организация живёт за ключом: «сессию знаем — организация уже выдана».
 * Память ограничена по числу и сроку; вытесняется самая давняя запись.
 */
const ORG_PIN_MAX = 500
const ORG_PIN_TTL_MS = 12 * 60 * 60 * 1000
const orgPins = new Map<string, { org: string; at: number }>()

function pinLookup(key: string): string | null {
  const hit = orgPins.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > ORG_PIN_TTL_MS) {
    orgPins.delete(key)
    return null
  }
  return hit.org
}

function pinStore(key: string, org: string): void {
  if (orgPins.size >= ORG_PIN_MAX) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of orgPins) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
    }
    if (oldestKey) orgPins.delete(oldestKey)
  }
  orgPins.set(key, { org, at: Date.now() })
}

function callKindOf(req: Request): CallKind {
  const v = req.headers.get(CALL_KIND_HEADER)
  return v === 'warm' || v === 'probe' || v === 'refresh' || v === 'title' ? v : 'real'
}

/** Реестр читается заново на каждый вызов: он маленький, а правка реестра не должна требовать перезапуска. */
function registry(): GoRegistry {
  const path = ctx.config.goRegistryPath
  if (!path) throw new GoRegistryError('GO_REGISTRY_PATH не задан')
  return loadRegistry(path)
}

/**
 * Готовность двери Go — БЕЗ запроса к поставщику: настроена ли она вообще.
 *
 * 🔴 ЗАЧЕМ ЭТО ОТДЕЛЬНО ОТ 503 (17.10.2026). Дверь без заданных путей отвечает 503
 * на КАЖДЫЙ вызов — и это верно, но узнать о ней можно было только вызовом. Из-за
 * этого сервер kiberos.ai читался как «дверь выкачена»: модуль загружен, два маршрута
 * на месте, а использовать дверь нельзя. Готовность обязана быть видна в строке
 * здоровья и названа при запуске, а не выясняться пробой — пробу к тому же легко
 * послать не туда (буквальный `/go` даёт 404 и читается как «двери нет»).
 */
export function goDoorReadiness(cfg: ProxyConfig): { configured: boolean; missing: string[] } {
  const missing: string[] = []
  if (!cfg.goRegistryPath) missing.push('GO_REGISTRY_PATH')
  if (!cfg.goTokensPath) missing.push('GO_TOKENS_PATH')
  return { configured: missing.length === 0, missing }
}

/**
 * ПРЕФИКС ЗАПРОСА: продолжает прошлый или переписан — по одному слепку на вызов.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 23.10: «если есть движки, которые ломают кэш — вычислить, чтобы
 * поправили у себя код и были байт-идентичны»). Замер по 72 часам трафика Go: первые вызовы
 * сессии дают всего **0.2%** токенов входа, а перезапись из-за смены префикса — **2.8%**
 * (517 млн из 18.2 млрд), и 92% из них — «промпт вырос, а кэша нет». Тело запроса в базе
 * посредника НЕ хранится (`messages = {}`), поэтому снаружи видно ЧТО случилось и не видно
 * КАКОЙ. Здесь — только слепки, без тел: кэш поставщика держится за ПРЕФИКС, поэтому
 * вопрос «продолжение или переписывание» решается двумя хешами.
 *
 * Как читается: `prefix` = всё, кроме последнего сообщения (то, что должно прочитаться из
 * кэша); `full` = все сообщения. Если нынешний `prefix` равен прошлому `full` — история
 * продолжилась (append), кэш должен попасть. Если не равен — ранняя часть переписана.
 */
const PREFIX_MEMORY_MAX = 2000
const prefixMemory = new Map<string, {
  full: string
  msgHashes: string[]
  roles: string[]
  tools: string
  system?: string
  at: number
}>()

/**
 * 🔴 РЕЕСТР ПРЕФИКСОВ ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК (слово фаундера 24.10.2026): «система перезапустится,
 * у нас этот реестр должен быть сохранён и подняться, чтобы не терять данные».
 *
 * Зачем это важно, а не «на всякий случай»: слепок нужен, чтобы следующий ход сессии сравнить с
 * предыдущим. Без него после каждого перезапуска ПЕРВЫЙ ход каждой живой сессии выглядит как
 * «первый в жизни» — сторож молчит, а сессия на 900 тысяч токенов платит полную запись ровно в тот
 * момент, когда мы её и должны были остановить. Плюс теряется отметка времени последнего хода, а
 * она и есть вход в решение о простое.
 *
 * Хранение: один JSON рядом с остальным состоянием, запись атомарная и С ЗАДЕРЖКОЙ (раз в 5 с), иначе
 * каждая мысль агента тянула бы запись мегабайтов. Потолок числа сессий и возраста — чтобы файл не
 * рос вечно.
 */
const PREFIX_REGISTRY_PATH = join(homedir(), '.claude-local', 'go-prefix-registry.json')
const PREFIX_REGISTRY_MAX_SESSIONS = 500
const PREFIX_REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PREFIX_REGISTRY_FLUSH_MS = 5_000
/** Сколько хэшей сообщений держим на сессию: длиннее — сравниваем только голову. */
const PREFIX_REGISTRY_MAX_HASHES = 2_000

let prefixDirty = false
let prefixFlushTimer: ReturnType<typeof setTimeout> | null = null

function prunePrefixRegistry(now = Date.now()): void {
  for (const [sid, entry] of prefixMemory) {
    if (now - entry.at > PREFIX_REGISTRY_MAX_AGE_MS) prefixMemory.delete(sid)
  }
  if (prefixMemory.size <= PREFIX_REGISTRY_MAX_SESSIONS) return
  const byAge = [...prefixMemory.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [sid] of byAge.slice(0, prefixMemory.size - PREFIX_REGISTRY_MAX_SESSIONS)) {
    prefixMemory.delete(sid)
  }
}

function flushPrefixRegistry(): void {
  prefixFlushTimer = null
  if (!prefixDirty) return
  prefixDirty = false
  try {
    prunePrefixRegistry()
    const payload = { version: 1, savedAt: new Date().toISOString(), sessions: Object.fromEntries(prefixMemory) }
    const tmp = `${PREFIX_REGISTRY_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, PREFIX_REGISTRY_PATH)
  } catch {
    // Сохранение слепка — удобство, а не путь обслуживания: не сумели — работаем как раньше,
    // но говорим об этом в журнал, чтобы «не сохранилось» не читалось потом как «не было».
    prefixDirty = true
  }
}

function markPrefixDirty(): void {
  prefixDirty = true
  if (prefixFlushTimer) return
  prefixFlushTimer = setTimeout(flushPrefixRegistry, PREFIX_REGISTRY_FLUSH_MS)
  // Таймер не должен держать процесс живым.
  ;(prefixFlushTimer as any).unref?.()
}

/** Поднять реестр с диска. Битый или отсутствующий файл — пустой реестр, а не падение. */
function loadPrefixRegistry(): void {
  try {
    if (!existsSync(PREFIX_REGISTRY_PATH)) return
    const body = JSON.parse(readFileSync(PREFIX_REGISTRY_PATH, 'utf8')) as {
      sessions?: Record<string, { full?: unknown; msgHashes?: unknown; roles?: unknown; tools?: unknown; system?: unknown; at?: unknown }>
    }
    const now = Date.now()
    for (const [sid, e] of Object.entries(body?.sessions ?? {})) {
      if (typeof e?.full !== 'string' || typeof e?.tools !== 'string') continue
      if (!Array.isArray(e?.msgHashes) || !Array.isArray(e?.roles)) continue
      if (typeof e?.at !== 'number' || now - e.at > PREFIX_REGISTRY_MAX_AGE_MS) continue
      prefixMemory.set(sid, {
        full: e.full,
        msgHashes: (e.msgHashes as string[]).slice(0, PREFIX_REGISTRY_MAX_HASHES),
        roles: (e.roles as string[]).slice(0, PREFIX_REGISTRY_MAX_HASHES),
        tools: e.tools,
        ...(typeof e.system === 'string' ? { system: e.system } : {}),
        at: e.at,
      })
    }
  } catch {
    // Битый файл — начинаем с пустого: хуже было бы упасть на старте.
    prefixMemory.clear()
  }
}

loadPrefixRegistry()

/**
 * ГОЛОВА ИСТОРИИ ДЛЯ СНИМКА — чтобы на ПЕРВОЙ же переписи назвать не только место,
 * но и ЧТО ИМЕННО стояло в этом месте до и после.
 *
 * 🔴 ЗАЧЕМ ОТДЕЛЬНО ОТ `prefixMemory` (слово фаундера 23.10: «в логах показать, ГДЕ байты
 * разошлись и что поменялось»). Хеши отвечают «сообщение #3 изменилось», но не «с ТАКОГО
 * на ТАКОЕ». Полные тела в памяти держать нельзя — 2000 сессий по мегабайту; поэтому
 * храним ГОЛОВУ: первые `HEAD_SNIPPETS` сообщений, каждое обрезано по `SNIPPET_CHARS`.
 * 92% переписей (замер 23.10) — «промпт вырос, а кэша нет», то есть расхождение в РАННЕЙ
 * части; голова его покрывает. Не покрыло — так и пишем, а не делаем вид.
 *
 * Память ограничена отдельно от `prefixMemory`: 200 сессий × 8 сообщений × 2 КБ ≈ 3 МБ
 * худшего случая, против 2000×… у полного слепка. Перепись после долгого простоя всё равно
 * не про движок (кэш истёк), поэтому старые сессии вытесняются первыми и не в ущерб.
 */
const HEAD_SNIPPETS = 8
const SNIPPET_CHARS = 2048
const SNIPPET_SESSIONS_MAX = 200
const headSnippets = new Map<string, string[]>()

/** Сколько первых сообщений сессии мы помним — для честного «покрыто/не покрыто». */
export function rememberedHeadLength(sessionId: string | null): number {
  return sessionId ? (headSnippets.get(sessionId)?.length ?? 0) : 0
}

/** Голова ПРЕДЫДУЩЕЙ истории — снимается ДО `commitPrefix`, иначе сравнивали бы новое с новым. */
function headOf(sessionId: string | null): string[] | undefined {
  return sessionId ? headSnippets.get(sessionId) : undefined
}

function rememberHead(sessionId: string, msgs: any[]): void {
  const head = msgs.slice(0, HEAD_SNIPPETS).map((m) => {
    try { return JSON.stringify(m).slice(0, SNIPPET_CHARS) } catch { return '<unserializable>' }
  })
  if (headSnippets.size >= SNIPPET_SESSIONS_MAX && !headSnippets.has(sessionId)) {
    const oldest = headSnippets.keys().next().value
    if (oldest !== undefined) headSnippets.delete(oldest)
  }
  headSnippets.set(sessionId, head)
}

/** Каталог снимков — тот же, что у дампов тел: его TTL и потолок объёма (body-capture)
 *  накрывают и наши файлы, поэтому отдельной политики хранения не заводим. */
function snapshotDir(): string {
  return process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
    ?? join(homedir(), '.claude-local', 'proxy-body-dumps')
}

/**
 * Снимок ОДНОГО разошедшегося сообщения: до и после, плюс всё, что нужно, чтобы связать
 * файл с журналом и с конкретной сессией. Ошибка записи запрос не роняет — снимок это
 * доказательство, а не путь обслуживания.
 */
export function writeRewriteSnapshot(input: {
  sessionId: string
  model: string | null
  analysis: PrefixAnalysis
  prevSnippet: string | null
  curSnippet: string | null
  now: number
}): string | null {
  const { sessionId, model, analysis, prevSnippet, curSnippet, now } = input
  if (process.env.CLAUDE_MAX_PROXY_CAPTURE_BODIES === '0') return null
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  const path = join(snapshotDir(), `go-rewrite-${safeSid}-${now}.json`)
  const payload = {
    ts: new Date(now).toISOString(),
    door: 'opencode-go',
    sessionId,
    model,
    firstDiffIndex: analysis.firstDiffIndex ?? null,
    role: analysis.role ?? null,
    prevMsgs: analysis.prevMsgs ?? null,
    msgs: analysis.msgs ?? null,
    toolsChanged: analysis.toolsChanged === true,
    idleMs: analysis.idleMs ?? null,
    cacheTtlMs: analysis.cacheTtlMs ?? null,
    avoidableRewrite: analysis.avoidableRewrite === true,
    // Обрезка НАЗВАНА: читатель должен видеть, что перед ним голова сообщения, а не всё.
    snippetChars: SNIPPET_CHARS,
    prev: prevSnippet,
    cur: curSnippet,
  }
  // Запись СИНХРОННАЯ: файл ≤ нескольких килобайт, а перепись — редкий путь (~3% вызовов).
  // Асинхронная запись сделала бы результат непроверяемым: функция вернула бы путь, которого
  // в эту минуту ещё нет, и испытание не отличило бы «записал» от «не записал».
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2))
    return path
  } catch {
    return null
  }
}

export type PrefixVerdict = 'first' | 'append' | 'rewrite' | 'unknown'

/** Где именно разошлось: индекс сообщения, его роль, простой и цена переписи. */
export interface PrefixAnalysis {
  verdict: PrefixVerdict
  /** Индекс ПЕРВОГО разошедшегося сообщения (в терминах прошлой истории). */
  firstDiffIndex?: number
  role?: string
  prevMsgs?: number
  msgs?: number
  toolsChanged?: boolean
  /** Сколько прошло с прошлого вызова этой сессии (`now - prev.at`). */
  idleMs?: number
  /**
   * Перепись ПРИ ЖИВОМ КЭШЕ: кэш ещё должен был попасть, значит промах — не работа
   * движка, а изменение промпта. Именно этот случай сторож и останавливает.
   */
  avoidableRewrite?: boolean
  /** Срок жизни кэша, принятый в решении (мс). Передаётся снаружи, из env здесь не читается. */
  cacheTtlMs?: number
  /**
   * Кэш УЖЕ ИСТЁК по времени: простой больше срока жизни и префикс не совпал. Это не вина
   * движка — это холодная запись, и она дорога ровно так же, как тёплая перепись. Отдельное
   * поле, а не вывод читателя: различить «кэш истёк» и «префикс сменился» обязан тот, кто
   * знает и время, и слепок.
   */
  cacheExpired?: boolean
  /** Сменился системный промпт: кэш теряется ЦЕЛИКОМ, и убыток считается по всему телу. */
  systemChanged?: boolean
}

/** Сколько живёт кэш по умолчанию, если вызывающий не назвал своё (45 мин, колено Go). */
const DEFAULT_CACHE_TTL_MS = 2700_000

/**
 * Состояние холодного сторожа и его авто-отказа. Модульное, а не в конфиге, потому что откат —
 * это РЕШЕНИЕ ВО ВРЕМЕНИ: конфиг читается один раз при старте, а «мы перекрыли кислород» надо
 * остановить на живом процессе, не перезапуская его (перезапуск сам по себе — перезапись кэша).
 */
let coldGuardReverted = false
let coldGuardArmedAt = 0
let coldGuardRefusals = 0
let coldGuardPassed = 0
let coldGuardLastRefusalAt = 0
let coldGuardLastPassAt = 0

/** Для испытаний: вернуть сторож в исходное состояние. */
export function resetColdGuardState(): void {
  coldGuardReverted = false
  coldGuardArmedAt = 0
  coldGuardRefusals = 0
  coldGuardPassed = 0
  coldGuardLastRefusalAt = 0
  coldGuardLastPassAt = 0
}

export function coldGuardState(): { reverted: boolean; refusals: number; passed: number } {
  return { reverted: coldGuardReverted, refusals: coldGuardRefusals, passed: coldGuardPassed }
}

function msgHash(m: unknown): string { return sha256(JSON.stringify(m)).slice(0, 12) }

/**
 * ПРОЧИТАТЬ префикс сессии, ничего не записывая.
 *
 * 🔴 Отделено от `commitPrefix` ради сторожа: решение «остановить» принимается ДО того,
 * как состояние сдвинуто, иначе отказ сам стал бы переписью — следующий честный ход
 * сравнивался бы с телом, которое мы отказались обслуживать. Чистая функция ещё и
 * честнее в испытаниях: два вызова подряд не могут изменить ответ друг другу.
 */
export function assessPrefix(
  sessionId: string | null,
  body: any,
  opts: { now?: number; cacheTtlMs?: number } = {},
): PrefixAnalysis {
  const now = opts.now ?? Date.now()
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (!sessionId) return { verdict: 'unknown', cacheTtlMs }
  const msgs = Array.isArray(body?.messages) ? body.messages : null
  if (!msgs || msgs.length === 0) return { verdict: 'unknown', cacheTtlMs }
  return compareToPrevious(prefixMemory.get(sessionId), msgs, body, now, cacheTtlMs)
}

/**
 * ЗАПИСАТЬ новый слепок сессии и вернуть анализ против ПРЕДЫДУЩЕЙ записи.
 *
 * Так `commitPrefix` в одиночку ведёт себя ровно как прежний `analyse`, а пара
 * `assessPrefix` + `commitPrefix` даёт тот же ответ, что один `analyse`.
 */
export function commitPrefix(
  sessionId: string | null,
  body: any,
  opts: { now?: number; cacheTtlMs?: number } = {},
): PrefixAnalysis {
  const now = opts.now ?? Date.now()
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (!sessionId) return { verdict: 'unknown', cacheTtlMs }
  const msgs = Array.isArray(body?.messages) ? body.messages : null
  if (!msgs || msgs.length === 0) return { verdict: 'unknown', cacheTtlMs }
  const prev = prefixMemory.get(sessionId)
  if (prefixMemory.size >= PREFIX_MEMORY_MAX && !prev) {
    const oldest = prefixMemory.keys().next().value
    if (oldest !== undefined) prefixMemory.delete(oldest)
  }
  prefixMemory.set(sessionId, {
    // 🔴 СИСТЕМНЫЙ ПРОМПТ — ЧАСТЬ ПРЕФИКСА, А НЕ ФОН (нашёл 24.10.2026 по вопросу владельца
    // wake-router). Раньше хэшировались только сообщения и инструменты, поэтому прогон, у
    // которого сменился ТОЛЬКО системный промпт (у нас в стартовый контекст подмешиваются рельсы
    // и знание проекта), считался `append` — то есть сторож молчал на самой дорогой переписи,
    // какая бывает: меняется голова, кэш теряется целиком.
    full: sha256(JSON.stringify(msgs)),
    msgHashes: msgs.map(msgHash),
    roles: msgs.map((m: any) => (typeof m?.role === 'string' ? m.role : '?')),
    tools: sha256(JSON.stringify(body?.tools ?? null)).slice(0, 12),
    // 🔴 СИСТЕМНЫЙ ПРОМПТ — ОТДЕЛЬНОЕ СЛЕПОК-ПОЛЕ, И ЭТО ВАЖНО (24.10.2026). Раньше его не
    // хэшировали вовсе: прогон со сменённым ТОЛЬКО system считался `append`, и сторож молчал на
    // самой дорогой переписи. Отдельным полем, а не примешанным к сообщениям: смена головы не
    // даёт расхождения ПО СООБЩЕНИЯМ, и обычный поиск первого расхождения вернул бы «ничего не
    // изменилось», то есть посчитал бы убыток по хвосту вместо всего префикса.
    system: sha256(JSON.stringify(body?.system ?? null)).slice(0, 12),
    at: now,
  })
  // Голова — ДО того, как её заменит следующая история: иначе снимок сравнивал бы новое с новым.
  rememberHead(sessionId, msgs)
  // Отметка времени хода и слепок — то, что должно пережить перезапуск.
  markPrefixDirty()
  return compareToPrevious(prev, msgs, body, now, cacheTtlMs)
}

/** Общий разбор: единственное место, где решается append/rewrite/first. */
function compareToPrevious(
  prev: { full: string; msgHashes: string[]; roles: string[]; tools: string; system?: string; at: number } | undefined,
  msgs: any[],
  body: any,
  now: number,
  cacheTtlMs: number,
): PrefixAnalysis {
  const cacheable = msgs.slice(0, -1)
  const prefixSha = sha256(JSON.stringify(cacheable))
  const tools = sha256(JSON.stringify(body?.tools ?? null)).slice(0, 12)
  const system = sha256(JSON.stringify(body?.system ?? null)).slice(0, 12)

  if (!prev) return { verdict: 'first', msgs: msgs.length, cacheTtlMs }
  if (cacheable.length === 0) return { verdict: 'first', msgs: msgs.length, cacheTtlMs }
  const idleMs = Math.max(0, now - prev.at)
  // 🔴 tools ВХОДЯТ В КЭШИРУЕМЫЙ ПРЕФИКС наравне с сообщениями: продолжение истории при
  // смене набора инструментов — всё равно промах, и назвать его «append» значило бы соврать.
  const systemChanged = (prev.system ?? '') !== system
  // 🔴 ДВА ВИДА «НИЧЕГО НОВОГО»: добавлено сообщение (прежняя история стала префиксом) и
  // ПОВТОР ТОЙ ЖЕ ИСТОРИИ (прогрев). Второй случай раньше падал в «историю обрезали» и получал
  // вердикт `rewrite` — то есть прогрев с неизменным префиксом выглядел переписью. Владелец
  // wake-router спрашивал именно об этом 24.10.2026.
  const sameHistory = prev.full === sha256(JSON.stringify(msgs))
  if ((prev.full === prefixSha || sameHistory) && prev.tools === tools && !systemChanged) {
    return { verdict: 'append', msgs: msgs.length, idleMs, cacheTtlMs }
  }

  // Расхождение: ищем первое сообщение, которое перестало совпадать с отправленным прошлый раз.
  let firstDiff: number | undefined
  const common = Math.min(prev.msgHashes.length, cacheable.length)
  for (let i = 0; i < common; i++) {
    if (prev.msgHashes[i] !== msgHash(cacheable[i])) { firstDiff = i; break }
  }
  // 🔴 СМЕНА ГОЛОВЫ КОНТЕКСТА — РАСХОЖДЕНИЕ С НУЛЕВОГО СООБЩЕНИЯ. Сообщения при этом совпадают,
  // поэтому обычный поиск ничего не находит, и убыток посчитался бы по хвосту. На деле меняется
  // системный промпт — кэш теряется ЦЕЛИКОМ, и назвать это надо честно.
  if (systemChanged) firstDiff = 0
  // Прошлая история была длиннее, а общий префикс совпал — историю обрезали.
  if (firstDiff === undefined && prev.msgHashes.length > cacheable.length) firstDiff = cacheable.length
  const toolsChanged = prev.tools !== tools
  return {
    verdict: 'rewrite',
    ...(firstDiff !== undefined ? { firstDiffIndex: firstDiff, role: prev.roles[firstDiff] ?? '?' } : {}),
    prevMsgs: prev.msgHashes.length,
    msgs: msgs.length,
    toolsChanged,
    idleMs,
    // Смена инструментов — не «движок сломал кэш»: префикс обязан измениться, и сторож
    // здесь молчит. Измерение 23.10: таких меньшинство, но называть их виноватыми нельзя.
    avoidableRewrite: !toolsChanged && idleMs < cacheTtlMs,
    cacheExpired: !toolsChanged && idleMs >= cacheTtlMs,
    ...(systemChanged ? { systemChanged: true } : {}),
    cacheTtlMs,
  }
}

/**
 * Совместимость: прежняя сигнатура `analyse(sessionId, body, now)` — ею пользуются
 * испытания и внешние вызовы. Теперь это тонкий псевдоним `commitPrefix`.
 */
export function analyse(sessionId: string | null, body: any, now: number = Date.now()): PrefixAnalysis {
  return commitPrefix(sessionId, body, { now })
}

/** Совместимость: прежняя сигнатура (строка) — ею пользуются испытания и внешние вызовы. */
export function prefixVerdict(sessionId: string | null, body: any, now = Date.now()): PrefixVerdict {
  return analyse(sessionId, body, now).verdict
}

/**
 * Остановить ли ход. Чистое решение — без файлов, без env, без побочных эффектов:
 * поэтому матрицу условий можно проверить целиком, не поднимая дверь.
 */
/**
 * СКОЛЬКО ТОКЕНОВ ПЕРЕПИШЕТСЯ — а не сколько весит запрос.
 *
 * Кэш ключуется ПРЕФИКСОМ: всё, что до первого расхождения, читается дёшево. Платим за то, что
 * после него, плюс за весь запрос, если сменился набор инструментов (тогда префикс новый с нуля).
 * Неизвестное расхождение — считаем весь запрос: не преуменьшать убыток.
 *
 * Оценка в токенах — по объёму JSON/4, тем же курсом, что у Anthropic. Это оценка, и она
 * называется оценкой; точное число даёт только сам ответ поставщика, после того как запись уже
 * случилась и переплачена.
 */
export function rewrittenTokens(parsed: any, analysis: PrefixAnalysis): number {
  // 🔴 БАЙТЫ, А НЕ ЗНАКИ (слово фаундера 24.4.2026: «должна быть побайтовая проверка, понимающая,
  // сколько кэша будет записано»). `JSON.stringify(...).length` считает единицы UTF-16: русский
  // текст — один знак, но два байта, то есть прежняя оценка занижала убыток на русском вдвое.
  // Токены примерно равны байтам/4 — тем же курсом, что у Anthropic.
  const bytes = (v: unknown): number => {
    try { return Buffer.byteLength(JSON.stringify(v ?? null), 'utf8') } catch { return 0 }
  }
  const whole = () => Math.round(bytes({
    system: parsed?.system ?? null,
    tools: parsed?.tools ?? null,
    messages: parsed?.messages ?? [],
  }) / 4)
  // Сменилась голова контекста — не попадает НИЧЕГО, платим за всё тело.
  if (analysis.toolsChanged === true || analysis.systemChanged === true) return whole()
  const idx = analysis.firstDiffIndex
  if (idx === undefined) return whole()
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : []
  if (msgs.length === 0) return whole()
  // Система и инструменты СОВПАЛИ — они читаются из кэша и в убыток не входят. Платим только
  // за сообщения от места расхождения: всё, что до него, попадает.
  return Math.round(bytes(msgs.slice(Math.max(0, idx))) / 4)
}

export function shouldBlockRewrite(input: {
  enabled: boolean
  /** Второй случай — дорогая запись после колена. Отдельный ключ, не тот же самый. */
  coldEnabled?: boolean
  /**
   * Запись префикса после ЭКОНОМИЧЕСКОГО колена (не «кэш истёк» — кэш может быть жив, но цена
   * промаха уже сравнялась с ценой новой сессии). Считает вызывающий: он знает и порог модели,
   * и простой. Функция остаётся чистой.
   */
  coldRewrite?: boolean
  analysis: PrefixAnalysis
  predictedTokens: number
  minTokens: number
  consented: boolean
}): boolean {
  if (input.consented) return false
  if (input.predictedTokens < input.minTokens) return false
  // 🔴 ДВА СЛУЧАЯ — ДВА КЛЮЧА, БЕЗ ОБЩЕГО ГЕЙТА (нашёл на испытании 24.10): раньше `enabled`
  // гасил и холодный случай, поэтому при выключенном основном сторожа холодный ключ не включал
  // ничего. Теперь каждый случай спрашивает только свой ключ.
  // Тёплая перепись: кэш ещё должен был попасть — вина отправителя.
  if (input.enabled && input.analysis.avoidableRewrite === true) return true
  // Дорогая запись после колена: кэш мог истечь, а мог и выжить — платим в любом случае много.
  // Природа другая, ключ другой, поэтому и поле отдельное.
  return input.coldEnabled === true && (input.coldRewrite === true || input.analysis.cacheExpired === true)
}

/**
 * Учесть исход хода для авто-отказа: пропуск или отказ. Вызывается в обоих концах решения,
 * чтобы «остановили и никто не прошёл» было измерением, а не догадкой.
 */
function noteColdGuardOutcome(cfg: { goRewriteGuardAutoRevertSec: number }, passed: boolean): void {
  const windowMs = cfg.goRewriteGuardAutoRevertSec * 1000
  if (windowMs <= 0 || coldGuardReverted) return
  if (coldGuardArmedAt === 0) coldGuardArmedAt = Date.now()
  const now = Date.now()
  if (passed) { coldGuardPassed += 1; coldGuardLastPassAt = now }
  else { coldGuardRefusals += 1; coldGuardLastRefusalAt = now }
  // 🔴 ОКНО — СКОЛЬЗЯЩЕЕ, А НЕ ОТ СТАРТА ПРОЦЕССА. Счётчики «за всё время» делали откат
  // невозможным после первого же успешного хода: однажды пропустив, сторож уже никогда не
  // признал бы, что перекрыл кислород. Условие спрашивает про ПОСЛЕДНИЙ отказ, а не про первый.
  if (shouldAutoRevert({
    now,
    lastRefusalAt: coldGuardLastRefusalAt,
    lastPassAt: coldGuardLastPassAt,
    windowMs,
  })) {
    coldGuardReverted = true
  }
}

/**
 * 🔴 АВТО-ОТКАТ СТОРОЖА (слово фаундера 24.10.2026: «включай, если готово, но с автоматическим
 * откатом, если всё поплывёт и все агенты не смогут общаться, чтобы через минуту откатилось»).
 *
 * Условие — НЕ время само по себе: по таймеру сторож выключился бы и тогда, когда всё в порядке.
 * Условие — «нас остановили, и после этого НИКТО не прошёл»: значит мы не защищаем кэш, а
 * перекрыли кислород. Ноль трафика при этом откатом НЕ считается: молчащая дверь — не поломка,
 * и выключать сторожа из-за тишины значило бы никогда не проверить его на живом.
 */
export function shouldAutoRevert(input: {
  now: number
  lastRefusalAt: number
  lastPassAt: number
  windowMs: number
}): boolean {
  if (input.windowMs <= 0) return false
  if (!input.lastRefusalAt) return false
  // Кто-то прошёл ПОСЛЕ последнего отказа — кислород не перекрыт.
  if (input.lastPassAt >= input.lastRefusalAt) return false
  // Отказ был, окно с тех пор истекло, и ни один ход не прошёл — вот это и есть поломка.
  return input.now - input.lastRefusalAt >= input.windowMs
}

/**
 * Метка согласия в ПОСЛЕДНЕМ сообщении пользователя (диалект OpenAI).
 * `content` бывает строкой или массивом частей — читаем оба, никогда не бросаем.
 */
export function hasMarkerInLastUserMessage(body: any, marker: string): boolean {
  try {
    const msgs = Array.isArray(body?.messages) ? body.messages : []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role !== 'user') continue
      const content = m.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        const parts: string[] = []
        for (const p of content) {
          if (typeof p === 'string') parts.push(p)
          else if (p && typeof p === 'object') {
            if (typeof p.text === 'string') parts.push(p.text)
            else if (typeof p.input_text === 'string') parts.push(p.input_text)
          }
        }
        text = parts.join('\n')
      }
      return text.includes(marker)
    }
    return false
  } catch {
    return false
  }
}

async function serve(req: Request, dialect: 'chat' | 'responses'): Promise<Response> {
  const t0 = Date.now()
  const cfg = ctx.config
  const kind = callKindOf(req)
  const door = 'proxy:opencode-go'
  // Единое правило опознания (FR-19/D3). У двери Go носителя в теле нет, поэтому
  // дверей две: имя зовущего (см. `readCallerSession` — пускатель агентов и дверь
  // чата называют сессию РАЗНЫМИ заголовками) или честное «не опознан».
  const caller = readCallerSession(req.headers)
  const identity = resolveSessionIdentity({ headerValue: caller.sessionId })
  const sessionId = identity.sessionId
  const actor = hashActor(req.headers.get(ACTOR_HEADER))
  const path = dialect === 'chat' ? '/chat/completions' : '/responses'

  const raw = new Uint8Array(await req.arrayBuffer())
  let model: string | null = null
  let wantStream = false
  let parsed: any = null
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
    model = typeof parsed.model === 'string' ? parsed.model : null
    wantStream = parsed.stream === true
  } catch {
    return errorResponse(400, 'Invalid JSON body', 'invalid_request_error')
  }

  // Неопознанный запрос ОБСЛУЖИВАЕТСЯ, но назван в журнале: у разового вызова нет
  // номера, по которому его узнать второй раз, — прогрев на нём не вооружается.
  if (identity.source === 'none') {
    ctx.emit({
      level: 'info', kind: EVENT.GO_REQUEST_UNIDENTIFIED,
      sessionId: null, model,
      msg: `дверь Go: запрос без имени зовущего (${CALLER_SESSION_HEADERS.join(' / ')}) — обслужен, прогрев на нём не вооружается`,
    })
  }

  const rec = newRecord({ door, provider: 'opencode-go', call_kind: kind })
  rec.model = model
  rec.session_id = sessionId
  rec.actor = actor
  rec.request.body_bytes = raw.byteLength
  rec.request.body_sha256 = sha256(raw)

  // Названный разрыв префикса — одна строка, только когда действительно переписано:
  // дописывание идут тысячами в час и называть их незачем.
  //
  // 🔴 ПОРЯДОК РЕШЕНИЯ (23.10). Сначала ЧИТАЕМ префикс, потом решаем, потом (если не
  // остановили) записываем. Отказ не сдвигает состояние: иначе остановленный ход сам
  // стал бы переписью, и следующий честный сравнивался бы с телом, которое мы не обслужили.
  // 🔴 ПОРОГИ БЕРУТСЯ У МОДЕЛИ, А НАСТРОЙКА — ТОЛЬКО ЗАПАСНОЙ ВАРИАНТ (24.10.2026, слово
  // фаундера: «лучше задавать отдельно для каждой модели и провайдера»). Реестр теперь несёт
  // `cacheTtlSec` и `rewriteMinTokens` у каждой записи; глобальная настройка остаётся для
  // моделей, которых в реестре нет, — отсутствие поля не должно менять поведение.
  const modelMeta = typeof model === 'string' && model ? getModelMetadata(model) : undefined
  const cacheTtlSec = cfg.goRewriteGuardCacheTtlSecExplicit
    ? cfg.goRewriteGuardCacheTtlSec
    : (modelMeta?.cacheTtlSec ?? cfg.goRewriteGuardCacheTtlSec)
  const cacheTtlMs = cacheTtlSec * 1000
  const analysis = assessPrefix(sessionId, parsed, { now: Date.now(), cacheTtlMs })
  // 🔴 ПОРОГ СЧИТАЕТСЯ ПО ПЕРЕПИСЫВАЕМОЙ ЧАСТИ, А НЕ ПО ВСЕМУ ТЕЛУ (слово фаундера 24.10:
  // «проверяет байт-идентичность слепка и того, что агент шлёт, чтобы детектировать, СКОЛЬКО КЭША
  // перепишется»). Раньше здесь стоял `raw.byteLength / 4` — размер ВСЕГО запроса. У сессии на
  // 300k токенов любая правка в начале давала «~300k» и упиралась в порог, хотя реально
  // переписывается только хвост после расхождения; и наоборот, дописывание в конце считалось
  // переписью целиком. Сторож обязан мерить убыток, а не размер запроса.
  const totalTokens = Math.round(raw.byteLength / 4)
  const predictedTokens = rewrittenTokens(parsed, analysis)
  // Согласие читаем ТОЛЬКО на холодном пути (перепись при живом кэше): пропуск
  // одноразовый и удаляется при чтении, поэтому на append/first его трогать нельзя.
  let consented = false
  // 🔴 Только при включённом стороже: пропуск ОДНОРАЗОВЫЙ и удаляется при чтении,
  // поэтому выключенный сторож не имеет права его сжигать.
  const coldAfterSec = cfg.goRewriteGuardColdAfterSecExplicit
    ? cfg.goRewriteGuardColdAfterSec
    : (modelMeta?.coldRewriteAfterSec ?? cfg.goRewriteGuardColdAfterSec)
  // 🔴 ДОРОГАЯ ЗАПИСЬ = перепись префикса после экономического колена (20 мин у моделей Go).
  // Срок жизни кэша тут НЕ решает: кэш может быть ещё жив, но промах уже стоит как холодный старт.
  const coldRewrite = analysis.verdict === 'rewrite'
    && analysis.toolsChanged !== true
    && (analysis.idleMs ?? 0) >= coldAfterSec * 1000
  const coldGuardOn = cfg.goRewriteGuardColdEnabled && !coldGuardReverted
  if ((cfg.goRewriteGuardEnabled || coldGuardOn) && (analysis.avoidableRewrite === true || analysis.cacheExpired === true || coldRewrite) && sessionId) {
    consented = hasMarkerInLastUserMessage(parsed, cfg.goRewriteGuardMarker)
      || consumeConsent(cfg.goRewriteGuardGrantPath, sessionId)
  }
  // 🔴 ДВА КЛЮЧА — ДВА СЛУЧАЯ, И ОНИ НЕ СКЛАДЫВАЮТСЯ В ОДИН (нашёл на испытании 24.10):
  // `enabled: main || cold` включал бы ТЁПЛУЮ блокировку вместе с холодным ключом, хотя основной
  // сторож выключен. Каждый случай входит только своим ключом.
  if (shouldBlockRewrite({
    enabled: cfg.goRewriteGuardEnabled,
    coldEnabled: coldGuardOn,
    coldRewrite,
    analysis,
    predictedTokens,
    minTokens: cfg.goRewriteGuardMinTokensExplicit
      ? cfg.goRewriteGuardMinTokens
      : (modelMeta?.rewriteMinTokens ?? cfg.goRewriteGuardMinTokens),
    consented,
  })) {
    const whereRu = analysis.firstDiffIndex === undefined
      ? 'место расхождения не определено'
      : `первое расхождение — сообщение #${analysis.firstDiffIndex} (role=${analysis.role})`
    // Текст клиенту — английский, как у сторожа Anthropic; журнал — русский. Смешивать
    // языки внутри одной фразы нельзя: читатель посреди английского предложения
    // спотыкается на русском вставном обороте.
    const whereEn = analysis.firstDiffIndex === undefined
      ? 'the divergence point is unknown'
      : `first divergence at message #${analysis.firstDiffIndex} (role=${analysis.role})`
    const idleMin = Math.round((analysis.idleMs ?? 0) / 60_000)
    const ttlMin = Math.round((analysis.cacheTtlMs ?? cacheTtlMs) / 60_000)
    const consentHttp = `POST http://127.0.0.1:${cfg.proxyPort}/admin/cache-rewrite-ok `
      + `{"sessionId":"${sessionId}"}`
    // 🔴 НАЧАЛО «Cache guard» — ОПУБЛИКОВАННЫЙ КОНТРАКТ (как у сторожа Anthropic):
    // соседи опознают наш отказ именно по этому началу, а не по типу, которого у CLI нет.
    // Текст называет, ЧЕМ эта перепись плоха: кэш жив (виноват отправитель) или уже истёк
    // (виновато время, но платим столько же). Один и тот же отказ с разной причиной читался бы
    // как один и тот же случай, и виновного искали бы не там.
    const coldMin = Math.round(coldAfterSec / 60)
    const why = coldRewrite
      ? `of a prefix after a ${idleMin}-minute gap (>= ${coldMin} min) — this write costs like a COLD start; `
        + `a NEW SESSION would be cheaper than rewriting`
      : `of a prefix whose cache is still alive (idle ${idleMin} min < ttl ${ttlMin} min)`
    const message = `Cache guard: this turn on the Go door would rewrite ~${predictedTokens} `
      + `tokens (of ~${totalTokens} in the request) ${why} — `
      + `${whereEn}, was ${analysis.prevMsgs ?? '?'} messages, now ${analysis.msgs ?? '?'}. `
      + `TWO WAYS FORWARD, and both are deliberate: (1) CONTINUE this session — include `
      + `${cfg.goRewriteGuardMarker} in your next message (or grant out-of-band: ${consentHttp}; `
      + `consent is single-use), and the write is paid knowingly; (2) START FRESH — restart the agent `
      + `so it re-primes from a clean prefix instead of rewriting a large warm cache. `
      + `(Disable: GO_REWRITE_GUARD_ENABLED=false.)`

    rec.response.status = 400
    rec.error = { kind: 'client', provider_type: null }
    rec.timing.total_ms = Date.now() - t0
    writeDump(rec)
    const wasCold = analysis.cacheExpired === true
    // Учитываем отказ ДО выхода: авто-откат решает по числам, а не по обещаниям.
    noteColdGuardOutcome(cfg, false)
    if (coldGuardReverted) {
      ctx.emit({
        level: 'error', kind: EVENT.GO_COLD_GUARD_AUTOREVERT, sessionId, model,
        msg: `🔴 сторож ХОЛОДНОЙ переписи снят АВТО-ОТКАТОМ: остановили ход и после этого ни один `
          + `не прошёл — значит перекрыли кислород, а не защитили кэш. Дверь снова пропускает. `
          + `Отказов ${coldGuardRefusals}, пропусков ${coldGuardPassed}.`,
      })
    }
    ctx.emit({
      level: 'error', kind: EVENT.GO_PREFIX_REWRITE_BLOCKED, sessionId, model,
      msg: `дверь Go: остановлена ${wasCold ? 'ХОЛОДНАЯ перепись (кэш истёк)' : 'перепись при ЖИВОМ кэше'} — ~${predictedTokens} токенов `
        + `(простой ${idleMin} мин, TTL ${ttlMin} мин); ${whereRu}; `
        + `было ${analysis.prevMsgs ?? '?'}, стало ${analysis.msgs ?? '?'}; `
        + `согласия нет (${cfg.goRewriteGuardMarker} или пропуск)`,
    })
    return new Response(JSON.stringify({
      error: {
        type: 'cache_rewrite_guard',
        door: 'opencode-go',
        sessionId,
        predictedTokens,
        minTokens: cfg.goRewriteGuardMinTokens,
        idleMs: analysis.idleMs ?? null,
        cacheTtlMs: analysis.cacheTtlMs ?? cacheTtlMs,
        firstDiffIndex: analysis.firstDiffIndex ?? null,
        role: analysis.role ?? null,
        prevMsgs: analysis.prevMsgs ?? null,
        msgs: analysis.msgs ?? null,
        toolsChanged: analysis.toolsChanged === true,
        consent: {
          marker: cfg.goRewriteGuardMarker,
          http: consentHttp,
          disable: 'GO_REWRITE_GUARD_ENABLED=false',
        },
        message,
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  // Голову ПРЕДЫДУЩЕЙ истории снимаем ДО сдвига состояния: после `commitPrefix` в памяти
  // лежит уже новое, и снимок сравнивал бы новое с новым — то есть молчал бы всегда.
  const prevHead = analysis.verdict === 'rewrite' ? headOf(sessionId) : undefined
  // Прошли — значит сторож не перекрыл кислород. Учитываем ИМЕННО пропуск: авто-откат
  // смотрит на пару «были отказы / были пропуски», а не на время.
  noteColdGuardOutcome(cfg, true)
  // Не остановили — только теперь сдвигаем состояние (ответ не нужен: он уже посчитан).
  commitPrefix(sessionId, parsed, { now: Date.now(), cacheTtlMs })
  if (analysis.verdict === 'rewrite') {
    // Названо МЕСТО, а не только факт: без него нельзя ответить «кто и что поменял».
    const where = analysis.firstDiffIndex === undefined
      ? 'место расхождения не определено'
      : `первое расхождение — сообщение #${analysis.firstDiffIndex} (role=${analysis.role})`
    // 🔴 ТРИ ПРИЧИНЫ, А НЕ ОДНА (23.10): «переписано» без причины читается как «движок
    // сломал кэш». На деле перепись при живом кэше — вина отправителя, смена инструментов —
    // законное изменение префикса, а истёкший кэш — холодная запись, и виноватых нет.
    const idleMin = Math.round((analysis.idleMs ?? 0) / 60_000)
    const ttlMin = Math.round((analysis.cacheTtlMs ?? cacheTtlMs) / 60_000)
    const cause = analysis.avoidableRewrite
      ? `перепись при ЖИВОМ кэше (простой ${idleMin} мин < TTL ${ttlMin} мин) — кэш промахнётся`
      : analysis.toolsChanged
        ? 'сменился набор инструментов — префикс переписан'
        : `кэш истёк по времени (простой ${idleMin} мин ≥ TTL ${ttlMin} мин) — это холодная запись, а не работа движка`
    const tail = analysis.toolsChanged ? '' : '; tools те же'
    // СНИМОК МЕСТА: «сообщение #N изменилось» без «с чего на что» отправляет читателя гадать.
    // Пишем только когда место попало в запомненную голову — иначе честно говорим, почему нет.
    const idx = analysis.firstDiffIndex
    let snapshotNote = '; снимок не снят (место за пределами запомненной головы)'
    if (!sessionId) {
      snapshotNote = '; снимок не снят (сессия не опознана)'
    } else if (idx !== undefined && prevHead && idx < prevHead.length) {
      let curSnippet: string | null = null
      try { curSnippet = JSON.stringify(parsed.messages[idx]).slice(0, SNIPPET_CHARS) } catch { curSnippet = null }
      const path = writeRewriteSnapshot({
        sessionId, model, analysis,
        prevSnippet: prevHead[idx] ?? null,
        curSnippet,
        now: Date.now(),
      })
      snapshotNote = path ? `; снимок ${path}` : '; снимок не снят (запись не удалась или снимки выключены)'
    }
    ctx.emit({
      level: 'info', kind: EVENT.GO_PREFIX_REWRITE, sessionId, model,
      msg: `дверь Go: ${cause}; ${where}; `
        + `было ${analysis.prevMsgs ?? '?'}, стало ${analysis.msgs ?? '?'}${tail}${snapshotNote}`,
    })
  }

  // Продление — за флагом (рельс R8): пока его не включили, здесь ровно прежнее чтение.
  const refreshOn = goTokenRefreshEnabled(process.env)
  const credSrc = {
    tokensPath: cfg.goTokensPath, environ: process.env, now: Date.now, userAgent: cfg.goUserAgent,
  }

  let org
  let orgSource: OrgSource = 'active'
  let cred
  // Якорь выдачи: настоящий номер сессии, если посредник его прокинул, иначе личность агента.
  const orgKey = (sessionId ?? agentKey(parsed) ?? '').trim()
  if (orgKey) {
    const payload = spoolPayload(parsed)
    if (payload) spoolWrite(process.env.GO_SPOOL_DIR ?? `${homedir()}/.claude-local/go-body-spool`, orgKey, payload)
  }
  try {
    const selected = selectOrg(registry(), req.headers.get(ORG_HEADER), cfg, orgKey)
    org = selected.org
    orgSource = selected.source
    rec.org_id = org.name
    rec.provider_org_ref = org.workspace
    cred = await withFreshGoCredential(org, credSrc)
  } catch (err: any) {
    const status = err instanceof GoOrgError ? 400 : 503
    const msg = String(err?.message ?? err).slice(0, 300)
    rec.response.status = status
    rec.error = { kind: err instanceof GoOrgError ? 'client' : err instanceof GoCredentialError ? 'auth' : 'provider', provider_type: null }
    rec.timing.total_ms = Date.now() - t0
    writeDump(rec)
    ctx.emit({ level: 'error', kind: EVENT.GO_ERROR, sessionId, org: org?.name ?? null, msg })
    return errorResponse(status, msg, status === 400 ? 'invalid_request_error' : 'api_error')
  }

  const url = org.baseUrl.replace(/\/$/, '') + path
  rec.request.url = url
  const baseHeaders: Record<string, string> = {
    ...cred.headers,
    'content-type': 'application/json',
    // Постоянный на всех: шлюз скоупит кэш этим заголовком (архитектура R6 — не менять до замера 5.4).
    'x-opencode-session': cfg.goProviderSession,
  }
  const send = (secret: string) => fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders, authorization: `Bearer ${secret}` },
    body: raw, signal: req.signal,
  })
  rec.request.headers = redactHeaders({ ...baseHeaders, authorization: `Bearer ${cred.secret}` })

  ctx.emit({ level: 'info', kind: EVENT.GO_REQUEST, sessionId, org: org.name, model, stream: wantStream, callKind: kind })

  // Не больше ДВУХ попыток и никаких циклов. 401 у организации-консоли — единственный сигнал,
  // которому верим на слово: продлеваем ОДИН раз и повторяем запрос ОДИН раз. Продление не
  // удалось — клиенту проходит исходный 401 (дверь не падает из-за чужой сети).
  let upstream: Response | null = null
  let networkErr: any = null
  for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
    try {
      upstream = await send(cred.secret)
      networkErr = null
    } catch (err: any) {
      upstream = null
      networkErr = err
      break
    }
    if (!(upstream.status === 401 && attemptNo === 0 && refreshOn && org.auth === 'console')) break
    // Тело первого 401 не читаем — освобождаем соединение, иначе оно висит до сборки мусора.
    try { await upstream.body?.cancel() } catch { /* уже закрыто */ }
    let renewed
    try {
      renewed = await forceRefreshGoCredential(org, credSrc, { failedToken: cred.secret })
    } catch (err: any) {
      ctx.emit({
        level: 'error', kind: EVENT.GO_ERROR, sessionId, org: org.name,
        msg: `дверь Go: продление после 401 не удалось: ${String(err?.message ?? err).slice(0, 200)}`,
      })
      break
    }
    cred = renewed
    rec.request.headers = redactHeaders({ ...baseHeaders, authorization: `Bearer ${cred.secret}` })
  }

  if (!upstream) {
    const err = networkErr
    const msg = err?.name === 'AbortError' ? 'client aborted' : `gateway unreachable: ${err?.message}`
    rec.error = classifyError(null, true)
    rec.timing.total_ms = Date.now() - t0
    writeDump(rec)
    ctx.emit({ level: 'error', kind: EVENT.GO_ERROR, sessionId, org: org.name, msg: msg.slice(0, 200) })
    return errorResponse(502, msg)
  }

  rec.timing.ttfb_ms = Date.now() - t0
  rec.response.status = upstream.status
  const respHeaders = redactHeaders(upstream.headers)
  rec.response.headers = respHeaders
  rec.quota_seen = pickQuotaSeen(respHeaders)
  rec.error = classifyError(upstream.status, false)
  const extract = dialect === 'chat' ? extractUsageChat : extractUsageResponses

  const passHeaders = new Headers()
  for (const h of ['content-type', 'retry-after', 'cache-control']) {
    const v = upstream.headers.get(h)
    if (v) passHeaders.set(h, v)
  }
  // 🔴 СЛЕД ВЫБОРА НАРУЖУ, А НЕ ТОЛЬКО В СВОЙ ЖУРНАЛ.
  // Выбирает организация ДВЕРЬ, и только дверь знает этот факт; посредник пишет учёт по факту
  // и без этих заголовков теряет пару «сессия → организация» (замер 26.10: после перевода
  // маршрута go_org/go_session в журнале посредника стали 0 — его хук узнавал модели Go
  // по credential-имени, которого у модели больше нет). Правило заказчика: выбирает дверь,
  // а пишет тот, кто видит факт со стороны.
  passHeaders.set('x-kiberos-served-org', org.name)
  if (orgKey) passHeaders.set('x-kiberos-org-key', orgKey)
  passHeaders.set('x-kiberos-org-source', orgSource)

  const finish = (text: string, streamed: boolean) => {
    rec.timing.total_ms = Date.now() - t0
    let usage: unknown | null = null
    if (streamed) usage = usageFromSseText(text)
    else {
      try { const j = JSON.parse(text); usage = j?.usage ?? j?.response?.usage ?? null; rec.response.body = bodyField(text) } catch { /* не JSON */ }
    }
    if (streamed) rec.response.body = bodyField(null)
    rec.usage_raw = usage
    rec.usage_norm = extract(usage)
    if (rec.error) {
      try { rec.response.body = JSON.parse(text) } catch { rec.response.body = text.slice(0, 2000) }
    }
    writeDump(rec)
    ctx.emit({
      level: upstream.ok ? 'info' : 'error',
      kind: upstream.ok ? EVENT.GO_COMPLETE : EVENT.GO_ERROR,
      sessionId, org: org.name, model, stream: streamed, status: upstream.status,
      durationMs: rec.timing.total_ms, inTokens: rec.usage_norm.input, outTokens: rec.usage_norm.output,
      cachedTokens: rec.usage_norm.cache_read, callKind: kind,
    })
  }

  if (!wantStream || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    finish(text, false)
    return new Response(text, { status: upstream.status, headers: passHeaders })
  }

  // Поток: отдаём клиенту как идёт, копию (до предела) держим для usage и дампа.
  let kept = ''
  let keptBytes = 0
  const decoder = new TextDecoder()
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (keptBytes < STREAM_CAP_BYTES) { kept += decoder.decode(chunk, { stream: true }); keptBytes += chunk.byteLength }
    },
    flush() { finish(kept, true) },
    // Обрыв читателя: запись всё равно уходит (отказ сети и обрыв — тоже вызов).
  })
  return new Response(upstream.body.pipeThrough(tee), { status: upstream.status, headers: passHeaders })
}

export function createGoDoorModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/go/chat/completions', handler: (req) => serve(req, 'chat') },
    { method: 'POST', path: '/go/responses', handler: (req) => serve(req, 'responses') },
  ]
  return { name: 'go-door', routes, init(c) { ctx = c } }
}
