import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CredentialManager,
  getClaudeConfigDir,
  getGlobalCredentialPath,
  getLocalCredentialPath,
  resolveCredentialPath,
} from '../packages/opencode-plugin/src/index.ts'

describe('opencode plugin auth helpers', () => {
  let sandbox: string
  let cwd: string
  let originalClaudeConfigDir: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'opencode-plugin-auth-'))
    cwd = join(sandbox, 'project')
    mkdirSync(cwd, { recursive: true })
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'global-claude')
  })

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    rmSync(sandbox, { recursive: true, force: true })
  })

  test('getClaudeConfigDir respects CLAUDE_CONFIG_DIR', () => {
    expect(getClaudeConfigDir()).toBe(join(sandbox, 'global-claude'))
    expect(getGlobalCredentialPath()).toBe(join(sandbox, 'global-claude', '.credentials.json'))
  })

  test('resolveCredentialPath prefers local project credentials over global', () => {
    const localPath = getLocalCredentialPath(cwd)
    const globalPath = getGlobalCredentialPath()

    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(join(sandbox, 'global-claude'), { recursive: true })

    writeFileSync(localPath, JSON.stringify({ claudeAiOauth: { accessToken: 'local-token' } }))
    writeFileSync(globalPath, JSON.stringify({ claudeAiOauth: { accessToken: 'global-token' } }))

    expect(resolveCredentialPath(cwd)).toBe(localPath)
  })

  test('resolveCredentialPath falls back to global when local is missing', () => {
    const globalPath = getGlobalCredentialPath()
    mkdirSync(join(sandbox, 'global-claude'), { recursive: true })
    writeFileSync(globalPath, JSON.stringify({ claudeAiOauth: { accessToken: 'global-token' } }))

    expect(resolveCredentialPath(cwd)).toBe(globalPath)
  })

  test('CredentialManager switches storage path and persists Claude-style credentials', () => {
    const localPath = getLocalCredentialPath(cwd)
    const globalPath = getGlobalCredentialPath()

    mkdirSync(join(sandbox, 'global-claude'), { recursive: true })
    writeFileSync(globalPath, JSON.stringify({ claudeAiOauth: { accessToken: 'global-token' } }))

    const creds = new CredentialManager(cwd)
    expect(creds.credPath).toBe(globalPath)

    creds.setCredentialPath(localPath)
    creds.setCredentials('local-access', 'local-refresh', 123456)

    expect(creds.credPath).toBe(localPath)

    const saved = new CredentialManager(cwd, localPath)
    expect(saved.hasCredentials).toBe(true)
    expect(saved.token).toBe('local-access')

    const globalReloaded = new CredentialManager(cwd, globalPath)
    expect(globalReloaded.token).toBe('global-token')
  })
})
