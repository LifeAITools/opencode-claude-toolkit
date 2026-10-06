/**
 * Клеймо запуска сессии (session-stamp.ts): однократно, fail-open, без секретов.
 * Раннер инжектится — сети и команды `context` в испытаниях нет.
 */
import { describe, expect, test } from 'bun:test'
import { stampSessionLaunch, type StampRunner } from './session-stamp'

const okRunner: StampRunner = async () => ({ code: 0, stdout: 'stamped ses_x', stderr: '' })

describe('клеймо запуска', () => {
  test('ставится один раз на процесс; повтор — пропуск без вызова', async () => {
    process.env.SYNQTASK_AGENT_ID = 'a'
    process.env.KIBEROS_PROJECT_SLUG = 'p'
    let calls = 0
    const run: StampRunner = async (...a) => { calls++; return okRunner(...a) }
    const guard = {}
    try {
      const r1 = await stampSessionLaunch(run, 'ses_x', '/tmp', guard)
      expect(r1.ok).toBe(true)
      const r2 = await stampSessionLaunch(run, 'ses_x', '/tmp', guard)
      expect(r2.ok).toBe(false)
      expect(r2.detail).toBe('already_stamped_this_process')
      expect(calls).toBe(1)
    } finally {
      delete process.env.SYNQTASK_AGENT_ID
      delete process.env.KIBEROS_PROJECT_SLUG
    }
  })

  test('без номера сессии и без личности — пропуск, а не падение', async () => {
    expect((await stampSessionLaunch(okRunner, 'unknown', '/tmp', {})).ok).toBe(false)
    expect((await stampSessionLaunch(okRunner, '', '/tmp', {})).ok).toBe(false)
    const savedA = process.env.SYNQTASK_AGENT_ID
    delete process.env.SYNQTASK_AGENT_ID
    try {
      const r = await stampSessionLaunch(okRunner, 'ses_x', '/tmp', {})
      expect(r.ok).toBe(false)
      expect(r.detail).toBe('no_launch_identity_in_env')
    } finally {
      if (savedA != null) process.env.SYNQTASK_AGENT_ID = savedA
    }
  })

  test('отказ команды и падение раннера — строка в detail, не исключение', async () => {
    process.env.SYNQTASK_AGENT_ID = 'a'
    process.env.KIBEROS_PROJECT_SLUG = 'p'
    try {
      const refused: StampRunner = async () => ({ code: 2, stdout: '', stderr: 'missing_argument' })
      const r1 = await stampSessionLaunch(refused, 'ses_x', '/tmp', {})
      expect(r1.ok).toBe(false)
      expect(r1.detail).toContain('exit_2')
      const down: StampRunner = async () => { throw new Error('no context cli') }
      const r2 = await stampSessionLaunch(down, 'ses_x', '/tmp', {})
      expect(r2.ok).toBe(false)
      expect(r2.detail).toContain('runner_failed')
    } finally {
      delete process.env.SYNQTASK_AGENT_ID
      delete process.env.KIBEROS_PROJECT_SLUG
    }
  })
})
