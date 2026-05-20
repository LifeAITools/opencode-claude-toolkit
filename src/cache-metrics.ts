/**
 * cache-metrics.ts — rolling-window cache metrics + regression detector.
 *
 * Subscribes to KA event bus (real requests + KA fires) and aggregates:
 *   - hit_rate (cache_read > 0 / total)
 *   - avg_cache_read, avg_cache_write, avg_input
 *   - cold_start_count (callNum=1 with cache_read=0)
 *   - tool_drift_count (delegated to logger that emits TOOL_DRIFT separately)
 *   - distinct_sysHash_count per PID (max in window)
 *
 * Emits CACHE_METRICS_SUMMARY every reportIntervalMs (default 60s).
 *
 * Regression detector: if hit_rate falls below regressionThreshold AND the
 * previous window was healthy, emits CACHE_REGRESSION_DETECTED. This catches
 * silent Anthropic-side changes (e.g. if 1h cache stops being honored).
 *
 * Usage (in proxy-client or opencode-claude):
 *   import { CacheMetricsCollector } from '@life-ai-tools/claude-code-sdk'
 *   const metrics = new CacheMetricsCollector({
 *     onSummary: (summary) => events.emit({ kind: 'CACHE_METRICS_SUMMARY', ...summary }),
 *     onRegression: (info) => events.emit({ kind: 'CACHE_REGRESSION_DETECTED', ...info }),
 *   })
 *   metrics.recordRequest({ kind: 'real', cacheRead, cacheWrite, input, model, sysHash })
 *   metrics.recordRequest({ kind: 'ka', cacheRead, cacheWrite, input, model })
 *   // on shutdown:
 *   metrics.stop()
 */

export interface RecordedRequest {
  kind: 'real' | 'ka'
  cacheRead: number
  cacheWrite: number
  input: number
  model?: string
  /** Unique hash of system prompt (per-PID stability indicator). Optional. */
  sysHash?: string
  /** Whether this is the first request of a process. Used for cold-start detection. */
  firstCall?: boolean
}

export interface MetricsSummary {
  windowMs: number
  windowEndsAt: string
  total: number
  hitRate: number
  coldStartCount: number
  realCount: number
  kaCount: number
  avgCacheRead: number
  avgCacheWrite: number
  avgInput: number
  maxCacheRead: number
  distinctSysHash: number
  /** Total tokens "saved" via cache reads vs cold cost. */
  estimatedSavedTokens: number
}

export interface RegressionInfo {
  detectedAt: string
  windowMs: number
  currentHitRate: number
  previousHitRate: number
  drop: number
  reason: string
}

export interface CacheMetricsOptions {
  /** Window size for the rolling summary. Default: 60_000 (1 min). */
  windowMs?: number
  /** How often to emit a summary. Default: equal to windowMs. */
  reportIntervalMs?: number
  /** Hit-rate below which we trigger a regression (if previous was healthy). Default: 0.7. */
  regressionThreshold?: number
  /** "Healthy" hit-rate floor for the previous window. Default: 0.85. */
  regressionPreviousFloor?: number
  /** Minimum samples in the window before regression check makes sense. Default: 50. */
  regressionMinSamples?: number
  /** Called every reportIntervalMs with rolling stats. */
  onSummary?: (summary: MetricsSummary) => void
  /** Called when regression detected. */
  onRegression?: (info: RegressionInfo) => void
}

interface SampleEntry extends RecordedRequest {
  ts: number
}

const DEFAULTS = {
  windowMs: 60_000,
  regressionThreshold: 0.7,
  regressionPreviousFloor: 0.85,
  regressionMinSamples: 50,
}

export class CacheMetricsCollector {
  private samples: SampleEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private previousHitRate = 1.0
  private previousSampleCount = 0
  private readonly windowMs: number
  private readonly reportIntervalMs: number
  private readonly regressionThreshold: number
  private readonly regressionPreviousFloor: number
  private readonly regressionMinSamples: number
  private readonly onSummary?: (summary: MetricsSummary) => void
  private readonly onRegression?: (info: RegressionInfo) => void

