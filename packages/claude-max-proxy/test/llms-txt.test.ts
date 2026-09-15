/**
 * ДВЕРЬ «ЧТО ЭТО И КАК СО МНОЙ РАБОТАТЬ» — И ПОЧЕМУ ОНА ОБЯЗАНА ОТВЕЧАТЬ.
 *
 * Спросил общий агент 07.09.2026, передавая наблюдение владельца службы схем:
 * агент, пришедший за руководством, получал 404 и уходил, а служба считалась
 * «невостребованной». Замер 15.09.2026 показал у нас ровно то же — `/llms.txt`
 * отвечал 404 при живых `/health` и `/version`.
 *
 * Цена немоты у нас выше, чем у соседа: сосед, которого остановил наш сторож,
 * получает 400 и до этой двери не имел НИ ОДНОГО места, где написано, что этот
 * отказ значит. Поэтому здесь проверяется не факт «200», а то, что в ответе
 * есть именно те слова, по которым сосед опознаёт наш отказ и находит выход.
 */

import { describe, test, expect } from 'bun:test'
import { createHealthModule } from '../src/modules/health.js'

/** Достать обработчик двери, не поднимая службу. Версию подаём свою — она в
 *  ответе живая, и это проверяется отдельно. */
function routeFor(path: string) {
  const mod = createHealthModule({ mode: 'global', parentPid: 0 } as never)
  mod.init?.({
    config: { logLevel: 'info' },
    proxyClient: { sessionCount: () => 0 },
    version: '9.9.9-test',
  } as never)
  return (mod as unknown as { routes: Array<{ method: string; path: string; handler: Function }> })
    .routes.find((x) => x.path === path)
}

describe('служба сама рассказывает, что она и как с ней работать', () => {
  test('дверь есть и отвечает простым текстом', async () => {
    const r = routeFor('/llms.txt')
    expect(r).toBeDefined()
    const res = await r!.handler(new Request('http://x/llms.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
  })

  test('🔴 названы ОБА сторожа теми словами, по которым сосед их опознаёт', async () => {
    const text = await (await routeFor('/llms.txt')!.handler(new Request('http://x/llms.txt'))).text()
    // Эти два начала — обязательство перед потребителями: у Claude Code нет
    // класса для нашего 400, он пишет его как 'unknown', и опознают нас по ним.
    expect(text).toContain('Cache guard')
    expect(text).toContain('Quota guard')
  })

  test('назван выход из каждого: согласие человека и ожидание сброса', async () => {
    const text = await (await routeFor('/llms.txt')!.handler(new Request('http://x/llms.txt'))).text()
    expect(text).toContain('context cache-rewrite-ok')
    expect(text).toContain('Кэши при этом ЖИВЫ')
  })

  test('назван способ назваться — иначе прогрев не вооружится', async () => {
    const text = await (await routeFor('/llms.txt')!.handler(new Request('http://x/llms.txt'))).text()
    expect(text).toContain('x-claude-code-session-id')
    expect(text).toContain('metadata.user_id')
  })

  test('версия в тексте — ЖИВАЯ, а не вписанная строкой', async () => {
    const text = await (await routeFor('/llms.txt')!.handler(new Request('http://x/llms.txt'))).text()
    expect(text).toContain('9.9.9-test')
  })
})
