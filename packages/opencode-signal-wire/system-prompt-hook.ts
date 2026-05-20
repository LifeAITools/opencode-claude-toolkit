/**
 * system-prompt-hook — implements opencode's `experimental.chat.system.transform`
 * hook to inject role-specific system prompts.
 *
 * Two execution paths handle the two ways opencode sessions are used:
 *
 *   1. PARENT SESSION (the main opencode interactive session):
 *      Uses the plugin's provisioned identity. Role's systemPrompt block
 *      is appended or replaces opencode default (per role's strategy).
 *
 *   2. SUB-SESSION (spawned via task tool, brief claimed in claimBriefForSubSession):
 *      Uses the ephemeral brief's composedSystemPrompt. Strategy from brief
 *      (typically 'replace' for staff-*).
 *
 * Strategy details (REQ-39, REQ-40, REQ-41):
 *   - append: opencode default stays at output.system[0]; our content pushed.
 *     Preserves Anthropic prompt cache prefix → cache hits across sessions.
 *   - replace: opencode default discarded; our content becomes output.system[0].
 *     Cache invalidation on first message of each replace-role session, but
 *     within a single session the prompt is stable. Used for focused staff-*
 *     where opencode default would dilute focus.
 *
 * Hook signature (from @opencode-ai/plugin):
 *   "experimental.chat.system.transform"(input: {sessionID?, model}, output: {system: string[]}): Promise<void>
 *
 * Error handling: never throw. If brief lookup fails or identity is missing,
 * we don't inject — opencode default is used as-is. The plugin's runtime is
 * never blocked by hook failures.
 *
 * Conformance: REQ-38..REQ-43, CR-04, CR-13, US-04, US-11.
 */

import { getBriefForSession, claimBriefForSubSession } from './spawn-brief-applier'
import { AGENT_IDENTITY_DIR } from './domain-constants'

interface SystemTransformInput {
  sessionID?: string
  model: { id?: string; providerID?: string; api?: { id?: string } }
}

interface SystemTransformOutput {
  system: string[]
}

interface ProvisionedIdentitySnapshot {
  memberId: string
  role: string
  orgRole?: {
    systemPrompt?: string
    metadata?: Record<string, string>
  }
}

/**
 * Resolve current parent-session identity. We rely on the cached identity
 * set by identity-bootstrap.ts (Phase 2.4). If not provisioned, return null
 * — hook becomes a no-op for that session.
 */
function getParentIdentity(): ProvisionedIdentitySnapshot | null {
  const memberId = process.env.SYNQTASK_MEMBER_ID
  if (!memberId) return null
  const role = process.env.SYNQTASK_AGENT_ROLE ?? 'developer'

  // identity-bootstrap caches orgRole in the agent-identity cache file.
  // For hook performance, we should ideally load this once per plugin lifetime.
  // For v1 simplicity, we re-read from cache on each hook call (it's a single
  // JSON file read, ~1ms; chat.message hook fires ~once per turn).
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    // Find cache file by deterministic key (computed by identity-bootstrap)
    // We stored it in env but actually need to enumerate. For now, scan the
    // identity dir and pick the one matching memberId.
    const cacheDir = AGENT_IDENTITY_DIR
    const { readdirSync } = require('fs') as typeof import('fs')
    let files: string[]
    try {
      files = readdirSync(cacheDir)
    } catch {
      return { memberId, role }  // cache dir doesn't exist
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(cacheDir, f), 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed.memberId === memberId) {
          return {
            memberId: parsed.memberId,
            role: parsed.role ?? role,
            orgRole: parsed.orgRole,
          }
        }
      } catch { continue }
    }
  } catch { /* */ }

  return { memberId, role }
}

/**
 * Format the role context as a single string block to inject.
 *
 * For PARENT sessions: synthesizes from identity cache's orgRole snapshot.
 * For SUB-SESSIONS: uses brief's pre-composed systemPrompt.
 */
function formatRoleBlock(identity: ProvisionedIdentitySnapshot): string {
  if (!identity.orgRole?.systemPrompt) {
    return `## Your Identity\n\nYou are operating as memberId=${identity.memberId}, role=${identity.role}.\n` +
           `(No OrgRole systemPrompt was found in cache — role definition may need refresh.)`
  }
  const md = identity.orgRole.metadata ?? {}
  const lines = [
    `## Your Role: ${identity.role}`,
    '',
    identity.orgRole.systemPrompt.trim(),
  ]
  // Capabilities, tools, limits — pull from metadata for parent-session injection.
  // (Sub-sessions get this already pre-composed in brief.composedSystemPrompt.)
  if (md.tools_allowed) {
    lines.push('', `**Tools allowed:** ${md.tools_allowed}`)
  }
  if (md.tools_blocked) {
    lines.push(`**Tools blocked:** ${md.tools_blocked}`)
  }
  if (md.can_spawn) {
    lines.push(`**Can spawn roles:** ${md.can_spawn}`)
  }
  return lines.join('\n')
}

/**
 * The hook callback. Registered in plugin export under
 * "experimental.chat.system.transform".
 */
export async function systemTransformHook(
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  // Hooks must never throw. Wrap everything.
  try {
    const sessionID = input.sessionID
    if (!sessionID) return

    // PATH 1: Sub-session — check if it has a brief to apply
    // First time we see this sub-session, claim a registered brief
    let brief = getBriefForSession(sessionID)
    if (!brief) {
      // Maybe this is the FIRST chat.message for a newly-spawned sub-session;
      // try to claim an unassociated brief.
      brief = claimBriefForSubSession(sessionID)
    }

    if (brief) {
      // Sub-session path: brief.composedSystemPrompt was already assembled by
      // wake-router's composable-prompt module per the role's strategy
      // (append vs replace). For ephemeral sub-sessions we always treat the
      // composed prompt as REPLACE — anchor the cache prefix on OUR content
      // only, discarding opencode default. Trade-off: small one-time cache
      // miss; benefit: full focus on role-specific instructions without
      // dilution from generic CLI prose.
      output.system[0] = brief.composedSystemPrompt
      output.system.length = 1
      return
    }

    // PATH 2: Parent session — synthesize from provisioned identity
    const identity = getParentIdentity()
    if (!identity?.orgRole) {
      // No identity or no role data → no-op. Hook should not break opencode.
      return
    }

    const roleBlock = formatRoleBlock(identity)
    const strategy = identity.orgRole.metadata?.system_prompt_strategy ?? 'append'

    if (strategy === 'replace') {
      // Replace opencode default
      output.system[0] = roleBlock
      output.system.length = 1
    } else {
      // Append (default) — preserves opencode cache prefix at [0]
      output.system.push(roleBlock)
    }
  } catch (e: any) {
    // Log to stderr but never throw — hook must not break opencode
    console.error(`[system-prompt-hook] error (non-fatal): ${e?.message ?? String(e)}`)
  }
}
