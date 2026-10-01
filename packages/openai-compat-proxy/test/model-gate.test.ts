/**
 * model-gate: модель вне /models апстрима — отказ 400 с именем, а не тихое списание мимо подписки.
 * Замер 01.10.2026: `deepseek-v4-pro-0813` отвечал по имени через ключ Token Plan, которого нет
 * в его /models, и 192 вызова за 9 дней ушли мимо плана. Нашли по письму о квоте.
 */
import { describe, test, expect } from 'bun:test'
import { UpstreamModelGate } from '../src/model-gate.js'

const LIST = ['deepseek-v4-pro', 'deepseek-v4.1-flash', 'qwen3.8-max']

function fakeUpstream(opts: { ok?: boolean; ids?: string[]; throws?: boolean } = {}) {
  const calls: Array<{ url: string; auth: string | undefined }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)?.authorization })
    if (opts.throws) throw new Error('network')
    return new Response(JSON.stringify({ data: (opts.ids ?? LIST).map((id) => ({ id })) }), { status: opts.ok === false ? 401 : 200 })
  }
  return { calls, fetcher }
}

describe('модель вне подписки', () => {
  test('датированный снимок, которого нет в /models, — отказ 400 с его именем и списком', async () => {
    const { fetcher } = fakeUpstream()
    const r = await new UpstreamModelGate(fetcher).check('https://up/compatible-mode', 'Bearer k', 'deepseek-v4-pro-0813')
    expect(r?.status).toBe(400)
    const body = await r!.json() as any
    expect(body.error.code).toBe('model_not_in_plan')
    expect(body.error.message).toContain('deepseek-v4-pro-0813')
    expect(body.error.offered).toEqual(LIST)
  })

  test('модель из списка проходит', async () => {
    const { fetcher } = fakeUpstream()
    expect(await new UpstreamModelGate(fetcher).check('https://up', 'Bearer k', 'deepseek-v4-pro')).toBeNull()
  })

  test('список спрашивается тем же ключом, что пришёл с запросом, и по пути апстрима', async () => {
    const { calls, fetcher } = fakeUpstream()
    await new UpstreamModelGate(fetcher).check('https://up/compatible-mode/', 'Bearer k1', 'x')
    expect(calls[0]).toEqual({ url: 'https://up/compatible-mode/v1/models', auth: 'Bearer k1' })
  })

  test('список держится в памяти: второй вызов апстрим не трогает; другой ключ — свой список', async () => {
    const { calls, fetcher } = fakeUpstream()
    const g = new UpstreamModelGate(fetcher)
    await g.check('https://up', 'Bearer k1', 'deepseek-v4-pro')
    await g.check('https://up', 'Bearer k1', 'qwen3.8-max')
    expect(calls.length).toBe(1)
    await g.check('https://up', 'Bearer k2', 'qwen3.8-max')
    expect(calls.length).toBe(2)
  })

  test('сбой списка (сеть, 401, пусто) — пропускаем: проверка не роняет работу', async () => {
    for (const opts of [{ throws: true }, { ok: false }, { ids: [] as string[] }]) {
      const { fetcher } = fakeUpstream(opts)
      expect(await new UpstreamModelGate(fetcher).check('https://up', 'Bearer k', 'anything')).toBeNull()
    }
  })

  test('нет имени модели — нечего проверять', async () => {
    const { calls, fetcher } = fakeUpstream()
    expect(await new UpstreamModelGate(fetcher).check('https://up', 'Bearer k', undefined)).toBeNull()
    expect(calls.length).toBe(0)
  })
})
