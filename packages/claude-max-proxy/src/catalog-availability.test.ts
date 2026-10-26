/**
 * Донесения доступности: главное, что здесь проверяется, — ЧЕГО БОКАРЬ НЕ ОТПРАВЛЯЕТ.
 * Отчёт заменяет снимок машины целиком, поэтому пустой снимок при сбое сбора объявил бы
 * «на этой машине не запускается ничего» — то есть сбой прибора стал бы фактом о мире.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildReport,
  missingSettings,
  readCatalogAvailabilityConfig,
  sendAvailability,
  startCatalogAvailability,
  type CatalogAvailabilityConfig,
} from './catalog-availability.js'

const ENV = {
  CATALOG_AVAILABILITY_ENABLED: 'true',
  CATALOG_AVAILABILITY_URL: 'https://catalog.invalid/api/launch/availability',
  CATALOG_AVAILABILITY_SECRET_FILE: '/secret/writer',
  CATALOG_AVAILABILITY_MACHINE: 'pop-os',
  CATALOG_AVAILABILITY_MODELS_URL: 'https://gateway.invalid/v1/models',
  CATALOG_AVAILABILITY_MODELS_KEY_FILE: '/secret/reader',
  CATALOG_AVAILABILITY_HARNESS: 'claude-code',
  CATALOG_AVAILABILITY_MODEL_PREFIX: 'm',
  CATALOG_AVAILABILITY_MODEL_NAMESPACE: 'kiberos-go/',
}

const cfg = (over: Partial<CatalogAvailabilityConfig> = {}): CatalogAvailabilityConfig => ({
  ...readCatalogAvailabilityConfig(ENV),
  ...over,
})

const FILES: Record<string, string> = { '/secret/writer': 'writer-secret', '/secret/reader': 'reader-key' }
const readFile = (p: string) => {
  const v = FILES[p]
  if (v === undefined) throw new Error('ENOENT')
  return v
}

const modelsResponse = (ids: string[]) =>
  new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('настройки', () => {
  test('по умолчанию выключено и называет всё, чего не хватает', () => {
    const c = readCatalogAvailabilityConfig({})
    expect(c.enabled).toBe(false)
    expect(missingSettings(c)).toEqual([
      'CATALOG_AVAILABILITY_ENABLED',
      'CATALOG_AVAILABILITY_URL',
      'CATALOG_AVAILABILITY_SECRET_FILE',
      'CATALOG_AVAILABILITY_MACHINE',
      'CATALOG_AVAILABILITY_MODELS_KEY_FILE',
      'CATALOG_AVAILABILITY_MODEL_PREFIX',
      'CATALOG_AVAILABILITY_MODEL_NAMESPACE',
    ])
  })

  test('полный набор — недостающего нет', () => {
    expect(missingSettings(cfg())).toEqual([])
  })
})

describe('что не отправляется', () => {
  test('пустой список моделей — не снимок, а ложь', async () => {
    const r = await buildReport(cfg(), { fetchImpl: async () => modelsResponse([]), readFile })
    expect(r.report).toBeNull()
    expect(r.reason).toContain('empty')
  })

  test('отказ фронта — не отправляем', async () => {
    const r = await buildReport(cfg(), {
      fetchImpl: async () => new Response('{"error":"nope"}', { status: 401 }),
      readFile,
    })
    expect(r.report).toBeNull()
  })

  test('сеть не ответила — не отправляем', async () => {
    const r = await buildReport(cfg(), {
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      readFile,
    })
    expect(r.report).toBeNull()
  })

  test('префикс отсеял всё — не отправляем пустое', async () => {
    const r = await buildReport(cfg({ modelPrefix: 'kiberos-go/' }), {
      fetchImpl: async () => modelsResponse(['claude-opus-4-6']),
      readFile,
    })
    expect(r.report).toBeNull()
    expect(r.reason).toContain('prefix')
  })

  test('нет файла секрета — PUT не делается вовсе', async () => {
    let calls = 0
    const out = await sendAvailability(cfg({ secretFile: '/secret/missing' }), {
      fetchImpl: async () => { calls++; return modelsResponse(['m1']) },
      readFile,
    })
    // Первый вызов — чтение списка моделей; до PUT дело не дошло.
    expect(calls).toBe(1)
    expect(out.sent).toBe(false)
    expect(out.reason).toContain('secret')
  })
})

describe('снимок', () => {
  test('форма — ровно то, что принимает каталог', async () => {
    const r = await buildReport(cfg(), { fetchImpl: async () => modelsResponse(['m2', 'm1']), readFile, now: () => 0 })
    expect(r.report).toEqual({
      machine: 'pop-os',
      harnesses: [
        {
          harness: 'claude-code',
          version: undefined,
          models: [
            { model: 'kiberos-go/m2', ok: true, probedAt: '1970-01-01T00:00:00.000Z', detail: expect.stringContaining('not probed') },
            { model: 'kiberos-go/m1', ok: true, probedAt: '1970-01-01T00:00:00.000Z', detail: expect.stringContaining('not probed') },
          ],
        },
      ],
    })
  })

  test('«*» — осознанное «все модели этой программы»', async () => {
    const r = await buildReport(cfg({ modelPrefix: '*' }), {
      fetchImpl: async () => modelsResponse(['kiberos-go/flash', 'claude-opus-4-6']),
      readFile,
    })
    expect(r.report?.harnesses[0].models).toHaveLength(2)
  })

  test('несколько префиксов через запятую и пространство имён каталога', async () => {
    const r = await buildReport(cfg({ modelPrefix: 'deepseek-v4.1-flash-go,muse-spark' }), {
      fetchImpl: async () => modelsResponse(['deepseek-v4.1-flash-go', 'muse-spark-1.3-contributor', 'claude-opus-5']),
      readFile,
    })
    expect(r.report?.harnesses[0].models.map((m) => m.model)).toEqual([
      'kiberos-go/deepseek-v4.1-flash-go',
      'kiberos-go/muse-spark-1.3-contributor',
    ])
  })

  test('ok честно назван объявлением фронта, а не пробой', async () => {
    const r = await buildReport(cfg(), { fetchImpl: async () => modelsResponse(['m1']), readFile })
    expect(r.report?.harnesses[0].models[0].detail).toContain('listed by the gateway')
  })
})

describe('отправка', () => {
  const capture = () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return modelsResponse(['m1', 'm2'])
      seen.push({ url: String(url), init })
      return new Response('{"ok":true}', { status: 200 })
    }
    return { seen, fetchImpl }
  }

  test('кладёт снимок на дверь каталога с секретом писателя', async () => {
    const { seen, fetchImpl } = capture()
    const out = await sendAvailability(cfg(), { fetchImpl, readFile })
    expect(out.sent).toBe(true)
    expect(out.models).toBe(2)
    expect(seen).toHaveLength(1)
    expect(seen[0].init?.method).toBe('PUT')
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBe('Bearer writer-secret')
  })

  test('отказ двери — это «не отправлено», а не «отправлено и всё равно»', async () => {
    const fetchImpl = async (url: string) => {
      if (String(url).endsWith('/v1/models')) return modelsResponse(['m1'])
      return new Response('{"error":"launch_forbidden"}', { status: 403 })
    }
    const out = await sendAvailability(cfg(), { fetchImpl, readFile })
    expect(out.sent).toBe(false)
    expect(out.status).toBe(403)
  })

  test('секрет не попадает ни в причину отказа, ни в строку журнала', async () => {
    const lines: string[] = []
    const fetchImpl = async (url: string) => {
      if (String(url).endsWith('/v1/models')) return modelsResponse(['m1'])
      throw new Error('boom')
    }
    const out = await sendAvailability(cfg(), { fetchImpl, readFile })
    lines.push(String(out.reason))
    expect(lines.join(' ')).not.toContain('writer-secret')
    expect(lines.join(' ')).not.toContain('reader-key')
  })
})

describe('таймер', () => {
  test('выключенный флаг — таймера нет вовсе', () => {
    let calls = 0
    const stop = startCatalogAvailability(cfg({ enabled: false }), {
      fetchImpl: async () => { calls++; return modelsResponse(['m1']) },
      readFile,
      log: () => {},
    })
    stop()
    expect(calls).toBe(0)
  })

  test('включён, но недонастроен — говорит причину один раз и молчит', async () => {
    const lines: string[] = []
    const stop = startCatalogAvailability(cfg({ machine: null }), {
      fetchImpl: async () => { throw new Error('must not be called') },
      readFile,
      log: (l) => lines.push(l),
    })
    await Bun.sleep(5)
    stop()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('CATALOG_AVAILABILITY_MACHINE')
  })
})

describe('учётные данные писателя', () => {
  const FILES2: Record<string, string> = {
    '/secret/env': 'SYNQTASK_REPORTER_ID=abc-123\nSYNQTASK_REPORTER_SECRET=deadbeef\n',
    '/secret/raw': 'sk-raw-token\n',
    '/secret/empty': '\n',
    '/secret/reader': 'reader-key',
  }
  const read2 = (p: string) => {
    const v = FILES2[p]
    if (v === undefined) throw new Error('ENOENT')
    return v
  }
  const capture = () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return modelsResponse(['m1'])
      seen.push({ url: String(url), init })
      return new Response('{"ok":true}', { status: 200 })
    }
    return { seen, fetchImpl }
  }

  test('env-файл → два заголовка машинной учётки, Bearer не ставится', async () => {
    const { seen, fetchImpl } = capture()
    const out = await sendAvailability(cfg({ secretFile: '/secret/env' }), { fetchImpl, readFile: read2 })
    expect(out.sent).toBe(true)
    const h = seen[0].init?.headers as Record<string, string>
    expect(h['x-agent-id']).toBe('abc-123')
    expect(h['x-agent-secret']).toBe('deadbeef')
    expect(h.authorization).toBeUndefined()
  })

  test('готовая строка → Bearer, как было', async () => {
    const { seen, fetchImpl } = capture()
    await sendAvailability(cfg({ secretFile: '/secret/raw' }), { fetchImpl, readFile: read2 })
    const h = seen[0].init?.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer sk-raw-token')
    expect(h['x-agent-id']).toBeUndefined()
  })

  test('пустой файл — отказ, а не «отправим пустое»', async () => {
    const { seen, fetchImpl } = capture()
    const out = await sendAvailability(cfg({ secretFile: '/secret/empty' }), { fetchImpl, readFile: read2 })
    expect(out.sent).toBe(false)
    expect(seen).toHaveLength(0)
  })
})
