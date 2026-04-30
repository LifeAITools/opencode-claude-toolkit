# Changelog

All notable changes to `@life-ai-tools/claude-code-sdk` and the `opencode-claude` plugin.

## [0.12.0] / opencode-claude [1.3.0] / claude-max-proxy [0.6.0] - 2026-04-30

### Added
- **`src/keepalive-config.ts` — SSOT for cache & keepalive parameters.**
  All knobs (cacheTtlMs, safetyMarginMs, intervalMs, retryDelaysMs,
  rewriteWarn*, healthProbe*, idleTimeoutMs, minTokens, enabled) live in one
  place, hot-reloaded from `~/.claude/keepalive.json` on each access.
  Auto-scales sensibly: 5m TTL → 150s interval, 1h TTL → 1800s interval, with
  the upper interval clamp computed dynamically as `cacheTtlMs - safetyMarginMs - 60s`.
  Test-time isolation via `CLAUDE_KEEPALIVE_CONFIG_PATH` env override.

- **`src/cache-metrics.ts` — rolling-window metrics + regression detector.**
  Tracks hit_rate, cache_read avg/max, cold-start count, distinct sysHash count.
  Emits `CACHE_METRICS_SUMMARY` every 60s and `CACHE_REGRESSION_DETECTED` if
  hit_rate drops from healthy (>=85%) to bad (<70%) — surfaces silent
  Anthropic-side cache changes within an hour of regression.

- **`bunfig.toml` + `test/_setup-keepalive-fixture.ts`** — preload hook ensures
  tests see a stable fixture config regardless of host's `~/.claude/keepalive.json`.

- **Prefix fingerprint logging** (`provider.ts:convertPrompt`).
  Each system block hashed separately (`fingerprints=[hash@len, ...]`) so
  cross-PID cache misses can be diagnosed by comparing fingerprints between
  STARTUP logs.

- **Tool schema drift detector** (`provider.ts:convertTools`).
  Beyond name-set changes (`TOOL_DRIFT`), now also detects `TOOL_SCHEMA_DRIFT`
  when tool *bodies* (descriptions/schemas) change while names stay the same.
  Caught mid-session schema mutations from MCP servers (e.g. telegram-mcp_tg_send_message).

### Fixed
- **1h cache TTL is now actually used.** The `prompt-caching-scope-2026-01-05`
  beta is honoured by Anthropic on the OAuth subscription endpoint —
  empirically confirmed: WRITE → READ at T+5m30s, T+10m, T+30m all hit with
  `cache_read_input_tokens > 0`. Engine's hardcoded `CACHE_TTL_MS = 5 * 60 * 1000`
  removed; `cacheTtlMs` is now an instance field initialized from SSOT.
  Default keepalive interval scales from 2 min → 30 min when 1h TTL active —
  **15× fewer keepalive fires** per session.

- **`addCacheMarkers` clamp tightened**. The legacy `intervalMs` upper bound
  240_000 was hardcoded for 5-minute TTL; now derived as
  `cacheTtlMs - safetyMarginMs - 60_000`, allowing intervals up to ~58 min on
  1h TTL without clamp.

- **`todo_write` no longer drifts between builtin and MCP buckets.**
  Pre-fix, `MCP_TOOL_PATTERN /^[a-z][\w-]+_[a-z]/` matched `todo_write` (after
  `TOOL_NAME_REMAP` from `todowrite`), classifying it as MCP. Whenever
  `todo_write` appeared/disappeared, the alphabetically-sorted MCP block
  shifted, breaking cache prefix. Observed 319× over the past month
  (`TOOL_DRIFT 80↔79 (builtin=10 mcp=69)` pattern).
  Now uses an explicit `BUILTIN_NAMES_AFTER_REMAP` allowlist.

- **MEMORY.md split out of stable prefix** (`provider.ts:buildContextInjectionParts`).
  Pre-fix: CLAUDE.md + MEMORY.md were both prepended at the front of system,
  so any MEMORY.md growth (agents write to it) invalidated the entire 36 KB+
  prefix. Now: CLAUDE.md prepended (stable), MEMORY.md *appended* (volatile).
  Growth in MEMORY.md only invalidates the trailing segment.

