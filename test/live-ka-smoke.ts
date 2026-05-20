#!/usr/bin/env bun
/**
 * Live KA smoke test — verifies KeepaliveEngine integration end-to-end.
 *
 * Uses Haiku 4.5 (cheapest) + real OAuth credentials.
 *
 * Success criteria (LOGIC-based, not cache-hit-based):
 *   ✓ real request completes without error
 *   ✓ engine registers snapshot after completion (registry.size > 0)
 *   ✓ KA timer fires within ~90s (onHeartbeat called)
 *   ✓ KA fire uses max_tokens=1 (verifiable via debug log body dump)
 *   ✓ KA fire returns usage with cacheRead (if API respects cache_control)
 *     OR matches same small token counts as initial request (cache not activated)
 *     — either way, proves replay succeeds
 *
 * Not a unit test — run manually: bun run test/live-ka-smoke.ts
 */

import { ClaudeCodeSDK } from '../src/sdk.js'
import type { KeepaliveStats, TokenStatusEvent } from '../src/types.js'
import { appendFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Logging setup ─────────────────────────────────────────────

const LOG_DIR = join(homedir(), '.claude', 'live-ka-smoke-logs')
mkdirSync(LOG_DIR, { recursive: true })
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const LOG = (tag: string, data: unknown) => {
  const line = `[${new Date().toISOString()}] [${tag}] ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
  console.log(line)
  appendFileSync(join(LOG_DIR, `${RUN_ID}.log`), line + '\n')
}

LOG('INIT', { runId: RUN_ID, logDir: LOG_DIR, pid: process.pid })

// ─── Observation buckets ───────────────────────────────────────

const observations = {
  realRequests: [] as Array<{ usage: any; durationMs: number }>,
  keepaliveFires: [] as KeepaliveStats[],
  ticks: [] as Array<{ idleMs: number; nextFireMs: number; model: string; tokens: number }>,
  disarmEvents: [] as Array<{ reason: string; at: number }>,
  rewriteWarnings: [] as any[],
  networkChanges: [] as any[],
  tokenEvents: [] as TokenStatusEvent[],
}

// ─── Build SDK ─────────────────────────────────────────────────

const sdk = new ClaudeCodeSDK({
  keepalive: {
    intervalMs: 60_000,       // clamped min — fire quickly
    idleTimeoutMs: Infinity,
    minTokens: 100,           // low — our small test request should register
    onHeartbeat: (stats) => {
      LOG('KA_FIRE', {
        durationMs: stats.durationMs,
        idleMs: stats.idleMs,
        model: stats.model,
        usage: {
          in: stats.usage.inputTokens,
          out: stats.usage.outputTokens,
          cacheRead: stats.usage.cacheReadInputTokens ?? 0,
          cacheWrite: stats.usage.cacheCreationInputTokens ?? 0,
        },
        rateLimit: stats.rateLimit,
      })
      observations.keepaliveFires.push(stats)
    },
    onTick: (tick) => {
      observations.ticks.push(tick)
      if (tick.idleMs > 50_000) LOG('KA_TICK_CLOSE', tick)
    },
    onDisarmed: (info) => {
      LOG('KA_DISARMED', info)
      observations.disarmEvents.push(info)
    },
    onRewriteWarning: (info) => {
      LOG('REWRITE_WARNING', info)
      observations.rewriteWarnings.push(info)
    },
    onNetworkStateChange: (info) => {
      LOG('NETWORK_STATE', info)
      observations.networkChanges.push(info)
    },
  },
  onTokenStatus: (event) => {
    LOG('TOKEN_STATUS', event)
    observations.tokenEvents.push(event)
  },
})

// Expose engine internals for introspection
const engine = (sdk as any).keepalive

// ─── Test ──────────────────────────────────────────────────────

async function run() {
  const model = 'claude-haiku-4-5-20251001'

  // Phase 1: Make real request — seeds registry
  LOG('PHASE_1', 'Real request — expect engine registry populated after')

  const messages = [
    { role: 'user' as const, content: 'Say just the word "ready" and nothing else.' },
  ]

  let resp1: any = null
  const t1 = Date.now()
  let eventCount = 0
  for await (const ev of sdk.stream({ model, messages, maxTokens: 16 })) {
    eventCount++
    LOG('SMOKE_EVENT', { n: eventCount, type: ev.type })
    if (ev.type === 'message_stop') resp1 = ev
  }
  LOG('SMOKE_LOOP_EXIT', { eventCount, _lastStreamUsage: (sdk as any)._lastStreamUsage })
  const d1 = Date.now() - t1

  LOG('PHASE_1_COMPLETE', {
    durationMs: d1,
    usage: resp1?.usage,
    stopReason: resp1?.stopReason,
    engineRegistrySize: engine._registry.size,
    engineHasTimer: engine._timer !== null,
  })

  observations.realRequests.push({ usage: resp1.usage, durationMs: d1 })

  // Verify engine state
  if (engine._registry.size === 0) {
    LOG('FAIL_EARLY', 'Engine registry empty after successful request — notifyRealRequestComplete did not fire')
    sdk.stopKeepalive()
    process.exit(1)
  }
  if (engine._timer === null) {
    LOG('FAIL_EARLY', 'Engine KA timer not started after registry populated')
    sdk.stopKeepalive()
    process.exit(1)
  }

  // Phase 2: Wait for KA fire (60-90s)
  LOG('PHASE_2', 'Polling up to 150s for KA fire (intervalMs=60000 + jitter≤30s)')
  const phase2Start = Date.now()
  while (observations.keepaliveFires.length === 0 && Date.now() - phase2Start < 150_000) {
    await new Promise(r => setTimeout(r, 5_000))
    if (Date.now() - phase2Start > 30_000 && (Date.now() - phase2Start) % 30_000 < 5_500) {
      LOG('PHASE_2_PROGRESS', {
        elapsedS: Math.round((Date.now() - phase2Start) / 1000),
        ticksObserved: observations.ticks.length,
        firesObserved: observations.keepaliveFires.length,
      })
    }
  }

  LOG('PHASE_2_COMPLETE', {
    waitedS: Math.round((Date.now() - phase2Start) / 1000),
    fires: observations.keepaliveFires.length,
    ticks: observations.ticks.length,
  })

  // Final report
  sdk.stopKeepalive()

  const report = {
    runId: RUN_ID,
    summary: {
      realRequests: observations.realRequests.length,
      kaFires: observations.keepaliveFires.length,
      kaTicks: observations.ticks.length,
      disarms: observations.disarmEvents.length,
    },
    verifications: {
      engine_registry_populated_after_request: engine._registry.size > 0 || observations.keepaliveFires.length > 0,
      engine_timer_started: engine._timer !== null || observations.keepaliveFires.length > 0,
      ka_fire_observed: observations.keepaliveFires.length > 0,
      ka_fire_max_tokens_1: observations.keepaliveFires.every(f => f.usage.outputTokens <= 1),
      ka_fire_no_cache_write: observations.keepaliveFires.every(f => (f.usage.cacheCreationInputTokens ?? 0) === 0),
    },
    observations,
  }

  const reportPath = join(LOG_DIR, `${RUN_ID}-report.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  LOG('FINAL_REPORT', { path: reportPath, ...report.verifications })

  const ok =
    report.verifications.engine_registry_populated_after_request &&
    report.verifications.engine_timer_started &&
    report.verifications.ka_fire_observed &&
    report.verifications.ka_fire_max_tokens_1 &&
    report.verifications.ka_fire_no_cache_write

  if (ok) {
    LOG('VERDICT', '✅ KA engine integration verified on live API')
    process.exit(0)
  } else {
    LOG('VERDICT', '❌ One or more KA checks failed — inspect report')
    process.exit(1)
  }
}

run().catch(err => {
  LOG('FATAL', { error: err?.message, stack: err?.stack?.split('\n').slice(0, 5) })
  try { sdk.stopKeepalive() } catch {}
  process.exit(3)
})
