# OpenCode v2 — почему зарегистрированная модель отвергается

**Дата:** 22.10.2026
**Вопрос:** почему `opencode2 run -m claude-max/claude-sonnet-5` получает `Model unavailable`,
какие поля `Model.Info` обязательны и как выглядит минимальная валидная запись.

## 0. Что именно прочитано (версия и коммит)

| Что | Значение | Откуда |
|---|---|---|
| Установленный бинарь | `@opencode/cli` **2.0.27** | `/home/relishev/packages/opencode-v2/node_modules/@opencode/cli/package.json` (`"version": "2.0.27"`) |
| Плагинный API | `@opencode/plugin` **2.0.27** | `/home/relishev/packages/opencode-v2/refs/package/package.json` (распакованный npm-tarball `refs/opencode-plugin-2.0.27.tgz`) |
| Тег в апстриме | `v2.0.27` | `https://api.github.com/repos/anomalyco/opencode/git/refs/tags/v2.0.27` |
| Коммит | `1f4d07a4a519185955ae8ab2ea3607805509e386` (2026-10-12 04:16:59 +0000) | `git log -1` в клоне |

Клон (одноразовый, воспроизводимый из тега — в дерево проекта не клался, чтобы не менять ничего вне отчёта):

```
git clone --depth 1 --branch v2.0.27 --single-branch \
  https://github.com/anomalyco/opencode.git /tmp/opencode/oc-v2.0.27
```

**Все `path:line` ниже — относительно `/tmp/opencode/oc-v2.0.27`.**
Локальный бинарь — компилированный Bun-бинарник, читаемого исходника на диске нет;
единственный источник истины — тег выше. `opencode2` в этой сессии НЕ запускался.

---

## 1. Путь регистрации: `reg` — это `ProviderEditor`

`ctx.provider.transform(callback)` даёт синхронный колбэк с редактором.
Хост-обёртка — `packages/core/src/plugin/host.ts:207-226`:

```ts
transform: (callback) =>
  providers.transform((editor) => {
    callback({
      list: editor.list,
      get: (id) => editor.get(Provider.ID.make(id)),
      add: (definition) => editor.add({ ...definition, sourceConnection: ... }),
      update: (id, update) => editor.update(Provider.ID.make(id), update),   // :215
      remove: (id) => editor.remove(Provider.ID.make(id)),
      models: { set, update, remove },                                        // :217-226
    })
  }),
```

Тип (Promise-фасад) — `packages/plugin/src/promise/provider.ts:5-28`:

```ts
export interface ProviderEditor {
  list(): readonly ProviderRecord[]
  get(providerID: string): ProviderRecord | undefined
  add(input: { info: Provider.Info; models: readonly Model.Info[]; sourceConnection?: ConnectionInfo }): void   // :19
  update(providerID: string, update: (provider: DeepMutable<Provider.Info>) => void): void                       // :20
  remove(providerID: string): void
  readonly models: { set(...), update(...), remove(...) }
}
```

### Что реально делает `add`

`packages/core/src/provider.ts:337-343`:

```ts
add: (definition) => {
  records.set(definition.info.id, {
    provider: structuredClone(definition.info) as MutableInfo,
    models: index(definition.info.id, definition.models),
    sourceConnection: definition.sourceConnection,
  })
},
```

`index()` — `packages/core/src/provider.ts:282-292` — строит `Map<model.id, Model.Info>`,
**подменяя `providerID` на id провайдера**, и замораживает (`freeze(..., true)`):

```ts
const result = freeze(
  new Map(models.map((model) => [model.id, model.providerID === providerID ? model : { ...model, providerID }])),
  true,
)
```

Три следствия, важных для порта:

1. **Схема здесь НЕ валидируется.** `add` не декодирует `Model.Info` — объект кладётся как есть.
   Поэтому неверный тип поля (например, `time.released` строкой) не бросает и не логируется;
   он всплывает позже и в другом месте.
2. **`providerID` можно не указывать точно** — `index()` его перезапишет.
3. **Ключ — `model.id`.** Модель ищется по паре `providerID` + `id`, а не по `modelID`.

### Что делает провайдера «доступным»

`packages/core/src/provider.ts:407-420` — `activation: "auto"` даёт доступность тогда и только тогда,
когда у провайдера нет интеграции с тем же id:

```ts
const available = Array.from(records.values()).filter((record) => {
  if (record.provider.activation === "disabled") return false
  const integration = byID.get(record.provider.integrationID ?? Integration.ID.make(record.provider.id))
  ...
  if (record.provider.activation === "enabled") return true
  if (integration?.connections.length) return true
  return record.provider.integrationID === undefined && !integration
})
```

