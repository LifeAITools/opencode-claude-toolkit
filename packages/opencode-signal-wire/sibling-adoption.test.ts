/**
 * Усвоение sibling-карточки по ПРИВЯЗКЕ, а не только по pid (правка 16.10.2026).
 *
 * Карточку CLI lat-context пишет СВОЙ процесс, поэтому pid у неё другой (замер: у
 * vibe_kiberos-billing CLI — 3938612, плагин — 3938911). Прежний матч по pid не срабатывал
 * НИКОГДА, и memberId оставался harness-личностью. Тот же матч даёт tmux-сессию — запасную дверь.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptFromSiblingCards } from './wake-listener'

const dir = () => mkdtempSync(join(tmpdir(), 'sib-'))

describe('усвоение sibling-карточки по привязке', () => {
  test('карточка CLI с ДРУГИМ pid — усваивается по привязке (memberId + tmux)', () => {
    const d = dir()
    const self = join(d, '100-vibe_x_owner_01.json')
    writeFileSync(self, JSON.stringify({ pid: 100, contract: 'agent-presence/1' }))
    writeFileSync(join(d, '200-vibe_x_owner_01.json'), JSON.stringify({
      pid: 200, tmux_binding_id: 'vibe_x_owner_01', tmux_session_id: 'ctx-a-vibe_x_owner_01',
      memberId: 'real-member', memberName: 'x-owner',
    }))
    const r = adoptFromSiblingCards(d, self, 100, 'vibe_x_owner_01')
    expect(r.memberId).toBe('real-member')
    expect(r.memberName).toBe('x-owner')
    expect(r.tmuxSession).toBe('ctx-a-vibe_x_owner_01')
  })

  test('чужая привязка не усваивается', () => {
    const d = dir()
    const self = join(d, '100-vibe_x_owner_01.json')
    writeFileSync(self, '{}')
    writeFileSync(join(d, '200-vibe_y_owner_01.json'), JSON.stringify({
      pid: 200, tmux_binding_id: 'vibe_y_owner_01', memberId: 'other', tmux_session_id: 'ctx-a-vibe_y_owner_01',
    }))
    const r = adoptFromSiblingCards(d, self, 100, 'vibe_x_owner_01')
    expect(r.memberId).toBeUndefined()
    expect(r.tmuxSession).toBeUndefined()
  })

  test('своя карточка не усваивается сама из себя', () => {
    const d = dir()
    const self = join(d, '100-vibe_x_owner_01.json')
    writeFileSync(self, JSON.stringify({ pid: 100, tmux_binding_id: 'vibe_x_owner_01', memberId: 'self' }))
    expect(adoptFromSiblingCards(d, self, 100, 'vibe_x_owner_01').memberId).toBeUndefined()
  })

  test('нет каталога — пусто, без исключения', () => {
    expect(adoptFromSiblingCards('/nonexistent/dir', '/nonexistent/dir/a.json', 1, 'b')).toEqual({})
  })

  test('совпадение по pid всё ещё работает (обратная совместимость)', () => {
    const d = dir()
    const self = join(d, '100-vibe_x_owner_01.json')
    writeFileSync(self, '{}')
    writeFileSync(join(d, '100-legacy.json'), JSON.stringify({ pid: 100, tmux_binding_id: 'x', memberId: 'legacy' }))
    expect(adoptFromSiblingCards(d, self, 100, undefined).memberId).toBe('legacy')
  })
})
