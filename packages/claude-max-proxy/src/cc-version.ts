/**
 * cc-version.ts — какой версией Claude Code представляться за чужих клиентов.
 *
 * 🔴 ЧЕМ КУПЛЕНО (23.09.2026). Прокси дописывает чужому запросу (kiberos-app, tixi,
 * OpenAI-поверхность) подпись `claude-cli/<версия>`, и версия эта была ЛИТЕРАЛОМ в
 * настройке — 2.1.177. Пока сервер пускал любую, литерал старел незаметно. С выходом
 * Opus 5.5 сервер стал проверять версию: «Claude Code 2.1.177 does not support this
 * model; version 2.1.280 or newer is required». Родные агенты прошли (их обновили), а
 * все, кто ходит через нас не из Claude Code, упёрлись в замок — живая проба 1.1.17.
 *
 * Лечение не «поднять литерал ещё раз» (он снова состарится молча), а брать версию
 * там, где её держат свежей: у установленного на этой машине Claude Code. Настройка
 * остаётся полом — для сайдкаров, где Claude Code не стоит вовсе. Берётся БОЛЬШАЯ из
 * двух, и читается только при старте: версия, прыгающая посреди жизни службы, меняла
 * бы строку учёта в системной части запроса и перезаписывала кэш чужих сессий.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CC_PACKAGE = '@anthropic-ai/claude-code'

/** Сравнение x.y.z; нечисловые хвосты игнорируются. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Версия Claude Code, установленного на машине: от исполняемого файла вверх до
 * package.json пакета. null — если не нашли (сайдкар, другая раскладка).
 */
export function detectInstalledCcVersion(
  candidates: string[] = [join(homedir(), '.local/bin/claude'), join(homedir(), '.npm-global/bin/claude')],
): string | null {
  for (const c of candidates) {
    let dir: string
    try { dir = dirname(realpathSync(c)) } catch { continue }
    for (let i = 0; i < 6; i++) {
      const pkg = join(dir, 'package.json')
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string }
          if (j.name === CC_PACKAGE && j.version) return j.version
        } catch { /* битый package.json — идём выше */ }
      }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

/** Действующая версия: большая из настроенной (пол) и установленной. */
export function resolveCompatVersion(configured: string, installed: string | null): { version: string; source: 'installed' | 'config' } {
  if (installed && compareVersions(installed, configured) > 0) return { version: installed, source: 'installed' }
  return { version: configured, source: 'config' }
}
