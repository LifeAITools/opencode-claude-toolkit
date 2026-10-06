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
 * Size cap:  CLAUDE_MAX_PROXY_CAPTURE_MAX_MB (default: 500; 0 = TTL only).
 * Dir override: CLAUDE_MAX_PROXY_CAPTURE_DIR (default: ~/.claude-local/proxy-body-dumps).
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFile } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Читаются лениво (на каждый вызов), а не константами при импорте: иначе первый
// импорт в процессе фиксирует каталог навсегда, и испытания не могут подменить
// его временным (замер 06.10: файл теста падал только в полном прогоне, когда
// body-capture уже импортировал чужой файл). В проде env неподвижен с подъёма,
// поведение то же.
function captureEnabled(): boolean {
  return process.env.CLAUDE_MAX_PROXY_CAPTURE_BODIES !== '0'
}
function captureDir(): string {
  return process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
    ?? join(homedir(), '.claude-local', 'proxy-body-dumps')
}
const CAPTURE_TTL_HOURS = Number(process.env.CLAUDE_MAX_PROXY_CAPTURE_TTL_HOURS ?? '48')
// Hard disk cap (MB). After the TTL pass, if the dir still exceeds this, oldest
// files are deleted until it fits. Guards against full-body 1M-context traffic
// blowing past the 48h TTL window (observed 2.1GB/8h → ~10GB before TTL kicks).
// 0 = no size cap (TTL only). Default: 500 MB.
const CAPTURE_MAX_MB = Number(process.env.CLAUDE_MAX_PROXY_CAPTURE_MAX_MB ?? '500')

const _ensuredDirs = new Set<string>()
function ensureDir(dir: string): void {
  if (_ensuredDirs.has(dir)) return
  try { mkdirSync(dir, { recursive: true }); _ensuredDirs.add(dir) } catch {}
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
  if (!captureEnabled()) return
  const dir = captureDir()
  ensureDir(dir)
  const turn = ++_turnCounter
  const ts = Date.now()
  const portTag = meta.srcPort ?? 'no-port'
  const base = `proxy-${portTag}-${String(turn).padStart(4, '0')}-${ts}`

  // Body: raw bytes (the same JSON CC sends to Anthropic).
  const bodyPath = join(dir, `${base}.json`)
  writeFile(bodyPath, Buffer.from(rawBody), () => { /* swallow */ })

  // Sidecar with headers + session attribution.
  const metaPath = join(dir, `${base}.meta.json`)
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
  if (!captureEnabled()) return () => {}
  ensureDir(captureDir())
  const sweepIntervalMs = 30 * 60 * 1000
  const ttlMs = CAPTURE_TTL_HOURS * 60 * 60 * 1000

  const capBytes = CAPTURE_MAX_MB > 0 ? CAPTURE_MAX_MB * 1024 * 1024 : 0

  const sweep = (): void => {
    const dir = captureDir()
    try {
      const cutoff = Date.now() - ttlMs
      const entries = readdirSync(dir)
      let ttlDeleted = 0
      // Survivors after the TTL pass, with size+age for a possible size-cap pass.
      const survivors: { full: string; size: number; mtimeMs: number }[] = []
      for (const name of entries) {
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (st.mtimeMs < cutoff) {
            unlinkSync(full)
            ttlDeleted++
          } else {
            survivors.push({ full, size: st.size, mtimeMs: st.mtimeMs })
          }
        } catch { /* skip */ }
      }

      // Size-cap pass: if survivors still exceed the cap, delete oldest-first
      // until under it. Body + its .meta.json share a timestamp prefix so they
      // rotate together naturally (oldest mtime wins regardless of suffix).
      let capDeleted = 0
      if (capBytes > 0) {
        let total = 0
        for (const f of survivors) total += f.size
        if (total > capBytes) {
          survivors.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
          for (const f of survivors) {
            if (total <= capBytes) break
            try { unlinkSync(f.full); total -= f.size; capDeleted++ } catch { /* skip */ }
          }
        }
      }

      // Logging via console for now — proxy emit() lives elsewhere.
      if (ttlDeleted > 0 || capDeleted > 0) {
        console.log(`[body-capture] sweep: ttlDeleted=${ttlDeleted} capDeleted=${capDeleted} `
          + `kept=${survivors.length - capDeleted} ttl=${CAPTURE_TTL_HOURS}h cap=${CAPTURE_MAX_MB}MB dir=${dir}`)
      }
    } catch { /* swallow */ }
  }

  // Sweep once on boot to clean any leftovers, then periodic.
  sweep()
  const timer = setInterval(sweep, sweepIntervalMs)
  return () => clearInterval(timer)
}

/** Снимок настроек на момент вызова (для /health и отладки). */
export function captureInfo(): { enabled: boolean; ttlHours: number; maxMb: number; dir: string } {
  return {
    enabled: captureEnabled(),
    ttlHours: CAPTURE_TTL_HOURS,
    maxMb: CAPTURE_MAX_MB,
    dir: captureDir(),
  }
}
