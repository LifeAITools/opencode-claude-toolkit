import { createSignal, Show } from "solid-js"
import { spawn, spawnSync } from "child_process"
import { request as httpsRequest } from "https"
import { randomBytes, createHash } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─── Voice Constants ───────────────────────────────────────

const VOICE_STREAM_PATH = "/api/ws/speech_to_text/voice_stream"
const VOICE_KEEPALIVE_MS = 8000
const VOICE_SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS = 16

// ─── SolidJS Signals (module-level) ───────────────────────

const [voiceState, setVoiceState] = createSignal<
  "idle" | "recording" | "processing"
>("idle")
const [interimText, setInterimText] = createSignal("")
const [voiceError, setVoiceError] = createSignal<string | null>(null)

// ─── Module-level state for active recording / WS ─────────

let activeMic: { stop: () => void } | null = null
let activeWS: { sendAudio: (b: Buffer) => void; sendCloseStream: () => void; close: () => void } | null = null
let activeSocket: ReturnType<typeof import("net").Socket.prototype.on> | null =
  null
let keepAliveTimer: ReturnType<typeof setInterval> | null = null

// ─── Helper: Check Voice Dependencies ─────────────────────

function hasCmd(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0
}

/** Test that a recording tool actually captures audio (not just installed) */
function testRecordingTool(tool: string): boolean {
  try {
    const args = tool === "rec"
      ? ["-q", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"]
      : ["-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-q", "-"]
    const proc = spawnSync(tool, args, { timeout: 2000, maxBuffer: 64 * 1024, stdio: ["pipe", "pipe", "pipe"] })
    // If we got any audio data, the tool works
    return proc.stdout !== null && proc.stdout.length > 100
  } catch { return false }
}

function tryAutoInstall(): string | null {
  // Detect package manager and try to install sox automatically
  const installers: [string, string[]][] = [
    ["apt", ["apt-get", "install", "-y", "sox", "alsa-utils"]],
    ["brew", ["brew", "install", "sox"]],
    ["pacman", ["pacman", "-S", "--noconfirm", "sox", "alsa-utils"]],
    ["dnf", ["dnf", "install", "-y", "sox", "alsa-utils"]],
  ]

  for (const [pm, cmd] of installers) {
    if (!hasCmd(pm)) continue
    try {
      // Try with sudo for apt/pacman/dnf, without for brew
      const needsSudo = pm !== "brew"
      const fullCmd = needsSudo ? ["sudo", ...cmd] : cmd
      const result = spawnSync(fullCmd[0], fullCmd.slice(1), { encoding: "utf8", timeout: 60_000, stdio: "pipe" })
      if (result.status === 0) {
        // Verify installation
        if (hasCmd("rec")) return "rec"
        if (hasCmd("arecord")) return "arecord"
      }
    } catch {}
  }
  return null
}

function checkVoiceDeps(): { tool: string } | null {
  // Test that tools actually capture audio, not just exist.
  // SoX `rec` can be installed but produce 0 bytes if no audio backend is configured.
  // Prefer whichever tool actually works.
  if (hasCmd("rec") && testRecordingTool("rec")) return { tool: "rec" }
  if (hasCmd("arecord") && testRecordingTool("arecord")) return { tool: "arecord" }

  // Tools exist but don't capture? Try the other one without test
  if (hasCmd("arecord")) return { tool: "arecord" }
  if (hasCmd("rec")) return { tool: "rec" }

  // Not found — try auto-install
  const installed = tryAutoInstall()
  if (installed) return { tool: installed }

  return null
}

// ─── Helper: Read OAuth Token ─────────────────────────────

function getOAuthToken(): string | null {
  const candidates = [
    join(homedir(), ".claude", ".credentials.json"),
    join(process.cwd(), ".claude", ".credentials.json"),
  ]

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8")
      const data = JSON.parse(raw)
      const token = data?.claudeAiOauth?.accessToken
      if (typeof token === "string" && token.length > 0) return token
    } catch {
      // Try next candidate
    }
  }
  return null
}

// ─── Helper: Compute RMS of 16-bit PCM Buffer ────────────

