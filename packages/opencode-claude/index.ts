/**
 * OpenCode Plugin — Claude Max/Pro Provider
 *
 * Enables Claude Max/Pro subscription models in opencode via OAuth.
 * Each opencode instance maintains its own credentials isolated
 * in closure memory and per-project credential files.
 *
 * Multi-user simultaneous support:
 * - Each opencode instance runs `server()` separately → own closure
 * - Credential file resolved from CWD → different projects can use different accounts
 * - Token refresh deduped within instance, cross-process aware via file mtime
 * - No shared globals between instances
 *
 * Install:
 *   opencode plugin @life-ai-tools/opencode-claude
 *
 * Login:
 *   opencode providers login -p claude-max
 */

import { createHash, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { setSignalWireServerUrl } from './provider.ts'

// ─── OAuth Constants (matching Claude CLI exactly) ─────────
// Source: src/constants/oauth.ts (PROD_OAUTH_CONFIG)

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTH_BASE = 'https://platform.claude.com'
const AUTH_URL = 'https://claude.com/cai/oauth/authorize'
const TOKEN_URL = `${AUTH_BASE}/v1/oauth/token`
// Route through local proxy which handles OAuth auth
// Proxy replaces x-api-key with Bearer token and adds correct beta headers

// Source: src/constants/oauth.ts:44-51 (CLAUDE_AI_OAUTH_SCOPES + CONSOLE_OAUTH_SCOPES deduped)
const SCOPES = [
  'user:profile',
  'user:inference',
  'org:create_api_key',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ')

const EXPIRY_BUFFER_MS = 5 * 60 * 1000

// Models available via Max/Pro subscription
// Cost per million tokens — equivalent API pricing for savings display.
// Max subscription doesn't bill per-token, but showing equivalent savings
// helps users understand the value of caching.
// Source: https://docs.anthropic.com/en/docs/about-claude/models#model-comparison
const MAX_MODELS: Record<string, { name: string; context: number; output: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = {
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', context: 1000000, output: 16384,
    cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 } },
  'claude-opus-4-6': { name: 'Claude Opus 4.6', context: 1000000, output: 16384,
    cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } },
  'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', context: 200000, output: 8192,
    cost: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
}

// ─── PKCE Helpers ──────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
function generateCodeVerifier(): string { return base64url(randomBytes(32)) }
function generateCodeChallenge(v: string): string { return base64url(createHash('sha256').update(v).digest()) }
function generateState(): string { return base64url(randomBytes(32)) }

// ─── Per-Instance Credential Manager ───────────────────────

class CredentialManager {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private expiresAt = 0
  private lastMtime = 0
  private refreshing: Promise<void> | null = null
  readonly credPath: string

  constructor(cwd: string) {
    // Resolve credential file: CWD-local first, then global
    const candidates = [
      join(cwd, '.claude', '.credentials.json'),
      join(cwd, '.credentials.json'),
      join(homedir(), '.claude', '.credentials.json'),
    ]
    this.credPath = candidates.find(p => existsSync(p))
      ?? join(homedir(), '.claude', '.credentials.json')

    this.loadFromDisk()
  }

  get token(): string | null { return this.accessToken }
  get hasCredentials(): boolean { return !!this.accessToken }

  private loadFromDisk(): boolean {
    try {
      const raw = readFileSync(this.credPath, 'utf8')
      this.lastMtime = this.getMtime()
      const oauth = JSON.parse(raw).claudeAiOauth
      if (!oauth?.accessToken) return false
      this.accessToken = oauth.accessToken
      this.refreshToken = oauth.refreshToken
      this.expiresAt = oauth.expiresAt ?? 0
      return true
    } catch { return false }
  }

