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

export interface HumanAsked {
  sessionId: string
  kind: 'permission'
  message: string
  requestId: string
}

export interface HumanAnswered {
  sessionId: string
  kind: string
  outcome: string
  requestId: string
}

export interface SessionEnded {
  sessionId: string
}

/**
 * Память вида по id запроса: в replied вида нет, помним из asked.
 * Счётчик ограничен (старые вытесняются), чужие id не путаются — ключ полный.
 */
export function createPermissionKindMemory(limit = 500): {
  remember: (requestId: string, kind: string) => void
  recall: (requestId: string) => string | null
} {
  const map = new Map<string, string>()
  return {
    remember: (requestId, kind) => {
      if (!requestId) return
      map.set(requestId, kind)
      if (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
    },
    recall: (requestId) => map.get(requestId) ?? null,
  }
}

/**
 * permission.updated → human.asked. Инструмента в Permission нет — без него
 * (message ← title, requestId ← id). Пустой id — не вопрос.
 */
export function askedFromPermissionUpdated(event: any): HumanAsked | null {
  if (event?.type !== 'permission.updated') return null
  const p = event?.properties ?? {}
  if (typeof p.id !== 'string' || !p.id) return null
  if (typeof p.sessionID !== 'string' || !p.sessionID) return null
  return {
    sessionId: p.sessionID,
    kind: 'permission',
    message: typeof p.title === 'string' ? p.title : '',
    requestId: p.id,
  }
}

/**
 * permission.replied → human.answered. Вид — из памяти по permissionID
 * (в самом событии его нет), исход — response дословно.
 */
export function answeredFromPermissionReplied(
  event: any,
  recallKind: (requestId: string) => string | null,
): HumanAnswered | null {
  if (event?.type !== 'permission.replied') return null
  const p = event?.properties ?? {}
  if (typeof p.sessionID !== 'string' || !p.sessionID) return null
  if (typeof p.permissionID !== 'string' || !p.permissionID) return null
  if (typeof p.response !== 'string') return null
  return {
    sessionId: p.sessionID,
    kind: recallKind(p.permissionID) ?? 'permission',
    outcome: p.response,
    requestId: p.permissionID,
  }
}

/**
 * session.deleted → session.end. Причины у deleted нет — поле опускается.
 * disposed без номера сессии не синтезируется (догадка по каталогу).
 */
export function endFromSessionDeleted(event: any): SessionEnded | null {
  if (event?.type !== 'session.deleted') return null
  const sessionId = extractSessionId(event)
  if (!sessionId) return null
  return { sessionId }
}

export interface StreamDelta {
  sessionId: string
  text: string
}

/**
 * Живой кусок ответа (PRP 09): текстовые дельты message.part.updated.
 * Только delta — полный текст части повторяется в каждом апдейте и задвоил бы счёт.
 */
export function streamDeltaFromPartUpdated(event: any): StreamDelta | null {
  if (event?.type !== 'message.part.updated') return null
  const part = event?.properties?.part
  if (!part || part.type !== 'text') return null
  if (typeof part.sessionID !== 'string' || !part.sessionID) return null
  const delta = event?.properties?.delta
  if (typeof delta !== 'string' || !delta) return null
  return { sessionId: part.sessionID, text: delta }
}

/**
 * Конец сообщения: message.updated ассистента с time.completed.
 * Обрыв (abort) такого события не даёт — end не зовётся, «замолчал» отличим.
 */
export function messageEndFromMessageUpdated(event: any): { sessionId: string } | null {
  if (event?.type !== 'message.updated') return null
  const info = event?.properties?.info
  if (!info || info.role !== 'assistant') return null
  if (typeof info.sessionID !== 'string' || !info.sessionID) return null
  if (typeof info.time?.completed !== 'number') return null
  return { sessionId: info.sessionID }
}
