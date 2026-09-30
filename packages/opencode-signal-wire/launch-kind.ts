/**
 * КАК ЗАПУЩЕН opencode — по его подкоманде в командной строке.
 *
 * `opencode [project]` — окно (TUI); `opencode serve | web | acp` — долгоживущий сервер без окна;
 * `opencode run "…"` — РАЗОВЫЙ прогон: выполнил задание и вышел.
 *
 * ЗАЧЕМ РАЗЛИЧАТЬ. 30.09 13:56–14:02Z vibe-yjs-todo-sync-owner проверял модели командой
 * `opencode run -m <модель> "…"` из своей сессии, и дочерние процессы унаследовали его окружение
 * (KIBEROS_BINDING_ID и секрет). Плагин поднял в каждом приёмник побудок — роутер увидел у его
 * личности 4 живых места — и файловая дверь забрала письма из ОБЩЕЙ папки его окна: два прогона
 * получили голосовые фаундера и ответили ему от имени агента, противореча друг другу. Разовый прогон —
 * не место агента: ни двери, ни отметки жизни, ни привязки сессии к агенту.
 *
 * Разбор — по ПЕРВОМУ позиционному аргументу, а не по вхождению слова: текст задания
 * (`opencode run "serve the web"`) иначе читался бы как подкоманда.
 */

/** Флаги opencode, за которыми идёт значение отдельным аргументом. */
const VALUE_FLAGS = new Set([
  '-m', '--model', '-s', '--session', '--agent', '--port', '--hostname', '--prompt',
  '--log-level', '-f', '--file', '--title', '--format', '--attach', '--variant',
])

/** Подкоманда opencode или null (окно). Путь к самому бинарю/скрипту в начале пропускается. */
export function opencodeSubcommand(argv: readonly string[]): string | null {
  const args = argv.slice(1)
  if (args.length > 0 && /[\\/]/.test(args[0]!) && !args[0]!.startsWith('-')) args.shift()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') return null
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a)) i++
      continue
    }
    return a
  }
  return null
}

/** Разовый прогон `opencode run`: не место агента. */
export function isOneShotRun(argv: readonly string[]): boolean {
  return opencodeSubcommand(argv) === 'run'
}

/** Есть ли окно: всё, кроме serve | web | run | acp. Позиционный аргумент окна — путь проекта. */
export function hasWindow(argv: readonly string[]): boolean {
  const sub = opencodeSubcommand(argv)
  return !(sub === 'serve' || sub === 'web' || sub === 'run' || sub === 'acp')
}