  constructor(opts: CacheMetricsOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs
    this.reportIntervalMs = opts.reportIntervalMs ?? this.windowMs
    this.regressionThreshold = opts.regressionThreshold ?? DEFAULTS.regressionThreshold
    this.regressionPreviousFloor = opts.regressionPreviousFloor ?? DEFAULTS.regressionPreviousFloor
    this.regressionMinSamples = opts.regressionMinSamples ?? DEFAULTS.regressionMinSamples
    this.onSummary = opts.onSummary
    this.onRegression = opts.onRegression

    if (this.reportIntervalMs > 0) {
      this.timer = setInterval(() => this.report(), this.reportIntervalMs)
      if (typeof this.timer === 'object' && 'unref' in this.timer) {
        ;(this.timer as any).unref()
      }
    }
  }

  recordRequest(req: RecordedRequest): void {
    this.samples.push({ ts: Date.now(), ...req })
  }

  /**
   * Summarize current rolling window. Public so consumers (e.g. /stats endpoint)
   * can pull on demand.
   */
  summary(): MetricsSummary {
    this.prune()
    const total = this.samples.length
    const hits = this.samples.filter(s => s.cacheRead > 0).length
    const cold = this.samples.filter(s => s.firstCall && s.cacheRead === 0).length
    const real = this.samples.filter(s => s.kind === 'real').length
    const ka = this.samples.filter(s => s.kind === 'ka').length
    const sumCr = this.samples.reduce((a, s) => a + s.cacheRead, 0)
    const sumCw = this.samples.reduce((a, s) => a + s.cacheWrite, 0)
    const sumIn = this.samples.reduce((a, s) => a + s.input, 0)
    const maxCr = this.samples.reduce((a, s) => Math.max(a, s.cacheRead), 0)
    const distinctHashes = new Set(this.samples.map(s => s.sysHash).filter(Boolean)).size

    // "Saved tokens" = cache_read tokens that would have been billed at full input rate
    // (cache_read costs 10% on public API; on subscription it costs near-zero quota).
    const estimatedSavedTokens = Math.round(sumCr * 0.9)

    return {
      windowMs: this.windowMs,
      windowEndsAt: new Date().toISOString(),
      total,
      hitRate: total > 0 ? hits / total : 0,
      coldStartCount: cold,
      realCount: real,
      kaCount: ka,
      avgCacheRead: total > 0 ? sumCr / total : 0,
      avgCacheWrite: total > 0 ? sumCw / total : 0,
      avgInput: total > 0 ? sumIn / total : 0,
      maxCacheRead: maxCr,
      distinctSysHash: distinctHashes,
      estimatedSavedTokens,
    }
  }

  private report(): void {
    const s = this.summary()
    if (s.total === 0) return

    this.onSummary?.(s)

    // Regression check: previous window was healthy AND current dropped below threshold.
    if (
      this.previousSampleCount >= this.regressionMinSamples &&
      this.previousHitRate >= this.regressionPreviousFloor &&
      s.total >= this.regressionMinSamples &&
      s.hitRate < this.regressionThreshold
    ) {
      this.onRegression?.({
        detectedAt: s.windowEndsAt,
        windowMs: this.windowMs,
        currentHitRate: s.hitRate,
        previousHitRate: this.previousHitRate,
        drop: this.previousHitRate - s.hitRate,
        reason: `hit_rate dropped from ${this.previousHitRate.toFixed(3)} to ${s.hitRate.toFixed(3)} (Δ=${(this.previousHitRate - s.hitRate).toFixed(3)}); ${s.total} samples in current window`,
      })
    }

    this.previousHitRate = s.hitRate
    this.previousSampleCount = s.total
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
      this.samples.shift()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** @internal */
  get _samples(): readonly SampleEntry[] {
    return this.samples
  }
}
