# OpenCode 2.0: контракт регистрации провайдера и моделей (замер 26.10.2026)

Читал ИСХОДНИКИ, а не доки: `github.com/anomalyco/opencode`, ветка **`dev`** (default branch — не `main`).
Файлы скачаны по путям ниже; строки указаны по версии на 26.10.2026.

## Где живёт контракт

- `packages/core/src/config/plugin/provider.ts` (270 строк) — единственное место, где провайдер и модели
  попадают в реестр. Экспортируется как `ConfigProviderPlugin`.
- `packages/schema/src/model.ts` — `Model.Info` (142 строки).
- `packages/schema/src/config/provider.ts` — `ConfigProvider.Info` (описание провайдера из конфига).

## Как это устроено

Регистрация идёт НЕ через `reg.models.set` и не через отдельный «registry API», а через **три
последовательных transform-прохода**, которые вызываются на документах конфига:

```ts
ctx.integration.transform(integrations => …)  // провайдер как «интеграция» + способ входа (key/env)
ctx.provider.transform(providers   => …)      // провайдер + его модели (overlay поверх каталога)
ctx.model.transform(models         => …)      // модельные оверрайды (пределы, варианты, дефолт)
```

Источник записей — `configuredProviders(loaded.entries)`: каждый документ конфига отдаёт
`file.info.providers`, то есть **плагин объявляет провайдера как документ конфига**, а не как объект в рантайме.

### Модели (provider.ts:63-88)

```ts
for (const [id, config] of Object.entries(item.models ?? {})) {
  const base = source?.models.get(config.modelID ?? id) ?? source?.models.get(id)
  const inherit = changed || !current?.models.has(id)
  definitions.set(id, { inherit, base: base && structuredClone(base) })
  if (!inherit) continue
  providers.models.update(providerID, id, (model) => {
    if (base) Object.assign(model, structuredClone(base))
    if (item.package !== undefined) model.package = undefined
  })
}
```

Читать это надо так:

1. **`modelID` — это ссылка на модель КАТАЛОГА провайдера.** Если её не указать, берётся ключ `id`.
   Именно поэтому v1-карточка «своё имя → чужой каталог» ложится на `modelID` один в один.
2. **`base` клонируется из каталога** — то есть не нужно описывать всё заново: описывается дельта.
3. **`inherit`** = «документ изменился ИЛИ такой модели у провайдера ещё нет». Новая модель получает
   `base` (если он найден), существующая — нет.
4. **`item.package`** обнуляет пакет модели: это и есть «эта запись ходит своим путём».
5. **`item.settings.baseURL`** заменяет per-model endpoint у ВСЕХ моделей провайдера (provider.ts:79-84).

### `Model.Info` (schema/src/model.ts:100-140)

```ts
{ id, name, capabilities, variants, cost: [...], limit: { context, output }, … }
```

Дефолт, который подставляет схема (model.ts:127-139): `name = id`, `capabilities = default`,
`variants = []`, `cost = []`, `limit = { context: 200_000, output: 32_000 }`.

То есть обязательный минимум для собственной модели — `id` и всё; остальное имеет дефолты,
а `limit`/`capabilities`/`cost` накладываются оверрайдами (`provider.ts:88-96` — пределы,
`provider.ts:115-145` — варианты и reasoning).

## Что это значит для порта плагинов (задача 4e17b6a2)

Прежний блокер «`-m claude-max/...` → `Model unavailable`, и сообщение маскирует любую ошибку
построения модели» снимается так:

1. Плагин объявляет провайдера **документом конфига**: `providers: { "claude-max": { name, env?, models: {…} } }`.
2. Для каждой модели, которая у нас — алиас чужой, ставится `modelID` = имя модели каталога;
   так v1-шный маппинг `ModelMetadata` → модель провайдера переносится без переизобретения.
3. Наши собственные поля (`limit`, `capabilities`, `cost`) ставим оверрайдами, не копией каталога.
4. `models.default` пишется в `ctx.model.transform` (`provider.ts:110-112`) — там же место дефолтной модели.

## Границы этого замера

- Читал `dev` на 26.10.2026; ветка движется, при реализации сверить пути и номера строк.
- `ConfigProvider.Info` (schema/config/provider.ts) не читал построчно — только по использованию:
  `name`, `env`, `models`, `package`, `settings.baseURL`. Перед реализацией прочитать целиком.
- Доков v2 (`opencode.ai/v2/docs/plugins`) не касался: там про реестр провайдера молчит, что и было записано ранее.