Для `id: "claude-max"` без записи интеграции `claude-max` это `true`. **`activation: "auto"` — правильный выбор.**

### Что делает модель «доступной» — вот она, развилка

`packages/core/src/model.ts:218-221`:

```ts
const all = Array.from(byProvider.values())
  .flatMap((models) => Array.from(models.values()))
  .sort((left, right) => right.time.released - left.time.released)   // :220
cached = freeze({ data, all, available: all.filter((model) => model.enabled), byProvider }, true)  // :221
```

`available()` возвращает `all.filter(model => model.enabled)`.
**`enabled` — не украшение: это единственный фильтр каталога.** Нет `enabled: true` — модели нет в каталоге.

Перед этим `model.ts:182-217` домешивает в каждую модель значения провайдера:

```ts
const value = {
  ...model,
  ...(provider?.canonical === undefined ? {} : { canonical: provider.canonical }),
  package: model.package ?? provider?.package,                        // :201
  settings: Provider.mergeOverlay(Provider.modelSettings(provider?.settings), Provider.modelSettings(model.settings)),
  headers: Provider.mergeHeaders(provider?.headers, model.headers),
  body: Provider.mergeOverlay(provider?.body, model.body),
} satisfies Info
```

То есть `package` и `settings.baseURL` можно задать на уровне провайдера — модель их унаследует.

### Как разрешается `-m`

`packages/cli/src/session-target.ts:92-96` только парсит строку:

```ts
export function parseSessionTargetModel(value?: string): ModelRef | undefined {
  if (!value) return
  const model = Model.Ref.parse(value)
  return { providerID: model.providerID, id: model.id, variant: model.variant }
}
```

Дальше ref кладётся в сессию (`packages/cli/src/session-target.ts:61-72`), а поиск происходит на сервере —
`packages/core/src/session/runner/model.ts:82-90`:

```ts
const selected = (yield* available()).find(
  (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
)
if (!selected)
  return yield* new ModelUnavailableError({ providerID: ..., modelID: ... })
```

`available` — это `Model.Service.available` (`packages/core/src/session/context.ts:86,93`).

---

## 2. `Provider.Info` — схема

Источник: `packages/schema/src/provider.ts:74-82`.

```ts
export const Info = Schema.Struct({
  id: ID,
  canonical: ID.pipe(optional),
  integrationID: Integration.ID.pipe(optional),
  name: Schema.String,
  activation: Activation,      // "auto" | "enabled" | "disabled"
  package: Package,            // Schema.String — ОБЯЗАТЕЛЬНОЕ, не optional
  ...Overlays,                 // settings?, headers?, body?
})
```

| Поле | Тип | Обяз. | Кто читает |
|---|---|---|---|
| `id` | branded string | **да** | ключ записи (`provider.ts:338`), identity модели (`provider.ts:288`) |
| `name` | string | **да** | отображение |
| `activation` | `"auto" \| "enabled" \| "disabled"` | **да** | фильтр доступности (`provider.ts:408-419`) |
| `package` | string | **да** | `AISDKNative.rewrite` (`model.ts:200`), резолв пакета (`model-resolver.ts:219-224`), `aisdk.ts:320` |
| `canonical` | branded string | нет | переопределяет `providerID` в запросе и в `LanguageModel` (`model-resolver.ts:243-249`) |
| `integrationID` | branded string | нет | привязка к интеграции/креденшелам (`provider.ts:409`) |
| `settings` | `{timeout?, headerTimeout?, chunkTimeout?, compaction?, transport?, ...rest}` | нет | транспорт, `baseURL`, ключи пакета; `StructWithRest` — **произвольные ключи разрешены** (`schema/provider.ts:52-63`) |
| `headers` | `Record<string,string>` | нет | домешиваются в модель (`model.ts:203`) |
| `body` | `Record<string, unknown>` | нет | домешиваются в модель (`model.ts:204`) |

Эталонная «с нуля» конструкция в самом дереве — `packages/core/src/models-dev.ts:100-109`:

```ts
const info = {
  id: providerID,
  name: item.name,
  activation: "auto",
  package: packageName,
  ...(item.api ? { settings: { baseURL: item.api } } : {}),
} satisfies Provider.Info
```

`settings.baseURL` — это ровно то место, куда ложится v1-шный `api`.

---

## 3. `Model.Info` — схема и что читает каждое поле

Источник: `packages/schema/src/model.ts:122-146`.

