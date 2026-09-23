/**
 * Отказ 429 на двери OpenAI несёт срок ожидания дальше.
 *
 * Принёс vibe-kiberos-app-owner 19.09.2026: журнал знал retryAfterSec=420352 (недельное
 * окно, почти пять суток), а человек у экрана получил «Please try again later» и стучался
 * снова. Дверь пересобирала ответ в форму OpenAI и теряла заголовки апстрима.
 */
import { describe, expect, test } from 'bun:test'
import { createOpenAICompatModule } from '../src/modules/openai-compat.js'
import type { ModuleContext } from '../src/module.js'

function moduleWith(upstream: Response) {
  const mod = createOpenAICompatModule()
  mod.init({
    emit: () => {},
    config: { openaiCompatAuthToken: null, openaiCompatThinking: 'strip' } as unknown as ModuleContext['config'],
    proxyClient: { handleRequest: async () => upstream } as unknown as ModuleContext['proxyClient'],
    managedSessions: {} as ModuleContext['managedSessions'],
    version: 'test',
  })
  const route = mod.routes.find(r => r.method === 'POST' && r.path === '/v1/chat/completions')!
  const req = new Request('http://x/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'ra-test' },
    body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return route.handler(req, { requestIP: () => null })
}

const rateLimited = (headers: Record<string, string>) => new Response(
  JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account\'s rate limit. Please try again later.' } }),
  { status: 429, headers: { 'content-type': 'application/json', ...headers } },
)

describe('срок ожидания доезжает до потребителя', () => {
  test('429 с retry-after — тот же заголовок в ответе OpenAI', async () => {
    const res = await moduleWith(rateLimited({ 'retry-after': '420352' }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('420352')
  })
  test('без retry-after у апстрима — заголовка не выдумываем', async () => {
    const res = await moduleWith(rateLimited({}))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeNull()
  })
})
