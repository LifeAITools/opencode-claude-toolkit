/**
 * identity-bootstrap — plugin-side bootstrap of SynqTask identity.
 *
 * Called by plugin's server() hook on every opencode boot. Resolution
 * order (first match wins):
 *
 *   1. Local identity cache (AGENT_IDENTITY_DIR/{deterministicKey}.json — see domain-constants)
 *      — fastest path; no network call. Returns cached memberId+secret.
 *
 *   2. Wake-router provisioning (POST /identity/provision)
 *      — router reads router.json discovery file, sends provision request
 *      with bootstrap key. Router creates-or-finds SynqTask member, returns
 *      memberId+secret+orgRole+team. Plugin caches.
 *
 *   3. Failure → return null. Plugin continues with legacy env-based identity
 *      (backward compat). Signal-wire emits a hint about degraded mode.
 *
 * Deterministic key:
 *   The key under which identity is cached. Stable across reboots so the
 *   same cwd+role yields the same memberId (CR-02 — no audit history loss).
 *
 *   key = SYNQTASK_AGENT_NAME ?? slugify(cwd) + "-" + (role ?? "developer")
 *
 *   Override priority: process.env > ${cwd}/.env > defaults.
 *
 * Conformance: REQ-24..REQ-29, US-01, CR-02.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { WAKE_ROOT, AGENT_IDENTITY_DIR } from './domain-constants'

export interface ResolvedIdentity {
  memberId: string
  secret: string
  deterministicKey: string
  role: string
  cwd: string
  isNewlyProvisioned: boolean
  /** OrgRole template payload returned by router (or stub if cache-only) */
  orgRole?: OrgRoleSnapshot
  team?: TeamSnapshot | null
  /**
   * Phase 5.5.2: Multi-signal run mode computed at bootstrap time.
   * Used by task tool fail-mode and persisted to discovery file (Phase 5.5.3).
   */
  runMode?: 'human' | 'agent' | 'unknown'
  /** Score from run-mode detector (informational; debugging). */
  runModeScore?: number
}

export interface OrgRoleSnapshot {
  slug: string
  name: string
  systemPrompt: string
  capabilities: string[]
  toolsAllowed: string[]
  toolsBlocked: string[]
  maxConcurrentTasks: number
  maxSpawnDepth: number
  canSpawn: string[]
  metadata: Record<string, string>
}

export interface TeamSnapshot {
  id: string
  name: string
  purpose?: string | null
  leadMemberId?: string | null
}

export interface BootstrapOptions {
  cwd: string
  /** Override env reading (testing) */
  envOverride?: Record<string, string | undefined>
  /** Fetch impl (test injection) */
  fetchImpl?: typeof fetch
  /** Skip cache lookup (force re-provision) */
  forceProvision?: boolean
}

interface CachedIdentity {
  memberId: string
  secret: string
  deterministicKey: string
  role: string
  cwd: string
  provisionedAt: string
  /** Optional: copy of orgRole at provision time (regenerated on next boot from router) */
  orgRole?: OrgRoleSnapshot
  team?: TeamSnapshot | null
  ttlExpiresAt?: string | null
}

interface RouterDiscoveryData {
  host: string
  port: number
  bootstrapKey: string
  synqtaskUrl: string
  pid: number
  startedAt: string
  version: string
}

const ROUTER_JSON_PATH = join(WAKE_ROOT, 'router.json')
const IDENTITY_CACHE_DIR = AGENT_IDENTITY_DIR

/**
 * Slugify a cwd path for use in deterministic key. Strategy:
 *   - Take last 2 path segments (e.g. /home/x/projects/foo-bar/sub → "foo-bar-sub")
 *   - Lowercase, replace non-alphanumeric with hyphen, collapse hyphens, trim
 */
