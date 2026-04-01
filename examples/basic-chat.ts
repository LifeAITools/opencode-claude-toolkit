#!/usr/bin/env bun
/**
 * Basic streaming chat example using claude-code-sdk.
 * 
 * Usage: bun run examples/basic-chat.ts "Your question here"
 */

import { ClaudeCodeSDK } from '@life-ai-tools/claude-code-sdk'

const sdk = new ClaudeCodeSDK()
const question = process.argv[2] ?? 'What is the meaning of life?'

console.log(`\n> ${question}\n`)

for await (const event of sdk.stream({
  model: 'claude-sonnet-4-6-20250415',
  messages: [{ role: 'user', content: question }],
  maxTokens: 2048,
})) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text)
      break
    case 'thinking_delta':
      // Uncomment to see thinking:
      // process.stdout.write(`[think] ${event.text}`)
      break
    case 'message_stop':
      console.log(`\n\n[tokens: in=${event.usage.inputTokens} out=${event.usage.outputTokens}]`)
      break
    case 'error':
      console.error('\nError:', event.error.message)
      break
  }
}
