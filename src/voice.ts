/**
 * Voice STT — Speech-to-Text via Anthropic's voice_stream WebSocket endpoint.
 *
 * Architecture: transcribe-then-submit (NOT native multimodal audio).
 * The voice_stream endpoint is a private Anthropic API that accepts raw PCM
 * audio over WebSocket and returns text transcripts via Deepgram Nova 3.
 *
 * Wire protocol (from Claude Code CLI src/services/voiceStreamSTT.ts):
 *   Client → Server: binary audio frames (raw PCM 16kHz/16bit/mono)
 *   Client → Server: JSON control messages (KeepAlive, CloseStream)
 *   Server → Client: JSON transcript messages (TranscriptText, TranscriptEndpoint, TranscriptError)
 *
 * Sources:
 *   - src/services/voiceStreamSTT.ts — WebSocket STT client
 *   - src/services/voice.ts — Audio recording (cpal/SoX/arecord)
 *   - src/hooks/useVoice.ts — React hook for hold-to-talk
 *   - src/constants/oauth.ts:85 — BASE_API_URL = 'https://api.anthropic.com'
 */

import { spawn, spawnSync } from 'child_process'
import { request as httpsRequest } from 'https'
import { randomBytes, createHash } from 'crypto'
import { ANTHROPIC_API_BASE } from './anthropic-endpoints.js'
import {
  HEADER_AUTHORIZATION,
  HEADER_USER_AGENT,
  HEADER_X_APP,
} from './anthropic-headers.js'

// ─── Constants (from Claude Code source) ─────────────────────────────

const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream'
const KEEPALIVE_INTERVAL_MS = 8_000
const KEEPALIVE_MSG = '{"type":"KeepAlive"}'
const CLOSE_STREAM_MSG = '{"type":"CloseStream"}'

// Audio format: raw PCM, 16kHz, 16-bit signed little-endian, mono
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8

// Finalize timeouts (from voiceStreamSTT.ts:44-47)
const FINALIZE_SAFETY_MS = 5_000
const FINALIZE_NO_DATA_MS = 1_500

// File streaming: send audio in chunks that approximate real-time
// 16kHz × 1ch × 2bytes = 32,000 bytes/sec
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE
// Send in ~100ms chunks for smooth streaming
const CHUNK_SIZE = Math.floor(BYTES_PER_SECOND * 0.1)
// Inter-chunk delay to approximate real-time (with small speedup)
const CHUNK_DELAY_MS = 80 // ~0.8x realtime — slightly faster but not suspiciously fast

// ─── Types ───────────────────────────────────────────────────────────

export interface VoiceStreamCallbacks {
  /** Called with transcript text. isFinal=true means this segment is complete. */
  onTranscript: (text: string, isFinal: boolean) => void
  /** Called on errors. fatal=true means the connection should not be retried. */
  onError: (error: string, opts?: { fatal?: boolean }) => void
  /** Called when the WebSocket closes. */
  onClose: () => void
}

export interface VoiceStreamConnection {
  /** Send a raw PCM audio chunk (16kHz, 16-bit signed LE, mono). */
  send: (audioChunk: Buffer) => void
  /** Signal end of audio. Returns when the server has flushed final transcript. */
  finalize: () => Promise<string>
  /** Close the WebSocket immediately. */
  close: () => void
  /** Check if the WebSocket is still connected. */
  isConnected: () => boolean
}

export interface VoiceStreamOptions {
  /** BCP-47 language code for STT. Default: 'en' */
  language?: string
  /** Domain-specific vocabulary hints for better recognition. */
  keyterms?: string[]
  /** WebSocket base URL override. Default: wss://api.anthropic.com */
  baseUrl?: string
}

export interface TranscribeFileOptions extends VoiceStreamOptions {
  /** Callback for interim transcripts (live preview). */
  onInterim?: (text: string) => void
  /** If true, stream at real-time pace. If false (default), stream as fast as endpoint allows. */
  realtime?: boolean
}

// ─── Voice Stream Client ─────────────────────────────────────────────

