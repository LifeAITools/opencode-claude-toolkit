/**
 * Стартовый контекст агента opencode (пробел G2): текст сервера SynqTask попадает в системный
 * промпт родительской сессии, один раз на сессию и одной и той же строкой; отказ не запоминается.
 * Дверь ядра подменена — её собственный сторож с настоящим HTTP живёт в signal-wire-core
 * (tests/unit/startup-context.test.ts); здесь проверяется только когда и куда.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { resetStartupContextCache, startupTextForSession } from './startup-context-hook'
import { systemTransformHook } from './system-prompt-hook'
import type { StartupContext } from '@kiberos/signal-wire-core'

const ok: StartupContext = { text: 'PROBE-STARTUP rails+priming+brief', blocks: [{ name: 'role_brief', status: 'ok', text: 'x' }] }
const down: StartupContext = { text: '◻ Не доехало — бриф роли', blocks: [{ name: 'role_brief', status: 'failed', text: null, detail: 'http=000' }] }
const quiet = () => {}

beforeEach(() => resetStartupContextCache())

describe('opencode: стартовый контекст', () => {
  test('один запрос на сессию, та же строка на каждом ходу', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return ok }
    const a = await startupTextForSession('ses_A', { fetcher, log: quiet })
    const b = await startupTextForSession('ses_A', { fetcher, log: quiet })
    expect(a).toBe(ok.text)
    expect(b).toBe(a)
    expect(calls).toBe(1)
    await startupTextForSession('ses_B', { fetcher, log: quiet })
    expect(calls).toBe(2)
  })

  test('отказ сервера не запоминается — следующий ход спрашивает снова', async () => {
    let calls = 0
    const fetcher = async () => (++calls === 1 ? down : ok)
    expect(await startupTextForSession('ses_C', { fetcher, log: quiet })).toBe(down.text)
    expect(await startupTextForSession('ses_C', { fetcher, log: quiet })).toBe(ok.text)
    expect(calls).toBe(2)
  })

  test('перехватчик системного промпта кладёт текст ПОСЛЕДНИМ, умолчание opencode на месте', async () => {
    delete process.env.SYNQTASK_MEMBER_ID
    // Запомнить текст для сессии заранее — перехватчик берёт его из того же кэша.
    await startupTextForSession('ses_D', { fetcher: async () => ok, log: quiet })
    const output = { system: ['OPENCODE-DEFAULT'] }
    await systemTransformHook({ sessionID: 'ses_D', model: {} }, output)
    expect(output.system).toEqual(['OPENCODE-DEFAULT', ok.text])
  })
})
