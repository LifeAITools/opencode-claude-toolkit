/**
 * plugin-v2 — вход `opencode-claude` под OpenCode 2.0 (`@opencode/plugin@2.0.27`).
 *
 * НАЗНАЧЕНИЕ: дать v2-вход, который ПЕРЕИСПОЛЬЗУЕТ v1-инициализацию целиком. Единственный
 * способ без правки `index.ts` — позвать v1-вход `server(input)`: он поднимает OAuth-менеджер
 * и возвращает объект хуков (включая `config` с 11 моделями). Этот объект мы адаптируем
 * под v2-домены: модели кладём в реестр v2, языковую модель отдаём через `ctx.aisdk`.
 *
 * 🔴 ФОРМЫ ИЗМЕРЕНЫ ЖИВЫМ ПРОГОНОМ 19.10, А НЕ ПРОЧИТАНЫ ПО ТИПАМ (обёртка в конфиге v2 +
 * изолированный HOME). У каждой двери своя форма, и они НЕ совпадают — две похожие двери
 * принимают разное, и неверная форма НЕ бросает, а молчит:
 *   - `ctx.tool.hook('execute.before', cb)`          — СТРОКА + колбэк;
 *   - `ctx.session.hook('compaction', cb)`           — СТРОКА + колбэк;
 *   - `ctx.provider.transform(cb)`                   — ТОЛЬКО колбэк (length=1);
 *   - `ctx.event.subscribe()`                        — AsyncIterable.
 * Ошибка формы здесь = «зарегистрировалось и молчит», не исключение.
 *
 * 🔴 ПОЧЕМУ МОДЕЛИ ОТДАЮТСЯ ЧЕРЕЗ `aisdk:` И `ctx.aisdk.hook`, А НЕ ЧЕРЕЗ НАТИВНЫЙ `file://`:
 * v2-загрузчик нативного пакета (`core/src/model-resolver.ts:234`) ждёт от `module.model()`
 * СВОЙ `LanguageModel` — объект `{id, provider, route}`, где `route` строит сам v2
 * (`core/src/aisdk.ts:366-433`). Наш провайдер отдаёт AI-SDK v3-модель
 * (`{specificationVersion, doGenerate, doStream}`) — это другой тип, и route к ней снаружи
 * не пристроить: `LanguageModel.update()` прочитает `route: undefined` и первый же ход упадёт.
 * Штатная дверь v2 для AI-SDK-провайдера — `ctx.aisdk.hook('sdk')` + `package: aisdk:<spec>`;
 * ядро само строит route и зовёт `sdk.languageModel(id)` (`core/src/aisdk.ts:345-355`).
 * Поэтому `model(modelID, settings)` (`provider.ts`) — тот же шов, но вызывается ИЗ ХУКА.
 *
 * 🔴 ПОЧЕМУ ПОСЛЕ `aisdk:` СТОИТ `file://…/provider.ts`, А НЕ КОРОТКОЕ ИМЯ:
 * встроенный `DynamicProviderPlugin` (`core/src/plugin/provider/dynamic.ts`) вешает СВОЙ
 * `aisdk.hook('sdk')` раньше нашего и для любого пакета делает `loadSDKFactory(npm, name)`.
 * На имени без схемы (`aisdk:claude-max`) он идёт в npm за пакетом `claude-max`, получает 404
 * и роняет весь вызов ДО нашего хука — снаружи это выглядело как
 * `Cannot initialize claude-max/…: 404 … registry.npmjs.org/claude-max`.
 * `loadSDKFactory` для `file://` импортирует файл напрямую и берёт первый экспорт на `create*`
 * — у нас это `createClaudeMax` (`core/src/plugin/provider/sdk-factory.ts:5-19`). Так пакет
 * грузится нашим же модулем, а наш хук затем подменяет sdk на собранный из `settings`.
 *
 * Что НЕ трогаем: `index.ts` и остальные файлы пакета (кроме `provider.ts` — там добавлен экспорт).
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import v1 from './index'
import { model as createClaudeMaxModel } from './provider'
import { registerV2Provider } from './v2-register'

/** id провайдера в каталоге v2; он же `-m <provider>/<model>`. */
const PROVIDER_ID = 'claude-max'

/**
 * Пакет провайдера для v2. `aisdk:` — не имя npm-модуля: префикс говорит ядру
 * «языковую модель отдаст плагин через `ctx.aisdk.hook('sdk')`» (`core/src/provider.ts:24-35`).
 */
const PACKAGE = `aisdk:${new URL('./provider.ts', import.meta.url).href}`

/** Куда пишем ошибки порта. Тот же файл, что и v1-журнал, — его не надо включать отдельно. */
const LOG_FILE = join(homedir(), '.claude', 'claude-max-debug.log')

