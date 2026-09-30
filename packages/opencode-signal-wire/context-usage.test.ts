/**
 * Заполнение контекста агента opencode — из событий самого opencode (context-usage.ts).
 * 30.09 пилот SynqTalk на zai-coding-plan/glm-5.3 шёл мимо прокси, и отметка жизни несла
 * context_measured:false. Числа ниже — из базы opencode того же дня.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { heartbeatPath } from '@kiberos/signal-wire-core'
import { createModelWindowResolver, usageFromMessageEvent } from './context-usage'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'

const msg = (tokens: any, extra: any = {}) => ({
  type: 'message.updated',
  properties: { info: { role: 'assistant', sessionID: 'ses_p', providerID: 'zai-coding-plan', modelID: 'glm-5.3', tokens, ...extra } },
})

describe('opencode: замер заполнения из message.updated', () => {
  test('ответ ассистента: вход + чтение кэша + запись кэша последнего шага', () => {
    expect(usageFromMessageEvent(msg({ input: 656, output: 323, cache: { read: 293_952, write: 0 } })))
      .toEqual({ sessionId: 'ses_p', providerId: 'zai-coding-plan', modelId: 'glm-5.3', promptTokens: 294_608 })
  })

  test('не ответ ассистента, шаг ещё без токенов, чужое событие — null', () => {
    expect(usageFromMessageEvent(msg({ input: 0, output: 0, cache: { read: 0, write: 0 } }))).toBeNull()
    expect(usageFromMessageEvent({ type: 'message.updated', properties: { info: { role: 'user', sessionID: 's' } } })).toBeNull()
    expect(usageFromMessageEvent({ type: 'session.idle', properties: {} })).toBeNull()
  })

  test('окно модели — из каталога, один запрос на процесс; неизвестная модель — null', async () => {
    let calls = 0
    const resolve = createModelWindowResolver(async () => {
      calls++
      return { data: { providers: [{ id: 'zai-coding-plan', models: { 'glm-5.3': { limit: { context: 1_000_000 } } } }] } }
    })
    expect(await resolve('zai-coding-plan', 'glm-5.3')).toBe(1_000_000)
    expect(await resolve('zai-coding-plan', 'nope')).toBeNull()
    expect(calls).toBe(1)
  })

  test('сбой каталога не запоминается — следующий ответ спросит снова', async () => {
    let calls = 0
    const resolve = createModelWindowResolver(async () => { calls++; if (calls === 1) throw new Error('down'); return { data: { providers: [{ id: 'p', models: { m: { limit: { context: 5 } } } }] } } })
    expect(await resolve('p', 'm')).toBeNull()
    expect(await resolve('p', 'm')).toBe(5)
  })

  test('сквозь адаптер: модель не из таблицы Claude, окно из каталога — отметка жизни несёт замер', async () => {
    const sid = 'ses_ctx_glm'
    const sw = new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: sid, rulesPath: join(process.env.SW_HEARTBEAT_DIR!, 'none.json'), platform: 'opencode' })
    sw.trackModel('glm-5.3', 'zai-coding-plan')
    sw.trackContextWindow('glm-5.3', 1_000_000)
    sw.trackTokens({ inputTokens: 294_608 })
    await sw.evaluateHook({ source: 'plugin', type: 'session.idle', sessionId: sid, timestamp: Date.now(), payload: {} } as any)
    const hb = JSON.parse(readFileSync(heartbeatPath(process.env.SW_HEARTBEAT_DIR!, sid), 'utf-8'))
    expect(hb.context_measured).toBe(true)
    expect(hb.context_tokens).toBe(294_608)
    expect(hb.context_window).toBe(1_000_000)
    expect(hb.context_percent).toBe(29)
    // Модель — как её набирает пускатель, чтобы реестр сравнил выбранную с работающей строка в строку.
    expect(hb.context_model).toBe('zai-coding-plan/glm-5.3')
    // А в правила — без провайдера: на это имя опираются их условия.
    expect(sw.getCurrentRuntimeMeta().model).toBe('glm-5.3')
  })

  test('окно каталога важнее таблицы и переживает повторный trackModel', () => {
    const sw = new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_w', rulesPath: join(process.env.SW_HEARTBEAT_DIR!, 'none.json'), platform: 'opencode' })
    sw.trackContextWindow('glm-5.3', 1_000_000)
    sw.trackModel('glm-5.3')
    expect(sw.getCurrentRuntimeMeta().contextWindow).toBe(1_000_000)
  })

  test('в плагине больше нет оценки контекста по длине реплики (символы/4)', () => {
    const src = readFileSync(join(import.meta.dir, 'plugin.ts'), 'utf-8')
    expect(src).not.toMatch(/totalChars\s*\/\s*4/)
    expect(src).toContain('usageFromMessageEvent(event)')
  })
})
