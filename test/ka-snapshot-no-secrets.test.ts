/**
 * A keepalive snapshot must never carry a credential to disk.
 *
 * Measured 2026-08-20: 31 lineages in ~/.claude-local/proxy-ka-snapshots.json
 * held a live `Bearer sk-ant-…`, in a 47 MB file at mode 0664 inside a
 * world-writable directory — readable by any user on the machine. The snapshot
 * needs the SHAPE of the request; every fire rebuilds Authorization from
 * getToken(), so the stored copy bought nothing at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { stripCredentials, KeepaliveEngine } from '../src/keepalive-engine.js'
import { saveKaSnapshots } from '../src/ka-snapshot-store.js'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ka-secrets-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

describe('what may be written down', () => {
  test('the credential headers are dropped and everything else is kept', () => {
    const out = stripCredentials({
      Authorization: 'Bearer sk-ant-live',
      'x-api-key': 'sk-ant-also-live',
      Cookie: 'session=1',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching',
      'user-agent': 'claude-cli',
    })
    expect(out).not.toHaveProperty('Authorization')
    expect(out).not.toHaveProperty('x-api-key')
    expect(out).not.toHaveProperty('Cookie')
    expect(out['anthropic-version']).toBe('2023-06-01')
    expect(out['anthropic-beta']).toBe('prompt-caching')   // caching behaviour must survive
    expect(out['user-agent']).toBe('claude-cli')
  })

  test('the header name is matched however it is cased', () => {
    // Claude Code sends `Authorization`; other callers send `authorization`.
    expect(stripCredentials({ authorization: 'Bearer x' })).toEqual({})
    expect(stripCredentials({ AUTHORIZATION: 'Bearer x' })).toEqual({})
  })

  test('a serialised engine carries no credential', () => {
    const e = new KeepaliveEngine({
      config: { cacheTtlMs: 3_600_000, minTokens: 1 },
      getToken: async () => 'tok',
      doFetch: async function* () { yield { type: 'message_stop', usage: {} } as any },
      getRateLimitInfo: () => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }) as any,
    })
    const key = e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    } as any, { Authorization: 'Bearer sk-ant-live', 'anthropic-version': '2023-06-01' })
    e.notifyRealRequestComplete({ inputTokens: 5_000, outputTokens: 1 } as any, key)
    const state = e.serializeState()!
    const text = JSON.stringify(state)
    expect(text).not.toContain('sk-ant-live')
    expect(text).toContain('2023-06-01')
    e.stop()
  })

  test('the file itself is written for its owner only', () => {
    const p = join(dir, 'snap.json')
    saveKaSnapshots({}, p)
    expect(statSync(p).mode & 0o077).toBe(0)   // nothing for group or others
  })

  test('an ALREADY-OPEN file is closed on the next write, not left as it was', () => {
    // The mode argument only applies when the file is created, so the first
    // version of this fix removed the tokens and left the old permissions
    // untouched — measured live on 2026-08-20, the deployed file stayed 0664.
    // A test that only ever created a fresh file could not see it.
    const p = join(dir, 'snap.json')
    writeFileSync(p, '{}', { mode: 0o664 })
    expect(statSync(p).mode & 0o077).not.toBe(0)   // starts open
    saveKaSnapshots({}, p)
    expect(statSync(p).mode & 0o077).toBe(0)       // and is closed by the write
  })
})
