/**
 * owner-passport — кто завёл сессию: имя процесса, команда, каталог, родитель.
 *
 * 🔴 ЖИВЁТ ЗДЕСЬ, А НЕ В ТРЕКЕРЕ СЕССИЙ ПАКЕТА ПРОКСИ, И ЭТО КУПЛЕНО ОШИБКОЙ.
 * Сначала паспорт был написан в SessionTracker — и выкатился в мёртвый код:
 * живой прокси создаёт сессии через InMemorySessionStore, а событие рождения
 * сессии из трекера не эмитилось НИ РАЗУ за всю жизнь журнала (проверено
 * 04.09.2026: ровно ноль записей). Расписка о выкатке была зелёной, а путь не
 * отрабатывал. Поймано живой пробой, а не чтением кода.
 */

import { readFileSync, readlinkSync } from 'node:fs'

/**
 * Паспорт владельца сессии: что это за процесс, откуда он запущен и кем.
 *
 * 🔴 ЗАЧЕМ, ЗАМЕР 04.09.2026. Семь сессий грелись сутки, четыре из них не сделав
 * НИ ОДНОГО настоящего хода, и опознать их было нечем: ни в журнале, ни в
 * снимках, ни в дампах тел не нашлось ни имени клиента, ни владельца — только
 * шестнадцатеричное имя сессии. Просьба фаундера дословно: «чтобы мы понимали,
 * что за процесс, как называется, кто его запустил, в общем, всё, что нужно
 * знать, чтобы было видно всё».
 *
 * Снимается ОДИН РАЗ на рождение сессии, не на каждом ходу: паспорт не меняется,
 * а чтение /proc стоит нескольких системных вызовов.
 *
 * 🔴 КОМАНДНАЯ СТРОКА ОБРЕЗАЕТСЯ И ЧИСТИТСЯ. В аргументах процесса живут ключи и
 * токены, а этот журнал читают люди и соседние службы; лучше короткое честное
 * начало команды, чем полная строка, которую нельзя показать.
 */
export interface OwnerPassport {
  pid: number
  /** Короткое имя процесса — `node`, `bun`, `python3`. */
  name: string | null
  /** Начало команды запуска, вычищенное от похожего на секреты. */
  cmd: string | null
  /** Рабочий каталог — по нему сразу виден проект, из которого пришли. */
  cwd: string | null
  /** Кто запустил: номер родителя и его имя. */
  ppid: number | null
  parentName: string | null
  /** Когда процесс поднялся, в секундах от старта машины. */
  startedSecAfterBoot: number | null
}

/** Убрать из строки то, что похоже на ключ или токен.
 *  Открыто ради испытания: это единственная защита между аргументами чужого
 *  процесса и журналом, который читают люди и соседние службы. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ey[A-Za-z0-9_-]{20,})/g, '<секрет>')
    .replace(/(--?(?:token|key|secret|password|api[-_]?key)[= ])\S+/gi, '$1<секрет>')
}

export function readOwnerPassport(pid: number): OwnerPassport {
  const out: OwnerPassport = {
    pid, name: null, cmd: null, cwd: null, ppid: null, parentName: null, startedSecAfterBoot: null,
  }
  try { out.name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null } catch { /* процесс мог уйти */ }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    out.cmd = raw ? scrubSecrets(raw).slice(0, 300) : null
  } catch { /* нет прав или процесс ушёл */ }
  try { out.cwd = readlinkSync(`/proc/${pid}/cwd`) } catch { /* чужой процесс — читать не дадут */ }
  try {
    // /proc/PID/stat: поле 4 — родитель, поле 22 — время старта. Имя процесса в
    // поле 2 стоит в скобках и МОЖЕТ СОДЕРЖАТЬ ПРОБЕЛЫ, поэтому разбор идёт от
    // закрывающей скобки, а не простым split по пробелам.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)
    const ppid = parseInt(tail[1], 10)
    if (Number.isFinite(ppid)) {
      out.ppid = ppid
      try { out.parentName = readFileSync(`/proc/${ppid}/comm`, 'utf8').trim() || null } catch { /* родитель ушёл */ }
    }
    const startTicks = parseInt(tail[19], 10)
    if (Number.isFinite(startTicks)) out.startedSecAfterBoot = Math.round(startTicks / 100)
  } catch { /* stat недоступен */ }
  return out
}

