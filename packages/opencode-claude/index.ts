// TRACE: Plugin file loaded
try { require('fs').appendFileSync('/tmp/opencode-claude-trace.log', `LOADED pid=${process.pid} cwd=${process.cwd()} time=${new Date().toISOString()}\n`) } catch {}

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
import { setSignalWireServerUrl, setSignalWireSdkClient, getSignalWireInstance, handlePreToolUseSpawnCheck } from './provider.ts'
import { startWakeListener, stopWakeListener } from '@life-ai-tools/opencode-signal-wire'
import type { WakeListenerHandle } from '@life-ai-tools/opencode-signal-wire'
import { loadPreferences, computeSubscribe } from '@life-ai-tools/opencode-signal-wire'

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

// Models available via Max/Pro subscription — now sourced from SSOT at src/models.ts.
// This keeps per-model max_tokens / context / cost values in exactly one place across
// the SDK chain (sdk.ts, claude-max-provider, opencode-claude).
//
// If you need to add or update a model, edit src/models.ts in the root SDK package.
import { MAX_MODELS, supportsAdaptiveThinking } from '@life-ai-tools/claude-code-sdk'

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

// ─── Module-level identity error (bridged to signal-wire package) ──
//
// Identity-resolution errors flow: opencode-claude writes → signal-wire
// package (via setIdentityError) → tui.tsx reads (via getIdentityError).
// Re-exported for backward compat with any external consumers.
import { setIdentityError, getIdentityError as _getIdentityError } from '@life-ai-tools/opencode-signal-wire'

/** Export for TUI status display (Task 6) */
export const getIdentityError = _getIdentityError

/**
 * Resolve member identity from OAuth token via SynqTask MCP whoami.
 * Non-blocking with 3s timeout (CN-06, AC-04b).
 * Returns { memberId, memberName, memberType: 'human' } or null.
 */
async function resolveOAuthIdentity(): Promise<{
  memberId: string
  memberName: string
  memberType: 'human'
} | null> {
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'mcp-auth.json')
    if (!existsSync(authPath)) return null

    const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
    const accessToken = authData?.synqtask?.tokens?.accessToken
    const serverUrl = authData?.synqtask?.serverUrl ?? 'http://localhost:3747/mcp'
    if (!accessToken) return null

    // Call SynqTask MCP whoami — 3s timeout (CN-06: non-blocking)
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: {
          name: 'todo_session',
          arguments: { operations: { action: 'whoami' } },
        },
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null

    // Parse SSE response: "event: message\ndata: {...}\n"
    const text = await res.text()
    const dataLine = text.split('\n').find(l => l.startsWith('data: '))
    if (!dataLine) return null

    const rpcResult = JSON.parse(dataLine.substring(6))
    const content = rpcResult?.result?.content?.[0]?.text
    if (!content) return null

    const parsed = JSON.parse(content)
    const result = parsed?.results?.[0]?.result ?? parsed
    const memberId = result?.actingAs?.id ?? result?.member?.id ?? result?.ownerId
    const memberName = result?.actingAs?.name ?? result?.member?.name ?? 'unknown'
    if (!memberId) return null

    return { memberId, memberName, memberType: 'human' }
  } catch (e: any) {
    dbg(`OAuth whoami failed: ${e?.message}`)
    return null
  }
}

// ─── In-process module versions ──────────────────────────────────
//
// IMPORTANT — what these versions describe:
//   This plugin runs IN-PROCESS inside opencode. It does NOT use the
//   standalone @kiberos/claude-max-proxy daemon (port 5050) — that proxy
//   is for the native Claude Code CLI only.
//
//   Instead, this plugin uses an EMBEDDED keepalive engine + HTTP forwarder
//   imported from @life-ai-tools/claude-code-sdk. So when you see "sdk=..."
//   below, that IS the in-process equivalent of the proxy.
//
//   Logs are split by component:
//     • This plugin → ~/.claude/claude-max-debug.log (this file)
//     • Standalone proxy daemon (if running) → ~/.claude/claude-max-proxy.log[.jsonl]
//
function _readPkgVersion(p: string): string {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string }
    return `${j.name ?? '?'}@${j.version ?? '?'}`
  } catch { return 'unknown' }
}
const _PLUGIN_PKG = _readPkgVersion(join(import.meta.dir, '..', 'package.json'))
const _SDK_PKG = _readPkgVersion(join(import.meta.dir, '..', 'node_modules', '@life-ai-tools', 'claude-code-sdk', 'package.json'))
const _SIGNALWIRE_PKG = _readPkgVersion(join(import.meta.dir, '..', 'node_modules', '@life-ai-tools', 'opencode-signal-wire', 'package.json'))

