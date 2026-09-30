/**
 * ФАЙЛОВАЯ ДВЕРЬ ПОБУДКИ для opencode — общая дверь ядра (signal-wire-core ≥ 0.18.0,
 * src/harness/wake-door.ts), доставка — своя.
 *
 * ЗАЧЕМ. Роутер кладёт письмо файлом `wake-*.json` в `~/.kiberos/signals/<привязка>/` (и в
 * `~/.claude/wake-queue/<сессия>/`), когда до агента нельзя достучаться по HTTP — в том числе ДО
 * подъёма плагина. Хук Claude Code и адаптер dsh эти файлы забирают, плагин opencode не забирал:
 * 2026-09-30 письмо пилоту SynqTalk пролежало там после десяти минут его работы, и роутер не получил
 * квитанции «прочитано» (замер vibe-yjs-todo-sync-owner).
 *
 * ПОРЯДОК. Кому писать — решается ДО прохода по каталогам (занят ли агент, в какую сессию, открыть
 * ли её), а внутри прохода `drainWakeDirsAsync` ядра (≥ 0.18.0) отправляет в уже выбранную сессию и
 * удаляет файл только ПОСЛЕ того, как opencode принял текст. Пока агент занят, сессии нет или
 * отправка упала — письмо лежит в файле, а не в памяти процесса: ни сбой, ни смерть его не теряют.
 *
 * Кому писать — те же правила, что у HTTP-двери (wake-listener.ts): одна сессия каталога — ей;
 * ни одной — открыть; несколько — не угадывать.
 */
import { existsSync, readdirSync } from 'node:fs'
import { drainWakeDirsAsync, postReceipt, wakeDirs, type DrainResult, type WakeEnvelope } from '@kiberos/signal-wire-core'

export interface FileDoorDeps {
  /** Привязка пускателя kiberos (`KIBEROS_BINDING_ID`); нет — каталога привязки нет. */
  bindingId: () => string | null
  /** Уже известный номер сессии, без обращения к серверу (для каталога `wake-queue/<сессия>`). */
  knownSessionId: () => string | null
  isBusy: () => Promise<boolean>
  /** Сессия для письма: известная или единственная в каталоге агента; неоднозначно — null. */
  resolveSession: () => Promise<string | null>
  /** Открыть сессию, если в каталоге агента нет ни одной; иначе null. */
  openSession: () => Promise<string | null>
  /**
   * Отправить текст ходом в сессию и дождаться, что opencode его ПРИНЯЛ (не ответа модели).
   * true — файл удаляется и уходит квитанция; false или исключение — письмо лежит до следующего прохода.
   */
  send: (sessionId: string, text: string) => Promise<boolean>
  receipt?: (w: WakeEnvelope) => void
  log?: (line: string) => void
  home?: string
}

export type FileDoorOutcome =
  | { kind: 'idle' }
  | { kind: 'kept'; reason: 'busy' | 'no_session' }
  | { kind: 'drained'; sessionId: string; result: DrainResult }

function hasWakeFiles(dirs: string[]): boolean {
  for (const d of dirs) {
    if (!existsSync(d)) continue
    try {
      if (readdirSync(d).some((n) => n.startsWith('wake-') && n.endsWith('.json'))) return true
    } catch { /* нечитаемый каталог назовёт drainWakeDirs */ }
  }
  return false
}

/** Один проход. Интервалом управляет вызывающий. */
export async function pollFileDoor(deps: FileDoorDeps): Promise<FileDoorOutcome> {
  const dirs = wakeDirs({ bindingId: deps.bindingId(), sessionId: deps.knownSessionId(), home: deps.home })
  // Дёшево и без сервера: пока писем нет, opencode не спрашиваем ни о чём.
  if (!hasWakeFiles(dirs)) return { kind: 'idle' }
  if (await deps.isBusy()) return { kind: 'kept', reason: 'busy' }
  const sessionId = (await deps.resolveSession()) ?? (await deps.openSession())
  if (!sessionId) return { kind: 'kept', reason: 'no_session' }
  const result = await drainWakeDirsAsync(dirs, {
    deliver: (text) => deps.send(sessionId, text),
    receipt: deps.receipt ?? ((w) => postReceipt(w)),
    log: deps.log,
  })
  return { kind: 'drained', sessionId, result }
}
