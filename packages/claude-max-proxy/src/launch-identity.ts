/**
 * КТО ЗАПУЩЕН В ПРОЦЕССЕ — по клейму, которое пускатель ставит в окружение.
 *
 * 🔴 ЗАЧЕМ. Замер владельца SynqTask 26.09.2026, 13:44Z: тревога «сессия агента
 * promptera-api стоит 21 минуту» была про сессию `5e3ef0ef`, запущенную под
 * личностью `external_scratch_general_02` (запасная у главного агента), просто
 * в папке promptera-api. В той папке жили ТРИ Claude с тремя личностями, и
 * карточка с кнопкой «Перезапустить с чистой памятью» назвала здорового
 * владельца проекта. Папка говорит, ГДЕ агент работает, а не КТО он.
 *
 * Клеймо запуска — знание, а не догадка: kiberos пишет его в окружение при
 * старте, и оно не меняется до конца процесса. Прочитать его может только тот,
 * кто видит процесс, — это мы (номер процесса у нас есть), а не телеграм-служба:
 * она живёт в контейнере и чужих /proc не видит.
 *
 * 🔴 ЧИТАЮТСЯ РОВНО ТРИ ИМЕНИ, И НИ ОДНОГО СЕКРЕТА. В том же окружении лежат
 * ключи агента и мастер-ключ; окружение целиком никуда не уходит и не пишется.
 */

import { readFileSync } from 'node:fs'

export interface LaunchIdentity {
  /** Участник SynqTask — uuid (`SYNQTASK_AGENT_UUID`). */
  memberId?: string
  /** Имя агента, как его читает человек (`SYNQTASK_AGENT_ID`). */
  agentName?: string
  /** Привязка kiberos (`KIBEROS_BINDING_ID`) — различает запасные места одной личности. */
  bindingId?: string
}

const KEYS: Record<string, keyof LaunchIdentity> = {
  SYNQTASK_AGENT_UUID: 'memberId',
  SYNQTASK_AGENT_ID: 'agentName',
  KIBEROS_BINDING_ID: 'bindingId',
}

/** Разобрать содержимое /proc/PID/environ. Вынесено, чтобы проверять без /proc. */
export function parseLaunchIdentity(environ: string): LaunchIdentity | null {
  const out: LaunchIdentity = {}
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const field = KEYS[entry.slice(0, eq)]
    const value = entry.slice(eq + 1).trim()
    if (field && value) out[field] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Клеймо запуска процесса. `null` — клейма нет (запущен мимо kiberos) или
 * процесс не прочитать; это «не знаем», и выдумывать за него нельзя.
 */
export function readLaunchIdentity(pid: number): LaunchIdentity | null {
  try { return parseLaunchIdentity(readFileSync(`/proc/${pid}/environ`, 'utf8')) }
  catch { return null }
}
