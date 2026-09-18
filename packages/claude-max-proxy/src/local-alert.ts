/**
 * Local alert — carries the events that matter OUT of the log file.
 *
 * 🔴 WHY THIS EXISTS, MEASURED 2026-08-24.
 *
 * The upstream shed every large request for 52 minutes that morning. The storm
 * watch noticed and declared it — and the declaration went into a log file on
 * disk, which is to say to nobody. The founder found out by feeling his agents
 * stall, then asked; the instrument had "known" for six minutes by then and the
 * per-session alarm did not exist yet. A guard that detects correctly and
 * reports into a file it knows no one is tailing is the same defect the storm
 * watch header spends fifty lines arguing against, just one step further along:
 * honest in the happy case, mute in the case it exists for.
 *
 * So the service delivers its own alerts, to the two doors that need nobody
 * else's permission: the system journal (durable, greppable, survives restarts)
 * and a desktop notification (immediate, if a human is at this machine).
 *
 * 🔴 WHY THIS DUPLICATES proxy-failure-alert.sh AND MUST — the duplication is
 * forced, not sloppy. That script is invoked by systemd's OnFailure= when the
 * unit has already died; an in-process notifier cannot report its own death.
 * One path for "I am in trouble", another for "I am gone". Neither can cover
 * the other's case.
 *
 * 🔴 ТРЕТЬЯ ДВЕРЬ ПОЯВИЛАСЬ 15.09.2026 — И ПРЕЖНЯЯ ЗАПИСЬ ЗДЕСЬ БОЛЬШЕ НЕ ВЕРНА.
 * На этом месте стояло «это НЕ путь в Telegram, та дверь чужая, её просят, а не
 * берут». Просьба состоялась и удовлетворена: владелец сурфейса выкатил
 * `POST :9810/hitl/stuck-session` 12.09.2026, и стоящая сессия теперь зовёт
 * человека туда, где он читает. Само правило осталось прежним — дверь чужая, мы
 * в неё СТУЧИМ (`surface-card.ts`), а рисует карточку и решает про имя агента
 * её хозяин. Обе местные двери при этом на месте и от сети не зависят: сосед
 * может быть выключен, а журнал обязан наполниться всё равно.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { bus } from './event-bus.js'
import { processAlive } from './session-tracker.js'
import { raiseStuckCard, adviceFor, type StuckCardAsk } from './surface-card.js'

/** Whether to deliver at all — off in tests, and a way out if it ever annoys. */
const enabled = () => process.env.PROXY_LOCAL_ALERT !== '0'

/**
 * Test seam. Delivery goes out through two OS doors (journal + desktop), and a
 * test cannot read either of them without spawning processes on the machine
 * running the suite. Override to capture instead; `null` restores the real
 * doors. Same underscore idiom as storm-watch's `_stormState`.
 */
let delivery: ((subject: string, body: string, journalOnly?: boolean) => void) | null = null
export function _setAlertDelivery(
  fn: ((subject: string, body: string, journalOnly?: boolean) => void) | null,
): void {
  delivery = fn
}

/**
 * Жив ли процесс — тем же `kill -0`, что и у трекера, но через шов: испытанию
 * нужно называть живых и мёртвых самому, а не заводить настоящие процессы.
 */
let aliveProbe: ((pid: number) => boolean) | null = null
export function _setAliveProbe(fn: ((pid: number) => boolean) | null): void {
  aliveProbe = fn
}
const isAlive = (pid: number): boolean =>
  aliveProbe ? aliveProbe(pid) : processAlive(pid)

/** Never let a notifier hold the service open or crash it.
 *  `journalOnly` — для бухгалтерии: снятие с учёта обязано оставить след, но
 *  будить человека всплывашкой ради «перестал стоять» незачем. */
function fire(subject: string, body: string, journalOnly = false): void {
  if (!enabled()) return
  if (delivery) { try { delivery(subject, body, journalOnly) } catch { /* a sink must not break the path */ } return }
  const line = `${subject} — ${body}`
  try {
    // Durable half: the system journal. `logger` is in coreutils-adjacent
    // util-linux and present on every machine this runs on.
    Bun.spawn(['logger', '-p', 'user.warning', '-t', 'claude-max-proxy', line], {
      stdout: 'ignore', stderr: 'ignore',
    }).unref()
  } catch { /* a missing logger must not matter */ }
  if (journalOnly) return
  try {
    // Immediate half: a desktop notification, best-effort. User systemd units
    // have XDG_RUNTIME_DIR, so point at the session bus the same way the
    // failure hook does.
    const bus_addr = process.env.DBUS_SESSION_BUS_ADDRESS
      ?? `unix:path=${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/bus`
    Bun.spawn(['notify-send', '-u', 'critical', subject, body], {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus_addr },
      stdout: 'ignore', stderr: 'ignore',
    }).unref()
  } catch { /* no desktop is a normal state on a server */ }
}

