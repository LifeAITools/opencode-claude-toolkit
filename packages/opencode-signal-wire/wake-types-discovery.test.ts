import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { discoveryDir } from './wake-types'

let priorEnv: string | undefined

beforeEach(() => {
  priorEnv = process.env.WAKE_DISCOVERY_DIR
})

afterEach(() => {
  if (priorEnv === undefined) delete process.env.WAKE_DISCOVERY_DIR
  else process.env.WAKE_DISCOVERY_DIR = priorEnv
})

describe('discoveryDir() — WAKE_DISCOVERY_DIR override', () => {
  test('falls back to $HOME/.opencode/wake when env var is unset', () => {
    delete process.env.WAKE_DISCOVERY_DIR
    expect(discoveryDir()).toBe(join(homedir(), '.opencode', 'wake'))
  })

  test('honors WAKE_DISCOVERY_DIR when set', () => {
    process.env.WAKE_DISCOVERY_DIR = '/var/run/synqtask-discovery'
    expect(discoveryDir()).toBe('/var/run/synqtask-discovery')
  })

  test('lazy resolution: env var changes between calls are honored', () => {
    delete process.env.WAKE_DISCOVERY_DIR
    const before = discoveryDir()
    process.env.WAKE_DISCOVERY_DIR = '/tmp/late-discovery'
    const after = discoveryDir()
    expect(before).toBe(join(homedir(), '.opencode', 'wake'))
    expect(after).toBe('/tmp/late-discovery')
  })
})