```ts
export const Info = Schema.Struct({
  id: ID,
  modelID: ID,
  providerID: Provider.ID,
  canonical: Provider.ID.pipe(optional),
  family: Family.pipe(optional),
  name: Schema.String,
  compatibility: Compatibility.pipe(optional),
  package: Provider.Package.pipe(optional),
  ...Overlays,                                  // settings?, headers?, body?
  capabilities: Capabilities,
  variants: Schema.Array(Variant),
  time: Schema.Struct({ released: Schema.Finite }),   // :135-137
  cost: Schema.Array(Cost),                            // :138
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({ context: Schema.Int, input: Schema.Int.pipe(optional), output: Schema.Int }),
})
```

### 3.1 Таблица полей

| Поле | Тип | Обяз. | Что читает / зачем |
|---|---|---|---|
| `id` | string | **да** | ключ в `Map` провайдера (`provider.ts:288`); **точное сравнение** при разрешении `-m` (`session/runner/model.ts:82-84`) |
| `modelID` | string | **да** | id, который уходит в пакет провайдера: `module.model(resolved.modelID ?? resolved.id, …)` (`model-resolver.ts:234`), `sdk.languageModel(model.modelID ?? model.id)` (`aisdk.ts:354`). Дефолт `Info.default` ставит `modelID = id` |
| `providerID` | string | **да** | перезаписывается на id провайдера при `add` (`provider.ts:288`); потом используется в разрешении и в запросе |
| `canonical` | string | нет | подменяет provider в `LanguageModel` (`model-resolver.ts:244`), наследуется от провайдера (`model.ts:200`) |
| `family` | string | нет | `Model.small()` ищет по `family` (`model.ts:275-277`) |
| `name` | string | **да** | отображение |
| `compatibility` | `{reasoningField?, requireReasoning?, maxTokensField?, requireFinishReason?, requireAssistantAfterTool?, supportsPromptCacheKey?, supportsThinkingBlockBinding?, supportsEffortUpdates?}` | нет | `Object.assign` поверх `runtime.compatibility` (`model-resolver.ts:250-253`) |
| `package` | string | нет (но нужен на деле) | спец-резолв пакета; если нет — берётся от провайдера (`model.ts:201`) |
| `settings` | `{compaction?, ...rest}` | нет | `RuntimeInfo`; попадает в `module.model(id, settings)`; отсюда `baseURL`, `apiKey`, `thinking`, … |
| `headers` / `body` | record | нет | домешиваются в запрос |
| `capabilities.tools` | boolean | **да** | набор инструментов |
| `capabilities.input` | `string[]` | **да** | модальности входа (`["text","image","pdf"]`); `supportsText` (`model.ts:285-290`), `Model.small` (`model.ts:268-274`) |
| `capabilities.output` | `string[]` | **да** | модальности выхода |
| `variants` | `Variant[]` = `{id, settings?, headers?, body?}[]` | **да** (можно `[]`) | выбор варианта: `model.variants?.find(v => v.id === id)` (`model-resolver.ts:142`); формат `settings.thinking` — см. `packages/core/src/variant.ts:71-75` |
| `time.released` | **`Schema.Finite` — число** | **да** | см. §4 |
| `cost` | `Cost[]` = `{tier?, input, output, cache:{read,write}}[]` | **да** (можно `[]`) | `SessionUsage.calculateCost` (`session/usage.ts:19-35`); пустой массив → стоимость 0 |
| `status` | `"alpha"\|"beta"\|"deprecated"\|"active"` | **да** | `Model.small` фильтрует `status === "active"` (`model.ts:271`) |
| `enabled` | boolean | **да** | **единственный фильтр каталога** (`model.ts:221`) |
| `limit.context` | int | **да** | контекст, компакция |
| `limit.input` | int | нет | — |
| `limit.output` | int | **да** | `maxOutputTokens`, `Variant.budgets` потолок (`variant.ts:45-50`) |

### 3.2 Готовый конструктор в дереве

`packages/schema/src/model.ts:150-165` — `Model.Info.default(providerID, id)` отдаёт полностью
валидный объект (`enabled: true`, `time: { released: 0 }`, `cost: []`, `variants: []`,
`capabilities: {tools:true, input:["text","image"], output:["text"]}`, `status: "active"`,
`limit: {context:200_000, output:32_000}`).

`@opencode/plugin` реэкспортирует схему — `packages/plugin/src/promise/index.ts:9-10`:

```ts
export { Model } from "@opencode/schema/model"
export { Provider } from "@opencode/schema/provider"
```

