/**
 * Цена в ответе двери: `usage.cost` — единственное, что посредник читает как готовую
 * стоимость вызова. Поставщик за дверью присылает `cost: 0`, и LiteLLM берёт этот ноль
 * как есть (`if usage.cost is not None: cost = usage.cost`), НЕ считая по нашим ставкам.
 *
 * Цена этого нуля измерена 02.11.2026: `spend=0` у всего Go-трафика через дверь, а значит
 * не наполняется и `LiteLLM_BudgetWindowSpend` — то есть ЛИМИТЫ СТУПЕНЕЙ не растут ни у кого
 * на Go. Ноль — не «бесплатно», а «не считали», и разница здесь стоит денег.
 *
 * Поэтому дверь сама объявляет цену: она её уже знает (`opencode.list_cost`) и пишет в свой
 * журнал. Правило: есть `list_cost` — ставим его; нет — `cost` УБИРАЕМ (отсутствие значит
 * «решай сам», и посредник посчитает по ставкам), но никогда не оставляем ноль.
 */

/** Цена вызова, если поставщик её назвал. `null` — не назвал (а не «ноль»). */
export function listCostOf(usage: unknown): number | null {
  const u = (usage ?? {}) as Record<string, any>
  const v = (u.opencode ?? {})?.list_cost
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Правка одного объекта-ответа. Не-объект или нечего править — исходный текст. */
export function withCostInBody(text: string): string {
  try {
    const doc = JSON.parse(text) as Record<string, any>
    const usage = doc?.usage ?? doc?.response?.usage
    if (!usage || typeof usage !== 'object') return text
    const cost = listCostOf(usage)
    if (cost === null) {
      if ('cost' in usage && usage.cost === 0) delete usage.cost
      else return text
    } else {
      if (usage.cost === cost) return text
      usage.cost = cost
    }
    return JSON.stringify(doc)
  } catch {
    return text
  }
}

/**
 * Правка SSE-потока по строкам. Возвращает `{ out, rest }`: `out` — готовые строки для
 * клиента, `rest` — недописанный хвост, который надо придержать до следующего куска.
 * Строки, где нет usage, отдаются байт в байт — поток не переписывается зря.
 */
export function withCostInSse(buffer: string): { out: string; rest: string } {
  const cut = buffer.lastIndexOf('\n')
  if (cut < 0) return { out: '', rest: buffer }
  const head = buffer.slice(0, cut + 1)
  const rest = buffer.slice(cut + 1)
  // `head` заканчивается переводом строки, поэтому после split последний элемент пуст —
  // его снимаем, а перевод строки возвращаем явно, иначе склеим соседние события.
  const lines = head.split('\n')
  lines.pop()
  const out = lines
    .map((line) => {
      const t = line.trimEnd()
      if (!t.startsWith('data:')) return line
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') return line
      if (!payload.includes('"usage"') || !payload.includes('list_cost')) return line
      const fixed = withCostInBody(payload)
      return fixed === payload ? line : `data: ${fixed}`
    })
    .join('\n')
  return { out: out.length > 0 ? `${out}\n` : '', rest }
}
