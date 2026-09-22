import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_MODEL_ID,
  FULL_DEFAULT_MODEL_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./types.js"

export function buildProviderConfig() {
  return {
    api: "https://portal.qwen.ai/v1",
    npm: "@ai-sdk/openai-compatible",
    name: PROVIDER_NAME,
    options: {},
    models: {
      [DEFAULT_MODEL_ID]: {
        name: "Qwen Coder",
        release_date: "2026-04-01",
        cost: {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        },
        limit: {
          context: DEFAULT_CONTEXT_WINDOW,
          output: DEFAULT_MAX_OUTPUT,
        },
      },
    },
  }
}

export function applySubscriptionCost(provider: { models?: Record<string, any> }) {
  if (!provider.models) return
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    }
  }
}

export function filterModels(provider: { models?: Record<string, any> }) {
  if (!provider.models) return
  for (const modelId of Object.keys(provider.models)) {
    if (modelId !== DEFAULT_MODEL_ID && modelId !== FULL_DEFAULT_MODEL_ID) {
      delete provider.models[modelId]
    }
  }
}

export const providerMetadata = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  defaultModel: FULL_DEFAULT_MODEL_ID,
}
