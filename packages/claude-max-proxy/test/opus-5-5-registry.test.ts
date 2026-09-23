/**
 * Opus 5.5 / Fable 5.1 — registry + the "thinking can't be disabled" repair.
 *
 * Born 2026-09-23: Claude Code 2.1.280 put claude-opus-5-5 on the fleet (the API refuses
 * it from older clients). models.ts did not know it, so getModelMetadata fuzzy-matched it
 * onto claude-opus-5 — right caps, WRONG price (5/25 instead of 4/20, cache read 0.5
 * instead of 0.2), i.e. the savings display lied. Reported by home-relishev-general.
 *
 * Second half: on these models `thinking:{type:"disabled"}` is a 400 at EVERY effort,
 * so the old repair (lower effort to 'high') would forward a request that still fails.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_MODELS, getModelMetadata, clampEffortIfThinkingDisabled } from '@life-ai-tools/claude-code-sdk'
import { resolveModel, SUPPORTED_MODELS } from '../src/openai-translate.js'
import { EFFORT_ABOVE_HIGH_RE, THINKING_DISABLED_RE } from '../src/modules/anthropic.js'

describe('registry: point releases resolve to themselves, not to the base model', () => {
  test('opus-5-5 carries its own price, not opus-5’s', () => {
    expect(getModelMetadata('claude-opus-5-5')?.name).toBe('Claude Opus 5.5')
    expect(MAX_MODELS['claude-opus-5-5']!.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
  })
  test('fable-5-1 carries the 0.25 cache-read rate', () => {
    expect(getModelMetadata('claude-fable-5-1')?.name).toBe('Claude Fable 5.1')
    expect(MAX_MODELS['claude-fable-5-1']!.cost.cacheRead).toBe(0.25)
  })
  test('a dated / [1m] variant still lands on the point release (insertion order)', () => {
    expect(getModelMetadata('claude-opus-5-5[1m]')?.name).toBe('Claude Opus 5.5')
    expect(getModelMetadata('claude-opus-5[1m]')?.name).toBe('Claude Opus 5')
  })
  test('reachable through the OpenAI surface', () => {
    expect(resolveModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(resolveModel('claude-v5.5-opus')).toBe('claude-opus-5-5')
    expect(resolveModel('claude-v5.1-fable')).toBe('claude-fable-5-1')
    expect(SUPPORTED_MODELS.some(m => m.id === 'claude-opus-5-5')).toBe(true)
  })
})

describe('thinking repair is model-aware', () => {
  test('always-thinking model: explicit disabled is DROPPED, effort untouched', () => {
    const b: Record<string, unknown> = { model: 'claude-opus-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'xhigh' } }
    expect(clampEffortIfThinkingDisabled(b)).toBe('disabled')
    expect(b.thinking).toBeUndefined()
    expect((b.output_config as { effort: string }).effort).toBe('xhigh')
  })
  test('fable-5-1 with disabled at low effort is repaired too (400 at every effort)', () => {
    const b: Record<string, unknown> = { model: 'claude-fable-5-1', thinking: { type: 'disabled' } }
    expect(clampEffortIfThinkingDisabled(b)).toBe('disabled')
    expect(b.thinking).toBeUndefined()
  })
  test('opus-5 still accepts disabled ≤ high: old clamp kept', () => {
    const b: Record<string, unknown> = { model: 'claude-opus-5', thinking: { type: 'disabled' }, output_config: { effort: 'xhigh' } }
    expect(clampEffortIfThinkingDisabled(b)).toBe('xhigh')
    expect(b.thinking).toEqual({ type: 'disabled' })
    expect((b.output_config as { effort: string }).effort).toBe('high')
  })
  test('omitted thinking on a default-on model is NOT "off" — xhigh survives', () => {
    const b: Record<string, unknown> = { model: 'claude-opus-5', output_config: { effort: 'xhigh' } }
    expect(clampEffortIfThinkingDisabled(b)).toBeNull()
    expect((b.output_config as { effort: string }).effort).toBe('xhigh')
  })
  test('omitted thinking on opus-4-8 (default off) still clamps', () => {
    const b: Record<string, unknown> = { model: 'claude-opus-4-8', output_config: { effort: 'max' } }
    expect(clampEffortIfThinkingDisabled(b)).toBe('max')
  })
  test('text pre-check lets the disabled-only body through to the parser', () => {
    const raw = JSON.stringify({ model: 'claude-opus-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'low' } })
    expect(EFFORT_ABOVE_HIGH_RE.test(raw) || THINKING_DISABLED_RE.test(raw)).toBe(true)
  })
})
