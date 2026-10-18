# Порт opencode-signal-wire на OpenCode 2.0 — отчёт

Изменён ТОЛЬКО `packages/opencode-signal-wire/plugin-v2.ts`. `plugin.ts`, `signal-wire.ts`, `index.ts` и остальные файлы пакета не тронуты.

Пометки уровня доверия:
- **[живьём]** — видели в живом прогоне v2 17.10.
- **[типы]** — взято из `@opencode/plugin@2.0.27` и `@opencode/schema@2.0.27` (`session-event.js`, `permission.js`, `event-manifest.js`, `promise/*.d.ts`). Живьём не видели, сверить на первом прогоне.

## (а) Таблица соответствий v1 → v2

### Хуки

| v1 | v2 | Уровень | Примечание |
|---|---|---|---|
| `chat.message (input{sessionID, model}, output{parts})` | `session.hook('prompt')` → `{sessionID, messageID, prompt, metadata, delivery}` | живьём (форма `prompt` — типы) | `prompt` = `{text, files?, agents?, skills?}`, **`parts` нет**. Даём v1 одну text-часть из `prompt.text` и пишем текст обратно. **Модели в prompt нет**; ближайшее — `session.step.started.model` (событие, живьём), передаётся последняя известная модель сессии |
| `experimental.session.compacting` | `session.hook('compaction')` | типы | v1 читает только `sessionID` |
| `experimental.chat.system.transform (input{sessionID, model}, output{system: string[]})` | `session.hook('context')` → `{sessionID, model: {id, providerID}, system: SystemPart[]}` | типы | модель берётся из `h.model`, а не из `metadata.model` (как было угадано). Неизменённые части возвращаются исходными объектами, чтобы сохранить подсказки `cache` |
| `tool.definition (input{toolID}, output{description, parameters})` | `ctx.tool.transform(editor => …)` (синхронный) | типы | `parameters` ↔ `input`. `toolDefinitionHook` вызывается напрямую: в его теле нет `await`, поэтому мутация завершается синхронно |
| `tool.execute.before (input{tool, sessionID, callID}, output{args})` | `tool.hook('execute.before')` → `{tool, sessionID, agent, messageID, id, input}` | типы | `callID` ← `id`, `args` ↔ `input` |
| `tool.execute.after (… , output{title, output, metadata})` | `tool.hook('execute.after')` с `status:'completed'`, `result: {output?, content?: string \| Content[], metadata?}` | типы | `title` — **нет соответствия** (передаётся `''`). Результат пишется обратно только если v1 его изменил; file-части сохраняются |
| `event` (один обработчик) | `ctx.event.subscribe()` → AsyncIterable `{id, created, type, data, …}` | живьём | сырые события **не передаются**, каждое переводится (`translateV2Event`) |

### События

| v1 событие | v2 событие | Уровень | Перевод |
|---|---|---|---|
| `session.created {info/session}` | `session.created {sessionID, location.directory, parentID?}` | типы | имя то же, форма другая, поэтому переводим |
| `session.updated` (привязка) | **нет соответствия** | — | ближайшее: на первом `session.execution.started` (живьём) вызвать `ctx.session.get` и синтезировать v1 `session.updated` |
| `session.idle` | `session.execution.succeeded` / `.interrupted` | типы (семейство живьём) | v2 `session.idle` помечен deprecated и отбрасывается, чтобы не было двойного счёта |
| `session.error` | `session.execution.failed {error}` | типы | → `session.error` + `session.idle` |
| `session.status {type:'retry'}` | `session.retry.scheduled {attempt, at, error}` | типы | v2 `session.status` (событие для TUI) отбрасывается как дубль |
| `session.compacted` | `session.compaction.ended` | типы | v2 `session.compacted` не входит в серверный поток |
| `session.deleted` | `session.deleted {sessionID}` | типы | |
| `permission.updated {id, title}` | `permission.asked {id, action, message?}` | типы | `title` ← `message ?? action` |
| `permission.replied {permissionID, response}` | `permission.replied {requestID, reply}` | типы | |
| `message.part.updated` (регистрация text-части) | `session.text.started {assistantMessageID, ordinal}` | живьём | `partID` в v2 нет, ключ синтезируется как `assistantMessageID#ordinal` |
| `message.part.delta {partID, delta}` | `session.text.delta {assistantMessageID, ordinal, delta}` | живьём | |
| `message.updated` (модель) | `session.step.started {model}` | живьём | отправляется до ответа поставщика, поэтому модель известна и на сорванном ходу |
| `message.updated` (tokens, time.completed) | `session.step.ended {tokens, cost}` | живьём | модель берётся из `step.started`. `session.usage.updated` **не берём**: это нарастающий итог сессии |
| `message.part.updated` (tool в state error) | **нет события с именем инструмента**; ближайшее — `tool.hook('execute.after')` с `status:'error'` | типы | синтезируем v1 tool-error part. `session.tool.failed` не подходит: в нём нет имени инструмента |
| `app.exit` / `server.stop` | **нет соответствия** | — | cleanup из `setup` подаёт синтетический `server.stop` |

