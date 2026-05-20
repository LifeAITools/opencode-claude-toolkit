import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { MessageParam } from './types.js'

export interface SessionEntry {
  type: 'user' | 'assistant'
  uuid: string
  parentUuid: string | null
  timestamp: number
  content: MessageParam['content']
}

/** Save conversation messages to JSONL file (CLI-compatible format) */
export function saveSession(path: string, messages: readonly MessageParam[]): void {
  mkdirSync(dirname(path), { recursive: true })
  let parentUuid: string | null = null
  const lines: string[] = []

  for (const msg of messages) {
    const uuid = randomUUID()
    const entry: SessionEntry = {
      type: msg.role === 'user' ? 'user' : 'assistant',
      uuid,
      parentUuid,
      timestamp: Date.now(),
      content: msg.content,
    }
    lines.push(JSON.stringify(entry))
    parentUuid = uuid
  }

  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

/** Load conversation messages from JSONL file */
export function loadSession(path: string): MessageParam[] {
  const raw = readFileSync(path, 'utf8')
  const messages: MessageParam[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'user' || entry.type === 'assistant') {
      messages.push({
        role: entry.type === 'user' ? 'user' : 'assistant',
        content: entry.content,
      })
    }
  }

  return messages
}
