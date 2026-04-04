# Changelog

All notable changes to `@life-ai-tools/claude-code-sdk` and the `opencode-claude` plugin.

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
