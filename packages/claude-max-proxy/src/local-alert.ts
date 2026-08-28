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
    fire(
      'Агент стоит у сторожа кэша и ждёт согласия',
      `сессия ${sid}: ${streak} хода подряд отказано, ${rewriteReason(e?.rewriteClass, e?.spendKind)};`
      + ` ход просит ${groupDigits(Number.isFinite(tokens) ? tokens : 0)} токенов.`
      + ` Сама она этого сделать не может — ход не доходит до модели.`
      + ` Разрешить: context cache-rewrite-ok ${sid}`,
    )
  })
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
    try { offBegan?.() } catch { /* already off */ }
    try { offEnded?.() } catch { /* already off */ }
    try { offStuck?.() } catch { /* already off */ }
    try { offRewrite?.() } catch { /* already off */ }
    // Перезапуск наблюдателя не должен молча съесть первую тревогу.
    rewriteAnnouncedAt.clear()
  }
}