function computeRMS(buf: Buffer): number {
  if (buf.length < 2) return 0
  const samples = buf.length >> 1 // 16-bit = 2 bytes per sample
  let sumSq = 0
  for (let i = 0; i < samples; i++) {
    const sample = buf.readInt16LE(i * 2)
    sumSq += sample * sample
  }
  return Math.sqrt(sumSq / samples)
}

// ─── Microphone Recording ─────────────────────────────────

function startMicRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void
): { stop: () => void } {
  const deps = checkVoiceDeps()
  if (!deps) throw new Error("No recording tool found (need sox or alsa-utils)")

  let proc: ReturnType<typeof spawn>

  if (deps.tool === "rec") {
    // SoX rec: output raw PCM to stdout
    proc = spawn(
      "rec",
      [
        "-q", // quiet
        "-r",
        String(VOICE_SAMPLE_RATE),
        "-c",
        String(CHANNELS),
        "-b",
        String(BITS),
        "-e",
        "signed-integer",
        "-t",
        "raw",
        "-", // stdout
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
  } else {
    // arecord: ALSA raw PCM to stdout
    proc = spawn(
      "arecord",
      [
        "-q",
        "-f",
        `S${BITS}_LE`,
        "-r",
        String(VOICE_SAMPLE_RATE),
        "-c",
        String(CHANNELS),
        "-t",
        "raw",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
  }

  proc.stdout!.on("data", (chunk: Buffer) => {
    onData(chunk)
  })

  proc.on("close", () => {
    onEnd()
  })

  proc.on("error", (err) => {
    setVoiceError(`Mic process error: ${err.message}`)
    onEnd()
  })

  return {
    stop() {
      try {
        proc.kill("SIGTERM")
      } catch {
        // Already dead
      }
    },
  }
}

// ─── RFC 6455 WebSocket Frame Helpers ─────────────────────

function buildWsFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length
  const maskKey = randomBytes(4)
  let headerLen: number

  if (len < 126) {
    headerLen = 6 // 2 byte header + 4 byte mask
  } else if (len < 65536) {
    headerLen = 8 // 2 + 2 + 4
  } else {
    headerLen = 14 // 2 + 8 + 4
  }

  const frame = Buffer.alloc(headerLen + len)
  // FIN + opcode
  frame[0] = 0x80 | opcode

  if (len < 126) {
    frame[1] = 0x80 | len // MASK bit set
    maskKey.copy(frame, 2)
  } else if (len < 65536) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(len, 2)
    maskKey.copy(frame, 4)
  } else {
    frame[1] = 0x80 | 127
    // Write 64-bit length (high 32 bits = 0 for reasonable sizes)
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(len, 6)
    maskKey.copy(frame, 10)
  }

  // Mask payload
  const maskOffset = headerLen - 4 // mask key is last 4 bytes of header
  for (let i = 0; i < len; i++) {
    frame[headerLen + i] = payload[i] ^ maskKey[i % 4]
  }

  return frame
}

function buildTextFrame(text: string): Buffer {
  return buildWsFrame(Buffer.from(text, "utf8"), 0x01)
}

function buildBinaryFrame(data: Buffer): Buffer {
  return buildWsFrame(data, 0x02)
}

function buildCloseFrame(code: number = 1000): Buffer {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(code, 0)
  return buildWsFrame(payload, 0x08)
}

// ─── WebSocket Frame Parser ───────────────────────────────

interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

function parseWsFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = []
  let offset = 0

  while (offset < buf.length) {
    if (buf.length - offset < 2) break

    const byte0 = buf[offset]
    const byte1 = buf[offset + 1]
    const fin = !!(byte0 & 0x80)
    const opcode = byte0 & 0x0f
    const masked = !!(byte1 & 0x80)
    let payloadLen = byte1 & 0x7f
    let headerLen = 2

    if (payloadLen === 126) {
      if (buf.length - offset < 4) break
      payloadLen = buf.readUInt16BE(offset + 2)
      headerLen = 4
    } else if (payloadLen === 127) {
      if (buf.length - offset < 10) break
      // Read lower 32 bits (safe for practical sizes)
      payloadLen = buf.readUInt32BE(offset + 6)
      headerLen = 10
    }

    if (masked) headerLen += 4
    if (buf.length - offset < headerLen + payloadLen) break

    let payload = buf.subarray(
      offset + headerLen,
      offset + headerLen + payloadLen
    )

    if (masked) {
      const maskKey = buf.subarray(offset + headerLen - 4, offset + headerLen)
      payload = Buffer.from(payload) // copy to unmask
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }

    frames.push({ fin, opcode, payload })
    offset += headerLen + payloadLen
  }

  return { frames, rest: buf.subarray(offset) }
}

// ─── WebSocket STT Connection ─────────────────────────────

interface VoiceCallbacks {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (err: string) => void
  onClose: () => void
}

function connectVoiceWS(
  token: string,
  callbacks: VoiceCallbacks
): {
  sendAudio: (chunk: Buffer) => void
  sendCloseStream: () => void
  close: () => void
} {
  // Generate WebSocket accept key
  const wsKey = randomBytes(16).toString("base64")
  const expectedAccept = createHash("sha1")
    .update(wsKey + "258EAFA5-E914-47DA-95CA-5AB9FC19B34A")
    .digest("base64")

  let connected = false
  let recvBuf = Buffer.alloc(0)

  const req = httpsRequest(
    {
      hostname: "api.anthropic.com",
      port: 443,
      path: VOICE_STREAM_PATH,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": wsKey,
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2024-10-22",
        "Content-Type": "application/json",
      },
    },
    (res) => {
      // If we get a normal HTTP response instead of upgrade, it's an error
      let body = ""
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      res.on("end", () => {
        callbacks.onError(
          `Voice WS HTTP ${res.statusCode}: ${body.slice(0, 200)}`
        )
        callbacks.onClose()
      })
    }
  )

  req.on("upgrade", (res, socket, head) => {
    // Validate WebSocket handshake
    const accept = res.headers["sec-websocket-accept"]
    if (accept !== expectedAccept) {
      callbacks.onError("WebSocket handshake failed: invalid accept header")
      socket.destroy()
      callbacks.onClose()
      return
    }

    connected = true
    activeSocket = socket as any

    // Process any data that came with the upgrade
    if (head && head.length > 0) {
      recvBuf = Buffer.concat([recvBuf, head])
    }

    // Send initial configuration message
    const configMsg = JSON.stringify({
      type: "StreamStart",
      config: {
        encoding: "pcm_s16le",
        sample_rate: VOICE_SAMPLE_RATE,
        channels: CHANNELS,
      },
    })
    socket.write(buildTextFrame(configMsg))

    // Start keepalive
    keepAliveTimer = setInterval(() => {
      if (connected) {
        try {
          const ping = JSON.stringify({ type: "KeepAlive" })
          socket.write(buildTextFrame(ping))
        } catch {
          // Socket may be dead
        }
      }
    }, VOICE_KEEPALIVE_MS)

    socket.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk])
      const { frames, rest } = parseWsFrames(recvBuf)
      recvBuf = rest

      for (const frame of frames) {
        if (frame.opcode === 0x01) {
          // Text frame — JSON message
          try {
            const msg = JSON.parse(frame.payload.toString("utf8"))
            handleVoiceMessage(msg, callbacks)
          } catch {
            // Malformed JSON, skip
          }
        } else if (frame.opcode === 0x08) {
          // Close frame
          connected = false
          socket.end()
          callbacks.onClose()
        } else if (frame.opcode === 0x09) {
          // Ping → Pong
          socket.write(buildWsFrame(frame.payload, 0x0a))
        }
        // 0x0A = pong, ignore
      }
    })

    socket.on("close", () => {
      connected = false
      clearKeepAlive()
      callbacks.onClose()
    })

    socket.on("error", (err) => {
      connected = false
      clearKeepAlive()
      callbacks.onError(`Voice WS socket error: ${err.message}`)
      callbacks.onClose()
    })
  })

  req.on("error", (err) => {
    callbacks.onError(`Voice WS request error: ${err.message}`)
    callbacks.onClose()
  })

  req.end()

  return {
    sendAudio(chunk: Buffer) {
      if (connected && activeSocket) {
        try {
          ;(activeSocket as any).write(buildBinaryFrame(chunk))
        } catch {
          // Socket gone
        }
      }
    },
    sendCloseStream() {
      if (connected && activeSocket) {
        try {
          const msg = JSON.stringify({ type: "CloseStream" })
          ;(activeSocket as any).write(buildTextFrame(msg))
        } catch {
          // Socket gone
        }
      }
    },
    close() {
      connected = false
      clearKeepAlive()
      if (activeSocket) {
        try {
          ;(activeSocket as any).write(buildCloseFrame(1000))
          ;(activeSocket as any).end()
        } catch {
          // Already closed
        }
        activeSocket = null
      }
    },
  }
}

