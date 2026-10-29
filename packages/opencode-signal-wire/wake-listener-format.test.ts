import { describe, expect, test } from 'bun:test'
import { formatWakeMessage, wakeText } from './wake-listener'
import type { WakeEvent } from './wake-types'

// Пять веток ДОСТАВКИ удалены из formatWakeMessage 17.10 (замер: 0 заходов в
// fallback за 1.3 суток — все доставки несут `rendered` роутера). Разрешение
// автора канала теперь дело РОУТЕРА (его wake-render.ts) и проверяется там;
// здесь держится ПРАВИЛО адаптера: доставка берёт готовое, квота рисуется сама,
// а отсутствие текста зовётся по имени.

function quotaEvent(payload: Record<string, unknown> = {}): WakeEvent {
  return {
    eventId: 'evt-quota',
    source: 'proxy',
    type: 'quota_critical',
    priority: 'urgent',
    targetMemberId: '',
    payload: {
      accountHint: 'acct-1', util5h: 0.99, util7d: 0.5, level: 'critical',
      message: 'stop', issuedAt: '2026-04-28T20:16:48.833Z', ...payload,
    },
    timestamp: '2026-04-28T20:16:48.833Z',
  }
}

function deliveredEvent(payload: Record<string, unknown> = {}): WakeEvent {
  return {
    eventId: 'evt-delivery',
    source: 'synqtask',
    type: 'channel_message',
    priority: 'urgent',
    targetMemberId: 'agent-developer',
    payload: { channelId: 'c1', authorName: 'agent-ceo', text: 'привет', ...payload },
    timestamp: '2026-04-28T20:16:48.833Z',
  }
}

describe('формат побудки — текст доставки приходит готовым, свой рисуется только для квоты', () => {
  test('rendered есть — вставляется как есть: full на границе хода, brief посреди', () => {
    const ev = deliveredEvent({ rendered: { v: 1, full: 'ПОЛНЫЙ', brief: 'КОРОТКИЙ', parts: {} } })
    expect(wakeText(ev, 'full')).toBe('ПОЛНЫЙ')
    expect(wakeText(ev, 'brief')).toBe('КОРОТКИЙ')
  })

  test('доставка БЕЗ rendered — честное «роутер не приложил», а НЕ нарисованное адаптером', () => {
    const own = wakeText(deliveredEvent(), 'full')
    expect(own.startsWith('<system-reminder type="wake"')).toBe(true)
    expect(own).toContain('Роутер не приложил текст побудки')
    // Своего текста НЕТ: ни автора, ни инструкций — рисовальщик теперь один.
    expect(own).not.toContain('agent-ceo')
    expect(own).not.toContain('todo_channels')
  })

  test('rendered непонятной формы (v2) — тоже честный отказ, а не выдумка', () => {
    const fb = wakeText(deliveredEvent({ rendered: { v: 2, full: 'X', brief: 'Y' } }), 'full')
    expect(fb).toContain('Роутер не приложил текст побудки')
    expect(fb).not.toContain('X')
  })

  test('квота — ЕДИНСТВЕННЫЙ вид, который рисует адаптер (роутер её не видит)', () => {
    const local = wakeText(quotaEvent(), 'full')
    expect(local.startsWith('<system-reminder type="wake"')).toBe(true)
    expect(local).toContain('acct-1')
    expect(local).not.toContain('Роутер не приложил')
  })
})

describe('воспроизведение из склада — читаемо, но названо воспроизведением', () => {
  // Жалоба владельца telegram-mcp 29.10.2026: событие `replay:` собирается в адаптере из строки
  // `synqtask.activity`, роутера в этой дороге нет — и `rendered` не «потерян», его неоткуда
  // взять. Прежний код называл это дефектом доставки и вставлял объяснение хука вместо письма.
  const replay = (payload: Record<string, unknown>): WakeEvent => ({
    eventId: 'replay:act-1:member-1:abc123',
    source: 'synqtask.activity',
    type: 'channel_message',
    priority: 'info',
    targetMemberId: 'member-1',
    payload: { replayedFromActivity: true, ...payload },
    timestamp: '2026-10-29T10:00:00.000Z',
  })

  test('текст и автор из склада попадают в письмо', () => {
    const text = wakeText(replay({ text: 'Проверь очередь сборки', authorName: 'Руслан', channelId: 'ch-1' }), 'full')
    expect(text).toContain('Проверь очередь сборки')
    expect(text).toContain('Руслан')
    expect(text).toContain('ch-1')
    expect(text).not.toContain('Роутер не приложил текст побудки')
  })

  test('происхождение названо: это воспроизведение, а не живая доставка', () => {
    const text = wakeText(replay({ text: 'x' }), 'full')
    expect(text).toContain('Воспроизведение')
    expect(text).toContain('event-id="replay:')
  })

  test('в строке склада нет содержания — честно, а не пустой «🔔 WAKE: wake»', () => {
    const text = wakeText(replay({}), 'full')
    expect(text.startsWith('<system-reminder')).toBe(true)
    expect(text).toContain('replayed_from_activity')
  })

  test('живая доставка без rendered по-прежнему зовётся дефектом доставки', () => {
    expect(wakeText(deliveredEvent(), 'full')).toContain('Роутер не приложил текст побудки')
  })
})

describe('formatWakeMessage — настроечные данные не повторяются в каждой побудке', () => {
  // Слово фаундера 02.10: блок «кто ты, роль, команда, напарники» приходил с каждым сообщением,
  // у одиночки — «Team: none. Teammates: none.». Роль агент получает один раз на старте сессии
  // стартовым контекстом ядра; в побудке её больше нет, даже если личность известна.
  test('с известной личностью — ни блока, ни роли, ни напарников', () => {
    const identity = {
      name: 'vibe-synqtalk-owner', roleName: 'Project Owner', rolePrompt: 'You own the project.',
      teamName: null, teammates: [], budget: { maxSubagents: 5, maxSpawnDepth: 2 },
    } as any
    const text = formatWakeMessage(quotaEvent(), identity)
    expect(text).not.toContain('<agent-identity')
    expect(text).not.toContain('You own the project.')
    expect(text).not.toContain('Teammates')
    expect(text.startsWith('<system-reminder type="wake"')).toBe(true)
  })
})

describe('приёмник не пишет в SynqTask за агента', () => {
  // 02.10.2026, решение владельца SynqTask: статус задачи — дело самого агента, а runtime_state
  // через batch_update_active порождал на сервере agent_waking — адаптер сам себе вызывал подъём.
  test('в приёмнике нет смены статуса задачи, runtime_state и wakeLifecycle', async () => {
    // Проверяется КОД, а не комментарии: пояснение, почему записи удалены, называет их по имени.
    const src = (await Bun.file(new URL('./wake-listener.ts', import.meta.url)).text())
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toContain("action: 'set_status'")
    expect(src).not.toContain('batch_update_active')
    expect(src).not.toContain("key: 'wakeLifecycle'")
    expect(src).not.toContain('Starting work on')
  })
})
