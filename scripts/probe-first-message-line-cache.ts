/**
 * Проба: меняет ли разная строка в messages[0].content[1] (напр. «Claude Opus 5.5 (1M context)»
 * против «Claude Opus 5.5») ключ кэша, если метка кэша стоит ПОСЛЕ неё (как у боевых помощников).
 *
 *   1) строка A — пишет кэш;  2) строка B — чтение (строка не в ключе) или запись (в ключе);
 *   3) строка A — контроль: обязан прочитать.
 *   bun scripts/probe-first-message-line-cache.ts [http://127.0.0.1:5050]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5050'
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-5-5'
const stamp = Date.now().toString(36)
const rules = Array.from({ length: 700 }, (_, i) => `Правило ${i} пробы ${stamp}: держи ответ коротким и точным.`).join('\n')

const body = (line: string) => JSON.stringify({
  model: MODEL, max_tokens: 8,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.aaa; cc_entrypoint=cli;' },
           { type: 'text', text: 'Ты помощник пробы.' }],
  messages: [{ role: 'user', content: [
    { type: 'text', text: `<system-reminder>\n${rules}\n</system-reminder>` },
    { type: 'text', text: `Co-Authored-By: ${line} <noreply@anthropic.com>`, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ] }],
})

async function call(label: string, line: string) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': `probe-line-${stamp}` },
    body: body(line),
  })
  const j: any = await res.json().catch(() => ({}))
  const u = j.usage ?? {}
  console.log(label.padEnd(10), 'http=' + res.status, 'cache_creation=' + (u.cache_creation_input_tokens ?? 'n/a'),
    'cache_read=' + (u.cache_read_input_tokens ?? 'n/a'), j.error ? JSON.stringify(j.error).slice(0, 160) : '')
  return u
}
const a1 = await call('1 write', 'Claude Opus 5.5 (1M context)')
const b = await call('2 other', 'Claude Opus 5.5')
const a2 = await call('3 control', 'Claude Opus 5.5 (1M context)')
const wrote = (a1.cache_creation_input_tokens ?? 0) > 0
const control = (a2.cache_read_input_tokens ?? 0) > 0
console.log('\nverdict:', !wrote ? 'ПРОБА НЕ СРАБОТАЛА: нет первой записи'
  : !control ? 'ПРОБА НЕ ДОКАЗЫВАЕТ: контроль не прочитал'
  : (b.cache_read_input_tokens ?? 0) > 0 ? 'строка НЕ входит в ключ (другая строка прочитала кэш)'
  : 'строка ВХОДИТ в ключ: другая строка = холодная запись')
