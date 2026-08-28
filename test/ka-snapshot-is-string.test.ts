/**
 * Снимок прогрева хранится СТРОКОЙ — и это не деталь укладки, а инвариант.
 *
 * 🔴 ЧЕМ КУПЛЕНО (29.08.2026). Снимок хранился разобранным деревом и на каждом
 * реальном запросе создавался глубоким клоном `JSON.parse(JSON.stringify(body))`
 * — единственно затем, чтобы он не поехал следом за телом, которое вызывающий
 * может изменить. Замер на настоящем теле 3.4 МБ: клон стоит 8.4 мс и всплеск
 * 3.7 МБ на ХОД, а дерево потом ещё и держится в памяти — 3.7 МБ на родословную.
 * Строка неизменяема сама по себе, поэтому защищать её копированием не от чего.
 *
 * Повод пришёл снаружи: у соседнего проекта экземпляр убило ядро за память при
 * потолке в гигабайт, профиль — единицы сессий с огромными телами.
 *
 * 🔴 И ГЛАВНОЕ, РАДИ ЧЕГО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ: при переводе на строку едва не
 * случилась тихая беда. `detectCacheTtlFromBody` принимает `unknown` и на
 * СТРОКЕ молча возвращает «меток кэша нет» — тип бы не возразил, тесты бы
 * прошли, а прогрев перестал бы срабатывать для всех, потому что снимок без
 * меток пропускается в tick(). Признак снимается теперь при приёме, с живого
 * дерева, и здесь это проверяется отдельно.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'

function mkEngine() {
  return new KeepaliveEngine({
    config: { enabled: true, intervalMs: 60_000, cacheTtlMs: 300_000 } as never,
    getToken: async () => 'tok',
    doFetch: async function* () { /* не вызывается в этих проверках */ },
    getRateLimitInfo: () => ({}) as never,
  } as never)
}

const bodyWithCache = () => ({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'системная часть', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 'Read' }, { name: 'Bash' }],
  messages: [{ role: 'user', content: 'сделай дело ' + 'x'.repeat(4000) }],
})

const usage = { inputTokens: 60_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } as never

describe('снимок прогрева хранится строкой', () => {
  test('в реестре лежит строка, и она разбирается обратно в то же тело', () => {
    const e = mkEngine()
    const body = bodyWithCache()
    const key = e.notifyRealRequestStart('claude-opus-4-7', body, { 'x-app': 'cli' })
    e.notifyRealRequestComplete(usage, key)
    const entry = [...(e as never as { registry: Map<string, { body: unknown }> }).registry.values()][0]!
    expect(typeof entry.body).toBe('string')
    expect(JSON.parse(entry.body as string)).toEqual(body)
    e.stop()
  })

  test('🔴 метки кэша ВИДНЫ — признак снят с дерева при приёме, а не со строки при завершении', () => {
    const e = mkEngine()
    const body = bodyWithCache()
    const key = e.notifyRealRequestStart('claude-opus-4-7', body, {})
    e.notifyRealRequestComplete(usage, key)
    const entry = [...(e as never as { registry: Map<string, { hasCacheControl: boolean }> }).registry.values()][0]!
    // Со строкой detectCacheTtlFromBody ответила бы «меток нет», прогрев бы
    // молча перестал срабатывать, и ни один тип этого не поймал бы.
    expect(entry.hasCacheControl).toBe(true)
    e.stop()
  })

  test('снимок не едет следом за телом, которое вызывающий изменил после передачи', () => {
    const e = mkEngine()
    const body = bodyWithCache()
    const key = e.notifyRealRequestStart('claude-opus-4-7', body, {})
    ;(body.messages as { role: string; content: string }[])[0]!.content = 'ПОДМЕНА ПОСЛЕ ПЕРЕДАЧИ'
    e.notifyRealRequestComplete(usage, key)
    const entry = [...(e as never as { registry: Map<string, { body: string }> }).registry.values()][0]!
    expect(entry.body).not.toContain('ПОДМЕНА ПОСЛЕ ПЕРЕДАЧИ')
    e.stop()
  })

  test('снимки прежних версий (телом-деревом) поднимаются с диска как прежде', () => {
    const e = mkEngine()
    const oldShape = {
      cacheWrittenAt: Date.now() - 10_000,
      cacheTtlMs: 300_000,
      cacheTtlOverridden: false,
      cacheTtlObservedLocked: false,
      lastObservedTtlMs: null,
      ttlEverObserved: false,
      lastKnownCacheTokensByModel: {},
      registry: [{
        body: bodyWithCache(),          // ДЕРЕВО, как писали до этой правки
        headers: { 'x-app': 'cli' },
        model: 'claude-opus-4-7',
        lineageKey: 'sys:tools',
        role: 'main',
        inputTokens: 60_000,
        hasCacheControl: true,
      }],
    }
    ;(e as never as { revive: (s: unknown) => void }).revive(oldShape)
    const entry = [...(e as never as { registry: Map<string, { body: unknown }> }).registry.values()][0]
    expect(entry).toBeDefined()
    expect(typeof entry!.body).toBe('string')
    expect(JSON.parse(entry!.body as string).model).toBe('claude-opus-4-7')
    e.stop()
  })
})