/**
 * Connect to Anthropic's voice_stream WebSocket endpoint for STT.
 *
 * Matches the exact protocol from Claude Code CLI (voiceStreamSTT.ts):
 * - URL: wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
 * - Auth: Bearer OAuth token
 * - Headers: User-Agent: claude-cli/..., x-app: cli
 * - Query: encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=en
 *
 * @param accessToken - OAuth access token (same one used for Messages API)
 * @param callbacks - Transcript/error/close callbacks
 * @param options - Language, keyterms, base URL override
 */
export async function connectVoiceStream(
  accessToken: string,
  callbacks: VoiceStreamCallbacks,
  options?: VoiceStreamOptions,
): Promise<VoiceStreamConnection> {
  const baseUrl = options?.baseUrl ?? ANTHROPIC_API_BASE

  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: String(CHANNELS),
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: options?.language ?? 'en',
  })

  if (options?.keyterms?.length) {
    for (const term of options.keyterms) {
      params.append('keyterms', term)
    }
  }

  const path = `${VOICE_STREAM_PATH}?${params.toString()}`

  // Match Claude Code CLI headers exactly (voiceStreamSTT.ts:179-183)
  const wsKey = randomBytes(16).toString('base64')

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let connected = false
  let finalized = false
  let finalizing = false
  let resolveFinalize: ((source: string) => void) | null = null
  let cancelNoDataTimer: (() => void) | null = null
  let lastTranscriptText = ''

  // Raw WebSocket over HTTPS upgrade — zero external deps
  const socket = await new Promise<import('net').Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('voice_stream WebSocket connection timeout (10s)'))
    }, 10_000)

    const url = new URL(baseUrl)
    const req = httpsRequest({
      hostname: url.hostname,
      port: url.port || 443,
      path,
      method: 'GET',
      headers: {
        [HEADER_AUTHORIZATION]: `Bearer ${accessToken}`,
        [HEADER_USER_AGENT]: `claude-cli/1.0.0 (subscriber, cli)`,
        [HEADER_X_APP]: 'cli',
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
      },
    })

    req.on('upgrade', (res, sock, _head) => {
      clearTimeout(timeout)
      // Verify WebSocket accept (RFC 6455 §4.2.2)
      const expected = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-5AB5DC11E5B3')
        .digest('base64')
      if (res.headers['sec-websocket-accept'] !== expected) {
        sock.destroy()
        reject(new Error('WebSocket handshake failed: invalid accept header'))
        return
      }
      resolve(sock)
    })

    req.on('response', (res) => {
      // 101 Switching Protocols may arrive via 'response' instead of 'upgrade'
      // in some Node.js versions — handle both paths
      if (res.statusCode === 101 && res.socket) {
        clearTimeout(timeout)
        resolve(res.socket)
        return
      }
      clearTimeout(timeout)
      reject(new Error(`WebSocket upgrade rejected: HTTP ${res.statusCode}`))
    })

    req.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`voice_stream connection failed: ${err.message}`))
    })

    req.end()
  })

  connected = true

  // ─── WebSocket frame helpers (RFC 6455) ─────────────────────────

  function wsSendText(data: string): void {
    wsSendFrame(Buffer.from(data, 'utf8'), 0x01) // text frame
  }

  function wsSendBinary(data: Buffer): void {
    wsSendFrame(data, 0x02) // binary frame
  }

  function wsSendClose(): void {
    wsSendFrame(Buffer.alloc(0), 0x08) // close frame
  }

  function wsSendFrame(payload: Buffer, opcode: number): void {
    if (socket.destroyed) return
    const mask = randomBytes(4)
    const masked = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i]! ^ mask[i % 4]!
    }

    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.alloc(6)
      header[0] = 0x80 | opcode // FIN + opcode
      header[1] = 0x80 | payload.length // MASK + length
      mask.copy(header, 2)
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
      mask.copy(header, 4)
    } else {
      header = Buffer.alloc(14)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
      mask.copy(header, 10)
    }

    socket.write(Buffer.concat([header, masked]))
  }

  // ─── WebSocket frame reader ──────────────────────────────────────

  let frameBuffer = Buffer.alloc(0)

  function processFrames(): void {
    while (frameBuffer.length >= 2) {
      const byte0 = frameBuffer[0]!
      const byte1 = frameBuffer[1]!
      const opcode = byte0 & 0x0f
      const hasMask = (byte1 & 0x80) !== 0
      let payloadLen = byte1 & 0x7f
      let headerLen = 2

      if (payloadLen === 126) {
        if (frameBuffer.length < 4) return
        payloadLen = frameBuffer.readUInt16BE(2)
        headerLen = 4
      } else if (payloadLen === 127) {
        if (frameBuffer.length < 10) return
        payloadLen = Number(frameBuffer.readBigUInt64BE(2))
        headerLen = 10
      }

      if (hasMask) headerLen += 4
      const totalLen = headerLen + payloadLen
      if (frameBuffer.length < totalLen) return

      let payload = frameBuffer.subarray(headerLen, totalLen)
      if (hasMask) {
        const maskKey = frameBuffer.subarray(headerLen - 4, headerLen)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ maskKey[i % 4]!
        }
      }

      frameBuffer = frameBuffer.subarray(totalLen)

      if (opcode === 0x01) { // text
        handleMessage(payload.toString('utf8'))
      } else if (opcode === 0x08) { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        handleClose(code, reason)
        return
      } else if (opcode === 0x09) { // ping
        wsSendFrame(payload, 0x0A) // pong
      }
      // ignore pong (0x0A) and other frames
    }
  }

  function handleMessage(text: string): void {
    let msg: { type: string; data?: string; error_code?: string; description?: string; message?: string }
    try { msg = JSON.parse(text) } catch { return }

    switch (msg.type) {
      case 'TranscriptText': {
        const transcript = msg.data
        if (finalized) cancelNoDataTimer?.()
        if (transcript) {
          lastTranscriptText = transcript
          callbacks.onTranscript(transcript, false)
        }
        break
      }
      case 'TranscriptEndpoint': {
        const finalText = lastTranscriptText
        lastTranscriptText = ''
        if (finalText) callbacks.onTranscript(finalText, true)
        if (finalized) resolveFinalize?.('post_closestream_endpoint')
        break
      }
      case 'TranscriptError': {
        const desc = msg.description ?? msg.error_code ?? 'unknown transcription error'
        if (!finalizing) callbacks.onError(desc)
        break
      }
      case 'error': {
        const errorDetail = msg.message ?? JSON.stringify(msg)
        if (!finalizing) callbacks.onError(errorDetail)
        break
      }
    }
  }

  function handleClose(code: number, reason: string): void {
    connected = false
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }
    if (lastTranscriptText) {
      const t = lastTranscriptText; lastTranscriptText = ''
      callbacks.onTranscript(t, true)
    }
    resolveFinalize?.('ws_close')
    if (!finalizing && code !== 1000 && code !== 1005) {
      callbacks.onError(`Connection closed: code ${code}${reason ? ` — ${reason}` : ''}`)
    }
    callbacks.onClose()
    socket.destroy()
  }

  socket.on('data', (chunk: Buffer) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk])
    processFrames()
  })

  socket.on('close', () => {
    if (connected) handleClose(1006, 'connection lost')
  })

  socket.on('error', (err: Error) => {
    if (!finalizing) callbacks.onError(`Socket error: ${err.message}`)
  })

  // Send initial KeepAlive (voiceStreamSTT.ts:329-330)
  wsSendText(KEEPALIVE_MSG)

  // Periodic keepalive (voiceStreamSTT.ts:333-342)
  keepaliveTimer = setInterval(() => {
    if (connected) wsSendText(KEEPALIVE_MSG)
  }, KEEPALIVE_INTERVAL_MS)

  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (!connected || finalized) return
      wsSendBinary(Buffer.from(audioChunk))
    },

    finalize(): Promise<string> {
      if (finalizing || finalized) return Promise.resolve('already_closed')
      finalizing = true

      return new Promise<string>(resolve => {
        const safetyTimer = setTimeout(() => resolveFinalize?.('safety_timeout'), FINALIZE_SAFETY_MS)
        const noDataTimer = setTimeout(() => resolveFinalize?.('no_data_timeout'), FINALIZE_NO_DATA_MS)
        cancelNoDataTimer = () => { clearTimeout(noDataTimer); cancelNoDataTimer = null }

        resolveFinalize = (source: string) => {
          clearTimeout(safetyTimer); clearTimeout(noDataTimer)
          resolveFinalize = null; cancelNoDataTimer = null
          if (lastTranscriptText) {
            const t = lastTranscriptText; lastTranscriptText = ''
            callbacks.onTranscript(t, true)
          }
          resolve(source)
        }

        if (socket.destroyed) { resolveFinalize('ws_already_closed'); return }

        setTimeout(() => {
          finalized = true
          if (connected) wsSendText(CLOSE_STREAM_MSG)
        }, 0)
      })
    },

    close(): void {
      finalized = true
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }
      connected = false
      if (!socket.destroyed) { wsSendClose(); socket.destroy() }
    },

    isConnected(): boolean { return connected && !socket.destroyed },
  }

  return connection
}

