/**
 * plugin-v2 — вход под OpenCode 2.0 (`@opencode/plugin@2.0.27`).
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
 * ОТКУДА ФОРМЫ (два уровня доверия, помечены у каждого места):
 *   [живьём]  — живой прогон v2 17.10: путь плагина — каталог, `export default {id, setup}`;
 *             поверхность ctx (25 доменов); `ctx.message` НЕТ; `session.hook('prompt')`
 *             доставляется с {sessionID, messageID, prompt, metadata, delivery};
 *             `ctx.event.subscribe()` → AsyncIterable `{id, created, type, [durable],
 *             [location], [metadata], data}`; увиденные типы — `session.execution.started`,
 *             `session.step.{started,streamed,ended}`, `session.text.{started,delta,ended}`,
 *             `session.usage.updated`, `session.inbox.*`, `*.updated` доменов и т.д.
 *   [типы]    — `@opencode/plugin@2.0.27` + `@opencode/schema@2.0.27`
 *             (`dist/promise/{session,tool,registration}.d.ts`, `schema/dist/session-event.js`,
 *             `permission.js`, `event-manifest.js`). Живьём НЕ видели — сверить при первом прогоне.
 *
 * ГЛАВНОЕ: словари событий v1 (`message.*`, `permission.updated`, `session.idle`) и v2
 * (`session.text.*`, `session.step.*`, `session.execution.*`, `permission.asked`) РАЗНЫЕ.
 * Сырое v2-событие в v1-обработчик НЕ передаётся никогда: часть имён совпадает
 * (`session.created`, `session.deleted`, `permission.replied`, `session.status`), а форма
 * данных — нет (v1 читает `properties`, v2 кладёт в `data` и другими полями). Каждое
 * v2-событие либо ПЕРЕВОДИТСЯ в v1-форму (`translateV2Event`), либо отбрасывается.
 */

import { Plugin } from '@opencode/plugin'
import v1Plugin from './plugin'
import { toolDefinitionHook } from './tool-definition-hook'

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

/** v1-событие в той форме, которую разбирают экстракторы `session-lifecycle.ts` / `context-usage.ts`. */
export interface V1Event {
  type: string
  properties: Record<string, unknown>
}

/** Модель последнего шага по сессии — `session.step.ended` модели не несёт, а v1 `message.updated` ждёт её рядом с токенами. */
export interface V2TranslateState {
  modelBySession: Map<string, { modelID: string; providerID: string }>
}

export function createV2TranslateState(): V2TranslateState {
  return { modelBySession: new Map() }
}

/**
 * Ключ текстовой части. В v2 у текста нет `partID`: часть адресуется парой
 * (`assistantMessageID`, `ordinal`) — и в `text.started`, и в `text.delta` [живьём: оба типа
 * увидены; поля — типы]. v1 регистрирует часть по `part.id` и принимает дельты по `partID`,
 * поэтому ключ синтезируется из этой пары одинаково с обеих сторон.
 */
