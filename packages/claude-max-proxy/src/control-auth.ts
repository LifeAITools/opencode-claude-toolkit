/**
 * control-auth.ts — auth gate for the proxy's control plane (/mcp + /admin/*).
 *
 * Threat model: the proxy may listen on 0.0.0.0 (sidecars need /v1), which
 * historically left the ADMIN surface open to the whole LAN — anyone could
 * POST /admin/shutdown. The control plane therefore requires either:
 *   - a loopback caller (local CLI / TUI keep working with zero config), or
 *   - `Authorization: Bearer <ADMIN_TOKEN>` matching the configured token.
 *
 * When no ADMIN_TOKEN is configured, remote control-plane access is DENIED
 * (fail-closed) — set ADMIN_TOKEN in ~/.config/claude-max-proxy/.env to
 * enable remote panels. /v1/* data-plane routes are intentionally NOT gated
 * here (sidecar consumers authenticate at the network layer).
 */

import type { BunServer } from './module.js'

const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopback(req: Request, server: BunServer): boolean {
  try {
    const ip = server.requestIP(req)?.address
    return !!ip && LOOPBACKS.has(ip)
  } catch {
    return false
  }
}

/** Returns null when authorized; an error Response otherwise. */
export function requireControlAuth(
  req: Request,
  server: BunServer,
  adminToken: string | null,
): Response | null {
  if (isLoopback(req, server)) return null
  const auth = req.headers.get('authorization') ?? ''
  if (adminToken && auth === `Bearer ${adminToken}`) return null
  return Response.json(
    {
      error: adminToken
        ? 'control plane requires Authorization: Bearer <ADMIN_TOKEN>'
        : 'remote control plane disabled — set ADMIN_TOKEN in the proxy env to enable',
    },
    { status: 401, headers: { 'www-authenticate': 'Bearer' } },
  )
}

// ═══ CORS for the control plane (REQ-16, UCB web-PWA) ═══════════════
//
// A pure web-PWA control board is cross-origin: the browser sends a
// preflight (OPTIONS) and requires Access-Control headers on every
// /mcp + /admin response. Native shells (Tauri) bypass CORS — this is
// strictly for the web target. Auth still applies: CORS headers do not
// weaken the bearer gate, they only let the browser ask.

import type { RouteDefinition } from './module.js'

export function corsHeaders(req: Request): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.get('origin') ?? '*',
    'access-control-allow-headers': 'authorization, content-type, mcp-session-id',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-expose-headers': 'mcp-session-id',
  }
}

/**
 * Wrap a module's routes with CORS: every response gains the headers and
 * each unique path gains an OPTIONS preflight route (router matches exact
 * paths, so preflights must be first-class routes).
 */
export function corsify(routes: RouteDefinition[]): RouteDefinition[] {
  const wrapped: RouteDefinition[] = routes.map((r) => ({
    ...r,
    handler: async (req, server) => {
      const res = await r.handler(req, server)
      const headers = new Headers(res.headers)
      for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v)
      return new Response(res.body, { status: res.status, headers })
    },
  }))
  const seen = new Set<string>()
  for (const r of routes) {
    if (seen.has(r.path)) continue
    seen.add(r.path)
    wrapped.push({
      method: 'OPTIONS',
      path: r.path,
      handler: async (req) => new Response(null, { status: 204, headers: corsHeaders(req) }),
    })
  }
  return wrapped
}
