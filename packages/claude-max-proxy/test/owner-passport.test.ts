/**
 * Кто завёл сессию: имя процесса, его команда, каталог и родитель.
 *
 * 🔴 ПРОСЬБА ФАУНДЕРА 04.09.2026, дословно: «чтобы мы понимали, что за процесс,
 * как называется, кто его запустил, в общем, всё, что нужно знать, чтобы было
 * видно всё».
 *
 * Купил её замер того же утра: семь сессий грелись сутки, четыре из них не
 * сделав ни одного настоящего хода, и опознать их было нечем — ни в журнале, ни
 * в снимках, ни в дампах тел не нашлось ни имени клиента, ни владельца, только
 * шестнадцатеричное имя сессии.
 *
 * Проверяется на СВОЁМ процессе — единственном, чей паспорт заведомо известен и
 * читается без особых прав.
 */

import { describe, test, expect } from 'bun:test'
import { readOwnerPassport, scrubSecrets } from '../src/session-tracker.js'

describe('паспорт владельца сессии', () => {
  test('свой процесс опознаётся: имя, команда, каталог, родитель', () => {
    const p = readOwnerPassport(process.pid)
    expect(p.pid).toBe(process.pid)
    expect(p.name).toBeTruthy()
    expect(p.cmd).toBeTruthy()
    expect(p.cwd).toBe(process.cwd())
    expect(p.ppid).toBe(process.ppid)
    expect(p.parentName).toBeTruthy()
  })

  test('команда обрезается — полная строка запуска в журнал не едет', () => {
    const p = readOwnerPassport(process.pid)
    expect((p.cmd ?? '').length).toBeLessThanOrEqual(300)
  })

  test('несуществующий процесс не роняет чтение и не выдумывает полей', () => {
    // Заведомо свободный номер: ядро не выдаёт такие.
    const p = readOwnerPassport(4_194_303)
    expect(p.pid).toBe(4_194_303)
    expect(p.name).toBeNull()
    expect(p.cwd).toBeNull()
    expect(p.ppid).toBeNull()
  })

  test('ключ в аргументах не доезжает до журнала', () => {
    // В аргументах чужого процесса живут ключи, а журнал читают люди и соседние
    // службы. Лучше короткое честное начало команды, чем полная строка, которую
    // нельзя показать.
    expect(scrubSecrets('node app.js --api-key sk-abcdef1234567890')).not.toContain('sk-abcdef')
    expect(scrubSecrets('serve --token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).not.toContain('eyJhbGci')
    expect(scrubSecrets('python3 bot.py --secret hunter2')).not.toContain('hunter2')
  })

  test('обычная команда чисткой не портится', () => {
    const line = 'bun run /home/relishev/projects/vibe/claude-code-sdk/bin/proxy.ts --port 5050'
    expect(scrubSecrets(line)).toBe(line)
  })

  test('время старта процесса читается — по нему видно, ровесник ли он сессии', () => {
    const p = readOwnerPassport(process.pid)
    expect(p.startedSecAfterBoot).toBeGreaterThan(0)
  })
})