/** 352954 → «352 954». Цена хода читается человеком, а не парсером. */
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** Имя класса — для журнала; человеку нужно, ЧТО случилось. */
function rewriteReason(rewriteClass: unknown, spendKind: unknown): string {
  if (rewriteClass === 'expected:cold-start' || spendKind === 'first-write') {
    return 'первая запись кэша для этой родословной — ничего не выбрасывается'
  }
  if (rewriteClass === 'anomalous:org-switch') return 'сменился аккаунт, прежний кэш остался на нём'
  if (rewriteClass === 'avoidable:ttl-expiry') return 'кэш остыл и будет куплен заново'
  return `класс ${String(rewriteClass ?? 'неизвестен')}`
}

/**
 * Сколько отказов подряд означает стену. Первый — вопрос, на который вызывающий
 * ещё может ответить сам (маркером согласия в следующем сообщении); второй
 * означает, что отвечать некому, и вот тогда зовут человека.
 */
const REWRITE_ALERT_MIN_STREAK = 2
/** Одна тревога на сессию за окно: 29 отказов дали бы 29 уведомлений. */
const REWRITE_ALERT_COOLDOWN_MS = 15 * 60 * 1000
const rewriteAnnouncedAt = new Map<string, number>()

// Сторож запаса гасится ПО АККАУНТУ, а не по сессии, и это не мелочь: он
// останавливает КАЖДУЮ сессию на исчерпанном аккаунте, а их бывает три
// десятка. Ключ по сессии превратил бы одно событие в тридцать одинаковых
// уведомлений — способ добиться, чтобы человек выключил уведомления совсем.
const QUOTA_ALERT_COOLDOWN_MS = 15 * 60 * 1000
const quotaAnnouncedAt = new Map<string, number>()

// ── Тревога по СОСТОЯНИЮ, а не по событию ────────────────────────────
//
// 🔴 ЗАЧЕМ, И ЭТО НАШЁЛ НЕ Я. Владелец побудок 03.09.2026 прошёл ГЛАЗАМИ по
// экранам флота и нашёл ВОСЕМЬ агентов, стоящих у сторожа мёртво: у каждого
// последнее событие — отказ, дальше пустая строка. Самый давний молчал
// 6,7 суток. По журналу при этом всё выглядело исправно: 70 честных тревог за
// восемь дней, каждая с именем сессии и готовой командой.
//
// Причина в том, что тревога выше звучит НА ОТКАЗ — то есть пока агент ещё
// стучится. Замер по тем же 70 записям: у активных сессий 5–6 срабатываний
// подряд, у сдавшихся после второго отказа — ровно одно. Агент, который встал
// и ЗАМОЛЧАЛ, выпадает из поля зрения совсем: новых отказов нет, а тишина
// вставшего неотличима от тишины здорового.
//
// Поэтому здесь ведётся именно СОСТОЯНИЕ: кто стоит и сколько уже стоит.
// Напоминание повторяется с растущим шагом и НАЗЫВАЕТ СРОК — сессия, стоящая
// шестые сутки, говорит о себе шестые сутки, а не один раз в первые пятнадцать
// минут.
//
// 🔴 И ОНО ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК СЛУЖБЫ, иначе лечение не работает вовсе: за
// один сегодняшний день служба перезапускалась четырежды, а стоящие сессии
// живут сутками. Память в процессе забыла бы ровно тех, ради кого всё это.
// Путь настраиваемый — иначе испытание пишет в ЖИВОЙ файл машины и, что хуже,
// читает из него чужие сессии: обход шлёт уведомления по остаткам от флота, и
// «сработало один раз» превращается в «сработало сколько-то раз».
// 🔴 ПУТЬ ПРИХОДИТ ИЗВНЕ, А НЕ ИЗ ПЕРЕМЕННОЙ ОКРУЖЕНИЯ — И ЭТО ЗАПЛАЧЕНО.
// Прежде он вычислялся ОДИН РАЗ при загрузке модуля, а испытания подменяли
// переменную перед импортом. В одиночку такой набор зелёный; в общем прогоне
// модуль успевает загрузить кто-то раньше — и тогда испытания пишут в ЖИВОЙ
// файл состояния машины. 11.09.2026 это случилось по-настоящему: после прогона
// в живом файле оказался тестовый ключ `s-body`, то есть набор тестов правил
// учёт стоящих сессий боевой службы. Зависимость, переданную аргументом,
// подменить нельзя мимо — она видна в месте вызова.
const defaultBlockedStatePath = () =>
  process.env.PROXY_BLOCKED_STATE_PATH
  || join(homedir(), '.claude-local', 'blocked-sessions.json')
