/**
 * Проход по всем организациям Go. Сети нет: fetch подменён, хранилище и реестр — во временном
 * каталоге. Проверяем главное свойство: продление не зависит от того, ЗОВУТ ли организацию.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGoProactiveRefresh, sweepGoTokens } from './go-proactive-refresh.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'go-sweep-'))
const registryPath = join(dir, 'go-orgs.yaml')
const tokensPath = join(dir, 'tokens.json')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function writeRegistry(names: string[]) {
  const orgs = names.map((n) => [
    `  - name: ${n}`,
    `    workspace: wrk_${n}`,
    '    auth: console',
    '    base_url: https://gateway.invalid/openai/v1',
    `    account_url: https://console.invalid`,
    '    priority: 1',
  ].join('\n')).join('\n')
  writeFileSync(registryPath, `active: ${names[0]}\nusage_url: https://usage.invalid\norgs:\n${orgs}\n`)
}

function writeTokens(orgs: Record<string, { exp: number; access?: string }>) {
  const doc = { orgs: Object.fromEntries(Object.entries(orgs).map(([n, v]) => [n, {
    access_token: v.access ?? `A-${n}`, refresh_token: `R-${n}`, expiry_ms: v.exp,
  }])) }
  writeFileSync(tokensPath, JSON.stringify(doc))
}

const cfg = (environ: Record<string, string | undefined>) => ({
  registryPath,
  tokensPath,
  environ,
  userAgent: 'kiberos-chat/1.0',
})

function countingFetch() {
  const calls: string[] = []
  const fn = (async (input: any) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'NR', expires_in: 60 * 24 * 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('проход по всем организациям Go', () => {
  test('флаг выключен — ни сети, ни записи, ни чтения реестра', async () => {
    writeRegistry(['org-a'])
    writeTokens({ 'org-a': { exp: NOW + DAY } })
    const before = readFileSync(tokensPath, 'utf8')
    const { fn, calls } = countingFetch()
    const out = await sweepGoTokens(cfg({}), { fetchImpl: fn, now: () => NOW })
    expect(out.checked).toBe(0)
    expect(calls.length).toBe(0)
    expect(readFileSync(tokensPath, 'utf8')).toBe(before)
  })

  test('флаг включён — продлевается ИМЕННО ТА организация, которую никто не зовёт', async () => {
    writeRegistry(['org-a', 'org-b'])
    // org-a истекает через сутки (её никто не вызывает), org-b свежая.
    writeTokens({ 'org-a': { exp: NOW + DAY }, 'org-b': { exp: NOW + 20 * DAY } })
    const { fn, calls } = countingFetch()
    const out = await sweepGoTokens(cfg({ GO_TOKEN_REFRESH_ENABLED: 'true' }), { fetchImpl: fn, now: () => NOW })
    expect(out.checked).toBe(2)
    expect(out.refreshed).toBe(1)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('console.invalid/auth/device/token')
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
    expect(doc.orgs['org-a'].access_token).toBe('NEW')
    expect(doc.orgs['org-b'].access_token).toBe('A-org-b')
  })

  test('отказ одной организации не лишает продления остальные', async () => {
    writeRegistry(['org-bad', 'org-ok'])
    writeTokens({ 'org-bad': { exp: NOW + DAY }, 'org-ok': { exp: NOW + DAY } })
    const fn = (async (input: any) => {
      if (String(input).includes('console.invalid')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const out = await sweepGoTokens(cfg({ GO_TOKEN_REFRESH_ENABLED: 'true' }), { fetchImpl: fn, now: () => NOW })
    // Сеть падает у обеих (один и тот же адрес входа) — проверяем, что проход НЕ остановился
    // на первой: обе организации попали в отчёт.
    expect(out.checked).toBe(2)
    expect(out.failed.map((f) => f.org).sort()).toEqual(['org-bad', 'org-ok'])
  })

  test('включённый флаг, но нет путей — тихий ноль, а не падение', async () => {
    const out = await sweepGoTokens(
      { registryPath: null, tokensPath: null, environ: { GO_TOKEN_REFRESH_ENABLED: 'true' }, userAgent: 'x' },
      { now: () => NOW },
    )
    expect(out.checked).toBe(0)
  })

  test('выключенный флаг — таймера нет вовсе', () => {
    let fired = 0
    const stop = startGoProactiveRefresh(cfg({}), { intervalMs: 10, now: () => NOW, log: () => { fired++ } })
    stop()
    // Ни прохода по расписанию, ни немедленного первого прохода.
    expect(fired).toBe(0)
  })
})