  private saveToDisk() {
    let existing: Record<string, unknown> = {}
    try { existing = JSON.parse(readFileSync(this.credPath, 'utf8')) } catch { /* new */ }
    existing.claudeAiOauth = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
    }
    const dir = dirname(this.credPath)
    try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
    writeFileSync(this.credPath, JSON.stringify(existing, null, 2), 'utf8')
    try { chmodSync(this.credPath, 0o600) } catch { /* windows */ }
    this.lastMtime = this.getMtime()
  }

  private getMtime(): number {
    try { return statSync(this.credPath).mtimeMs } catch { return 0 }
  }

  private diskChanged(): boolean {
    return this.getMtime() !== this.lastMtime
  }

  private isExpired(): boolean {
    return !this.accessToken || (Date.now() + EXPIRY_BUFFER_MS >= this.expiresAt)
  }

  /** Ensure we have a valid token. Refreshes if needed. */
  async ensureValid(): Promise<string> {
    // Check if another process updated the file
    if (this.diskChanged()) {
      this.loadFromDisk()
      if (!this.isExpired()) return this.accessToken!
    }

    if (!this.isExpired()) return this.accessToken!
    if (!this.refreshToken) {
      throw new Error('Not logged in. Run: opencode providers login -p claude-max')
    }

    // Dedup concurrent refresh calls within this instance
    if (this.refreshing) { await this.refreshing; return this.accessToken! }

    this.refreshing = (async () => {
      // Triple-check: re-read from disk (another process may have refreshed)
      if (this.diskChanged()) {
        this.loadFromDisk()
        if (!this.isExpired()) return
      }

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: CLIENT_ID,
          scope: SCOPES,
        }),
      })

      if (!res.ok) {
        // Check 3: maybe another process refreshed while we were waiting
        if (this.diskChanged()) {
          this.loadFromDisk()
          if (!this.isExpired()) return
        }
        throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`)
      }

      const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number }
      this.accessToken = data.access_token
      this.refreshToken = data.refresh_token
      this.expiresAt = Date.now() + (data.expires_in * 1000)
      this.saveToDisk()
    })().finally(() => { this.refreshing = null })

    await this.refreshing
    return this.accessToken!
  }

  /** Store new credentials (from OAuth login) */
  setCredentials(access: string, refresh: string, expiresAt: number) {
    this.accessToken = access
    this.refreshToken = refresh
    this.expiresAt = expiresAt
    this.saveToDisk()
  }
}

// ─── Plugin Export ─────────────────────────────────────────
// Each opencode instance calls server() independently.
// The closure + CredentialManager give complete isolation.

import { appendFileSync } from 'fs'

const DEBUG = process.env.CLAUDE_MAX_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'claude-max-debug.log')
function dbg(...args: any[]) {
  if (!DEBUG) return
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`) } catch {}
}

