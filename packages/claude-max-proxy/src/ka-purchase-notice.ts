/**
 * СТРОКА ФАУНДЕРУ, КОГДА ПРОГРЕВ КУПИЛ КЭШ.
 *
 * Прогрев по смыслу кэш ЧИТАЕТ: чтение продлевает жизнь префикса у Anthropic. Если выстрел
 * ЗАПИСАЛ кэш, он купил префикс заново — либо ветка истекла, либо прокси выстрелил по мёртвой.
 * 30.09.2026 такие покупки нашлись только в журнале и только задним числом: за 40 часов четыре,
 * все сразу после перезапусков прокси (воскрешённые ветки получали чужие часы — починено в
 * 1.1.30). Фаундер в тот же вечер: «Да, присылать» — строку на каждую запись больше 50 тысяч;
 * «сначала логика по веткам, потом уведомления, и уведомления через сурфейс».
 *
 * КУДА: системный голос сурфейса (`postSystemNotice`, без имени агента, без кнопок, никого не
 * будит) в комнату проекта claude-code-sdk — это событие прокси, там его и ищут (совет владельца
 * сурфейса). Порог, комната и потолок строк в час — `keepalive.json` → `kaPurchaseNotice`.
 *
 * ФОРМА — по правилам фаундера: первая строка — короткий итог (в списке тем видна только она),
 * дальше по-человечески: чья сессия (имя агента), какая ветка, сколько записано против
 * прочитанного, сколько простояла и какой у неё срок, первый ли это выстрел после перезапуска.
 * Номера — в конце, для поиска.
 */
import { loadKeepaliveConfig } from '@life-ai-tools/claude-code-sdk'
import { bus } from './event-bus.js'
import { postSystemNotice } from './surface-card.js'
import type { LaunchIdentity } from './launch-identity.js'

export interface KaFireEvent {
  ts?: string
  sessionId?: string
  lineageKey?: string | null
  role?: string | null
  idleMs?: number | null
  provenBeforeFire?: boolean | null
  lineageTtlMs?: number | null
  lineageTokens?: number | null
  usage?: { cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
}

const thousands = (n: number): string => `${Math.round(n / 1000).toLocaleString('ru-RU')} тыс.`
const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m >= 60 && m % 60 === 0 ? `${m / 60} ч` : `${m} мин`
}
/** Роли движка (lineage.ts, AgentRole): main | sub | aux | unknown. */
const roleName = (role: string | null | undefined): string =>
  role === 'main' ? 'главный разговор'
    : role === 'sub' ? 'помощник'
      : role === 'aux' ? 'служебный запрос разговора'
        : 'ветка разговора'

/** Текст строки. Отдельно от отправки — чтобы форму можно было проверить без сети. */
export function purchaseNoticeText(e: KaFireEvent, who: LaunchIdentity | null): string {
  const write = e.usage?.cacheCreationInputTokens ?? 0
  const read = e.usage?.cacheReadInputTokens ?? 0
  const agent = who?.agentName ?? 'агент без имени (запущен не пускателем)'
  const lines: string[] = []
  lines.push(`**Прогрев купил кэш: ${thousands(write)}**`)
  lines.push('')
  lines.push(`У агента **${agent}** служебный запрос, который должен был только прочитать кэш, записал его заново.`)
  lines.push('')
  lines.push(`- ветка: ${roleName(e.role)}${e.lineageTokens ? `, ${thousands(e.lineageTokens)} токенов` : ''}`)
  lines.push(`- записано ${thousands(write)}, прочитано ${thousands(read)}`)
  if (typeof e.idleMs === 'number') lines.push(`- ветка простояла ${minutes(e.idleMs)}${e.lineageTtlMs ? `, её кэш живёт ${minutes(e.lineageTtlMs)}` : ''}`)
  if (e.provenBeforeFire === false) {
    lines.push('- это первый выстрел по ветке после перезапуска прокси: живой её до того ничто не подтвердило')
  } else if (e.provenBeforeFire === true) {
    lines.push('- ветка была подтверждена живой — похоже, кэш потерян на стороне Anthropic')
  }
  lines.push('')
  lines.push(`сессия \`${e.sessionId ?? '-'}\` · ветка \`${e.lineageKey ?? '-'}\``)
  return lines.join('\n')
}

/**
 * Подписаться на выстрелы прогрева. `resolveIdentity` — кто работает в сессии (по номеру процесса
 * её владельца, как у тревоги о стоящей сессии). Возвращает отписку.
 */
export function startKaPurchaseNotice(
  resolveIdentity: (sessionId: string) => LaunchIdentity | null,
  log: (line: string) => void = () => {},
): () => void {
  const sentAt: number[] = []
  return bus.onKind('KA_FIRE_COMPLETE' as never, (ev: unknown) => {
    const e = ev as KaFireEvent
    const cfg = loadKeepaliveConfig().kaPurchaseNotice
    const write = e?.usage?.cacheCreationInputTokens ?? 0
    if (!cfg.enabled || write < cfg.minWriteTokens) return
    const now = Date.now()
    while (sentAt.length && now - sentAt[0]! > 3_600_000) sentAt.shift()
    if (sentAt.length >= cfg.maxPerHour) {
      log(`KA_PURCHASE_NOTICE_CAPPED session=${e.sessionId} write=${write} — уже ${sentAt.length} строк за час`)
      return
    }
    sentAt.push(now)
    let who: LaunchIdentity | null = null
    try { who = e.sessionId ? resolveIdentity(e.sessionId) : null } catch { /* имя — лучшее усилие */ }
    void postSystemNotice({
      chatId: cfg.chatId,
      threadId: cfg.threadId,
      // Без кнопок управления агентом (menuAbout): строка сообщает о прокси, а не просит
      // что-то сделать с агентом.
      text: purchaseNoticeText(e, who),
    }).then((r) => {
      log(r.sent
        ? `KA_PURCHASE_NOTICE_SENT session=${e.sessionId} write=${write} message=${r.messageId ?? '-'}`
        : `KA_PURCHASE_NOTICE_FAILED session=${e.sessionId} write=${write} reason="${r.reason ?? '-'}"`)
    }).catch((err) => log(`KA_PURCHASE_NOTICE_FAILED session=${e.sessionId} err=${String(err)}`))
  })
}
