/**
 * Имя записи присутствия opencode — по привязке (wake-listener.ts, discoveryFilePath).
 * 30.09 пилот SynqTalk лежал как `30234-unknown.json`, и читатели lat-context (`*-<привязка>.json`)
 * звали живого агента offline.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryFilePath } from './wake-listener'

describe('opencode: имя записи присутствия', () => {
  test('под пускателем kiberos — {pid}-{привязка}.json, а не номер сессии', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-disc-'))
    expect(discoveryFilePath(dir, 30234, 'vibe_synqtalk_owner_01', 'unknown')).toBe(join(dir, '30234-vibe_synqtalk_owner_01.json'))
  })

  test('без привязки — прежнее имя по номеру сессии', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-disc-'))
    expect(discoveryFilePath(dir, 1, undefined, 'ses_x')).toBe(join(dir, '1-ses_x.json'))
  })

  test('чужой файл с тем же именем (дверь tmux от lat-context) не затирается', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-disc-'))
    writeFileSync(join(dir, '7-b_01.json'), JSON.stringify({ pid: 7, tmux_binding_id: 'b_01', door: { kind: 'tmux' } }))
    expect(discoveryFilePath(dir, 7, 'b_01', 'ses_y')).toBe(join(dir, '7-ses_y.json'))
  })

  test('свой прежний файл (opencode, http) переписывается на месте', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-disc-'))
    writeFileSync(join(dir, '7-b_01.json'), JSON.stringify({ harness: 'opencode', transport: 'http' }))
    expect(discoveryFilePath(dir, 7, 'b_01', 'ses_y')).toBe(join(dir, '7-b_01.json'))
  })
})