Эталонный приём «добавить модели к провайдеру» — первый-party плагин
`packages/core/src/plugin/provider/gitlab.ts:264-285`:

```ts
yield* ctx.provider.transform((editor) => {
  const item = editor.get(providerID)
  if (!item || !loaded.models?.length) return
  editor.add({
    info: item.provider,
    sourceConnection: loaded.connection,
    models: [
      ...item.models.values(),
      ...loaded.models.filter(m => !item.models.has(m.id)).map((model) => ({
        ...Model.Info.default(providerID, Model.ID.make(model.id)),
        name: `Agent Platform (${model.name})`,
        package: Provider.aisdk("gitlab-ai-provider"),
        settings: { workflowRef: model.ref },
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: model.context, output: model.output },
      })),
    ],
  })
})
```

И канонический конструктор из каталога — `packages/core/src/models-dev.ts:204-251`, где явно видны
`enabled: true`, `time: { released: released(model.release_date) }`, `cost` массивом,
`capabilities: {tools, input, output}`, `variants: []`, `status`, `limit`.

---

## 4. `time.released` — где читается и какой формы ждут

**Требование:** `Schema.Finite` — конечное **число**. Не строка, не ISO-дата.
`packages/schema/src/model.ts:135-137`.

**Единственная легальная конверсия в дереве** — `packages/core/src/models-dev.ts:134-137`:

```ts
function released(date: string) {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}
```

То есть **unix-миллисекунды**, `0` когда неизвестно. Это же зафиксировано в описании поля для
агентского инструмента: «Release date as a Unix timestamp in milliseconds, or 0 when unknown» —
`packages/core/src/tool/plugin/opencode.ts:65-69`.

**Все места чтения:**

| Место | Что делает | Поведение на строке |
|---|---|---|
| `packages/core/src/model.ts:220` | `sort((l,r) => r.time.released - l.time.released)` | строка минус строка = `NaN`; сортировка молча деградирует в произвольный порядок, **исключения нет** |
| `packages/protocol/src/groups/model.ts:12` | `success: Location.response(Schema.Array(Model.Info))` — **энкодер ответа `GET /api/model`** | **падение кодирования с путём `time.released`**. Это и есть наблюдавшийся `…time.released` |
| `packages/core/src/tool/plugin/opencode.ts:249` | сортировка выдачи инструмента `models` | как выше |
| `packages/core/src/tool/plugin/opencode.ts:268` | отдаёт `released` наружу | — |
| `packages/app/src/runtime/server/global-sync/utils.ts:115` | `new Date(model.time.released).toISOString()` | `RangeError: Invalid time value` на мусоре |
| `packages/core/src/modal/models.ts:120` | `time: previous?.time ?? { released: 0 }` | эталон «не знаешь — ноль» |

Если `time` отсутствует целиком, `model.ts:220` бросит `TypeError` на чтении `time` —
и это уже другой симптом (падение внутри `Model.read()`, а не ошибка схемы).

---

## 5. Где рождается `Model unavailable` и что он скрывает

### 5.1 Производители строки

1. **`packages/core/src/session/runner/model.ts:20-31`** — `ModelUnavailableError`, геттер `message`:

```ts
return `Model unavailable: ${this.providerID}/${this.modelID}`
```

бросается на `packages/core/src/session/runner/model.ts:85-89`, когда пара `(providerID, id)` **не найдена** в `available()`.

2. **`packages/core/src/generate.ts:59-62`** — `Generate.ModelSelectionError` с той же строкой,
   когда `resolver.resolve(input.model)` вернул `undefined`.

### 5.2 Что это на самом деле

**Это НЕ ошибка конструирования и НЕ проглоченное исключение.** Это промах поиска по каталогу.
Структурно он ничего не глотает — но **маскирует причину**: один и тот же текст и один и тот же тип
отдаются и когда модель не зарегистрирована, и когда зарегистрирована без `enabled: true`,
и когда `add` тихо не выполнился.

Тип ошибки, который видит клиент, — один на всё: `packages/core/src/session/to-session-error.ts:74-85`

```ts
if (
  cause instanceof SessionRunnerModel.ModelNotSelectedError ||
  cause instanceof SessionRunnerModel.ModelUnavailableError ||
  ...
)
  return { type: "provider.no-route", message: cause.message }
```

`provider.no-route` — тот же класс, что «опечатался в имени модели». Различить по нему нельзя.

### 5.3 Как увидеть настоящую причину

