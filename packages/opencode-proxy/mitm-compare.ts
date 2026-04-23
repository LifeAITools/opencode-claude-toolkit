#!/usr/bin/env bun
/**
 * Request interceptor — patches global fetch to dump ALL requests to api.anthropic.com.
 * Works with both CLI and SDK without proxy config.
 *
 * Usage:
 *   # Dump CLI requests:
 *   bun run mitm-compare.ts --mode cli --prompt "say hello"
 *
 *   # Dump SDK requests:
 *   bun run mitm-compare.ts --mode sdk --prompt "say hello"
 *
 *   # Compare two dumps:
 *   bun run mitm-compare.ts --diff /tmp/mitm-cli-*.json /tmp/mitm-sdk-*.json
 */

import { writeFileSync, readFileSync } from 'fs'
import { spawn } from 'bun'
import { homedir } from 'os'
import { join } from 'path'

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const MODE = modeIdx >= 0 ? args[modeIdx + 1] : null
const promptIdx = args.indexOf('--prompt')
const PROMPT = promptIdx >= 0 ? args[promptIdx + 1] : 'Say "hello" in one word.'
const diffIdx = args.indexOf('--diff')

// ─── DIFF MODE ───────────────────────────────────────────────
if (diffIdx >= 0) {
  const file1 = args[diffIdx + 1]
  const file2 = args[diffIdx + 2]
  if (!file1 || !file2) {
    console.error('Usage: --diff <cli-dump.json> <sdk-dump.json>')
    process.exit(1)
  }
  const d1 = JSON.parse(readFileSync(file1, 'utf8'))
  const d2 = JSON.parse(readFileSync(file2, 'utf8'))

  console.log('=' .repeat(80))
  console.log(`COMPARING: ${file1} vs ${file2}`)
  console.log('=' .repeat(80))

  // Compare first API request from each
  const r1 = d1.requests?.[0]
  const r2 = d2.requests?.[0]
  if (!r1 || !r2) {
    console.error('No requests found in one or both files')
    process.exit(1)
  }

  // Headers diff
  console.log('\n── REQUEST HEADERS ──')
  const allHeaders = new Set([...Object.keys(r1.headers), ...Object.keys(r2.headers)])
  for (const h of [...allHeaders].sort()) {
    const v1 = r1.headers[h]
    const v2 = r2.headers[h]
    if (v1 === v2) {
      console.log(`  ✓ ${h}: ${v1?.substring(0, 100)}`)
    } else if (v1 && v2) {
      console.log(`  ✗ ${h}:`)
      console.log(`    CLI: ${v1?.substring(0, 200)}`)
      console.log(`    SDK: ${v2?.substring(0, 200)}`)
    } else if (v1) {
      console.log(`  ← ${h} (CLI only): ${v1?.substring(0, 150)}`)
    } else {
      console.log(`  → ${h} (SDK only): ${v2?.substring(0, 150)}`)
    }
  }

  // Body diff (key fields)
  console.log('\n── REQUEST BODY ──')
  const b1 = r1.body
  const b2 = r2.body
  const bodyKeys = new Set([...Object.keys(b1 ?? {}), ...Object.keys(b2 ?? {})])
  for (const k of [...bodyKeys].sort()) {
    if (k === 'messages') {
      console.log(`  messages: CLI=${b1?.messages?.length ?? 0} msgs, SDK=${b2?.messages?.length ?? 0} msgs`)
      continue
    }
    if (k === 'tools') {
      console.log(`  tools: CLI=${b1?.tools?.length ?? 0}, SDK=${b2?.tools?.length ?? 0}`)
      continue
    }
    const v1 = JSON.stringify(b1?.[k])
    const v2 = JSON.stringify(b2?.[k])
    if (v1 === v2) {
      const preview = v1?.substring(0, 120)
      console.log(`  ✓ ${k}: ${preview}`)
    } else {
      console.log(`  ✗ ${k}:`)
      // For system, show full for comparison
      if (k === 'system') {
        console.log(`    CLI: ${v1?.substring(0, 500)}`)
        console.log(`    SDK: ${v2?.substring(0, 500)}`)
      } else {
        console.log(`    CLI: ${v1?.substring(0, 200)}`)
        console.log(`    SDK: ${v2?.substring(0, 200)}`)
      }
    }
  }

  // Response headers diff
  console.log('\n── RESPONSE HEADERS ──')
  const rh1 = r1.responseHeaders ?? {}
  const rh2 = r2.responseHeaders ?? {}
  const allRH = new Set([...Object.keys(rh1), ...Object.keys(rh2)])
  for (const h of [...allRH].sort()) {
    if (!h.includes('ratelimit') && !h.includes('anthropic') && !h.includes('request-id')) continue
    const v1 = rh1[h]
    const v2 = rh2[h]
    if (v1 === v2) {
      console.log(`  ✓ ${h}: ${v1}`)
    } else if (v1 && v2) {
      console.log(`  ✗ ${h}:`)
      console.log(`    CLI: ${v1}`)
      console.log(`    SDK: ${v2}`)
    } else if (v1) {
      console.log(`  ← ${h} (CLI only): ${v1}`)
    } else {
      console.log(`  → ${h} (SDK only): ${v2}`)
    }
  }

  process.exit(0)
}

// ─── CAPTURE MODE ────────────────────────────────────────────
if (!MODE || !['cli', 'sdk'].includes(MODE)) {
  console.error('Usage: bun run mitm-compare.ts --mode cli|sdk --prompt "..."')
  console.error('       bun run mitm-compare.ts --diff <file1> <file2>')
  process.exit(1)
}

const DUMP_FILE = `/tmp/mitm-${MODE}-${Date.now()}.json`
const dump: { mode: string; prompt: string; requests: any[] } = {
  mode: MODE,
  prompt: PROMPT,
  requests: [],
}

