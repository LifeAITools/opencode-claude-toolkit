/**
 * opencode-go-quota: квота Go в форме quota-status.json (provider:"opencode-go").
 * Числа — из двери реестра kiberos-app (`go_refresher.py status --json`): берётся
 * АКТИВНАЯ организация, не та, чей ключ в auth.json. Форма usage — как у поставщика
 * (percent — целый израсходованный, resetsAt ISO).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  accountHintFor,
  buildGoQuotaStatus,
  collectOnce,
  goSubscriptionModels,
  litellmGoAliases,
  readGoKey,
  readGoRegistry,
} from '../src/opencode-go-quota.js'

const AT = new Date('2026-10-07T12:00:00Z')
const LIVE = {
  rolling: { status: 'ok', percent: 11, resetsAt: '2026-10-07T15:40:49.000Z' },
  weekly: { status: 'ok', percent: 53, resetsAt: '2026-10-12T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 26, resetsAt: '2026-11-05T12:27:21.000Z' },
}

const okFetch = (body: unknown) => (async () => ({
  ok: true, status: 200, json: async () => body,
})) as any

describe('построение файла из usage активной организации', () => {
  test('percent целый → доля; message называет организацию', () => {
    const s: any = buildGoQuotaStatus({
      usage: LIVE, error: null, org: 'console-berezovskaya',
      activeOrg: { name: 'console-berezovskaya', sources: { registry: 'console-berezovskaya', accountState: 'console-berezovskaya' }, reason: 'agreed' },
      accountHint: 'console-berezovskaya', models: [], modelsSource: '', measuredAt: AT,
    })
    const a = s.accounts['console-berezovskaya']
    expect(a.util5h).toBe(0.11)
    expect(a.util7d).toBe(0.53)
    expect(a.utilMonth).toBe(0.26)
    expect(a.org).toBe('console-berezovskaya')
    expect(a.active).toBe(true)
    expect(s.org).toBe('console-berezovskaya')
    expect(a.windows.map((w: any) => w.window)).toEqual(['5h', 'week', 'month'])
    // message — то, что видит человек: percent 11/53/26, НЕ 1100/5300/2600 (двойное ×100),
    // и названа организация, которую обслуживает посредник.
    expect(a.message).toBe('opencode-go (console-berezovskaya, активна): 5h 11%, week 53%, month 26%.')
  })

  test('percent клампится, кривой сброс — null', () => {
    const s: any = buildGoQuotaStatus({
      usage: { rolling: { status: 'capped', percent: 137, resetsAt: 'nope' } },
      error: null, org: 'x', activeOrg: { name: null, sources: { registry: null, accountState: null }, reason: 'account_state_unreadable' },
      accountHint: 'x', models: [], modelsSource: '', measuredAt: AT,
    })
    expect(s.accounts.x.util5h).toBe(1)
    expect(s.accounts.x.windows[0].status).toBe('capped')
    expect(s.accounts.x.windows[0].resetAt).toBeNull()
    // Сверки нет → это ЗАЯВЛЕННОЕ «неизвестно», а не «не активна» (22.10).
    expect(s.accounts.x.message).toContain('активность не подтверждена')
  })

  test('нет usage — названное отсутствие, accounts пусто', () => {
    const s: any = buildGoQuotaStatus({
      usage: null, error: 'go_refresher_unavailable: x', org: 'unknown', active: false,
      accountHint: 'h', models: ['m'], modelsSource: '', measuredAt: AT,
    })
    expect(s.error).toBe('go_refresher_unavailable: x')
    expect(s.accounts).toEqual({})
  })

  test('отпечаток не содержит ключа', () => {
    expect(accountHintFor('sk-SECRET')).not.toContain('SECRET')
  })
})

describe('дверь реестра kiberos-app', () => {
  test('читает active и окна каждой организации', async () => {
    const body = JSON.stringify({
      active: 'console-berezovskaya',
      measured_at_ms: AT.getTime(),
      orgs: [
        { name: 'console-berezovskaya', active: true, usage: LIVE, exhausted: [] },
        { name: 'apikey-founder', active: false, usage: { weekly: { status: 'rate-limited', percent: 100 } }, exhausted: ['weekly'] },
      ],
    })
    const runner = (async () => ({ code: 0, stdout: body, stderr: '' })) as any
    const { registry, error } = await readGoRegistry('/door.py', runner)
    expect(error).toBeNull()
    expect(registry?.active).toBe('console-berezovskaya')
    expect(registry?.orgs.length).toBe(2)
    expect(registry?.orgs[1].exhausted).toEqual(['weekly'])
  })

  test('дверь упала — названная причина, не догадка', async () => {
    const runner = (async () => ({ code: 2, stdout: '', stderr: 'boom' })) as any
    expect((await readGoRegistry('/door.py', runner)).error).toBe('go_refresher_exit_2')
  })

  // 🔴 ЗАМЕР 24.10.2026: в момент заведения новой организации дверь напечатала русскую строку
  // журнала в тот же stdout, что и JSON. Разбор целого упал на «Unrecognized token 'о'», отчёт
  // записался БЕЗ `orgs` (пятнадцать организаций стали нулём), и выбиратель на рождении получил
  // «выбирать нечего» — свежая организация молча пропущена, ошибки не видит никто.
  test('журнальная строка рядом с JSON не обнуляет реестр, но и не проглатывается', async () => {
    const body = JSON.stringify({
      active: 'hello@foody7.com',
      measured_at_ms: AT.getTime(),
      orgs: [{ name: 'hello@foody7.com', active: true, usage: LIVE, exhausted: [] }],
    })
    const noisy = `завожу новую организацию hello@mailclowd.com\n${body}`
    const runner = (async () => ({ code: 0, stdout: noisy, stderr: '' })) as any
    const { registry, error } = await readGoRegistry('/door.py', runner)
    expect(registry?.orgs.length).toBe(1)
    expect(registry?.orgs[0].name).toBe('hello@foody7.com')
    expect(error).toContain('go_refresher_noisy_stdout')
    expect(error).toContain('завожу новую организацию')
  })

  test('в выводе нет объекта вовсе — ошибка называет, что именно пришло', async () => {
    const runner = (async () => ({ code: 0, stdout: 'ошибка: реестр не прочитан', stderr: '' })) as any
    const { registry, error } = await readGoRegistry('/door.py', runner)
    expect(registry).toBeNull()
    expect(error).toContain('no JSON object in door output')
    expect(error).toContain('ошибка')
  })
})

describe('чьи модели', () => {
  test('подписка: id с приставкой opencode-go/', async () => {
    const models = okFetch({ data: [{ id: 'muse-spark-1.3-contributor' }, { id: 7 }] })
    const r = await goSubscriptionModels('K', models)
    expect(r.models).toEqual(['opencode-go/muse-spark-1.3-contributor'])
  })

  test('алиасы LiteLLM — по api_base, не по имени', () => {
    const cfg = {
      model_list: [
        { model_name: 'muse-spark-1.3-contributor', litellm_params: { api_base: 'https://opencode.ai/zen/go/v1' } },
        { model_name: 'deepseek-v4.1-flash-go', litellm_params: { api_base: 'https://opencode.ai/zen/go/v1/chat' } },
        { model_name: 'deepseek-v4.1-flash', litellm_params: { api_base: 'https://dashscope.aliyuncs.com/x' } },
        { model_name: 'plain', litellm_params: {} },
      ],
    }
    // Голое deepseek-имя на DashScope — НЕ берём (ловушка из поручения).
    expect(litellmGoAliases(cfg).sort()).toEqual(['deepseek-v4.1-flash-go', 'muse-spark-1.3-contributor'])
    expect(litellmGoAliases({})).toEqual([])
  })

  test('алиасы LiteLLM — и по litellm_credential_name (наши kiberos-app), без api_base', () => {
    const cfg = {
      model_list: [
        { model_name: 'deepseek-v4.1-flash-go', litellm_params: { litellm_credential_name: 'opencode-go-active' } },
        { model_name: 'muse-spark-1.3-contributor', litellm_params: { litellm_credential_name: 'opencode-go-active' } },
        { model_name: 'muse-spark-1.3-contributor', litellm_params: { litellm_credential_name: 'other-cred' } },
        { model_name: 'deepseek-v4.1-flash', litellm_params: { litellm_credential_name: 'dashscope' } },
      ],
    }
    // Наш go-алиас несёт litellm_credential_name (api_base нельзя — у орг РАЗНЫЕ базы).
    expect(litellmGoAliases(cfg).sort()).toEqual(['deepseek-v4.1-flash-go', 'muse-spark-1.3-contributor'])
  })
})

describe('сборка целиком (без сети)', () => {
  test('берётся АКТИВНАЯ организация, файл пишется атомарно', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-goq-'))
    try {
      const auth = join(dir, 'auth.json')
      writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'K' } }))
      const out = join(dir, 'quota-status-opencode-go.json')
      const body = JSON.stringify({
        active: 'console-berezovskaya',
        measured_at_ms: AT.getTime(),
        orgs: [
          { name: 'apikey-founder', active: false, usage: { weekly: { status: 'rate-limited', percent: 100 } }, exhausted: ['weekly'] },
          { name: 'console-berezovskaya', active: true, usage: LIVE, exhausted: [] },
        ],
      })
      const runner = (async () => ({ code: 0, stdout: body, stderr: '' })) as any
      const fetchFn = okFetch({ data: [{ id: 'm' }] })
      const s: any = await collectOnce({
        authJsonPath: auth, litellmConfigPath: join(dir, 'nope.yaml'),
        goRefresherPath: '/door.py', outPath: out, fetcher: fetchFn, runner, now: () => AT,
        // Базы нет → пара не подтверждена. Испытание не должно читать ЖИВУЮ базу opencode.
        dbPath: join(dir, 'opencode.db'),
      })
      expect(s.provider).toBe('opencode-go')
      expect(s.org).toBe('console-berezovskaya')
      expect(s.active).toBeNull()
      expect(s.activeReason).toBe('account_state_unreadable')
      const onDisk = JSON.parse(readFileSync(out, 'utf8'))
      expect(onDisk.org).toBe('console-berezovskaya')
      expect(Object.keys(onDisk.accounts)).toEqual(['console-berezovskaya'])
      expect(onDisk.accounts['console-berezovskaya'].util7d).toBe(0.53)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readGoKey терпит отсутствие файла', () => {
    expect(readGoKey('/nonexistent/auth.json')).toBeNull()
  })
})

describe('мост имя→uid (member.orgUid ↔ orgs[])', () => {
  test('uid проставляется по имени; имя вне карты — поля нет', () => {
    const s: any = buildGoQuotaStatus({
      usage: LIVE, error: null, org: 'console-berezovskaya', active: true,
      accountHint: 'console-berezovskaya', models: [], modelsSource: '', measuredAt: AT,
      orgs: [
        { name: 'console-berezovskaya', active: true, usage: LIVE },
        { name: 'unknown-org', active: false, usage: LIVE },
      ],
      orgUids: { 'console-berezovskaya': '5dfa97f6-84bd-4d5e-b1fc-9755d13ef4e8' },
    })
    expect(s.orgs[0].uid).toBe('5dfa97f6-84bd-4d5e-b1fc-9755d13ef4e8')
    // Нет в карте — НЕ выдумываем uid (потребитель тогда падает на прежний выбор).
    expect('uid' in s.orgs[1]).toBe(false)
  })

  test('карты нет вовсе → uid нет ни у кого', () => {
    const s: any = buildGoQuotaStatus({
      usage: LIVE, error: null, org: 'x', active: true,
      accountHint: 'x', models: [], modelsSource: '', measuredAt: AT,
      orgs: [{ name: 'x', active: true, usage: LIVE }],
    })
    expect('uid' in s.orgs[0]).toBe(false)
  })
})

describe('статус и модельная привязка организации (FR-1/FR-18) — их читает пускатель', () => {
  const mk = (org: any) => buildGoQuotaStatus({
    usage: LIVE, error: null, org: 'a', active: true,
    accountHint: 'a', models: [], modelsSource: '', measuredAt: AT, orgs: [org],
  }) as any

  test('нет статуса в реестре → организация active (отсутствие не выдумываем в запрет)', () => {
    expect(mk({ name: 'a', active: true, usage: LIVE }).orgs[0].status).toBe('active')
  })

  test('restricted с причиной доезжает до отчёта', () => {
    const o = mk({
      name: 'a', active: true, usage: LIVE,
      status: 'restricted', restricted_reason: 'дорого в этом окне',
    }).orgs[0]
    expect(o.status).toBe('restricted')
    expect(o.restrictedReason).toBe('дорого в этом окне')
  })

  test('модельная привязка доезжает; её отсутствие — поля НЕТ, а не пустой список', () => {
    expect(mk({ name: 'a', active: true, usage: LIVE, models: ['opencode-go/x'] }).orgs[0].models)
      .toEqual(['opencode-go/x'])
    expect('models' in mk({ name: 'a', active: true, usage: LIVE }).orgs[0]).toBe(false)
  })

  test('причина без restricted не выводится (иначе поле читалось бы как запрет)', () => {
    const o = mk({ name: 'a', active: true, usage: LIVE, restricted_reason: 'просто так' }).orgs[0]
    expect(o.status).toBe('active')
    expect('restrictedReason' in o).toBe(false)
  })

  // Просьба home-relishev-general 22.10: организация, вошедшая в opencode без пропуска в
  // хранилище, раньше читалась как «окон нет» — неотличимо от «ещё не измерена». Агент падал
  // отказом, а причина не была видна НИКОМУ. Теперь она в отчёте прямым словом.
  test('организация console без пропуска помечена `credential: no_token` — это не «окон нет»', () => {
    const o = mk({ name: 'hello@sealform.dev', auth: 'console', active: false, usage: {} }).orgs[0]
    expect(o.credential).toBe('no_token')
  })

  test('организация С пропуском поля не несёт — молчание не читается как «сломано»', () => {
    const o = mk({ name: 'a', auth: 'console', active: true, usage: LIVE, expires_at_ms: 1794551455059 }).orgs[0]
    expect('credential' in o).toBe(false)
  })

  test('организация на ключе API без жалоб поля не несёт: у неё срока нет по устройству', () => {
    const o = mk({ name: 'a', auth: 'api_key', active: true, usage: LIVE }).orgs[0]
    expect('credential' in o).toBe(false)
  })

  // Вторая половина того же молчания: пропуск ЕСТЬ, а поставщик его отвергает. Замер 22.10 —
  // `relishev@gmail.com`, api_key_expired: организация непригодна, а отчёт говорил «окон нет».
  test('отвергнутый ключ/пропуск назван `credential: rejected`, а не выдан за «окон нет»', () => {
    const o = mk({ name: 'a', auth: 'api_key', active: false, usage: {},
      usage_error: 'отказ 401 / authentication_error: {"code":"api_key_expired"}' }).orgs[0]
    expect(o.credential).toBe('rejected')
  })

  test('отказ 401 у console-организации тоже назван — причина та же, дверь другая', () => {
    const o = mk({ name: 'a', auth: 'console', active: false, expires_at_ms: 1794551455059, usage: {},
      usage_error: 'отказ 401 / AuthError: Unauthorized' }).orgs[0]
    expect(o.credential).toBe('rejected')
  })
})