| Дверь | Как | Что даёт |
|---|---|---|
| **`GET /api/model`** | curl к локальному серверу | **Решающий тест.** Если 500 — метаданные не проходят энкодер (`time.released`). Если 200, а модели нет — её отфильтровал `enabled` |
| **`GET /api/provider`** | `packages/protocol/src/groups/provider.ts:11-19` | Показывает, зарегистрирован ли провайдер вообще (`Provider.Info[]`, без моделей) |
| **`GET /api/plugin`** | `packages/protocol/src/groups/plugin.ts:11-25` + `packages/schema/src/plugin.ts` (`State`) | `state: { status: "failed", error: "...", ref: "err_xxxxxxxx" }` — платформа сама скажет, что плагин отключён, и даст ref для грепа |
| **Файловый лог** | `$XDG_DATA_HOME/opencode/log/opencode-<channel>.log` (`packages/util/src/observability/logging.ts:63-66`, `packages/util/src/global.ts:21`) | Всегда пишется (файловый логгер включён по умолчанию — `logging.ts:175-177`) |
| **`--print-logs`** | ставит `OPENCODE_PRINT_LOGS=1` (`packages/cli/src/framework/runtime.ts:96-99`) | Дублирует лог в stderr (`logging.ts:159-162`). ⚠️ Описание флага прямо говорит: «server logs require `--standalone`» — для `run` логи плагина идут в файл |
| **`OPENCODE_LOG_LEVEL=DEBUG`** | `logging.ts:164-175` | Порог ниже `INFO` (по умолчанию `INFO`) |

### 5.4 Почему ошибка `transform` не доходит

`packages/core/src/state.ts:178-187`:

```ts
for (const transform of transforms) {
  try {
    transform.run(editor)
  } catch (cause) {
    if (!transform.group) throw cause
    disable(transform.group, { state: options.name ?? "anonymous", cause })   // :183
  }
  ...
}
```

и `packages/core/src/plugin.ts:48-57` + `:185-190`:

```ts
activation.failure = {
  error: `Plugin disabled after ${failure.state}.transform failed. Check server logs for details.`,
  ref: `err_${crypto.randomUUID().slice(0, 8)}`,
}
...
yield* Effect.logWarning("disabled plugin after transform failure", {
  "plugin.id": ..., state: item.failure.state, ref: item.ref, cause: ...,
})
```

**Вывод, важный для порта:** `try/catch` вокруг `reg.add` в `plugin-v2.ts:87-94` — источник тишины.
Если убрать `catch`, платформа сама напишет в лог `disabled plugin after transform failure` с
`state=provider` и `ref=err_xxxxxxxx`, и отключит плагин громко, с именем состояния.
Сейчас же ошибка ловится, логируется только в самодельный `OPENCODE_CLAUDE_V2_DEBUG_FILE`
(который надо ещё включить), и наружу не выходит ничего.

Дополнительно: фолбэк `reg.update({ info, models })` (`plugin-v2.ts:93`) **неверен по сигнатуре** —
`update(providerID: string, update: (provider) => void)` (`packages/plugin/src/promise/provider.ts:20`,
`packages/core/src/plugin/host.ts:215`). Объект уедет в `providerID`, второй аргумент будет `undefined`,
и вызов упадёт в `update(record.provider)` внутри `provider.ts:344-346`. То есть фолбэк не спасает,
а второй раз молча логирует `update failed`.

---

## 6. Корневая причина текущего порта

`packages/opencode-claude/plugin-v2.ts:83-88` формирует модель как `{...v1Model, time:{released}}`:

```ts
const released = new Date(0).toISOString()          // :82  — СТРОКА
const models = (Object.values(e?.models ?? {}) as any[]).map((m) => ({
  ...m,
  time: (m as any)?.time ?? { released },           // :85
}))
```

Против схемы `Model.Info` (`packages/schema/src/model.ts:122-146`) v1-объект из
`packages/opencode-claude/index.ts:445-497` **не содержит трёх обязательных полей и одно отдаёт в неверном типе**:

