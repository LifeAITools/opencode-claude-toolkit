/**
 * ПЕРЕХОДЫ ХОДА В ЖУРНАЛ ДВЕРИ `context agent beat` (13.11.2026).
 *
 * Решение фаундера (TG 84346): присутствие наружу несёт ОДИН представитель машины через шину,
 * прямые дороги снимаются. Дверь `agent beat` журналирует переход В МОМЕНТ, и представитель
 * отдаёт его отдельным телом. Без этого переходы агентов opencode ехали бы только снимком:
 * отставание до минуты, а короткий ход не виден вовсе. Заявка packages-lat-context-owner и
 * packages-signal-wire-core-owner; хук Claude Code делает то же самое (их половина).
 *
 * Зовём ТОЛЬКО на переходах, не на каждом событии: `session.start` при подъёме,
 * `chat.message` в начале хода, `session.idle` в конце (обрыв ошибкой — тоже конец).
 *
 * ТРИ ТРЕБОВАНИЯ — из живого краха хука 12.11:
 *  1. фоном, не блокируя: ход не ждёт двери (detached + unref, никакого await);
 *  2. отвязано от ошибок: необязательный вызов не роняет ход, а провал НАЗЫВАЕТСЯ строкой
 *     `AGENT_BEAT_FAILED … reason=…` в журнале плагина, а не глотается молча;
 *  3. собственный пульс адаптера (`session-heartbeat-*.json`) НЕ тронут: два писателя одного
 *     файла пока допустимы по решению владельцев, файл остаётся SSOT живости.
 *
 * Привязки (`KIBEROS_BINDING_ID`) нет — вызова нет: у простого opencode места в реестре нет.
 */
import { spawn as nodeSpawn } from 'node:child_process'

export type AgentBeatEvent = 'session.start' | 'chat.message' | 'session.idle'

export interface AgentBeatDeps {
  env?: NodeJS.ProcessEnv
  /** Путь к `context`; null — не найден. */
  resolveBin: () => string | null
  cwd?: string
  log: (step: string, details: Record<string, unknown>) => void
  spawn?: typeof nodeSpawn
  /** Предел жизни одного вызова, секунды (`timeout`). */
  timeoutSec?: number
}

/** Аргументы двери — чистая функция, ради испытания формы. */
export function agentBeatArgs(binding: string, event: AgentBeatEvent, cwd?: string): string[] {
  const args = ['agent', 'beat', '--binding', binding, '--event', event]
  if (cwd) args.push('--cwd', cwd)
  return args
}

/**
 * Фоновый вызов двери. Возвращает true, если процесс запущен (для испытаний и журнала),
 * false — если вызова нет по построению (нет привязки / нет `context`) или запуск упал.
 */
export function emitAgentBeat(event: AgentBeatEvent, deps: AgentBeatDeps): boolean {
  const env = deps.env ?? process.env
  const binding = env.KIBEROS_BINDING_ID?.trim()
  if (!binding) return false
  const fail = (reason: string, extra: Record<string, unknown> = {}) => {
    try { deps.log('AGENT_BEAT_FAILED', { event, binding, reason, ...extra }) } catch { /* журнал не роняет ход */ }
  }
  try {
    const bin = deps.resolveBin()
    if (!bin) { fail('context_not_found'); return false }
    const args = agentBeatArgs(binding, event, deps.cwd)
    const sp = deps.spawn ?? nodeSpawn
    const child = sp('timeout', [String(deps.timeoutSec ?? 5), bin, ...args], { detached: true, stdio: 'ignore' })
    child.on('error', (e: Error) => fail('spawn_error', { error: e?.message ?? String(e) }))
    child.on('exit', (code: number | null, signal: string | null) => {
      // 124 — `timeout` снял зависший вызов; любой ненулевой код — провал двери, назвать его.
      if (code !== 0) fail(code === 124 ? 'timeout' : 'nonzero_exit', { code, signal })
    })
    child.unref()
    return true
  } catch (e: any) {
    fail('throw', { error: e?.message ?? String(e) })
    return false
  }
}
