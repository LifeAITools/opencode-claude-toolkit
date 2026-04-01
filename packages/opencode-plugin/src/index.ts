/**
 * OpenCode Plugin — Claude Max/Pro Provider
 *
 * Enables Claude Max/Pro subscription models in opencode via OAuth.
 * Each opencode instance maintains its own credentials in memory,
 * isolated from other processes.
 *
 * Features:
 * - OAuth login via browser (PKCE flow, same as Claude CLI)
 * - Automatic token refresh (in-memory, no file watch needed)
 * - Per-project credentials (CWD-based .credentials.json)
 * - Zero cost display (subscription-included)
 * - Secure: tokens held in closure memory, not globals
 *
 * Install:
 *   opencode plugin @life-ai-tools/opencode-claude
 *
 * Login:
 *   opencode providers login -p anthropic
 */

import { createHash, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

// ─── OAuth Constants (matching Claude CLI exactly) ─────────

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTH_BASE = 'https://platform.claude.com'
const AUTH_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/v1/oauth/token`
const MANUAL_REDIRECT_URI = `${AUTH_BASE}/oauth/code/callback`
const API_BASE = 'https://api.anthropic.com'

const SCOPES = [
  'user:profile',
  'user:inference',
  'org:create_api_key',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ')

// 5 min buffer before actual expiry — matches CLI
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

// Models available via Max/Pro subscription
const MAX_MODELS: Record<string, { name: string; context: number; output: number }> = {
  'claude-sonnet-4-6-20250415': { name: 'Claude Sonnet 4.6', context: 200000, output: 16384 },
  'claude-opus-4-6-20250415': { name: 'Claude Opus 4.6', context: 200000, output: 16384 },
  'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', context: 200000, output: 8192 },
}

// Beta headers — matching CLI
const CLAUDE_CODE_BETA = 'claude-code-2025-01-01'
const PROMPT_CACHING_BETA = 'prompt-caching-scope-2026-01-05'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

// ─── PKCE Helpers ──────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

function generateState(): string {
  return base64url(randomBytes(32))
}

// ─── Credential Resolution ─────────────────────────────────
// Priority:
//   1. CWD/.claude/.credentials.json (per-project)
//   2. CWD/.credentials.json (simple per-project)
//   3. ~/.claude/.credentials.json (global default)

function resolveCredentialsPath(cwd: string): string {
  const candidates = [
    join(cwd, '.claude', '.credentials.json'),
    join(cwd, '.credentials.json'),
    join(homedir(), '.claude', '.credentials.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // Default to global path (will be created on login)
  return join(homedir(), '.claude', '.credentials.json')
}

function readCredentials(path: string): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const oauth = data.claudeAiOauth
    if (!oauth?.accessToken) return null
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? 0,
    }
  } catch {
    return null
  }
}

function saveCredentials(path: string, creds: { accessToken: string; refreshToken: string; expiresAt: number }) {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { /* new file */ }
  existing.claudeAiOauth = creds
  const dir = dirname(path)
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  writeFileSync(path, JSON.stringify(existing, null, 2), 'utf8')
  try { chmodSync(path, 0o600) } catch { /* windows */ }
}

// ─── Plugin Export ─────────────────────────────────────────

export default {
  id: 'opencode-claude-max',
  server: async (input: any) => {
    const cwd = input.directory ?? process.cwd()
    const credPath = resolveCredentialsPath(cwd)

    // ─── Secure In-Memory Token Store ──────────────────────
    // Tokens live in this closure only. No globals, no exports.
    // Each opencode instance gets its own isolated copy.

    let accessToken: string | null = null
    let refreshToken: string | null = null
    let expiresAt = 0
    let refreshPromise: Promise<void> | null = null

    // Load from file initially
    const stored = readCredentials(credPath)
    if (stored) {
      accessToken = stored.accessToken
      refreshToken = stored.refreshToken
      expiresAt = stored.expiresAt
    }

    function isExpired(): boolean {
      return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
    }

    async function refreshTokenIfNeeded(): Promise<void> {
      if (!isExpired() && accessToken) return
      if (!refreshToken) throw new Error('No refresh token — run `opencode providers login -p anthropic`')

      // Dedup concurrent refreshes
      if (refreshPromise) { await refreshPromise; return }

      refreshPromise = (async () => {
        // Re-read from file — another process may have refreshed
        const fresh = readCredentials(credPath)
        if (fresh && !((Date.now() + EXPIRY_BUFFER_MS) >= fresh.expiresAt)) {
          accessToken = fresh.accessToken
          refreshToken = fresh.refreshToken
          expiresAt = fresh.expiresAt
          return
        }

        // Do refresh
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
            scope: SCOPES,
          }),
        })

        if (!res.ok) {
          const body = await res.text()
          throw new Error(`Token refresh failed (${res.status}): ${body}`)
        }

        const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number }
        accessToken = data.access_token
        refreshToken = data.refresh_token
        expiresAt = Date.now() + (data.expires_in * 1000)

        // Persist
        saveCredentials(credPath, { accessToken, refreshToken, expiresAt })
      })().finally(() => { refreshPromise = null })

      await refreshPromise
    }

    // Generate fingerprint — matches CLI
    const deviceId = randomBytes(64).toString('hex')

    return {
      // ─── Config: inject Claude Max provider + models ─────
      config: async (config: any) => {
        if (!config.provider) config.provider = {}

        config.provider['anthropic'] = {
          ...config.provider['anthropic'],
          id: 'anthropic',
          name: 'Anthropic (Claude Max/Pro)',
          api: API_BASE,
          npm: '@ai-sdk/anthropic',
          models: {},
        }

        for (const [id, info] of Object.entries(MAX_MODELS)) {
          config.provider['anthropic'].models[id] = {
            id,
            name: info.name,
            api: { id, url: API_BASE, npm: '@ai-sdk/anthropic' },
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: info.context, output: info.output },
            status: 'active',
            options: {},
            headers: {},
          }
        }
      },

      // ─── Auth: OAuth login + token management ────────────
      auth: {
        provider: 'anthropic',

        // Called at startup — inject SDK options with live token
        loader: async (getAuth: () => Promise<any>, provider: any) => {
          // Zero out costs for all models (subscription-included)
          for (const model of Object.values(provider.models ?? {}) as any[]) {
            if (model.cost) {
              model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
            }
          }

          return {
            apiKey: 'oauth-managed', // Dummy — real auth via custom fetch

            // Custom fetch — injects OAuth bearer token per-request
            async fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
              await refreshTokenIfNeeded()

              const headers = new Headers(init?.headers)

              // Remove dummy API key header, inject real OAuth
              headers.delete('x-api-key')
              headers.set('Authorization', `Bearer ${accessToken}`)

              // Add required Anthropic headers (matching CLI exactly)
              headers.set('anthropic-version', '2023-06-01')
              headers.set('anthropic-dangerous-direct-browser-access', 'true')

              // Beta features
              const betas = [CLAUDE_CODE_BETA, PROMPT_CACHING_BETA, INTERLEAVED_THINKING_BETA]
              headers.set('anthropic-beta', betas.join(','))

              // Fingerprint
              headers.set('x-device-id', deviceId)

              return fetch(request, { ...init, headers })
            },
          }
        },

        // Login methods shown in `opencode providers login`
        methods: [
          {
            type: 'oauth' as const,
            label: 'Login with Claude Max/Pro (browser)',
            async authorize() {
              const codeVerifier = generateCodeVerifier()
              const codeChallenge = generateCodeChallenge(codeVerifier)
              const state = generateState()

              // Start localhost callback server
              let resolveCode: (code: string) => void
              let rejectCode: (err: Error) => void
              const codePromise = new Promise<string>((resolve, reject) => {
                resolveCode = resolve
                rejectCode = reject
              })

              const server = Bun.serve({
                port: 0,
                fetch(req) {
                  const url = new URL(req.url)
                  if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })

                  const code = url.searchParams.get('code')
                  const st = url.searchParams.get('state')
                  const error = url.searchParams.get('error')

                  if (error) {
                    rejectCode!(new Error(`OAuth error: ${error}`))
                    return new Response('<h1>Login failed</h1><p>Close this tab.</p>', {
                      status: 400, headers: { 'Content-Type': 'text/html' },
                    })
                  }

                  if (!code || st !== state) {
                    rejectCode!(new Error('Invalid callback'))
                    return new Response('Invalid', { status: 400 })
                  }

                  resolveCode!(code)
                  return new Response(null, {
                    status: 302,
                    headers: { Location: `${AUTH_BASE}/oauth/code/success?app=claude-code` },
                  })
                },
              })

              const callbackPort = server.port!
              const redirectUri = `http://localhost:${callbackPort}/callback`

              const params = new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: SCOPES,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                state,
                code: 'true',
              })

              const authUrl = `${AUTH_URL}?${params.toString()}`

              // Timeout
              const timeout = setTimeout(() => {
                rejectCode!(new Error('Login timed out (5 min)'))
                server.stop()
              }, 300_000)

              return {
                url: authUrl,
                instructions: 'Complete the login in your browser. The page will redirect automatically.',
                method: 'auto' as const,
                async callback() {
                  try {
                    const code = await codePromise

                    // Exchange code for tokens
                    const tokenRes = await fetch(TOKEN_URL, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: redirectUri,
                        client_id: CLIENT_ID,
                        code_verifier: codeVerifier,
                        state,
                      }),
                    })

                    if (!tokenRes.ok) {
                      const body = await tokenRes.text()
                      return { type: 'failed' as const }
                    }

                    const tokenData = await tokenRes.json() as {
                      access_token: string
                      refresh_token: string
                      expires_in: number
                    }

                    const exp = Date.now() + (tokenData.expires_in * 1000)

                    // Store in closure
                    accessToken = tokenData.access_token
                    refreshToken = tokenData.refresh_token
                    expiresAt = exp

                    // Persist to file
                    saveCredentials(credPath, { accessToken, refreshToken, expiresAt: exp })

                    return {
                      type: 'success' as const,
                      access: tokenData.access_token,
                      refresh: tokenData.refresh_token,
                      expires: exp,
                    }
                  } finally {
                    clearTimeout(timeout)
                    server.stop()
                  }
                },
              }
            },
          },
        ],
      },
    }
  },
}