| # | Дефект | Следствие |
|---|---|---|
| 1 | **`enabled` отсутствует** | `all.filter(m => m.enabled)` (`model.ts:221`) выбрасывает модель из `available()` → `ModelUnavailableError` → **`Model unavailable`**. Это и есть наблюдаемый отказ. `add` при этом не бросает — отсюда ощущение «зарегистрировалось, но недоступно» |
| 2 | **`time.released` — строка** (`new Date(0).toISOString()`) | `Schema.Finite` ждёт число. Промах в сортировке (`model.ts:220`) и **падение энкодинга `GET /api/model`** (`protocol/groups/model.ts:12`) с путём `time.released` |
| 3 | **`modelID` отсутствует** | обязательное; без него `modelID ?? id` маскирует проблему до момента `module.model(...)`, но схема его требует |
| 4 | **`capabilities` в форме v1** (`{temperature, reasoning, attachment, toolcall, input:{...}, output:{...}, interleaved}`) | v2 ждёт `{tools: boolean, input: string[], output: string[]}`. У v1 `input` — **объект**, и `supportsText` (`model.ts:285-290`) делает `model.capabilities.input.some(...)` → `TypeError: .some is not a function`. `supportsText` вызывается из `Model.default()` (`model.ts:264`). Сейчас не стреляет только потому, что модель уже отфильтрована по `enabled`; **как только `enabled: true` появится — упадёт** |
| 5 | **`cost` — объект, а не массив** | v2: `Schema.Array(Cost)`. `SessionUsage.calculateCost` делает `.filter` по массиву → `costs.filter is not a function` в момент учёта токенов |
| 6 | **`variants` — объект `{low,medium,high}`** | v2: массив `{id, settings}`. `model.variants?.find(...)` (`model-resolver.ts:142`) на объекте вернёт `undefined` → вариант не выбирается, `-m ...#high` даст `Variant unavailable` |
| 7 | `api: {id,url,npm}` внутри модели | в v2 такого поля в `Model.Info` нет: `Info` — обычный `Schema.Struct` (`schema/model.ts:123`), лишний ключ при кодировании просто игнорируется. Адрес двери живёт в `Provider.Info.settings.baseURL` |

`package` и `name` в `Provider.Info` уже заполняются (`plugin-v2.ts:72-78`), `package` берётся из v1 `npm`
= `file://…/dist/provider.js`. Это **не** `aisdk:`-префикс, значит пойдёт нативный путь (`provider.ts:25-33`).

---

## 7. Таблица соответствия: v1 `ModelMetadata` → v2 `Model.Info`

v1-источник: `packages/opencode-claude/index.ts:445-497` (объект, который реально уезжает в провайдера)
и `ModelMetadata` из `/home/relishev/projects/vibe/claude-code-sdk/src/models.ts:30-75`
(реэкспортируется как `MAX_MODELS` из `@life-ai-tools/claude-code-sdk`, импорт — `index.ts:71`).
Для `claude-sonnet-5` запись там: `/home/relishev/projects/vibe/claude-code-sdk/src/models.ts:169-178`
(`context: 1_000_000`, `defaultOutput: 64_000`, `maxOutput: 128_000`, `adaptiveThinking: true`,
`samplingParams: false`, `cost: {input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75}`).

| v1 поле (index.ts) | v2 поле (`Model.Info`) | Преобразование |
|---|---|---|
| `id` | `id` | как есть |
| — | `modelID` | **добавить**: `= id` (или API-id, если отличается — сейчас совпадает) |
| `providerID: 'claude-max'` | `providerID` | как есть (перезапишется в `index()` всё равно) |
| `name` | `name` | как есть |
| `api: {id,url,npm}` | — | **удалить**; `url` → `Provider.Info.settings.baseURL`, `npm` → `Provider.Info.package` |
| `reasoning: boolean` | `compatibility.reasoningField` | v1 `true` → v2 не имеет булева «reasoning»; смысл передаётся через `compatibility` и `variants` |
| `capabilities.toolcall` | `capabilities.tools` | `toolcall → tools` |
| `capabilities.input: {text,image,pdf,...}` | `capabilities.input: string[]` | собрать массив из true-ключей: `['text','image','pdf']` |
| `capabilities.output: {...}` | `capabilities.output: string[]` | `['text']` |
| `modalities: {input,output}` | (поглощено) | `modalities` в v2 нет; **единственный источник** — `capabilities.input/output`. v1 клал `['text','image','pdf']` |
| `capabilities.temperature` | — | поля нет; не переносится |
| `capabilities.reasoning` | — | не переносится (см. `compatibility`) |
| `capabilities.attachment` | — | выражается через `capabilities.input` |
| `capabilities.interleaved` | `compatibility.reasoningField` | `{field:'reasoning_content'}` → `'reasoning_content'` |
| `cost: {input, output, cache:{read,write}}` | `cost: [ {input, output, cache:{read,write}} ]` | **обернуть в массив**; значения — USD за 1M токенов (как и было в v1) |
| `limit: {context, output}` | `limit: {context, output}` | как есть (`context` обязателен, `output` обязателен). Берётся из `ModelMetadata.context` / `.defaultOutput` |
| `ModelMetadata.maxOutput` (`128_000`) | — | поля-потолка в v2 нет: `limit.output` — единственный потолок вывода. Сейчас v1 тоже кладёт `defaultOutput`, а не `maxOutput` |
| `ModelMetadata.adaptiveThinking` | `variants` + `compatibility` | прямого булева поля нет; включает `variants` и `compatibility.reasoningField` |
| `ModelMetadata.samplingParams` | — | в v2 на уровне модели не решается; это дело пакета провайдера |
| `status: 'active'` | `status` | как есть |
| `options: {}` | `settings: {}` | переименовать (или убрать) |
| `headers: {}` | `headers` | как есть (пустой можно убрать) |
| `variants: {low:{thinking:{type,budgetTokens}}, …}` | `variants: [ {id:'low', settings:{thinking:{type:'enabled',budgetTokens:5000}}}, … ]` | **объект → массив**; `thinking` уходит внутрь `settings` — ровно так его строит сам v2 (`packages/core/src/variant.ts:71-75`) |
| — | **`time: {released: <number>}`** | **добавить обязательно**; `0` при неизвестности. Строку убрать |
| — | **`enabled: true`** | **добавить обязательно** |
| — | `family` | опционально (`'sonnet'`, `'opus'`) — нужно только `Model.small` |
| — | `package` | опционально; наследуется от провайдера (`model.ts:201`) |

