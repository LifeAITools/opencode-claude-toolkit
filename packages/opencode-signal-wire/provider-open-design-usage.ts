/**
 * Квота OpenDesign Go ДЛЯ ПОДВАЛА агента — второй провайдер рядом с OpenCode Go.
 *
 * ЗАЧЕМ (вопрос фаундера 05.11.2026): подвал умеет показывать «в какой организации агент
 * и сколько там осталось», но читает ТОЛЬКО файл Go. Агент на OpenDesign в подвале показывал
 * пустоту — хотя числа есть и лежат рядом, в `quota-status-open-design.json`.
 *
 * 🔴 ЧТО ДАЁТ САМ ПРОВАЙДЕР, И ЧЕГО У НЕГО НЕТ.
 * Есть: `workspaceId` (это и есть «организация»), `workspaceType` (personal|team), имя
 * workspace, план и кошелёк. Нет: НИЧЕГО похожего на org-uid SynqTask — поэтому склеивать
 * `member.orgUid` с провайдером нечем, и подставлять туда чужой uid нельзя. Подвал показывает
 * ИМЯ workspace и его идентификатор — это честная подпись, а не выдуманная связь.
 *
 * Есть и второй идентификатор, `workspaceMemberId`, но он членский, а не организационный:
 * один человек в двух workspace имеет два разных — для подписи он бесполезен.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const OPEN_DESIGN_QUOTA_STATUS_JSON = join(homedir(), '.claude-local', 'quota-status-open-design.json')

export function openDesignQuotaStatusPath(): string {
  return process.env.OPEN_DESIGN_QUOTA_STATUS_JSON?.trim() || OPEN_DESIGN_QUOTA_STATUS_JSON
}

export interface OpenDesignAccountView {
  /** Имя workspace — то, что человек видит в кабинете. Не uid и не почта. */
  org: string | null
  workspaceId: string | null
  workspaceType: string | null
  plan: string | null
  util5h: number | null
  util7d: number | null
  reset5hAt: string | null
  reset7dAt: string | null
  /** Причина отсутствия чисел. `null` — чисел нет и причины провайдер не назвал. */
  absent: string | null
}

export interface OpenDesignQuotaView {
  provider: 'open-design'
  measuredAt: string | null
  accounts: OpenDesignAccountView[]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** Читает файл сборщика. Нет файла/битый — `null`: «не измерено», а не «ноль». */
export function readOpenDesignQuota(path: string = openDesignQuotaStatusPath()): OpenDesignQuotaView | null {
  let doc: any
  try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!doc || typeof doc !== 'object' || doc.provider !== 'open-design') return null
  const accounts: OpenDesignAccountView[] = []
  const raw = doc.accounts && typeof doc.accounts === 'object' ? doc.accounts : {}
  for (const [name, a] of Object.entries(raw as Record<string, any>)) {
    accounts.push({
      org: str(a?.org) ?? str(name),
      workspaceId: str(a?.workspaceId),
      workspaceType: str(a?.workspaceType),
      plan: str(a?.plan) ?? str(doc.plan),
      util5h: num(a?.util5h),
      util7d: num(a?.util7d),
      reset5hAt: str(a?.reset5hAt),
      reset7dAt: str(a?.reset7dAt),
      absent: str(a?.absent),
    })
  }
  return { provider: 'open-design', measuredAt: str(doc.measured_at) ?? str(doc.updatedAt), accounts }
}

/** Аккаунт для подписи: сначала годный, иначе первый (он и объяснит причину). */
export function pickOpenDesignAccount(view: OpenDesignQuotaView | null): OpenDesignAccountView | null {
  if (!view || !view.accounts.length) return null
  return view.accounts.find(a => !a.absent) ?? view.accounts[0]
}

/** Одна строка для подвала: «workspace · 5ч 5.3% · нед 1.8%». */
export function describeOpenDesignQuota(view: OpenDesignQuotaView | null): string | null {
  const a = pickOpenDesignAccount(view)
  if (!a) return null
  if (a.absent) return `${a.org ?? 'open-design'} · нет подписки (${a.absent})`
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`)
  return `${a.org ?? 'open-design'} · 5ч ${pct(a.util5h)} · нед ${pct(a.util7d)}`
}