let BLOCKED_STATE_JSON = defaultBlockedStatePath()
/** Шаг напоминаний: чем дольше стоит, тем реже — но никогда не молча. */
const STUCK_REMINDER_STEPS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]
const STUCK_SWEEP_INTERVAL_MS = 10 * 60_000
// 🔴 ПОТОЛОК ДЛЯ ТЕХ, ЧЬЮ ЖИЗНЬ ПРОВЕРИТЬ НЕЧЕМ — и только для них.
// Владельца опознать удаётся не всегда («порт источника не назван», «процесс по
// порту не найден»), а утверждать девятые сутки то, что не проверял, нельзя:
// это и есть та самая уверенная ложь, от которой мы лечим соседей. Поэтому у
// неопознанного есть срок, и считается он от ПОСЛЕДНЕЙ ПОПЫТКИ, а не от начала
// стояния: сессия, которую ещё пинают, отказывает снова и снова, а брошенная —
// молчит. Тому, чей владелец ЖИВ, потолок не применяется вовсе: он может честно
// стоять неделю и обязан звать всё это время.
const STUCK_UNVERIFIABLE_CEILING_MS = 48 * 60 * 60_000
interface StuckSession {
  since: number          // когда отказали в первый раз
  lastBlockAt: number    // последний отказ
  announcedAt: number    // когда в последний раз напоминали
  announcements: number
  reason: string
  tokens: number
  /** Владелец на момент отказа. null / поля нет — опознать не удалось.
   *  Именно он переживает перезапуск службы и даёт обходу судить самому. */
  pid?: number | null
  /** Сколько кэша уже нет, на момент последнего отказа. По нему считается
   *  СОВЕТ человеку: купить заново или перезапустить. `null`/поля нет — срок
   *  неизвестен, и тогда совет не посылается вовсе, а не выдумывается. */
  idleMs?: number | null
  /** Первая это запись кэша или перезапись — вторая половина того же совета:
   *  первая запись ничего не выбрасывает, и разрешить её дёшево. */
  spendKind?: string | null
  /** Рабочий каталог владельца — то есть ПРОЕКТ, в котором стоит агент.
   *  «Сессия d91694bb» человеку не говорит ничего; «сессия d91694bb,
   *  /home/relishev/projects/vibe/photo3d» говорит всё. Путь идёт как есть:
   *  выводить из него имя проекта значило бы гадать за реестр. */
  cwd?: string | null
}

/**
 * Всё, что служба знает о стоящей сессии, — для того, кто показывает это
 * ЧЕЛОВЕКУ. Ни одного поля «на всякий случай»: каждое отвечает на вопрос,
 * который человек задаёт, глядя на замерший разговор.
 */
export interface StuckReport {
  sessionId: string
  stuck: true
  /** Какой сторож держит ход. Сегодня в этот учёт пишет только сторож кэша:
   *  сторож запаса держит ходы ПО АККАУНТУ и сессий не помнит. */
  guard: 'cache'
  /** Сколько стоит — с ПЕРВОГО отказа, а не с последнего. */
  stuckForSec: number
  sinceAt: number
  lastBlockAt: number
  /** Давно ли стучался. Большой разрыв = агент перестал пробовать вовсе. */
  lastBlockAgoSec: number
  announcements: number
  reason: string
  /** Сколько токенов просит отбитый ход — размер беды человеческим числом. */
  tokens: number
  liveness: 'alive' | 'dead' | 'unknown'
  pid: number | null
  cwd: string | null
  idleMs: number | null
  spendKind: string | null
  advice: 'grant' | 'restart' | null
}

/** Кто владеет сессией прямо сейчас — номер процесса и его рабочий каталог. */
export interface StuckOwner {
  pid: number | null
  cwd: string | null
}
const stuck = new Map<string, StuckSession>()

function loadStuck(): void {
  try {
    const raw = JSON.parse(readFileSync(BLOCKED_STATE_JSON, 'utf8')) as Record<string, StuckSession>
    for (const [sid, v] of Object.entries(raw ?? {})) {
      if (v && typeof v.since === 'number') stuck.set(sid, v)
    }
  } catch { /* первый запуск или битый файл — начинаем с чистого */ }
}
function saveStuck(): void {
  try {
    const dir = dirname(BLOCKED_STATE_JSON)
    try { mkdirSync(dir, { recursive: true }) } catch { /* уже есть */ }
    writeFileSync(BLOCKED_STATE_JSON, JSON.stringify(Object.fromEntries(stuck)), 'utf8')
  } catch { /* учёт не должен ронять службу */ }
}
/** «6,7 суток» / «9,1 ч» / «22 мин» — человеку нужен срок, а не отметка времени. */
/**
 * Постучать в дверь сурфейса — поднять человеку карточку о стоящей сессии.
 *
 * 🔴 ПОЧЕМУ ЭТО ЗОВЁТСЯ ТАМ ЖЕ, ГДЕ И `fire`, А НЕ ВМЕСТО НЕЁ. Две местные двери
 * (журнал и рабочий стол) ни от чего не зависят и наполняются всегда. Эта —
 * сетевая и чужая: сосед может быть выключен, не настроен или молчать. Поэтому
 * она идёт ПОСЛЕ, её исход пишется в журнал отдельной строкой, и провал в ней
 * ничего не отменяет.
 *
 * Ничего не ждём: тревога живёт в обработчике события, и держать его ради чужой
 * сети нельзя. Исход дописывается, когда придёт.
 */
