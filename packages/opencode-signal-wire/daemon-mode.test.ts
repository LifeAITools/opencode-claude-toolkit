/**
 * Решает сервер правил, а не адаптер (слово фаундера 2026-10-02, договор адаптеров v2).
 *
 * До перевода opencode считал правила встроенным конвейером по копии набора из установленного
 * ядра: rules_loaded=95 при 100 в наборе, новое правило — только с выпуском и перезапуском окна.
 * Здесь поддельный сервер на своём сокете: что он ответил, то адаптер и применяет; сервер
 * лёг — событие считает встроенная копия, и это сказано в журнале.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalWire } from './signal-wire'

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

/** Сервер, отвечающий на каждый sw.evaluate заданным списком; запоминает присланное. */
function fakeDaemon(answer: unknown[] | 'error'): Promise<{ path: string; seen: any[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sw-daemon-'))
  const path = join(dir, 'rpc.sock')
  const seen: any[] = []
  const server = createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl))
      seen.push(req)
      const body = answer === 'error'
        ? { jsonrpc: '2.0', id: req.id, error: { message: 'boom' } }
        : { jsonrpc: '2.0', id: req.id, result: { results_per_event: [answer] } }
      sock.end(JSON.stringify(body) + '\n')
    })
  })
  servers.push(server)
  return new Promise((resolve) => server.listen(path, () => resolve({ path, seen })))
}

const toolBefore = (sessionId: string) => ({
  source: 'hook' as const,
  type: 'tool.before',
  sessionId,
  timestamp: Date.now(),
  payload: { tool: 'bash', args: { toolInput: { command: 'docker stop $(docker ps -q)' } } },
})

function adapter(socket: string, projectRoot?: string) {
  // Режим сервера включается сокетом; переменную испытаний снимаем только для этого экземпляра.
  const prev = process.env.OPENCODE_SW_LOCAL
  delete process.env.OPENCODE_SW_LOCAL
  try {
    return new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_daemon_probe', lifeTrace: false, daemonSocketPath: socket, ...(projectRoot ? { projectRoot } : {}) })
  } finally {
    if (prev !== undefined) process.env.OPENCODE_SW_LOCAL = prev
  }
}

describe('сервер решает', () => {
  test('сокет есть — решает сервер: его запрет и есть ответ адаптера', async () => {
    const block = { ruleId: 'v2-block-unnamed-mass-docker-lifecycle', type: 'block', success: true, blocked: true, reason: 'mass docker stop' }
    const d = await fakeDaemon([block])
    const sw = adapter(d.path)
    expect(sw.decidedBy).toBe('server')
    const results = await sw.evaluateHook(toolBefore('ses_daemon_probe'))
    expect(results).toEqual([block as any])
  })

  test('событие уходит с platform=opencode, своей сессией и runtimeMeta', async () => {
    const d = await fakeDaemon([])
    const sw = adapter(d.path)
    await sw.evaluateHook(toolBefore('ses_daemon_probe'))
    const req = d.seen[0]
    expect(req.method).toBe('sw.evaluate')
    expect(req.params.flags.platform).toBe('opencode')
    expect(req.params.input.events[0].sessionId).toBe('ses_daemon_probe')
    expect(req.params.input.events[0].runtimeMeta).toBeDefined()
  })

  test('сервер ответил ошибкой — событие считает встроенная копия, а не «пусто = разрешено» вслепую', async () => {
    const d = await fakeDaemon('error')
    const sw = adapter(d.path)
    const results = await sw.evaluateHook(toolBefore('ses_daemon_probe'))
    // Копия набора содержит то же защитное правило: массовая остановка docker всё равно запрещена.
    expect(results.some((r: any) => r.ruleId === 'v2-block-unnamed-mass-docker-lifecycle' && r.type === 'block')).toBe(true)
  })

  test('корень проекта окна уходит серверу — по нему он находит правила папки (.sw)', async () => {
    const d = await fakeDaemon([])
    const root = mkdtempSync(join(tmpdir(), 'oc-sw-root-'))
    const sw = adapter(d.path, root)
    await sw.evaluateHook({ ...toolBefore('ses_daemon_probe'), payload: { tool: 'edit', args: { toolInput: { filePath: join(root, 'src', 'a.ts') } } } } as any)
    expect(JSON.stringify(d.seen[0])).toContain(root)
  })

  test('позиция в токенах доходит до сервера — иначе правило с cooldown_tokens замолкает навсегда', async () => {
    // Ядро 0.22.1: сервер без позиции считал её нулём, и правило, показавшись раз, молчало до
    // конца сессии. Позицию клиент берёт из runtimeMeta.contextTokens, его заполняет адаптер.
    const d = await fakeDaemon([])
    const sw = adapter(d.path)
    sw.trackTokens({ inputTokens: 123_456 })
    await sw.evaluateHook(toolBefore('ses_daemon_probe'))
    expect(d.seen[0].params.input.tokenPosition).toBe(123_456)
  })

  test('сокета нет — встроенная копия, решает «local»', () => {
    const sw = adapter(join(tmpdir(), 'no-such-dir-xyz', 'rpc.sock'))
    expect(sw.decidedBy).toBe('local')
  })

  test('OPENCODE_SW_LOCAL=1 (как во всех прочих испытаниях) — к боевому серверу не ходим', () => {
    const sw = new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 's', lifeTrace: false })
    expect(sw.decidedBy).toBe('local')
  })
})
