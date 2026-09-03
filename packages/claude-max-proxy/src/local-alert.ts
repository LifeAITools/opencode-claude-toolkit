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
 * 🔴 WHAT THIS IS NOT. It is not a route to Telegram, where the founder
 * actually reads. That door belongs to the telegram surface and is asked for,
 * not taken. This is the floor under that conversation, so the alerts stop
 * being lost while it happens.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bus } from './event-bus.js'

/** Whether to deliver at all — off in tests, and a way out if it ever annoys. */
const enabled = () => process.env.PROXY_LOCAL_ALERT !== '0'

/**
 * Test seam. Delivery goes out through two OS doors (journal + desktop), and a
 * test cannot read either of them without spawning processes on the machine
 * running the suite. Override to capture instead; `null` restores the real
 * doors. Same underscore idiom as storm-watch's `_stormState`.
 */
let delivery: ((subject: string, body: string) => void) | null = null
export function _setAlertDelivery(fn: ((subject: string, body: string) => void) | null): void {
  delivery = fn
}

/** Never let a notifier hold the service open or crash it. */
function fire(subject: string, body: string): void {
  if (!enabled()) return
  if (delivery) { try { delivery(subject, body) } catch { /* a sink must not break the path */ } return }
  const line = `${subject} — ${body}`
  try {
    // Durable half: the system journal. `logger` is in coreutils-adjacent
    // util-linux and present on every machine this runs on.
    Bun.spawn(['logger', '-p', 'user.warning', '-t', 'claude-max-proxy', line], {
      stdout: 'ignore', stderr: 'ignore',
    }).unref()
  } catch { /* a missing logger must not matter */ }
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
const BLOCKED_STATE_JSON = process.env.PROXY_BLOCKED_STATE_PATH
  || join(homedir(), '.claude-local', 'blocked-sessions.json')
/** Шаг напоминаний: чем дольше стоит, тем реже — но никогда не молча. */
const STUCK_REMINDER_STEPS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]
const STUCK_SWEEP_INTERVAL_MS = 10 * 60_000
interface StuckSession {
  since: number          // когда отказали в первый раз
  lastBlockAt: number    // последний отказ
  announcedAt: number    // когда в последний раз напоминали
  announcements: number
  reason: string
  tokens: number
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
    const dir = join(homedir(), '.claude-local')
    try { mkdirSync(dir, { recursive: true }) } catch { /* уже есть */ }
    writeFileSync(BLOCKED_STATE_JSON, JSON.stringify(Object.fromEntries(stuck)), 'utf8')
  } catch { /* учёт не должен ронять службу */ }
}
/** «6,7 суток» / «9,1 ч» / «22 мин» — человеку нужен срок, а не отметка времени. */
/** Один проход по стоящим. Время — АРГУМЕНТ: обход, читающий часы сам, в тесте
 *  можно только ждать, а шаг напоминания здесь измеряется сутками. */
function sweepStuck(now: number): void {
  let changed = false
  for (const [sid, st] of stuck) {
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
      `сессия ${sid}: ${st.reason}; ход просит ${groupDigits(st.tokens)} токенов.`
      + ` Сама она выйти не может и БОЛЬШЕ НЕ ПЫТАЕТСЯ — молчание тут не признак здоровья.`
      + ` Разрешить: context cache-rewrite-ok ${sid} --until-consumed`
      + ` — либо перезапустить её, если работа уже неактуальна.`,
    )
  }
  if (changed) saveStuck()
}

/** Испытательный шов: прогнать обход в названный момент и посмотреть состояние. */
export const _stuckState = {
  sweep: (now: number) => sweepStuck(now),
  get: (sid: string) => stuck.get(sid),
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
export function startLocalAlert(): () => void {
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
      stuck.set(sid, {
        since: prev?.since ?? now,
        lastBlockAt: now,
        announcedAt: now,
        announcements: (prev?.announcements ?? 0) + 1,
        reason: rewriteReason(e?.rewriteClass, e?.spendKind),
        tokens: Number.isFinite(tokens) ? tokens : 0,
      })
      saveStuck()
    }
    fire(
      'Агент стоит у сторожа кэша и ждёт согласия',
      `сессия ${sid}: ${streak} хода подряд отказано, ${rewriteReason(e?.rewriteClass, e?.spendKind)};`
      + ` ход просит ${groupDigits(Number.isFinite(tokens) ? tokens : 0)} токенов.`
      + ` Сама она этого сделать не может — ход не доходит до модели.`
      + ` Разрешить: context cache-rewrite-ok ${sid}`,
    )
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
