/**
 * session-identity — единая точка опознания сессии по поставщику (FR-19 / D3).
 *
 * Двери узнают разговор РАЗНЫМИ носителями (Anthropic — заголовок
 * `x-claude-code-session-id`, затем `metadata.user_id` в теле; Go —
 * `x-litellm-session-id`; spark — `x-opencode-session`), но ПРАВИЛО одно и живёт
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
