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
import { corsify, requireControlAuth } from '../control-auth.js'
import { loadKeepaliveConfig, grantConsent } from '@life-ai-tools/claude-code-sdk'
import { stuckSessionState, dropStuck } from '../local-alert.js'

let ctx: ModuleContext
let shutdownFn: (() => void) | null = null

/** «Без часов» выражено годом ВНУТРИ существующей формы гранта — ровно так же,
 *  как это делает команда (`_UNTIL_CONSUMED_MS`, lat_context/cli.py:993).
 *  Расхождение здесь означало бы, что кнопка и команда дают разное согласие. */
const UNTIL_CONSUMED_SEC = 365 * 24 * 60 * 60

/**
 * Сколько живёт согласие сторожа кэша — ОТДЕЛЬНО от двери, нарочно.
 *
 * Правило проверяемо без единой записи на диск: испытание, зовущее дверь ради
 * срока, писало бы согласия в ЖИВОЙ склад машины (путь к настройкам берётся
 * один раз при загрузке модуля, и подменить его в общем прогоне нельзя).
 * Здесь же правило — чистая функция, и проверяется оно как правило.
 */
export function resolveRewriteConsentTtlSec(
  body: { ttlSec?: number; untilConsumed?: boolean },
  defaultTtlSec: number,
): number {
  if (body.untilConsumed) return UNTIL_CONSUMED_SEC
  if (Number.isFinite(body.ttlSec) && (body.ttlSec as number) > 0) {
    return Math.min(body.ttlSec as number, UNTIL_CONSUMED_SEC)
  }
  return defaultTtlSec
}

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

    // Consent for ONE turn held back by the quota guard.
    //
    // 🔴 WHY A DOOR OF OUR OWN. The cache guard's consent is typed by a human
    // as `context cache-rewrite-ok`, which lives in the lat-context CLI — a
    // repository we do not own. Promising a command we cannot ship would leave
    // every held sub-agent with a refusal that names a way out that does not
    // exist. This endpoint is the way out we can guarantee today; the CLI
    // wrapper is asked for separately and can simply call it.
    //
    // The grant is single-use and read by the guard on the session's next
    // turn — the same shape as the cache guard's, deliberately, so a person
    // does not have to learn two consent models.
    {
      method: 'POST',
      path: '/admin/quota-ok',
      handler: async (req) => {
        let body: { sessionId?: string; ttlSec?: number } = {}
        try { body = await req.json() as any } catch { /* empty body handled below */ }
        if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400 })
        const guard = loadKeepaliveConfig().quotaGuard
        // Default 1 hour, not the cache guard's 180 s: a session held by this
        // guard is by definition NOT taking turns — it is waiting for a window
        // that resets in tens of minutes — so a three-minute clock would expire
        // long before the turn it was granted for.
        const ttlSec = Number.isFinite(body.ttlSec) && (body.ttlSec as number) > 0
          ? Math.min(body.ttlSec as number, 6 * 3600)
          : 3600
        grantConsent(guard.consentGrantPath, body.sessionId, ttlSec * 1000)
        return Response.json({
          ok: true,
          sessionId: body.sessionId,
          ttlSec,
          note: 'single-use — consumed by this session\'s next real turn',
        })
      },
    },

    // Consent for ONE turn held back by the CACHE guard — the other half of the
    // pair above.
    //
    // 🔴 WHY IT EXISTS, 2026-09-11. The wake-router's owner is building the
    // executor behind the founder's "allow" tap and asked for three things: an
    // address, a header, a body. There was NO address: this guard's consent had
    // only ever been written by `context cache-rewrite-ok`, a command living in
    // a repository we do not own. That would have made the executor depend on a
    // third party's CLI being on its PATH — for a door we can simply hand over.
    //
    // 🔴 PARITY WITH THE COMMAND IS THE POINT, NOT A DETAIL. Two paths to one
    // consent that hand out DIFFERENT lifetimes is a defect nobody reproduces:
    // typed the command and it worked, tapped the button and it behaved
    // otherwise. So the clocks here are copied from the command — 180 s by
    // default and a year for "until consumed" (`_UNTIL_CONSUMED_MS`,
    // lat_context/cli.py:993) — and both write the same grant shape.
    //
    // No header is needed from a caller on this machine: the control plane lets
    // loopback through (control-auth.ts), and the wake-router is loopback.
    {
      method: 'POST',
      path: '/admin/cache-rewrite-ok',
      handler: async (req) => {
        let body: { sessionId?: string; ttlSec?: number; untilConsumed?: boolean } = {}
        try { body = await req.json() as any } catch { /* empty body handled below */ }
        if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400 })
        const guard = loadKeepaliveConfig().rewriteGuard
        // "Until consumed" is the grant's REAL semantics — it has always been
        // single-use, and only the clock cut it short on an idle agent that
        // takes no turns. Expressed as a year inside the existing shape, the
        // same way the command expresses it, so neither side has to learn a
        // second model.
        const ttlSec = resolveRewriteConsentTtlSec(body, guard.consentGrantTtlSec)
        grantConsent(guard.consentGrantPath, body.sessionId, ttlSec * 1000)
        // 🔴 ЧТО МЫ ЗНАЕМ О ЭТОЙ СЕССИИ — и почему это не отказ, а справка.
        // Спросил владелец роутера побудок: человек должен видеть разницу между
        // «разрешил не тому» и «дверь лежит», а не одно слово на оба случая.
        // Отказать нельзя: разрешать сессию, которую служба не видела с
        // перезапуска, — законный и частый случай. Поэтому согласие пишется
        // всегда, а рядом едет то, что известно, и решает рисующий карточку.
        const st = stuckSessionState(body.sessionId)
        const tracked = ctx.proxyClient.listSessions().some(s => s.sessionId === body.sessionId)
        return Response.json({
          ok: true,
          sessionId: body.sessionId,
          session: st.stuck ? 'stuck' : (tracked ? 'tracked' : 'unknown'),
          stuckForSec: st.stuckForSec,
          // Named so a receipt can never be mistaken for the quota guard's:
          // the two keep SEPARATE stores, and a grant for one is no grant for
          // the other.
          guard: 'cache',
          ttlSec,
          untilConsumed: !!body.untilConsumed,
          note: st.stuck
            ? 'single-use — consumed by this session\'s next proceeding rewrite'
            : (tracked
              ? 'granted, but this session is NOT currently held by the cache guard'
              : 'granted, but NOTHING is known about this session here — check the id '
                + 'before telling a person it is unblocked'),
        })
      },
    },

    // Снять сессию с учёта стоящих — решение ЧЕЛОВЕКА, а не согласие на трату.
    //
    // 🔴 ЭТО НЕ ДВЕРЬ СОГЛАСИЯ И НЕ ЕЁ СИНОНИМ. /admin/cache-rewrite-ok говорит
    // «покупку разрешаю, продолжай»; эта говорит «такой сессии больше нет,
    // перестань про неё напоминать». Замер 11.09.2026: в учёте висела aaf2acbd —
    // 190 часов, 18 напоминаний человеку, процесса за ней нет, и убрать её было
    // нечем, кроме как ждать сутки до потолка или править боевой файл машины
    // руками. Второе — ровно то, чем эта смена уже обожглась в тот же день.
    //
    // Цена пробела не в мусоре, а в доверии: карточка зовёт человека разрешить
    // несуществующего агента, нажатие уходит впустую, и человек перестаёт читать
    // карточки — ломается то, ради чего вся цепь строилась.
    {
      method: 'POST',
      path: '/admin/stuck-session/drop',
      handler: async (req) => {
        let body: { sessionId?: string } = {}
        try { body = await req.json() as any } catch { /* пустое тело — ниже */ }
        if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400 })
        const r = dropStuck(body.sessionId)
        return Response.json({
          ok: true,
          sessionId: body.sessionId,
          dropped: r.dropped,
          stuckForSec: r.stuckForSec,
          // Различимо нарочно: «убрал» и «нечего было убирать» — разные исходы,
          // и рисующий карточку обязан сказать человеку, который из них случился.
          note: r.dropped
            ? 'снята с учёта — напоминаний по ней больше не будет'
            : 'в учёте стоящих такой сессии не было — ничего не изменилось',
        })
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
        return Response.json({ ...result, ok: true, sessionId: body.sessionId })
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

  // Control-plane auth: every /admin/* route requires loopback OR the
  // ADMIN_TOKEN bearer (control-auth.ts). The proxy may listen on 0.0.0.0
  // for the /v1 data plane — that must never expose shutdown/disarm/org
  // controls to the LAN unauthenticated.
  const guarded = routes.map(r => ({
    ...r,
    handler: async (req: Request, server: Parameters<RouteDefinition['handler']>[1]) => {
      const denied = requireControlAuth(req, server, (ctx.config as { adminToken?: string | null }).adminToken ?? null)
      if (denied) return denied
      return r.handler(req, server)
    },
  }))

  return {
    name: 'admin',
    // CORS (REQ-16): web-PWA пульт ходит на control-plane cross-origin;
    // preflight-роуты OPTIONS не гейтятся auth (браузер не шлёт credentials)
    routes: corsify(guarded),
    init(c) { ctx = c },
  }
}
