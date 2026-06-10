/**
 * Admin module — /admin/* routes for proxy management.
 *
 * 8 endpoints per admin API contract (PRD §Technical Notes):
 *   GET    /admin/sessions          — list tracked sessions
 *   POST   /admin/sessions/managed  — mark Worker-managed
 *   GET    /admin/sessions/managed  — list managed sessions
 *   DELETE /admin/sessions/managed  — unmark managed
 *   POST   /admin/worker/heartbeat  — worker heartbeat
 *   POST   /admin/shutdown          — graceful shutdown
 *   POST   /admin/disarm            — disarm KA + invalidate token
 *   POST   /admin/reload            — reload KA (keep timers)
 *   GET    /admin/orgs              — org vault + session org pins (redacted)
 *   POST   /admin/sessions/org      — pin a session to an org from the vault
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'

let ctx: ModuleContext
let shutdownFn: (() => void) | null = null

export function createAdminModule(onShutdown: () => void): ProxyModule {
  shutdownFn = onShutdown

  const routes: RouteDefinition[] = [
    // List tracked sessions
    {
      method: 'GET',
      path: '/admin/sessions',
      handler: async () => Response.json({
        sessions: ctx.proxyClient.listSessions().map(s => ({
          sessionId: s.sessionId, pid: s.pid, model: s.model,
          firstSeenAt: s.firstSeenAt, lastRequestAt: s.lastRequestAt,
        })),
      }),
    },

    // Mark session as Worker-managed
    {
      method: 'POST',
      path: '/admin/sessions/managed',
      handler: async (req) => {
        const body = await req.json() as { sessionId: string; workerId: string; ttlMs?: number }
        if (!body.sessionId || !body.workerId) {
          return Response.json({ error: 'sessionId and workerId required' }, { status: 400 })
        }
        const sessions = ctx.proxyClient.listSessions()
        const tracked = sessions.find(s => s.sessionId === body.sessionId)
        ctx.managedSessions.mark(body.sessionId, body.workerId, body.ttlMs ?? 30_000, tracked?.pid ?? null)
        ctx.emit({ level: 'info', kind: EVENT.SESSION_MANAGED, sessionId: body.sessionId, workerId: body.workerId })
        return Response.json({ ok: true, sessionId: body.sessionId, workerId: body.workerId })
      },
    },

    // List managed sessions
    {
      method: 'GET',
      path: '/admin/sessions/managed',
      handler: async () => Response.json({ managed: ctx.managedSessions.list() }),
    },

    // Unmark managed session
    {
      method: 'DELETE',
      path: '/admin/sessions/managed',
      handler: async (req) => {
        const body = await req.json() as { sessionId: string }
        if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400 })
        const existed = ctx.managedSessions.unmark(body.sessionId)
        return Response.json({ ok: existed, sessionId: body.sessionId })
      },
    },

    // Worker heartbeat
    {
      method: 'POST',
      path: '/admin/worker/heartbeat',
      handler: async (req) => {
        const body = await req.json() as { workerId: string; activeSessionIds: string[] }
        if (!body.workerId || !Array.isArray(body.activeSessionIds)) {
          return Response.json({ error: 'workerId and activeSessionIds required' }, { status: 400 })
        }
        const refreshed = ctx.managedSessions.heartbeat(body.workerId, body.activeSessionIds)
        return Response.json({ ok: true, refreshed, total: ctx.managedSessions.list().length })
      },
    },

    // Graceful shutdown
    {
      method: 'POST',
      path: '/admin/shutdown',
      handler: async () => {
        ctx.emit({ level: 'info', kind: EVENT.PROXY_SHUTDOWN, msg: 'Shutdown requested via /admin/shutdown' })
        setTimeout(() => shutdownFn?.(), 100)
        return Response.json({ ok: true, msg: 'Shutting down' })
      },
    },

    // Disarm KA + invalidate token
    {
      method: 'POST',
      path: '/admin/disarm',
      handler: async (req) => {
        let body: { sessionId?: string; reason?: string } = {}
        try { body = await req.json() as any } catch { /* empty body = disarm all */ }
        const reason = body.reason ?? 'admin_disarm'
        const disarmed = ctx.proxyClient.disarmSessions(reason, body.sessionId)
        return Response.json({
          ok: true, disarmedCount: disarmed.length, sessionIds: disarmed,
          reason, tokenCacheInvalidated: true,
        })
      },
    },

    // Org surface — per-org credential vault + session pins (multi-org)
    {
      method: 'GET',
      path: '/admin/orgs',
      handler: async () => Response.json(ctx.proxyClient.orgSurface()),
    },

    // Explicit per-session org rotate (maintenance, one-shot guard consent).
    // Body: { sessionId, org } — org accepts a UUID, unique prefix, or name.
    {
      method: 'POST',
      path: '/admin/sessions/org',
      handler: async (req) => {
        let body: { sessionId?: string; org?: string } = {}
        try { body = await req.json() as any } catch { /* fall through to 400 */ }
        if (!body.sessionId || !body.org) {
          return Response.json({ error: 'sessionId and org required' }, { status: 400 })
        }
        const result = await ctx.proxyClient.switchSessionOrg(body.sessionId, body.org)
        if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 404 })
        return Response.json({ ok: true, sessionId: body.sessionId, ...result })
      },
    },

    // Reload KA (keep timers) + invalidate token
    {
      method: 'POST',
      path: '/admin/reload',
      handler: async (req) => {
        let body: { sessionId?: string; reason?: string } = {}
        try { body = await req.json() as any } catch { /* empty body = reload all */ }
        const reason = body.reason ?? 'admin_reload'
        const reloaded = ctx.proxyClient.reloadSessions(reason, body.sessionId)
        return Response.json({
          ok: true, reloadedCount: reloaded.length, sessionIds: reloaded,
          reason, tokenCacheInvalidated: true, kaTimerKept: true,
        })
      },
    },
  ]

  return {
    name: 'admin',
    routes,
    init(c) { ctx = c },
  }
}