// ─── Voice Message Handler ────────────────────────────────

function handleVoiceMessage(msg: any, callbacks: VoiceCallbacks) {
  if (!msg || !msg.type) return

  switch (msg.type) {
    case "TranscriptText":
      // Interim transcript update
      if (typeof msg.text === "string") {
        callbacks.onInterim(msg.text)
      }
      break

    case "TranscriptEndpoint":
      // Final transcript — speech segment complete
      if (typeof msg.text === "string" && msg.text.trim().length > 0) {
        callbacks.onFinal(msg.text.trim())
      }
      break

    case "Error":
      callbacks.onError(
        `Voice API error: ${msg.message ?? msg.error ?? "unknown"}`
      )
      break

    case "StreamStarted":
      // Confirmation from server — recording active
      break

    case "KeepAlive":
      // Server keepalive ack
      break

    default:
      // Unknown message type, ignore
      break
  }
}

// ─── Cleanup Helpers ──────────────────────────────────────

function clearKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

function cleanupVoice() {
  if (activeMic) {
    activeMic.stop()
    activeMic = null
  }
  clearKeepAlive()
  if (activeSocket) {
    try {
      ;(activeSocket as any).destroy()
    } catch {
      // Already dead
    }
    activeSocket = null
  }
}

// ─── Text Injection into Prompt ───────────────────────────