### Вход `server(input)`

| v1 input | v2 | Примечание |
|---|---|---|
| `directory` | `ctx.location.directory` | |
| `sessionID` | **нет соответствия** (плагин привязан к каталогу) | `undefined`, далее argv, затем `prompt`-хук или привязка через `session.get` |
| `serverUrl` | **нет соответствия** | 🔴 без него движок правил выключен. Источник — опция плагина `ctx.options.serverUrl`; при её отсутствии в stderr пишется `SERVER_URL_ABSENT` |
| `client.session.list` | **нет соответствия** | шима нет |
| `client.session.prompt({path, body:{parts}})` | `ctx.session.prompt({sessionID, text})` | шим |
| `client.config.providers()` | `ctx.model.list()` | пересобирается в v1-форму `{data:{providers:[{id, models:{[id]:{limit}}}]}}` |
| — | `ctx.message` | **не существует** (живьём) и не используется |

## (б) Что изменено в plugin-v2.ts

1. Новая экспортируемая чистая функция `translateV2Event(ev, state)` переводит события v2 в v1 по таблице выше. Всё, чего нет в таблице, отбрасывается. Раньше сырое v2-событие уходило в v1-обработчик и не совпадало ни с одной веткой, а при совпадении имени давало неверную форму данных.
2. Добавлены привязка сессии через `ctx.session.get` на `session.execution.started` и шимы `session.prompt` и `config.providers` под формы v2.
3. Хук `prompt` работает с `prompt.text`; `prompt.parts` в v2 не существует. Модель берётся из `step.started`.
4. Хук `context`: модель из `h.model`, части system сохраняются.
5. `execute.after`: провал (`status:'error'`) больше не идёт в v1 `tool.execute.after`, а синтезирует v1 tool-error событие. Успех пишется обратно только при изменении, file-content сохраняется.
6. `tool.transform`: коллбэк синхронный, `toolDefinitionHook` вызывается напрямую, `editor.update` — только при изменении.
7. `serverUrl` и `sessionID` больше не угадываются из `ctx.options`. `serverUrl` — явная опция, отсутствие называется вслух.
8. Все ~17 пометок PORT/UNCERTAIN заменены пометками [живьём]/[типы] и явными «нет соответствия».

## (в) Проверки

- `tsc --noEmit -p packages/opencode-signal-wire`: **0 ошибок в plugin-v2.ts**. Есть 27 ошибок в других файлах, все из-за недоступного приватного `@kiberos/signal-wire-core` (реестр npm.muid.io отвечает 403). До и после правки их ровно 27.
- `bun test packages/opencode-signal-wire/`: 76 pass / 26 fail / 23 errors, **идентично базе до правки**. Все падения из-за того же отсутствующего `@kiberos/signal-wire-core`; ни один тест не импортирует plugin-v2.
- Отдельная проба (в scratchpad, в репозиторий не входит) прогнала 12 типов v2-событий через `translateV2Event` и настоящие v1-экстракторы (`session-lifecycle.ts`, `context-usage.ts`): 1 pass, 15 expect.

## Открытые вопросы для живого прогона

- Приходят ли `session.execution.succeeded`, `permission.asked` и `session.retry.scheduled` в поток. Видели только `execution.started`.
- Доставляются ли `tool.hook` и `tool.transform`. Живьём проверен только `session.hook('prompt')`.
- Откуда взять `serverUrl` в v2, кроме опции плагина.
