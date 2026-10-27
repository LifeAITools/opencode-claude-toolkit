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
 * ОЖИДАНИЕ ЧЕЛОВЕКА → human.asked. ДВА ИМЕНИ ОДНОГО СОБЫТИЯ, и это не запас на всякий случай:
 * opencode 1.19.0 шлёт `permission.asked` (SDK v2, EventPermissionAsked), а `permission.updated`
 * (SDK v1 и наш договор до 27.10) в бинаре не встречается НИ РАЗУ. Слушатель старого имени
 * молчал ВСЕГДА, и «ждёт вас» не могло зажечься ни у одного агента флота.
 *
 * ПОЛЯ ТОЖЕ РАЗНЫЕ: v2 несёт `permission` + `patterns` (нет `title`), v1 нёс `title`. Поэтому
 * текст собирается из того, что есть: сначала старое поле, потом новое имя разрешения с
 * паттернами — иначе событие придёт, а `message` выйдет пустым (вторая тишина под тем же именем).
 * Инструмента в событии нет — без него. Пустой id — не вопрос.
 */
export function askedFromPermissionUpdated(event: any): HumanAsked | null {
  if (event?.type !== 'permission.updated' && event?.type !== 'permission.asked') return null
  const p = event?.properties ?? {}
  if (typeof p.id !== 'string' || !p.id) return null
  if (typeof p.sessionID !== 'string' || !p.sessionID) return null
  const patterns = Array.isArray(p.patterns) ? p.patterns.filter((x: unknown) => typeof x === 'string') : []
  const fromV2 = typeof p.permission === 'string' && p.permission !== ''
    ? [p.permission, ...patterns].join(' ')
    : ''
  return {
    sessionId: p.sessionID,
    kind: 'permission',
    message: typeof p.title === 'string' ? p.title : fromV2,
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
  // v2 зовёт поле `requestID`, v1 звало `permissionID` — читаем оба, иначе ответ человека
  // теряется ровно так же, как терялось само ожидание.
  const requestId = typeof p.permissionID === 'string' && p.permissionID
    ? p.permissionID
    : typeof p.requestID === 'string' ? p.requestID : ''
  if (!requestId) return null
  if (typeof p.response !== 'string') return null
  return {
    sessionId: p.sessionID,
    kind: recallKind(requestId) ?? 'permission',
    outcome: p.response,
    requestId,
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
 * Регистрация ТЕКСТОВОЙ части из `message.part.updated` (opencode 1.19.0).
 *
 * Почему нужна отдельная регистрация: в 1.19.0 дельта стрима едет ОТДЕЛЬНЫМ событием
 * `message.part.delta` (`{sessionID, messageID, partID, field, delta}`), а у
 * `message.part.updated` поля `delta` нет вовсе — только сама часть. Тип части (`text` /
 * `reasoning` / …) знает ТОЛЬКО `part.updated`, поэтому текстовые части регистрируем здесь,
 * а их дельты принимаем из `part.delta` по `partID`. Иначе рассуждения агента попали бы в
 * канал `agent_text` и правила по прозе срабатывали бы на внутреннюю речь.
 */
export function textPartFromPartUpdated(event: any): { sessionId: string; partId: string } | null {
  if (event?.type !== 'message.part.updated') return null
  const part = event?.properties?.part
  if (!part || part.type !== 'text') return null
  if (typeof part.id !== 'string' || !part.id) return null
  if (typeof part.sessionID !== 'string' || !part.sessionID) return null
  return { sessionId: part.sessionID, partId: part.id }
}

/** Дельта текста из `message.part.delta` (opencode 1.19.0): `properties.delta` — сам кусок. */
export function textDeltaFromPartDelta(event: any): { sessionId: string; partId: string; text: string } | null {
  if (event?.type !== 'message.part.delta') return null
  const p = event?.properties
  if (!p) return null
  if (typeof p.sessionID !== 'string' || !p.sessionID) return null
  if (typeof p.partID !== 'string' || !p.partID) return null
  if (typeof p.delta !== 'string' || !p.delta) return null
  return { sessionId: p.sessionID, partId: p.partID, text: p.delta }
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

// ─── КОПИЛКА ПРОЗЫ АГЕНТА (канал `agent_text`) ───────────────────────────────
//
// Правила по тексту агента (`agent_text_regex`: agent-claims-continue, anti-silent-defer и
// семейство) читают ТОЛЬКО `payload.channels.agent_text`. В opencode этот канал неоткуда взять
// на входе хода: хук `chat.message` зовётся ТОЛЬКО на сообщение человека (бинарь 1.19.0:
// `trigger("chat.message")` — одно вхождение, внутри `createUserMessage`, роль всегда `user`).
// Поэтому прозу копим из дельт `message.part.updated` и прикладываем к событию так же, как это
// делает хук Claude Code (там `agent_text` — последняя реплика ассистента на момент события):
// на `chat.message` — проза ПРЕДЫДУЩЕГО хода, на `tool.after` — текущего.
//
// Ключ — номер сессии. `take` (чтение с обнулением) зовётся на `chat.message`: это граница хода.
// `peek` (чтение без обнуления) — на `tool.after`: проза текущего хода ещё копится.

/** Дописать кусок прозы ассистента (пустой текст и пустая сессия — не событие). */
export function appendAgentProse(store: Map<string, string>, sessionId: string, text: string): void {
  if (!sessionId || !text) return
  store.set(sessionId, (store.get(sessionId) ?? '') + text)
}

/** Прочитать прозу, НЕ обнуляя. Пусто — undefined («проза не накопилась», а не пустая строка). */
export function peekAgentProse(store: Map<string, string>, sessionId: string): string | undefined {
  const v = store.get(sessionId)
  return v && v.length > 0 ? v : undefined
}

/** Прочитать прозу И обнулить (граница хода). Пусто — undefined. */
export function takeAgentProse(store: Map<string, string>, sessionId: string): string | undefined {
  const v = store.get(sessionId)
  store.delete(sessionId)
  return v && v.length > 0 ? v : undefined
}

export interface SessionRetry {
  sessionId: string
  attempt: number
  /** Когда будет следующая попытка, epoch-ms (типы SDK: next: number). */
  next: number
  message: string
}

/**
 * session.status → session.retry (PRP 10, договор «каждый описывает своё»).
 * Только ветка retry: busy и idle НЕ переводим — их уже дают chat.message и
 * session.idle, иначе одна поломка считалась бы дважды. Форма status — из типов
 * SDK opencode (types.gen.d.ts:396): {type:'retry', attempt, message, next}.
 */
export function retryFromSessionStatus(event: any): SessionRetry | null {
  if (event?.type !== 'session.status') return null
  const p = event?.properties ?? {}
  if (typeof p.sessionID !== 'string' || !p.sessionID) return null
  const st = p.status
  if (!st || st.type !== 'retry') return null
  return {
    sessionId: p.sessionID,
    attempt: typeof st.attempt === 'number' ? st.attempt : 0,
    next: typeof st.next === 'number' ? st.next : 0,
    message: typeof st.message === 'string' ? st.message : '',
  }
}