// ─── File Transcription ──────────────────────────────────────────────

/**
 * Transcribe a raw PCM file (16kHz, 16-bit signed LE, mono) via voice_stream.
 *
 * The file is streamed in chunks that approximate real-time pace to avoid
 * overwhelming the endpoint or triggering anti-abuse protections.
 *
 * @param accessToken - OAuth access token
 * @param filePath - Path to raw PCM file (or WAV — 44-byte header is auto-stripped)
 * @param options - Language, keyterms, callbacks
 * @returns Full transcription text
 */
export async function transcribeFile(
  accessToken: string,
  filePath: string,
  options?: TranscribeFileOptions,
): Promise<string> {
  const accumulated: string[] = []
  let error: string | null = null

  const conn = await connectVoiceStream(accessToken, {
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        accumulated.push(text.trim())
      } else {
        options?.onInterim?.(text)
      }
    },
    onError: (msg) => { error = msg },
    onClose: () => {},
  }, options)

  try {
    // Read file and determine if it has a WAV header
    const fileBuffer = await readFileAsBuffer(filePath)
    let pcmData = fileBuffer

    // Strip WAV header if present (44 bytes, starts with "RIFF")
    if (fileBuffer.length > 44 &&
        fileBuffer[0] === 0x52 && fileBuffer[1] === 0x49 &&
        fileBuffer[2] === 0x46 && fileBuffer[3] === 0x46) {
      pcmData = fileBuffer.subarray(44)
    }

    // Stream in chunks
    const useRealtime = options?.realtime !== false
    for (let offset = 0; offset < pcmData.length; offset += CHUNK_SIZE) {
      if (!conn.isConnected()) break
      const chunk = pcmData.subarray(offset, Math.min(offset + CHUNK_SIZE, pcmData.length))
      conn.send(chunk)

      // Pace the stream to approximate real-time
      if (useRealtime && offset + CHUNK_SIZE < pcmData.length) {
        await sleep(CHUNK_DELAY_MS)
      }
    }

    // Finalize and wait for server to flush
    await conn.finalize()
  } finally {
    conn.close()
  }

  if (error) {
    throw new Error(`Transcription error: ${error}`)
  }

  return accumulated.join(' ')
}