async function injectText(api: any, text: string) {
  // Method 1: typed SDK client (may not have appendPrompt method)
  try {
    if (api.client?.tui?.appendPrompt) {
      await api.client.tui.appendPrompt({ body: { text } })
      return
    }
  } catch {}

  // Method 2: scopedClient (may have different method shape)
  try {
    const client = api.scopedClient?.()
    if (client?.tui?.appendPrompt) {
      await client.tui.appendPrompt({ body: { text } })
      return
    }
  } catch {}

  // Method 3: raw HTTP — correct path is /tui/append-prompt (NOT /tui/prompt-append)
  // Get server URL from client's baseUrl or fall back to environment
  try {
    const baseUrl = api.client?.baseUrl ?? `http://localhost:${process.env.OPENCODE_PORT ?? "3000"}`
    const resp = await fetch(`${baseUrl}/tui/append-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (resp.ok) return
  } catch {}

  // Method 4: try the Bus event directly if accessible
  try {
    api.event?.emit?.("tui.prompt.append", { text })
  } catch {}

  setVoiceError("Failed to inject text — check opencode server")
}

// ─── Voice Controller ─────────────────────────────────────

// Cache dep check result (slow spawnSync — only check once)
let cachedDeps: { tool: string } | null | undefined = undefined

function stopAndSubmit(api: any) {
  if (voiceState() !== "recording") return
  setVoiceState("processing")

  if (activeMic) { activeMic.stop(); activeMic = null }

  // Send CloseStream to get final transcript
  if (activeWS) activeWS.sendCloseStream()

  // Fallback: if no final arrives in 3s, submit interim
  setTimeout(() => {
    if (voiceState() === "processing") {
      const text = interimText().trim()
      if (text) {
        injectText(api, text).then(() => { setVoiceState("idle"); setInterimText("") })
      } else {
        setVoiceState("idle"); setInterimText("")
      }
      cleanupVoice()
    }
  }, 3000)
}

function stopAndCancel(_api: any) {
  if (voiceState() === "idle") return
  setVoiceState("idle")
  setInterimText("")
  setVoiceError(null)
  if (activeMic) { activeMic.stop(); activeMic = null }
  cleanupVoice()
}

async function toggleVoice(api: any) {
  if (voiceState() === "recording") {
    stopAndSubmit(api)
    return
  }

  // ── Start recording ──
  setVoiceError(null)
  setInterimText("")

  // 1. Check dependencies (cached — only runs spawnSync once)
  if (cachedDeps === undefined) cachedDeps = checkVoiceDeps()
  const deps = cachedDeps
  if (!deps) {
    setVoiceError(
      "Voice requires sox or alsa-utils. Auto-install failed. Try manually: sudo apt install sox"
    )
    return
  }

  // 2. Get OAuth token
  const token = getOAuthToken()
  if (!token) {
    setVoiceError(
      "No OAuth token found. Login first: opencode providers login -p claude-max"
    )
    return
  }

  // 3. Read silence config from kv
  const silenceMs: number = api.kv.get("voiceSilenceMs") ?? 3000
  const silenceThreshold = 500

  // 4. Track silence for auto-stop
  // DON'T set lastVoiceTs until mic actually starts producing audio
  let lastVoiceTs = 0  // 0 = mic not started yet, silence detection disabled
  let gotFirstChunk = false
  let finalTranscript = ""
  let gotFinal = false

  // Buffer audio chunks while WebSocket connects
  const audioBuffer: Buffer[] = []
  let wsReady = false

  // 5. Start microphone FIRST (immediate — no network delay)
  setVoiceState("recording")
  try {
    activeMic = startMicRecording(
      (chunk: Buffer) => {
        if (!gotFirstChunk) {
          gotFirstChunk = true
          lastVoiceTs = Date.now()  // Start silence timer only on first audio
        }

        // Buffer or send audio
        if (wsReady && activeWS) {
          activeWS.sendAudio(chunk)
        } else {
          audioBuffer.push(chunk)
        }

        // Silence detection: only after we've been recording for at least 1 second
        if (gotFirstChunk && Date.now() - lastVoiceTs > 1000) {
          const rms = computeRMS(chunk)
          if (rms >= silenceThreshold) {
            lastVoiceTs = Date.now()
          } else if (Date.now() - lastVoiceTs > silenceMs && !gotFinal) {
            // Silence exceeded threshold — auto-stop
            if (activeWS) activeWS.sendCloseStream()
            setVoiceState("processing")
            if (activeMic) { activeMic.stop(); activeMic = null }
            // Wait for final transcript with timeout
            setTimeout(() => {
              if (!gotFinal) {
                const interim = interimText()
                if (interim.trim().length > 0) {
                  injectText(api, interim.trim()).then(() => { setVoiceState("idle"); setInterimText("") })
                } else {
                  setVoiceState("idle"); setInterimText("")
                }
                if (activeWS) activeWS.close()
              }
            }, 3000)
          }
        }
      },
      () => {
        // Mic ended (process exited)
        if (voiceState() === "recording" && activeWS) {
          activeWS.sendCloseStream()
          setVoiceState("processing")

          // Fallback timeout
          setTimeout(() => {
            if (!gotFinal) {
              const interim = interimText()
              if (interim.trim().length > 0) {
                injectText(api, interim.trim())
              }
              setVoiceState("idle")
              setInterimText("")
              if (activeWS) activeWS.close()
            }
          }, 3000)
        }
      }
    )
  } catch (err: any) {
    setVoiceError(`Failed to start mic: ${err.message}`)
    setVoiceState("idle")
    return
  }

  // 6. Connect WebSocket AFTER mic starts (so audio buffers during connect)
  const ws = connectVoiceWS(token, {
    onInterim(text: string) {
      setInterimText(text)
      lastVoiceTs = Date.now()
    },
    onFinal(text: string) {
      finalTranscript = text
      gotFinal = true
      setVoiceState("processing")
      injectText(api, finalTranscript).then(() => {
        setVoiceState("idle")
        setInterimText("")
      })
      if (activeMic) { activeMic.stop(); activeMic = null }
      cleanupVoice()
    },
    onError(err: string) {
      setVoiceError(err)
      setVoiceState("idle")
      cleanupVoice()
    },
    onClose() {
      if (!gotFinal && voiceState() !== "idle") setVoiceState("idle")
    },
  })
  activeWS = ws
  wsReady = true

  // Flush buffered audio
  for (const chunk of audioBuffer) {
    ws.sendAudio(chunk)
  }
  audioBuffer.length = 0
}

// ─── VoiceOverlay Component ───────────────────────────────

function VoiceOverlay(props: { api: any }) {
  // Import useKeyboard from @opentui/solid (available in TUI plugin runtime)
  let useKeyboard: any
  try {
    useKeyboard = require("@opentui/solid").useKeyboard
  } catch {
    try {
      useKeyboard = (globalThis as any).__opentui_useKeyboard
    } catch {}
  }

  // Register global keyboard handler for voice hotkeys
  // Claude Code uses: hold Space (5 rapid presses) or modifier+key (instant)
  // We use: Alt+V to start/stop (modifier = instant, no conflict with typing)
  //         Escape to cancel while recording
  if (useKeyboard) {
    useKeyboard((evt: any) => {
      // Alt+V — toggle voice (no conflict: Alt+V isn't used by opencode or terminals)
      if (evt.meta && evt.name === "v" && !evt.ctrl && !evt.shift) {
        toggleVoice(props.api)
        return
      }
      // Ctrl+Alt+V — same (fallback if Alt+V is intercepted by OS/terminal)
      if (evt.ctrl && evt.meta && evt.name === "v") {
        toggleVoice(props.api)
        return
      }
      // Escape while recording — cancel (discard)
      if (evt.name === "escape" && voiceState() === "recording") {
        stopAndCancel(props.api)
        return
      }
    })
  }

  return (
    <Show when={voiceState() !== "idle"}>
      <box
        position="absolute"
        bottom={1}
        right={2}
        maxWidth={50}
        paddingLeft={1}
        paddingRight={1}
        borderStyle="round"
      >
        <text bold>
          {voiceState() === "recording"
            ? "Recording... (Alt+V to stop & submit, Esc to cancel)"
            : "Processing..."}
        </text>
        <text wrap="truncate">{interimText() || "Listening..."}</text>
        <Show when={voiceError()}>
          <text bold>{voiceError()}</text>
        </Show>
      </box>
    </Show>
  )
}

// ─── Plugin Registration ──────────────────────────────────

const tui = async (api: any) => {
  // Register app slot for overlay
  api.slots.register({
    order: 200,
    slots: {
      app() {
        return <VoiceOverlay api={api} />
      },
    },
  })

  // Initialize voice config defaults
  if (api.kv.get("voiceEnabled") === undefined) api.kv.set("voiceEnabled", true)
  if (api.kv.get("voiceSilenceMs") === undefined)
    api.kv.set("voiceSilenceMs", 3000)

  // Pre-cache deps on plugin load (async, doesn't block)
  setTimeout(() => { if (cachedDeps === undefined) cachedDeps = checkVoiceDeps() }, 100)

  // Voice commands
  api.command.register(() => {
    const recording = voiceState() === "recording"
    const cmds: any[] = [
      {
        title: recording ? "Voice: Stop & Submit" : "Voice: Start Recording",
        value: "voice.toggle",
        slash: { name: "voice", aliases: ["v"] },
        category: "Provider",
        onSelect() { toggleVoice(api); api.ui.dialog.clear() },
      },
    ]

    // Only show stop/cancel when recording
    if (recording) {
      cmds.push({
        title: "Voice: Cancel (discard)",
        value: "voice.cancel",
        slash: { name: "vcancel", aliases: ["vc"] },
        category: "Provider",
        onSelect() { stopAndCancel(api); api.ui.dialog.clear() },
      })
    }

    return cmds
  })

  // Cleanup on plugin dispose
  api.lifecycle.onDispose(() => {
    cleanupVoice()
    setVoiceState("idle")
    setInterimText("")
    setVoiceError(null)
  })
}

export default { id: "opencode-claude-max-voice", tui }