- **`rewriteWarnIdleMs` auto-scales with `cacheTtlMs`.**
  Default was 300_000 (5 min) — when 1h TTL active, this fired the
  `[claude-max] Cache likely dead — idle=375s, next request will cost ~520972
  cache_write tokens` banner every 5 min of user idleness while cache was
  *actually* fine. Now defaults to `cacheTtlMs - safetyMarginMs` (close to TTL
  boundary), matching the actual time when cache could plausibly be dead.

- **Disk-mtime token reload on every `ensureAuth` call.**
  `_doEnsureAuth` (sdk.ts:919) and `CredentialManager.ensureValid`
  (opencode-claude/index.ts:134) used to fast-path return when the in-memory
  token wasn't expired, never reading the disk. After a `claude login` while a
  process was running, the in-memory token stayed alive ~8h, pinning the
  process to the old org. Live demo on 2026-04-30: org A hit `util_5h=1.0,
  status=rejected, retry-after=5516s`, but the running PID kept retrying with
  the old token instead of picking up the new credentials sitting on disk.
  Now: every request first checks `credentialStore.hasChanged()` (cheap mtime
  check) and reloads on change — with no impact on the non-rotation path.

### Changed
- **`KeepaliveEngine.CACHE_TTL_MS` → `this.cacheTtlMs`** (instance field).
  Ditto `CACHE_SAFETY_MARGIN_MS`, `KEEPALIVE_RETRY_DELAYS`, `HEALTH_PROBE_INTERVALS_MS`,
  `HEALTH_PROBE_TIMEOUT_MS`. All read from SSOT via `loadKeepaliveConfig()`
  in the constructor. Ten internal use-sites updated.

- **Live-reload mechanism unified.** Removed duplicate
  `KEEPALIVE_CONFIG_PATH` + `readKeepaliveConfig()` from
  `keepalive-engine.ts`; tick() now calls `loadKeepaliveConfig()` directly
  (mtime-cached inside SSOT module).

- **`ProxyClient.kaIntervalSec` defaults to undefined**, deferring to SSOT.
  Same change in `claude-max-proxy/src/config.ts` (`KA_INTERVAL_SEC` env
  override still works) and `opencode-claude/provider.ts`
  (`CLAUDE_MAX_KEEPALIVE_INTERVAL` env override still works).

- **`/stats` endpoint** (claude-max-proxy) now exposes resolved `cacheConfig`
  + rolling `cacheMetrics` for live observability of the SSOT and hit-rate.

- **STARTUP log marker** in `createClaudeMax`:
  `STARTUP createClaudeMax pid=… sdk=0.12.0 plugin=1.3.0 [cache-ssot]
  cacheConfig={cacheTtlMin:60, intervalMin:30, …}`. Trivial check that a
  process loaded the new code by greping for `[cache-ssot]`.

### Activated by writing to `~/.claude/keepalive.json`
```json
{
  "enabled": true,
  "cacheTtlSec": 3600,
  "safetyMarginSec": 60,
  "intervalSec": 1800,
  "retryDelaysSec": [2, 3, 5, 10, 15, 20, 30, 60, 120, 300]
}
```
Without this file, defaults fall back to legacy 5m TTL behaviour for safety.

## [0.11.4] - 2026-04-27

