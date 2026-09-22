import { OAUTH_DUMMY_KEY } from "./types.js"

export function normalizeBaseURL(resourceUrl: string): string {
  const trimmed = resourceUrl.trim()
  if (!trimmed) {
    throw new Error("Qwen OAuth returned no resource_url. Reauthenticate and inspect the token payload.")
  }

  const withProtocol = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`
  const withoutTrailingSlash = withProtocol.replace(/\/+$/, "")
  return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`
}

export function cloneHeaders(init?: RequestInit): Headers {
  const headers = new Headers()
  if (!init?.headers) return headers

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value))
    return headers
  }

  if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      headers.set(key, value)
    }
    return headers
  }

  for (const [key, value] of Object.entries(init.headers)) {
    if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

export function stripProviderAuthHeaders(headers: Headers) {
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.delete("x-api-key")
  headers.delete("X-API-Key")
}

export function rewriteRequestUrl(input: string | URL | Request, baseURL: string): URL {
  const requestUrl =
    input instanceof URL ? new URL(input.href) : new URL(typeof input === "string" ? input : input.url)

  const nextUrl = new URL(baseURL)

  if (requestUrl.pathname.includes("/chat/completions")) {
    nextUrl.pathname = "/v1/chat/completions"
    return nextUrl
  }

  if (requestUrl.pathname.includes("/responses")) {
    nextUrl.pathname = "/v1/responses"
    return nextUrl
  }

  if (requestUrl.pathname.startsWith("/v1/")) {
    nextUrl.pathname = requestUrl.pathname
    nextUrl.search = requestUrl.search
    return nextUrl
  }

  nextUrl.pathname = "/v1/chat/completions"
  return nextUrl
}

export function buildLoaderResult(baseURL: string, fetchImpl: typeof fetch) {
  return {
    baseURL,
    apiKey: OAUTH_DUMMY_KEY,
    fetch: fetchImpl,
  }
}