if (MODE === 'sdk') {
  // ─── SDK mode: use our SDK directly ──────────────────────
  const { ClaudeCodeSDK } = await import('../../src/sdk.js')

  // Patch fetch to intercept
  const origFetch = globalThis.fetch
  globalThis.fetch = async function patchedFetch(input: any, init?: any): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('api.anthropic.com/v1/messages')) {
      const headers: Record<string, string> = {}
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v: string, k: string) => { headers[k] = v })
        } else if (typeof init.headers === 'object') {
          Object.entries(init.headers).forEach(([k, v]) => { headers[k] = String(v) })
        }
      }

      let body: any = null
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      } catch {}

      const resp = await origFetch(input, init)

      const responseHeaders: Record<string, string> = {}
      resp.headers.forEach((v: string, k: string) => { responseHeaders[k] = v })

      dump.requests.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body,
        responseStatus: resp.status,
        responseHeaders,
      })

      console.error(`[SDK] Captured ${init?.method} ${url} → ${resp.status}`)

      return resp
    }
    return origFetch(input, init)
  }

  const sdk = new ClaudeCodeSDK()
  console.error(`[SDK] Sending prompt: "${PROMPT}"`)

  try {
    const events: any[] = []
    for await (const event of sdk.stream({
      model: 'claude-sonnet-4-6-20250514',
      messages: [{ role: 'user', content: PROMPT }],
      maxTokens: 200,
      thinking: { type: 'disabled' },
      caching: false,
    })) {
      if (event.type === 'text') events.push(event)
    }
    console.error(`[SDK] Got ${events.length} text events`)
  } catch (e: any) {
    console.error(`[SDK] Error: ${e.message}`)
  }

  writeFileSync(DUMP_FILE, JSON.stringify(dump, null, 2))
  console.log(`\nDump saved: ${DUMP_FILE}`)

} else {
  // ─── CLI mode: run claude --print with fetch intercept ───
  // We can't patch fetch inside the compiled binary.
  // Instead, use NODE_OPTIONS with a preload script.

  const preloadScript = `/tmp/mitm-preload-${Date.now()}.mjs`
  const preloadDumpFile = DUMP_FILE

  writeFileSync(preloadScript, `
// Preload script to intercept fetch in Claude CLI
const origFetch = globalThis.fetch;
const _dumpRequests = [];

globalThis.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (url && url.includes('api.anthropic.com/v1/messages')) {
    const headers = {};
    if (init?.headers) {
      if (init.headers instanceof Headers || (typeof init.headers === 'object' && typeof init.headers.forEach === 'function')) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (typeof init.headers === 'object') {
        Object.entries(init.headers).forEach(([k, v]) => { headers[k] = String(v); });
      }
    }

    let body = null;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {}

    const resp = await origFetch(input, init);

    const responseHeaders = {};
    resp.headers.forEach((v, k) => { responseHeaders[k] = v; });

    _dumpRequests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
      responseStatus: resp.status,
      responseHeaders,
    });

    process.stderr.write('[CLI] Captured ' + (init?.method ?? 'GET') + ' → ' + resp.status + '\\n');

    // Write after each request (in case process dies)
    const fs = await import('fs');
    fs.writeFileSync(${JSON.stringify(preloadDumpFile)}, JSON.stringify({
      mode: 'cli',
      prompt: ${JSON.stringify(PROMPT)},
      requests: _dumpRequests,
    }, null, 2));

    return resp;
  }
  return origFetch(input, init);
};
`)

  console.error(`[CLI] Running: claude --print "${PROMPT}"`)
  console.error(`[CLI] Preload: ${preloadScript}`)

  // Claude CLI is a compiled binary (SEA), not a Node.js script
  // NODE_OPTIONS --import won't work. Let's try LD_PRELOAD approach... nope.
  // Better: use --output-format json and just use the existing log files.

  // Actually, the CLI binary includes Node.js runtime, so --import MIGHT work
  const proc = spawn({
    cmd: ['claude', '--print', '--output-format', 'json', PROMPT],
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${preloadScript}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  console.error(`[CLI] Exit: ${exitCode}`)
  if (stderr) console.error(`[CLI] stderr: ${stderr.substring(0, 500)}`)

  // Check if dump was written by preload
  try {
    const d = JSON.parse(readFileSync(preloadDumpFile, 'utf8'))
    console.log(`\nDump saved: ${preloadDumpFile} (${d.requests.length} requests)`)
  } catch {
    console.error('[CLI] Preload may not have worked (compiled binary). Trying alternative...')

    // Alternative: just clear the header log, run CLI, and parse the new entries
    const headerLog = join(homedir(), '.claude', 'claude-max-headers.log')

    // The CLI doesn't log request headers, only response headers.
    // We need to use strace/ltrace to capture actual TLS data... too complex.
    // Let's use a simpler approach: NODE_DEBUG=http

    console.error('[CLI] Trying NODE_DEBUG approach...')
    const proc2 = spawn({
      cmd: ['claude', '--print', PROMPT],
      env: {
        ...process.env,
        NODE_DEBUG: 'http,https',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout2 = await new Response(proc2.stdout).text()
    const stderr2 = await new Response(proc2.stderr).text()

    // Parse NODE_DEBUG output for outgoing headers
    console.error(`[CLI] Got ${stderr2.length} bytes of debug output`)

    // Save raw debug output
    const debugFile = `/tmp/mitm-cli-debug-${Date.now()}.txt`
    writeFileSync(debugFile, stderr2)
    console.log(`Debug output saved: ${debugFile}`)

    // Also save stdout
    if (stdout2) {
      console.log(`CLI response: ${stdout2.substring(0, 200)}`)
    }
  }
}
