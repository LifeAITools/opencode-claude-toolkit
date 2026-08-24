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

/** Never let a notifier hold the service open or crash it. */
function fire(subject: string, body: string): void {
  if (!enabled()) return
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
  return () => {
    try { offBegan?.() } catch { /* already off */ }
    try { offEnded?.() } catch { /* already off */ }
    try { offStuck?.() } catch { /* already off */ }
  }
}
