#!/usr/bin/env bun
/**
 * Example: Transcribe an audio file via Anthropic's voice_stream endpoint.
 *
 * Usage:
 *   bun run examples/voice-transcribe.ts <audio-file> [language]
 *
 * Supports:
 *   - Raw PCM files (16kHz, 16-bit signed LE, mono)
 *   - WAV files (header auto-stripped)
 *   - Any audio format if ffmpeg/sox installed (.mp3, .ogg, .flac, .m4a, etc.)
 *
 * Prerequisites:
 *   - Logged in to Claude (credentials in ~/.claude/.credentials.json)
 *   - For non-PCM/WAV files: ffmpeg or sox installed
 */

import { readFileSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import { connectVoiceStream, transcribeFile, transcribeAudioFile } from '../src/voice.js'

async function main() {
  const filePath = process.argv[2]
  const language = process.argv[3] ?? 'en'

  if (!filePath) {
    console.error('Usage: bun run examples/voice-transcribe.ts <audio-file> [language]')
    console.error('')
    console.error('Examples:')
    console.error('  bun run examples/voice-transcribe.ts recording.wav')
    console.error('  bun run examples/voice-transcribe.ts meeting.mp3 ru')
    console.error('  bun run examples/voice-transcribe.ts voice.raw en')
    process.exit(1)
  }

  // Load OAuth token
  const credPath = join(homedir(), '.claude', '.credentials.json')
  let accessToken: string
  try {
    const raw = readFileSync(credPath, 'utf8')
    const creds = JSON.parse(raw)
    accessToken = creds.claudeAiOauth?.accessToken
    if (!accessToken) throw new Error('No accessToken found')
  } catch (err) {
    console.error(`Failed to read credentials from ${credPath}`)
    console.error('Run: claude login (or opencode providers login -p claude-max)')
    process.exit(1)
  }

  const ext = extname(filePath).toLowerCase()
  const isRawOrWav = ext === '.raw' || ext === '.pcm' || ext === '.wav'

  console.error(`Transcribing: ${filePath}`)
  console.error(`Language: ${language}`)
  console.error(`Format: ${isRawOrWav ? 'raw PCM / WAV (direct)' : `${ext} (via ffmpeg/sox)`}`)
  console.error('')

  const startTime = Date.now()

  try {
    let transcript: string

    if (isRawOrWav) {
      transcript = await transcribeFile(accessToken, filePath, {
        language,
        onInterim: (text) => {
          process.stderr.write(`\r  [interim] ${text}`)
        },
      })
    } else {
      transcript = await transcribeAudioFile(accessToken, filePath, {
        language,
        onInterim: (text) => {
          process.stderr.write(`\r  [interim] ${text}`)
        },
      })
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    process.stderr.write('\r' + ' '.repeat(80) + '\r') // clear interim line
    console.error(`Done in ${elapsed}s`)
    console.error('')

    // Output transcript to stdout (can be piped)
    console.log(transcript)
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`)
    process.exit(1)
  }
}

main()
