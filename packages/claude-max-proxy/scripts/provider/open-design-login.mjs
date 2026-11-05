#!/usr/bin/env node
/**
 * Вход в контрольную плоскость OpenDesign — БЕЗ их приложения и без Linux-сборки.
 *
 * Зачем: квоту OpenDesign отдаёт только `amr-api.open-design.ai`, и только Control Key
 * `vela_ctrl_…` (или cookie кабинета). Inference-ключ `sk-amr-…` туда не пускают —
 * их собственный баг nexu-io/open-design#8674. Десктоп-приложение выпускается ТОЛЬКО
 * под macOS и Windows (замер 05.11.2026: 6 файлов релиза 0.27.0, Linux нет).
 *
 * Но вход — это обычная device authorization, тот же поток, что делает `vela login`:
 *   1. POST /api/v1/cli/device-authorizations  → код + страница подтверждения
 *   2. человек подтверждает страницу в ЛЮБОМ браузере
 *   3. POST /api/v1/cli/device-authorizations/{id}/token {deviceSecret} → оба ключа
 *
 * Отсюда: ни установки, ни чужой ОС. Подтверждение можно сделать с телефона.
 *
 *   node open-design-login.mjs            # начать и ждать (печатает ссылку сразу)
 *   node open-design-login.mjs --print-only
 *   node open-design-login.mjs --out ~/.secrets/open-design-control-2.json
 *
 * 🔴 `--out` НУЖЕН ДЛЯ ВТОРОГО АККАУНТА (05.11.2026): у нас две организации OpenDesign
 * под РАЗНЫМИ входами, и квоту каждой видно только своим Control Key. Один файл на аккаунт;
 * сборщик читает все файлы по маске `open-design-control*.json`.
 *
 * Результат кладётся в ~/.secrets/open-design-control.json (0600):
 *   { controlKey, runtimeKey, email, accountId, at }
 */
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

const CONTROL = 'https://amr-api.open-design.ai'
const UA = 'kiberos-claude-max-proxy-login/1.0'
const argOut = (() => {
  const i = process.argv.indexOf('--out')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/^~(?=\/)/, homedir())
  return null
})()
const OUT = argOut ?? join(homedir(), '.secrets', 'open-design-control.json')

async function api(path, { key, body, method = 'GET' } = {}) {
  const headers = { accept: 'application/json', 'user-agent': UA }
  if (key) headers.authorization = 'Bearer ' + key
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(CONTROL + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const raw = await res.text()
  let parsed = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = { __text: raw.slice(0, 300) } }
  return { status: res.status, ok: res.ok, body: parsed }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const started = await api('/api/v1/cli/device-authorizations', {
  method: 'POST',
  body: { cliVersion: '1.0.0', host: hostname() || 'linux', profile: 'prod' },
})
if (!started.ok || !started.body?.deviceId) {
  console.error(`отказ (${started.status}):`, JSON.stringify(started.body).slice(0, 300))
  process.exit(1)
}
const d = started.body
console.log(`КОД: ${d.userCode}`)
console.log(`ССЫЛКА: ${d.activationUrl}`)
console.log(`годна до: ${d.expiresAt}`)
if (process.argv.includes('--print-only')) process.exit(0)

const until = Date.parse(d.expiresAt ?? '') || Date.now() + 10 * 60_000
const interval = (Number(d.pollIntervalSeconds) > 0 ? Number(d.pollIntervalSeconds) : 2) * 1000
for (;;) {
  if (Date.now() > until) { console.error('код истёк, не дождались подтверждения'); process.exit(2) }
  await sleep(interval)
  let r
  try {
    r = await api(`/api/v1/cli/device-authorizations/${encodeURIComponent(d.deviceId)}/token`, {
      method: 'POST', body: { deviceSecret: d.deviceSecret },
    })
  } catch { continue }
  const control = r.body?.controlKey
  const runtime = r.body?.runtimeKey
  if (control && runtime) {
    const payload = {
      controlKey: String(control), runtimeKey: String(runtime),
      email: r.body?.user?.email ?? null, accountId: r.body?.user?.id ?? null,
      at: new Date().toISOString(),
    }
    mkdirSync(join(homedir(), '.secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(OUT, JSON.stringify(payload, null, 2), { mode: 0o600 })
    try { chmodSync(OUT, 0o600) } catch {}
    console.log(`ГОТОВО: control key получен и записан в ${OUT}`)
    console.log(`аккаунт: ${payload.email ?? payload.accountId ?? '?'}`)
    process.exit(0)
  }
  const status = String(r.body?.status ?? '').toLowerCase()
  if (r.status === 404 || ['expired', 'canceled', 'cancelled', 'denied', 'rejected'].includes(status)) {
    console.error(`вход ${status || 'не найден'} — начните заново`); process.exit(3)
  }
  if (r.status === 401) { console.error('код больше не годен — начните заново'); process.exit(3) }
}
