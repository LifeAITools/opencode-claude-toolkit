/**
 * org-vault.ts — persisted per-organization credential vault + session→org pins.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * Claude Code keeps exactly ONE OAuth credential on disk
 * (`~/.claude/.credentials.json`). Logging into a different organization
 * OVERWRITES it — the previous org's refresh token is gone, so a session
 * HOLDing its old org (see proxy-client.ts selectSessionToken) dies as soon
 * as the in-memory access token expires (≤8h), and a proxy restart rebinds
 * every session onto whatever org the file currently holds (the 2026-06-08
 * "stand-down gap" incident class).
 *
 * Organizations are SEPARATE accounts: org B's login does not invalidate
 * org A's tokens upstream. So the fix is simply to never lose them: snapshot
 * every credential we see, keyed by the org it belongs to, and refresh each
 * org's token independently via the standard OAuth refresh grant.
 *
 * The vault stores:
 *   - `orgs`  — one credential record per organization UUID;
 *   - `pins`  — session → orgId bindings (ONLY the binding; tokens always
 *               come from `orgs`, so a stale pin can never resurrect a
 *               revoked token on its own).
 *
 * Org identity is verified empirically: Anthropic returns
 * `anthropic-organization-id` on every response, which the proxy feeds back
 * via `markVerified()` — the vault's view of "which org owns this token"
 * is grounded in what the API actually served, not just `~/.claude.json`.
 *
 * File: `~/.claude-local/org-vault.json`, mode 0600, atomic tmp+rename
 * writes. Every method is fail-soft (never throws) — vault problems must
 * degrade to "behave like before the vault existed", never break requests.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

/** Default vault location. NOT /tmp — must survive reboots. */
export const DEFAULT_ORG_VAULT_PATH = join(homedir(), '.claude-local', 'org-vault.json')

export interface OrgVaultEntry {
  orgId: string
  orgName?: string
  /** Account email that captured this credential (claude.json oauthAccount).
   *  First-class resolve() key: personal orgs happen to embed the email in
   *  orgName ("x@y's Organization"), but team/enterprise orgs carry custom
   *  names — email matching must not depend on Anthropic's naming. */
  accountEmail?: string
  accessToken: string
  refreshToken: string | null
  /** epoch ms; null = unknown (treat as alive, upstream 401 is the backstop) */
  expiresAt: number | null
  /** when this credential was captured from the system file or a refresh */
  capturedAt: number
  /** last time the API confirmed this org served a request with this token */
  lastVerifiedAt?: number
}

export interface OrgPin {
  orgId: string
}

interface VaultFile {
  version: 1
  orgs: Record<string, OrgVaultEntry>
  pins: Record<string, OrgPin>
  /** session → last-seen watermark (epoch ms) for pin GC (T4.3). Kept SEPARATE
   *  from `pins` so a pin record stays a pure `{orgId}` binding (no tokens, no
   *  GC metadata leaking into the binding contract). Absent for legacy files. */
  pinsSeen?: Record<string, number>
}

const EMPTY: VaultFile = { version: 1, orgs: {}, pins: {}, pinsSeen: {} }

export class OrgVault {
  private state: VaultFile = structuredClone(EMPTY)
  private loaded = false

  constructor(private readonly path: string = DEFAULT_ORG_VAULT_PATH) {}

