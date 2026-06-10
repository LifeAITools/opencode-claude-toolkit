/**
 * MCP control module — the proxy's control surface as a Model Context
 * Protocol server over Streamable HTTP (spec rev 2025-03-26).
 *
 * Why MCP instead of a bespoke SSE feed: any MCP client — a control panel,
 * the MCP Inspector, Claude itself — becomes a remote console for the proxy
 * with zero custom client code. One endpoint:
 *
 *   POST   /mcp   JSON-RPC 2.0 (initialize, ping, tools/list, tools/call)
 *   GET    /mcp   server→client stream (SSE framing per spec): realtime
 *                 proxy events as `notifications/proxy_event` — per-session
 *                 KA ticks/fires/disarms, heartbeat, org events, guard blocks
 *   DELETE /mcp   end the MCP session
 *
 * Auth: control-auth.ts — loopback callers are exempt; remote callers need
 * `Authorization: Bearer <ADMIN_TOKEN>` (fail-closed when unset).
 *
 * Hand-rolled JSON-RPC on purpose: the official SDK would be the proxy's
 * first runtime dep for a ~300-line protocol slice; the module pattern here
 * mirrors kibctl's "no framework dep" stance (see module.ts header).
 */

import type { ProxyModule, ModuleContext, RouteDefinition, BunServer } from '../module.js'
import { bus } from '../event-bus.js'
import { corsify, requireControlAuth } from '../control-auth.js'
import { buildControlManifest, CONTROL_MANIFEST_URI } from './ucm-manifest.js'

const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = { name: 'claude-max-proxy-control', version: '1.0.0' }

/** Event kinds streamed to panels by default (override with GET /mcp?kinds=A,B). */
const DEFAULT_STREAM_KINDS = new Set([
  'HEALTH_HEARTBEAT',
  'PROXY_KA_TICK',
  'KA_FIRE_START', 'KA_FIRE_COMPLETE', 'KA_FIRE_ERROR', 'KA_DISARM',
  'KA_PAUSED', 'KA_RESUMED', 'KA_RESUMED_FROM_PAUSE',
  'SESSION_TRACKED', 'SESSION_DEAD',
  'ORG_PIN_HELD', 'ORG_PIN_EXPIRED', 'ORG_PIN_ROTATED', 'ORG_PIN_RESTORED',
  'ORG_TOKEN_REFRESHED', 'ORG_TOKEN_REFRESH_FAILED', 'ORG_SERVED_MISMATCH',
  'REWRITE_WARN', 'REWRITE_BLOCK',
  'TOKEN_EXPIRED', 'TOKEN_NEEDS_RELOGIN', 'TOKEN_FILE_CHANGED',
  'UPSTREAM_RATE_LIMITED', 'NETWORK_DEGRADED', 'NETWORK_HEALTHY',
  'CREDENTIALS_CHANGED',
])

let ctx: ModuleContext
const liveSessions = new Set<string>()  // Mcp-Session-Id values issued by initialize

// UCM-манифест (UCB, REQ-15): собирается лениво, валидируется ucm-schema
let manifestCache: { version: string; json: string } | null = null
function controlManifestJson(): string {
  if (!manifestCache || manifestCache.version !== ctx.version) {
    manifestCache = {
      version: ctx.version,
      json: JSON.stringify(buildControlManifest(ctx.version)),
    }
  }
  return manifestCache.json
}

// ─── tool registry ───────────────────────────────────────────────────

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<unknown>
}

function buildTools(): ToolDef[] {
  return [
    {
      name: 'proxy_status',
      description: 'Proxy health summary: tracked sessions, org vault state, version. Live KA detail arrives on the GET /mcp event stream (PROXY_KA_TICK / HEALTH_HEARTBEAT).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({
        version: ctx.version,
        sessions: ctx.proxyClient.listSessions().length,
        orgs: ctx.proxyClient.orgSurface().orgs.length,
        managedSessions: ctx.managedSessions.list().length,
      }),
    },
    {
      name: 'sessions_list',
      description: 'List tracked Claude Code sessions (id, pid, model, first/last request timestamps).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ctx.proxyClient.listSessions().map(s => ({
        sessionId: s.sessionId, pid: s.pid, model: s.model,
        firstSeenAt: s.firstSeenAt, lastRequestAt: s.lastRequestAt,
      })),
    },
    {
      name: 'orgs_list',
      description: 'Per-organization token vault (redacted) + session→org pins + which org actually served each session.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ctx.proxyClient.orgSurface(),
    },
    {
      name: 'org_switch',
      description: 'Maintenance rotate: pin one session to an organization from the vault (org = UUID, unique prefix, or name). Grants exactly ONE rewrite-guard org-switch consent for that session — protections stay intact.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Target session UUID' },
          org: { type: 'string', description: 'Org UUID / unique prefix / name' },
        },
        required: ['session_id', 'org'],
        additionalProperties: false,
      },
      run: async (a) => {
        const r = await ctx.proxyClient.switchSessionOrg(String(a.session_id), String(a.org))
        if (!r.ok) throw new Error(r.error)
        return r
      },
    },
    {
      name: 'sessions_reload',
      description: 'Reload KA for one session (or all when session_id omitted): drop snapshots + invalidate token cache, KEEP keepalive timers. The documented safe org-swap primitive.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
      run: async (a) => ({
        reloaded: ctx.proxyClient.reloadSessions(String(a.reason ?? 'mcp_reload'), a.session_id ? String(a.session_id) : undefined),
      }),
    },
    {
      name: 'sessions_disarm',
      description: 'Disarm KA for one session (or all): stops keepalive until the next real request. Stronger than reload — use for quota emergencies.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
      run: async (a) => ({
        disarmed: ctx.proxyClient.disarmSessions(String(a.reason ?? 'mcp_disarm'), a.session_id ? String(a.session_id) : undefined),
      }),
    },
  ]
}

