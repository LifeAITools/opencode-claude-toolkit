/**
 * Выдачи переживают перезапуск двери. Полюс измерен 26.10.2026: память процесса стиралась
 * каждым выпуском прокси, и живая сессия с уже выданной организацией выбиралась заново —
 * в следе это `pin → quota → pin`, то есть холодная перезапись префикса на ровном месте.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePins, restorePinsForTest } from './modules/go-door.js'

describe('выдачи организации на диске', () => {
  // 🔴 ПОВЕДЕНИЕ ПЕРЕВЁРНУТО ПО СЛОВУ ФАУНДЕРА 03.11.2026 (принёс vibe-translator-owner):
  // «почему спустя 12 часов сессия должна получить новую организацию? … Либо она получает ту же,
  // либо полный отказ». Прежний тест утверждал обратное («просроченная — нет»), и на этом
  // стояла дыра: файл ВЫБРАСЫВАЛ истёкшие записи при загрузке, поэтому после перезапуска дверь
  // не знала, что организация была выдана, и выбирала новую как «первую выдачу» — то есть
  // правило «не переселяй молча» обходилось самим перезапуском.
  //
  // Теперь: выдача живёт 12 ч ДЛЯ МАРШРУТИЗАЦИИ (истёкшая = повод держать ту же организацию),
  // а в файле помнится неделю — чтобы сессия, вернувшаяся после паузы, получила ту же
  // организацию или отказ, а не холодную запись в чужую.
  test('свежая и ИСТЁКШАЯ (13 ч) выдача остаются в файле; забытая за неделю — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'))
    const path = join(dir, 'pins.json')
    const now = Date.now()
    restorePinsForTest([
      ['ses_fresh', { org: 'hello@sealform.dev', at: now }],
      ['ses_expired', { org: 'hello@foody7.com', at: now - 13 * 3600 * 1000 }],
      ['ses_forgotten', { org: 'hello@uniclowd.com', at: now - 8 * 24 * 3600 * 1000 }],
    ])
    savePins(path)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(doc.pins).sort()).toEqual(['ses_expired', 'ses_fresh'])
    expect(doc.pins.ses_fresh.org).toBe('hello@sealform.dev')
    expect(doc.pins.ses_expired.org).toBe('hello@foody7.com')
  })

  test('файл читается обратно тем же форматом', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'))
    const path = join(dir, 'pins.json')
    const now = Date.now()
    restorePinsForTest([['ses_a', { org: 'hello@kiberos.app', at: now }]])
    savePins(path)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    // v2 с 06.11.2026 (b07b270): к выдачам добавился `dropped` — отдых отказавшей
    // организации, который обязан переживать перезапуск двери.
    expect(doc.version).toBe(2)
    expect(doc.pins.ses_a).toEqual({ org: 'hello@kiberos.app', at: now })
    expect(doc.dropped).toEqual({})
  })
})