export default {
  id: 'opencode-claude-max',
  server: async (input: any) => {
    const t0 = Date.now()
    const cwd = input.directory ?? process.cwd()
    const sessionId = process.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_SLUG ?? input.sessionID ?? 'unknown'
    const creds = new CredentialManager(cwd)
    const providerPath = `file://${import.meta.dir}`

    dbg(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} providerPath=${providerPath} initTime=${Date.now() - t0}ms`)

    // Signal-wire: capture serverUrl for TUI notifications
    const _serverUrl = typeof input.serverUrl === 'object' && input.serverUrl?.href
      ? input.serverUrl.href.replace(/\/$/, '')  // URL object → string, strip trailing slash
      : (typeof input.serverUrl === 'string' ? input.serverUrl.replace(/\/$/, '') : '')
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId
    dbg(`STARTUP signal-wire: serverUrl=${_serverUrl} sessionId=${_sessionId}`)

    // Pass serverUrl to provider.ts for SignalWire instance construction
    setSignalWireServerUrl(_serverUrl)

    if (!creds.hasCredentials) {
      dbg('Not logged in — run: opencode providers login -p claude-max')
    }

    return {
      // ─── Config: register Claude Max as a provider ───────
      config: async (config: any) => {
        const tc = Date.now()
        if (!config.provider) config.provider = {}

        dbg('STARTUP config hook called')

        config.provider['claude-max'] = {
          id: 'claude-max',
          name: 'Claude Max/Pro',
          api: 'https://api.anthropic.com',
          npm: providerPath,
          env: [],
          models: {},
        }

        for (const [id, info] of Object.entries(MAX_MODELS)) {
          const is46 = id.includes('opus-4-6') || id.includes('sonnet-4-6')
          config.provider['claude-max'].models[id] = {
            id,
            name: `${info.name} (Max)`,
            api: { id, url: 'https://api.anthropic.com', npm: providerPath },
            providerID: 'claude-max',
            reasoning: is46,
            // modalities — opencode reads THIS (not capabilities.input/output) to decide
            // whether to pass images/PDFs through or strip them with error text.
            // See provider.ts unsupportedParts() → model.capabilities.input[modality]
            // and provider.ts model building → model.modalities?.input?.includes("image")
            modalities: {
              input: ['text', 'image', 'pdf'],
              output: ['text'],
            },
            capabilities: {
              temperature: true,
              reasoning: is46,
              attachment: true,
              toolcall: true,
              input: {
                text: true,
                audio: false,
                image: true,
                video: false,
                pdf: true,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: is46 ? { field: 'reasoning_content' as const } : false,
            },
            cost: { input: info.cost.input, output: info.cost.output, cache: { read: info.cost.cacheRead, write: info.cost.cacheWrite } },
            limit: { context: info.context, output: info.output },
            status: 'active',
            options: {},
            headers: {},
            // Effort variants — opencode uses these for the reasoning effort selector
            ...(is46 ? {
              variants: {
                low:  { thinking: { type: 'enabled', budgetTokens: 5000 } },
                medium: { thinking: { type: 'enabled', budgetTokens: 16000 } },
                high: { thinking: { type: 'enabled', budgetTokens: 32000 } },
              },
            } : {}),
          }
        }
        dbg(`STARTUP config hook done in ${Date.now() - tc}ms — ${Object.keys(config.provider['claude-max'].models).length} models registered`)
      },

      // ─── Auth: OAuth login + loader ──────────────────────
      auth: {
        provider: 'claude-max',

        // Called at startup — return SDK options with per-request fetch
        // Mirrors src/services/api/client.ts:88-315 (getAnthropicClient)
        loader: async (_getAuth: () => Promise<any>, provider: any) => {
          const tl = Date.now()
          dbg('STARTUP auth.loader called', { providerModels: Object.keys(provider.models ?? {}), providerOptions: provider.options })
          // NOTE: Do NOT zero out model costs here — we set equivalent API pricing
          // in the config hook for the sidebar savings display to work.

          // Pass provider options through so createClaudeMax can read keepalive/debug config
          // from opencode.json → provider.claude-max.options
          dbg(`STARTUP auth.loader done in ${Date.now() - tl}ms credPath=${creds.credPath}`)
          return {
            credentialsPath: creds.credPath,
            providerOptions: provider.options ?? {},
          }
        },

        methods: [
          {
            type: 'oauth' as const,
            label: 'Login with Claude Max/Pro (browser)',
            prompts: [
              {
                type: 'select' as const,
                key: 'credLocation',
                message: 'Where to save credentials?',
                options: [
                  { label: 'This project', value: 'local', hint: `${cwd}/.claude/.credentials.json` },
                  { label: 'Global (default)', value: 'global', hint: `~/.claude/.credentials.json` },
                ],
              },
            ],
            async authorize(inputs?: Record<string, string>) {
              const savePath = inputs?.credLocation === 'local'
                ? join(cwd, '.claude', '.credentials.json')
                : join(homedir(), '.claude', '.credentials.json')

              const codeVerifier = generateCodeVerifier()
              const codeChallenge = generateCodeChallenge(codeVerifier)
              const state = generateState()

              let resolveCode!: (code: string) => void
              let rejectCode!: (err: Error) => void
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
                    rejectCode(new Error(`OAuth error: ${error}`))
                    return new Response('<h1>Login failed</h1>', { status: 400, headers: { 'Content-Type': 'text/html' } })
                  }
                  if (!code || st !== state) {
                    rejectCode(new Error('Invalid callback'))
                    return new Response('Invalid', { status: 400 })
                  }
                  resolveCode(code)
                  return new Response(null, { status: 302, headers: { Location: `${AUTH_BASE}/oauth/code/success?app=claude-code` } })
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

              const timeout = setTimeout(() => {
                rejectCode(new Error('Login timed out (5 min)'))
                server.stop()
              }, 300_000)

              return {
                url: `${AUTH_URL}?${params.toString()}`,
                instructions: 'Complete the login in your browser. The page will redirect automatically.',
                method: 'auto' as const,
                async callback() {
                  try {
                    const code = await codePromise
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
                      dbg(`Token exchange failed (${tokenRes.status}): ${body}`)
                      return { type: 'failed' as const }
                    }

                    const data = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number }
                    const exp = Date.now() + (data.expires_in * 1000)

                    // Save to our credential file (NOT opencode's auth.json)
                    creds.setCredentials(data.access_token, data.refresh_token, exp)

                    // Also return to opencode so it knows login succeeded
                    return {
                      type: 'success' as const,
                      access: data.access_token,
                      refresh: data.refresh_token,
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

      // NOTE: experimental.chat.system.transform does NOT fire for external plugins
      // (only config/auth hooks are dispatched to npm-installed plugins).
      // Context injection stays in provider.ts convertPrompt() — see buildContextInjection().

      // ─── Event bus: diagnostics ─────────────────────────
      // NOTE: event hook also may not fire for external plugins (same Plugin.trigger limitation).
      // Keeping as no-op for now — will activate if opencode adds external plugin hook support.
      event: async ({ event }: { event: any }) => {
        if (event?.type === 'mcp.tools.changed') {
          dbg(`MCP_EVENT: tools changed on server=${event.properties?.server}`)
        }
      },

      // ─── Compaction: inject cache context ────────────────
      "experimental.session.compacting": async (_input: any, output: any) => {
        output.context.push(`## Cache Optimization Notes
- This session uses Anthropic prompt caching with keepalive
- Cache prefix (system + tools ≈30K tokens) is shared across all sessions
- When continuing, reuse exact tool names and file paths to maximize cache hits
- Cache read is 10x cheaper than uncached input — preserving conversation structure matters`)

        // If user configured a custom compaction prompt, use it
        const customPrompt = (creds as any)._providerOptions?.customCompaction
        if (typeof customPrompt === 'string' && customPrompt.length > 0) {
          output.prompt = customPrompt
        }
      },
    }
  },
}
