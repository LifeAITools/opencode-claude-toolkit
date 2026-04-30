import { appendFileSync as _traceWrite } from 'fs'
try { _traceWrite('/tmp/opencode-claude-trace.log', `PROVIDER.TS pid=${process.pid} cwd=${process.cwd()} ${new Date().toISOString()}\n`) } catch {}
/**
 * @life-ai-tools/claude-max-provider
 *
 * Vercel AI SDK v3 provider backed by ClaudeCodeSDK.
 * Implements LanguageModelV3 interface so opencode can use Claude Max/Pro
 * subscription directly — no proxy, no @ai-sdk/anthropic dependency.
 *
 * Usage in opencode plugin:
 *   config.provider['claude-max'].npm = '@life-ai-tools/claude-max-provider'
 *   // or via file:// path
 */

import { ClaudeCodeSDK, resolveMaxTokens, supportsAdaptiveThinking, loadKeepaliveConfig } from '@life-ai-tools/claude-code-sdk'
import type { GenerateOptions, StreamEvent } from '@life-ai-tools/claude-code-sdk'

import { appendFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
const DEBUG = process.env.CLAUDE_MAX_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'claude-max-debug.log')
const STATS_FILE = join(homedir(), '.claude', 'claude-max-stats.log')
const STATS_JSONL = join(homedir(), '.claude', 'claude-max-stats.jsonl')

const PID = process.pid
const SESSION = process.env.OPENCODE_SESSION_SLUG ?? process.env.OPENCODE_SESSION_ID?.slice(0, 12) ?? '?'

const MAX_MEMORY_LINES = 500
const MAX_MEMORY_BYTES = 50_000

function logStats(line: string, structured?: Record<string, unknown>) {
  try { appendFileSync(STATS_FILE, `${line} pid=${PID} ses=${SESSION}\n`) } catch {}
  if (structured) {
    try { appendFileSync(STATS_JSONL, JSON.stringify({ ts: new Date().toISOString(), pid: PID, ses: SESSION, ...structured }) + '\n') } catch {}
  }
}

