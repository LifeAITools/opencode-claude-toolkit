/**
 * Проба: входит ли хвост cc_version в billing-header в ключ кэша Anthropic?
 *
 * Три запроса через локальный прокси, тела совпадают байт в байт, кроме хвоста в system[0]:
 *   1) хвост A  — пишет кэш (ожидаем cache_creation > 0)
 *   2) хвост B  — если cache_read > 0, строка В КЛЮЧ НЕ ВХОДИТ; если 0 и снова запись — входит
 *   3) хвост A  — контроль: обязан прочитать (иначе проба ничего не доказывает)
 * Модель дешёвая, тело ~6k токенов: расход пренебрежимо мал. Секреты не печатаются.
 *   bun scripts/probe-billing-tail-cache-key.ts [http://127.0.0.1:5050]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5050'
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-5-5'
const stamp = Date.now().toString(36)
const filler = Array.from({ length: 700 }, (_, i) => `Правило ${i} пробы ${stamp}: держи ответ коротким и точным.`).join('\n')

const body = (tail: string) => JSON.stringify({
  model: MODEL, max_tokens: 8,
  system: [
    { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.296.${tail}; cc_entrypoint=cli;` },
    { type: 'text', text: filler, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ],
  messages: [{ role: 'user', content: 'ответь одним словом: ок' }],
})

async function call(label: string, tail: string) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': `probe-tail-${stamp}`,
    },
    body: body(tail),
  })
  const j: any = await res.json().catch(() => ({}))
  const u = j.usage ?? {}
  console.log(label.padEnd(10), 'tail=' + tail, 'http=' + res.status,
    'cache_creation=' + (u.cache_creation_input_tokens ?? 'n/a'), 'cache_read=' + (u.cache_read_input_tokens ?? 'n/a'),
    'input=' + (u.input_tokens ?? 'n/a'), j.error ? 'error=' + JSON.stringify(j.error).slice(0, 160) : '')
  return u
}

const a1 = await call('1 write', 'aaa')
const b = await call('2 other', 'bbb')
const a2 = await call('3 control', 'aaa')

const wrote = (a1.cache_creation_input_tokens ?? 0) > 0
const control = (a2.cache_read_input_tokens ?? 0) > 0
const otherRead = (b.cache_read_input_tokens ?? 0) > 0
console.log('\nverdict:',
  !wrote ? 'ПРОБА НЕ СРАБОТАЛА: первый запрос не записал кэш'
  : !control ? 'ПРОБА НЕ ДОКАЗЫВАЕТ: контроль с тем же хвостом не прочитал кэш'
  : otherRead ? 'хвост НЕ входит в ключ кэша (другой хвост прочитал чужую запись)'
  : 'хвост ВХОДИТ в ключ кэша (другой хвост не прочитал, тот же прочитал)')
