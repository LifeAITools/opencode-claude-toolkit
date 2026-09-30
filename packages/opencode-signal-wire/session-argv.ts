/**
 * Номер сессии, который пускатель назвал opencode в командной строке (`--session <id>`, `-s <id>`,
 * `--session=<id>`).
 *
 * ЗАЧЕМ. Плагину на старте opencode номер сессии не передаёт (`input.sessionID` пуст), и до
 * 0.3.21 приёмник побудок искал «свою» сессию по папке. 30.09 пилот SynqTalk был поднят как
 * `opencode --session ses_f0e72908…` — продолжение разговора, начатого в СТАРОМ месте проекта
 * (`/mnt/d/Vibe_coding_projects/synqtalk`), а процесс жил в новом (`~/projects/vibe/synqtalk`).
 * По папке сессия не нашлась, и первое же письмо открыло НОВУЮ пустую сессию мимо идущего
 * разговора. Аргумент запуска — единственный достоверный признак: его назвал тот, кто запускал.
 *
 * `--continue` («последняя сессия») номера не несёт — его здесь нет, и он не выдумывается.
 */
export function sessionFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--session' || a === '-s') {
      const v = argv[i + 1]
      return v && !v.startsWith('-') ? v : null
    }
    if (a.startsWith('--session=')) return a.slice('--session='.length) || null
  }
  return null
}
