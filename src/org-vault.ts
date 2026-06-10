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
}

const EMPTY: VaultFile = { version: 1, orgs: {}, pins: {} }

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
      lastVerifiedAt: prev?.lastVerifiedAt && (!entry.lastVerifiedAt || prev.lastVerifiedAt > entry.lastVerifiedAt)
        ? prev.lastVerifiedAt : entry.lastVerifiedAt,
    }
    this.persist()
  }

  get(orgId: string): OrgVaultEntry | null {
    this.ensureLoaded()
    return this.state.orgs[orgId] ?? null
  }

  /** Fuzzy resolve: exact orgId, then unique prefix, then unique orgName substring. */
  resolve(query: string): OrgVaultEntry | null {
    this.ensureLoaded()
    const q = query.toLowerCase()
    const all = Object.values(this.state.orgs)
    const exact = this.state.orgs[query]
    if (exact) return exact
    const byPrefix = all.filter(e => e.orgId.toLowerCase().startsWith(q))
    if (byPrefix.length === 1) return byPrefix[0]!
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
    this.persist()
  }

  getPin(sessionId: string): OrgPin | null {
    this.ensureLoaded()
    return this.state.pins[sessionId] ?? null
  }

  deletePin(sessionId: string): void {
    this.ensureLoaded()
    if (this.state.pins[sessionId]) {
      delete this.state.pins[sessionId]
      this.persist()
    }
  }

  pins(): Record<string, OrgPin> {
    this.ensureLoaded()
    return { ...this.state.pins }
  }
}