export default {
  id: 'opencode-claude-max',
  server: async (input: any) => {
    const t0 = Date.now()
    const cwd = input.directory ?? process.cwd()
    const sessionId = process.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_SLUG ?? input.sessionID ?? 'unknown'
    const creds = new CredentialManager(cwd)
    const providerPath = `file://${import.meta.dir}/provider.js`

    // Resolve provider.js mtime (build timestamp marker — useful when versions don't change but rebuilds happen)
    let _providerMtime = 'unknown'
    try { _providerMtime = statSync(join(import.meta.dir, 'provider.js')).mtime.toISOString() } catch {}

    // STARTUP fields (in-process plugin only — DOES NOT include standalone proxy):
    //   plugin       — this opencode plugin package
    //   sdkInProc    — in-process keepalive engine + HTTP forwarder (what you'd call "embedded proxy")
    //   signalWire   — extracted signal-wire helper package
    //   node         — Node/Bun runtime version
    //   providerPath — file:// URL to bundled dist/provider.js (what opencode actually loads)
    //   providerMtime — build timestamp of that bundle (useful when version doesn't change but rebuild happens)
    //
    // For standalone proxy daemon version — query its own log: GET http://127.0.0.1:5050/version
    // (that proxy logs to ~/.claude/claude-max-proxy.log, not here).
    dbg(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} plugin=${_PLUGIN_PKG} sdkInProc=${_SDK_PKG} signalWire=${_SIGNALWIRE_PKG} node=${process.version} providerPath=${providerPath} providerMtime=${_providerMtime} initTime=${Date.now() - t0}ms`)

    // Signal-wire: capture serverUrl for TUI notifications
    const _serverUrl = typeof input.serverUrl === 'object' && input.serverUrl?.href
      ? input.serverUrl.href.replace(/\/$/, '')  // URL object → string, strip trailing slash
      : (typeof input.serverUrl === 'string' ? input.serverUrl.replace(/\/$/, '') : '')
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId
    dbg(`STARTUP signal-wire: serverUrl=${_serverUrl} sessionId=${_sessionId}`)

    // Pass serverUrl to provider.ts for SignalWire instance construction
    setSignalWireServerUrl(_serverUrl)

    // Proactive wake: start plugin wake listener (L4)
    // Bun.serve on random port — writes discovery file for Event Router
    let wakeHandle: WakeListenerHandle | null = null

    // Resolve member identity — DB-01 priority: X-Agent-Id > OAuth whoami > env var
    let _memberId = process.env.SYNQTASK_MEMBER_ID
    let _memberType: 'human' | 'agent' | 'unknown' = 'unknown'

    // Priority 1: opencode.json X-Agent-Id header (agent path — CN-01: untouched)
    try {
      const configPath = require('path').join(cwd, 'opencode.json')
      if (require('fs').existsSync(configPath)) {
        const projConfig = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
        const synqHeaders = projConfig?.mcp?.synqtask?.headers
        if (synqHeaders?.['X-Agent-Id']) {
          _memberId = synqHeaders['X-Agent-Id']
          _memberType = 'agent'
          dbg(`WAKE memberId from opencode.json (agent): ${_memberId}`)
        }
      }
    } catch (e: any) { dbg(`WAKE config read failed: ${e?.message}`) }

    // Priority 2: OAuth whoami (human path — CR-01, CN-06: 3s timeout, non-blocking)
    if (!_memberId || _memberType !== 'agent') {
      try {
        const oauthResult = await resolveOAuthIdentity()
        if (oauthResult) {
          _memberId = oauthResult.memberId
          _memberType = 'human'
          dbg(`WAKE memberId from OAuth whoami (human): ${_memberId} name=${oauthResult.memberName}`)
        } else if (!_memberId) {
          setIdentityError('OAuth whoami returned no member (token expired or SynqTask down?)')
          dbg(`WAKE OAuth whoami failed: ${_identityError}`)
        }
      } catch (e: any) {
        setIdentityError(e?.message ?? 'OAuth whoami exception')
        dbg(`WAKE OAuth identity failed (non-fatal): ${_identityError}`)
      }
    }

    // Priority 3: env SYNQTASK_MEMBER_ID already assigned above as initial value

    // Load wake preferences (SSOT) and compute subscribe list
    const _wakePrefs = loadPreferences(cwd)
    const { subscribe: _subscribe, preset: _presetName } = computeSubscribe(_wakePrefs, _memberType)

    // Start wake listener if serverUrl available
    if (_serverUrl) {
      try {
        wakeHandle = await startWakeListener({
          serverUrl: _serverUrl,
          sessionId: _sessionId,
          memberId: _memberId,
          synqtaskUrl: process.env.SYNQTASK_API_URL,
          // SignalWire instance is constructed lazily in provider.ts config hook,
          // not available at wake-listener startup — use resolver for request-time lookup
          signalWireResolver: () => getSignalWireInstance() as any,
          // SDK client for in-process injection (TUI mode — no HTTP server)
          sdkClient: input.client,
          // Wake subscriptions (REQ-02)
          subscribe: _subscribe,
          subscribePreset: _presetName ?? undefined,
          memberType: _memberType,
        })
        dbg(`WAKE listener started on port ${wakeHandle.port} token=${wakeHandle.token.slice(0, 8)}...`)
      } catch (e: any) {
        // CN-02: wake failure must NOT crash plugin startup
        dbg(`WAKE listener failed to start: ${e?.message ?? e}`)
      }
    } else {
      dbg(`WAKE listener skipped: serverUrl=${_serverUrl} sessionId=${_sessionId}`)
    }

    // AC-04d: Deferred toast on identity failure (non-silent)
    if (!_memberId && _identityError) {
      try {
        setTimeout(() => {
          try {
            if (_serverUrl) {
              fetch(`${_serverUrl}/tui/toast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `⚠️ Wake identity not resolved: ${_identityError}`, type: 'warning' }),
              }).catch(() => {})
            }
          } catch {}
        }, 2000)
      } catch {}
    }

    // Pass SDK client to signal-wire for in-process session injection
    setSignalWireSdkClient(input.client)

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
          // Adaptive-thinking support sourced from SSOT instead of hardcoded
          // substring check. Model table at src/models.ts controls this.
          const isAdaptive = supportsAdaptiveThinking(id)
          config.provider['claude-max'].models[id] = {
            id,
            name: `${info.name} (Max)`,
            api: { id, url: 'https://api.anthropic.com', npm: providerPath },
            providerID: 'claude-max',
            reasoning: isAdaptive,
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
              reasoning: isAdaptive,
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
              interleaved: isAdaptive ? { field: 'reasoning_content' as const } : false,
            },
            cost: { input: info.cost.input, output: info.cost.output, cache: { read: info.cost.cacheRead, write: info.cost.cacheWrite } },
            // limit.output — opencode uses this to decide what maxOutputTokens
            // value to pass into the AI SDK layer. Reads SSOT's defaultOutput
            // (the per-model "happy path" cap, mirroring native CLI's wa().default).
            // Previously hardcoded 16384 — too low for large tool-calls.
            limit: { context: info.context, output: info.defaultOutput },
            status: 'active',
            options: {},
            headers: {},
            // Effort variants — opencode uses these for the reasoning effort selector
            ...(isAdaptive ? {
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

      // ─── Stage 2: Spawn budget enforcement (CR-06, CN-06, CN-07) ──
      // Intercepts `task` tool to enforce depth/subagent limits.
      // Non-task tools pass through unaffected (CN-06).
      // Errors in budget tracking never block the agent (CN-07).
      "pre_tool_use": async ({ toolName, input }: { toolName: string; input?: any }) => {
        try {
          const result = await handlePreToolUseSpawnCheck(toolName, _serverUrl, _sessionId, input)
          if (result) return result  // { decision: 'block', message: '...' }
        } catch (e: any) {
          // CN-07: fail-open — never crash on hook errors
          dbg(`pre_tool_use hook error (allowing): ${e?.message}`)
        }
        // Allow: return undefined (no block)
        return undefined
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
