export const PROVIDER_ID = "qwen-portal"
export const PROVIDER_NAME = "Qwen Portal"
export const DEFAULT_MODEL_ID = "coder-model"
export const FULL_DEFAULT_MODEL_ID = `${PROVIDER_ID}/${DEFAULT_MODEL_ID}`
export const OAUTH_DUMMY_KEY = "qwen-oauth"
export const DEFAULT_CONTEXT_WINDOW = 128000
export const DEFAULT_MAX_OUTPUT = 8192

export const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai"
export const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`
export const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`
export const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56"
export const QWEN_OAUTH_SCOPE = "openid profile email model.completion"
export const QWEN_OAUTH_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
export const QWEN_OAUTH_REFRESH_GRANT_TYPE = "refresh_token"

export type QwenStoredAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  resourceUrl: string
  accountEmail?: string
}

export type QwenDeviceAuthorization = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

export type QwenTokenPayload = {
  access_token?: string | null
  refresh_token?: string | null
  expires_in?: number | null
  token_type?: string | null
  resource_url?: string | null
  email?: string | null
  error?: string
  error_description?: string
  interval?: number
}

export type QwenOAuthTokens = {
  access: string
  refresh: string
  expiresAt: number
  resourceUrl: string
  accountEmail?: string
}
