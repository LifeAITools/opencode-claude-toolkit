/**
 * Signal-Wire Hook Listener — OpenCode Hook Normalizers
 *
 * Pure functions that convert OpenCode `tool.execute.*` and `chat.message`
 * hook inputs/outputs into canonical `SignalWireEvent` payloads accepted
 * by `signalWire.evaluateHook()`. Plus appliers that route the engine's
 * `EmitResult[]` back into the mutable hook output.
 *
 * Ported from the DEPRECATED parallel package (renamed 2026-04-30):
 * `/home/relishev/packages/opencode-signal-wire_DEPRECATED_2026-04-20/src/listeners/hook-listener.ts`
 * on 2026-04-30 as part of signal-wire-architecture-v3 Stage 2
 * follow-up: completing the migration of in-process hook routing into the
 * canonical `@kiberos/signal-wire-core` engine.
 *
 * Hook callsite signatures (verified against opencode-ai 1.14.30 binary):
 *   trigger("tool.execute.before", {tool, sessionID, callID},          {args})
 *   trigger("tool.execute.after",  {tool, sessionID, callID, args},    {title, output, metadata, ...})
 *   trigger("chat.message",        {sessionID, agent, model, messageID, variant}, {message, parts})
 *
 * The mutable second arg is what the hook can modify in place to inject
 * hints (`output.output += hint`) or block tool execution
 * (`output.args.command = 'echo BLOCKED'`).
 *
 * Canonical event types (match `translateLegacyRules` output for
 * UserPromptSubmit/PreToolUse/PostToolUse):
 *   UserPromptSubmit → chat.message
 *   PreToolUse       → tool.before
 *   PostToolUse      → tool.after
 */

import { packHints, type SignalWireEvent, type EmitResult, type PackOutput } from '@kiberos/signal-wire-core'
import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─── Render diagnostics ─────────────────────────────────────────────
//
// HINT_PACKED line in opencode-signal-wire-debug.log records what the
// render layer decided per emit: total → kept after dedup/trim → bytes.
// Cheap audit: tail -f the log to see hint pressure & dropped reasons.

const RENDER_LOG = join(homedir(), '.claude', 'opencode-signal-wire-debug.log')
function logHintPacked(hook: string, sessionId: string | null, out: PackOutput): void {
  try {
    const line = `[${new Date().toISOString()}] {"step":"HINT_PACKED","hook":"${hook}","sessionId":"${sessionId ?? '?'}","total":${out.stats.total},"kept":${out.stats.kept},"deduped":${out.stats.deduped},"trimmed":${out.stats.trimmed},"bytes":${out.stats.bytes},"droppedDeduped":${JSON.stringify(out.droppedDeduped)},"droppedTrimmed":${JSON.stringify(out.droppedTrimmed)}}\n`
    appendFileSync(RENDER_LOG, line)
  } catch { /* logging best-effort */ }
}

/**
 * Default render budget — 4000 chars (~1k tokens). Empirically:
 *   - typical 6-hint emit = ~900 chars → well under budget
 *   - extreme 20-hint emit at peak quota = ~5000 chars → trim ~25% of low-pri
 * Tuneable via SW_HINT_MAX_CHARS env if production patterns shift.
 */
function renderBudget(): number {
  const env = process.env.SW_HINT_MAX_CHARS
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 4000
}

// Event-type literals (hardcoded so consumers don't need to import a constants
// table from core). Must stay in sync with `translateEventType()` in
// signal-wire-core/src/translate/index.ts.
const EVT_TOOL_BEFORE = 'tool.before'
const EVT_TOOL_AFTER = 'tool.after'
const EVT_CHAT_MESSAGE = 'chat.message'

// ─── Normalizers ────────────────────────────────────────────────────

/**
 * Normalize tool.execute.before hook inputs to SignalWireEvent.
 * The `output.args` field is the LIVE mutable args object — same reference
 * the tool will execute against. This means rule-action emitters that
 * mutate args (e.g. block emitter swapping a Bash command for a safe echo)
 * have effect.
 */
export function normalizeToolBefore(
  input: { tool: string; sessionID: string; callID: string },
  output: { args: unknown },
): SignalWireEvent {
  return {
    source: 'hook',
    type: EVT_TOOL_BEFORE,
    sessionId: input.sessionID,
    payload: {
      tool: input.tool,
      callID: input.callID,
      args: output.args,
      // Match payload.tool conventions used by other consumers (wake/legacy):
      // some rule matchers may key off `payload.toolName`.
      toolName: input.tool,
    },
    timestamp: Date.now(),
  }
}

/**
 * Normalize tool.execute.after hook inputs to SignalWireEvent.
 */
export function normalizeToolAfter(
  input: { tool: string; sessionID: string; callID: string; args: unknown },
  output: { title: string; output: string; metadata: unknown },
): SignalWireEvent {
  return {
    source: 'hook',
    type: EVT_TOOL_AFTER,
    sessionId: input.sessionID,
    payload: {
      tool: input.tool,
      toolName: input.tool,
      callID: input.callID,
      args: input.args,
      output: output.output,
      title: output.title,
      // Common shape used by translate.contextToEvent() so existing rule
      // matchers that look for `payload.response.output` keep working.
      response: { output: output.output },
    },
    timestamp: Date.now(),
  }
}

