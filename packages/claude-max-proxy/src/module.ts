/**
 * ProxyModule — the extension point for claude-max-proxy.
 *
 * Each endpoint family (Anthropic passthrough, OpenAI compat, admin, health)
 * is a self-contained module with its own routes and lifecycle. server.ts is
 * a thin router that loads modules and dispatches requests.
 *
 * Inspired by kibctl's Module interface but standalone — no framework dep.
 */

import type { ProxyConfig } from './config.js'
import type { ProxyClient } from '@life-ai-tools/claude-code-sdk'

// ═══ Module Context ═════════════════════════════════════════════════

/** Event emitter interface — matches the proxy's bus `emit()` signature. */
export interface EventEmitFn {
  (event: Record<string, unknown>): void
}

/** Managed-session service interface — decouples from implementation. */
export interface IManagedSessions {
  mark(sessionId: string, workerId: string, ttlMs?: number, lastPid?: number | null): void
  unmark(sessionId: string): boolean
  heartbeat(workerId: string, activeSessionIds: string[]): number
  list(): { sessionId: string; workerId: string; lastHeartbeat: number; ttlMs: number; staleSec: number }[]
  isAliveByPid(pid: number): boolean
}

export interface ModuleContext {
  emit: EventEmitFn
  config: ProxyConfig
  proxyClient: ProxyClient
  managedSessions: IManagedSessions
  version: string
}

// ═══ Route Definition ═══════════════════════════════════════════════

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'DELETE' | 'OPTIONS' | '*'
  path: string
  handler: (req: Request, server: BunServer) => Promise<Response>
}

export type BunServer = { requestIP(r: Request): { address: string; port: number } | null }

// ═══ ProxyModule Interface ══════════════════════════════════════════

export interface ProxyModule {
  name: string
  routes: RouteDefinition[]
  init(ctx: ModuleContext): void
  cleanup?(): void | Promise<void>
}

// ═══ Module Loader ══════════════════════════════════════════════════

export interface ModuleLoadResult {
  allRoutes: RouteDefinition[]
  loaded: string[]
  failed: { name: string; error: string }[]
}

export function loadModules(
  modules: ProxyModule[],
  ctx: ModuleContext,
  emit: (event: Record<string, unknown>) => void,
): ModuleLoadResult {
  const allRoutes: RouteDefinition[] = []
  const loaded: string[] = []
  const failed: { name: string; error: string }[] = []

  for (const mod of modules) {
    try {
      mod.init(ctx)
      allRoutes.push(...mod.routes)
      loaded.push(mod.name)
      emit({ level: 'info', kind: 'INFO', msg: `Module '${mod.name}' loaded — ${mod.routes.length} routes` })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      failed.push({ name: mod.name, error: msg })
      emit({ level: 'error', kind: 'ERROR', msg: `Module '${mod.name}' init FAILED: ${msg} — routes skipped` })
    }
  }

  return { allRoutes, loaded, failed }
}

// ═══ Route Dispatcher ═══════════════════════════════════════════════

export function matchRoute(
  routes: RouteDefinition[],
  method: string,
  path: string,
): RouteDefinition | null {
  for (const r of routes) {
    if ((r.method === method || r.method === '*') && r.path === path) return r
  }
  return null
}
