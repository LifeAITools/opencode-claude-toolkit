/**
 * plugin-v2 — черновик входа под OpenCode 2.0 (`@opencode/plugin@2.0.27`).
 *
 * Назначение: дать v2-вход, который ПЕРЕИСПОЛЬЗУЕТ v1-инициализацию целиком, а не
 * повторяет её. Единственный способ сделать это без правки `plugin.ts` — позвать
 * v1-вход `server(input)`: он выполняет bootstrap идентичности, поднимает приёмник
 * побудок (wake-listener) и наблюдатель квоты (quota-watcher) и ВОЗВРАЩАЕТ объект
 * хуков, замкнутый на своё состояние (signalWire, boundSessionId, wakeHandle,
 * quotaHandle). Этот объект мы адаптируем под v2-домены.
 *
 * Что НЕ трогаем: `plugin.ts`, `signal-wire.ts`, `index.ts` и прочие файлы пакета.
 *
 * Точная форма v2 взята из `@opencode/plugin@2.0.27`
 * (`dist/promise/{plugin,session,tool,event,registration}.d.ts` и `adapter.js`):
 *   - вход: `define({ id, setup(ctx) { ...; return cleanup } })`;
 *   - `ctx.event.subscribe(options?)` → AsyncIterable<V2Event> (НЕ `(name, cb)`);
 *   - `ctx.session.hook(name, cb)` → одна мутируемая структура (НЕ `(input, output)`);
 *   - `ctx.tool.hook(name, cb)` → одна мутируемая структура (НЕ `(input, output)`);
 *   - `ctx.tool.transform(cb)` → cb получает ToolEditor, cb СИНХРОННЫЙ.
 */

import { Plugin } from '@opencode/plugin'
import v1Plugin from './plugin'

/**
 * Объект хуков, который возвращает v1-вход. Поля совпадают с ключами v1-входа;
 * сигнатуры намеренно `any` — v1 отдаёт нетипизированный объект (все коллбэки
 * объявлены с `input: any, output: any`).
 */
interface V1Hooks {
  event: (arg: { event: any }) => Promise<void>
  'experimental.session.compacting': (input: any, output: any) => Promise<void>
  'experimental.chat.system.transform': (input: any, output: any) => Promise<void>
  'tool.definition': (input: any, output: any) => Promise<void>
  'chat.message': (input: any, output: any) => Promise<void>
  'tool.execute.before': (input: any, output: any) => Promise<void>
  'tool.execute.after': (input: any, output: any) => Promise<void>
}

/**
 * Собрать `input`, который ждёт v1-вход `server(input)`.
 *
 * v1 читает: `directory`, `sessionID`, `serverUrl`, `client`. В v2-домене `ctx`
 * прямого `client` нет — есть домены. Отсюда шим.
 *
 * ⚠ UNCERTAIN: соответствие `ctx` → v1 `input` не подтверждено живым запуском.
 * ⚠ UNCERTAIN: `ctx.options` — `Record<string, any>`; имена `sessionID`/`serverUrl`
 *   внутри него взяты по аналогии с v1 и могут называться иначе.
 * ⚠ UNCERTAIN: `input.client.session.list` у v2-домена `ctx.session` ОТСУТСТВУЕТ
 *   (SessionDomain = Pick<..., "create"|"get"|"prompt"|...>, без `list`), поэтому
 *   v1-путь `findNewSessionByDirectory` (привязка сессии ретраями) в v2 не имеет
 *   источника. Шим `list` не выставлен намеренно — не выдумываем то, чего нет.
 * ⚠ UNCERTAIN: `ctx.session.prompt` в v2 принимает другую форму аргументов, чем
 *   `client.session.prompt({ path, body })` в v1 (используется на досылке continue).
 */
function buildV1Input(ctx: Plugin.Context): any {
  const directory = (ctx.location as any)?.directory ?? process.cwd()
  const sessionID = (ctx.options as any)?.sessionID ?? 'unknown'
  const serverUrl = (ctx.options as any)?.serverUrl ?? ''
  const client = {
    session: { prompt: ctx.session.prompt.bind(ctx.session) },
    config: { providers: () => ctx.provider.list() },
  }
  return { directory, sessionID, serverUrl, client }
}

