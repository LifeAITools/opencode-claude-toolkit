/**
 * session-identity — единая точка опознания сессии по поставщику (FR-19 / D3).
 *
 * Двери узнают разговор РАЗНЫМИ носителями (Anthropic — заголовок
 * `x-claude-code-session-id`, затем `metadata.user_id` в теле; Go и spark — имя
 * зовущего из `CALLER_SESSION_HEADERS`), но ПРАВИЛО одно и живёт
 * здесь: сначала заголовок, затем тело (если у диалекта есть носитель), затем
 * производный номер (если дверь умеет его вывести), иначе — честное «не опознан».
 *
 * 🔴 ПОЧЕМУ «НЕ ОПОЗНАН» — ОТДЕЛЬНЫЙ ИСХОД, А НЕ ВЫДУМАННЫЙ НОМЕР.
 * Неопознанный запрос ОБСЛУЖИВАЕТСЯ, но прогрев на нём НЕ вооружается: у разового
 * вызова нет номера, по которому его можно узнать второй раз, — греть его слот
 * кэша некому (замер: анонимные запросы — одноразовая суммаризация без сессии по
 * природе). Производный номер (хэш ключа, адрес пира) — ЗАКОННЫЙ исход для дверей
 * совместимости, но он обязан называться `derived`, а не выдавать себя за заголовок:
 * иначе он молча вооружает прогрев на номере, который делят несколько клиентов.
 *
 * Дверь, у которой нет носителя в теле, зовёт с `bodyText: null` — это «носителя
 * нет», а не «не нашли».
 */

/**
 * Имена заголовка сессии, которыми ЗОВУЩИЕ её называют, — в порядке предпочтения.
 *
 * 🔴 ИЗМЕРЕНО, А НЕ ВЫДУМАНО (дамп ключей заголовков на pre-call хуке посредника,
 * kiberos-app 19.10.2026, 31 вызов подряд — все одинаковые): приходят ровно два:
 * `x-opencode-session-id` (так зовёт пускатель агентов) и `x-litellm-session-id`
 * (на дверях моделей чата). Прежнее чтение `x-opencode-session` — НЕ то имя:
 * разница в два знака, и дверь молча не опознавала сессию пускателя.
 * Имя `x-opencode-session` осталось ТОЛЬКО на ИСХОДЯЩЕЙ стороне (так зовёт
 * поставщика дверь spark) — читать его у зовущего больше не нужно.
 */
export const CALLER_SESSION_HEADERS = ['x-opencode-session-id', 'x-litellm-session-id'] as const

/**
 * Имя сессии от зовущего и ИМЯ ЗАГОЛОВКА, которым оно пришло.
 *
 * 🔴 ИМЯ ЗАГОЛОВКА ВОЗВРАЩАЕТСЯ НАРОЧНО: пускатель агентов и дверь чата называют
 * сессию по-разному, и без этого нельзя отличить агентскую сессию от разговора —
 * а смешать их значит испортить показ (довод владельца kiberos-app 19.10).
 */
export function readCallerSession(headers: { get(name: string): string | null }): {
  sessionId: string | null
  header: (typeof CALLER_SESSION_HEADERS)[number] | null
} {
  for (const name of CALLER_SESSION_HEADERS) {
    const value = (headers.get(name) ?? '').trim()
    if (value) return { sessionId: value, header: name }
  }
  return { sessionId: null, header: null }
}

/** Откуда взялось имя сессии. `none` — не опознана (обслужить, прогрев не вооружать). */
export type SessionIdSource = 'header' | 'body' | 'derived' | 'none'

export interface SessionIdentity {
  /** Имя сессии; `null` — запрос не опознан (номер, если нужен, выдаёт вызывающий). */
  sessionId: string | null
  source: SessionIdSource
}

export interface SessionIdentityInput {
  /** Значение заголовка-двери ЭТОГО поставщика, если он есть. */
  headerValue?: string | null
  /** Тело как текст. `null` — диалект носителя не имеет / тело не читали. */
  bodyText?: string | null
  /** Извлекатель из тела для ЭТОГО диалекта (Anthropic — `metadata.user_id`). */
  bodyExtractor?: ((text: string) => string | null) | null
  /** Производный номер, когда ни заголовка, ни тела нет (двери совместимости). */
  derive?: (() => string | null) | null
}

export function resolveSessionIdentity(input: SessionIdentityInput): SessionIdentity {
  const header = (input.headerValue ?? '').trim()
  if (header) return { sessionId: header, source: 'header' }

  if (input.bodyText && input.bodyExtractor) {
    const fromBody = (input.bodyExtractor(input.bodyText) ?? '').trim()
    if (fromBody) return { sessionId: fromBody, source: 'body' }
  }

  if (input.derive) {
    const derived = (input.derive() ?? '').trim()
    if (derived) return { sessionId: derived, source: 'derived' }
  }

  return { sessionId: null, source: 'none' }
}

/**
 * Отображение в `idSource` движка (`header` | `body` | `none`): неопознанному —
 * `none`, чтобы прогрев на нём не вооружился. `derived` идёт как `header` —
 * дверь совместимости объявила номер САМА, и это её нынешнее поведение; смена
 * этого — отдельное решение про двери совместимости, не про эту точку.
 */
export function toEngineIdSource(source: SessionIdSource): 'header' | 'body' | 'none' {
  return source === 'none' ? 'none' : source === 'body' ? 'body' : 'header'
}
