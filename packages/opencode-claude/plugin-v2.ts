/**
 * plugin-v2 — вход `opencode-claude` под OpenCode 2.0 (`@opencode/plugin@2.0.27`).
 *
 * НАЗНАЧЕНИЕ: дать v2-вход, который ПЕРЕИСПОЛЬЗУЕТ v1-инициализацию целиком. Единственный
 * способ без правки `index.ts` — позвать v1-вход `server(input)`: он поднимает embedded
 * keepalive-движок, OAuth-менеджер и провайдер через `file://` и ВОЗВРАЩАЕТ объект хуков.
 * Этот объект мы адаптируем под v2-домены.
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
 * Что НЕ трогаем: `index.ts`, `provider.ts` и прочие файлы пакета.
 */
import { Plugin } from '@opencode/plugin'
import v1 from './index'

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

function v2dbg(line: string): void {
  const f = process.env.OPENCODE_CLAUDE_V2_DEBUG_FILE
  if (!f) return
  try { require('node:fs').appendFileSync(f, line + '\n') } catch { /* журнал не должен ломать порт */ }
}

export default Plugin.define({
  id: 'opencode-claude-max',
  async setup(ctx: any) {
    const hooks: any = await (v1 as any).server(v1Input(ctx))

    // ── v1 `config` (инъекция провайдера через file://) → регистр провайдеров v2 ──────
    // v1-хук МУТИРУЕТ объект конфига; v2 даёт редактор реестра. Переводим одно в другое:
    // даём хуку временный конфиг, забираем то, что он добавил, и кладём в реестр.
    // [типы] форма записи реестра снята живьём: reg.add({ provider: { id, name, ... } }).
    if (typeof hooks?.config === 'function') {
      // 🔴 ФОРМА РЕЕСТРА ИЗМЕРЕНА ЖИВЬЁМ 21.10 (обёртка в конфиге v2 + --print-logs):
      //   reg.add({ info, models: [...] })  — РАБОТАЕТ, модель потом разрешается по `-m <provider>/<model>`;
      //   reg.add({ provider: {...} })       — БРОСАЕТ `N.info.id` (у записи нет поля `info`);
      //   models ОБЪЕКТОМ (как у v1)          — БРОСАЕТ `e.map is not a function`: реестр ждёт МАССИВ.
      // Прежняя форма падала в try/catch, и «11 моделей зарегистрировано» в журнале v1 означало
      // регистрацию В СВОЙ временный объект, а не в реестр v2 — модель оставалась недоступной.
      //
      // 🔴 И ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ ЛОВУШКИ: v1-хук асинхронный, а `provider.transform` — СИНХРОННЫЙ.
      // Раньше `reg.add` стоял в `.then(...)`, то есть регистрация происходила ПОСЛЕ того, как
      // opencode уже разрешил модель, — и добавка не успевала. Поэтому конфиг считается ЗАРАНЕЕ,
      // на `setup` (он async), а внутри transform остаётся только синхронная запись в реестр.
      // 🔴 v1-хук НИЧЕГО НЕ ВОЗВРАЩАЕТ — он МУТИРУЕТ переданный объект. Взять `return` значит
      // получить `undefined` и зарегистрировать ноль моделей, при том что журнал v1 бодро скажет
      // «11 моделей зарегистрировано»: он писал в СВОЙ объект, а мы читали чужой ответ.
      const cfgSink: any = { provider: {} }
      await hooks.config(cfgSink)
      const entries = Object.entries((cfgSink.provider ?? {}) as Record<string, any>)
      ctx.provider.transform((reg: any) => {
        for (const [id, e] of entries) {
          // v1 кладёт адрес двери в `api`, пакет — в `npm`; v2 ждёт `settings.baseURL` и `package`.
          const info = {
            id,
            name: e?.name ?? id,
            activation: 'auto' as const,
            ...(e?.npm ? { package: e.npm } : {}),
            ...(e?.api ? { settings: { baseURL: e.api } } : {}),
          }
          // 🔴 v2 читает `model.time.released` при построении модели — у v1-записи этого поля нет,
          // и без него падение уже ПОСЛЕ разрешения по имени (`rH.time.released`), то есть выглядит
          // как поломка провайдера, а не как недостающее поле метаданных.
          const released = new Date(0).toISOString()
          const models = (Object.values(e?.models ?? {}) as any[]).map((m) => ({
            ...m,
            time: (m as any)?.time ?? { released },
          }))
          try {
            reg.add({ info, models })
            v2dbg(`add ok ${id} models=${models.length} first=${models[0]?.id ?? '-'}`)
          } catch (err: any) {
            v2dbg(`add failed ${id}: ${err?.message ?? err}`)
            // transform вызывается на каждого провайдера, а setup — один раз: второй проход обновляет.
            try { reg.update({ info, models }); v2dbg(`update ok ${id}`) } catch (e2: any) { v2dbg(`update failed ${id}: ${e2?.message ?? e2}`) }
          }
        }
      })
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
