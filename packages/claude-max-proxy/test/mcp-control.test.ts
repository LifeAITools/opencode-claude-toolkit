/**
 * MCP Streamable HTTP control surface — module-level tests.
 *
 * Covers: JSON-RPC lifecycle (initialize/tools), tool wiring to ProxyClient,
 * the realtime event stream (snapshot-then-live, kind filtering), and the
 * control-plane auth gate (loopback exempt, bearer required remotely,
 * fail-closed without ADMIN_TOKEN) on BOTH /mcp and /admin/*.
 */
import { describe, test, expect } from 'bun:test'
import { createMcpControlModule } from '../src/modules/mcp-control.js'
import { createAdminModule } from '../src/modules/admin.js'
import { bus } from '../src/event-bus.js'
import type { ModuleContext, BunServer } from '../src/module.js'

// ─── fakes ───────────────────────────────────────────────────────────

const fakeClient = () => {
  const calls: Record<string, unknown[]> = { switch: [], reload: [], disarm: [] }
  return {
    calls,
    listSessions: () => [{ sessionId: 's-1', pid: 1, model: 'claude-opus-4-8', firstSeenAt: 1, lastRequestAt: 2 }],
    orgSurface: () => ({ orgs: [{ orgId: 'org-A' }], sessions: [] }),
    switchSessionOrg: async (sid: string, org: string) => { calls.switch.push([sid, org]); return { ok: true, orgId: 'org-A' } },
    reloadSessions: (reason: string, sid?: string) => { calls.reload.push([reason, sid]); return ['s-1'] },
    disarmSessions: (reason: string, sid?: string) => { calls.disarm.push([reason, sid]); return ['s-1'] },
  }
}

function mkCtx(adminToken: string | null = null) {
  const client = fakeClient()
  const ctx = {
    emit: () => {},
    config: { adminToken } as ModuleContext['config'],
    proxyClient: client as unknown as ModuleContext['proxyClient'],
    managedSessions: { list: () => [], mark() {}, unmark: () => true, heartbeat: () => 0, isAliveByPid: () => true },
    version: 'test',
  } as unknown as ModuleContext
  return { ctx, client }
}

const loopback: BunServer = { requestIP: () => ({ address: '127.0.0.1', port: 1 }) }
const remote: BunServer = { requestIP: () => ({ address: '10.0.0.7', port: 1 }) }

const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
  new Request('http://x/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })

function route(mod: ReturnType<typeof createMcpControlModule>, method: string, path: string) {
  const r = mod.routes.find(r => r.method === method && r.path === path)
  if (!r) throw new Error(`route ${method} ${path} missing`)
  return r
}

// ─── JSON-RPC lifecycle ──────────────────────────────────────────────

describe('MCP /mcp — JSON-RPC', () => {
  test('initialize returns protocol + assigns Mcp-Session-Id', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx().ctx)
    const resp = await route(mod, 'POST', '/mcp').handler(rpc('initialize', { protocolVersion: '2025-03-26' }), loopback)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('mcp-session-id')).toBeTruthy()
    const body = await resp.json()
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe('claude-max-proxy-control')
  })

  test('tools/list exposes the 6 control tools', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx().ctx)
    const resp = await route(mod, 'POST', '/mcp').handler(rpc('tools/list'), loopback)
    const body = await resp.json()
    const names = body.result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(['org_switch', 'orgs_list', 'proxy_status', 'sessions_disarm', 'sessions_list', 'sessions_reload'])
  })

  test('tools/call org_switch wires to ProxyClient.switchSessionOrg', async () => {
    const { ctx, client } = mkCtx()
    const mod = createMcpControlModule(); mod.init(ctx)
    const resp = await route(mod, 'POST', '/mcp').handler(
      rpc('tools/call', { name: 'org_switch', arguments: { session_id: 'sess-9', org: 'acme' } }), loopback)
    const body = await resp.json()
    expect(body.result.isError).toBe(false)
    expect(client.calls.switch).toEqual([['sess-9', 'acme']])
  })

  test('unknown method → -32601; notification (no id) → 202', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx().ctx)
    const bad = await route(mod, 'POST', '/mcp').handler(rpc('nope/nope'), loopback)
    expect((await bad.json()).error.code).toBe(-32601)
    const notifReq = new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),   // no id = notification
    })
    const notif = await route(mod, 'POST', '/mcp').handler(notifReq, loopback)
    expect(notif.status).toBe(202)
  })
})

// ─── event stream ────────────────────────────────────────────────────

describe('MCP /mcp — event stream', () => {
  test('GET streams snapshot first, then filtered live bus events', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx().ctx)
    const req = new Request('http://x/mcp?kinds=KA_FIRE_COMPLETE', { headers: { accept: 'text/event-stream' } })
    const resp = await route(mod, 'GET', '/mcp').handler(req, loopback)
    expect(resp.headers.get('content-type')).toBe('text/event-stream')

    const reader = resp.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const readFrame = async () => {
      while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value)
      const idx = buf.indexOf('\n\n')
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
      return JSON.parse(frame.replace(/^data: /, ''))
    }

    const snapshot = await readFrame()
    expect(snapshot.method).toBe('notifications/proxy_event')
    expect(snapshot.params.kind).toBe('CONTROL_SNAPSHOT')
    expect(snapshot.params.sessions.length).toBe(1)

    // filtered OUT kind → no frame; filtered IN kind → frame arrives
    bus.emitEvent({ level: 'info', kind: 'KA_TICK_IDLE' } as never)
    bus.emitEvent({ level: 'info', kind: 'KA_FIRE_COMPLETE', sessionId: 'live-1' } as never)
    const live = await readFrame()
    expect(live.params.kind).toBe('KA_FIRE_COMPLETE')
    expect(live.params.sessionId).toBe('live-1')

    await reader.cancel()
  })

  test('GET without Accept: text/event-stream → 405', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx().ctx)
    const resp = await route(mod, 'GET', '/mcp').handler(new Request('http://x/mcp'), loopback)
    expect(resp.status).toBe(405)
  })
})

// ─── control-plane auth ──────────────────────────────────────────────

describe('control-plane auth (/mcp + /admin/*)', () => {
  test('remote without token → 401 fail-closed; loopback always ok', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx(null).ctx)
    expect((await route(mod, 'POST', '/mcp').handler(rpc('ping'), remote)).status).toBe(401)
    expect((await route(mod, 'POST', '/mcp').handler(rpc('ping'), loopback)).status).toBe(200)
  })

  test('remote with correct bearer → 200; wrong bearer → 401', async () => {
    const mod = createMcpControlModule(); mod.init(mkCtx('sekret').ctx)
    const withAuth = (tok: string) => new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect((await route(mod, 'POST', '/mcp').handler(withAuth('sekret'), remote)).status).toBe(200)
    expect((await route(mod, 'POST', '/mcp').handler(withAuth('wrong'), remote)).status).toBe(401)
  })

  test('/admin/* routes are gated the same way', async () => {
    const { ctx } = mkCtx(null)
    const admin = createAdminModule(() => {}); admin.init(ctx)
    const sessions = admin.routes.find(r => r.path === '/admin/sessions' && r.method === 'GET')!
    expect((await sessions.handler(new Request('http://x/admin/sessions'), remote)).status).toBe(401)
    expect((await sessions.handler(new Request('http://x/admin/sessions'), loopback)).status).toBe(200)
  })
})
