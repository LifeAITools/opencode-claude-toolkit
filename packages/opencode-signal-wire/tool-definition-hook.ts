/**
 * tool-definition-hook — implements opencode's `tool.definition` hook to
 * "hide" tools that the current role is not permitted to use.
 *
 * IMPORTANT — opencode API limitation:
 *   The `tool.definition` hook lets us modify a tool's description and
 *   parameters, but NOT remove it from the tools list entirely. The user
 *   preference was "hide entirely" — the best approximation given the API is:
 *     1. Replace description with "[BLOCKED for role X]" so LLM sees the
 *        tool exists but is unavailable
 *     2. Replace parameters with an empty schema so LLM can't construct a
 *        valid call
 *     3. Hard block at tool.execute.before (Phase 4.5.3) as final guard
 *
 *   This is defense in depth: LLM that ignores the [BLOCKED] marker and
 *   tries to call anyway gets stopped at execution.
 *
 * Per-session blocked lists:
 *   - Parent session: blocked = role.metadata.tools_blocked from cached
 *     OrgRole snapshot.
 *   - Sub-session: blocked = brief.blockedTools (the ephemeral list assembled
 *     by wake-router for this specific spawn).
 *
 * Hook signature:
 *   "tool.definition"(input: {toolID}, output: {description, parameters}): Promise<void>
 *
 * Conformance: REQ-42, US-04, "hide entirely" user preference.
 */

import { getBriefForSession } from './spawn-brief-applier'
import { AGENT_IDENTITY_DIR } from './domain-constants'

interface ToolDefinitionInput {
  toolID: string
  /** sessionID is unfortunately not in the input — opencode applies tool.definition globally per turn */
}

interface ToolDefinitionOutput {
  description: string
  parameters: any
}

interface ProvisionedIdentitySnapshot {
  memberId: string
  role: string
  orgRole?: {
    metadata?: Record<string, string>
  }
}

function getParentIdentity(): ProvisionedIdentitySnapshot | null {
  const memberId = process.env.SYNQTASK_MEMBER_ID
  if (!memberId) return null
  const role = process.env.SYNQTASK_AGENT_ROLE ?? 'developer'
  try {
    const { readFileSync, readdirSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const cacheDir = AGENT_IDENTITY_DIR
    let files: string[]
    try { files = readdirSync(cacheDir) } catch { return { memberId, role } }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'))
        if (parsed.memberId === memberId) {
          return { memberId: parsed.memberId, role: parsed.role ?? role, orgRole: parsed.orgRole }
        }
      } catch { continue }
    }
  } catch { /* */ }
  return { memberId, role }
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch { return [] }
  }
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * Cache of blocked tools per session. Avoids re-reading the identity cache
 * on every tool.definition call (fires N times per turn for N tools).
 *
 * Invalidated when:
 *   - Sub-session brief is released (releaseBrief)
 *   - identity-bootstrap runs (rare, once per plugin lifetime)
 *
 * For v1 we just rebuild on each plugin invocation start. If perf becomes
 * an issue (high tool count × many turns) we'll add invalidation.
 */
const blockedCache = new Map<string, string[]>()

function getBlockedForSession(sessionID: string | undefined): string[] {
  if (!sessionID) {
    // Hook may fire without sessionID (initial tool definition pass). Use parent.
    return blockedCache.get('__parent__') ?? computeParentBlocked()
  }

  // Try sub-session brief
  const brief = getBriefForSession(sessionID)
  if (brief) {
    const cached = blockedCache.get(sessionID)
    if (cached) return cached
    blockedCache.set(sessionID, brief.blockedTools)
    return brief.blockedTools
  }

  // Fall through to parent identity
  return blockedCache.get('__parent__') ?? computeParentBlocked()
}

function computeParentBlocked(): string[] {
  const identity = getParentIdentity()
  const blocked = parseList(identity?.orgRole?.metadata?.tools_blocked)
  blockedCache.set('__parent__', blocked)
  return blocked
}

/**
 * Test helper: clear cache (call when identity changes or for tests).
 */
export function invalidateBlockedCache(): void {
  blockedCache.clear()
}

/**
 * Test helper: peek at blocked list (for debugging).
 */
export function _getBlockedForSession(sessionID: string | undefined): string[] {
  return getBlockedForSession(sessionID)
}

/**
 * The hook callback. Registered in plugin export under "tool.definition".
 *
 * NOTE: opencode's tool.definition input doesn't include sessionID — it's
 * called per tool, per turn, but without per-session context. This means we
 * can ONLY use parent identity for blocking decisions. Per-sub-session
 * blocking has to happen at tool.execute.before (which DOES include
 * sessionID).
 *
 * This is a known limitation: the LLM in a sub-session may still see all
 * tools listed (with parent's descriptions). Hard block at execution time
 * is the final guard.
 */
export async function toolDefinitionHook(
  input: ToolDefinitionInput,
  output: ToolDefinitionOutput,
): Promise<void> {
  try {
    // Use parent identity since tool.definition is session-agnostic
    const blocked = computeParentBlocked()
    if (!blocked.includes(input.toolID)) return

    const identity = getParentIdentity()
    const role = identity?.role ?? 'unknown'

    output.description = `[BLOCKED for role ${role}] This tool is not available to your role. ` +
                          `Calls to this tool will be hard-blocked at execution. ` +
                          `Use one of your allowed tools, or escalate to a higher-privilege role via SynqTask delegation.`
    // Strip parameters — LLM can't construct a valid call
    output.parameters = { type: 'object', properties: {}, additionalProperties: false }
  } catch (e: any) {
    console.error(`[tool-definition-hook] error (non-fatal): ${e?.message ?? String(e)}`)
  }
}
