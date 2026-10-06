/**
 * ДВЕ ДЫРЫ ДОКТРИНЫ (сверка 06.10, вопрос фаундера).
 *
 * 1. session.start. У opencode НЕТ события старта — только session.created
 *    (проверено по типам SDK: created/updated/deleted/error/idle/status/...,
 *    start отсутствует). По договору session.start — «процесс поднялся, ещё до
 *    первого промпта», поэтому адаптер синтезирует его из первого session.created
 *    сессии сам, один раз на процесс (createSessionStartTracker).
 *
 * 2. tool.failure. У opencode нет события провала вызова вовсе (хук after тоже
 *    без поля ошибки): провал виден как message.part.updated, где часть —
 *    tool со state.status 'error' (типы SDK, ToolStateError несёт error:input).
 *    Переводится в канонический tool.failure той же формы, что tool.after
 *    ({tool, args, response:{output}}) — близнец правил срабатывает, слова
 *    в успешном выводе ложно не триггерят.
 */

export interface ToolFailure {
  sessionId: string
  tool: string
  callID: string
  /** Ввод вызова как был (state.input), для предикатов правил. */
  args: unknown
  /** Текст ошибки — в response.output, как у tool.after. */
  error: string
}

/** Номер сессии из любой оболочки события (поток, хук, письмо). */
export function extractSessionId(event: any): string | null {
  const p = event?.properties ?? event?.payload ?? event?.data ?? event
  const info = p?.info
  const session = p?.session
  const id =
    info?.id ?? info?.sessionID ?? info?.sessionId ??
    session?.id ?? session?.sessionID ?? session?.sessionId ??
    p?.id ?? p?.sessionID ?? p?.sessionId
  return typeof id === 'string' && id ? id : null
}

/**
 * Однократность старта: первый session.created сессии — старт, повторы —
 * переподключения, не новые процессы. Пустые и unknown — не сессии.
 */
export function createSessionStartTracker(): (sessionId: string | null) => boolean {
  const seen = new Set<string>()
  return (sessionId) => {
    if (!sessionId || sessionId === 'unknown' || seen.has(sessionId)) return false
    seen.add(sessionId)
    return true
  }
}

/**
 * Замер из события message.part.updated; всё, что не упавший вызов, — null.
 * Упавший вызов у opencode — НЕ отдельное событие: часть tool переходит
 * в state error прямо в потоке (замер по типам SDK 06.10).
 */export function failureFromPartUpdated(event: any): ToolFailure | null {
  if (event?.type !== 'message.part.updated') return null
  const part = event?.properties?.part
  if (!part || part.type !== 'tool') return null
  const state = part.state
  if (!state || state.status !== 'error') return null
  if (typeof part.sessionID !== 'string' || !part.sessionID) return null
  if (typeof part.tool !== 'string' || !part.tool) return null
  const error = typeof state.error === 'string' && state.error ? state.error : 'tool failed (no error text)'
  return {
    sessionId: part.sessionID,
    tool: part.tool,
    callID: typeof part.callID === 'string' ? part.callID : '',
    args: state.input ?? null,
    error,
  }
}

export interface SessionError {
  sessionId: string
  /** Объект ошибки SDK как есть (ProviderAuthError | UnknownError | ...). */
  error: unknown
}

/**
 * Ошибка сессии (session.error) — тем же узором: своё событие, везётся как есть.
 * Канонического типа в ядре пока нет (близнец — сторона ядра), поэтому имя
 * сохраняется дословно: правило совпадёт, когда близнец появится, а до тех пор
 * событие видно в логе, но никого ложно не триггерит.
 */
export function errorFromSessionError(event: any): SessionError | null {
  if (event?.type !== 'session.error') return null
  const p = event?.properties ?? {}
  const sessionId = typeof p.sessionID === 'string' && p.sessionID ? p.sessionID
    : typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null
  if (!sessionId) return null
  if (p.error == null) return null
  return { sessionId, error: p.error }
}