// ─── JSON-RPC plumbing ───────────────────────────────────────────────

type RpcMsg = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any; result?: any; error?: any }

const rpcResult = (id: RpcMsg['id'], result: unknown): RpcMsg => ({ jsonrpc: '2.0', id: id ?? null, result })
const rpcError = (id: RpcMsg['id'], code: number, message: string): RpcMsg =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function handleRpc(msg: RpcMsg, tools: ToolDef[]): Promise<RpcMsg | null> {
  const { id, method, params } = msg
  if (!method) return rpcError(id, -32600, 'missing method')
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: {}, logging: {} },
        serverInfo: SERVER_INFO,
        instructions: 'claude-max-proxy control surface. Call tools/list for actions; read ui://control-manifest (UCM) for the control-board declaration; open GET /mcp (text/event-stream) for realtime KA/org/quota events as notifications/proxy_event.',
      })
    case 'ping':
      return rpcResult(id, {})
    case 'resources/list':
      return rpcResult(id, {
        resources: [
          {
            uri: CONTROL_MANIFEST_URI,
            name: 'UCM control manifest',
            description: 'Universal Control Manifest for the Universal Control Board (UCB)',
            mimeType: 'application/json',
          },
        ],
      })
    case 'resources/read': {
      if (params?.uri !== CONTROL_MANIFEST_URI) {
        return rpcError(id, -32602, `unknown resource: ${params?.uri}`)
      }
      return rpcResult(id, {
        contents: [
          { uri: CONTROL_MANIFEST_URI, mimeType: 'application/json', text: controlManifestJson() },
        ],
      })
    }
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const tool = tools.find(t => t.name === params?.name)
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`)
      try {
        const out = await tool.run(params?.arguments ?? {})
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false })
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: String((err as Error)?.message ?? err) }],
          isError: true,
        })
      }
    }
    default:
      // notifications (no id) are acknowledged silently per spec
      if (id === undefined) return null
      return rpcError(id, -32601, `method not found: ${method}`)
  }
}

// ─── module ──────────────────────────────────────────────────────────

export function createMcpControlModule(): ProxyModule {
  const tools = buildTools()

  const guard = (req: Request, server: BunServer): Response | null =>
    requireControlAuth(req, server, (ctx.config as { adminToken?: string | null }).adminToken ?? null)

  const routes: RouteDefinition[] = [
    {
      method: 'POST',
      path: '/mcp',
      handler: async (req, server) => {
        const denied = guard(req, server); if (denied) return denied
        let body: RpcMsg | RpcMsg[]
        try { body = await req.json() as RpcMsg | RpcMsg[] } catch {
          return Response.json(rpcError(null, -32700, 'parse error'), { status: 400 })
        }
        const msgs = Array.isArray(body) ? body : [body]
        const isInit = msgs.some(m => m.method === 'initialize')
        const responses = (await Promise.all(msgs.map(m => handleRpc(m, tools)))).filter((r): r is RpcMsg => r !== null)

        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (isInit) {
          const sid = crypto.randomUUID()
          liveSessions.add(sid)
          headers['mcp-session-id'] = sid
        }
        if (responses.length === 0) return new Response(null, { status: 202, headers })
        const payload = Array.isArray(body) ? responses : responses[0]
        return new Response(JSON.stringify(payload), { status: 200, headers })
      },
    },
    {
      method: 'GET',
      path: '/mcp',
      handler: async (req, server) => {
        const denied = guard(req, server); if (denied) return denied
        const accept = req.headers.get('accept') ?? ''
        if (!accept.includes('text/event-stream')) {
          return Response.json({ error: 'GET /mcp requires Accept: text/event-stream' }, { status: 405 })
        }
        const url = new URL(req.url)
        const kindsParam = url.searchParams.get('kinds')
        const kinds = kindsParam
          ? new Set(kindsParam.split(',').map(s => s.trim()).filter(Boolean))
          : DEFAULT_STREAM_KINDS

        let unsubscribe: (() => void) | null = null
        let keepalive: ReturnType<typeof setInterval> | null = null
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const send = (obj: unknown) => {
              try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)) } catch { /* closed */ }
            }
            // Snapshot first so a panel renders without waiting for ticks.
            send({
              jsonrpc: '2.0', method: 'notifications/proxy_event',
              params: {
                kind: 'CONTROL_SNAPSHOT', ts: Date.now(), version: ctx.version,
                sessions: ctx.proxyClient.listSessions(),
                orgs: ctx.proxyClient.orgSurface(),
              },
            })
            unsubscribe = bus.onEvent((e) => {
              if (!kinds.has(String((e as { kind?: string }).kind))) return
              send({ jsonrpc: '2.0', method: 'notifications/proxy_event', params: e })
            })
            // SSE comment keep-alive every 25s so idle proxies don't drop the stream.
            keepalive = setInterval(() => {
              try { controller.enqueue(enc.encode(': keepalive\n\n')) } catch { /* closed */ }
            }, 25_000)
          },
          cancel() {
            unsubscribe?.()
            if (keepalive) clearInterval(keepalive)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'connection': 'keep-alive',
          },
        })
      },
    },
    {
      method: 'DELETE',
      path: '/mcp',
      handler: async (req, server) => {
        const denied = guard(req, server); if (denied) return denied
        const sid = req.headers.get('mcp-session-id')
        if (sid) liveSessions.delete(sid)
        return new Response(null, { status: 200 })
      },
    },
  ]

  return {
    name: 'mcp-control',
    // CORS (REQ-16): web-PWA пульт — cross-origin; заголовки + OPTIONS preflight
    routes: corsify(routes),
    init(c) { ctx = c },
  }
}