function dbg(...args: any[]) {
  if (!DEBUG) return
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`) } catch {}
}

// ─── Types (subset of @ai-sdk/provider v3) ────────────────
// We inline these to avoid a dependency on @ai-sdk/provider

interface LanguageModelV3 {
  readonly specificationVersion: 'v3'
  readonly provider: string
  readonly modelId: string
  supportedUrls: Record<string, RegExp[]>
  doGenerate(options: any): Promise<any>
  doStream(options: any): Promise<any>
}

// ─── Image resize (matches Claude Code limits) ───────────
// Claude Code: 2000×2000 max, 3.75MB raw (5MB base64), resize with sharp/jimp
// We try jimp (pure JS, works in Bun) — lazy-loaded, no hard dependency.

// Anthropic vision model processes at 1568px max on long edge — anything larger
// gets server-side downscaled with no quality benefit. We resize client-side to
// match exactly, saving upload bandwidth and tokens while preserving full quality.
const IMAGE_MAX_LONG_EDGE = 1568
const IMAGE_TARGET_RAW_BYTES = 3.75 * 1024 * 1024   // 3.75 MB raw → ≤5 MB base64

// Anthropic vision API constraints (from API error messages observed in the wild):
// - supported formats: JPEG, PNG, GIF, WEBP (plus animated GIF but we don't try to resize those)
// - minimum dimensions ≥ 8×8 px (smaller → "Could not process image")
// - maximum base64 size 5 MB per image
// - must be a decodable image matching its claimed media_type
const IMAGE_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const IMAGE_MIN_DIMENSION = 8
const IMAGE_MIN_BASE64_BYTES = 32            // anything smaller can't be a real image header

// Magic-byte detection so we catch mislabeled images (e.g. PNG bytes with media_type=image/jpeg)
// and malformed/truncated data before shipping to the API.
function sniffImageMime(raw: Buffer): string | null {
  if (raw.length < 12) return null
  // JPEG: FF D8 FF
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return 'image/png'
  // GIF: 47 49 46 38 (GIF8)
  if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x38) return 'image/gif'
  // WEBP: 'RIFF'....'WEBP'
  if (raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 &&
      raw[8] === 0x57 && raw[9] === 0x45 && raw[10] === 0x42 && raw[11] === 0x50) return 'image/webp'
  // BMP: 42 4D
  if (raw[0] === 0x42 && raw[1] === 0x4d) return 'image/bmp'
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((raw[0] === 0x49 && raw[1] === 0x49 && raw[2] === 0x2a && raw[3] === 0x00) ||
      (raw[0] === 0x4d && raw[1] === 0x4d && raw[2] === 0x00 && raw[3] === 0x2a)) return 'image/tiff'
  return null
}

// Validate an inline image payload. Returns normalized data on success, or a failure
// reason the caller should surface as a text placeholder instead of an image block.
// Handles: empty/truncated payload, unsupported MIME, MIME/content mismatch,
// too-small dimensions, and transcoding BMP/TIFF → PNG via jimp if available.
export async function validateAndNormalizeImage(
  base64Data: string,
  claimedMediaType: string,
): Promise<
  | { ok: true; data: string; mediaType: string; reason?: string }
  | { ok: false; reason: string }
> {
  // 1. Basic string sanity
  if (!base64Data || typeof base64Data !== 'string') {
    return { ok: false, reason: 'empty or non-string image data' }
  }
  if (base64Data.length < IMAGE_MIN_BASE64_BYTES) {
    return { ok: false, reason: `image base64 too short (${base64Data.length} bytes, min ${IMAGE_MIN_BASE64_BYTES})` }
  }

  // 2. Base64 must actually decode
  let raw: Buffer
  try {
    raw = Buffer.from(base64Data, 'base64')
    // Detect "silent" base64 failures: invalid chars get dropped, yielding zero-length
    if (raw.length === 0) {
      return { ok: false, reason: 'base64 decoded to zero bytes (invalid encoding)' }
    }
    // If re-encoding doesn't match original length (ignoring padding), data was corrupted
    // We don't do full round-trip check (expensive) but catch grossly short decodes
    if (raw.length < 32) {
      return { ok: false, reason: `decoded image too small (${raw.length} bytes, likely truncated)` }
    }
  } catch (e: any) {
    return { ok: false, reason: `base64 decode failed: ${e.message}` }
  }

  // 3. Sniff actual format from magic bytes
  const sniffedMime = sniffImageMime(raw)
  if (!sniffedMime) {
    return { ok: false, reason: `unrecognized image format (first bytes: ${raw.slice(0, 8).toString('hex')})` }
  }

  // 4. MIME/content mismatch → trust the sniff, log the discrepancy
  let mediaType = claimedMediaType
  if (sniffedMime !== claimedMediaType && claimedMediaType !== 'image/*') {
    dbg(`image MIME mismatch: claimed=${claimedMediaType} actual=${sniffedMime} — using actual`)
    mediaType = sniffedMime
  } else if (claimedMediaType === 'image/*') {
    mediaType = sniffedMime
  }

  // 5. If format is not API-supported, transcode if jimp available, else reject
  if (!IMAGE_ALLOWED_MIME.has(mediaType)) {
    const jimpMod = getJimp()
    if (!jimpMod) {
      return { ok: false, reason: `unsupported image format ${mediaType} and no transcoder available (allowed: jpeg/png/gif/webp)` }
    }
    try {
      const { Jimp } = jimpMod
      const img = await Jimp.fromBuffer(raw)
      if (img.width < IMAGE_MIN_DIMENSION || img.height < IMAGE_MIN_DIMENSION) {
        return { ok: false, reason: `image too small ${img.width}×${img.height} (min ${IMAGE_MIN_DIMENSION}×${IMAGE_MIN_DIMENSION})` }
      }
      const outBuf = await img.getBuffer('image/png')
      dbg(`image transcoded ${mediaType} → image/png (${img.width}×${img.height}, ${(outBuf.length/1024).toFixed(0)}KB)`)
      return { ok: true, data: outBuf.toString('base64'), mediaType: 'image/png', reason: `transcoded from ${mediaType}` }
    } catch (e: any) {
      return { ok: false, reason: `failed to transcode ${mediaType}: ${e.message}` }
    }
  }

  // 6. For supported formats, verify decodability + minimum dimensions when possible
  const jimpMod = getJimp()
  if (jimpMod) {
    try {
      const { Jimp } = jimpMod
      const img = await Jimp.fromBuffer(raw)
      if (img.width < IMAGE_MIN_DIMENSION || img.height < IMAGE_MIN_DIMENSION) {
        return { ok: false, reason: `image too small ${img.width}×${img.height} (min ${IMAGE_MIN_DIMENSION}×${IMAGE_MIN_DIMENSION})` }
      }
    } catch (e: any) {
      // Decode failed → image is corrupt even though magic bytes looked right
      return { ok: false, reason: `image appears corrupted (${mediaType} decode failed: ${e.message})` }
    }
  }

  return { ok: true, data: base64Data, mediaType }
}

let _jimp: any = undefined
let _jimpChecked = false

function getJimp(): any {
  if (_jimpChecked) return _jimp
  _jimpChecked = true
  try {
    _jimp = require('jimp')
    dbg('Image resizer: jimp loaded')
  } catch {
    dbg('Image resizer: jimp not available — images will not be resized')
  }
  return _jimp
}

async function maybeResizeImage(
  base64Data: string,
  mediaType: string,
): Promise<{ data: string; mediaType: string; resized: boolean }> {
  const rawBytes = Buffer.from(base64Data, 'base64')
  const needsSizeReduction = rawBytes.length > IMAGE_TARGET_RAW_BYTES

  const jimpMod = getJimp()
  if (!jimpMod) {
    // No resize lib — pass through with warning if oversized
    if (needsSizeReduction) {
      dbg(`WARNING: image ${(rawBytes.length / 1024 / 1024).toFixed(1)}MB exceeds ${(IMAGE_TARGET_RAW_BYTES / 1024 / 1024).toFixed(1)}MB target but no resize lib available`)
    }
    return { data: base64Data, mediaType, resized: false }
  }

  try {
    const { Jimp } = jimpMod
    const img = await Jimp.fromBuffer(rawBytes)
    const w = img.width, h = img.height
    const longEdge = Math.max(w, h)
    let needsResize = longEdge > IMAGE_MAX_LONG_EDGE || needsSizeReduction

    if (!needsResize) {
      return { data: base64Data, mediaType, resized: false }
    }

    // Scale so long edge = 1568px (model's native max), preserving aspect ratio
    let scale = Math.min(IMAGE_MAX_LONG_EDGE / longEdge, 1)

    // If still too large after dimension cap, reduce further
    if (needsSizeReduction && scale === 1) {
      // Estimate: JPEG at ~0.5 bytes/pixel after resize
      const targetPixels = IMAGE_TARGET_RAW_BYTES / 0.5
      const currentPixels = w * h
      scale = Math.min(scale, Math.sqrt(targetPixels / currentPixels))
    }

    const nw = Math.max(1, Math.round(w * scale))
    const nh = Math.max(1, Math.round(h * scale))

    img.resize({ w: nw, h: nh })

    // Choose output format: keep PNG for screenshots/diagrams (sharp text, flat colors),
    // use JPEG for photos (smaller file, imperceptible quality loss).
    // Heuristic: PNG input = likely screenshot → keep PNG, try to fit within size limit.
    // If PNG is still too large after resize, fall back to JPEG.
    const isPng = mediaType === 'image/png'
    let outBuf: Buffer
    let outMediaType: string

    if (isPng) {
      outBuf = await img.getBuffer('image/png')
      outMediaType = 'image/png'
      // PNG too large after resize? Fall back to JPEG
      if (outBuf.length > IMAGE_TARGET_RAW_BYTES) {
        dbg(`PNG still ${(outBuf.length/1024).toFixed(0)}KB after resize, converting to JPEG`)
        outBuf = await img.getBuffer('image/jpeg')
        outMediaType = 'image/jpeg'
      }
    } else {
      outBuf = await img.getBuffer('image/jpeg')
      outMediaType = 'image/jpeg'
    }

    const outBase64 = outBuf.toString('base64')

    dbg(`Image resized: ${w}×${h} → ${nw}×${nh}, ${(rawBytes.length/1024).toFixed(0)}KB → ${(outBuf.length/1024).toFixed(0)}KB ${outMediaType}`)
    return { data: outBase64, mediaType: outMediaType, resized: true }
  } catch (e: any) {
    dbg('Image resize failed, using original:', e.message)
    return { data: base64Data, mediaType, resized: false }
  }
}

// ─── Context injection: CLAUDE.md + MEMORY.md ──────────────

function sanitizePathForProjects(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-')
}

let _gitRoot: string | null | undefined = undefined  // undefined = not cached yet
function getGitRoot(): string | null {
  if (_gitRoot !== undefined) return _gitRoot
  try {
    _gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    _gitRoot = null
  }
  return _gitRoot
}

const _fileCache = new Map<string, { content: string; mtimeMs: number }>()

function readCachedFile(filePath: string): string | null {
  try {
    const { statSync, readFileSync } = require('fs')
    const st = statSync(filePath)
    const cached = _fileCache.get(filePath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content
    const content = readFileSync(filePath, 'utf8')
    _fileCache.set(filePath, { content, mtimeMs: st.mtimeMs })
    return content
  } catch {
    return null
  }
}

function truncateMemory(raw: string): { text: string; truncated: boolean } {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const byteOver = trimmed.length > MAX_MEMORY_BYTES
  const lineOver = lines.length > MAX_MEMORY_LINES

  if (!byteOver && !lineOver) return { text: trimmed, truncated: false }

  let result = lineOver ? lines.slice(0, MAX_MEMORY_LINES).join('\n') : trimmed
  if (result.length > MAX_MEMORY_BYTES) {
    // Truncate at last newline before byte limit
    const cut = result.lastIndexOf('\n', MAX_MEMORY_BYTES)
    result = cut > 0 ? result.slice(0, cut) : result.slice(0, MAX_MEMORY_BYTES)
  }

  const reasons: string[] = []
  if (lineOver) reasons.push(`${lines.length} lines > ${MAX_MEMORY_LINES} limit`)
  if (byteOver) reasons.push(`${trimmed.length} bytes > ${MAX_MEMORY_BYTES} limit`)
  result += `\n\n<!-- TRUNCATED: ${reasons.join(', ')} -->`
  return { text: result, truncated: true }
}

// Frozen after first build — never re-read within the same process.
// Why: mid-session changes (agent writes MEMORY.md) would alter the system prompt,
// invalidating the entire Anthropic cache prefix (36K+ tokens). The agent already
// has any new knowledge in conversation history — re-injecting it into the prefix
// wastes cache and money. New sessions pick up fresh content on startup.
//
// Split into TWO blocks (added 2026-04-30):
//   1. STABLE  — CLAUDE.md (rarely-changing global/project rules) → goes FIRST in system
//   2. VOLATILE — MEMORY.md (agent-written, grows over time) → goes LAST in system
// Rationale: cache_control breakpoint sits on the LAST system block (sdk.ts:805).
// If MEMORY.md is at the end, only the small final segment invalidates when it grows;
// the large STABLE prefix (CLAUDE.md + opencode-system + tools) stays cached.
let _stableInjectionFrozen: string | null | undefined = undefined
let _volatileInjectionFrozen: string | null | undefined = undefined

interface InjectionParts {
  stable: string | null     // CLAUDE.md content — goes first in system
  volatile: string | null   // MEMORY.md content — goes last in system
}

export function buildContextInjectionParts(): InjectionParts {
  if (_stableInjectionFrozen !== undefined && _volatileInjectionFrozen !== undefined) {
    return { stable: _stableInjectionFrozen, volatile: _volatileInjectionFrozen }
  }

  const tInject = Date.now()
  const home = homedir()
  const cwd = process.cwd()
  const gitRoot = getGitRoot()
  const projectBase = gitRoot || cwd
  const sanitized = sanitizePathForProjects(projectBase)
  const memoryPath = join(home, '.claude', 'projects', sanitized, 'memory', 'MEMORY.md')

  // STABLE sources — CLAUDE.md files (global + project)
  const stableSources: { path: string; tag: string }[] = [
    { path: join(home, '.claude', 'CLAUDE.md'), tag: 'claude-rules' },
  ]
  if (cwd !== home) {
    stableSources.push({ path: join(cwd, 'CLAUDE.md'), tag: 'claude-rules' })
    const dotClaudePath = join(cwd, '.claude', 'CLAUDE.md')
    if (dotClaudePath !== join(home, '.claude', 'CLAUDE.md')) {
      stableSources.push({ path: dotClaudePath, tag: 'claude-rules' })
    }
  }

  const stableParts: string[] = []
  let claudeMdBytes = 0
  for (const src of stableSources) {
    const raw = readCachedFile(src.path)
    if (!raw || !raw.trim()) continue
    stableParts.push(`<${src.tag} source="${src.path}">\n${raw.trim()}\n</${src.tag}>`)
    claudeMdBytes += raw.trim().length
  }
  const stable = stableParts.length > 0 ? stableParts.join('\n\n') : null

  // VOLATILE source — MEMORY.md
  let volatile: string | null = null
  let memoryBytes = 0
  let memoryTruncated = false
  const memRaw = readCachedFile(memoryPath)
  if (memRaw && memRaw.trim()) {
    const { text, truncated } = truncateMemory(memRaw)
    volatile = `<project-memory source="${memoryPath}">\n${text}\n</project-memory>`
    memoryBytes = text.length
    memoryTruncated = truncated
  }

  const totalSources = stableParts.length + (volatile ? 1 : 0)
  const totalBytes = (stable?.length ?? 0) + (volatile?.length ?? 0)
  dbg(`context_inject: ${totalSources} sources, ${totalBytes} bytes (claude_md=${claudeMdBytes}, memory=${memoryBytes}${memoryTruncated ? ' TRUNCATED' : ''}) built in ${Date.now() - tInject}ms [FROZEN for session, split: stable+volatile]`)
  logStats(`[${new Date().toISOString()}] type=context_inject | sources=${totalSources} claude_md=${claudeMdBytes} memory=${memoryBytes} truncated=${memoryTruncated} buildMs=${Date.now() - tInject} split=true`, {
    type: 'context_inject', sources: totalSources, claudeMdBytes, memoryBytes, truncated: memoryTruncated, buildMs: Date.now() - tInject, split: true,
  })

  _stableInjectionFrozen = stable
  _volatileInjectionFrozen = volatile
  return { stable, volatile }
}

/**
 * Legacy helper: returns concatenated stable+volatile injection.
 * Used by callers that don't yet support the split. New code should use buildContextInjectionParts().
 * @deprecated Prefer buildContextInjectionParts() to keep MEMORY.md changes from invalidating the entire cache prefix.
 */
export function buildContextInjection(): string | null {
  const { stable, volatile } = buildContextInjectionParts()
  if (!stable && !volatile) return null
  return [stable, volatile].filter(Boolean).join('\n\n')
}

// ─── Prompt conversion: V3 → SDK ──────────────────────────

async function convertPrompt(prompt: any[]): Promise<{ system?: string; messages: any[] }> {
  const tConvert = Date.now()
  let system: string | undefined
  const messages: any[] = []

  // Debug: dump what opencode sends us
  for (const msg of prompt) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === 'reasoning') {
          dbg('PROMPT reasoning part:', {
            textLen: p.text?.length,
            hasProviderMetadata: !!p.providerMetadata,
            providerMetadataKeys: p.providerMetadata ? Object.keys(p.providerMetadata) : [],
            hasProviderOptions: !!p.providerOptions,
            providerOptionsKeys: p.providerOptions ? Object.keys(p.providerOptions) : [],
            fullPart: JSON.stringify(p).slice(0, 500),
          })
        }
      }
    }
  }

  for (const msg of prompt) {
    if (msg.role === 'system') {
      // MUST deep-copy — addCacheMarkers mutates message content in-place,
      // and opencode passes content arrays by reference. Without copy,
      // cache_control markers leak into opencode's internal state, causing
      // cache misses on session restart (content differs by baked-in markers).
      system = typeof msg.content === 'string' ? msg.content : JSON.parse(JSON.stringify(msg.content))
      // Strip opencode's billing header from system prompt — it contains a non-deterministic
      // version number (cc_version=0.1.0.XXX) that changes on every process restart,
      // invalidating the entire cache prefix. The LLM doesn't need this header.
      if (typeof system === 'string') {
        system = system.replace(/x-anthropic-billing-header:[^\n]*\n?/g, '').trim() || undefined
      } else if (Array.isArray(system)) {
        for (const block of system as { type: string; text?: string }[]) {
          if (block.type === 'text' && block.text) {
            block.text = block.text.replace(/x-anthropic-billing-header:[^\n]*\n?/g, '').trim()
          }
        }
        // Remove empty text blocks
        system = (system as { type: string; text?: string }[]).filter(b => b.type !== 'text' || (b.text && b.text.length > 0))
        if ((system as unknown[]).length === 0) system = undefined
      }
      // Inject CLAUDE.md (stable) and MEMORY.md (volatile) into system prompt.
      //
      // Layout (added 2026-04-30 for cache prefix stability):
      //   [STABLE: CLAUDE.md] + [opencode system content] + [VOLATILE: MEMORY.md]
      //
      // Why split: MEMORY.md grows over time (agent writes to it). cache_control
      // breakpoint sits on the LAST system block (sdk.ts:805 addCacheMarkers).
      // Putting MEMORY.md last means its growth invalidates only the small final
      // segment, while the large CLAUDE.md + opencode-system prefix stays cached.
      //
      // NOTE: attempted migration to experimental.chat.system.transform hook failed —
      // opencode only dispatches config/auth hooks to external (npm) plugins,
      // not trigger-type hooks. So injection stays in the provider for now.
      const { stable: stableInj, volatile: volatileInj } = buildContextInjectionParts()

      if (stableInj || volatileInj) {
        if (typeof system === 'string') {
          system = [
            stableInj,
            system,
            volatileInj,
          ].filter(Boolean).join('\n\n') || undefined
        } else if (Array.isArray(system)) {
          // Stable goes to the front, volatile to the end.
          if (stableInj) (system as any[]).unshift({ type: 'text', text: stableInj })
          if (volatileInj) (system as any[]).push({ type: 'text', text: volatileInj })
        } else {
          system = [stableInj, volatileInj].filter(Boolean).join('\n\n') || undefined
        }
      }
      continue
    }

    if (msg.role === 'user') {
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      const content: any[] = []
      for (const p of parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text || '...' })
        // file parts: convert to Anthropic content blocks based on mediaType
        if (p.type === 'file' && typeof p.mediaType === 'string') {
          // Check if data is a URL (string URL or URL object)
          const isUrl = p.data instanceof URL || (typeof p.data === 'string' && (p.data.startsWith('http://') || p.data.startsWith('https://')))
          if (isUrl) {
            const url = typeof p.data === 'string' ? p.data : p.data.toString()
            if (p.mediaType.startsWith('image/')) {
              content.push({ type: 'image', source: { type: 'url', url } } as any)
              dbg('Converted file part to image URL block:', p.mediaType, url)
            } else if (p.mediaType === 'application/pdf') {
              content.push({ type: 'document', source: { type: 'url', url } } as any)
              dbg('Converted file part to document URL block:', url)
            }
            continue
          }
          // Inline data: base64 string, Uint8Array, or ArrayBuffer
          let data = typeof p.data === 'string' ? p.data
            : p.data instanceof Uint8Array ? Buffer.from(p.data).toString('base64')
            : p.data instanceof ArrayBuffer ? Buffer.from(p.data).toString('base64')
            : null
          if (!data) {
            dbg('Skipping file part: could not convert data to base64, type:', typeof p.data)
            continue
          }
          // Safety: strip data URL prefix if AI SDK passed full data URL instead of pure base64
          // (e.g. "data:image/png;base64,iVBOR..." → "iVBOR...")
          if (typeof data === 'string' && data.startsWith('data:')) {
            const commaIdx = data.indexOf(',')
            if (commaIdx !== -1) {
              data = data.slice(commaIdx + 1)
              dbg('Stripped data URL prefix from file data')
            }
          }
          if (p.mediaType.startsWith('image/')) {
            // Step 1: Validate + normalize before resize. Catches empty/truncated/corrupt
            // images, MIME mismatches, unsupported formats (transcodes BMP/TIFF → PNG),
            // and tiny dimensions (<8×8). Returns text placeholder on failure so the
            // conversation stays sendable instead of hitting API 400 "Could not process image".
            const validated = await validateAndNormalizeImage(data, p.mediaType)
            if (!validated.ok) {
              dbg(`image validation failed: ${validated.reason} — replacing with text placeholder`)
              content.push({ type: 'text', text: `[Image could not be processed: ${validated.reason}]` })
              continue
            }
            if (validated.reason) {
              dbg(`image normalized: ${validated.reason}`)
            }
            // Step 2: Resize if oversized (2000×2000 max, 3.75MB raw — matches Claude Code limits)
            const resized = await maybeResizeImage(validated.data, validated.mediaType)
            // Final safety check: reject if still over API limit after resize attempt
            const API_IMAGE_MAX_BASE64 = 5 * 1024 * 1024
            if (resized.data.length > API_IMAGE_MAX_BASE64) {
              dbg(`WARNING: image still too large after resize (${(resized.data.length / 1024 / 1024).toFixed(1)}MB base64, limit 5MB) — skipping`)
              content.push({ type: 'text', text: `[Image too large: ${(resized.data.length / 1024 / 1024).toFixed(1)}MB after resize, API limit is 5MB. Please use a smaller image.]` })
              continue
            }
            content.push({ type: 'image', source: { type: 'base64', media_type: resized.mediaType, data: resized.data } })
            dbg('Converted file part to image block:', resized.mediaType, `${(resized.data.length / 1024).toFixed(0)}KB base64`, resized.resized ? '(resized)' : '(original)')
          } else if (p.mediaType === 'application/pdf') {
            // PDF → Anthropic document content block
            content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })
            dbg('Converted file part to document block:', `${(data.length / 1024).toFixed(0)}KB base64`)
          } else {
            // Unsupported mediaType — skip silently (don't crash)
            dbg('Skipping file part with unsupported mediaType:', p.mediaType)
          }
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '...' })
      messages.push({ role: 'user', content })
      continue
    }

    if (msg.role === 'assistant') {
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      const content: any[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
        if (p.type === 'reasoning' && p.text) {
          // Only include thinking blocks if we have the signature (required by API)
          const sig = p.providerMetadata?.['claude-max']?.signature ?? p.providerOptions?.['claude-max']?.signature
          if (sig) {
            content.push({ type: 'thinking', thinking: p.text, signature: sig })
          }
          // Without signature: skip thinking block — API rejects it
        }
        if (p.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: p.toolCallId,
            name: p.toolName,
            input: typeof p.input === 'string' ? JSON.parse(p.input) : p.input ?? {},
          })
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '...' })
      messages.push({ role: 'assistant', content })
      continue
    }

    if (msg.role === 'tool') {
      const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
      const toolResults: any[] = []
      for (const p of parts) {
        if (p.type === 'tool-result') {
          let resultContent: string
          if (Array.isArray(p.output)) {
            // LanguageModelV3ToolResultOutput array
            resultContent = p.output.map((o: any) => {
              if (o.type === 'text' || o.type === 'error-text') return o.value
              if (o.type === 'json' || o.type === 'error-json') return JSON.stringify(o.value)
              return String(o.value ?? '')
            }).join('\n')
          } else if (typeof p.output === 'object' && p.output !== null) {
            if (p.output.type === 'text' || p.output.type === 'error-text') resultContent = p.output.value
            else if (p.output.type === 'json' || p.output.type === 'error-json') resultContent = JSON.stringify(p.output.value)
            else resultContent = JSON.stringify(p.output)
          } else {
            resultContent = String(p.output ?? '')
          }
          const isError = p.output?.type === 'error-text' || p.output?.type === 'error-json' || p.output?.type === 'execution-denied'
          toolResults.push({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: resultContent,
            ...(isError ? { is_error: true } : {}),
          })
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults })
      }
      continue
    }
  }

  // ─── Orphan tool_use sanitizer ──────
  // Heals conversations where an assistant turn streamed a `tool_use` block
  // but opencode never persisted the matching `tool_result` (e.g. stream
  // aborted by stuck TCP mid-reply). Anthropic API rejects such histories
  // with 400 "tool_use ids were found without tool_result blocks immediately
  // after". Root cause is opencode's save-as-you-stream — not fixable here,
  // but we can neutralize the damage at send time.
  //
  // CACHE-SAFETY RULES (do not break):
  //   1. Only touches messages where orphan is DETECTED. Healthy conversations
  //      pass through byte-identical.
  //   2. Synthetic tool_result uses a CONSTANT string (no timestamps, no IDs).
  //      Same corrupted history → same sanitized output every time →
  //      cache stabilizes on the new prefix after one rebuild.
  //   3. Idempotent: running twice produces the same result as once.
  //   4. Every activation is logged for observability.
  const SANITIZER_CONSTANT_TEXT = '[Tool execution interrupted before completion. Please retry if needed.]'
  let sanitizerHits = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    // Collect tool_use IDs in this assistant turn
    const toolUseIds: string[] = []
    for (const block of msg.content as any[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        toolUseIds.push(block.id)
      }
    }
    if (toolUseIds.length === 0) continue
    // Next message must be user with tool_result blocks covering all tool_use IDs
    const next = messages[i + 1]
    const coveredIds = new Set<string>()
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const block of next.content as any[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          coveredIds.add(block.tool_use_id)
        }
      }
    }
    const orphanIds = toolUseIds.filter(id => !coveredIds.has(id))
    if (orphanIds.length === 0) continue
    // Build synthetic tool_result blocks for each orphan.
    // KEY: constant text ensures byte-identical output on every resend →
    // cache rebuilds ONCE at message i+1 and then stably hits from there.
    const syntheticResults = orphanIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: SANITIZER_CONSTANT_TEXT,
      is_error: true,
    }))
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      // Inject into existing user message (preserve any real tool_results already there)
      (next.content as any[]).push(...syntheticResults)
    } else {
      // No next message yet — insert a new user turn
      messages.splice(i + 1, 0, { role: 'user', content: syntheticResults })
    }
    sanitizerHits += orphanIds.length
    dbg(`tool_use_sanitizer: healed ${orphanIds.length} orphan(s) at assistant msg[${i}] ids=[${orphanIds.join(',')}]`)
  }
  if (sanitizerHits > 0) {
    dbg(`tool_use_sanitizer: total ${sanitizerHits} synthetic tool_results injected (cache prefix rebuilt from first healed point)`)
  }

  // Prefix fingerprint: hash each system block separately for cache-debugging.
  // When cache_read=0 unexpectedly, comparing fingerprints across PIDs reveals
  // which block changed (CLAUDE.md? opencode hints? MEMORY.md?).
  const sysFingerprints: string[] = []
  if (Array.isArray(system)) {
    const { createHash } = require('crypto') as typeof import('crypto')
    for (const block of system as any[]) {
      const text = block?.text ?? ''
      sysFingerprints.push(`${createHash('md5').update(String(text)).digest('hex').slice(0, 8)}@${String(text).length}`)
    }
  } else if (typeof system === 'string') {
    const { createHash } = require('crypto') as typeof import('crypto')
    sysFingerprints.push(`${createHash('md5').update(system).digest('hex').slice(0, 8)}@${system.length}`)
  }
  dbg(`convertPrompt: ${messages.length} messages, system=${typeof system === 'string' ? system.length : Array.isArray(system) ? (system as any[]).length + ' blocks' : 'none'} fingerprints=[${sysFingerprints.join(',')}] in ${Date.now() - tConvert}ms`)
  return { system, messages }
}

// ─── Tools conversion: V3 → SDK ──────────────────────────

// Normalize tool schemas for cross-session cache reuse.
// opencode injects the CWD path into the bash tool's workdir description
// (e.g. "Defaults to /mnt/d/.../myproject"). This tiny path difference
// breaks Anthropic's byte-exact prefix cache matching across sessions
// in different project directories, forcing a full ~33K token cache rewrite.
// Replacing with a stable placeholder makes the tool prefix identical
// regardless of CWD, so all sessions share the same cached tools.
const CWD_PATTERNS: [RegExp, string][] = [
  [/Defaults to \/\S+\./g, 'Defaults to the current working directory.'],
  [/All commands run in \/\S+ by default/g, 'All commands run in the current working directory by default'],
]

function normalizeCwd(text: string): string {
  for (const [re, replacement] of CWD_PATTERNS) {
    re.lastIndex = 0
    text = text.replace(re, replacement)
  }
  return text
}

function normalizeToolSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema
  const result = { ...schema }
  if (result.properties) {
    result.properties = { ...result.properties }
    for (const [key, val] of Object.entries(result.properties)) {
      if (val && typeof val === 'object' && typeof (val as any).description === 'string') {
        result.properties[key] = { ...(val as any), description: normalizeCwd((val as any).description) }
      }
    }
  }
  return result
}

let _lastToolCount = 0
let _lastToolHash = ''
let _lastToolFingerprint = ''

// Tool name remapping — Anthropic blocks certain third-party tool names
// by routing requests to overage/extra-usage billing with misleading error.
// We rename blocked names before sending and restore in responses.
const TOOL_NAME_REMAP: Record<string, string> = {
  'todowrite': 'todo_write',
}
const TOOL_NAME_UNREMAP: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_NAME_REMAP).map(([k, v]) => [v, k])
)

// MCP tools have names like "km_km_think", "synqtask_todo_tasks" — they contain
// underscores from the sanitized server name prefix. Built-in tools are simple
// names: "bash", "read", "glob", "edit", "write", "task", etc.
// We use this heuristic to separate them for cache-optimal ordering.
const MCP_TOOL_PATTERN = /^[a-z][\w-]+_[a-z]/  // e.g. "km_km_think", "telegram-mcp_tg_send"

// Explicit allowlist of built-in names AFTER TOOL_NAME_REMAP. Required because
// `todo_write` (remapped from `todowrite`) contains an underscore and would
// otherwise match MCP_TOOL_PATTERN, causing it to drift between builtin (10)
// and MCP (69 or 70) buckets — observed 319× in claude-max-debug.log.
// This caused the exact "TOOL_DRIFT 80↔79 (builtin=10 mcp=69)" pattern.
const BUILTIN_NAMES_AFTER_REMAP: ReadonlySet<string> = new Set([
  'bash', 'read', 'glob', 'grep', 'edit', 'write',
  'task', 'todo_write', 'question', 'webfetch', 'skill',
])

function convertTools(tools?: any[]): any[] | undefined {
  if (!tools?.length) return undefined

  const all = tools
    .filter((t: any) => t.type === 'function')
    .map((t: any) => ({
      name: TOOL_NAME_REMAP[t.name] ?? t.name,
      description: normalizeCwd(t.description ?? ''),
      input_schema: normalizeToolSchema(t.inputSchema ?? { type: 'object', properties: {} }),
    }))

  // Split: keep built-in tools in opencode's original order (stable prefix),
  // sort only MCP tools among themselves (deterministic regardless of connection race).
  // This way missing MCPs only truncate the SUFFIX — the built-in prefix stays
  // byte-identical for cache hits across sessions with different MCP availability.
  //
  // Allowlist takes priority: known built-in names always go to builtIn even if
  // they happen to contain underscores (e.g. todo_write).
  const builtIn: typeof all = []
  const mcp: typeof all = []
  for (const t of all) {
    if (BUILTIN_NAMES_AFTER_REMAP.has(t.name)) {
      builtIn.push(t)
    } else if (MCP_TOOL_PATTERN.test(t.name)) {
      mcp.push(t)
    } else {
      // Unknown name without underscore separator — treat as builtin for cache stability
      builtIn.push(t)
    }
  }
  mcp.sort((a, b) => a.name.localeCompare(b.name))

  const result = [...builtIn, ...mcp]

  // Detect tool set changes (MCP server connected/disconnected mid-session).
  // Diff produces actionable info for next investigation: which tool was added/removed.
  const count = result.length
  const namesNow = result.map((t: any) => t.name)
  const hash = namesNow.join(',')
  // Per-tool body fingerprints — catches mid-session schema/description drift
  // even when the name list is stable. (Seen 2026-04-30: telegram-mcp_tg_send_message
  // schema-hash differed between PIDs without name change.)
  const { createHash } = require('crypto') as typeof import('crypto')
  const toolsFingerprint = createHash('md5').update(
    result.map((t: any) => `${t.name}|${createHash('md5').update(JSON.stringify(t)).digest('hex').slice(0,8)}`).join(',')
  ).digest('hex').slice(0, 12)
  if (_lastToolCount > 0 && hash !== _lastToolHash) {
    const oldNames = new Set(_lastToolHash.split(','))
    const newNames = new Set(namesNow)
    const added = namesNow.filter(n => !oldNames.has(n))
    const removed = [..._lastToolHash.split(',')].filter(n => !newNames.has(n))
    dbg(`⚠ TOOL_DRIFT: count ${_lastToolCount} → ${count} (builtin=${builtIn.length} mcp=${mcp.length}) added=[${added.join(',')}] removed=[${removed.join(',')}] toolsFp=${toolsFingerprint}`)
    logStats(`[${new Date().toISOString()}] type=tool_drift | old=${_lastToolCount} new=${count} builtin=${builtIn.length} mcp=${mcp.length} added=${added.join(',')} removed=${removed.join(',')} toolsFp=${toolsFingerprint}`, {
      type: 'tool_drift', oldCount: _lastToolCount, newCount: count,
      builtIn: builtIn.length, mcpCount: mcp.length,
      added, removed, toolsFingerprint,
    })
  } else if (_lastToolCount === 0) {
    dbg(`tools: ${count} registered (builtin=${builtIn.length} mcp=${mcp.length}) toolsFp=${toolsFingerprint}`)
  } else if (toolsFingerprint !== _lastToolFingerprint) {
    // Same name list but DIFFERENT schemas — silent drift, hardest to catch.
    dbg(`⚠ TOOL_SCHEMA_DRIFT: same ${count} tools but fingerprint changed ${_lastToolFingerprint} → ${toolsFingerprint}`)
    logStats(`[${new Date().toISOString()}] type=tool_schema_drift | count=${count} oldFp=${_lastToolFingerprint} newFp=${toolsFingerprint}`, {
      type: 'tool_schema_drift', count, oldFingerprint: _lastToolFingerprint, newFingerprint: toolsFingerprint,
    })
  }
  _lastToolCount = count
  _lastToolHash = hash
  _lastToolFingerprint = toolsFingerprint

  return result
}

function convertToolChoice(tc?: any): any {
  if (!tc) return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'required') return 'any'
  if (tc.type === 'tool') return { type: 'tool', name: TOOL_NAME_REMAP[tc.toolName] ?? tc.toolName }
  return undefined
}

// ─── Usage conversion: SDK → V3 ──────────────────────────

function convertUsage(usage: any) {
  // Total input = base + cacheRead + cacheWrite (full prompt size)
  const baseIn = usage?.inputTokens ?? 0
  const cacheRead = usage?.cacheReadInputTokens ?? 0
  const cacheWrite = usage?.cacheCreationInputTokens ?? 0
  const totalIn = baseIn + cacheRead + cacheWrite

  return {
    inputTokens: {
      total: totalIn,
      noCache: baseIn,
      cacheRead: cacheRead || undefined,
      cacheWrite: cacheWrite || undefined,
    },
    outputTokens: {
      total: usage?.outputTokens ?? 0,
      text: undefined,
      reasoning: undefined,
    },
  }
}

function convertFinishReason(stopReason: string | null) {
  const map: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool-calls',
  }
  return {
    unified: map[stopReason ?? ''] ?? 'other',
    raw: stopReason ?? undefined,
  }
}

// ─── The LanguageModelV3 implementation ───────────────────

function createLanguageModel(sdk: ClaudeCodeSDK, modelId: string, providerId: string): LanguageModelV3 {
  return {
    specificationVersion: 'v3' as const,
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doGenerate(options: any) {
      dbg('doGenerate', { modelId, promptLen: options.prompt?.length, hasTools: !!options.tools?.length })
      const { system, messages } = await convertPrompt(options.prompt)
      const tools = convertTools(options.tools)
      const toolChoice = convertToolChoice(options.toolChoice)

      const sdkOpts: any = {
        model: modelId,
        messages,
        // Resolved from SSOT (src/models.ts): explicit override > env > per-model default.
        // Replaces the old hardcoded 16384 which caused max_tokens retry loops.
        maxTokens: resolveMaxTokens(modelId, options.maxOutputTokens),
        signal: options.abortSignal,
      }
      if (system) sdkOpts.system = system
      if (tools?.length) sdkOpts.tools = tools
      if (toolChoice) sdkOpts.toolChoice = toolChoice
      if (options.temperature !== undefined) sdkOpts.temperature = options.temperature
      if (options.stopSequences?.length) sdkOpts.stopSequences = options.stopSequences

       // Thinking config from providerOptions (effort variant) or default
       // 4.6+ models use adaptive thinking — SDK handles it in buildRequestBody
       const po = options.providerOptions?.['claude-max'] ?? options.providerOptions ?? {}
       const thinking = po.thinking ?? po
       if (thinking?.type === 'enabled' && thinking?.budgetTokens) {
         sdkOpts.thinking = { type: 'enabled', budgetTokens: thinking.budgetTokens }
       }
       // For adaptive models (4.6+), don't set thinking here — SDK sets { type: 'adaptive' }

       const response = await sdk.generate(sdkOpts)

      // Convert content blocks to V3 format
      const content: any[] = []
      for (const block of response.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          content.push({
            type: 'reasoning', text: (block as any).thinking,
            providerMetadata: (block as any).signature ? { 'claude-max': { signature: (block as any).signature } } : undefined,
          })
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool-call',
            toolCallId: (block as any).id,
            toolName: TOOL_NAME_UNREMAP[(block as any).name] ?? (block as any).name,
            input: JSON.stringify((block as any).input ?? {}),
          })
        }
      }

      const u = response.usage
      const rl = sdk.getRateLimitInfo()
      const rlStr = rl.status ? ` | quota=${rl.status} claim=${rl.claim ?? '?'} util5h=${rl.utilization5h ?? '?'} util7d=${rl.utilization7d ?? '?'}` : ''
      logStats(`[${new Date().toISOString()}] model=${modelId} type=generate | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${response.stopReason}${rlStr}`, {
        type: 'generate', model: modelId, dur: 0, stop: response.stopReason,
        usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheCreationInputTokens ?? 0 },
        rateLimit: rl.status ? { status: rl.status, claim: rl.claim, resetAt: rl.resetAt, util5h: rl.utilization5h, util7d: rl.utilization7d } : undefined,
      })
      return {
        content,
        finishReason: convertFinishReason(response.stopReason),
        usage: convertUsage(response.usage),
        providerMetadata: {
          'claude-max': {
            cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
          },
          anthropic: {
            cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
          },
        },
        warnings: [],
        response: { id: undefined, timestamp: new Date(), modelId },
      }
    },

    async doStream(options: any) {
      const t0 = Date.now()
      dbg('doStream', { modelId, promptLen: options.prompt?.length, hasTools: !!options.tools?.length })
      const { system, messages } = await convertPrompt(options.prompt)
      const tools = convertTools(options.tools)
      const toolChoice = convertToolChoice(options.toolChoice)

      const sdkOpts: any = {
        model: modelId,
        messages,
        // Resolved from SSOT (src/models.ts): explicit override > env > per-model default.
        maxTokens: resolveMaxTokens(modelId, options.maxOutputTokens),
        signal: options.abortSignal,
      }
      if (system) sdkOpts.system = system
      if (tools?.length) sdkOpts.tools = tools
      if (toolChoice) sdkOpts.toolChoice = toolChoice
      if (options.temperature !== undefined) sdkOpts.temperature = options.temperature
      if (options.stopSequences?.length) sdkOpts.stopSequences = options.stopSequences

      // Thinking config from providerOptions (effort variant) or default.
      // 4.6+ models use adaptive thinking — SDK's buildRequestBody will convert
      // to { type: 'adaptive' } for models reported as supporting it by the SSOT.
      const po = options.providerOptions?.['claude-max'] ?? options.providerOptions ?? {}
      const thinking = po.thinking ?? po
      const isAdaptive = supportsAdaptiveThinking(modelId)
      if (thinking?.type === 'enabled' && thinking?.budgetTokens) {
        sdkOpts.thinking = { type: 'enabled', budgetTokens: thinking.budgetTokens }
        dbg('doStream thinking from variant:', sdkOpts.thinking)
      } else if (isAdaptive) {
        // Don't set thinking here — SDK will set { type: 'adaptive' } in buildRequestBody
        dbg('doStream: adaptive model, SDK will handle thinking')
      }

      const sdkStream = sdk.stream(sdkOpts)

      // IDs for lifecycle events
      let textId = ''
      let reasoningId = ''
      let toolId = ''
      let textActive = false
      let reasoningActive = false
      let currentToolInput = ''
      let currentSignature: string | undefined

      const stream = new ReadableStream({
        async start(controller) {
          // First event must be stream-start
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'response-metadata', modelId })

          let firstEvent = true
          try {
            for await (const event of sdkStream) {
              if (firstEvent) {
                dbg(`doStream first event after ${Date.now() - t0}ms`, { type: event.type, modelId })
                firstEvent = false
              }
              switch (event.type) {
                case 'text_delta': {
                  if (!textActive) {
                    textId = `text-${Date.now()}`
                    controller.enqueue({ type: 'text-start', id: textId })
                    textActive = true
                  }
                  controller.enqueue({ type: 'text-delta', id: textId, delta: event.text })
                  break
                }

                case 'thinking_delta': {
                  if (!reasoningActive) {
                    reasoningId = `reasoning-${Date.now()}`
                    controller.enqueue({ type: 'reasoning-start', id: reasoningId })
                    reasoningActive = true
                  }
                  controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: event.text })
                  break
                }

                case 'thinking_end': {
                  currentSignature = event.signature
                  if (reasoningActive) {
                    controller.enqueue({ type: 'reasoning-end', id: reasoningId, providerMetadata: currentSignature ? { 'claude-max': { signature: currentSignature } } : undefined })
                    reasoningActive = false
                  }
                  break
                }

                case 'tool_use_start': {
                  // Close any open text/reasoning
                  if (textActive) { controller.enqueue({ type: 'text-end', id: textId }); textActive = false }
                  if (reasoningActive) { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningActive = false }

                  toolId = event.id
                  currentToolInput = ''
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: toolId,
                    toolName: TOOL_NAME_UNREMAP[event.name] ?? event.name,
                  })
                  break
                }

                case 'tool_use_delta': {
                  const partial = event.partialInput ?? ''
                  if (partial) {
                    currentToolInput += partial
                    controller.enqueue({ type: 'tool-input-delta', id: toolId, delta: partial })
                  }
                  break
                }

                case 'tool_use_end': {
                  controller.enqueue({ type: 'tool-input-end', id: toolId })
                  // Emit complete tool-call
                  const inputStr = currentToolInput || JSON.stringify(event.input ?? {})
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: event.id,
                    toolName: TOOL_NAME_UNREMAP[event.name] ?? event.name,
                    input: inputStr,
                  })
                  toolId = ''
                  currentToolInput = ''
                  break
                }

                case 'message_stop': {
                  const dur = Date.now() - t0
                  const u = event.usage
                  const rl = sdk.getRateLimitInfo()
                  const rlStr = rl.status ? ` | quota=${rl.status} claim=${rl.claim ?? '?'} util5h=${rl.utilization5h ?? '?'} util7d=${rl.utilization7d ?? '?'}` : ''
                  logStats(`[${new Date().toISOString()}] model=${modelId} type=stream dur=${dur}ms | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${event.stopReason}${rlStr}`, {
                    type: 'stream', model: modelId, dur, stop: event.stopReason,
                    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheCreationInputTokens ?? 0 },
                    rateLimit: rl.status ? { status: rl.status, claim: rl.claim, resetAt: rl.resetAt, util5h: rl.utilization5h, util7d: rl.utilization7d } : undefined,
                  })
                  dbg(`doStream complete in ${dur}ms`, { modelId, stopReason: event.stopReason })
                  if (textActive) { controller.enqueue({ type: 'text-end', id: textId }); textActive = false }
                  if (reasoningActive) { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningActive = false }

                  const eu = event.usage
                  controller.enqueue({
                    type: 'finish',
                    usage: convertUsage(eu),
                    finishReason: convertFinishReason(event.stopReason ?? null),
                    providerMetadata: {
                      'claude-max': {
                        cacheCreationInputTokens: eu?.cacheCreationInputTokens ?? 0,
                        cacheReadInputTokens: eu?.cacheReadInputTokens ?? 0,
                      },
                      // Also under 'anthropic' key for opencode compatibility
                      anthropic: {
                        cacheCreationInputTokens: eu?.cacheCreationInputTokens ?? 0,
                        cacheReadInputTokens: eu?.cacheReadInputTokens ?? 0,
                      },
                    },
                  })
                  break
                }
              }
            }
          } catch (err) {
            controller.enqueue({ type: 'error', error: err })
          }

          controller.close()
        },
      })

      return { stream }
    },
  }
}

// ─── Provider factory ─────────────────────────────────────

export interface ClaudeMaxProviderOptions {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  credentialsPath?: string
}

export function createClaudeMax(options: ClaudeMaxProviderOptions = {}) {
  const tCreate = Date.now()
  // Note: signal-wire/wake-listener moved to @life-ai-tools/opencode-signal-wire.
  // If that package isn't resolvable, the imports at top of file throw —
  // no separate runtime check needed.

  // Provider options from opencode.json → provider.claude-max.options
  // These override env vars for user-friendly configuration.
  const providerOpts = (options as any).providerOptions ?? {}

  const keepaliveEnabled = providerOpts.keepalive !== undefined
    ? !!providerOpts.keepalive
    : process.env.CLAUDE_MAX_KEEPALIVE !== '0'
  // keepaliveInterval: explicit user value wins; otherwise undefined → engine reads
  // from SSOT (~/.claude/keepalive.json). Auto-scales with cacheTtlMs (5m→150s, 1h→1800s).
  const keepaliveInterval: number | undefined = providerOpts.keepaliveInterval
    ? parseInt(providerOpts.keepaliveInterval) * 1000
    : process.env.CLAUDE_MAX_KEEPALIVE_INTERVAL
      ? (parseInt(process.env.CLAUDE_MAX_KEEPALIVE_INTERVAL) || 0) * 1000 || undefined
      : undefined
  const keepaliveIdle = providerOpts.keepaliveIdle
    ? parseInt(providerOpts.keepaliveIdle) * 1000
    : process.env.CLAUDE_MAX_KEEPALIVE_IDLE ? parseInt(process.env.CLAUDE_MAX_KEEPALIVE_IDLE) * 1000 : Infinity

  // ─── Rewrite-burst protection (Layer 3) ───────────────────────────
  // Env flags (seconds for humans):
  //   CLAUDE_MAX_REWRITE_WARN_IDLE_SEC   — warn if next stream fires after this idle. Default 300 (5 min).
  //   CLAUDE_MAX_REWRITE_WARN_TOKENS     — warn threshold for estimated rewrite cost. Default 50000.
  //   CLAUDE_MAX_REWRITE_BLOCK=1         — enable hard block (opt-in).
  //   CLAUDE_MAX_REWRITE_BLOCK_IDLE_SEC  — idle threshold for block. Default 1800 (30 min).
  const rewriteWarnIdleMs = (parseInt(process.env.CLAUDE_MAX_REWRITE_WARN_IDLE_SEC ?? '300', 10) || 300) * 1000
  const rewriteWarnTokens = parseInt(process.env.CLAUDE_MAX_REWRITE_WARN_TOKENS ?? '50000', 10) || 50_000
  const rewriteBlockEnabled = process.env.CLAUDE_MAX_REWRITE_BLOCK === '1'
  const rewriteBlockIdleMs = (parseInt(process.env.CLAUDE_MAX_REWRITE_BLOCK_IDLE_SEC ?? '1800', 10) || 1800) * 1000

  // Resolve cache + KA params from SSOT (~/.claude/keepalive.json) for visibility.
  // This is the SAME config the engine will read internally; logging it makes
  // it trivial to confirm new code is loaded after a restart.
  let cacheConfigSnapshot: Record<string, unknown> = {}
  try {
    const c = loadKeepaliveConfig()
    cacheConfigSnapshot = {
      cacheTtlMs: c.cacheTtlMs,
      cacheTtlMin: Math.round(c.cacheTtlMs / 60_000),
      intervalMs: c.intervalMs,
      intervalMin: Math.round(c.intervalMs / 60_000),
      safetyMarginMs: c.safetyMarginMs,
      retryCount: c.retryDelaysMs.length,
      source: c._source,
    }
  } catch (e: any) {
    cacheConfigSnapshot = { error: e?.message }
  }

  dbg(`STARTUP createClaudeMax pid=${PID} sdk=0.12.0 plugin=1.3.0 [cache-ssot]`, {
    hasAccessToken: !!options.accessToken,
    credentialsPath: options.credentialsPath,
    keepaliveEnabled,
    keepaliveInterval,
    providerOpts: Object.keys(providerOpts),
    rewriteWarnIdleMs,
    rewriteBlockEnabled,
    cacheConfig: cacheConfigSnapshot,
  })
  const sdk = new ClaudeCodeSDK({
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    expiresAt: options.expiresAt,
    credentialsPath: options.credentialsPath,
    onTokenStatus: (event) => {
      const emoji = event.level === 'rotated' ? '✅' : event.level === 'warning' ? '⚠️' : event.level === 'critical' ? '🔴' : '💀'
      const line = `${emoji} TOKEN ${event.level.toUpperCase()}: ${event.message} (expires in ${Math.round(event.expiresInMs / 60000)}min, failures=${event.failedAttempts})`
      dbg(line)
      logStats(`[${new Date().toISOString()}] type=token_${event.level} | expiresIn=${Math.round(event.expiresInMs / 60000)}min failures=${event.failedAttempts} needsReLogin=${event.needsReLogin}`, {
        type: `token_${event.level}`,
        expiresInMin: Math.round(event.expiresInMs / 60000),
        failures: event.failedAttempts,
        needsReLogin: event.needsReLogin,
        message: event.message,
      })
      // On critical/expired — log to stderr so it's visible in terminal
      if (event.level === 'critical' || event.level === 'expired') {
        console.error(`[claude-max] ${line}`)
      }
    },
    keepalive: {
      enabled: keepaliveEnabled,
      intervalMs: keepaliveInterval,
      idleTimeoutMs: keepaliveIdle,
      rewriteWarnIdleMs,
      rewriteWarnTokens,
      rewriteBlockEnabled,
      rewriteBlockIdleMs,
      onTick: (tick) => {
        dbg(`keepalive tick: idle=${Math.round(tick.idleMs/1000)}s nextFire=${Math.round(tick.nextFireMs/1000)}s model=${tick.model}`)
      },
      onHeartbeat: (stats) => {
        const rl = stats.rateLimit ? ` | quota=${stats.rateLimit.status ?? '?'} claim=${stats.rateLimit.claim ?? '?'}` : ''
        logStats(`[${new Date().toISOString()}] model=${stats.model} type=keepalive dur=${stats.durationMs}ms | in=${stats.usage.inputTokens} out=${stats.usage.outputTokens} cacheRead=${stats.usage.cacheReadInputTokens ?? 0} cacheWrite=${stats.usage.cacheCreationInputTokens ?? 0} | idle=${Math.round(stats.idleMs / 1000)}s${rl}`, {
          type: 'keepalive', model: stats.model, dur: stats.durationMs, idle: Math.round(stats.idleMs / 1000),
          usage: { in: stats.usage.inputTokens, out: stats.usage.outputTokens, cacheRead: stats.usage.cacheReadInputTokens ?? 0, cacheWrite: stats.usage.cacheCreationInputTokens ?? 0 },
          rateLimit: stats.rateLimit ?? undefined,
        })
        dbg('keepalive FIRED', { model: stats.model, dur: stats.durationMs, cacheRead: stats.usage.cacheReadInputTokens ?? 0, cacheWrite: stats.usage.cacheCreationInputTokens ?? 0, rateLimit: stats.rateLimit })
      },
      onDisarmed: (info) => {
        // KA stopped firing (cache/network issue) but timer stays alive for auto-resume.
        // Stream this to stats.jsonl so audits can see why KA went quiet for a PID.
        logStats(`[${new Date().toISOString()}] type=keepalive_disarmed reason=${info.reason} | timer stays alive, will auto-resume on next real stream`, {
          type: 'keepalive_disarmed', reason: info.reason,
        })
        dbg(`keepalive DISARMED reason=${info.reason} (timer alive, auto-resume on next real stream)`)
      },
      onRewriteWarning: (info) => {
        // Real stream() about to run after long idle — cache likely dead, will pay cacheWrite.
        // Log for quota observability; also stderr so orchestrators catch it.
        const tag = info.blocked ? 'cache_rewrite_blocked' : 'cache_rewrite_warn'
        logStats(`[${new Date().toISOString()}] type=${tag} model=${info.model} idle=${Math.round(info.idleMs/1000)}s estimatedTokens=${info.estimatedTokens}${info.blocked ? ' BLOCKED' : ''}`, {
          type: tag, model: info.model, idleSec: Math.round(info.idleMs / 1000), estimatedTokens: info.estimatedTokens, blocked: info.blocked,
        })
        const banner = info.blocked
          ? `🚫 [claude-max] CACHE REWRITE BLOCKED — idle=${Math.round(info.idleMs/1000)}s, would cost ~${info.estimatedTokens} tokens. Unset CLAUDE_MAX_REWRITE_BLOCK to allow.`
          : `⚠️  [claude-max] Cache likely dead — idle=${Math.round(info.idleMs/1000)}s, next request will cost ~${info.estimatedTokens} cache_write tokens`
        console.error(banner)
      },
      onNetworkStateChange: (info) => {
        logStats(`[${new Date().toISOString()}] type=network_${info.to} from=${info.from}`, {
          type: `network_${info.to}`, from: info.from, to: info.to,
        })
        dbg(`network state: ${info.from} → ${info.to}`)
      },
    },
  })

  dbg(`STARTUP createClaudeMax done in ${Date.now() - tCreate}ms`)

   return {
    languageModel(modelId: string): LanguageModelV3 {
      dbg('languageModel requested:', modelId)
      return createLanguageModel(sdk, modelId, 'claude-max')
    },
  }
}