function knock(sid: string, st: StuckSession, now: number): void {
  const pid = st.pid ?? null
  const ask: StuckCardAsk = {
    sessionId: sid,
    guard: 'cache',
    reason: st.reason,
    stuckForSec: Math.max(0, Math.round((now - st.since) / 1000)),
    tokens: st.tokens,
    lastBlockAt: st.lastBlockAt,
    announcements: st.announcements,
    // 🔴 «Проверить нечем» — это СВОЁ состояние, а не «наверное, жив». Владелец
    // не опознан → говорим `unknown`, и карточка произносит это вслух.
    liveness: pid === null ? 'unknown' : (isAlive(pid) ? 'alive' : 'dead'),
    source: 'claude-max-proxy/local-alert',
    ...(st.cwd ? { cwd: st.cwd } : {}),
    ...(pid !== null ? { pid } : {}),
    // Совет шлём ТОЛЬКО когда есть чем его обосновать: срок мёртвого кэша.
    // Нет срока — нет и совета; выдуманный совет хуже отсутствующего, потому
    // что человек примет его за замер.
    ...(typeof st.idleMs === 'number' && st.idleMs >= 0
      ? { advice: adviceFor(st.spendKind, st.idleMs) }
      : {}),
  }
  void raiseStuckCard(ask).then((r) => {
    fire(
      r.raised ? 'Карточка о стоящей сессии поднята' : 'Карточку о стоящей сессии поднять не удалось',
      `сессия ${sid}: ${r.raised
        ? `человека спросили${r.interactionUuid ? `, взаимодействие ${r.interactionUuid}` : ''}`
        : (r.reason ?? 'причина не названа')}.`,
      true,
    )
  })
}

/** Один проход по стоящим. Время — АРГУМЕНТ: обход, читающий часы сам, в тесте
 *  можно только ждать, а шаг напоминания здесь измеряется сутками. */
function sweepStuck(now: number): void {
  let changed = false
  for (const [sid, st] of stuck) {
    // ── Сначала: а есть ли ещё кого звать? ──────────────────────────────
    // 🔴 ПОЧЕМУ ЭТО ЗДЕСЬ, А НЕ НА СОБЫТИИ `SESSION_DEAD`. Снятие по событию
    // работает ровно до первого перезапуска службы: `reapDead()` обходит ПАМЯТЬ
    // трекера, а она умирает вместе с процессом, тогда как файл стоящих —
    // переживает. Дальше о покойнике сказать некому: трекер о нём не знает, а
    // обход ждёт события, которое уже не придёт. Замер 11.09.2026 по живому
    // файлу: семь стоящих, живая одна, остальные шесть встали 02–05.09 и
    // получили по 9–18 напоминаний каждая. Событие оставлено — оно снимает
    // быстрее; но истина о жизни считается ЗДЕСЬ, из данных, лежащих на диске.
    const pid = st.pid ?? null
    if (pid !== null) {
      if (!isAlive(pid)) {
        stuck.delete(sid)
        changed = true
        retired(sid, st, now, `владельца (${pid}) больше нет — звать некого`)
        continue
      }
    } else if (now - st.lastBlockAt > STUCK_UNVERIFIABLE_CEILING_MS) {
      stuck.delete(sid)
      changed = true
      retired(sid, st, now, 'владелец не опознан, и попыток нет более двух суток —'
        + ' утверждать, что она всё ещё стоит, стало нечем')
      continue
    }
    // Шаг берётся по числу УЖЕ СДЕЛАННЫХ напоминаний минус первое, прозвучавшее
    // на самом отказе: иначе первый повтор ушёл бы на час, а он нужен раньше —
    // пятнадцать минут это ещё то окно, в котором человек помнит, чем занимался.
    const idx = Math.min(Math.max(0, st.announcements - 1), STUCK_REMINDER_STEPS_MS.length - 1)
    const step = STUCK_REMINDER_STEPS_MS[idx]
    if (now - st.announcedAt < step) continue
    st.announcedAt = now
    st.announcements += 1
    changed = true
    fire(
      `Агент стоит у сторожа кэша уже ${humanFor(now - st.since)}`,
      `сессия ${sid}${st.cwd ? ` (${st.cwd})` : ''}: ${st.reason};`
      + ` ход просит ${groupDigits(st.tokens)} токенов.`
      + ` Сама она выйти не может и БОЛЬШЕ НЕ ПЫТАЕТСЯ — молчание тут не признак здоровья.`
      + (pid === null
        ? ' Владелец не опознан, поэтому жив ли её процесс, проверить нечем — возможно, звать уже некого.'
        : '')
      + ` Разрешить: context cache-rewrite-ok ${sid} --until-consumed`
      + ` — либо перезапустить её, если работа уже неактуальна.`,
    )
    // И туда же, где человек читает. Напоминание в журнал он может не увидеть
    // вовсе — ровно та немота, ради которой напоминания и заведены.
    knock(sid, st, now)
  }
  if (changed) saveStuck()
}

