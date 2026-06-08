/**
 * Test bootstrap — runs BEFORE any test module imports anything.
 * Sets CLAUDE_KEEPALIVE_CONFIG_PATH to a fixture so SSOT-reading code
 * sees a stable test config instead of host's ~/.claude/keepalive.json.
 *
 * Wired via bunfig.toml: [test] preload = ["./test/_setup-keepalive-fixture.ts"]
 */
import { writeFileSync } from 'fs'

const FIXTURE_PATH = '/tmp/__test_keepalive_fixture_global.json'
writeFileSync(FIXTURE_PATH, JSON.stringify({
  enabled: true,
  cacheTtlSec: 300,         // legacy 5m TTL — most tests assume this
  safetyMarginSec: 15,
  intervalSec: 60,
  idleTimeoutSec: null,
  // Rewrite guard ON for test/rewrite-guard.test.ts. Harmless to other tests:
  // the guard only blocks idle>ttl non-first requests, which fast unit tests
  // never produce (they use the default 300s proxy TTL, not this).
  rewriteGuard: {
    enabled: true,
    minRewriteTokens: 1000,
    overrideMarker: '[cache-rewrite-ok]',
    // Hermetic consent-grant store — never touch the host's
    // ~/.claude-local/cache-rewrite-grants.json from a test.
    consentGrantPath: '/tmp/__test_cache_rewrite_grants.json',
    consentGrantTtlSec: 180,
  },
}))
process.env.CLAUDE_KEEPALIVE_CONFIG_PATH = FIXTURE_PATH