export function slugifyCwd(cwd: string): string {
  const parts = cwd.split('/').filter(p => p.length > 0)
  const tail = parts.slice(-2).join('-')
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function readCwdDotEnv(cwd: string): Record<string, string> {
  const p = join(cwd, '.env')
  try {
    return parseDotEnv(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function getEnv(name: string, opts: BootstrapOptions, cwdEnv: Record<string, string>): string | undefined {
  // Priority: process.env > cwd .env > undefined
  const procVal = opts.envOverride
    ? opts.envOverride[name]
    : (process.env as any)[name]
  if (procVal != null && procVal !== '') return procVal
  return cwdEnv[name]
}

export function computeDeterministicKey(cwd: string, opts: BootstrapOptions = { cwd }): { key: string; role: string } {
  const cwdEnv = readCwdDotEnv(cwd)
  const explicitName = getEnv('SYNQTASK_AGENT_NAME', opts, cwdEnv)
  const role = getEnv('SYNQTASK_AGENT_ROLE', opts, cwdEnv) ?? 'developer'

  const key = explicitName ?? `${slugifyCwd(cwd)}-${role}`
  return { key, role }
}

function cachePath(deterministicKey: string): string {
  // Sanitize: cache files should be plain alphanumeric+hyphen
  const safe = deterministicKey.replace(/[^a-z0-9/_-]/gi, '_')
  return join(IDENTITY_CACHE_DIR, `${safe}.json`)
}

function readCache(deterministicKey: string): CachedIdentity | null {
  try {
    const raw = readFileSync(cachePath(deterministicKey), 'utf-8')
    return JSON.parse(raw) as CachedIdentity
  } catch {
    return null
  }
}

function writeCache(entry: CachedIdentity): void {
  const p = cachePath(entry.deterministicKey)
  const dir = dirname(p)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    try { chmodSync(dir, 0o700) } catch { /* */ }
  }
  const tmp = `${p}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(entry, null, 2))
  try { chmodSync(tmp, 0o600) } catch { /* */ }
  const { renameSync } = require('fs') as typeof import('fs')
  renameSync(tmp, p)
}

function readRouterDiscovery(): RouterDiscoveryData | null {
  try {
    return JSON.parse(readFileSync(ROUTER_JSON_PATH, 'utf-8')) as RouterDiscoveryData
  } catch {
    return null
  }
}

async function provisionViaRouter(
  router: RouterDiscoveryData,
  payload: { name: string; role: string; cwd: string; parentMemberId?: string | null },
  fetchImpl: typeof fetch,
): Promise<{
  memberId: string
  secret: string
  isNewlyCreated: boolean
  orgRole: OrgRoleSnapshot
  team: TeamSnapshot | null
} | { error: string; status?: number }> {
  if (!router.bootstrapKey) {
    return { error: 'router_no_bootstrap_key' }
  }
  const url = `http://${router.host}:${router.port}/identity/provision`
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${router.bootstrapKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { error: `router_returned_${resp.status}: ${text.slice(0, 200)}`, status: resp.status }
    }
    const data = await resp.json() as any
    if (!data.memberId || !data.secret) {
      return { error: 'router_response_missing_fields' }
    }
    return data
  } catch (e: any) {
    return { error: `network: ${e?.message ?? String(e)}` }
  }
}

/**
 * Main bootstrap entry point. Called by plugin server() hook on boot.
 *
 * Returns ResolvedIdentity or null. Plugin should:
 *   - On non-null: set SYNQTASK_MEMBER_ID/SECRET in env, proceed with provisioned identity
 *   - On null: fall back to legacy env-based behavior, emit signal-wire degraded hint
 */
export async function bootstrapIdentity(opts: BootstrapOptions): Promise<ResolvedIdentity | null> {
  const cwd = opts.cwd
  const fetchImpl = opts.fetchImpl ?? fetch
  const { key: deterministicKey, role } = computeDeterministicKey(cwd, opts)

  // Phase 5.5.2: Compute run mode FIRST (independent of identity resolution).
  // Used by both task tool fail-mode and discovery file write.
  const { detectRunMode } = await import('./run-mode')
  const runMode = detectRunMode()

  // 1. Cache lookup
  if (!opts.forceProvision) {
    const cached = readCache(deterministicKey)
    if (cached?.memberId && cached?.secret) {
      // Honor TTL if set
      if (cached.ttlExpiresAt) {
        const expired = new Date(cached.ttlExpiresAt).getTime() < Date.now()
        if (!expired) {
          return {
            memberId: cached.memberId,
            secret: cached.secret,
            deterministicKey,
            role: cached.role,
            cwd: cached.cwd,
            isNewlyProvisioned: false,
            orgRole: cached.orgRole,
            team: cached.team ?? null,
            runMode: runMode.mode,
            runModeScore: runMode.score,
          }
        }
      } else {
        return {
          memberId: cached.memberId,
          secret: cached.secret,
          deterministicKey,
          role: cached.role,
          cwd: cached.cwd,
          isNewlyProvisioned: false,
          orgRole: cached.orgRole,
          team: cached.team ?? null,
          runMode: runMode.mode,
          runModeScore: runMode.score,
        }
      }
    }
  }

  // 2. Router discovery + provisioning
  const router = readRouterDiscovery()
  if (!router) {
    console.warn(`[identity-bootstrap] router.json not found at ${ROUTER_JSON_PATH}; identity provisioning unavailable`)
    return null
  }

  const parentMemberId = (opts.envOverride?.SPAWN_PARENT_MEMBER_ID ?? process.env.SPAWN_PARENT_MEMBER_ID) ?? null

  const result = await provisionViaRouter(router, {
    name: deterministicKey,
    role,
    cwd,
    parentMemberId,
  }, fetchImpl)

  if ('error' in result) {
    console.warn(`[identity-bootstrap] provisioning failed: ${result.error}`)
    return null
  }

  // 3. Cache + return
  const entry: CachedIdentity = {
    memberId: result.memberId,
    secret: result.secret,
    deterministicKey,
    role,
    cwd,
    provisionedAt: new Date().toISOString(),
    orgRole: result.orgRole,
    team: result.team,
    ttlExpiresAt: null,
  }
  try {
    writeCache(entry)
  } catch (e: any) {
    console.warn(`[identity-bootstrap] cache write failed (continuing in-memory): ${e?.message ?? String(e)}`)
  }

  return {
    memberId: result.memberId,
    secret: result.secret,
    deterministicKey,
    role,
    cwd,
    isNewlyProvisioned: result.isNewlyCreated,
    orgRole: result.orgRole,
    team: result.team,
    runMode: runMode.mode,
    runModeScore: runMode.score,
  }
}

/**
 * Convenience: applied bootstrap result to process.env so downstream code
 * (signal-wire, wake-listener, MCP clients) can pick it up without
 * additional plumbing.
 */
export function applyIdentityToEnv(identity: ResolvedIdentity): void {
  process.env.SYNQTASK_MEMBER_ID = identity.memberId
  process.env.SYNQTASK_MEMBER_SECRET = identity.secret
  process.env.SYNQTASK_AGENT_ROLE = identity.role
  // Compatibility with existing plugin's OPENCODE_AGENT_INSTANCE_ID convention
  if (!process.env.OPENCODE_AGENT_INSTANCE_ID) {
    process.env.OPENCODE_AGENT_INSTANCE_ID = `opencode:${identity.deterministicKey}:${process.pid}`
  }
}