/**
 * Convert an audio file to raw PCM (16kHz, 16-bit signed LE, mono) using ffmpeg or sox,
 * then transcribe via voice_stream.
 *
 * Supports: .mp3, .wav, .ogg, .flac, .m4a, .webm, .opus, .aac
 *
 * @param accessToken - OAuth access token
 * @param filePath - Path to any supported audio file
 * @param options - Language, keyterms, callbacks
 * @returns Full transcription text
 */
export async function transcribeAudioFile(
  accessToken: string,
  filePath: string,
  options?: TranscribeFileOptions,
): Promise<string> {
  const accumulated: string[] = []
  let error: string | null = null

  const conn = await connectVoiceStream(accessToken, {
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        accumulated.push(text.trim())
      } else {
        options?.onInterim?.(text)
      }
    },
    onError: (msg) => { error = msg },
    onClose: () => {},
  }, options)

  try {
    // Use ffmpeg to convert to raw PCM and pipe directly to WebSocket
    const converter = findConverter()
    if (!converter) {
      throw new Error('No audio converter found. Install ffmpeg or sox.')
    }

    await streamConvertedAudio(conn, filePath, converter, options?.realtime !== false)

    await conn.finalize()
  } finally {
    conn.close()
  }

  if (error) {
    throw new Error(`Transcription error: ${error}`)
  }

  return accumulated.join(' ')
}