/**
 * Normalize chat.message hook inputs to SignalWireEvent.
 * For UserPromptSubmit-style rules (`events: ["UserPromptSubmit"]` →
 * canonical `chat.message`), matchers usually inspect `payload.prompt`
 * (string) or `payload.parts[].text`. We populate both.
 */
export function normalizeChatMessage(
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string },
  output: { message: unknown; parts: unknown[] },
): SignalWireEvent {
  // Concatenate text parts → single prompt string for keyword/regex matchers.
  const promptText = extractPromptText(output.parts)
  return {
    source: 'hook',
    type: EVT_CHAT_MESSAGE,
    sessionId: input.sessionID,
    payload: {
      parts: output.parts,
      message: output.message,
      agent: input.agent,
      messageID: input.messageID,
      // Match `contextToEvent()` payload contract (translate/index.ts:50-67)
      // so legacy `match.prompt_keywords` rules keep firing.
      prompt: promptText,
    },
    timestamp: Date.now(),
  }
}

function extractPromptText(parts: unknown[]): string {
  if (!Array.isArray(parts)) return ''
  const texts: string[] = []
  for (const p of parts) {
    if (p && typeof p === 'object') {
      const part = p as { type?: string; text?: string }
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text)
      }
    }
  }
  return texts.join('\n')
}

// ─── Result Appliers ────────────────────────────────────────────────

/**
 * Apply hint results to a tool.execute.after output by appending hint
 * text to `output.output`. The agent sees this as part of the tool's
 * response on the next turn.
 *
 * Routes through pack-hints helper so dedup/sort/trim/interpolate are
 * consistent with chat.message render path.
 *
 * Cache cost: appended text invalidates only the trailing tool-result
 * block, NOT the cache prefix. Cheap (~hint-size cw).
 *
 * Returns: count of hints rendered (after dedup/trim).
 */
export function applyHintResults(
  results: EmitResult[],
  output: { output: string; title: string; metadata: unknown },
  sessionId?: string | null,
): number {
  const packed = packHints(results, { maxChars: renderBudget() })
  if (packed.text.length === 0) return 0
  output.output = `${output.output}\n${packed.text}`
  logHintPacked('tool.execute.after', sessionId ?? null, packed)
  return packed.stats.kept
}

/**
 * Check if any block result indicates the tool action should be denied.
 * Returns the block reason if blocked (and mutates `output.args` to neuter
 * the action); otherwise null.
 *
 * For Bash tools: replaces `args.command` with a safe `echo` so the
 * dangerous command never runs but the agent still gets visible feedback.
 *
 * For non-Bash tools: empties `output.args` so the tool is invoked with
 * no parameters (typically a no-op or controlled error).
 */
export function applyBlockResults(
  results: EmitResult[],
  output: { args: unknown },
  toolName?: string,
): string | null {
  for (const r of results) {
    if (r.type === 'block' && r.blocked === true) {
      const reason = r.reason ?? 'blocked by signal-wire safety rule'

      if (toolName === 'Bash' || toolName === 'bash') {
        const args = output.args as Record<string, unknown> | undefined
        if (args && typeof args === 'object') {
          args.command = `echo '🛑 SIGNAL-WIRE BLOCKED: ${reason.replace(/'/g, "'\\''")}'`
        }
      } else {
        output.args = {}
      }
      return reason
    }
  }
  return null
}

/**
 * Apply hint results to a chat.message output.
 *
 * Routes through pack-hints helper for consistent dedup/sort/trim/interpolate.
 * The helper:
 *   - drops failed/non-hint results
 *   - dedupes by semantic_group (highest priority wins)
 *   - sorts by priority (critical → info)
 *   - trims under char budget (low/info first; critical/high never)
 *   - interpolates {contextPercent}, {pid}, {model}, etc. from runtimeMeta
 *
 * IMPORTANT: opencode validates each part needs `id`, `sessionID`,
 * `messageID` — pushing new bare parts crashes the session validator
 * with "Invalid input: expected string, received undefined". So we
 * APPEND the combined hint text to the last text part's `text` field
 * instead of creating new parts. The last text part already has all
 * required validator fields populated by opencode.
 *
 * Cache strategy: this mutation extends the LAST user message tail.
 * Cache prefix (system + prior turns) stays valid; only the very tail
 * invalidates. ~hint-size cache_write per fired rule.
 *
 * Returns: count of hints rendered (after dedup/trim).
 */
export function applyChatHintResults(
  results: EmitResult[],
  output: { message: unknown; parts: unknown[] },
  sessionId?: string | null,
): number {
  if (!Array.isArray(output.parts) || output.parts.length === 0) return 0

  const packed = packHints(results, { maxChars: renderBudget() })
  if (packed.text.length === 0) return 0

  // Find the last text part (search from end). Skip non-text parts (file,
  // image, tool-call, etc.) — appending into those is wrong.
  let targetIdx = -1
  for (let i = output.parts.length - 1; i >= 0; i--) {
    const p = output.parts[i] as { type?: string; text?: string }
    if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
      targetIdx = i
      break
    }
  }
  if (targetIdx < 0) return 0

  const target = output.parts[targetIdx] as { text: string }
  // Mutate in place — preserves all validator-required fields (id, sessionID,
  // messageID) on the existing part.
  target.text = `${target.text}\n${packed.text}`
  logHintPacked('chat.message', sessionId ?? null, packed)
  return packed.stats.kept
}
