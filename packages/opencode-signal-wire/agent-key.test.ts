/**
 * Ключ ЛИЧНЫХ правил агента — то, без чего сервер не подмешивает правила этого агента.
 * Два полюса: есть номер участника — ключ есть; нет/пусто — ключа нет (а не пустая строка).
 * Живой полюс «правило срабатывает» держит тест ядра (daemon-client-agent-key.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { agentKeyFromEnv } from './signal-wire.js'

describe('ключ личных правил из окружения', () => {
  test('номер участника есть — ключ есть, с обрезкой пробелов', () => {
    expect(agentKeyFromEnv({ SYNQTASK_AGENT_UUID: '  25f2a25d-bcc1-4ffc-818a-c54a60b427da  ' } as NodeJS.ProcessEnv))
      .toBe('25f2a25d-bcc1-4ffc-818a-c54a60b427da')
  })
  test('нет переменной или пусто — undefined, а не пустая строка', () => {
    expect(agentKeyFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined()
    expect(agentKeyFromEnv({ SYNQTASK_AGENT_UUID: '   ' } as NodeJS.ProcessEnv)).toBeUndefined()
  })
})
