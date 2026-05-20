/**
 * body-capture — empirical request body dumper for native CC traffic.
 *
 * Mirrors opencode-claude's body-dump infrastructure (CLAUDE_DUMP_BODIES_FULL)
 * but inside claude-max-proxy so native Claude Code traffic is captured too.
 *
 * Why this exists:
 *   We need byte-level evidence of what native CC actually sends on the wire
 *   (cache_control shape, scope field presence, beta combos, system layout).
 *   Binary reverse-engineering tells us what code paths EXIST in the bundle;
 *   only empirical wire capture tells us what code paths actually FIRE.
 *
 * Operational discipline:
 *   - Fire-and-forget I/O: writeFile errors are swallowed; capture must never
 *     block the request forwarding hot path or affect throughput.
 *   - Rolling TTL cleanup: files older than CAPTURE_TTL_HOURS are deleted on
 *     a slow background timer (every 30min). Keeps disk bounded.
 *   - Source attribution: filename embeds peer-port + ts so we can later
 *     trace dumps back to the native CC PID via session-tracker.
 *
 * Disable: set CLAUDE_MAX_PROXY_CAPTURE_BODIES=0 (default: ON).
 * TTL override: CLAUDE_MAX_PROXY_CAPTURE_TTL_HOURS (default: 48).
 * Dir override: CLAUDE_MAX_PROXY_CAPTURE_DIR (default: ~/.claude-local/proxy-body-dumps).
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFile } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CAPTURE_ENABLED = process.env.CLAUDE_MAX_PROXY_CAPTURE_BODIES !== '0'
const CAPTURE_TTL_HOURS = Number(process.env.CLAUDE_MAX_PROXY_CAPTURE_TTL_HOURS ?? '48')
const CAPTURE_DIR = process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
  ?? join(homedir(), '.claude-local', 'proxy-body-dumps')

let _ensured = false
function ensureDir(): void {
  if (_ensured) return
  try { mkdirSync(CAPTURE_DIR, { recursive: true }); _ensured = true } catch {}
}

let _turnCounter = 0

/**
 * Dump a request body. Non-blocking, errors swallowed.
 *
 * Filename: `proxy-<peerPort>-<turn>-<unixMs>.json`
 * Sidecar:  `proxy-<peerPort>-<turn>-<unixMs>.meta.json` with headers + session metadata.
 */
export function captureBody(
  rawBody: ArrayBuffer,
  headers: Record<string, string>,
  meta: { sessionId: string; sourcePid: number | null; srcPort: number | null },
): void {
  if (!CAPTURE_ENABLED) return
  ensureDir()
  const turn = ++_turnCounter
  const ts = Date.now()
  const portTag = meta.srcPort ?? 'no-port'
  const base = `proxy-${portTag}-${String(turn).padStart(4, '0')}-${ts}`

  // Body: raw bytes (the same JSON CC sends to Anthropic).
  const bodyPath = join(CAPTURE_DIR, `${base}.json`)
  writeFile(bodyPath, Buffer.from(rawBody), () => { /* swallow */ })

  // Sidecar with headers + session attribution.
  const metaPath = join(CAPTURE_DIR, `${base}.meta.json`)
  const sidecar = {
    ts: new Date(ts).toISOString(),
    sessionId: meta.sessionId,
    sourcePid: meta.sourcePid,
    srcPort: meta.srcPort,
    headers: redactHeaders(headers),
    capturedBy: 'claude-max-proxy/body-capture',
  }
  writeFile(metaPath, JSON.stringify(sidecar, null, 2), () => { /* swallow */ })
}

/** Strip secret-bearing headers so dumps are shareable. Keeps beta/content-type/UA visible. */
function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase()
    if (lk === 'authorization' || lk === 'cookie' || lk === 'x-api-key') {
      out[k] = `<redacted:${v.length}b>`
    } else {
      out[k] = v
    }
  }
  return out
}

/** Periodic TTL sweep — deletes files older than CAPTURE_TTL_HOURS. Runs every 30min. */
export function startCaptureCleanup(): () => void {
  if (!CAPTURE_ENABLED) return () => {}
  ensureDir()
  const sweepIntervalMs = 30 * 60 * 1000
  const ttlMs = CAPTURE_TTL_HOURS * 60 * 60 * 1000

  const sweep = (): void => {
    try {
      const cutoff = Date.now() - ttlMs
      const entries = readdirSync(CAPTURE_DIR)
      let deleted = 0
      let kept = 0
      for (const name of entries) {
        const full = join(CAPTURE_DIR, name)
        try {
          const st = statSync(full)
          if (st.mtimeMs < cutoff) {
            unlinkSync(full)
            deleted++
          } else {
            kept++
          }
        } catch { /* skip */ }
      }
      // Logging via console for now — proxy emit() lives elsewhere.
      if (deleted > 0) {
        console.log(`[body-capture] TTL sweep: deleted=${deleted} kept=${kept} ttl=${CAPTURE_TTL_HOURS}h dir=${CAPTURE_DIR}`)
      }
    } catch { /* swallow */ }
  }

  // Sweep once on boot to clean any leftovers, then periodic.
  sweep()
  const timer = setInterval(sweep, sweepIntervalMs)
  return () => clearInterval(timer)
}

export const CAPTURE_INFO = {
  enabled: CAPTURE_ENABLED,
  ttlHours: CAPTURE_TTL_HOURS,
  dir: CAPTURE_DIR,
}
