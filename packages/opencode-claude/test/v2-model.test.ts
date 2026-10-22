/**
 * v2-model — метаданные модели v1 → `Model.Info` OpenCode 2.0.27.
 *
 * Испытания закрепляют ровно те поля, из-за которых каталог v2 отвергал модель:
 * `enabled`, числовой `time.released`, `variants` массивом, `cost` массивом,
 * `capabilities.input/output` массивами строк. Плюс — что NaN не выходит ни при
 * каком входе (сортировка каталога на строке/NaN молча деградирует).
 */
import { describe, expect, test } from 'bun:test'
import {
  V2_DEFAULT_LIMIT,
  parseReleased,
  toV2Cost,
  toV2Model,
  toV2Provider,
  toV2Variants,
  type V1ModelLike,
} from '../v2-model'

/** Ровно та запись, которую v1-хук `config` кладёт в `config.provider['claude-max'].models`. */
const v1Sonnet5: V1ModelLike = {
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5 (Max)',
  api: { id: 'claude-sonnet-5', url: 'http://127.0.0.1:5050', npm: 'file:///x/provider.js' },
  providerID: 'claude-max',
  reasoning: true,
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: 'reasoning_content' },
  },
  cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  limit: { context: 1_000_000, output: 64_000 },
  status: 'active',
  options: {},
  headers: {},
  variants: {
    low: { thinking: { type: 'enabled', budgetTokens: 5000 } },
    medium: { thinking: { type: 'enabled', budgetTokens: 16000 } },
    high: { thinking: { type: 'enabled', budgetTokens: 32000 } },
  },
}

describe('toV2Model — обязательные поля схемы', () => {
  test('enabled: true — единственный фильтр каталога', () => {
    expect(toV2Model(v1Sonnet5, 'claude-max').enabled).toBe(true)
  })

  test('enabled: false уважается, но отсутствие поля = включена', () => {
    expect(toV2Model({ ...v1Sonnet5, enabled: false }, 'claude-max').enabled).toBe(false)
    expect(toV2Model({ id: 'x' }, 'p').enabled).toBe(true)
  })

  test('modelID и providerID заполнены рядом с id', () => {
    const model = toV2Model(v1Sonnet5, 'claude-max')
    expect(model.id).toBe('claude-sonnet-5')
    expect(model.modelID).toBe('claude-sonnet-5')
    expect(model.providerID).toBe('claude-max')
  })

  test('чужой providerID в v1-записи перекрывается аргументом', () => {
    expect(toV2Model({ ...v1Sonnet5, providerID: 'other' }, 'claude-max').providerID).toBe('claude-max')
  })

  test('status: active', () => {
    expect(toV2Model(v1Sonnet5, 'claude-max').status).toBe('active')
    expect(toV2Model({ id: 'x', status: 'weird' }, 'p').status).toBe('active')
    expect(toV2Model({ id: 'x', status: 'deprecated' }, 'p').status).toBe('deprecated')
  })

  test('limit: context/output — целые числа, дефолт схемы при отсутствии', () => {
    expect(toV2Model(v1Sonnet5, 'claude-max').limit).toEqual({ context: 1_000_000, output: 64_000 })
    expect(toV2Model({ id: 'x' }, 'p').limit).toEqual(V2_DEFAULT_LIMIT)
    expect(toV2Model({ id: 'x', limit: { context: 12.9, output: Number.NaN } }, 'p').limit).toEqual({
      context: 12,
      output: V2_DEFAULT_LIMIT.output,
    })
  })

  test('запись без id бросает — назвать её в журнале иначе нечем', () => {
    expect(() => toV2Model({ name: 'no id' }, 'p')).toThrow(/no string id/)
    expect(() => toV2Model({ id: '' }, 'p')).toThrow(/no string id/)
  })
})