function textPartKey(d: any): string {
  return `${d?.assistantMessageID ?? ''}#${d?.ordinal ?? 0}`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * v2-событие → ноль или больше v1-событий. Чистая функция (кроме памяти модели в `state`).
 * Таблица соответствий — в отчёте порта и в комментариях ниже; «нет соответствия» — пустой массив.
 */
export function translateV2Event(ev: any, state: V2TranslateState): V1Event[] {
  const type = ev?.type
  const d = ev?.data ?? {}
  const sessionID = str(d.sessionID)
  if (typeof type !== 'string' || !sessionID) return []

  switch (type) {
    // v1 session.created → v2 session.created [типы; живьём не видели — прогон шёл в готовой
    // сессии]. Имя то же, форма другая: id в `sessionID`, каталог в `location.directory`.
    case 'session.created':
      return [{
        type: 'session.created',
        properties: { sessionID, directory: str(d.location?.directory), parentID: str(d.parentID) ?? null },
      }]

    // v1 session.deleted → v2 session.deleted [типы]. Данные — только `sessionID`.
    case 'session.deleted':
      return [{ type: 'session.deleted', properties: { sessionID } }]

    // v1 session.idle → v2 session.execution.succeeded | interrupted [типы; семейство
    // execution.* подтверждено живьём через `.started`]. v2 `session.idle` тоже есть в потоке,
    // но помечен в схеме `// deprecated` — его отбрасываем, чтобы конец хода не считался дважды.
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return [{ type: 'session.idle', properties: { sessionID } }]

    // v1 session.error → v2 session.execution.failed {error: {type, message, status?}} [типы].
    // v1-opencode после ошибки тоже доходил до idle; здесь idle синтезируется явно, иначе
    // правила конца хода не сработают на оборванном ходу.
    case 'session.execution.failed':
      return [
        { type: 'session.error', properties: { sessionID, error: d.error } },
        { type: 'session.idle', properties: { sessionID } },
      ]

    // v1 session.status{type:'retry'} → v2 session.retry.scheduled {attempt, at, error} [типы].
    // v2 `session.status` в потоке тоже есть (для TUI), но как дубль — отбрасываем.
    case 'session.retry.scheduled':
      return [{
        type: 'session.status',
        properties: {
          sessionID,
          status: { type: 'retry', attempt: d.attempt, next: d.at, message: str(d.error?.message) ?? '' },
        },
      }]

    // v1 session.compacted → v2 session.compaction.ended [типы]. v2 `session.compacted`
    // в схеме есть, но не входит в серверный набор потока (`EventManifest.ServerDefinitions`).
    case 'session.compaction.ended':
      return [{ type: 'session.compacted', properties: { sessionID } }]

    // v1 permission.updated → v2 permission.asked {id, action, resources, message?} [типы].
    // `title` у v2 нет — ближайшее `message`, иначе `action`.
    case 'permission.asked': {
      const id = str(d.id)
      if (!id) return []
      return [{ type: 'permission.updated', properties: { id, sessionID, title: str(d.message) ?? str(d.action) ?? '' } }]
    }

    // v1 permission.replied {permissionID, response} → v2 permission.replied {requestID, reply} [типы].
    case 'permission.replied': {
      const requestID = str(d.requestID)
      if (!requestID || typeof d.reply !== 'string') return []
      return [{ type: 'permission.replied', properties: { sessionID, permissionID: requestID, response: d.reply } }]
    }

    // v1 message.part.updated(part.type='text') → v2 session.text.started [живьём].
    // Регистрирует часть как ТЕКСТ: в v2 рассуждения идут отдельным `session.reasoning.*`,
    // поэтому в канал agent_text они не попадут и без регистрации — но v1-обработчик
    // принимает дельту только для зарегистрированной части.
    case 'session.text.started':
      return [{ type: 'message.part.updated', properties: { part: { type: 'text', id: textPartKey(d), sessionID } } }]

    // v1 message.part.delta {partID, delta} → v2 session.text.delta {assistantMessageID, ordinal, delta} [живьём].
    case 'session.text.delta': {
      if (typeof d.delta !== 'string' || !d.delta) return []
      return [{ type: 'message.part.delta', properties: { sessionID, partID: textPartKey(d), delta: d.delta } }]
    }

    // v1 message.updated (assistant, modelID) → v2 session.step.started {model: {id, providerID}} [живьём].
    // Шаг стартует ДО ответа поставщика — это и «модель из запроса», что v1 брал у chat.message:
    // модель узнаётся и на ходу, отбитом ошибкой.
    case 'session.step.started': {
      const modelID = str(d.model?.id)
      if (!modelID) return []
      const providerID = String(d.model?.providerID ?? '')
      state.modelBySession.set(sessionID, { modelID, providerID })
      return [{ type: 'message.updated', properties: { info: { role: 'assistant', sessionID, modelID, providerID } } }]
    }

    // v1 message.updated (assistant, tokens, time.completed) → v2 session.step.ended {tokens, cost} [живьём].
    // `tokens` = TokenUsage.Info {input, output, reasoning, cache{read,write}} — те же поля, что
    // читает `usageFromMessageEvent`; модель — из памяти `step.started` той же сессии.
    // `session.usage.updated` [живьём] НЕ берём: это нарастающий итог сессии, а не запрос шага.
    case 'session.step.ended': {
      const model = state.modelBySession.get(sessionID)
      const created = typeof ev.created === 'number' ? ev.created : Date.now()
      return [{
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID,
            modelID: model?.modelID ?? '',
            providerID: model?.providerID ?? '',
            tokens: d.tokens,
            time: { completed: created },
          },
        },
      }]
    }

    default:
      return []
  }
}

