/**
 * Третья дверь тревоги — КАРТОЧКА ЧЕЛОВЕКУ ТУДА, ГДЕ ОН ЧИТАЕТ.
 *
 * 🔴 ЗАЧЕМ ЭТО ЕСТЬ, И ПОЧЕМУ ДВУХ ПРЕЖНИХ ДВЕРЕЙ НЕ ХВАТИЛО.
 *
 * `local-alert.ts` доставляет тревогу в системный журнал и всплывашкой на
 * рабочий стол. Обе честные и обе НЕ ДОХОДЯТ до фаундера: ночью за машиной
 * никого, а журнал читает тот, кто уже пошёл искать беду. Замер 03.09.2026:
 * семь сессий у сторожа, 29 отказов, 34 записи в системном журнале — и ни
 * одного согласия за ночь, потому что человеку об этом никто не сказал.
 *
 * Отказ сторожа уходит HTTP 400 ДО модели, поэтому остановленный агент не может
 * позвать сам: хода у него больше нет. Владелец tixi-cold принёс это замером
 * 13.09.2026 — его смена простояла двое суток, фаундер трижды написал ей и
 * трижды получил ответ не от неё, а от сторожа; снаружи «агент молчит» и
 * «агента сняли» выглядели одинаково. Круг не размыкается изнутри: чтобы
 * воспользоваться законным выходом (согласием), агенту нужен ход, а хода нет.
 *
 * 🔴 ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ВЕТКА В `local-alert.ts`. У тех двух
 * дверей нет сети: они пишут в свою машину и не умеют ни висеть, ни отвечать
 * отказом. Эта — сетевая, чужая и может быть выключена (503), не настроена
 * (секрета нет) или просто молчать. Смешать их значило бы поставить доставку
 * в журнал в зависимость от чужого таймаута.
 *
 * 🔴 ГРАНИЦА ВЛАСТИ: КАРТОЧКА СПРАШИВАЕТ, А НЕ РАЗРЕШАЕТ. Согласие на трату
 * остаётся за человеком — сторож заведён директивой фаундера ровно затем, чтобы
 * дорогая трата была подписана. Мы приносим ему основание и совет; кнопку
 * нажимает он.
 *
 * Контракт полей назван владельцем сурфейса и прочитан в его исходнике
 * (`telegram-surface/src/mcp/server.ts:1751`, интерфейс `StuckSessionAsk`
 * там же выше): обязательны `sessionId`, `guard`, `reason`, `stuckForSec`;
 * незнакомое слово в `guard`/`liveness`/`advice` он ОТВЕРГАЕТ, а не рисует
 * чем-нибудь. Заголовок секрета — `x-executor-secret`.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Дверь сурфейса. Переопределяется переменной — у другой машины она другая. */
const doorUrl = (): string =>
  process.env.SURFACE_HITL_URL || 'http://127.0.0.1:9810/hitl/stuck-session'

/**
 * Секрет исполнительских дверей сурфейса.
 *
 * 🔴 ОН ОБЩИЙ НА ВСЕХ ИСПОЛНИТЕЛЕЙ — то же значение держит роутер побудок.
 * Значит смена значения ломает не только нас, и ротация — не наше одностороннее
 * действие (названо владельцем сурфейса 12.09.2026 и принято). Читаем из
 * окружения, иначе из файла вне репозитория; в git он не попадёт никогда.
 */
const SECRET_FILE = () =>
  process.env.SURFACE_CONSENT_ENV
  || join(homedir(), '.claude-local', 'surface-consent.env')