/** Снятие с учёта — в журнал, но НЕ всплывашкой: «перестал стоять» это не
 *  тревога, а бухгалтерия. Без следа же выходит прежняя болезнь наизнанку —
 *  замолчало, и объяснить это некому. */
function retired(sid: string, st: StuckSession, now: number, why: string): void {
  fire(
    'Стоящая сессия снята с учёта',
    `сессия ${sid}: ${why}. Простояла ${humanFor(now - st.since)},`
    + ` напоминаний сделано ${st.announcements}.`,
    true,
  )
}

/**
 * Стоит ли эта сессия у сторожа кэша прямо сейчас, и сколько уже стоит.
 *
 * 🔴 ЗАЧЕМ ЭТО СНАРУЖИ, 11.09.2026. Владелец роутера побудок спросил: умеет ли
 * дверь согласия отличить НЕЗНАКОМУЮ сессию от знакомой? Не умела — писала
 * согласие любому набору знаков и отвечала «ок». Значит фаундер, нажавший
 * кнопку на карточке с опечаткой в номере, увидел бы «разрешено», а разрешение
 * легло бы в пустоту, и он ждал бы агента, которому ничего не разрешили.
 *
 * Отказывать при этом НЕЛЬЗЯ: человек у терминала законно разрешает сессию,
 * которую служба не видела с последнего перезапуска. Поэтому дверь пишет
 * согласие ВСЕГДА, но НАЗЫВАЕТ, что она знает о сессии, — и решение, показывать
 * ли это человеку, остаётся тому, кто рисует карточку.
 */
export function stuckSessionState(sessionId: string, now: number = Date.now()):
  { stuck: boolean; stuckForSec: number | null } {
  const st = stuck.get(sessionId)
  if (!st) return { stuck: false, stuckForSec: null }
  return { stuck: true, stuckForSec: Math.max(0, Math.round((now - st.since) / 1000)) }
}

/**
 * ЧТО МЫ ЗНАЕМ О СТОЯЩЕЙ СЕССИИ — целиком и НИЧЕГО не меняя.
 *
 * 🔴 ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, 19.09.2026. Владелец телеграм-службы принёс
 * случай фаундера: сессия соседа стояла у сторожа десять с половиной часов, а
 * во всех приборах числилась ЖИВОЙ И ЗАНЯТОЙ — каждый отбитый ход пишет в
 * стенограмму запись, а свежесть записей и есть то, по чему реестр судит о
 * жизни. Дословно фаундер: «Почему агент показывает статус, что работает… но
 * если он заблокирован, он не может ничего дёргать». Стук в стену неотличим от
 * работы для того, кто считает только частоту.
 *
 * Состояние у нас БЫЛО, наружу не выходило: спросить «стоит ли» можно было
 * только через `/admin/cache-rewrite-ok`, а та дверь ВЫДАЁТ СОГЛАСИЕ — то есть
 * вопрос был неотличим от разрешения. Отсюда правило этой функции и двери над
 * ней: она НИЧЕГО не пишет и ничего не разрешает.
 *
 * `null` — это «в учёте стоящих такой сессии нет», а не «всё хорошо»: сторож
 * запаса держит ходы ПО АККАУНТУ и в этот учёт не пишет вовсе. Полный ответ
 * человеку собирает дверь, складывая это с показанием запаса.
 */