/**
 * Собрать `input`, который ждёт v1-вход `server(input)`.
 *
 * v1 читает: `directory`, `sessionID`, `serverUrl`, `client` (`session.prompt`,
 * `session.list`, `config.providers`).
 *
 * - `directory` ← `ctx.location.directory` [типы: Location.Info; домен `location` — живьём].
 * - `sessionID` — нет соответствия: v2-плагин живёт на каталог, не на сессию; в ctx номера
 *   сессии нет. Отдаём undefined — v1 сам падает на `--session` из argv, затем 'unknown',
 *   а настоящий номер приходит с `prompt`-хуком (setSessionId) и с привязкой ниже.
 * - `serverUrl` — нет соответствия в ctx. 🔴 Без него v1 НЕ создаёт signalWire и движок
 *   правил выключен целиком. Единственный честный источник — явная опция плагина
 *   (`ctx.options.serverUrl`: PluginOptions — это конфиг плагина от оператора, а не рантайм).
 *   Отсутствие называется вслух в stderr.
 * - `client.session.list` — нет соответствия (SessionDomain без `list`). Шим не ставим: v1
 *   `findNewSessionByDirectory` молча вернёт count:0. Привязку делаем иначе — см.
 *   `bindFromExecution` в setup (через `ctx.session.get`).
 * - `client.session.prompt({path:{id}, body:{parts}})` → `ctx.session.prompt({sessionID, text})`
 *   [типы: SessionPromptInput — плоский `{sessionID, text, files?, metadata?, delivery?}`].
 * - `client.config.providers()` → `ctx.model.list()` [типы: `{data: ModelInfo[]}`, у модели
 *   `id`, `providerID`, `limit.context`], пересобранный в v1-форму `{data:{providers:[…]}}`.
 */
function buildV1Input(ctx: Plugin.Context): any {
  const directory = ctx.location?.directory ?? process.cwd()
  const serverUrl = typeof ctx.options?.serverUrl === 'string' ? ctx.options.serverUrl : ''
  if (!serverUrl) {
    console.error('[opencode-signal-wire/v2] SERVER_URL_ABSENT: в v2 ctx нет serverUrl; задайте опцию плагина `serverUrl` — без неё движок правил выключен')
  }
  const client = {
    session: {
      prompt: (arg: any) => {
        const parts: any[] = arg?.body?.parts ?? []
        const text = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
        return ctx.session.prompt({ sessionID: arg?.path?.id, text } as any)
      },
    },
    config: {
      providers: async () => {
        const r = await ctx.model.list()
        const byProvider = new Map<string, Record<string, { limit?: { context?: number } }>>()
        for (const m of (r?.data ?? []) as any[]) {
          const models = byProvider.get(m.providerID) ?? {}
          models[m.id] = { limit: { context: m.limit?.context } }
          byProvider.set(m.providerID, models)
        }
        return { data: { providers: [...byProvider].map(([id, models]) => ({ id, models })) } }
      },
    },
  }
  return { directory, sessionID: undefined, serverUrl, client }
}

/** Текст результата инструмента: v2 `Tool.Result.content` — строка ИЛИ массив Content (text|file) [типы]. */
function resultText(result: any): string {
  const c = result?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
  if (result?.output === undefined) return ''
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
}