### Fixed
- **Token refresh 429 storms — three independent root causes addressed.**
  Production incident on 2026-04-27 04:50:54Z reproduced the same `429 Too
  Many Requests` pattern that we thought was fully fixed in 0.11.1. Detailed
  log analysis revealed the lock fix worked perfectly *between our PIDs*, but
  three other paths still produced the storm:

  1. **Within a single PID we hammered the endpoint 5× in 13 seconds.** On the
     first 429, our retry loop slept the configured `[500, 1500, 3000, 5000,
     8000]ms` delays and POSTed again — but Anthropic's per-`refresh_token`
     rate window is on the order of **60 seconds**. Every retry just *extended*
     the window we were already locked out of.
  2. **`PROACTIVE_REFRESH_RATIO=0.50` was too aggressive.** Refreshing at 50%
     of remaining lifetime triggers ~6 fetches/day per refresh_token. Standard
     OAuth clients (and the original Claude Code CLI) refresh at 5–15% remaining
     or reactively on 401. Our cadence alone was enough to flag us with
     Anthropic as a "noisy" client.
  3. **No coordination with non-SDK refreshers.** The original Claude Code CLI
     reads/writes the same `~/.claude/.credentials.json` but knows nothing
     about our `~/.claude/.token-refresh-lock/` directory. When CLI was
     mid-refresh and our SDK fired its own scheduled rotation, both POSTed
     simultaneously — and Anthropic's rate-limit hit our SDK harder (the CLI
     wins the race per logs from 04:51:32Z).

### Changed
- `PROACTIVE_REFRESH_RATIO` lowered from `0.50` → `0.20`. With an 8h token
  this moves first refresh from "4h after issue" to "6h 24min after issue"
  (96min remaining), cutting fetch frequency from ~6/day to ~1.2/day per
  refresh_token while preserving plenty of margin for retries.
- `doTokenRefresh()` now **bails out immediately on the first 429** instead
  of retrying 4 more times. Sets a flat 60-second cross-process cooldown
  (`setRefreshCooldown(60_000)`) so other PIDs and our own next scheduled
  rotation back off long enough to clear Anthropic's window. The 5× retry
  loop is preserved only for genuine `5xx` server errors.
- `doTokenRefresh()` performs a **mtime check** on `~/.claude/.credentials.json`
  before its first POST. If the file was modified within the last 60 seconds,
  the SDK reads the file and uses whatever fresh token landed there — whether
  it was written by another of our PIDs, the original Claude Code CLI, or any
  other process sharing the credential file. This is the only practical way to
  coordinate with closed-source CLI without modifying it.
- `FileCredentialStore.path` changed from `private` to `public readonly` so
  `doTokenRefresh()` can perform the mtime check without a separate API.

### Tests
- New file `test/token-refresh-coord.test.ts`: 6 tests covering
  `FileCredentialStore.path` accessibility, mtime classification of
  recent vs stale writes, `read()` parsing, and missing-file behavior.
- Total: 36 pass / 0 fail across `keepalive-engine`, `keepalive-regression`,
  and `token-refresh-coord` suites.

## [0.11.3] - 2026-04-26

