/**
 * OAuth 2.0 Authorization Code + PKCE flow for Claude.
 * 
 * Mirrors the Claude Code CLI OAuth implementation:
 * - Generates PKCE code_verifier + challenge (S256)
 * - Opens browser to Anthropic's auth page
 * - Listens on localhost for callback with auth code
 * - Exchanges code for access/refresh tokens
 * - Saves credentials to .credentials.json
 * 
 * Usage:
 *   const creds = await oauthLogin({ credentialsPath: '~/.claude/.credentials.json' })
 */

import { createHash, randomBytes } from 'crypto'
import { writeFileSync, readFileSync, mkdirSync, chmodSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import {
  ANTHROPIC_PLATFORM_BASE,
  ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_TOKEN_URL,
  ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI,
} from './anthropic-endpoints.js'
import {
  HEADER_CONTENT_TYPE,
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_TEXT_HTML,
} from './anthropic-headers.js'

// ─── Constants ─────────────────────────────────────────────
// OAuth/console URLs sourced from SSOT (anthropic-endpoints.ts).
// Local aliases retained so existing references stay self-documenting.

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTH_BASE = ANTHROPIC_PLATFORM_BASE
const CONSOLE_AUTH_URL = ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL
const CLAUDE_AI_AUTH_URL = ANTHROPIC_OAUTH_AUTHORIZE_URL
const TOKEN_URL = ANTHROPIC_OAUTH_TOKEN_URL
const MANUAL_REDIRECT_URI = ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI

export function getClaudeConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC')
}

export function getDefaultCredentialsPath(): string {
  return join(getClaudeConfigDir(), '.credentials.json')
}

// Scopes — union of console + claude.ai scopes, deduped, matching CLI exactly
const SCOPES = [
  'user:profile',
  'user:inference',
  'org:create_api_key',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ')

export interface OAuthLoginOptions {
  /** Where to save credentials. Default: ~/.claude/.credentials.json */
  credentialsPath?: string
  /** Port for localhost callback. Default: 0 (OS-assigned) */
  port?: number
  /** Callback when the auth URL is ready — display to user. If not provided, prints to stdout. */
  onAuthUrl?: (url: string, manualUrl: string) => void
  /** Try to open browser automatically. Default: true */
  openBrowser?: boolean
  /** Prefer Claude.ai personal login route (better for Pro/Max users). Default: true */
  loginWithClaudeAi?: boolean
  /** Optional login hint (email) */
  loginHint?: string
  /** Optional login method hint (e.g. sso, google, magic_link) */
  loginMethod?: string
  /** Optional organization UUID for enterprise flows */
  orgUUID?: string
}

export interface OAuthResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialsPath: string
}

// ─── PKCE helpers ──────────────────────────────────────────

