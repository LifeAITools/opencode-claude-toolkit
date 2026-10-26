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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadKeepaliveConfig, grantConsent } from '@life-ai-tools/claude-code-sdk'
import { stuckSessionState, stuckSessionReport, stuckSessionsAll, dropStuck } from '../local-alert.js'
import { enrichOrgSurface } from '../org-surface.js'

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


/**
 * Последняя запись журнала двери про эту сессию: кто её обслужил и откуда взялась организация.
 *
 * Читаем только сегодняшний и вчерашний файл и идём с конца: журнал построчный, а сессия
 * живет часами. Если записи нет — это честное `found:false` («дверь ещё не обслуживала»),
 * НЕ повод подставлять `active` или организацию по членству.
 */
export function servedOrgOf(session: string): { found: boolean; session: string; org?: string; source?: string | null; at?: string; ageSec?: number } {
  const dir = process.env.PROVIDER_DUMP_DIR ?? join(homedir(), '.claude-local', 'provider-dump')
  const days = [0, 1].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10))
  for (const day of days) {
    let text = ''
    try { text = readFileSync(join(dir, `${day}.jsonl`), 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes(session)) continue
      try {
        const rec = JSON.parse(line) as { session_id?: string | null; org_id?: string | null; org_source?: string | null; ts?: string }
        if (rec.session_id !== session) continue
        const at = typeof rec.ts === 'string' ? rec.ts : null
        const ageSec = at ? Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)) : undefined
        return { found: true, session, org: rec.org_id ?? undefined, source: rec.org_source ?? null, at: at ?? undefined, ageSec }
      } catch { /* битая строка — идём дальше */ }
    }
  }
  return { found: false, session }
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

    // Кто ОБСЛУЖИЛ сессию — факт из собственного журнала двери, а не догадка из env.
    // 🔴 Зачем: подвал агента брал организацию из `KIBEROS_GO_ORG` процесса, а у части
    // агентов переменной нет вовсе — и тогда показывалась организация по членству, которая
    // может не совпадать с фактической (замер 26.10: у `home-ourhome-owner` в карточке
    // `ruslan@elishev.com`, а дверь обслуживала `luxeresit@gmail.com`).
    {
      method: 'GET',
      path: '/admin/served-org',
      handler: async (req) => {
        const session = (new URL(req.url).searchParams.get('session') ?? '').trim()
        if (!session) return Response.json({ error: 'session required' }, { status: 400 })
        return Response.json(servedOrgOf(session))
      },
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

    // ── СПРАВКА О СТОЯЩЕЙ СЕССИИ. ТОЛЬКО ЧИТАЕТ. ───────────────────────────
    //
    // 🔴 ЗАЧЕМ, 19.09.2026. Владелец телеграм-службы принёс случай фаундера:
    // сессия соседа простояла у сторожа десять с половиной часов, а во всех
    // приборах числилась живой и занятой — каждый отбитый ход пишет в
    // стенограмму запись, а свежесть записей и есть то, по чему реестр судит о
    // жизни. Дословно фаундер: «Почему агент показывает статус, что работает…
    // но если он заблокирован, он не может ничего дёргать».
    //
    // 🔴 И ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ДВЕРЬ, А НЕ ПОЛЕ В СУЩЕСТВУЮЩЕЙ. Состояние у нас
    // БЫЛО и выходило наружу единственным путём — справкой при ВЫДАЧЕ согласия
    // (`/admin/cache-rewrite-ok`). То есть спросить «стоит ли он» было нельзя,
    // не разрешив заодно трату: вопрос был неотличим от ответа. Эта дверь не
    // пишет НИЧЕГО и ничего не разрешает — поэтому она GET.
    //
    // 🔴 ОТВЕЧАЕТ ПО ОБОИМ СТОРОЖАМ, И ЭТО НЕ ПОЛНОТА РАДИ ПОЛНОТЫ. Сторож кэша
    // помнит СЕССИИ, сторож запаса держит ходы ПО АККАУНТУ и сессий не помнит
    // вовсе. Дверь, отвечающая только по учёту стоящих, сказала бы «не стоит»
    // ровно тому агенту, чьи ходы придержаны запасом, — то есть соврала бы в
    // одном из двух случаев, ради которых её просили.
    {
      method: 'GET',
      path: '/admin/stuck-session',
      handler: async (req) => {
        const sid = new URL(req.url).searchParams.get('sessionId') ?? ''
        if (!sid) return Response.json({ error: 'sessionId required' }, { status: 400 })
        const cache = stuckSessionReport(sid)
        const quota = ctx.proxyClient.quotaHoldFor(sid)
        const tracked = ctx.proxyClient.listSessions().some(s => s.sessionId === sid)
        // Кто именно держит ход. Сторож кэша сильнее: он УЖЕ отбил ход этой
        // сессии, тогда как запас — состояние аккаунта, под которое она только
        // попадёт на следующем ходе.
        const guard = cache ? 'cache' : (quota.holding ? 'quota' : null)
        return Response.json({
          sessionId: sid,
          stuck: !!guard,
          guard,
          stuckForSec: cache?.stuckForSec ?? null,
          tokens: cache?.tokens ?? null,
          // 🔴 «Не стоит» и «я про неё ничего не знаю» — РАЗНЫЕ ответы, и тот,
          // кто рисует карточку человеку, обязан их различать: во втором случае
          // молчание прибора не означает здоровья.
          known: !!cache || tracked,
          cache,
          quota,
          note: cache
            ? 'ход отбит сторожем кэша — сессия ждёт решения человека и сама выйти не может'
            : (quota.holding
              ? 'сторож запаса придержал настоящие ходы этого аккаунта; кэш при этом жив, ждать до сброса'
              : (tracked
                ? 'ход ничем не придержан — сессия на ходу'
                : 'про эту сессию здесь не известно ничего: ни в учёте стоящих, ни среди живых')),
        })
      },
    },

    // Все стоящие разом — тому, кто рисует состояние ФЛОТА и не знает заранее,
    // чьё имя спрашивать. Та же справка, тоже без единой записи.
    {
      method: 'GET',
      path: '/admin/stuck-sessions',
      handler: async () => {
        const all = stuckSessionsAll()
        return Response.json({ count: all.length, sessions: all })
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

    // Human modes (FR-7): auto / away-until / off, per session. The human's
    // refusal is stronger than the policy — `off`/`away-until` stand the guards
    // down for that session, alongside (never replacing) the per-turn consent.
    {
      method: 'POST',
      path: '/admin/session-mode',
      handler: async (req) => {
        let body: { sessionId?: string; mode?: string; until?: number } = {}
        try { body = await req.json() as any } catch { /* 400 below */ }
        if (!body.sessionId || !body.mode) {
          return Response.json({ error: 'sessionId and mode required' }, { status: 400 })
        }
        if (body.mode !== 'auto' && body.mode !== 'away-until' && body.mode !== 'off') {
          return Response.json({ error: 'mode ∈ {auto|away-until|off}' }, { status: 400 })
        }
        const r = ctx.proxyClient.setHumanMode(body.sessionId, body.mode, body.until ?? null)
        return Response.json(r, { status: r.ok ? 200 : 400 })
      },
    },
    {
      method: 'GET',
      path: '/admin/session-mode',
      handler: async () => Response.json({ modes: ctx.proxyClient.humanModeSurface() }),
    },

    // Org surface — per-org credential vault + session pins (multi-org), plus
    // the COMPLETE roster with quota windows + status from the quota file (S1/D1).
    {
      method: 'GET',
      path: '/admin/orgs',
      handler: async () => Response.json(enrichOrgSurface(ctx.proxyClient.orgSurface())),
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