export default Plugin.define({
  id: 'opencode-signal-wire',
  async setup(ctx: Plugin.Context) {
    // ── 1. Инициализация v1 целиком ─────────────────────────────────────────
    // bootstrap идентичности, wake-listener, quota-watcher, клеймо запуска —
    // всё это живёт в v1 `server()` и переиспользуется как есть.
    const v1Hooks = (await (v1Plugin as any).server(buildV1Input(ctx))) as V1Hooks
    const feed = async (event: V1Event) => {
      try {
        await v1Hooks.event({ event })
      } catch {
        /* v1-коллбэк сам fail-open; поток не роняем */
      }
    }

    // ── 2a. События: v2-поток → перевод → v1-обработчик ─────────────────────
    // [живьём] `subscribe()` → AsyncIterable; [типы] options = {signal?, onActivity?}.
    const state = createV2TranslateState()
    // Привязка сессии. v1 привязывался по `session.created|updated` (каталог == cwd) и ретраями
    // через `client.session.list`. В v2 `list` нет, а `session.created` при работе в готовой
    // сессии не приходит (живьём не видели). Ближайшее: на первом `session.execution.started`
    // [живьём] сессии спросить `ctx.session.get` [типы: SessionInfo {id, parentID?, location}]
    // и отдать v1 `session.updated` — тот привязывает БЕЗ синтеза session.start.
    const bindLooked = new Set<string>()
    const bindFromExecution = async (sessionID: string) => {
      if (bindLooked.has(sessionID)) return
      bindLooked.add(sessionID)
      try {
        const info: any = await ctx.session.get({ sessionID } as any)
        await feed({
          type: 'session.updated',
          properties: { sessionID, directory: str(info?.location?.directory), parentID: str(info?.parentID) ?? null },
        })
      } catch {
        /* нет сессии/сбой — привязка останется за prompt-хуком (setSessionId) */
      }
    }
    const eventsAbort = new AbortController()
    void (async () => {
      for await (const ev of ctx.event.subscribe({ signal: eventsAbort.signal }) as AsyncIterable<any>) {
        if (ev?.type === 'session.execution.started' && typeof ev?.data?.sessionID === 'string') {
          await bindFromExecution(ev.data.sessionID)
        }
        for (const event of translateV2Event(ev, state)) await feed(event)
      }
    })().catch(() => { /* поток закрылся/оборвался — не наша ошибка */ })

    // ── 2b. session-хуки ────────────────────────────────────────────────────
    // v1 chat.message → session.hook('prompt') [живьём: {sessionID, messageID, prompt, metadata, delivery}].
    // [типы] `prompt` = PromptInput {text, files?, agents?, skills?} — `parts` у него НЕТ. v1 ждёт
    // output.parts и дописывает подсказки в ПОСЛЕДНЮЮ текстовую часть — даём одну часть из
    // `prompt.text` и пишем её текст обратно.
    // Модели в prompt нет [живьём]: она приходит раньше событием `session.step.started` и уже
    // отслежена переводом; здесь отдаём последнюю известную модель сессии (или ничего).
    await ctx.session.hook('prompt', async (h) => {
      const part = { type: 'text', text: h.prompt.text }
      const out = { message: { role: 'user' }, parts: [part] }
      const model = state.modelBySession.get(h.sessionID)
      const v1In = {
        sessionID: h.sessionID,
        messageID: h.messageID,
        model: model ? { modelID: model.modelID, providerID: model.providerID } : undefined,
      }
      await v1Hooks['chat.message'](v1In, out)
      h.prompt.text = part.text
    })

    // v1 experimental.session.compacting → session.hook('compaction') [типы: SessionCompaction
    // extends SessionContext]. v1 читает только `input.sessionID`; `result` не трогаем.
    await ctx.session.hook('compaction', async (h) => {
      await v1Hooks['experimental.session.compacting']({ sessionID: h.sessionID }, undefined)
    })

    // v1 experimental.chat.system.transform → session.hook('context') [типы: SessionContext
    // {sessionID, model: Model.Ref{id, providerID}, system: SystemPart[] ({type:'text', text}), …}].
    // v1 работает со `string[]`; при сборке обратно неизменённые части берём ИСХОДНЫМИ объектами,
    // чтобы не потерять их `cache`-подсказки.
    await ctx.session.hook('context', async (h) => {
      const original = h.system.map((p: any) => ({ part: p, text: typeof p === 'string' ? p : (p?.text ?? '') }))
      const out = { system: original.map((o) => o.text) }
      await v1Hooks['experimental.chat.system.transform'](
        { sessionID: h.sessionID, model: { providerID: h.model.providerID, modelID: h.model.id } },
        out,
      )
      h.system = out.system.map((text: string, i: number) =>
        original[i] && original[i].text === text ? original[i].part : { type: 'text', text },
      ) as any
    })

    // ── 2c. tool-хуки ───────────────────────────────────────────────────────
    // v1 tool.execute.before → tool.hook('execute.before') [типы: {tool, sessionID, agent,
    // messageID, id, input}; `input` мутируемый]. v1 блокирует, переписывая `output.args`.
    await ctx.tool.hook('execute.before', async (h) => {
      const v1In = { tool: h.tool, sessionID: h.sessionID, callID: h.id }
      const v1Out = { args: h.input }
      await v1Hooks['tool.execute.before'](v1In, v1Out)
      h.input = v1Out.args
    })

    // v1 tool.execute.after → tool.hook('execute.after') status:'completed' [типы:
    // result = Tool.Result {output?, content?: string | Content[], metadata?}].
    // v1 ждёт строку `output`; назад пишем только если v1 её изменил (сжатие/подсказка),
    // сохраняя file-части исходного `content`.
    // v1 провал вызова (message.part.updated, part tool в state error) → тот же хук со
    // status:'error' [типы: error = Tool.Error {message}]. v1 провалы через after НЕ гонял
    // (иначе слова ошибки ложно триггерят правила по выводу) — поэтому синтезируем ровно то
    // v1-событие, из которого он строит `tool.failure`. Событие v2 `session.tool.failed` для
    // этого не годится: в нём нет имени инструмента.
    await ctx.tool.hook('execute.after', async (h) => {
      if (h.status === 'error') {
        await feed({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              sessionID: h.sessionID,
              tool: h.tool,
              callID: h.id,
              state: { status: 'error', error: h.error?.message ?? '', input: h.input },
            },
          },
        })
        return
      }
      const before = resultText(h.result)
      const v1In = { tool: h.tool, sessionID: h.sessionID, callID: h.id, args: h.input }
      const v1Out = { title: '', output: before, metadata: h.result.metadata ?? {} }
      await v1Hooks['tool.execute.after'](v1In, v1Out)
      if (v1Out.output !== before) {
        const c = h.result.content
        const files = Array.isArray(c) ? c.filter((p: any) => p?.type !== 'text') : []
        h.result = { ...h.result, content: [{ type: 'text', text: v1Out.output }, ...files] }
      }
    })

    // ── 2d. tool transform (v1 `tool.definition`) ────────────────────────────
    // v1 tool.definition (походовый, `(input{toolID}, output{description, parameters})`) →
    // ctx.tool.transform (разовый, ToolEditor) [типы]. Коллбэк трансформера СИНХРОННЫЙ, а
    // v1-обёртка асинхронна (`await import(...)`). Поэтому зовём `toolDefinitionHook` напрямую:
    // в его теле нет ни одного `await`, мутация `out` завершается до возврата промиса.
    // Поле схемы: v1 `parameters` ↔ v2 `input` (ValueSchema допускает JSON Schema [типы]).
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        const out = { description: tool.description, parameters: tool.input as unknown }
        void toolDefinitionHook({ toolID: tool.id }, out as any)
        if (out.description === tool.description && out.parameters === tool.input) continue
        editor.update(tool.id, (t) => {
          t.description = out.description
          t.input = out.parameters as any
        })
      }
    })

    // ── 3. cleanup ──────────────────────────────────────────────────────────
    // v1 app.exit / server.stop — нет соответствия в словаре v2 (ни живьём, ни в типах).
    // Ближайшее — cleanup, который возвращает setup [типы: Plugin.Cleanup]: он и отдаёт
    // v1-обработчику синтетический `server.stop`, закрывающий wake-listener и quota-watcher
    // тем же кодом, что и v1 (включая счётчик экземпляров процесса).
    return async () => {
      eventsAbort.abort()
      await feed({ type: 'server.stop', properties: {} })
    }
  },
})