`Provider.Info` из v1-провайдера (`index.ts:432-439`):

| v1 | v2 |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `api` | `settings.baseURL` |
| `npm` | `package` (обязательное) |
| `env: []` | — (поля нет) |
| `models: {}` | — (модели отдельным массивом в `add`) |
| — | `activation: 'auto'` |

---

## 8. Минимальный валидный JSON для `claude-sonnet-5`

Ровно то, что нужно, чтобы `-m claude-max/claude-sonnet-5` прошёл поиск в `available()`
и не сломал `GET /api/model`.

```json
{
  "info": {
    "id": "claude-max",
    "name": "Claude Max/Pro",
    "activation": "auto",
    "package": "file:///home/relishev/projects/vibe/claude-code-sdk/packages/opencode-claude/dist/provider.js",
    "settings": { "baseURL": "https://api.anthropic.com" }
  },
  "models": [
    {
      "id": "claude-sonnet-5",
      "modelID": "claude-sonnet-5",
      "providerID": "claude-max",
      "name": "Claude Sonnet 5 (Max)",
      "capabilities": { "tools": true, "input": ["text", "image", "pdf"], "output": ["text"] },
      "variants": [],
      "time": { "released": 0 },
      "cost": [],
      "status": "active",
      "enabled": true,
      "limit": { "context": 1000000, "output": 64000 }
    }
  ]
}
```

Это минимум **по схеме**: `cost: []` валиден (`SessionUsage.calculateCost` вернёт `Money.USD.zero`,
`session/usage.ts:28`), `variants: []` валиден (`model-resolver.ts:142` даст `undefined` → вариант «по умолчанию»).

Чтобы каталог ещё и показывал цену и работали варианты — те же объекты, но:

```json
{
  "cost": [{ "input": 3, "output": 15, "cache": { "read": 0.3, "write": 3.75 } }],
  "variants": [
    { "id": "low",    "settings": { "thinking": { "type": "enabled", "budgetTokens": 5000 } } },
    { "id": "medium", "settings": { "thinking": { "type": "enabled", "budgetTokens": 16000 } } },
    { "id": "high",   "settings": { "thinking": { "type": "enabled", "budgetTokens": 32000 } } }
  ]
}
```

(числа `cost` — метаданные каталога для отображения, не биллинг-утверждение.)

Эквивалент в коде плагина (короче и безопаснее — все обязательные поля приходят от самой платформы):

```ts
import { Model, Provider } from '@opencode/plugin'

const base = Model.Info.default(Provider.ID.make(id), Model.ID.make(id))
const model = {
  ...base,
  name: `${info.name} (Max)`,
  capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'] },
  limit: { context: info.context, output: info.defaultOutput },
  cost: [{ input: info.cost.input, output: info.cost.output,
           cache: { read: info.cost.cacheRead, write: info.cost.cacheWrite } }],
}
```

---

## 9. Что сломается СЛЕДУЮЩИМ (после починки метаданных)

Это за границей вопроса, но проверено по коду и всплывёт на первом же реальном ходе.

`ModelUnavailableError` — только поиск. Следующий шаг — `ModelResolver.resolveCatalogModel`
(`packages/core/src/model-resolver.ts:196-257`). Для `package`, **не** начинающегося с `aisdk:`:

