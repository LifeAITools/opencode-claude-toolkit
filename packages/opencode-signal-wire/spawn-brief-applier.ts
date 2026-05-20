/**
 * spawn-brief-applier — applies wake-router's inline_helper decision to a
 * spawned sub-session.
 *
 * Critical architecture note (discovered during impl):
 *   In opencode, `task` tool does NOT spawn a separate process. It creates
 *   a new session (sub-session) WITHIN THE SAME opencode runtime. The same
 *   plugin instance handles BOTH the parent session and child sub-session.
 *
 *   This means there's NO "child plugin reads env on boot" step — the args
 *   we injected (_swSpawnBriefRef etc.) never reach a subprocess.
 *
 *   Instead, we have to:
 *     1. Detect when chat.message arrives for a sub-session that was just
 *        spawned via our intercept (we have decisionLogId + spawnBriefRef
 *        in flight)
 *     2. Read the brief file
 *     3. Inject the per-call system-reminder into the chat parts
 *     4. Hook experimental.chat.system.transform to inject the composed
 *        system prompt for THAT specific sub-session ID
 *     5. Hook tool.execute.before to enforce the brief's blockedTools for
 *        THAT specific sub-session ID
 *
 * Storage:
 *   We maintain an in-memory `Map<sessionID, AppliedBrief>` keyed by the
 *   sub-session ID. Entries are populated when our intercept fires and
 *   we get back inline_ok. Entries are removed when the sub-session
 *   completes (or on a TTL).
 *
 * The brief on disk is read ONCE and then unlinked (Phase 4.3 decision A:
 * child deletes after read). Secrets don't persist on disk longer than
 * needed.
 */

import { readFileSync, unlinkSync } from 'fs'

export interface SpawnBrief {
  composedSystemPrompt: string
  perCallReminder: string
  ephemeralMemberId: string
  ephemeralMemberSecret: string
  allowedTools: string[]
  blockedTools: string[]
  promptHash: string
  parentMemberId: string
  task: {
    title: string
    description: string
    expectedOutput?: string
    deadlineSec?: number
    priority?: string
  }
}

export interface AppliedBrief extends SpawnBrief {
  /** Sub-session ID this brief applies to. Set when we observe the first chat.message. */
  sessionId: string | null
  /** Original brief file path. Cleared after first read. */
  briefRef: string
  /** Decision log ID for cross-reference. */
  decisionLogId: string
  /** When this brief was registered (parent intercept fire time). */
  registeredAt: number
  /** When the sub-session first picked up the brief. null = not yet picked up. */
  appliedAt: number | null
  /** Whether per-call reminder has been injected (only first chat.message). */
  reminderInjected: boolean
}

const TTL_MS = 60 * 60 * 1000  // 1h max — match wake-router brief TTL

/**
 * Map of all in-flight briefs. Keyed by spawnBriefRef path because that's
 * what we have at intercept time (session ID is unknown yet). On first
 * chat.message after intercept, we associate session ID by some heuristic
 * (most-recently-registered brief without sessionId).
 */
const briefs = new Map<string, AppliedBrief>()

/**
 * Register a brief at parent intercept time. Called from routeTaskThroughEngine
 * after we get inline_ok from router.
 */
export function registerBrief(args: {
  briefRef: string
  decisionLogId: string
  parentMemberId: string
}): void {
  // Read brief from disk
  let brief: SpawnBrief
  try {
    const raw = readFileSync(args.briefRef, 'utf-8')
    brief = JSON.parse(raw) as SpawnBrief
  } catch (e: any) {
    console.error(`[spawn-brief-applier] failed to read brief ${args.briefRef}: ${e?.message}`)
    return
  }

  const applied: AppliedBrief = {
    ...brief,
    sessionId: null,
    briefRef: args.briefRef,
    decisionLogId: args.decisionLogId,
    registeredAt: Date.now(),
    appliedAt: null,
    reminderInjected: false,
  }
  briefs.set(args.briefRef, applied)

  // Periodic cleanup of stale unclaimed briefs
  cleanupStaleBriefs()
}

/**
 * Called from chat.message hook. If this sub-session matches one of our
 * registered-but-unclaimed briefs, associate it and return the brief.
 *
 * Heuristic for matching: the most-recently-registered unclaimed brief.
 * This works because task tool intercept and the resulting chat.message
 * for the new sub-session happen in tight sequence (~tens of ms apart),
 * and intercepts for OTHER spawn paths can't happen between them on a
 * single plugin instance (Bun is single-threaded event loop).
 *
 * Race safety: if two task tool calls fire near-simultaneously, we may
 * mis-associate. Mitigation: register briefs are short-lived (cleaned up
 * on first chat.message claim) and the cost of mis-association is
 * "child gets wrong role brief" — visible in audit (decisionLogId mismatch)
 * and benign (role is still constrained, just maybe wrong role).
 */
export function claimBriefForSubSession(sessionId: string): AppliedBrief | null {
  // Find most recent unclaimed
  let pick: AppliedBrief | null = null
  let pickKey: string | null = null
  for (const [key, b] of briefs.entries()) {
    if (b.sessionId !== null) continue  // already claimed
    if (pick === null || b.registeredAt > pick.registeredAt) {
      pick = b
      pickKey = key
    }
  }
  if (!pick || !pickKey) return null

  pick.sessionId = sessionId
  pick.appliedAt = Date.now()

  // Delete brief file after read (Phase 4.3 decision A: short-lived secrets)
  try {
    unlinkSync(pick.briefRef)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`[spawn-brief-applier] failed to unlink brief ${pick.briefRef}: ${e?.message}`)
    }
  }
  // Keep entry in memory (now keyed by sessionId for lookups) — drop briefRef-keyed
  briefs.delete(pickKey)
  briefs.set(sessionId, pick)

  return pick
}

/**
 * Look up brief by session ID. Returns null if this session wasn't spawned
 * via our intercept (or brief expired / was cleaned up).
 */
export function getBriefForSession(sessionId: string): AppliedBrief | null {
  return briefs.get(sessionId) ?? null
}

/**
 * Mark per-call reminder as injected for this session. Prevents re-injection
 * on subsequent chat.message events in the same sub-session.
 */
export function markReminderInjected(sessionId: string): void {
  const b = briefs.get(sessionId)
  if (b) b.reminderInjected = true
}

/**
 * Release brief when sub-session is done (or on TTL). Removes from memory.
 */
export function releaseBrief(sessionId: string): void {
  briefs.delete(sessionId)
}

function cleanupStaleBriefs(): void {
  const now = Date.now()
  for (const [key, b] of briefs.entries()) {
    if (now - b.registeredAt > TTL_MS) {
      // Stale — never claimed by a sub-session. Clean up brief file too.
      try {
        if (b.briefRef) unlinkSync(b.briefRef)
      } catch { /* */ }
      briefs.delete(key)
    }
  }
}

/**
 * Test helper / introspection. Returns brief snapshot count.
 */
export function _getBriefsSnapshot(): { byRef: number; byParentMember: number } {
  let byRef = 0
  let byParentMember = 0
  for (const b of briefs.values()) {
    if (b.sessionId === null) byRef++
    else byParentMember++
  }
  return { byRef, byParentMember }
}
