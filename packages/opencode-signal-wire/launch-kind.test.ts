import { describe, expect, test } from 'bun:test'
import { hasWindow, isOneShotRun, opencodeSubcommand } from './launch-kind'

describe('opencode: как запущен процесс', () => {
  test('разовый прогон — как у vibe-yjs-todo-sync-owner 30.09', () => {
    expect(isOneShotRun(['/usr/bin/opencode', 'run', '-m', 'zai-coding-plan/glm-5.3', 'проверь модель'])).toBe(true)
    expect(isOneShotRun(['bun', '/$bunfs/root/opencode', '-m', 'x/y', 'run', 'hi'])).toBe(true)
    expect(hasWindow(['opencode', 'run', 'hi'])).toBe(false)
  })
  test('окно — в том числе с --session и путём проекта', () => {
    expect(isOneShotRun(['opencode', '-m', 'zai-coding-plan/glm-5.3', '--session', 'ses_f0e72908fffen7IcAC0GhwoZ3p'])).toBe(false)
    expect(hasWindow(['opencode', '-m', 'zai-coding-plan/glm-5.3', '--session', 'ses_x'])).toBe(true)
    expect(hasWindow(['opencode', '/home/relishev/projects/vibe/synqtalk'])).toBe(true)
  })
  test('сервер без окна', () => {
    expect(hasWindow(['opencode', 'serve', '--port', '4096'])).toBe(false)
    expect(opencodeSubcommand(['opencode', '--port', '4096', 'web'])).toBe('web')
  })
  test('слово из текста задания не подкоманда', () => {
    expect(opencodeSubcommand(['opencode', 'run', 'serve the web'])).toBe('run')
    expect(hasWindow(['opencode', '-m', 'serve'])).toBe(true)  // значение флага, не подкоманда
  })
})
