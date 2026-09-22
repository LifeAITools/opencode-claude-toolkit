import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

/**
 * health — `/health`-ответ и pid-файл. Прокси-процесс один: повторный запрос к живому
 * `/health` не поднимает второй инстанс (REQ-CORE-03). Признак жизни — pid-файл с живым
 * pid, а готовность проверяется лаунчером опросом самого `/health`.
 */

export function healthResponse(extra: Record<string, unknown> = {}): Response {
  return Response.json({ status: 'ok', pid: process.pid, ...extra })
}

export function writePidFile(pidPath: string): void {
  try {
    writeFileSync(pidPath, String(process.pid))
  } catch {}
}

/** Живой pid из pid-файла, или null (файла нет / pid мёртв). */
export function readLivePid(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    if (!Number.isFinite(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

export function removePidFile(pidPath: string): void {
  try {
    unlinkSync(pidPath)
  } catch {}
}

export { existsSync }