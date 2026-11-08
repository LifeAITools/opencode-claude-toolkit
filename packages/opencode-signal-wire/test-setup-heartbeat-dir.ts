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

/**
 * 🔴 СОСТОЯНИЕ КУЛДАУНОВ — ТОЖЕ В ПЕСОЧНИЦУ (08.11.2026). Тесты берут ПОСТОЯННЫЕ номера сессий
 * (`ses_idle_probe`, `ses_parity_1`), а кулдаун правила — это запись в корне состояния ядра
 * (`<root>/sw_cooldowns_<session>.json`). На живом корне тест проходил РОВНО ОДИН РАЗ: первый
 * прогон записывал `last_fire_tokens`, второй читал его и правило уже не срабатывало — и это
 * выглядело как регресс ядра после подъёма версии (замер 08.11: удалить два файла кулдауна —
 * 20/20 зелёные). `defaultStateDir()` учитывает `SW_STATE_DIR`, поэтому одна подмена здесь
 * закрывает весь прогон: и флак, и мусор в живом корне.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'oc-sw-state-'))
process.env.SW_STATE_DIR = stateDir
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))

// Сервер правил машины — боевой. Прогон испытаний не должен отдавать ему выдуманные события:
// их записал бы демон, и правила с побочными действиями (запись памяти, побудки) сработали бы
// по-настоящему. Испытание режима сервера поднимает свой поддельный сокет и задаёт его явно.
process.env.OPENCODE_SW_LOCAL = '1'
