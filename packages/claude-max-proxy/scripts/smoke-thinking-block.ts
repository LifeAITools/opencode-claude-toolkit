#!/usr/bin/env bun
/**
 * smoke-thinking-block — post-deploy guard for the thinking-block 400 regression.
 *
 * WHY (2026-05-28 incident): a thinking/redacted_thinking block in the latest
 * assistant message that carries a client cache_control marker must pass through
 * the proxy's enrichment UNTOUCHED. Anthropic rejects ANY modification of thinking
 * blocks (400 "thinking blocks ... cannot be modified"). Two enrichment paths can
 * mutate it: injectCacheMarkers (daemon openai-translate.ts) and
 * upgradeCacheControlTtl (SDK bundle). A prior "fix" shipped the test but never the
 * impl, and the deploy shipped a stale bundle — the flood ran for hours.
 *
 * This probes the ACTUAL DEPLOYED artifacts (not source) with zero upstream traffic:
 * it never contacts Anthropic, never touches the running proxy process — it only
 * imports the deployed modules and runs the pure transforms over a crafted body.
 *
 * Exit 0 = thinking block survived both transforms unchanged. Exit 1 = regression.
 */

const INSTALLED = '/home/relishev/.local/share/claude-max-proxy'
const TRANSLATE = `${INSTALLED}/src/openai-translate.ts`
const SDK_BUNDLE = `${INSTALLED}/node_modules/@life-ai-tools/claude-code-sdk/dist/index.js`

function fail(msg: string): never {
  console.error(`[smoke-thinking-block] FAIL: ${msg}`)
  process.exit(1)
}

// The exact failure shape: a thinking block, carrying a client cache_control
// marker, sitting in an assistant message that is NOT the last message (so it is
// the "latest assistant message" Anthropic protects). upgradeCacheControlTtl walks
// ALL messages; injectCacheMarkers targets the last message.
function makeBody(): string {
  return JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    system: 'you are helpful',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'reasoning', signature: 'sig', cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
    ],
  })
}

function thinkingBlockOf(body: any): any {
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type === 'thinking' || b?.type === 'redacted_thinking') return b
    }
  }
  return null
}

const { enrichAnthropicRequest } = await import(TRANSLATE)
const { upgradeCacheControlTtl } = await import(SDK_BUNDLE)

if (typeof enrichAnthropicRequest !== 'function') fail(`enrichAnthropicRequest not exported from ${TRANSLATE}`)
if (typeof upgradeCacheControlTtl !== 'function') fail(`upgradeCacheControlTtl not exported from ${SDK_BUNDLE}`)

// Path 1: daemon enrichment (injectCacheMarkers + prompt-caching-scope beta).
const enriched = enrichAnthropicRequest(makeBody(), {}, 'smoke-session')
const afterEnrich = JSON.parse(enriched.body)
let tb = thinkingBlockOf(afterEnrich)
if (!tb) fail('thinking block disappeared after enrichAnthropicRequest')
const ccAfterEnrich = JSON.stringify(tb.cache_control)
if (ccAfterEnrich !== JSON.stringify({ type: 'ephemeral' }))
  fail(`enrichAnthropicRequest modified the thinking block cache_control: ${ccAfterEnrich}`)

// Path 2: SDK ttl upgrade (runs in ProxyClient.handleRequest on the live path).
upgradeCacheControlTtl(afterEnrich)
tb = thinkingBlockOf(afterEnrich)
const ccAfterTtl = JSON.stringify(tb.cache_control)
if (ccAfterTtl !== JSON.stringify({ type: 'ephemeral' }))
  fail(`upgradeCacheControlTtl modified the thinking block cache_control (ttl bumped): ${ccAfterTtl}`)

console.log('[smoke-thinking-block] PASS: thinking block survived enrich + ttl-upgrade unchanged (deployed artifacts)')
process.exit(0)