```ts
const specifier = Provider.packageName(resolved.package)     // :219 — вернёт строку как есть
...
const module = yield* (dependencies?.loadPackage ?? Provider.loadPackage)(specifier)   // :222
...
const runtime = module.model(resolved.modelID ?? resolved.id, settings)                // :234
```

`Provider.loadPackage` (`packages/core/src/provider.ts:126-138`) **явно принимает `file://`**
(`if (specifier.startsWith("file://") || ...) return specifier`), так что загрузка нашего модуля
должна пройти.

Но контракт модуля — `packages/ai/src/provider-package.ts:14-20`:

```ts
export interface Definition<...> {
  readonly model: (modelID: string, settings: ProviderSettings) => LanguageModel<Options, Compact>
}
```

Наш `dist/provider.js` экспортирует `createClaudeMax()` → `{ languageModel(modelId) }`
(`packages/opencode-claude/provider.ts:1503`, `dist/provider.js` — финальный `export { …, createClaudeMax, … }`).
**Функции `model` там нет.**

Значит после починки `Model.Info` ожидаемый следующий отказ —
`ModelInitializationError: Cannot initialize claude-max/claude-sonnet-5: <причина>`
(фаза `construct`, `model-resolver.ts:247-255`), а не `Model unavailable`.

Два честных пути (выбор — решение владельца порта):

1. **Нативный пакет:** добавить в `provider.ts` (или отдельный entrypoint) экспорт
   `model(modelID, settings)`, который оборачивает `createClaudeMax().languageModel(modelID)`
   в `LanguageModel`. `package` остаётся `file://…/dist/provider.js`.
2. **AI SDK-путь:** `package: "aisdk:<что-то>"` **плюс** регистрация SDK из плагина через
   `ctx.aisdk.hook('sdk', …)`. Без хука будет `No AISDK provider plugin returned an SDK`
   (`packages/core/src/aisdk.ts:346-350`) — то есть `aisdk:`-префикс сам по себе модуль не загружает.

---

## 10. Чего подтвердить не удалось

1. **Точная форма текста ошибки с `rH.time.released`.** Путь `time.released` соответствует
   `Model.Info.time.released` (`packages/schema/src/model.ts:135-137`), а единственная дверь, где
   этот путь может дать отказ, — энкодер `GET /api/model` (`packages/protocol/src/groups/model.ts:12`).
   Но воспроизвести рендер ошибки в компилированном бинаре нельзя: `opencode2` по условию задачи
   не запускался, а рендеринг пути выполняет сам `effect`-энкодер. Токен `rH` — это, судя по всему,
   минифицированный `Model.Info`; **сам факт минификации я не проверял**.
2. **Файл лога на этой машине.** Путь `$XDG_DATA_HOME/opencode/log/opencode-<channel>.log` выведен
   из `packages/util/src/observability/logging.ts:63-66` и `packages/util/src/global.ts:21`.
   В `~/.local/share/opencode/log/` сейчас лежат только старые v1-файлы вида `2026-06-15T071518.log`;
   `opencode-local.log` не создан, потому что v2 в этой сессии не запускался. **Существование
   именно этого имени файла на живой машине не подтверждено.**
3. **Поведение `Schema.Finite` на строке** (падает vs со-erce) взято из определения схемы
   (`packages/schema/src/money.ts:6-16`, `packages/schema/src/model.ts:136`): `Schema.Finite` —
   число с проверкой конечности. Прогнать `effect`-декодер не мог: монорепо клонирован без
   `node_modules`, а устанавливать зависимости запрещено.
4. **Семантика `settings.thinking` для нативного пакета.** Что v2 передаёт `settings` в
   `module.model(id, settings)` — подтверждено (`model-resolver.ts:234`); что наш `provider.ts`
   читает оттуда `thinking` — **не проверял**, это уже контракт самого пакета.
5. **Порядок активации плагина относительно разрешения модели в `run`.** `POST /session` плагинов
   НЕ ждёт (`packages/server/src/handlers/session.ts:134` только сохраняет ref), а `awaitPlugins`
   стоит только в `handlers/model.ts:13,21` и `handlers/generate.ts:21` (`packages/server/src/location.ts:36-47`,
   таймаут 5 с → 503 `Location plugins did not finish activating`). Разрешение происходит позже,
   в ходе, поэтому «гонка регистрации» как объяснение `Model unavailable` **менее вероятна, чем
   отсутствие `enabled`**, но живым прогоном я это не разделял.
