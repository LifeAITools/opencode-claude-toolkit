import { spawn } from 'node:child_process'

/**
 * launch — авто-старт: проверить `/health` → нет → detached spawn → poll до ready.
 *
 * Паттерн `opencode-proxy/launch.ts`, вынесенный в общее. Написан на `node:child_process`,
 * а не на `bun` — чтобы клиент (плагин opencode) мог тянуть этот модуль, не таща за собой
 * bun-типы и `bun:sqlite` остального ядра. Повторный `/health` на живом прокси не плодит
 * второй процесс (REQ-CORE-03).
 */

export interface LaunchSpec {
  healthUrl: string
  spawnCmd: string[]
  readyTimeoutMs?: number
  pollIntervalMs?: number
}

export async function ensureRunning(spec: LaunchSpec): Promise<{ alreadyRunning: boolean }> {
  const timeoutMs = spec.readyTimeoutMs ?? 5_000
  const pollMs = spec.pollIntervalMs ?? 100

  if (await healthy(spec.healthUrl, 500)) {
    return { alreadyRunning: true }
  }

  const [cmd, ...args] = spec.spawnCmd
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy(spec.healthUrl, pollMs)) {
      return { alreadyRunning: false }
    }
    await sleep(pollMs)
  }

  try {
    child.kill()
  } catch {}
  throw new Error(`proxy-core:launch: прокси не ответил на ${spec.healthUrl} за ${timeoutMs} мс`)
}

async function healthy(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return false
    const body = (await r.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}