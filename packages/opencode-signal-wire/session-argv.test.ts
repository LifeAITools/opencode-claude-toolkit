import { describe, expect, test } from 'bun:test'
import { sessionFromArgv } from './session-argv'

describe('opencode: номер сессии из командной строки пускателя', () => {
  test('--session <id> — как у пилота SynqTalk 30.09', () => {
    expect(sessionFromArgv(['bun', 'opencode', '-m', 'zai-coding-plan/glm-5.3', '--session', 'ses_f0e72908fffen7IcAC0GhwoZ3p']))
      .toBe('ses_f0e72908fffen7IcAC0GhwoZ3p')
  })
  test('-s <id> и --session=<id>', () => {
    expect(sessionFromArgv(['opencode', '-s', 'ses_a'])).toBe('ses_a')
    expect(sessionFromArgv(['opencode', '--session=ses_b'])).toBe('ses_b')
  })
  test('нет номера — null, а не выдуманный', () => {
    expect(sessionFromArgv(['opencode', '-m', 'x'])).toBeNull()
    expect(sessionFromArgv(['opencode', '--continue'])).toBeNull()
    expect(sessionFromArgv(['opencode', '--session'])).toBeNull()
    expect(sessionFromArgv(['opencode', '--session', '-m', 'x'])).toBeNull()
    expect(sessionFromArgv(['opencode', '--session='])).toBeNull()
  })
})