export function stuckSessionReport(sessionId: string, now: number = Date.now()): StuckReport | null {
  const st = stuck.get(sessionId)
  if (!st) return null
  const pid = st.pid ?? null
  return {
    sessionId,
    stuck: true,
    guard: 'cache',
    stuckForSec: Math.max(0, Math.round((now - st.since) / 1000)),
    sinceAt: st.since,
    lastBlockAt: st.lastBlockAt,
    lastBlockAgoSec: Math.max(0, Math.round((now - st.lastBlockAt) / 1000)),
    announcements: st.announcements,
    reason: st.reason,
    tokens: st.tokens,
    // 🔴 `unknown` — «проверить нечем», а НЕ «наверное, жив». Рисующий карточку
    // обязан произнести это тем же словом, иначе вернётся ровно та беда, ради
    // которой дверь и открыта: догадка, поданная как замер.
    liveness: pid === null ? 'unknown' : (isAlive(pid) ? 'alive' : 'dead'),
    pid,
    cwd: st.cwd ?? null,
    idleMs: typeof st.idleMs === 'number' ? st.idleMs : null,
    spendKind: st.spendKind ?? null,
    // Совет — только когда есть чем его обосновать (срок мёртвого кэша), тем же
    // правилом, что и в карточке: выдуманный совет хуже отсутствующего.
    advice: typeof st.idleMs === 'number' && st.idleMs >= 0 ? adviceFor(st.spendKind, st.idleMs) : null,
  }
}

/** Все стоящие разом — тому, кто рисует состояние ФЛОТА и не знает заранее,
 *  чьё имя спрашивать. Тот же отчёт, что и по одной, без единой записи. */
export function stuckSessionsAll(now: number = Date.now()): StuckReport[] {
  return [...stuck.keys()]
    .map(sid => stuckSessionReport(sid, now))
    .filter((r): r is StuckReport => r !== null)
    .sort((a, b) => b.stuckForSec - a.stuckForSec)
}

/**
 * Снять сессию с учёта стоящих по решению ЧЕЛОВЕКА.
 *
 * 🔴 ЗАЧЕМ ЭТА ДВЕРЬ ЕСТЬ. Учёт умеет снимать сам — по мёртвому процессу и по
 * потолку в двое суток, — но не умел принять «этой сессии не существует,
 * убери». Замер 11.09.2026: в живом учёте висела aaf2acbd — 190 часов, 18
 * напоминаний человеку, процесса за ней нет вовсе, а снять было нечем: ждать
 * сутки до потолка или править боевой файл машины руками. Правка руками —
 * ровно то, чем эта смена уже обожглась в тот же день.
 *
 * Цена пробела не в мусоре, а в доверии: тревога зовёт человека разрешить
 * сессию, которой нет; нажатие уходит впустую; человек перестаёт читать
 * карточки — ломается то, ради чего вся цепь строилась.
 *
 * Отвечает РАЗЛИЧИМО: «убрал» и «нечего было убирать» — разные исходы, и
 * рисующий карточку обязан их различать.
 */
export function dropStuck(sessionId: string, now: number = Date.now()):
  { dropped: boolean; wasStuck: boolean; stuckForSec: number | null } {
  const st = stuck.get(sessionId)
  if (!st) return { dropped: false, wasStuck: false, stuckForSec: null }
  const stuckForSec = Math.max(0, Math.round((now - st.since) / 1000))
  stuck.delete(sessionId)
  saveStuck()
  return { dropped: true, wasStuck: true, stuckForSec }
}

/** Испытательный шов: прогнать обход в названный момент и посмотреть состояние. */
export const _stuckState = {
  sweep: (now: number) => sweepStuck(now),
  get: (sid: string) => stuck.get(sid),
  put: (sid: string, v: StuckSession) => { stuck.set(sid, v) },
  size: () => stuck.size,
  clear: () => { stuck.clear() },
}

function humanFor(ms: number): string {
  const min = ms / 60_000
  if (min < 90) return `${Math.round(min)} мин`
  const h = min / 60
  if (h < 36) return `${h.toFixed(1)} ч`
  return `${(h / 24).toFixed(1)} суток`
}

/**
 * Subscribe the alert path to the events worth waking a human for. Returns a
 * stop function (tests and shutdown use it).
 */
/**
 * @param resolveOwner — кто владеет этой сессией прямо сейчас: номер процесса и
 * его рабочий каталог. Передаётся снаружи (из server.ts, где живёт трекер), а не
 * берётся отсюда: тревога не должна знать устройство трекера, ей нужны два факта
 * — по номеру процесса она судит о жизни, а каталогом называет человеку ПРОЕКТ,
 * в котором агент стоит. Оба ложатся на диск и переживают перезапуск службы.
 */