export default Plugin.define({
  id: 'opencode-signal-wire',
  async setup(ctx: Plugin.Context) {
    // ── 1. Инициализация v1 целиком ─────────────────────────────────────────
    // bootstrap идентичности, wake-listener, quota-watcher, клеймо запуска —
    // всё это живёт в v1 `server()` и переиспользуется как есть.
    const v1Hooks = (await (v1Plugin as any).server(buildV1Input(ctx))) as V1Hooks

    // ── 2a. События ─────────────────────────────────────────────────────────
    // v1 держит ОДИН обработчик на все типы событий и разбирает их сам
    // (`eventTypeOf`/`eventPayloadOf` внутри). В v2 событие приходит потоком
    // `ctx.event.subscribe()`, поэтому крутим цикл и отдаём каждое событие в
    // тот же v1-коллбэк.
    // ⚠ PORT: v1-мэппинг `event → ctx.event.subscribe(name, cb)` неверен для
    //   2.0.27: `subscribe` принимает `options` и возвращает AsyncIterable, а не
    //   пару `(name, cb)`. Фильтрацию по типу оставляем внутри v1-коллбэка.
    // ⚠ UNCERTAIN: v2-событие `{ id, type, data, ... }`; v1 ждёт `{ type, properties }`.
    //   `eventPayloadOf` падает на `event.data` (третий фолбэк), но имена типов
    //   (`session.created`, `message.part.updated`, `permission.updated`, …) и форма
    //   payload в v2 не сверены с живым потоком.
    const eventsAbort = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: eventsAbort.signal })) {
        try {
          await v1Hooks.event({ event })
        } catch {
          /* v1-коллбэк сам fail-open; цикл не роняем */
        }
      }
    })().catch(() => { /* поток закрылся/оборвался — не наша ошибка */ })

    // ── 2b. session-хуки ────────────────────────────────────────────────────
    // ⚠ PORT: v2 отдаёт ОДНУ мутируемую структуру, v1 ждёт пару `(input, output)`.
    //   Ниже — сборка пары, вызов v1-коллбэка и запись мутаций обратно.
    // ⚠ UNCERTAIN: v2 `SessionPrompt` НЕ несёт модель; v1 `chat.message` берёт её из
    //   `input.model.modelID` и трекает в signalWire. Источник модели в v2 — вероятно
    //   `ctx.session.hook('model.request', …)` (SessionModelRequest.model). В черновике
    //   пробуем `metadata.model`; если его нет — трекинг модели с запроса теряется.
    await ctx.session.hook('prompt', async (h) => {
      const prompt = h.prompt as any
      const out = { parts: prompt?.parts ?? [] }
      const v1In = { sessionID: h.sessionID, model: (h as any).metadata?.model }
      await v1Hooks['chat.message'](v1In, out)
      prompt.parts = out.parts
    })

    // v1 `experimental.session.compacting` читает только `input.sessionID`, output не
    // трогает — поэтому пара строится тривиально.
    // ⚠ PORT: v2-хук `compaction` отдаёт один объект `SessionCompaction`; output v1 не нужен.
    await ctx.session.hook('compaction', async (h) => {
      await v1Hooks['experimental.session.compacting']({ sessionID: h.sessionID }, undefined)
    })

    // ⚠ PORT: v2 `SessionContext.system` — `Array<SystemPart>` (`{ type:'text', text }`),
    //   а v1-хук пишет `string[]`. Разворачиваем в текст перед вызовом и собираем обратно.
    //   Побочно теряются `cache`-подсказки существующих частей.
    // ⚠ UNCERTAIN: модель для v1-хука берём из `metadata.model`; в v2 её, возможно, надо
    //   тянуть из `model.request`.
    await ctx.session.hook('context', async (h) => {
      const out = { system: h.system.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))) }
      await v1Hooks['experimental.chat.system.transform']({ sessionID: h.sessionID, model: (h as any).metadata?.model }, out)
      h.system = out.system.map((text: string) => ({ type: 'text', text })) as any
    })

    // ── 2c. tool-хуки ───────────────────────────────────────────────────────
    // ⚠ PORT: v2 отдаёт одну структуру, v1 ждёт `(input, output)`. Формы полей v2:
    //   'execute.before' = { tool, sessionID, agent, messageID, id, input }.
    //   v1 `normalizeToolBefore` читает `{ tool, sessionID, callID }` из input и `args`
    //   из output; запись блока — в `output.args`.
    await ctx.tool.hook('execute.before', async (h) => {
      const v1In = { tool: h.tool, sessionID: h.sessionID, callID: h.id }
      const v1Out = { args: h.input }
      await v1Hooks['tool.execute.before'](v1In, v1Out)
      h.input = v1Out.args
    })

    // ⚠ PORT: v2 'execute.after' = { tool, sessionID, messageID, id, input } &
    //   ({ status:'completed', result } | { status:'error', error }).
    //   v1 ждёт output = { title, output, metadata }, а v2 `Tool.Result` = { output?, content?, metadata? }.
    //   Соответствие `title/output` → `content` приблизительное.
    // ⚠ UNCERTAIN: при `status:'error'` v1-путь не предусмотрен — коллбэк вызываем всё
    //   равно с пустым результатом (v1 сам fail-open).
    await ctx.tool.hook('execute.after', async (h) => {
      const completed = (h as any).status === 'completed'
      const result = completed ? (h as any).result : {}
      const v1In = { tool: h.tool, sessionID: h.sessionID, callID: h.id, args: h.input }
      const v1Out = {
        title: (result as any)?.title ?? '',
        output: (result as any)?.content ?? (result as any)?.output ?? '',
        metadata: (result as any)?.metadata ?? {},
      }
      await v1Hooks['tool.execute.after'](v1In, v1Out)
      if (completed) {
        Object.assign((h as any).result, { content: v1Out.output, metadata: v1Out.metadata })
      }
    })

    // ── 2d. tool transform (v1 `tool.definition`) ────────────────────────────
    // ⚠ PORT: v1 `tool.definition` — ПОХОДОВЫЙ хук `(input{toolID}, output{description,parameters})`.
    //   v2 `tool.transform` — РАЗОВЫЙ трансформер, получающий ToolEditor.
    // ⚠ UNCERTAIN: v2-коллбэк трансформера СИНХРОННЫЙ (`(editor) => void`), а
    //   `toolDefinitionHook` асинхронный. Мутация `editor.update(...)` после возврата из
    //   коллбэка может прийти поздно — трансформер, возможно, уже прочитал editor.
    // ⚠ UNCERTAIN: у v2-инструмента поле схемы — `input`, у v1 — `parameters`.
    await ctx.tool.transform(async (editor) => {
      for (const tool of editor.list()) {
        const out = { description: tool.description, parameters: (tool as any).input }
        await v1Hooks['tool.definition']({ toolID: tool.id }, out)
        editor.update(tool.id, (t: any) => {
          t.description = out.description
          t.input = out.parameters
        })
      }
    })

    // ── 3. cleanup ──────────────────────────────────────────────────────────
    // Останавливаем поток событий и зовём v1-путь остановки (`server.stop`), который
    // закрывает wake-listener и quota-watcher — тем же кодом, что и v1, без дублирования.
    // ⚠ UNCERTAIN: v1-путь считает `releaseProcessWakeListener()`; если setup звали один
    //   раз на процесс, счётчик сойдётся. При нескольких экземплярах — семантика та же,
    //   что у v1 (закрывает только последний уходящий).
    return async () => {
      eventsAbort.abort()
      try {
        await v1Hooks.event({ event: { type: 'server.stop' } })
      } catch {
        /* fail-open: остановка не должна бросать */
      }
    }
  },
})
