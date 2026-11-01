/**
 * Журнал денег двери Go: одна строка на один вызов, дописывание в конец.
 *
 * ЗАЧЕМ ОН ВООБЩЕ. Посредник (LiteLLM) на стримящем пути пишет в SpendLogs `spend=0`:
 * цена там считается по объекту, в котором уже нет ни токенов, ни ставки, а строка
 * записывается РАНЬШЕ, чем срабатывают хуки — подложить готовое значение некуда
 * (замер 01.11.2026, одиннадцать отвергнутых дорог в задаче 9e04cea5). При этом ДВЕРЬ
 * деньги знает всегда: она отдаёт `usage.opencode.list_cost` и в стриме, и без него.
 *
 * Поэтому писатель — здесь, у того, кто видит факт. Читатели (биллинг, ступени, подвал)
 * переезжают на этот журнал; SpendLogs перестаёт быть источником для расчёта.
 *
 * ГРАНИЦЫ (не расширять молча):
 *   • ОДИН писатель. Второй писатель одного факта — это два расходящихся числа.
 *   • Только дописывание. Правок и пересчётов нет: пересчёт — это второй писатель.
 *   • НЕТ ЦИФРЫ — NULL, А НЕ НОЛЬ. Поставщик не отдал `list_cost` — значит «не измерено»;
 *     ноль соврёт так же, как соврал SpendLogs.
 *   • Любая беда журнала — МОЛЧАНИЕ, а не ошибка клиенту: деньги не стоят сорванного хода.
 *
 * СЦЕПКА С ПОСРЕДНИКОМ: `responseId` — это `id`, который дверь вернула клиенту, и он же
 * лежит в `LiteLLM_SpendLogs.request_id` (проверено живьём 01.11.2026: значение совпало
 * побайтно). По нему деньги сцепляются с ключом и человеком на стороне посредника; сам
 * ключ до двери не доезжает — LiteLLM ходит сюда с подставным `sk-door`.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface GoSpendEntry {
  /** ISO-8601, момент ответа. */
  ts: string
  /** id ответа двери = `LiteLLM_SpendLogs.request_id`. */
  responseId: string | null
  sessionId: string | null
  org: string | null
  model: string | null
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  /** `usage.opencode.list_cost` — настоящие деньги вызова. */
  listCost: number | null
  /** `usage.opencode.allowance` — сколько из них покрыто подпиской. */
  allowance: number | null
  callKind: string | null
}

/** Каталог журнала: `GO_SPEND_LEDGER_DIR`, иначе рядом с остальными следами двери. */
export function goSpendLedgerDir(): string {
  return process.env.GO_SPEND_LEDGER_DIR ?? join(homedir(), '.claude-local')
}

/** Один файл в сутки — как у дампа тел: без ротации файл растёт без предела. */
export function goSpendLedgerPath(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return join(goSpendLedgerDir(), `go-spend-${day}.jsonl`)
}

/**
 * Деньги из `usage` ответа двери. Отсутствие — NULL: `usage.cost` у двери всегда 0 и
 * деньги в него НЕ кладутся, поэтому читать надо `opencode.list_cost`.
 */
export function extractDoorMoney(usage: unknown): { listCost: number | null; allowance: number | null } {
  const u = (usage ?? {}) as Record<string, any>
  const o = (u.opencode ?? {}) as Record<string, any>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { listCost: num(o.list_cost), allowance: num(o.allowance) }
}

/**
 * id потока из SSE-текста. Дверь кладёт один и тот же `id` в каждый чанк, поэтому
 * достаточно первого `data:` — копия потока начинается с начала.
 */
export function responseIdFromSseText(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const j = JSON.parse(payload) as { id?: unknown }
      if (typeof j?.id === 'string' && j.id) return j.id
    } catch {
      /* не-JSON чанк — идём дальше */
    }
  }
  return null
}

/**
 * Запущен ли набор испытаний. `NODE_ENV` у `bun test` бывает не выставлен (проверено
 * 01.11.2026: он `undefined`), поэтому смотрим ещё и аргументы: имя тест-файла в них есть.
 */
function underTest(): boolean {
  if (process.env.NODE_ENV === 'test') return true
  return process.argv.some((a) => a === 'test' || a.endsWith('.test.ts'))
}

/** Дописать одну строку. Никогда не бросает: журнал не имеет права сорвать ход. */
export function appendGoSpendRecord(entry: GoSpendEntry, opts: { path?: string } = {}): boolean {
  try {
    // 🔴 ИСПЫТАНИЯ НЕ ПИШУТ В БОЕВОЙ ЖУРНАЛ. Найдено на живом 01.11.2026: прогон набора
    // оставил в боевом файле строку с `sessionId=conv-401` — деньги людей и выдумка
    // испытания лежали в одном файле. Явно указанный путь (временный каталог) — можно.
    if (opts.path === undefined && underTest()) return false
    const path = opts.path ?? goSpendLedgerPath()
    mkdirSync(goSpendLedgerDir(), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
    return true
  } catch {
    return false
  }
}
