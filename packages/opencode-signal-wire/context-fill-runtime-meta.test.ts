/**
 * Готовая строка заполнения контекста в runtimeMeta opencode (поле `contextFill`).
 *
 * Правило `context-meta-baseline` просит `{contextFill}` — одну строку для показа, потому что текст
 * правила подставляет величины дословно и ветвиться не умеет. Хук Claude Code её слал
 * (`signal-wire-hook.sh`: `CONTEXT_FILL="${PERCENT}% · ${TOKENS} из ${WINDOW}"`), а плагин opencode
 * клал только числа — `{contextFill}` разворачивалось в пустоту. Здесь закреплён контракт поля:
 * оно ВСЕГДА есть, и неизмеренный случай называет себя прямо, а не печатает «0%».
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'

const dir = mkdtempSync(join(tmpdir(), 'oc-ctx-fill-'))
const rulesPath = join(dir, 'rules.json')
writeFileSync(rulesPath, JSON.stringify({ rules: [] }))

function make(): SignalWire {
  return new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_ctxfill', rulesPath, platform: 'opencode' })
}

describe('opencode: готовая строка заполнения контекста (runtimeMeta.contextFill)', () => {
  test('неизмеренный контекст НАЗЫВАЕТ себя, а не печатает «0%»', () => {
    expect(make().getCurrentRuntimeMeta().contextFill).toBe('НЕ ИЗМЕРЕНО (это не «пусто»)')
  })

  test('измеренный контекст — одна строка «{процент}% · {токены} из {окно}»', () => {
    const sw = make()
    ;(sw as any).contextPosition = 740_000
    ;(sw as any).lastContextWindow = 1_000_000
    expect(sw.getCurrentRuntimeMeta().contextFill).toBe('74% · 740000 из 1000000')
  })
})
