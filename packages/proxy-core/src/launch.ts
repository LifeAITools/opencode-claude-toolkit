import { spawn } from 'bun'

/**
 * launch — авто-старт: проверить `/health` → нет → detached spawn → poll до ready.
 *
 * Паттерн `opencode-proxy/launch.ts`, вынесенный в общее: expensive fetch'ем апстрима не
 * должен быть риск, а повторный запрос к живому прокси не плодит второй процесс.
 */

export interface LaunchSpec {
  healthUrl: string
  spawnCmd: string[]
  readyTimeoutMs?: number
  pollIntervalMs?: number
}

export async function ensureRunning(spec: LaunchSpec): Promise<{ url: string; alreadyRunning: boolean }> {
  const timeoutMs = spec.readyTimeoutMs ?? 5_000
  const pollMs = spec.pollIntervalMs ?? 100

  if (await healthy(spec.healthUrl, 500)) {
    return { url: spec.healthUrl, alreadyRunning: true }
  }

  const child = spawn({ cmd: spec.spawnCmd, stdout: 'ignore', stderr: 'ignore', detached: true })
  child.unref?.()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy(spec.healthUrl, pollMs)) {
      return { url: spec.healthUrl, alreadyRunning: false }
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