function generateCodeVerifier(): string {
  return base64url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

function generateState(): string {
  return base64url(randomBytes(32))
}

function base64url(buf: Buffer): string {
  // Match CLI's base64URLEncode — manual replacement, not Node's base64url
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// ─── Main login flow ──────────────────────────────────────

export async function oauthLogin(options: OAuthLoginOptions = {}): Promise<OAuthResult> {
  const credPath = options.credentialsPath ?? getDefaultCredentialsPath()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  // Start localhost callback server
  const { port: callbackPort, waitForCode, close } = await startCallbackServer(state, options.port)

  const redirectUri = `http://localhost:${callbackPort}/callback`
  const authBaseUrl = options.loginWithClaudeAi !== false
    ? CLAUDE_AI_AUTH_URL
    : CONSOLE_AUTH_URL

  // Build auth URLs
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    code: 'true', // UI hint
  })

  if (options.loginHint) params.set('login_hint', options.loginHint)
  if (options.loginMethod) params.set('login_method', options.loginMethod)
  if (options.orgUUID) params.set('orgUUID', options.orgUUID)

  const autoUrl = `${authBaseUrl}?${params.toString()}&redirect_uri=${encodeURIComponent(redirectUri)}`
  const manualUrl = `${authBaseUrl}?${params.toString()}&redirect_uri=${encodeURIComponent(MANUAL_REDIRECT_URI)}`

  // Notify caller of URLs
  if (options.onAuthUrl) {
    options.onAuthUrl(autoUrl, manualUrl)
  } else {
    console.log('\n🔐 Login to Claude\n')
    console.log('Open this URL in your browser:\n')
    console.log(`  ${manualUrl}\n`)
  }

  // Try to open browser
  if (options.openBrowser !== false) {
    tryOpenBrowser(autoUrl).catch(() => { /* silent fail */ })
  }

  // Wait for auth code (from localhost callback or manual input)
  let authCode: string
  let usedRedirectUri: string
  try {
    authCode = await waitForCode
    usedRedirectUri = redirectUri
  } catch (err) {
    close()
    throw err
  }

  close()

  // Exchange code for tokens
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: usedRedirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  })

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text()
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`)
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
    scope?: string
  }

  const expiresAt = Date.now() + (tokenData.expires_in * 1000)

  // Save credentials via the shared atomic writer (tmp+rename, chmod 0600,
  // preserve-on-null) so the login path and the proxy's active-org co-write
  // path share ONE writer (no drift between the two).
  const creds = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scopes: tokenData.scope?.split(' ') ?? [],
  }
  writeClaudeCredentials(credPath, creds)

  console.log(`\n✅ Login successful! Credentials saved to ${credPath}\n`)

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    credentialsPath: credPath,
  }
}

// ─── .credentials.json read/write (shared, atomic) ─────────────────

/** The `claudeAiOauth` block persisted in `~/.claude/.credentials.json`. */
export interface ClaudeAiOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
}

/**
 * Read the raw `.credentials.json` file. Returns the parsed object (with an
 * optional `claudeAiOauth` block) or `null` when the file is missing/malformed.
 * Fail-soft, never throws.
 */
export function readClaudeCredentials(
  credPath: string = getDefaultCredentialsPath(),
): { claudeAiOauth?: ClaudeAiOAuthCredentials; [k: string]: unknown } | null {
  try {
    return JSON.parse(readFileSync(credPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Atomically persist the `claudeAiOauth` block into `.credentials.json`
 * (tmp+rename + chmod 0600), merging into any existing top-level keys and
 * preserving `subscriptionType`/`rateLimitTier` when the fresh grant returns
 * null for them — byte-for-byte the native CLI's `saveOAuthTokensIfNeeded`
 * preserve-on-null contract (`claude-code-source/src/utils/auth.ts:1217`).
 *
 * The atomic tmp+rename is strictly SAFER than the native in-place write:
 * a concurrent reader (native CLI, opencode) never observes a torn file.
 * Callers that co-write the ACTIVE org MUST hold the config-dir lock
 * (see config-dir-lock.ts) so this write is serialized with the native CLI's
 * own refresh (`lockfile.lock(claudeDir)`).
 */
export function writeClaudeCredentials(
  credPath: string,
  oauth: ClaudeAiOAuthCredentials,
): void {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(readFileSync(credPath, 'utf8')) } catch { /* new file */ }
  const prev = (existing.claudeAiOauth ?? {}) as Partial<ClaudeAiOAuthCredentials>
  existing.claudeAiOauth = {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes ?? prev.scopes,
    // Preserve profile-derived fields the refresh grant doesn't return (null)
    // — clobbering a valid subscription with null would strand paying users.
    subscriptionType: oauth.subscriptionType ?? prev.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? prev.rateLimitTier ?? null,
  }

  const dir = dirname(credPath)
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  const tmp = `${credPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* mode set on create */ }
  renameSync(tmp, credPath)
}

// ─── Localhost callback server ─────────────────────────────

