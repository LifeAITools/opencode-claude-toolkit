import {
  QWEN_OAUTH_CLIENT_ID,
  QWEN_OAUTH_REFRESH_GRANT_TYPE,
  QWEN_OAUTH_TOKEN_ENDPOINT,
  type QwenOAuthTokens,
  type QwenTokenPayload,
} from "./types.js"

function toFormUrlEncoded(data: Record<string, string>): string {
  return new URLSearchParams(data).toString()
}

export async function refreshTokens(
  refreshToken: string,
  previous: { resourceUrl: string; accountEmail?: string },
): Promise<QwenOAuthTokens> {
  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toFormUrlEncoded({
      grant_type: QWEN_OAUTH_REFRESH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as QwenTokenPayload

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Qwen OAuth refresh failed.")
  }

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Qwen OAuth refresh returned an incomplete token payload.")
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token || refreshToken,
    expiresAt: Date.now() + payload.expires_in * 1000,
    resourceUrl: payload.resource_url || previous.resourceUrl,
    accountEmail: payload.email ?? previous.accountEmail,
  }
}
