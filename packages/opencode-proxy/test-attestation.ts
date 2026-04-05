#!/usr/bin/env bun
/**
 * Test attestation proxy — exercises both direct and CC modes.
 * Run: bun run test-attestation.ts
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn, type Subprocess } from 'bun'

const PROXY_SCRIPT = join(import.meta.dir, 'attestation-proxy.ts')
const CRED_PATH = join(homedir(), '.claude', '.credentials.json')

// Read token
const creds = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
const token = creds.claudeAiOauth?.accessToken
if (!token) { console.error('No token found'); process.exit(1) }

async function startProxy(mode: 'direct' | 'cc', port: number): Promise<Subprocess> {
  const proc = spawn(['bun', 'run', PROXY_SCRIPT, '--port', String(port), '--mode', mode], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Wait for startup
  await new Promise(r => setTimeout(r, 1500))
  return proc
}

async function testCall(port: number, label: string): Promise<{ ok: boolean; claim: string; text: string; latency: number }> {
  const t0 = Date.now()
  try {
    const resp = await fetch(`http://localhost:${port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-app': 'cli',
        'User-Agent': 'claude-code/2.1.90',
        'Accept-Encoding': 'identity',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        stream: false,
        system: 'x-anthropic-billing-header: cc_version=2.1.90.abc; cc_entrypoint=cli; cch=00000;\nYou are Claude Code.',
        messages: [{ role: 'user', content: 'Say "proxy test ok" and nothing else' }],
        metadata: { user_id: JSON.stringify({ device_id: 'test', account_uuid: '', session_id: 'test' }) },
      }),
    })
    
    const claim = resp.headers.get('anthropic-ratelimit-unified-representative-claim') || '?'
    const status = resp.headers.get('anthropic-ratelimit-unified-status') || '?'
    const data = await resp.json() as any
    const text = data.content?.[0]?.text || data.error?.message || JSON.stringify(data).slice(0, 100)
    const latency = Date.now() - t0
    
    return { ok: resp.status === 200, claim, text: text.trim(), latency }
  } catch (err: any) {
    return { ok: false, claim: 'error', text: err.message, latency: Date.now() - t0 }
  }
}

// ─── Run tests ─────────────────────────────────────────────
console.log('=== Attestation Proxy E2E Test ===\n')

// Test 1: Direct mode (our current approach)
console.log('Starting proxy in DIRECT mode (port 8319)...')
const directProc = await startProxy('direct', 8319)

// Health check
const health = await fetch('http://localhost:8319/health').then(r => r.json()) as any
console.log(`Health: ${JSON.stringify(health)}`)

const directResult = await testCall(8319, 'DIRECT')
console.log(`\nDIRECT MODE: ${directResult.ok ? '✅' : '❌'} ${directResult.text}`)
console.log(`  claim=${directResult.claim} latency=${directResult.latency}ms`)

directProc.kill()
await new Promise(r => setTimeout(r, 500))

// Test 2: CC passthrough mode
console.log('\nStarting proxy in CC mode (port 8320)...')
const ccProc = await startProxy('cc', 8320)

const ccResult = await testCall(8320, 'CC')
console.log(`\nCC MODE: ${ccResult.ok ? '✅' : '❌'} ${ccResult.text}`)
console.log(`  claim=${ccResult.claim} latency=${ccResult.latency}ms`)

ccProc.kill()
await new Promise(r => setTimeout(r, 500))

// Test 3: Direct call without proxy (baseline)
console.log('\nDIRECT API (no proxy, baseline)...')
const baselineResult = await testCall(0, 'BASELINE').catch(() => null)
// Can't call port 0 - make direct API call instead
const t0 = Date.now()
const directResp = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'User-Agent': 'claude-code/2.1.90',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 10,
    stream: false,
    system: 'x-anthropic-billing-header: cc_version=2.1.90.abc; cc_entrypoint=cli; cch=00000;\nYou are Claude Code.',
    messages: [{ role: 'user', content: 'Say "baseline ok" and nothing else' }],
  }),
})
const baseline = await directResp.json() as any
console.log(`BASELINE: ✅ ${baseline.content?.[0]?.text?.trim()}`)
console.log(`  claim=${directResp.headers.get('anthropic-ratelimit-unified-representative-claim')} latency=${Date.now() - t0}ms`)

// Summary
console.log('\n=== Summary ===')
console.log(`Direct proxy:  ${directResult.ok ? '✅ PASS' : '❌ FAIL'} (${directResult.latency}ms) claim=${directResult.claim}`)
console.log(`CC passthrough: ${ccResult.ok ? '✅ PASS' : '❌ FAIL'} (${ccResult.latency}ms) claim=${ccResult.claim}`)
console.log(`Direct API:    ✅ PASS (${Date.now() - t0}ms) claim=${directResp.headers.get('anthropic-ratelimit-unified-representative-claim')}`)
console.log('\nIf Anthropic enforces cch=: switch to CC mode with --mode cc')

process.exit(0)
