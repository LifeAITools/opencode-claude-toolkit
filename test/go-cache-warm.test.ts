/**
 * Испытания прогрева кэша Go (scripts/go-cache-warm.py, задача b08418ac, часть 3).
 *
 * Держат ТРИ обещания, которые прогрев даёт живому вызову:
 *   1. ПО УМОЛЧАНИЮ НИЧЕГО НЕ ШЛЁТ — без `--fire` только показывает (защита от случайного звона).
 *   2. НЕ ГРЕЕТ СВЕЖУЮ СЕССИЮ — агент только что ходил, кэш и так тёплый.
 *   3. ОСТАНАВЛИВАЕТСЯ, КОГДА АГЕНТ УШЁЛ — файл не переписывался дольше TTL, греть нечего.
 *
 * Зовём питоновский скрипт как есть: он и есть предмет проверки, а не его копия.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'go-cache-warm.py')

function spoolWith(agesMin: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'go-warm-'))
  const now = Date.now() / 1000
  for (const [session, ageMin] of Object.entries(agesMin)) {
    const p = join(dir, `${session}.json`)
    writeFileSync(p, JSON.stringify({ model: 'deepseek-v4.1-flash-go', messages: [{ role: 'user', content: 'x' }] }))
    const t = now - ageMin * 60
    utimesSync(p, t, t)
  }
  return dir
}

async function run(args: string[]): Promise<string> {
  const p = Bun.spawnSync(['python3', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
}

describe('go-cache-warm — прогрев не смеет вредить живому вызову', () => {
  test('🔴 по умолчанию НИЧЕГО НЕ ШЛЁТ и говорит об этом', async () => {
    const dir = spoolWith({ ses_idle: 60 })
    const out = await run(['--spool', dir])
    expect(out).toContain('ничего не послано')
    expect(out).toContain('ses_idle')
    expect(out).toContain('показал бы')
  })

  test('свежую сессию не греет — кэш и так тёплый', async () => {
    const dir = spoolWith({ ses_fresh: 5 })
    const out = await run(['--spool', dir, '--idle-min', '40'])
    expect(out).toContain('к прогреву: 0')
  })

  test('🔴 сессию, которая ушла, не греет — файл старше TTL', async () => {
    const dir = spoolWith({ ses_gone: 300 })
    const out = await run(['--spool', dir, '--ttl-min', '120'])
    expect(out).toContain('к прогреву: 0')
  })

  test('в окне простоя — берёт ровно её', async () => {
    const dir = spoolWith({ ses_fresh: 5, ses_idle: 60, ses_gone: 300 })
    const out = await run(['--spool', dir, '--idle-min', '40', '--ttl-min', '120'])
    expect(out).toContain('к прогреву: 1')
    expect(out).toContain('ses_idle')
    expect(out).not.toContain('ses_fresh')
    expect(out).not.toContain('ses_gone')
  })

  test('пустой/отсутствующий спул — не падает и не шлёт', async () => {
    const out = await run(['--spool', join(tmpdir(), 'нет-такого-каталога-xyz')])
    expect(out).toContain('спул не найден')
  })

  test('🔴 без организации в спуле — повтор НЕ шлётся (прогрел бы чужую учётку)', async () => {
    // Тело без меты (старая форма) — организации нет, значит слать нельзя вовсе.
    const dir = mkdtempSync(join(tmpdir(), 'go-warm-noorg-'))
    const p = join(dir, 'ses_noorg.json')
    writeFileSync(p, JSON.stringify({ model: 'deepseek-v4.1-flash-go', messages: [{ role: 'user', content: 'x' }] }))
    const t = Date.now() / 1000 - 60 * 60
    utimesSync(p, t, t)
    const out = await run(['--spool', dir, '--fire'])
    expect(out).toContain('нет организации')
    expect(out).not.toContain('HTTP')
  })

  test('дверь берётся из меты: диалект не подменяется', async () => {
    // Проверяем не сеть, а выбор двери — он вынесен в чистую функцию.
    const p = Bun.spawnSync(['python3', '-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('w', '${SCRIPT}')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.door_path('acompletion'), m.door_path('anthropic_messages'), m.door_path('aresponses'), m.door_path('неизвестное'))
`], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
    const out = new TextDecoder().decode(p.stdout)
    expect(out.trim()).toBe('/v1/chat/completions /v1/messages /v1/responses /v1/chat/completions')
  })
})