### Fixed
- **`AbortError`/timeout misclassified as `server_transient` → fake
  `cache_ttl_exhausted` disarms.** Production logs on 2026-04-26 18:44Z
  showed two consecutive incidents:

  ```
  18:44:31  API_ERROR pid=2649955 ttfb=245497ms err=The operation timed out.
  18:44:31  keepalive DISARMED reason=cache_ttl_exhausted
  18:46:14  API_ERROR pid=2299636 ttfb=259957ms err=The operation timed out.
  18:46:14  keepalive DISARMED reason=cache_ttl_exhausted
  ```

  Anthropic API hung for ~4 minutes on real requests. The SDK's request-level
  timeout (`sdk.ts:234`, default 600s) eventually fired `controller.abort()`,
  fetch threw `AbortError`, and the SDK wrapped it as
  `ClaudeCodeSDKError('Network error', err)`. The engine's `classifyError()`
  only inspected `e.code`/`e.cause.code`/`e.message`, none of which contained
  any of the network keywords — so it fell through to `server_transient`,
  rolled into `retryChain()`, and then disarmed with the lying reason
  `cache_ttl_exhausted` (the cache hadn't expired by TTL — the *retries* did).
  Two days of debugging traced this exact cause back to the engine
  misclassification.

### Changed
- `classifyError()` now walks the full `.cause` chain, recognises
  `AbortError`/`TimeoutError` by `name`, matches additional message keywords
  including the literal SDK wrapper text `'Network error'`, and adds Bun /
  Undici codes (`ABORT_ERR`, `ERR_NETWORK`) plus phrases (`'aborted'`,
  `'the operation timed out'`, `'fetch failed'`, `'socket hang up'`,
  `'terminated'`).
- `retryChain()` emits a new, more honest reason when retries — not idle —
  consumed the cache window: `retry_budget_exceeds_ttl` (cache was still
  fresh-ish when retries started but the next backoff would land past TTL).
  The old `cache_ttl_exhausted` reason is preserved only for the genuine
  case where the cache aged past half-TTL before failures began. Both reasons
  now trigger `startHealthProbe()` so a recovering network is detected fast.

### Tests
- 5 new regression tests in `Layer 4: error classification`:
  - `AbortError (request timeout) → classified as network, NOT cache_ttl_exhausted`
  - `"The operation timed out." message → classified as network`
  - `TimeoutError name → classified as network`
  - `plain "Network error" (SDK wrapper with no cause details) → classified as network`
  - `ECONNRESET → still classified as network (regression guard)`
- 23 pass / 0 fail.

## [0.11.2] - 2026-04-26

### Fixed
- **False "Cache likely dead" warnings while KA is healthy.**
  `KeepaliveEngine.checkRewriteGuard()` measured idle time against
  `lastRealActivityAt` (only updated by real user requests), causing the TUI to
  display `⚠️ [claude-max] Cache likely dead — idle=350s, next request will cost
  ~150k cache_write tokens` every 5 minutes of user idleness — even when KA fires
  were continuously refreshing the prompt cache and Anthropic was returning low
  `cache_creation_input_tokens` (< 2k) on real requests, proving the cache was
  actually warm.
  Guard now measures against `cacheWrittenAt`, which is updated by both real
  requests **and** successful KA fires (line 504). Result: warnings appear only
  when the cache is genuinely stale (KA broken / DISARMED / engine stopped),
  not on every period of user idleness.

### Tests
- 4 existing rewrite-guard tests migrated from `_setLastRealActivityAt` to
  `_setCacheWrittenAt` to reflect the new (correct) semantics.
- 2 new regression tests:
  1. `no warn when KA recently fired (cacheWrittenAt is fresh) even after long user idle`
  2. `warn DOES fire when cacheWrittenAt is stale (KA broken or DISARMED)` —
     ensures the guard still works correctly when KA actually fails.
- New test helpers `_setCacheWrittenAt(v)` and `_cacheWrittenAt` getter.

## [0.11.1] - 2026-04-26

### Fixed
- **Token refresh 429 storm** — when N opencode PIDs running on the same machine
  rotated their OAuth tokens at similar times, the cross-process file lock
  (`~/.claude/.token-refresh-lock`) only retried for ~10s before giving up and
  returning `null`. Callers ignored the `null` and proceeded to call the OAuth
  endpoint anyway — producing 3+ simultaneous `POST /v1/oauth/token` requests
  that Anthropic answered with 429. Each PID then entered its own retry loop
  (`TOKEN_REFRESH_RETRY status=429 attempt=1/5` …), failing repeatedly for
  several minutes. Meanwhile the prompt cache (5 min TTL) drained, and
  keepalive eventually disarmed with `cache_ttl_exhausted` because no valid
  token was available to fire heartbeats. (Symptom in logs:
  `keepalive DISARMED reason=cache_ttl_exhausted` immediately after a TOKEN_ROTATION
  429 cluster.)

### Changed
- `acquireTokenRefreshLock()` budget raised from 5 to 30 attempts (~10s → ~45s),
  comfortably covering the worst-case real refresh of ~25-30s (5 fetch attempts
  with `[500, 1500, 3000, 5000, 8000]`ms backoff plus network RTT).
- All three call sites (`proactiveRefresh()`, `refreshTokenWithTripleCheck()`,
  `handleAuth401()`) now **fail-closed** when the lock is unavailable: instead
  of joining the storm, the loser polls the credential store on disk for the
  fresh token the winner is about to write. New helper `pollDiskForFreshToken()`
  encapsulates this.
- Last-resort unlocked refresh kept only as a safety net for
  `refreshTokenWithTripleCheck()` and `handleAuth401()` when no fresh token
  appears within 45s — proactive rotation never falls through, since the timer
  will fire again soon and the system will eventually converge.

## [0.5.0] - 2026-04-04

### Added
- **Voice input** — `/voice` command (or `/v`) toggles voice-to-text recording in opencode TUI
- **Voice STT** — streams mic audio to Anthropic's Deepgram-powered WebSocket endpoint (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`)
- **Recording indicator** — `app` slot overlay shows "🔴 Recording..." with live interim transcript
- **Silence auto-stop** — recording stops after configurable silence period (default 3s, via `voiceSilenceMs` in api.kv)
- **Voice dependency check** — detects SoX/arecord, shows install hint via toast if missing
- **Voice config** — `voiceEnabled` and `voiceSilenceMs` persisted via opencode's `api.kv`
- **Text injection** — transcribed text inserted into prompt via `api.client.tui.appendPrompt()` with HTTP fallback
- **Lifecycle cleanup** — mic process killed and WebSocket closed on plugin dispose

### Technical
- All voice functions inlined in tui.tsx (avoids cross-process import issues)
- Raw WebSocket implementation (RFC 6455 frame parsing, no ws dependency)
- PCM 16kHz/16-bit/mono via SoX `rec` or ALSA `arecord`
- RMS-based silence detection with configurable threshold
- Toggle UX (not hold-to-talk — terminal key release detection too fragile)

## [0.4.1] - 2026-04-04

### Fixed
- **Tool order non-deterministic** — MCP servers register tools in startup-race order, causing cache prefix to diverge at tool ~#11 across processes. All processes now sort tools by name before sending to API, producing identical prefixes regardless of MCP server startup timing.

## [0.4.0] - 2026-04-04

### Fixed
- **Token refresh stampede** — 6 concurrent sessions detecting expired token simultaneously caused 1064 simultaneous refresh requests, all getting 429, resulting in 40-minute outages. Root cause: no cross-process coordination.

### Added
- **Filesystem lock** (`mkdir`-based) for token refresh — only one process refreshes at a time, others wait and read from disk. Lock at `~/.claude/.token-refresh-lock/` with 30s stale timeout and PID file.
- **Triple-check pattern** — Check 1 (cached), Check 2 (re-read store), acquire lock, Check 3 (post-lock re-read). Prevents double-refresh across processes.
- **ensureAuth dedup** — concurrent calls within one process share a single pending promise instead of each triggering independent refresh.
- **Race recovery** — after all refresh retries fail, re-reads credential store one final time in case another process succeeded. Logs `TOKEN_REFRESH_RACE_RECOVERY` on success.

### Changed
- Token refresh now coordinates across processes: ≤5 endpoint requests per cycle instead of 1064
- Session recovery from token expiry: ~5 seconds instead of ~40 minutes

## [0.3.3] - 2026-04-04

### Fixed
- **Cost display bug** — auth.loader was zeroing out model costs after config hook set them, causing sidebar to show "N/A savings" instead of actual dollar savings

### Added
- **Keepalive config via opencode.json** — `options.keepalive` (bool), `options.keepaliveInterval` (seconds), `options.keepaliveIdle` (seconds) in provider config, with env var fallback
- **Compaction hook** — `experimental.session.compacting` injects cache optimization context into compaction summaries; optional full prompt replacement via `options.customCompaction`
- **Fine-grained tool streaming** — `fine-grained-tool-streaming-2025-05-14` beta header enables streaming partial tool arguments

### Changed
- Provider options from `opencode.json` now flow through to `createClaudeMax()` for runtime configuration

## [0.3.2] - 2026-04-04

### Fixed
- **Keepalive snapshot protection** — subagent calls (Task tool spawns) could overwrite the main conversation's keepalive snapshot with a tiny context, causing the main conversation's cache to expire during idle periods. Fix: never downgrade snapshot — only overwrite if new call has more tokens than existing.

## [0.3.1] - 2026-04-04

### Added
- **TUI Plugin: Cache Stats Sidebar** — real-time cache read/write tokens, hit ratio %, and estimated cost savings visible in opencode sidebar (`Ctrl+X B`)
- **TUI Plugin: `/cache` Command** — diagnostics dialog with keepalive fire history, API response time percentiles (min/p50/max), live config display, and active sessions list
- **Cross-Project Cache Sharing** — CWD paths normalized in tool schemas so all projects share the same ~30K token tool prefix (saves ~33K tokens per new project session)
- **Live-Reload Keepalive Config** — `~/.claude/keepalive.json` read on each tick with mtime caching; change interval, idle timeout, or kill switch without restarting
- **Image Resize Pipeline** — automatic resize via jimp to Anthropic's native 1568px long edge; PNG preserved for screenshots, JPEG fallback for oversized images
- **Equivalent API Pricing** — model config includes Anthropic per-token rates so sidebar shows estimated savings (e.g. "$179 saved") instead of "N/A"

### Fixed
- **Image Support** — added `modalities` config (not just `capabilities`) so opencode passes images through instead of stripping with "model does not support image input" error
- **Data URL Safety** — strip `data:` prefix if AI SDK passes full data URL instead of pure base64
- **Oversized Image Handling** — reject images >5MB with user-visible message instead of crashing

### Changed
- **Keepalive: No Idle Timeout** — empirically verified keepalives cost zero quota (0.00 util5h across 185 fires); sessions now keep cache warm for process lifetime
- **Image Resize Target** — 1568px long edge (was 2000px) matching Anthropic vision model's native resolution; saves ~38% tokens with zero quality loss
- **Dead Code Removed** — `computeFingerprint`, `hashFingerprint`, `FINGERPRINT_SALT` removed from SDK

### Performance
- 99.5% cache hit ratio observed (13.7M read / 64.7K write in production session)
- 163K token cross-session cache hit on session restart
- Keepalive overhead: 183 output tokens/day (0.04% of real traffic)
- Image resize: <100ms via jimp (pure JS, no native deps)

## [0.3.0] - 2026-04-03

### Added
- Cache keepalive with 120s interval, jitter, retry chain
- Image/PDF content block support in provider
- Voice STT module (`src/voice.ts`) with WebSocket streaming
- Voice transcription examples
- API timing logs (TTFB) and raw body dumps (first 3 calls)
- Document content block type in types

### Fixed
- Simplified to 1-marker cache strategy (matches Claude Code)
- Deep-copy system prompt to prevent `cache_control` mutation leaking
- Deterministic billing header (stripped per-message fingerprint)
- `.gitignore` was using literal `\n` instead of newlines (no rules worked)

### Changed
- Context window: 1M for Opus/Sonnet on Max subscription
- Keepalive interval: 120s (was 270s)
- Compaction disabled in test configs

## [0.2.0] - 2026-04-01

### Added
- Structured JSONL stats log with utilization metrics (5h/7d)
- Session slug + PID in all stats log entries
- Rate limit header dumping for discovery

### Changed
- Keepalive interval tuning (270s → 240s → 120s progression)

## [0.1.2] - 2026-03-31

### Fixed
- Token usage display: total includes cache
- Provider metadata for opencode cache tracking

## [0.1.1] - 2026-03-30

### Fixed
- Surface rate limit and API errors during streaming
- Proxy stays alive with multiple clients

## [0.1.0] - 2026-03-29

### Added
- Initial release
- ClaudeCodeSDK: OAuth auth, streaming, tool use, thinking
- OpenCode plugin: provider registration, model config
- FileCredentialStore with mtime-based refresh detection
- Keepalive system for prompt cache preservation
