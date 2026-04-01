#!/usr/bin/env bun
/**
 * Multi-turn conversation example.
 * 
 * Usage: bun run examples/conversation.ts
 */

import { ClaudeCodeSDK, Conversation } from '@life-ai-tools/claude-code-sdk'

const sdk = new ClaudeCodeSDK()
const conv = new Conversation(sdk, {
  model: 'claude-sonnet-4-6-20250415',
  system: 'You are a helpful coding assistant. Be concise.',
})

// Turn 1
console.log('> What is a closure in JavaScript?\n')
const reply1 = await conv.send('What is a closure in JavaScript?')
console.log(reply1.text)

// Turn 2 — model remembers context
console.log('\n> Give me an example\n')
const reply2 = await conv.send('Give me an example')
console.log(reply2.text)

console.log(`\n[${conv.turns.length} turns, history: ${conv.messageCount} messages]`)
