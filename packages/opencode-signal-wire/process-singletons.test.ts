/**
 * Один приёмник побудок на процесс, сколько бы экземпляров opencode ни подняли плагин.
 * 30.09 пилот SynqTalk получил два экземпляра (две папки проекта) и два приёмника на портах 34841 и
 * 38139: второй перезаписал запись присутствия, первый слушал без адреса.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { processWakeListener, releaseProcessWakeListener, resetProcessSingletons } from './plugin'

afterEach(() => resetProcessSingletons())

const fakeHandle = (port: number) => ({ port, token: 't', server: null as any, stop: () => {} })

describe('opencode: общие двери процесса', () => {
  test('второй экземпляр получает тот же приёмник, а не запускает свой', async () => {
    let starts = 0
    const start = async () => { starts++; return fakeHandle(34841) }
    const a = processWakeListener(start)
    const b = processWakeListener(start)
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(true)
    expect((await a.handle)?.port).toBe(34841)
    expect((await b.handle)?.port).toBe(34841)
    expect(starts).toBe(1)
  })

  test('сбой запуска отдаётся всем как null, и второй не открывает дверь поверх упавшей', async () => {
    let starts = 0
    const start = async () => { starts++; throw new Error('порт занят') }
    expect(await processWakeListener(start).handle).toBeNull()
    expect(await processWakeListener(start).handle).toBeNull()
    expect(starts).toBe(1)
  })

  test('дверь закрывает только последний уходящий экземпляр', () => {
    const start = async () => fakeHandle(1)
    processWakeListener(start)
    processWakeListener(start)
    expect(releaseProcessWakeListener()).toBe(false)  // ушёл один — второй ещё живёт
    expect(releaseProcessWakeListener()).toBe(true)   // ушёл последний — закрывать
  })
})
