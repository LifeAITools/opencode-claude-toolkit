/**
 * Стартовый контекст агента opencode — бриф роли и непрочитанное, прайминг и рельсы проекта — тем же
 * текстом, что получает агент в Claude Code (пробел G2, signal-wire-core
 * PRPs/harness-adapters/05-startup-context-idea.md). Текст рендерит сервер SynqTask, дверь ядра
 * `fetchStartupContext` только везёт его и называет отказ; здесь — только КОГДА и КУДА вставить.
 *
 * КУДА. В системный промпт через `experimental.chat.system.transform`: `session.start` opencode не
 * шлёт вовсе, а перехватчик срабатывает на каждом ходу.
 * КОГДА. Забирается один раз на сессию и дальше повторяется ТОЙ ЖЕ строкой — начало промпта не
 * меняется от хода к ходу и не сбивает кэш. Если хоть один блок не доехал (`failed`), текст НЕ
 * запоминается: на следующем ходу новая попытка, как у хука Claude Code. Неподдержка сервером
 * (`unsupported`) запоминается — от повтора она не пройдёт.
 */
import { fetchStartupContext, startupContextInputFromEnv } from '@kiberos/signal-wire-core'
import type { StartupContext, StartupContextInput } from '@kiberos/signal-wire-core'

type Fetcher = (input: StartupContextInput) => Promise<StartupContext>

const settled = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

/** Текст для сессии; пустая строка — вставлять нечего. Никогда не бросает. */
export async function startupTextForSession(
  sessionID: string,
  opts: { env?: Record<string, string | undefined>; fetcher?: Fetcher; log?: (line: string) => void } = {},
): Promise<string> {
  const done = settled.get(sessionID)
  if (done !== undefined) return done
  let p = inflight.get(sessionID)
  if (!p) {
    p = (async () => {
      try {
        const sc = await (opts.fetcher ?? fetchStartupContext)(startupContextInputFromEnv(opts.env ?? process.env))
        const summary = sc.blocks.map((b) => `${b.name}:${b.status}`).join(' ')
        const retry = sc.blocks.some((b) => b.status === 'failed')
        if (!retry) settled.set(sessionID, sc.text)
        ;(opts.log ?? ((l) => console.error(l)))(
          `[opencode-signal-wire] startup context session=${sessionID} chars=${sc.text.length} ${summary}${retry ? ' (не запомнено — повтор на следующем ходу)' : ''}`,
        )
        return sc.text
      } catch (e: any) {
        ;(opts.log ?? ((l) => console.error(l)))(`[opencode-signal-wire] startup context error session=${sessionID}: ${e?.message ?? e}`)
        return ''
      } finally {
        inflight.delete(sessionID)
      }
    })()
    inflight.set(sessionID, p)
  }
  return p
}

/** Только для тестов: забыть всё запомненное. */
export function resetStartupContextCache(): void {
  settled.clear()
  inflight.clear()
}