function appendLog(line: string): void {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [v2] ${line}\n`)
  } catch {
    /* журнал не должен ломать порт */
  }
}

/** Ошибка регистрации обязана называть себя ВСЕГДА — прежний try/catch делал её невидимой. */
function v2error(line: string): void {
  appendLog(`ERROR ${line}`)
  console.error(`[opencode-claude/v2] ${line}`)
}

/** Успехи/диагностика — только по запросу, чтобы не засорять общий журнал. */
function v2dbg(line: string): void {
  if (process.env.OPENCODE_CLAUDE_V2_DEBUG !== '1' && !process.env.OPENCODE_CLAUDE_V2_DEBUG_FILE) return
  const extra = process.env.OPENCODE_CLAUDE_V2_DEBUG_FILE
  if (extra) {
    try { appendFileSync(extra, line + '\n') } catch { /* см. выше */ }
  }
  appendLog(line)
}

/** Какие поля v1-входа v2 может дать, а каких у него нет. */
function v1Input(ctx: any): Record<string, unknown> {
  return {
    directory: ctx?.location?.directory ?? process.cwd(),
    // v1 падает в env, если поля нет; sessionID у v2 в этом месте не приходит.
    sessionID: process.env.OPENCODE_SESSION_ID ?? undefined,
    // 🔴 `serverUrl` v2 НЕ отдаёт. В v1 он нужен ТОЛЬКО для косметического тоста
    // (`${serverUrl}/tui/toast`), и там стоит `if (_serverUrl)` — значит без него
    // инициализация идёт, тост просто не показывается. Это названная потеря, не ошибка.
    serverUrl: undefined,
  }
}

export default Plugin.define({
  id: 'opencode-claude-max',
  async setup(ctx: any) {
    const hooks: any = await (v1 as any).server(v1Input(ctx))

    // ── v1 `config` (инъекция провайдера через file://) → регистр провайдеров v2 ──────
    // v1-хук МУТИРУЕТ объект конфига; v2 даёт редактор реестра. Переводим одно в другое:
    // даём хуку временный конфиг, забираем то, что он добавил, и кладём в реестр.
    //
    // 🔴 ФОРМА РЕЕСТРА ИЗМЕРЕНА ЖИВЬЁМ 21.10 (обёртка в конфиге v2 + --print-logs):
    //   reg.add({ info, models: [...] })  — РАБОТАЕТ, модель потом разрешается по `-m <provider>/<model>`;
    //   reg.add({ provider: {...} })       — БРОСАЕТ `N.info.id` (у записи нет поля `info`);
    //   models ОБЪЕКТОМ (как у v1)          — БРОСАЕТ `e.map is not a function`: реестр ждёт МАССИВ.
    //
    // 🔴 И ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ ЛОВУШКИ: v1-хук асинхронный, а `provider.transform` — СИНХРОННЫЙ.
    // Поэтому конфиг считается ЗАРАНЕЕ, на `setup` (он async), а внутри transform остаётся
    // только синхронная запись в реестр.
    // 🔴 v1-хук НИЧЕГО НЕ ВОЗВРАЩАЕТ — он МУТИРУЕТ переданный объект.
    if (typeof hooks?.config === 'function') {
      const cfgSink: any = { provider: {} }
      await hooks.config(cfgSink)
      const entries = Object.entries((cfgSink.provider ?? {}) as Record<string, any>)

      ctx.provider.transform((reg: any) => {
        for (const [id, e] of entries) {
          // Вся арифметика и весь текст ошибок — в `v2-register.ts`, чтобы провал
          // регистрации проверялся испытанием, а не глазами в живом прогоне.
          registerV2Provider(reg, id, e, {
            packageName: PACKAGE,
            onError: v2error,
            onDebug: v2dbg,
          })
        }
      })
    } else {
      v2error('v1 hooks.config missing: provider could not be registered')
    }

    // ── Языковая модель: v2 → наш AI-SDK v3 провайдер ─────────────────────────────
    // Ядро зовёт `sdk.languageModel(modelID)` и оборачивает ответ в свой route
    // (`core/src/aisdk.ts:345-355`). `settings` — то, что v2 собрал для модели:
    // настройки провайдера + модели + варианта (см. `model()` в provider.ts).
    if (typeof ctx?.aisdk?.hook === 'function') {
      ctx.aisdk.hook('sdk', (event: any) => {
        const settings = (event?.options ?? {}) as Record<string, unknown>
        event.sdk = {
          languageModel: (modelID: string) => createClaudeMaxModel(modelID, settings),
        }
        v2dbg(`aisdk sdk handed over for ${event?.model?.providerID}/${event?.model?.modelID ?? event?.model?.id}`)
      }, { providerID: PROVIDER_ID })
    } else {
      v2error('ctx.aisdk.hook is unavailable: claude-max models cannot be served under v2')
    }

    // ── v1 `experimental.session.compacting` → session.hook('compaction') ────────────
    // [живьём] форма: session.hook('имя', колбэк); v2 отдаёт ОДНУ мутируемую структуру.
    if (typeof hooks?.['experimental.session.compacting'] === 'function') {
      await ctx.session.hook('compaction', async (h: any) => {
        const output = { context: Array.isArray(h?.context) ? h.context : [], prompt: h?.prompt }
        try {
          await hooks['experimental.session.compacting']({}, output)
        } catch { /* подсказки кэша — не повод ронять сжатие */ }
        if (Array.isArray(h?.context) && output.context.length) h.context.push(...output.context)
        if (typeof output.prompt === 'string' && output.prompt) h.prompt = output.prompt
      })
    }

    // ── v1 `event` → event.subscribe (AsyncIterable) ───────────────────────────────
    // В v1 это был no-op-диагностика; сохраняем, но без цикла-блокировки: цикл живёт
    // отдельно и не держит setup.
    if (typeof hooks?.event === 'function' && typeof ctx.event?.subscribe === 'function') {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe()) {
            try { await hooks.event({ event: ev }) } catch { /* диагностика не роняет ход */ }
          }
        } catch { /* поток событий закрылся */ }
      })()
    }

    return () => { /* у v1-входа нет отдельного cleanup — гасим только свои регистрации */ }
  },
})
