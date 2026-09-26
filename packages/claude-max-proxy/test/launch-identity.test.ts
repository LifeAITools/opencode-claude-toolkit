/**
 * Клеймо запуска читается из окружения процесса — РОВНО три имени и ни одного
 * секрета: в том же окружении лежат ключи агента и мастер-ключ.
 */
import { describe, test, expect } from 'bun:test'
import { parseLaunchIdentity, readLaunchIdentity } from '../src/launch-identity.js'

describe('клеймо запуска', () => {
  test('берёт участника, имя и привязку', () => {
    const env = [
      'PATH=/usr/bin',
      'SYNQTASK_AGENT_UUID=25f2a25d-bcc1-4ffc-818a-c54a60b427da',
      'SYNQTASK_AGENT_ID=vibe-claude-code-sdk-owner',
      'KIBEROS_BINDING_ID=vibe_claude-code-sdk_owner_01',
      '',
    ].join('\0')
    expect(parseLaunchIdentity(env)).toEqual({
      memberId: '25f2a25d-bcc1-4ffc-818a-c54a60b427da',
      agentName: 'vibe-claude-code-sdk-owner',
      bindingId: 'vibe_claude-code-sdk_owner_01',
    })
  })

  test('секреты из того же окружения не выходят наружу', () => {
    const env = ['SYNQTASK_AGENT_SECRET=s3cret', 'KIBEROS_MASTER_KEY=k3y', 'SYNQTASK_AGENT_ID=a'].join('\0')
    const out = parseLaunchIdentity(env)
    expect(out).toEqual({ agentName: 'a' })
    expect(JSON.stringify(out)).not.toContain('s3cret')
    expect(JSON.stringify(out)).not.toContain('k3y')
  })

  test('клейма нет → null, а не пустой объект', () => {
    expect(parseLaunchIdentity('PATH=/usr/bin\0HOME=/x\0')).toBeNull()
    expect(parseLaunchIdentity('SYNQTASK_AGENT_ID=\0')).toBeNull()
  })

  test('несуществующий процесс → null, без броска', () => {
    expect(readLaunchIdentity(2 ** 30)).toBeNull()
  })

  test('свой процесс читается живьём', () => {
    // Под kiberos у прогона есть клеймо; вне его — честный null. Оба исхода верны,
    // проверяем, что чтение /proc само по себе работает и не бросает.
    const own = readLaunchIdentity(process.pid)
    expect(own === null || typeof own === 'object').toBe(true)
  })
})