// ─── Microphone Recording ────────────────────────────────────────────

/**
 * Record from microphone using SoX (rec) or arecord.
 * Returns a handle to stop recording and get the audio data callback.
 *
 * Fallback chain (from Claude Code voice.ts):
 * 1. SoX `rec` (macOS/Linux)
 * 2. `arecord` (Linux ALSA)
 */
export function startMicRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
): { stop: () => void } | null {
  // Try SoX first
  if (hasCommand('rec')) {
    const child = spawn('rec', [
      '-q', '--buffer', '1024',
      '-t', 'raw', '-r', String(SAMPLE_RATE),
      '-e', 'signed', '-b', String(BITS_PER_SAMPLE),
      '-c', String(CHANNELS),
      '-', // stdout
      // Silence detection: stop after 2s of silence
      'silence', '1', '0.1', '3%', '1', '2.0', '3%',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    child.stdout?.on('data', onData)
    child.stderr?.on('data', () => {}) // consume to prevent backpressure
    child.on('close', onEnd)
    child.on('error', onEnd)

    return {
      stop() { child.kill('SIGTERM') },
    }
  }

  // Try arecord (Linux)
  if (hasCommand('arecord')) {
    const child = spawn('arecord', [
      '-f', 'S16_LE', '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS), '-t', 'raw', '-q', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    child.stdout?.on('data', onData)
    child.stderr?.on('data', () => {})
    child.on('close', onEnd)
    child.on('error', onEnd)

    return {
      stop() { child.kill('SIGTERM') },
    }
  }

  return null
}

/**
 * Check what audio recording tools are available.
 */
export function checkVoiceDeps(): { available: boolean; tool: string | null; installHint: string | null } {
  if (hasCommand('rec')) return { available: true, tool: 'sox', installHint: null }
  if (hasCommand('arecord')) return { available: true, tool: 'arecord', installHint: null }

  const hints: Record<string, string> = {
    darwin: 'brew install sox',
    linux: 'sudo apt-get install sox  # or: sudo apt-get install alsa-utils',
  }

  return {
    available: false,
    tool: null,
    installHint: hints[process.platform] ?? 'Install SoX (sox) or ALSA utils (arecord)',
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function hasCommand(cmd: string): boolean {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 3000 })
  return result.error === undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readFileAsBuffer(filePath: string): Promise<Buffer> {
  const { readFile } = await import('fs/promises')
  return readFile(filePath)
}

type Converter = 'ffmpeg' | 'sox'

function findConverter(): Converter | null {
  if (hasCommand('ffmpeg')) return 'ffmpeg'
  if (hasCommand('sox')) return 'sox'
  return null
}

async function streamConvertedAudio(
  conn: VoiceStreamConnection,
  filePath: string,
  converter: Converter,
  realtime: boolean,
): Promise<void> {
  const args = converter === 'ffmpeg'
    ? ['-i', filePath, '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1']
    : [filePath, '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed', '-b', String(BITS_PER_SAMPLE), '-c', String(CHANNELS), '-']

  const child = spawn(converter, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  return new Promise<void>((resolve, reject) => {
    let lastSendTime = Date.now()

    child.stdout?.on('data', async (chunk: Buffer) => {
      if (!conn.isConnected()) {
        child.kill('SIGTERM')
        return
      }
      conn.send(chunk)

      // Pace to approximate real-time if requested
      if (realtime) {
        const chunkDurationMs = (chunk.length / BYTES_PER_SECOND) * 1000
        const elapsed = Date.now() - lastSendTime
        const waitMs = Math.max(0, chunkDurationMs * 0.8 - elapsed)
        if (waitMs > 10) {
          child.stdout?.pause()
          await sleep(waitMs)
          child.stdout?.resume()
        }
        lastSendTime = Date.now()
      }
    })

    child.stderr?.on('data', () => {}) // consume
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`${converter} exited with code ${code}`))
      } else {
        resolve()
      }
    })
    child.on('error', reject)
  })
}
