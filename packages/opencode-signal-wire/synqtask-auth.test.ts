/**
 * The listener's SynqTask calls authenticate as the AGENT, not with the human's bearer.
 * Measured 2026-09-25: lifecycle updates 401'd — they carried only opencode's OAuth bearer.
 */
import { describe, test, expect } from 'bun:test'
import { synqtaskAuthHeaders } from './wake-listener'

describe('synqtaskAuthHeaders', () => {
  test('bootstrap identity (SYNQTASK_MEMBER_*) wins over a bearer', () => {
    expect(synqtaskAuthHeaders({ SYNQTASK_MEMBER_ID: 'uuid-1', SYNQTASK_MEMBER_SECRET: 's1', SYNQTASK_BEARER_TOKEN: 'human' }))
      .toEqual({ 'X-Agent-Id': 'uuid-1', 'X-Agent-Secret': 's1' })
  })
  test('kiberos env alone is enough', () => {
    expect(synqtaskAuthHeaders({ SYNQTASK_AGENT_ID: 'name', SYNQTASK_AGENT_UUID: 'uuid-2', SYNQTASK_AGENT_SECRET: 's2' }))
      .toEqual({ 'X-Agent-Id': 'uuid-2', 'X-Agent-Secret': 's2' })
  })
  test('no agent identity → the bearer, as before', () => {
    expect(synqtaskAuthHeaders({ SYNQTASK_BEARER_TOKEN: 'tok' })).toEqual({ Authorization: 'Bearer tok' })
  })
  test('an id without a secret is not an identity', () => {
    expect(synqtaskAuthHeaders({ SYNQTASK_MEMBER_ID: 'uuid-1', SYNQTASK_BEARER_TOKEN: 'tok' })).toEqual({ Authorization: 'Bearer tok' })
  })
})
