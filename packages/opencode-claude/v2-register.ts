/**
 * v2-register — запись v1-провайдера в реестр OpenCode 2.0.
 *
 * Вынесено из `plugin-v2.ts` отдельным швом, чтобы провал регистрации можно было
 * проверить испытанием: раньше `try/catch` вокруг `reg.add` глотал ошибку, и
 * единственным следом оставался необязательный файл отладки. Теперь любая неудача
 * называет себя (текст ошибки + провайдер + модель) через `onError`, а `reg.add`
 * пробрасывает исключение дальше — платформа сама отключит плагин вслух
 * (`core/src/plugin.ts:48-57`, `state.ts:178-187`).
 */
import { toV2Model, toV2Provider, type V1ModelLike, type V1ProviderLike, type V2ModelInfo } from './v2-model'

/** Минимум, который нам нужен от `ProviderEditor` (`packages/plugin/src/promise/provider.ts:5-28`). */
export interface ProviderEditorLike {
  add(definition: { info: unknown; models: readonly V2ModelInfo[] }): void
}

export interface RegisterOptions {
  /** Чем регистрировать: `aisdk:<specifier>` или `file://…`. */
  packageName: string
  /** Обязательный канал ошибок — не глушится и не зависит от env. */
  onError(message: string): void
  /** Необязательная диагностика успеха. */
  onDebug?(message: string): void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * @returns сколько моделей зарегистрировано (0 — регистрация не состоялась, причина в `onError`).
 * @throws если `reg.add` бросил: провал записи в реестр не лечится повторной попыткой.
 */
export function registerV2Provider(
  editor: ProviderEditorLike,
  providerId: string,
  v1Provider: V1ProviderLike,
  options: RegisterOptions,
): number {
  const rawModels = (v1Provider?.models ?? {}) as Record<string, V1ModelLike>
  const models: V2ModelInfo[] = []
  for (const [modelId, raw] of Object.entries(rawModels)) {
    try {
      models.push(toV2Model(raw, providerId))
    } catch (err) {
      options.onError(`model map failed ${providerId}/${modelId}: ${errorText(err)}`)
    }
  }
  if (models.length === 0) {
    options.onError(
      `registration skipped ${providerId}: no valid models (v1 models=${Object.keys(rawModels).length})`,
    )
    return 0
  }

  let info: ReturnType<typeof toV2Provider>
  try {
    info = toV2Provider(v1Provider, { id: providerId, package: options.packageName })
  } catch (err) {
    options.onError(`provider map failed ${providerId}: ${errorText(err)}`)
    return 0
  }

  const first = models[0]?.id ?? '-'
  try {
    editor.add({ info, models })
  } catch (err) {
    options.onError(
      `add failed ${providerId} models=${models.length} first=${first} package=${info.package}: ${errorText(err)}`,
    )
    throw err
  }
  options.onDebug?.(`add ok ${providerId} models=${models.length} first=${first} package=${info.package}`)
  return models.length
}