let secretCache: string | null | undefined
function secret(): string | null {
  if (secretCache !== undefined) return secretCache
  const fromEnv = process.env.SURFACE_SPAWN_CONSENT_SECRET?.trim()
  if (fromEnv) { secretCache = fromEnv; return secretCache }
  try {
    for (const line of readFileSync(SECRET_FILE(), 'utf8').split('\n')) {
      const m = /^\s*SURFACE_SPAWN_CONSENT_SECRET\s*=\s*(.+?)\s*$/.exec(line)
      if (m) { secretCache = m[1].replace(/^["']|["']$/g, ''); return secretCache }
    }
  } catch { /* файла нет — дверь просто не настроена на этой машине */ }
  secretCache = null
  return secretCache
}
/** Забыть прочитанное — для испытаний и на случай, если файл появился позже. */
export function _forgetSecret(): void { secretCache = undefined }
/** Шов чтения секрета — чтобы проверять ЕГО, не трогая дверь и сеть. */
export function _secretForTests(): string | null { return secret() }

/** Конверт ровно той формы, которую разбирает дверь сурфейса. */
export interface StuckCardAsk {
  sessionId: string
  guard: 'cache' | 'quota'
  reason: string
  stuckForSec: number
  tokens?: number
  lastBlockAt?: number
  announcements?: number
  cwd?: string
  pid?: number
  /** 🔴 `unknown` — это «проверить нечем», а НЕ «почти жив». Так и рисуется. */
  liveness?: 'alive' | 'dead' | 'unknown'
  /** Совет, а не решение: старый мёртвый кэш дешевле перезапустить, чем купить. */
  advice?: 'grant' | 'restart'
  source?: string
  version?: string
}

export interface StuckCardResult {
  /** Поднялась ли карточка. `false` и с причиной — тоже штатный ответ двери. */
  raised: boolean
  /** Почему не поднялась — своими словами двери либо нашими, если она молчит. */
  reason?: string
  interactionUuid?: string
  /** Кем оказался владелец каталога: имени агента у нас нет, его выводит дверь. */
  agent?: unknown
  /** Вопрос уже висит — дверь не задаёт второй. */
  standing?: unknown
}

/**
 * Шов для испытаний: настоящая доставка идёт по сети к чужой службе, и прогон
 * набора НЕ ДОЛЖЕН стучаться в живую дверь машины. Тот же приём, что
 * `_setAlertDelivery` у соседнего файла.
 */
let sender: ((ask: StuckCardAsk) => Promise<StuckCardResult>) | null = null
export function _setCardSender(
  fn: ((ask: StuckCardAsk) => Promise<StuckCardResult>) | null,
): void { sender = fn }

/** Выключатель, как у тревоги: '0' — не звать дверь вовсе. */
const enabled = () => process.env.PROXY_SURFACE_CARD !== '0'

/** Сколько ждём чужую дверь. Она рисует карточку в Telegram, это не мгновенно. */
const TIMEOUT_MS = 8_000

/**
 * Поднять карточку. НИКОГДА НЕ БРОСАЕТ: тревога не должна падать оттого, что
 * сосед выключен. Всякий исход возвращается словами, чтобы его можно было
 * записать в журнал — молчаливый провал здесь был бы той же болезнью, от
 * которой вся эта цепь и лечит.
 */
export async function raiseStuckCard(ask: StuckCardAsk): Promise<StuckCardResult> {
  // 🔴 ШОВ СПРАШИВАЕТСЯ ПЕРВЫМ, И ЭТО НЕ МЕЛОЧЬ ПОРЯДКА. Выключатель говорит про
  // НАСТОЯЩУЮ дверь — «не ходи в сеть». Шов же и есть подставная дверь: если
  // проверить его молчанием выключателя, испытание пройдёт, ничего не проверив,
  // и провал в конверте всплывёт на живой службе.
  if (sender) {
    try { return await sender(ask) }
    catch (e) { return { raised: false, reason: `шов испытания бросил: ${String(e)}` } }
  }
  if (!enabled()) return { raised: false, reason: 'карточка выключена (PROXY_SURFACE_CARD=0)' }
  // 🔴 ПРОГОН ИСПЫТАНИЙ НЕ СТУЧИТСЯ К ЖИВОМУ ЧЕЛОВЕКУ — ЗАМОК ЗДЕСЬ, А НЕ В
  // ДИСЦИПЛИНЕ КАЖДОГО ФАЙЛА. Замер 19.09.2026, принёс владелец телеграм-службы:
  // за две минуты в комнату фаундера пришло СЕМЬ настоящих карточек с живыми
  // кнопками — s-unknown, s-live, s-trace, s-stale, s-patient, s-known, s-freed.
  // Это имена сессий из `local-alert-stuck-liveness.test.ts`: оно подменяло
  // доставку тревоги (`_setAlertDelivery`), а про ЭТУ дверь не знало вовсе, и
  // каждый прогон набора будил человека всерьёз. Нажатие на такой карточке
  // вернулось бы вердиктом по несуществующей сессии.
  //
  // Шов был и раньше — но он требовал, чтобы КАЖДОЕ испытание про него помнило,
  // то есть лечил дисциплиной там, где нужен замок. Кто хочет проверить
  // настоящую отправку, ставит `_setCardSender` и проходит условием выше;
  // случайно обойти этот замок нельзя.
  //
  // 🔴 И ЗАМОК НЕСНИМАЕМ — ЭТО ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ УРОКА, КУПЛЕННАЯ ЧЕРЕЗ
  // ЧАС ПОСЛЕ ПЕРВОЙ. Сперва замок умел сниматься переменной окружения
  // (`PROXY_SURFACE_CARD=1`) — «для тех, кто проверяет саму отправку». Замер
  // тем же вечером: испытание сняло её и не вернуло (восстановление писало
  // значение назад, только если оно БЫЛО, а его не было) — и дальше весь прогон
  // шёл с открытым замком. Результат: ещё ДЕСЯТЬ настоящих стуков, и уже не с
  // выдуманными именами, а с живыми номерами сессий машины, вычитанными из
  // рабочего учёта. Снимаемый замок не замок: одна забытая уборка открывает его
  // всем остальным файлам разом.
  //
  // Кому нужна настоящая отправка — ставит `_setCardSender` (условие выше).
  // Кому нужна проверка секрета — зовёт `secret()` напрямую. Через эту дверь в
  // сеть из прогона не выйти НИКАК.
  if (process.env.NODE_ENV === 'test') {
    return { raised: false, reason: 'прогон испытаний — живая дверь не зовётся (шов: _setCardSender)' }
  }
  const key = secret()
  if (!key) {
    return { raised: false, reason: `секрет не найден — ни в окружении, ни в ${SECRET_FILE()}` }
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(doorUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-executor-secret': key },
      body: JSON.stringify(ask),
      signal: ctl.signal,
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      // 🔴 ОТКАЗ НАЗЫВАЕТСЯ ЕГО ЖЕ СЛОВАМИ. Дверь отвечает 400 С ИМЕНЕМ ошибки
      // нарочно — «чтобы она была громкой там, где её чинят». Подменять это
      // своим «не получилось» значило бы гасить именно ту громкость.
      const named = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
      return { raised: false, reason: `дверь отказала: ${named}` }
    }
    return {
      raised: body?.raised !== false,
      ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
      ...(typeof body?.interaction_uuid === 'string' ? { interactionUuid: body.interaction_uuid } : {}),
      ...(body?.agent ? { agent: body.agent } : {}),
      ...(body?.standing_question ? { standing: body.standing_question } : {}),
    }
  } catch (e) {
    const why = (e as { name?: string })?.name === 'AbortError'
      ? `дверь не ответила за ${TIMEOUT_MS / 1000} с`
      : `дверь недостижима: ${String((e as Error)?.message ?? e)}`
    return { raised: false, reason: why }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Что СОВЕТОВАТЬ человеку — по решению фаундера 11.09.2026, дословно: «Если
 * сторож их уже остановил и кэш их точно уже протух, то тратить кэш не нужно.
 * Надо просто скажи мне, я их сам перезапущу».
 *
 * Отсюда две развилки, и обе про цену, а не про вкус:
 * — первая запись (`first-write`) ничего не выбрасывает, покупать нечего заново
 *   — разрешить дёшево и правильно;
 * — кэш, умерший больше часа назад, согласие КУПИТ ЗАНОВО целиком, и куплен
 *   будет позавчерашний разговор: перезапуск дешевле и чище.
 * Час — это срок жизни кэша (`cacheTtlMs`, замер 03.09: 60 минут), то есть
 * граница, за которой «освежить» уже невозможно в принципе.
 *
 * 🔴 ЭТО СОВЕТ, А НЕ РЕШЕНИЕ. Карточка рисует его вместе с основанием, выбирает
 * человек: цена одного и того же нажатия зависит от того, нужна ли ему ещё та
 * смена, а этого отсюда не видно.
 */
export function adviceFor(
  spendKind: unknown,
  cacheDeadForMs: number | null,
  ttlMs = 3_600_000,
): 'grant' | 'restart' {
  if (spendKind === 'first-write') return 'grant'
  if (cacheDeadForMs !== null && cacheDeadForMs >= ttlMs) return 'restart'
  return 'grant'
}
