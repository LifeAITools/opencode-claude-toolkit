/**
 * `x-claude-max-cache: none` — клиент с разовыми запросами отказывается от точек кэша.
 *
 * 🔴 ЧЕМ КУПЛЕНО (01.10.2026, замер vibe-kiberos-app-owner). Служба поиска чата шлёт
 * через прокси разовые запросы без cache_control (каждый раз новые страницы). Прокси
 * сам ставил в них часовые точки кэша: cache_read 0, cache_write до 17 тысяч на ход,
 * а прогрев ещё и грел эти ветки (4 выстрела по ~11 тысяч чтения), хотя прочитать их
 * было некому. Что запросы разовые, знает только клиент — поэтому он и говорит.
 */
import { describe, test, expect } from 'bun:test'
import { enrichAnthropicRequest, cacheInjectionDisabled, detectCacheTtlFromBody } from '../src/index.js'
import { translateToAnthropicBody } from '../packages/claude-max-proxy/src/openai-translate.js'

const body = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 500,
  system: 'You summarise search results.',
  messages: [{ role: 'user', content: 'page text '.repeat(200) }],
})

describe('отказ от вставки точек кэша', () => {
  test('без заголовка — как раньше: точки вставлены', () => {
    const r = enrichAnthropicRequest(body, { 'content-type': 'application/json' }, 'ses-a')
    expect(detectCacheTtlFromBody(JSON.parse(r.body)).hasAnyCacheControl).toBe(true)
  })

  test('с заголовком none — ни одной точки, значит и прогрев не вооружится', () => {
    const r = enrichAnthropicRequest(body, { 'content-type': 'application/json', 'X-Claude-Max-Cache': 'none' }, 'ses-b')
    expect(detectCacheTtlFromBody(JSON.parse(r.body)).hasAnyCacheControl).toBe(false)
  })

  test('заголовок не уходит к Anthropic', () => {
    const r = enrichAnthropicRequest(body, { 'x-claude-max-cache': 'none' }, 'ses-c')
    expect(Object.keys(r.headers).map(k => k.toLowerCase())).not.toContain('x-claude-max-cache')
  })

  test('свои точки клиента не трогаются и при заголовке', () => {
    const own = JSON.stringify({ ...JSON.parse(body), system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] })
    const r = enrichAnthropicRequest(own, { 'x-claude-max-cache': 'none' }, 'ses-d')
    expect(JSON.parse(r.body).system.some((b: any) => b.cache_control)).toBe(true)
  })

  test('любое другое значение не выключает (только явное none)', () => {
    expect(cacheInjectionDisabled({ 'x-claude-max-cache': 'off' })).toBe(false)
    expect(cacheInjectionDisabled(new Headers({ 'x-claude-max-cache': ' None ' }))).toBe(true)
    expect(cacheInjectionDisabled(undefined)).toBe(false)
  })

  test('вход OpenAI: тот же отказ', () => {
    const req = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi '.repeat(200) }] } as any
    const on = translateToAnthropicBody(req)
    const off = translateToAnthropicBody(req, { injectCache: false })
    expect(detectCacheTtlFromBody(JSON.parse(on.body)).hasAnyCacheControl).toBe(true)
    expect(detectCacheTtlFromBody(JSON.parse(off.body)).hasAnyCacheControl).toBe(false)
  })
})

/**
 * 🔴 Системная часть строкой — строка учёта ОТДЕЛЬНЫМ блоком. Живая проба 01.10.2026:
 * склеенная в одну строку, системная часть клиента до модели не доходила вовсе
 * («NONE» вместо секретного слова; 13.6 тыс. токенов посчитаны как 9).
 */
describe('строка учёта не склеивается с системной частью клиента', () => {
  test('строка → два блока, текст клиента цел и отдельно', () => {
    const r = enrichAnthropicRequest(JSON.stringify({ model: 'claude-haiku-4-5', system: 'The secret word is ZEBRA.', messages: [{ role: 'user', content: 'x' }] }), {}, 'ses-s')
    const sys = JSON.parse(r.body).system
    expect(Array.isArray(sys)).toBe(true)
    expect(sys[0].text).toContain('x-anthropic-billing-header')
    expect(sys[0].text).not.toContain('ZEBRA')
    expect(sys.some((b: any) => b.text === 'The secret word is ZEBRA.')).toBe(true)
  })
  test('withBillingBlock: массив, пусто, отсутствие', async () => {
    const { withBillingBlock } = await import('../src/index.js')
    expect(withBillingBlock([{ type: 'text', text: 'a' }], 'B')).toEqual([{ type: 'text', text: 'B' }, { type: 'text', text: 'a' }])
    expect(withBillingBlock(undefined, 'B')).toBe('B')
    expect(withBillingBlock('', 'B')).toBe('B')
  })
})
