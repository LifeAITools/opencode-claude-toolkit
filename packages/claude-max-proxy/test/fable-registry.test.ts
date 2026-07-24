/**
 * fable-registry.test.ts — registry completeness + fable-5 capability regression.
 *
 * Born from the 2026-06-10 drift: claude-fable-5 shipped, worked only via the
 * resolveModel passthrough fallback, and was invisible to cost/quota accounting
 * and the OpenAI-format surface. Root cause: capability gates bypassed the
 * models.ts SSOT. These tests fail the moment a model is reachable through the
 * OpenAI surface without a registry entry — so the next launch (claude-mythos-5
 * is already visible in the native CLI binary) is a one-file edit, not a hunt.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_MODELS,
  getModelMetadata,
  supportsAdaptiveThinking,
  supportsSamplingParams,
} from '@life-ai-tools/claude-code-sdk'
import {
  resolveModel,
  translateToAnthropicBody,
  SUPPORTED_MODELS,
  type OAIChatRequest,
} from '../src/openai-translate.js'

describe('registry completeness (SSOT enforcement)', () => {
  test('every SUPPORTED_MODELS id resolves to a model present in MAX_MODELS', () => {
    for (const { id } of SUPPORTED_MODELS) {
      const resolved = resolveModel(id)
      const meta = getModelMetadata(resolved)
      expect(meta, `${id} → ${resolved} has no MAX_MODELS entry — add it to src/models.ts`).toBeDefined()
    }
  })

  test('fable-5 is reachable by direct id and proxy-style alias', () => {
    expect(resolveModel('claude-fable-5')).toBe('claude-fable-5')
    expect(resolveModel('claude-v5-fable')).toBe('claude-fable-5')
    expect(SUPPORTED_MODELS.some(m => m.id === 'claude-fable-5')).toBe(true)
  })

  test('fable-5 registry entry carries correct pricing and caps', () => {
    const meta = MAX_MODELS['claude-fable-5']
    expect(meta).toBeDefined()
    expect(meta.cost).toEqual({ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 })
    expect(meta.context).toBe(1_000_000)
    expect(meta.maxOutput).toBe(128_000)
    expect(meta.adaptiveThinking).toBe(true)
    expect(meta.samplingParams).toBe(false)
  })

  test('opus-4-8 pricing matches current Anthropic price card (5/25)', () => {
    expect(MAX_MODELS['claude-opus-4-8'].cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })
})

describe('capability helpers (models.ts SSOT)', () => {
  test('adaptive thinking', () => {
    expect(supportsAdaptiveThinking('claude-fable-5')).toBe(true)
    expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true)
    expect(supportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false)
  })

  test('sampling params removed on fable-5/opus-4-7+/4-8, kept on 4-6 family', () => {
    expect(supportsSamplingParams('claude-fable-5')).toBe(false)
    expect(supportsSamplingParams('claude-opus-4-8')).toBe(false)
    expect(supportsSamplingParams('claude-opus-4-7')).toBe(false)
    expect(supportsSamplingParams('claude-opus-4-6')).toBe(true)
    expect(supportsSamplingParams('claude-sonnet-4-6')).toBe(true)
  })
})

describe('translateToAnthropicBody — 400-safety on sampling-removed models', () => {
  const baseReq = (model: string, extra: Partial<OAIChatRequest> = {}): OAIChatRequest => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    top_p: 0.9,
    ...extra,
  } as OAIChatRequest)

  test('fable-5: temperature/top_p are dropped (would 400 upstream)', () => {
    const body = JSON.parse(translateToAnthropicBody(baseReq('claude-fable-5')).body)
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })

  test('opus-4-8: temperature/top_p are dropped', () => {
    const body = JSON.parse(translateToAnthropicBody(baseReq('claude-opus-4-8')).body)
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })

  test('sonnet-4-6 regression: temperature/top_p still forwarded', () => {
    const body = JSON.parse(translateToAnthropicBody(baseReq('claude-sonnet-4-6')).body)
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
  })

  test('reasoning_effort on fable-5 → adaptive thinking, never budget_tokens', () => {
    const body = JSON.parse(
      translateToAnthropicBody(baseReq('claude-fable-5', { reasoning_effort: 'high' })).body,
    )
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  test('reasoning_effort on haiku (non-adaptive) → legacy budget_tokens path intact', () => {
    const body = JSON.parse(
      translateToAnthropicBody(baseReq('claude-haiku-4-5', { reasoning_effort: 'high' })).body,
    )
    expect(body.thinking?.type).toBe('enabled')
    expect(body.thinking?.budget_tokens).toBeGreaterThan(0)
  })
})

describe('5-series launch — opus-5 / sonnet-5 (2026-07-24)', () => {
  const baseReq = (model: string, extra: Partial<OAIChatRequest> = {}): OAIChatRequest => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    top_p: 0.9,
    ...extra,
  } as OAIChatRequest)

  test('both reachable by direct id and proxy-style alias', () => {
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5')
    expect(resolveModel('claude-v5-opus')).toBe('claude-opus-5')
    expect(resolveModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveModel('claude-v5-sonnet')).toBe('claude-sonnet-5')
    expect(SUPPORTED_MODELS.some(m => m.id === 'claude-opus-5')).toBe(true)
    expect(SUPPORTED_MODELS.some(m => m.id === 'claude-sonnet-5')).toBe(true)
  })

  test('opus-5 registry entry: adaptive-only, sampling removed, 5/25 pricing, 1M/128k', () => {
    const meta = MAX_MODELS['claude-opus-5']
    expect(meta).toBeDefined()
    expect(meta.adaptiveThinking).toBe(true)
    expect(meta.samplingParams).toBe(false)
    expect(meta.context).toBe(1_000_000)
    expect(meta.maxOutput).toBe(128_000)
    expect(meta.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })

  test('sonnet-5 registry entry: adaptive-only, sampling removed, 3/15 pricing, 1M/128k', () => {
    const meta = MAX_MODELS['claude-sonnet-5']
    expect(meta).toBeDefined()
    expect(meta.adaptiveThinking).toBe(true)
    expect(meta.samplingParams).toBe(false)
    expect(meta.context).toBe(1_000_000)
    expect(meta.maxOutput).toBe(128_000)
    expect(meta.cost).toEqual({ input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 })
  })

  test('capability gates resolve correctly for both (incl. dated snapshot variant)', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-20260724']) {
      expect(supportsAdaptiveThinking(id), `${id} must be adaptive`).toBe(true)
      expect(supportsSamplingParams(id), `${id} must reject sampling params`).toBe(false)
    }
  })

  test('400-safety: temperature/top_p dropped on opus-5 and sonnet-5 (would 400 upstream)', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5']) {
      const body = JSON.parse(translateToAnthropicBody(baseReq(id)).body)
      expect(body.temperature, `${id} temperature must be dropped`).toBeUndefined()
      expect(body.top_p, `${id} top_p must be dropped`).toBeUndefined()
    }
  })

  test('reasoning_effort on opus-5/sonnet-5 → adaptive thinking, never budget_tokens', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5']) {
      const body = JSON.parse(translateToAnthropicBody(baseReq(id, { reasoning_effort: 'high' })).body)
      expect(body.thinking).toEqual({ type: 'adaptive' })
    }
  })
})
