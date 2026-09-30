/**
 * Процесс с приёмником побудок выходит по SIGTERM (wake-listener.ts, exitAfterCleanupOnSignal).
 * 30.09 `timeout 240 opencode run …` проработал больше 6 минут: обработчик уборки заменял выход.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const script = (tail: string) => `
import { exitAfterCleanupOnSignal } from ${JSON.stringify(join(import.meta.dir, 'wake-listener.ts'))}
let cleaned = false
exitAfterCleanupOnSignal(() => { cleaned = true; console.log('CLEANED') })
${tail}
setInterval(() => {}, 1000)
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
`

async function run(tail: string, ms = 5000) {
  const p = Bun.spawn(['bun', '-e', script(tail)], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill('SIGKILL'), ms)
  const code = await p.exited
  clearTimeout(timer)
  return { code, signal: p.signalCode, out: await new Response(p.stdout).text() }
}

describe('opencode: выход по сигналу завершения', () => {
  test('никто больше не слушает SIGTERM — прибрались и вышли по сигналу', async () => {
    const r = await run('')
    expect(r.out).toContain('CLEANED')
    expect(r.signal).toBe('SIGTERM')  // вышел сам, а не снят SIGKILL через 5 с
  })

  test('сигнал слушает кто-то ещё (сам opencode) — выход остаётся за ним', async () => {
    const r = await run(`process.on('SIGTERM', () => { console.log('HOST_EXIT'); process.exit(7) })`)
    expect(r.out).toContain('CLEANED')
    expect(r.out).toContain('HOST_EXIT')
    expect(r.code).toBe(7)
  })
})
