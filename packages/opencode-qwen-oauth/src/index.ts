import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { ensureRunning } from "@kiberos/proxy-core/launch"
import { buildProviderConfig, applySubscriptionCost, filterModels, providerMetadata } from "./models.js"
import { startDeviceAuthorization, pollForTokens } from "./oauth.js"
import { normalizeBaseURL, cloneHeaders, stripProviderAuthHeaders, rewriteRequestUrl, buildLoaderResult } from "./provider.js"
import { refreshTokens } from "./refresh.js"
import { FULL_DEFAULT_MODEL_ID, PROVIDER_ID, type QwenStoredAuth } from "./types.js"

// Тонкий прокси, через который идёт трафик (учёт usage). REQ-CORE-04: значения из env,
// литералы только как fallback.
const PROXY_BASE = process.env.QWEN_PROXY_BASE ?? "http://127.0.0.1:17100/v1"
const PROXY_HEALTH = PROXY_BASE.replace(/\/v1\/?$/, "") + "/health"
const PROXY_SERVER_PATH =
  process.env.OPENAI_COMPAT_PROXY_SERVER ??
  "/home/relishev/projects/vibe/claude-code-sdk/packages/openai-compat-proxy/src/server.ts"

let proxyStarted = false
async function ensureProxyRunning(): Promise<void> {
  // Авто-старт: прокси поднимается при первом запросе, если ещё не живой.
  if (proxyStarted) return
  await ensureRunning({
    healthUrl: PROXY_HEALTH,
    spawnCmd: [process.execPath ?? "bun", PROXY_SERVER_PATH],
  })
  proxyStarted = true
}

function ensureProviderConfig(config: Config) {
  config.provider ??= {}
  config.provider[PROVIDER_ID] ??= buildProviderConfig()
}

function toStoredAuth(input: any): QwenStoredAuth {
  return {
    type: "oauth",
    access: String(input.access),
    refresh: String(input.refresh),
    expires: Number(input.expires ?? input.expiresAt ?? 0),
    resourceUrl: String(input.enterpriseUrl ?? input.resourceUrl ?? ""),
    accountEmail: input.accountEmail ? String(input.accountEmail) : undefined,
  }
}

export async function QwenPortalAuthPlugin(input: PluginInput): Promise<Hooks> {
  let refreshFailed = false

  return {
    async config(config) {
      ensureProviderConfig(config)
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        filterModels(provider)
        applySubscriptionCost(provider)

        const fetchImpl: typeof fetch = async (requestInput, init) => {
          if (refreshFailed) {
            throw new Error("Qwen OAuth credentials are no longer usable. Log in again for qwen-portal.")
          }

          const currentAuth = toStoredAuth(await getAuth())
          if (currentAuth.type !== "oauth") return fetch(requestInput, init)

          let effectiveAuth = currentAuth
          if (!effectiveAuth.access || effectiveAuth.expires <= Date.now()) {
            try {
              const refreshed = await refreshTokens(effectiveAuth.refresh, {
                resourceUrl: effectiveAuth.resourceUrl,
                accountEmail: effectiveAuth.accountEmail,
              })
              await input.client.auth.set({
                path: { id: PROVIDER_ID },
                body: {
                  type: "oauth",
                  access: refreshed.access,
                  refresh: refreshed.refresh,
                  expires: refreshed.expiresAt,
                  enterpriseUrl: refreshed.resourceUrl,
                  accountEmail: refreshed.accountEmail,
                } as any,
              })
              effectiveAuth = {
                type: "oauth",
                access: refreshed.access,
                refresh: refreshed.refresh,
                expires: refreshed.expiresAt,
                resourceUrl: refreshed.resourceUrl,
                accountEmail: refreshed.accountEmail,
              }
            } catch (error) {
              refreshFailed = true
              throw new Error(
                `Qwen OAuth refresh failed. Reauthenticate for ${PROVIDER_ID}. ${(error as Error).message}`,
              )
            }
          }

          if (!effectiveAuth.resourceUrl) {
            throw new Error("Qwen OAuth credentials are missing resource_url. Reauthenticate for qwen-portal.")
          }

          const baseURL = normalizeBaseURL(effectiveAuth.resourceUrl)
          const headers = cloneHeaders(init)
          stripProviderAuthHeaders(headers)
          headers.set("authorization", `Bearer ${effectiveAuth.access}`)

          // Наводим на локальный тонкий прокси (учёт usage), а не напрямую на Qwen:
          // апстрим-адрес отдаём заголовком, прокси ретранслирует и пишет статистику.
          await ensureProxyRunning()
          headers.set("x-upstream-url", baseURL)
          return fetch(rewriteRequestUrl(requestInput, PROXY_BASE), {
            ...init,
            headers,
          })
        }

        const stored = toStoredAuth(auth)
        return buildLoaderResult(PROXY_BASE, fetchImpl)
      },
      methods: [
        {
          type: "oauth",
          label: "Login with Qwen OAuth",
          async authorize() {
            const authStart = await startDeviceAuthorization()

            return {
              url: authStart.url,
              instructions: authStart.instructions,
              method: "auto" as const,
              callback: async () => {
                const tokens = await pollForTokens(
                  authStart.device.device_code,
                  authStart.verifier,
                  authStart.device.interval ?? 5,
                  authStart.device.expires_in,
                )

                refreshFailed = false

                return {
                  type: "success" as const,
                  provider: PROVIDER_ID,
                  access: tokens.access,
                  refresh: tokens.refresh,
                  expires: tokens.expiresAt,
                  enterpriseUrl: tokens.resourceUrl,
                  accountEmail: tokens.accountEmail,
                } as any
              },
            }
          },
        },
      ],
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `Provider hint: ${providerMetadata.id} uses subscription-backed OAuth access and exposes ${FULL_DEFAULT_MODEL_ID} in v1.`,
      )
    },
  }
}

export default {
  id: "opencode-qwen-oauth-auth",
  server: QwenPortalAuthPlugin,
}
