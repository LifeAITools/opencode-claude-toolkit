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