describe('time.released — Schema.Finite, никогда NaN', () => {
  test('ISO-строка v1 → unix-ms числом', () => {
    const model = toV2Model({ id: 'x', time: { released: '2026-07-24T00:00:00.000Z' } }, 'p')
    expect(model.time.released).toBe(Date.parse('2026-07-24T00:00:00.000Z'))
    expect(typeof model.time.released).toBe('number')
  })

  test('нет поля → 0 (эталон v2 «не знаешь — ноль»)', () => {
    expect(toV2Model({ id: 'x' }, 'p').time.released).toBe(0)
    expect(toV2Model({ id: 'x', time: {} }, 'p').time.released).toBe(0)
  })

  test('мусор не даёт NaN', () => {
    for (const bad of ['not-a-date', '', Number.NaN, Number.POSITIVE_INFINITY, {}, [], null, undefined]) {
      const released = parseReleased(bad)
      expect(Number.isFinite(released)).toBe(true)
      expect(released).toBe(0)
    }
  })

  test('число переносится как есть, включая 0', () => {
    expect(parseReleased(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(parseReleased(0)).toBe(0)
  })
})

describe('variants — объект v1 → массив v2', () => {
  test('{low,medium,high} → [{id,settings.thinking}] в порядке объявления', () => {
    const variants = toV2Variants({
      low: { thinking: { type: 'enabled', budgetTokens: 5000 } },
      high: { thinking: { type: 'enabled', budgetTokens: 32000 } },
    })
    expect(variants).toEqual([
      { id: 'low', settings: { thinking: { type: 'enabled', budgetTokens: 5000 } } },
      { id: 'high', settings: { thinking: { type: 'enabled', budgetTokens: 32000 } } },
    ])
  })

  test('готовый массив v2 проходит без изменений формы', () => {
    expect(toV2Variants([{ id: 'high', settings: { thinking: { type: 'enabled', budgetTokens: 1 } } }])).toEqual([
      { id: 'high', settings: { thinking: { type: 'enabled', budgetTokens: 1 } } },
    ])
  })

  test('отсутствие вариантов → [] (валидно: модель без выбора)', () => {
    expect(toV2Variants(undefined)).toEqual([])
    expect(toV2Model({ id: 'x' }, 'p').variants).toEqual([])
  })

  test('вариант без id отбрасывается, а не превращается в мусор', () => {
    expect(toV2Variants([{ settings: { a: 1 } }])).toEqual([])
  })
})

describe('cost — объект v1 → массив Cost', () => {
  test('{input,output,cache} → [{input,output,cache}]', () => {
    expect(toV2Cost({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toEqual([
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    ])
  })

  test('нет cost → [] (стоимость 0, валидно по схеме)', () => {
    expect(toV2Model({ id: 'x' }, 'p').cost).toEqual([])
  })

  test('нечисловые значения → 0, не NaN', () => {
    const [cost] = toV2Cost({ input: 'x', output: null, cache: { read: Number.NaN, write: 2 } })
    expect(cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 2 } })
  })
})

describe('capabilities — {tools, input[], output[]}', () => {
  test('toolcall → tools, modalities → массивы строк', () => {
    const model = toV2Model(v1Sonnet5, 'claude-max')
    expect(model.capabilities).toEqual({
      tools: true,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
    })
  })

  test('без modalities массив собирается из true-флагов capabilities', () => {
    const model = toV2Model(
      {
        id: 'x',
        capabilities: {
          input: { text: true, image: false, pdf: true },
          output: { text: true },
        },
      },
      'p',
    )
    expect(model.capabilities).toEqual({ tools: true, input: ['text', 'pdf'], output: ['text'] })
  })

  test('v1 toolcall:false → tools:false; неизвестно → tools:true', () => {
    expect(toV2Model({ id: 'x', capabilities: { toolcall: false } }, 'p').capabilities.tools).toBe(false)
    expect(toV2Model({ id: 'x' }, 'p').capabilities.tools).toBe(true)
  })

  test('ничего не известно → дефолт схемы v2 [text,image]/[text]', () => {
    expect(toV2Model({ id: 'x' }, 'p').capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
    })
  })
})

describe('остальные поля', () => {
  test('options → settings, пустой объект не переносится', () => {
    expect(toV2Model({ id: 'x', options: { keepalive: false } }, 'p').settings).toEqual({ keepalive: false })
    expect(toV2Model({ id: 'x', options: {} }, 'p').settings).toBeUndefined()
  })

  test('headers переносятся, пустые — нет', () => {
    expect(toV2Model({ id: 'x', headers: { a: 'b', n: 1 } }, 'p').headers).toEqual({ a: 'b' })
    expect(toV2Model({ id: 'x', headers: {} }, 'p').headers).toBeUndefined()
  })

  test('interleaved.field → compatibility.reasoningField; его отсутствие поля не создаёт', () => {
    const model = toV2Model(v1Sonnet5, 'claude-max')
    expect(model.compatibility).toEqual({ reasoningField: 'reasoning_content' })
    expect(toV2Model({ id: 'x' }, 'p').compatibility).toBeUndefined()
  })

  test('поля, которых в Model.Info нет, наружу не выходят', () => {
    const model = toV2Model(v1Sonnet5, 'claude-max') as Record<string, unknown>
    for (const gone of ['api', 'reasoning', 'modalities', 'options']) {
      expect(model[gone]).toBeUndefined()
    }
  })

  test('сериализуется в JSON без потерь (никаких branded-объектов)', () => {
    const model = toV2Model(v1Sonnet5, 'claude-max')
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })
})

describe('toV2Provider — Provider.Info', () => {
  const v1Provider = {
    id: 'claude-max',
    name: 'Claude Max/Pro',
    api: 'http://127.0.0.1:5050',
    npm: 'file:///x/provider.js',
    env: [],
    models: {},
  }

  test('activation auto, name, package', () => {
    expect(toV2Provider(v1Provider)).toEqual({
      id: 'claude-max',
      name: 'Claude Max/Pro',
      activation: 'auto',
      package: 'file:///x/provider.js',
      settings: { baseURL: 'http://127.0.0.1:5050' },
    })
  })

  test('адрес двери уходит в settings.baseURL, а не остаётся полем api', () => {
    const info = toV2Provider(v1Provider) as Record<string, unknown>
    expect(info.api).toBeUndefined()
    expect((info.settings as Record<string, unknown>).baseURL).toBe('http://127.0.0.1:5050')
  })

  test('package можно переопределить (aisdk: путь)', () => {
    expect(toV2Provider(v1Provider, { package: 'aisdk:claude-max' }).package).toBe('aisdk:claude-max')
  })

  test('без package провайдер не регистрируется — это обязательное поле', () => {
    expect(() => toV2Provider({ id: 'x', name: 'X' })).toThrow(/no package/)
  })
})