async function startCallbackServer(
  expectedState: string,
  preferredPort?: number,
): Promise<{ port: number; waitForCode: Promise<string>; close: () => void }> {
  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = Bun.serve({
    port: preferredPort ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 })
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        rejectCode(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') ?? ''}`))
        return new Response(
          '<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>',
          { status: 400, headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML } },
        )
      }

      if (!code || state !== expectedState) {
        rejectCode(new Error('Invalid callback: missing code or state mismatch'))
        return new Response('Invalid request', { status: 400 })
      }

      resolveCode(code)

      // Redirect to success page
      return new Response(null, {
        status: 302,
        headers: { Location: `${AUTH_BASE}/oauth/code/success?app=claude-code` },
      })
    },
  })

  // Timeout after 5 minutes
  const timeout = setTimeout(() => {
    rejectCode(new Error('Login timed out (5 minutes). Try again.'))
    server.stop()
  }, 300_000)

  return {
    port: server.port!,
    waitForCode: waitForCode.finally(() => clearTimeout(timeout)),
    close: () => { clearTimeout(timeout); server.stop() },
  }
}

// ─── Browser opener ────────────────────────────────────────

async function tryOpenBrowser(url: string): Promise<void> {
  const commands: string[][] = (() => {
    switch (process.platform) {
      case 'darwin': return [['open', url]]
      case 'win32': return [['cmd', '/c', 'start', url]]
      default: return [
        ['xdg-open', url],
        ['wslview', url],
        ['sensible-browser', url],
      ]
    }
  })()

  for (const cmd of commands) {
    try {
      const proc = Bun.spawn({ cmd, stdout: 'ignore', stderr: 'ignore' })
      await proc.exited
      if (proc.exitCode === 0) return
    } catch { /* try next */ }
  }
}

// ─── OAuth refresh grant (per-org vault support) ───────────────────

/** Result of a refresh-token grant. The refresh token ROTATES — the caller
 *  MUST persist the new one immediately or the org's credential line dies. */
export interface RefreshedTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** Scopes returned by the grant (Anthropic allows scope expansion on refresh). */
  scopes?: string[]
}

/**
 * A refresh-token grant that failed at the HTTP layer. Carries the status +
 * body so the caller can distinguish a REVOKED grant (`400/401 invalid_grant`
 * → the org needs a fresh `claude login`, stop re-forcing) from transient
 * network/5xx noise (keep the entry + retry). Mirrors the expiry-vs-revoke
 * classification the KA force-on-401 backstop needs (architect-review H3).
 */
export class OAuthRefreshError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OAuth refresh failed (${status}): ${body.slice(0, 200)}`)
    this.name = 'OAuthRefreshError'
  }

  /** A revoked / no-longer-valid refresh_token — re-login required, not retryable. */
  get isInvalidGrant(): boolean {
    return (this.status === 400 || this.status === 401) && /invalid_grant/i.test(this.body)
  }
}

/**
 * Exchange a refresh token for a fresh access token (standard OAuth
 * `refresh_token` grant against the same TOKEN_URL/CLIENT_ID as login).
 *
 * Pure network call — does NOT itself touch `~/.claude/.credentials.json`.
 * Persistence is the caller's job and depends on WHICH org this is:
 *   - the ACTIVE org co-writes `.credentials.json` under the native CLI's
 *     config-dir `proper-lockfile` lock (proxy-client `withFreshOrgToken`),
 *     because that file is the native CLI's source of truth and Anthropic
 *     rotates the refresh_token on every grant — writing only the vault would
 *     strand the disk token for the native CLI + every other consumer;
 *   - a non-active VAULT org persists into the per-org `OrgVault` instead.
 * Throws `OAuthRefreshError` (with .status/.isInvalidGrant) on HTTP failure so
 * the caller can distinguish a revoke from transient noise.
 */
export async function refreshOAuthToken(refreshToken: string): Promise<RefreshedTokens> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new OAuthRefreshError(resp.status, body)
  }
  const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
  return {
    accessToken: data.access_token,
    // Some providers omit rotation; Anthropic rotates — fall back to the old one if absent.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(' ') : undefined,
  }
}
