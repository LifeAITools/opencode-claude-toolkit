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

import type { SignalWireEvent, EmitResult } from '@kiberos/signal-wire-core'

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
 * Cache cost: appended text invalidates only the trailing tool-result
 * block, NOT the cache prefix. Cheap (~hint-size cw).
 */
export function applyHintResults(
  results: EmitResult[],
  output: { output: string; title: string; metadata: unknown },
): number {
  const hints: string[] = []
  for (const r of results) {
    if (r.type === 'hint' && r.success && r.hintText) {
      hints.push(r.hintText)
    }
  }
  if (hints.length > 0) {
    output.output = `${output.output}\n${hints.join('\n')}`
  }
  return hints.length
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
 * IMPORTANT: opencode validates each part needs `id`, `sessionID`,
 * `messageID` — pushing new bare parts crashes the session validator
 * with "Invalid input: expected string, received undefined". So we
 * APPEND the combined hint text to the last text part's `text` field
 * instead of creating new parts. The last text part already has all
 * required validator fields populated by opencode.
 *
 * Wrapping: each hint inside <signal-wire-hint rule="…"> tag so the
 * agent recognizes it as engine-injected (vs literal user input).
 *
 * Cache strategy: this mutation extends the LAST user message tail.
 * Cache prefix (system + prior turns) stays valid; only the very tail
 * invalidates. ~hint-size cache_write per fired rule.
 *
 * Returns: count of hints applied (0 if no part to mutate).
 */
export function applyChatHintResults(
  results: EmitResult[],
  output: { message: unknown; parts: unknown[] },
): number {
  const hints: { ruleId: string; text: string }[] = []
  for (const r of results) {
    if ((r.type === 'hint' || r.type === 'respond') && r.success && r.hintText) {
      hints.push({ ruleId: r.ruleId, text: r.hintText })
    }
  }
  if (hints.length === 0) return 0
  if (!Array.isArray(output.parts) || output.parts.length === 0) return 0

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
  const block = hints
    .map(h => `<signal-wire-hint rule="${h.ruleId}">\n${h.text}\n</signal-wire-hint>`)
    .join('\n')
  // Mutate in place — preserves all validator-required fields (id, sessionID,
  // messageID) on the existing part.
  target.text = `${target.text}\n${block}`
  return hints.length
}
