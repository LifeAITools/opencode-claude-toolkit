/**
 * heartbeat — plugin-side lastSeen writer.
 *
 * Every 30 seconds, updates the `lastSeen` field of THIS process's
 * discovery file. wake-router's registry uses this push-based signal
 * (with a 90s threshold = 3× heartbeat interval) to detect liveness
 * without expensive HTTP /health pings on every observed agent.
 *
 * Failure modes:
 *   - Discovery file missing (cleanup race, manual rm): logged at debug,
 *     loop continues. On next heartbeat, if still missing, we give up
 *     after 5 consecutive failures and stop the interval.
 *   - JSON parse error: logged at error, skip this tick.
 *   - Write error (disk full, permission): logged at error, skip this tick.
 *
 * Lifecycle: startHeartbeat() returns a handle with .stop(). Caller must
 * invoke .stop() in process cleanup paths (SIGTERM/SIGINT/exit) to clear
 * the interval. (The interval ALREADY survives a missing-file gracefully,
 * so failing to stop just keeps the loop running uselessly until process
 * exit — not catastrophic.)
 *
 * Atomic write: tmp file + rename, like all other discovery writes.
 *
 * Conformance: REQ-29, US-07, CR-06.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'

export interface HeartbeatHandle {
  /** Stop the interval. Safe to call multiple times. */
  stop(): void
  /** Number of successful heartbeats since start. */
  beats: () => number
  /** Number of consecutive failures (resets on success). */
  consecutiveFailures: () => number
}

const DEFAULT_INTERVAL_MS = 30_000  // 30 seconds — must be < 1/3 of registry threshold (90s)
const MAX_CONSECUTIVE_FAILURES = 5  // After 5 failures in a row, give up

export function startHeartbeat(
  getDiscoveryPath: () => string | null,
  opts: {
    intervalMs?: number
    onError?: (msg: string) => void
    onSkipped?: (msg: string) => void
  } = {},
): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const onError = opts.onError ?? ((m) => console.error(`[heartbeat] ${m}`))
  const onSkipped = opts.onSkipped ?? (() => { /* silent by default */ })

  let beats = 0
  let failures = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = (): void => {
    if (stopped) return

    const path = getDiscoveryPath()
    if (!path) {
      // No discovery file yet (plugin still booting). Skip silently.
      onSkipped('no discovery path yet')
      return
    }

    try {
      const raw = readFileSync(path, 'utf-8')
      const disc = JSON.parse(raw)
      disc.lastSeen = new Date().toISOString()

      // Atomic write
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(disc))
      renameSync(tmp, path)

      beats += 1
      failures = 0  // reset on success
    } catch (e: any) {
      failures += 1
      const code = e?.code ?? ''
      if (code === 'ENOENT') {
        // File was removed (probably reaper or manual cleanup). Skip; next
        // tick will probably succeed if plugin re-creates it.
        onSkipped(`discovery file not found at ${path}`)
      } else {
        onError(`heartbeat write failed (consecutive: ${failures}/${MAX_CONSECUTIVE_FAILURES}): ${e?.message ?? String(e)}`)
      }

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        onError(`heartbeat stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`)
        stop()
      }
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // Start the loop. First tick immediately to verify write capability, then
  // every intervalMs. We don't await the first tick — it's best-effort.
  tick()
  timer = setInterval(tick, intervalMs)

  return {
    stop,
    beats: () => beats,
    consecutiveFailures: () => failures,
  }
}
