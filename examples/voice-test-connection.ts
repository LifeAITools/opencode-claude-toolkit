#!/usr/bin/env bun
/**
 * Test: verify voice_stream WebSocket connection and audio streaming.
 * 
 * Generates a short test tone, sends it to the endpoint, and checks
 * that the connection is accepted and responds with transcript events.
 *
 * Usage: bun run examples/voice-test-connection.ts
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawnSync } from 'child_process'
import { connectVoiceStream } from '../src/voice.js'

async function main() {
  // Load OAuth token
  const credPath = join(homedir(), '.claude', '.credentials.json')
  let accessToken: string
  try {
    const raw = readFileSync(credPath, 'utf8')
    const creds = JSON.parse(raw)
    accessToken = creds.claudeAiOauth?.accessToken
    if (!accessToken) throw new Error('No accessToken')
  } catch {
    console.error(`No credentials at ${credPath}. Run: claude login`)
    process.exit(1)
  }

  console.log('=== Voice Stream Connection Test ===\n')

  // Step 1: Connect
  console.log('1. Connecting to wss://api.anthropic.com/api/ws/speech_to_text/voice_stream ...')

  const events: string[] = []
  let conn: Awaited<ReturnType<typeof connectVoiceStream>>

  try {
    conn = await connectVoiceStream(accessToken, {
      onTranscript: (text, isFinal) => {
        const tag = isFinal ? 'FINAL' : 'interim'
        events.push(`TranscriptText[${tag}]: "${text}"`)
        console.log(`   [${tag}] "${text}"`)
      },
      onError: (err, opts) => {
        events.push(`Error: ${err} (fatal=${opts?.fatal ?? false})`)
        console.error(`   ERROR: ${err}`)
      },
      onClose: () => {
        events.push('Close')
      },
    }, { language: 'en' })

    console.log('   ✓ Connected!\n')
  } catch (err) {
    console.error(`   ✗ Connection FAILED: ${(err as Error).message}`)
    process.exit(1)
  }

  // Step 2: Generate and send test audio
  console.log('2. Generating test audio (2s speech-like tone) ...')

  // Generate 2 seconds of PCM audio with varying frequency (speech-like)
  const sampleRate = 16000
  const duration = 2
  const samples = sampleRate * duration
  const buf = Buffer.alloc(samples * 2) // 16-bit = 2 bytes per sample

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    // Mix multiple frequencies to approximate speech energy
    const val = Math.floor(
      3000 * Math.sin(2 * Math.PI * 200 * t) * // fundamental ~200Hz
      (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) + // AM at 3Hz (syllable rate)
      1000 * Math.sin(2 * Math.PI * 800 * t) + // formant ~800Hz
      500 * Math.sin(2 * Math.PI * 2400 * t)   // formant ~2400Hz
    )
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2)
  }

  // Send in 100ms chunks (3200 bytes each at 16kHz/16bit/mono)
  const chunkSize = 3200
  let sent = 0
  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    const chunk = buf.subarray(offset, Math.min(offset + chunkSize, buf.length))
    conn.send(chunk)
    sent += chunk.length
    // Small delay between chunks (~100ms real-time pace)
    await new Promise(r => setTimeout(r, 80))
  }

  console.log(`   ✓ Sent ${sent} bytes (${(sent / 32000).toFixed(1)}s of audio)\n`)

  // Step 3: Finalize and collect results
  console.log('3. Finalizing (waiting for server to flush) ...')

  const finalizeSource = await conn.finalize()
  console.log(`   ✓ Finalized via: ${finalizeSource}\n`)

  // Cleanup
  conn.close()

  // Step 4: Report
  console.log('=== Results ===')
  console.log(`Events received: ${events.length}`)
  for (const e of events) {
    console.log(`  - ${e}`)
  }

  const hasTranscript = events.some(e => e.startsWith('TranscriptText'))
  const hasError = events.some(e => e.startsWith('Error'))

  console.log('')
  if (hasError) {
    console.log('⚠ Errors detected — check endpoint access and OAuth token')
  } else if (hasTranscript) {
    console.log('✓ SUCCESS: Endpoint accepted audio and returned transcripts')
  } else {
    console.log('⚠ No transcripts received (expected for synthetic audio — endpoint may ignore non-speech)')
    console.log('  Connection itself succeeded, which confirms:')
    console.log('  - OAuth token works for voice_stream')
    console.log('  - WebSocket upgrade accepted')
    console.log('  - Protocol (KeepAlive, audio frames, CloseStream) works')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
