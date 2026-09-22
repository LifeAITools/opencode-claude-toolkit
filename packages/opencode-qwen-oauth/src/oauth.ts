import { createHash, randomBytes, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import {
  QWEN_OAUTH_CLIENT_ID,
  QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
  QWEN_OAUTH_DEVICE_GRANT_TYPE,
  QWEN_OAUTH_SCOPE,
  QWEN_OAUTH_TOKEN_ENDPOINT,
  type QwenDeviceAuthorization,
  type QwenOAuthTokens,
  type QwenTokenPayload,
} from "./types.js"

function toFormUrlEncoded(data: Record<string, string>): string {
  return new URLSearchParams(data).toString()
}

export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export async function requestDeviceCode(challenge: string): Promise<QwenDeviceAuthorization> {
  const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-request-id": randomUUID(),
    },
    body: toFormUrlEncoded({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to start Qwen device authorization: ${await response.text() || response.statusText}`)
  }

  const payload = (await response.json()) as QwenDeviceAuthorization
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new Error("Qwen device authorization returned an incomplete payload.")
  }
  return payload
}

function parseTokenPayload(payload: QwenTokenPayload): QwenOAuthTokens {
  if (!payload.access_token || !payload.refresh_token || !payload.expires_in || !payload.resource_url) {
    throw new Error("Qwen OAuth returned an incomplete token payload.")
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    resourceUrl: payload.resource_url,
    accountEmail: payload.email ?? undefined,
  }
}

export async function pollForTokens(deviceCode: string, verifier: string, intervalSeconds = 5, expiresInSeconds = 900) {
  const startedAt = Date.now()
  let pollDelayMs = Math.max(intervalSeconds, 1) * 1000
  const timeoutAt = startedAt + expiresInSeconds * 1000

  while (Date.now() < timeoutAt) {
    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: toFormUrlEncoded({
        grant_type: QWEN_OAUTH_DEVICE_GRANT_TYPE,
        client_id: QWEN_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        code_verifier: verifier,
      }),
    })

    const payload = (await response.json().catch(() => ({}))) as QwenTokenPayload

    if (response.ok) {
      return parseTokenPayload(payload)
    }

    if (payload.error === "authorization_pending") {
      await sleep(pollDelayMs)
      continue
    }

    if (payload.error === "slow_down") {
      pollDelayMs = Math.min((payload.interval ?? intervalSeconds + 5) * 1000, 10000)
      await sleep(pollDelayMs)
      continue
    }

    throw new Error(payload.error_description || payload.error || "Qwen OAuth token polling failed.")
  }

  throw new Error("Qwen OAuth timed out waiting for authorization.")
}

export async function startDeviceAuthorization() {
  const { verifier, challenge } = generatePkce()
  const device = await requestDeviceCode(challenge)
  return {
    verifier,
    device,
    url: device.verification_uri_complete || device.verification_uri,
    instructions: `Open the URL and approve access. If prompted, enter code: ${device.user_code}`,
  }
}
