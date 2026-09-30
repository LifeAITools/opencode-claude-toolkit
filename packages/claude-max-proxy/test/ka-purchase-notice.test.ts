/**
 * Строка фаундеру, когда прогрев купил кэш (src/ka-purchase-notice.ts).
 * «Да, присылать» — фаундер 30.09.2026, на каждую запись прогрева больше 50 тысяч, через сурфейс.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { bus } from '../src/event-bus.js'
import { _setNoticeSender, type SystemNotice } from '../src/surface-card.js'
import { purchaseNoticeText, startKaPurchaseNotice } from '../src/ka-purchase-notice.js'

afterEach(() => _setNoticeSender(null))

const fire = (write: number, extra: Record<string, unknown> = {}) => ({
  level: 'info', kind: 'KA_FIRE_COMPLETE', sessionId: '036c8476-a8f7-4886-b9d9-fade279ac37f',
  lineageKey: '27ca338db3d2:9ffb148d9c21', role: 'main', idleMs: 1_658_669,
  provenBeforeFire: false, lineageTtlMs: 3_600_000, lineageTokens: 368_000,
  usage: { inputTokens: 21, outputTokens: 1, cacheReadInputTokens: 22_940, cacheCreationInputTokens: write },
  ...extra,
}) as any

describe('строка о покупке кэша прогревом', () => {
  test('первая строка — короткий итог; дальше агент по имени, ветка, числа; номера в конце', () => {
    const t = purchaseNoticeText(fire(345_324), { agentName: 'vibe-music-notation-owner', memberId: 'm' })
    const lines = t.split('\n')
    expect(lines[0]).toBe('**Прогрев купил кэш: 345 тыс.**')
    expect(t).toContain('**vibe-music-notation-owner**')
    expect(t).toContain('главный разговор, 368 тыс. токенов')
    expect(t).toContain('записано 345 тыс., прочитано 23 тыс.')
    expect(t).toContain('простояла 28 мин, её кэш живёт 1 ч')
    expect(t).toContain('первый выстрел по ветке после перезапуска')
    expect(lines[lines.length - 1]).toContain('036c8476-a8f7-4886-b9d9-fade279ac37f')
  })

  test('выше порога — уходит в комнату проекта; ниже — молчит', async () => {
    const sent: SystemNotice[] = []
    _setNoticeSender(async (n) => { sent.push(n); return { sent: true, messageId: 1 } })
    const stop = startKaPurchaseNotice(() => ({ agentName: 'a' }))
    bus.emitEvent(fire(49_000))
    bus.emitEvent(fire(64_664))
    await new Promise((r) => setTimeout(r, 10))
    stop()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.chatId).toBe('-1004351473367')
    expect(sent[0]!.threadId).toBe('9090')
    expect('menuAbout' in sent[0]!).toBe(false)   // строка о прокси — без кнопок агента
  })

  test('после перезапуска пачкой — не больше потолка строк в час', async () => {
    const sent: SystemNotice[] = []
    _setNoticeSender(async (n) => { sent.push(n); return { sent: true } })
    const stop = startKaPurchaseNotice(() => null)
    for (let i = 0; i < 15; i++) bus.emitEvent(fire(100_000))
    await new Promise((r) => setTimeout(r, 10))
    stop()
    expect(sent).toHaveLength(10)
  })
})