  /** Lazy-load from disk. Fail-soft: a corrupt/missing file yields an empty vault. */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<VaultFile>
      if (raw && typeof raw === 'object') {
        this.state = {
          version: 1,
          orgs: (raw.orgs && typeof raw.orgs === 'object') ? raw.orgs as VaultFile['orgs'] : {},
          pins: (raw.pins && typeof raw.pins === 'object') ? raw.pins as VaultFile['pins'] : {},
          pinsSeen: (raw.pinsSeen && typeof raw.pinsSeen === 'object') ? raw.pinsSeen as VaultFile['pinsSeen'] : {},
        }
      }
    } catch { /* fail-soft: empty vault */ }
  }

  /** Atomic persist (tmp + rename), 0600. Fail-soft. */
  private persist(): void {
    try {
      const dir = dirname(this.path)
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* mode set on create */ }
      renameSync(tmp, this.path)
    } catch { /* fail-soft */ }
  }

  /** Insert/update an org credential record. Newer capture always wins. */
  upsert(entry: OrgVaultEntry): void {
    this.ensureLoaded()
    const prev = this.state.orgs[entry.orgId]
    // Keep the freshest credential; preserve verification timestamp + name.
    if (prev && prev.capturedAt > entry.capturedAt) return
    this.state.orgs[entry.orgId] = {
      ...entry,
      orgName: entry.orgName ?? prev?.orgName,
      accountEmail: entry.accountEmail ?? prev?.accountEmail,
      lastVerifiedAt: prev?.lastVerifiedAt && (!entry.lastVerifiedAt || prev.lastVerifiedAt > entry.lastVerifiedAt)
        ? prev.lastVerifiedAt : entry.lastVerifiedAt,
    }
    this.persist()
  }

  get(orgId: string): OrgVaultEntry | null {
    this.ensureLoaded()
    return this.state.orgs[orgId] ?? null
  }

  /** Fuzzy resolve: exact orgId, then unique prefix, then unique account
   *  email substring, then unique orgName substring. */
  resolve(query: string): OrgVaultEntry | null {
    this.ensureLoaded()
    const q = query.toLowerCase()
    const all = Object.values(this.state.orgs)
    const exact = this.state.orgs[query]
    if (exact) return exact
    const byPrefix = all.filter(e => e.orgId.toLowerCase().startsWith(q))
    if (byPrefix.length === 1) return byPrefix[0]!
    const byEmail = all.filter(e => (e.accountEmail ?? '').toLowerCase().includes(q))
    if (byEmail.length === 1) return byEmail[0]!
    const byName = all.filter(e => (e.orgName ?? '').toLowerCase().includes(q))
    if (byName.length === 1) return byName[0]!
    return null
  }

  list(): OrgVaultEntry[] {
    this.ensureLoaded()
    return Object.values(this.state.orgs).sort((a, b) => b.capturedAt - a.capturedAt)
  }

  /** API confirmed this org served a request — ground-truth verification. */
  markVerified(orgId: string, ts: number = Date.now()): void {
    this.ensureLoaded()
    const e = this.state.orgs[orgId]
    if (!e) return
    if (!e.lastVerifiedAt || ts > e.lastVerifiedAt) {
      e.lastVerifiedAt = ts
      this.persist()
    }
  }

  // ─── session → org pins (binding only; tokens live in orgs) ───

  setPin(sessionId: string, orgId: string): void {
    this.ensureLoaded()
    this.state.pins[sessionId] = { orgId }
    ;(this.state.pinsSeen ??= {})[sessionId] = Date.now()   // GC watermark (T4.3)
    this.persist()
  }

  getPin(sessionId: string): OrgPin | null {
    this.ensureLoaded()
    const pin = this.state.pins[sessionId]
    // Normalize to the pure binding contract (`{orgId}`) — GC metadata lives in
    // `pinsSeen`, never in the returned pin.
    return pin ? { orgId: pin.orgId } : null
  }

  deletePin(sessionId: string): void {
    this.ensureLoaded()
    if (this.state.pins[sessionId] || this.state.pinsSeen?.[sessionId] !== undefined) {
      delete this.state.pins[sessionId]
      if (this.state.pinsSeen) delete this.state.pinsSeen[sessionId]
      this.persist()
    }
  }

  pins(): Record<string, OrgPin> {
    this.ensureLoaded()
    return { ...this.state.pins }
  }

  /**
   * Refresh a pin's last-seen watermark (T4.3 GC anti-staleness). Throttled by
   * the caller via `minStaleMs`: only writes when the watermark is at least that
   * stale, so a hot request path costs at most one vault write per throttle
   * window per session. No-op when the session has no pin.
   */
  touchPin(sessionId: string, now: number = Date.now(), minStaleMs = 0): void {
    this.ensureLoaded()
    if (!this.state.pins[sessionId]) return
    const seen = (this.state.pinsSeen ??= {})
    const last = seen[sessionId]
    if (last !== undefined && now - last < minStaleMs) return
    seen[sessionId] = now
    this.persist()
  }

  /**
   * Retire session pins the caller deems dead (T4.3). `retain(sessionId,
   * lastSeenAt)` returns true to KEEP a pin. A pin with NO recorded watermark is
   * SEEDED to `now` (persisted) and kept this round — so a legacy pin gets a full
   * grace window and its clock starts even across restarts (the seed is
   * persisted, not reset each load). Only `pins` / `pinsSeen` are touched —
   * `orgs` (credentials) are NEVER dropped (a stale pin must never cost an org
   * its tokens). Returns the retired session ids.
   */
  gcPins(retain: (sessionId: string, lastSeenAt: number) => boolean, now: number = Date.now()): string[] {
    this.ensureLoaded()
    const seen = (this.state.pinsSeen ??= {})
    const retired: string[] = []
    let changed = false
    for (const sid of Object.keys(this.state.pins)) {
      let watermark = seen[sid]
      if (watermark === undefined) { watermark = seen[sid] = now; changed = true }   // seed grace
      if (retain(sid, watermark)) continue
      delete this.state.pins[sid]
      delete seen[sid]
      retired.push(sid)
      changed = true
    }
    if (changed) this.persist()
    return retired
  }
}
