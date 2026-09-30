/**
 * Отметки жизни из тестов — в песочницу, а не в общий каталог флота; привязки сессий — никуда.
 *
 * Адаптер пишет след жизни на каждом событии конвейера (signal-wire.ts, touchLife), а тесты
 * гоняют конвейер с выдуманными номерами сессий (`ses_agentname`, …). Без этой подмены каждый
 * прогон клал бы их в ~/.claude/hooks/state, и роутер побудок минуту считал бы живым агента,
 * которого нет. Каталог ядро читает при каждом вызове (heartbeatDir → SW_HEARTBEAT_DIR), так
 * что установка здесь, до импорта тестов, действует на весь прогон.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Привязку к агенту конвейер ставит сам (lifeTraceFromEnv) по KIBEROS_BINDING_ID — а прогон, запущенный
// из сессии агента, это окружение наследует и записал бы выдуманные ses_* в живой реестр lat-context.
delete process.env.KIBEROS_BINDING_ID

const dir = mkdtempSync(join(tmpdir(), 'oc-sw-heartbeat-'))
process.env.SW_HEARTBEAT_DIR = dir
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