export function startLocalAlert(
  resolveOwner?: (sessionId: string) => StuckOwner,
  opts?: { statePath?: string },
): () => void {
  BLOCKED_STATE_JSON = opts?.statePath ?? defaultBlockedStatePath()
  const offBegan = bus.onKind('UPSTREAM_STORM_BEGAN' as never, (e: any) => {
    const b = e?.breakdown ?? {}
    fire(
      'Anthropic отказывает — буря',
      `${e?.refusals ?? '?'} отказов за ${e?.windowSec ?? '?'} с у ${e?.sessions ?? '?'} сессий`
      + ` (real ${b.real ?? 0}, keepalive ${b.ka ?? 0}). Началось ${e?.since ?? '?'}.`,
    )
  })
  const offEnded = bus.onKind('UPSTREAM_STORM_ENDED' as never, (e: any) =>
    fire('Буря кончилась', `длилась ${e?.durationSec ?? '?'} с, всего ${e?.refusals ?? '?'} отказов`))
  const offStuck = bus.onKind('SESSION_STUCK' as never, (e: any) =>
    fire(
      'Агент стоит мёртвым',
      `сессия ${String(e?.sessionId ?? '?').slice(0, 8)}: ${e?.consecutiveFailures ?? '?'} отказов подряд`
      + ` за ${e?.stuckForSec ?? '?'} с, последний ${e?.lastStatus ?? '?'}. Ни одного успеха между ними.`,
    ))
  // 🔴 СЕССИЯ, ОСТАНОВЛЕННАЯ СТОРОЖЕМ, САМА ПОЗВАТЬ НЕ МОЖЕТ — И В ЭТОМ ВСЁ ДЕЛО.
  //
  // Отказ сторожа уходит как HTTP 400 ДО того, как ход дойдёт до модели. Значит
  // заблокированный агент физически не способен выполнить команду согласия,
  // которую сторож ему же и называет: её набирает человек. У сессии, поднятой
  // побудкой (письмо, крон, вотчер), человека рядом нет по определению.
  //
  // Замерено 28.08.2026 за трое суток: 71 отказ у 10 сессий, и 9 сессий из 10
  // после последнего отказа не сделали ни одного успешного запроса. То есть
  // сторож не тормозил ход, он заканчивал смену — молча, потому что
  // SESSION_STUCK его блок не видит (тот считает только отказы с числовым
  // статусом из REAL_REQUEST_ERROR, а здесь такого события нет вовсе).
  //
  // Отсюда порог по СЕРИИ, а не по одиночному отказу, и окно тишины на сессию.
  const offRewrite = bus.onKind('CACHE_REWRITE_BLOCKED', (e: any) => {
    const streak = Number(e?.consecutiveBlocks ?? 0)
    if (!Number.isFinite(streak) || streak < REWRITE_ALERT_MIN_STREAK) return
    const sid = String(e?.sessionId ?? '')
    if (!sid) return
    const now = Date.now()
    const announced = rewriteAnnouncedAt.get(sid)
    if (announced !== undefined && now - announced < REWRITE_ALERT_COOLDOWN_MS) return
    rewriteAnnouncedAt.set(sid, now)
    const tokens = Number(e?.predictedTokens ?? 0)
    // Запомнить СОСТОЯНИЕ: с этой минуты сессия считается стоящей, пока не
    // сделает успешный ход или пока не умрёт её процесс.
    {
      const prev = stuck.get(sid)
      // Владельца спрашиваем КАЖДЫЙ раз, а не только при первом отказе: после
      // перезапуска агента у той же сессии он другой, а старый — покойник, по
      // которому обход снял бы с учёта живого.
      let pid: number | null = prev?.pid ?? null
      let cwd: string | null = prev?.cwd ?? null
      try {
        const owner = resolveOwner?.(sid)
        if (owner) { pid = owner.pid ?? pid; cwd = owner.cwd ?? cwd }
      } catch { /* опознание не должно ронять тревогу */ }
      stuck.set(sid, {
        since: prev?.since ?? now,
        lastBlockAt: now,
        announcedAt: now,
        announcements: (prev?.announcements ?? 0) + 1,
        reason: rewriteReason(e?.rewriteClass, e?.spendKind),
        tokens: Number.isFinite(tokens) ? tokens : 0,
        idleMs: Number.isFinite(Number(e?.idleMs)) ? Number(e.idleMs) : null,
        spendKind: typeof e?.spendKind === 'string' ? e.spendKind : null,
        pid,
        cwd,
      })
      saveStuck()
    }
    fire(
      'Агент стоит у сторожа кэша и ждёт согласия',
      `сессия ${sid}${stuck.get(sid)?.cwd ? ` (${stuck.get(sid)!.cwd})` : ''}:`
      + ` ${streak} хода подряд отказано, ${rewriteReason(e?.rewriteClass, e?.spendKind)};`
      + ` ход просит ${groupDigits(Number.isFinite(tokens) ? tokens : 0)} токенов.`
      + ` Сама она этого сделать не может — ход не доходит до модели.`
      + ` Разрешить: context cache-rewrite-ok ${sid}`,
    )
    // 🔴 И ТУТ ЖЕ — ЧЕЛОВЕКУ. Это и есть то, ради чего вся цепь: агент позвать
    // не может (хода нет), журнал и рабочий стол ночью не читает никто, а
    // карточка приходит туда, где фаундер есть.
    const st = stuck.get(sid)
    if (st) knock(sid, st, now)
  })
  // Запас окна кончился, и сторож остановил настоящие ходы, чтобы прогрев
  // дожил до сброса. Человеку это надо сказать ОДИН раз на аккаунт и сказать
  // ГЛАВНОЕ: ждать осталось столько-то, а кэш при этом жив — иначе он решит,
  // что флот сломался, и пойдёт всех перезапускать, то есть сделает ровно ту
  // перезапись, которую сторож и бережёт. (Замер 03.09.2026: восемь живых
  // сессий, ~3.4 млн токенов перезаписи, ни одной по чьему-либо решению.)
  const offQuota = bus.onKind('QUOTA_GUARD_BLOCKED' as never, (e: any) => {
    const org = String(e?.orgId ?? 'unknown')
    const now = Date.now()
    const announced = quotaAnnouncedAt.get(org)
    if (announced !== undefined && now - announced < QUOTA_ALERT_COOLDOWN_MS) return
    quotaAnnouncedAt.set(org, now)
    const pct = Math.round(Number(e?.util5h ?? 0) * 100)
    const resetIn = Number(e?.resetInSec ?? 0)
    const waitMin = Number.isFinite(resetIn) && resetIn > 0 ? Math.ceil(resetIn / 60) : null
    const resetAt = Number(e?.resetAt ?? 0)
    const resetClock = resetAt > 0
      ? new Date(resetAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : null
    fire(
      'Запас окна на исходе — настоящие ходы остановлены, прогрев идёт',
      `аккаунт ${org.slice(0, 8)}: пятичасовое окно израсходовано на ${pct}%.`
      + ` Настоящие ходы отбиваются, чтобы аккаунт не упёрся в отказ самого Anthropic —`
      + ` тот закрывает и прогрев, и тогда кэши всех сессий умирают по часам,`
      + ` а каждая после сброса покупает свой контекст заново.`
      + (resetClock ? ` Запас вернётся в ${resetClock}` : '')
      + (waitMin !== null ? ` (через ${waitMin} мин)` : '')
      + '. Кэши при этом ЖИВЫ: после сброса сессии продолжат с чтения, а не с перезаписи.'
      + ' Продавить один ход: POST /admin/quota-ok {"sessionId":"<номер>"} на порт прокси.',
    )
  })
  // Сессия ПОШЛА — снять с учёта. Именно успешный ход, а не новая попытка:
  // попытка, которую снова отбили, состояния не меняет.
  const offWent = bus.onKind('REAL_REQUEST_COMPLETE' as never, (e: any) => {
    const sid = String(e?.sessionId ?? '')
    if (sid && stuck.delete(sid)) saveStuck()
  })
  // Процесса больше нет — напоминать о покойнике незачем, это ровно тот шум,
  // из-за которого уведомления в конце концов выключают.
  const offDead = bus.onKind('SESSION_DEAD' as never, (e: any) => {
    const sid = String(e?.sessionId ?? '')
    if (sid && stuck.delete(sid)) saveStuck()
  })
  // Обход по состоянию: кто стоит и достаточно ли давно молчали о нём.
  loadStuck()
  const sweep = setInterval(() => sweepStuck(Date.now()), STUCK_SWEEP_INTERVAL_MS)
  sweep.unref?.()

  // Прокси, который работает и ничего не греет, — это установленный и
  // бесполезный продукт. Соседи нашли это у себя САМИ, спустя недели, потому
  // что событие было, а голоса у него не было. См. identity-watch.ts.
  const offWarmsNothing = bus.onKind('PROXY_WARMS_NOTHING' as never, (e: any) =>
    fire(
      'Прокси работает, но не греет ничего',
      `за ${e?.windowMin ?? '?'} мин ${Math.round((e?.unidentifiedShare ?? 0) * 100)}% запросов пришли без имени сессии`
      + ` (всего ${e?.requests ?? '?'}), вооружённых сессий нет.`
      + ' Клиент должен слать заголовок x-claude-code-session-id с устойчивым id разговора —'
      + ' иначе каждый ход покупает тёплый кэш заново.',
    ))
  return () => {
    try { offWarmsNothing?.() } catch { /* already off */ }
    try { offQuota?.() } catch { /* already off */ }
    try { offWent?.() } catch { /* already off */ }
    try { offDead?.() } catch { /* already off */ }
    try { clearInterval(sweep) } catch { /* already stopped */ }
    try { offBegan?.() } catch { /* already off */ }
    try { offEnded?.() } catch { /* already off */ }
    try { offStuck?.() } catch { /* already off */ }
    try { offRewrite?.() } catch { /* already off */ }
    // Перезапуск наблюдателя не должен молча съесть первую тревогу.
    rewriteAnnouncedAt.clear()
    quotaAnnouncedAt.clear()
  }
}
