/**
 * Config — reads ~/.config/claude-max-proxy/.env with overrides from process.env.
 * Keeps Bun-side of everything simple: one import, one config object.
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface ProxyConfig {
  // Logging
  logLevel: 'error' | 'info' | 'debug'
  logFormat: 'human' | 'json' | 'both'
  logFile: string
  logJsonl: string

  // KA tuning (clamped via engine anyway, but user-visible defaults)
  kaIntervalSec: number
  kaIdleTimeoutSec: number  // 0 = never stop
  kaMinTokens: number

  // Rewrite guard
  kaRewriteWarnIdleSec: number
  kaRewriteWarnTokens: number
  kaRewriteBlockIdleSec: number
  kaRewriteBlockEnabled: boolean

  // Network
  proxyPort: number
  proxyHost: string

  // Summary heartbeat
  healthHeartbeatSec: number  // 0 = disabled

  // Credentials
  credentialsPath: string

  // Upstream
  anthropicBaseUrl: string
}

const DEFAULT_ENV_PATH = join(homedir(), '.config', 'claude-max-proxy', '.env')

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function read(key: string, fallback: string, fileEnv: Record<string, string>): string {
  return process.env[key] ?? fileEnv[key] ?? fallback
}

function readInt(key: string, fallback: number, fileEnv: Record<string, string>): number {
  const v = read(key, String(fallback), fileEnv)
  const parsed = parseInt(v, 10)
  return isNaN(parsed) ? fallback : parsed
}

function readBool(key: string, fallback: boolean, fileEnv: Record<string, string>): boolean {
  const v = read(key, String(fallback), fileEnv).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

let _cached: ProxyConfig | null = null

export function loadConfig(envPath: string = DEFAULT_ENV_PATH): ProxyConfig {
  if (_cached) return _cached

  const fileEnv = parseDotEnv(envPath)

  const logLevel = read('LOG_LEVEL', 'info', fileEnv) as ProxyConfig['logLevel']
  if (!['error', 'info', 'debug'].includes(logLevel)) {
    console.error(`[config] Invalid LOG_LEVEL="${logLevel}", falling back to info`)
  }
  const logFormat = read('LOG_FORMAT', 'human', fileEnv) as ProxyConfig['logFormat']

  _cached = {
    logLevel: ['error', 'info', 'debug'].includes(logLevel) ? logLevel : 'info',
    logFormat: ['human', 'json', 'both'].includes(logFormat) ? logFormat : 'human',
    logFile: expandHome(read('LOG_FILE', '~/.claude/claude-max-proxy.log', fileEnv)),
    logJsonl: expandHome(read('LOG_JSONL', '~/.claude/claude-max-proxy.jsonl', fileEnv)),

    kaIntervalSec: readInt('KA_INTERVAL_SEC', 120, fileEnv),
    kaIdleTimeoutSec: readInt('KA_IDLE_TIMEOUT_SEC', 0, fileEnv),
    kaMinTokens: readInt('KA_MIN_TOKENS', 2000, fileEnv),

    kaRewriteWarnIdleSec: readInt('KA_REWRITE_WARN_IDLE_SEC', 300, fileEnv),
    kaRewriteWarnTokens: readInt('KA_REWRITE_WARN_TOKENS', 50000, fileEnv),
    kaRewriteBlockIdleSec: readInt('KA_REWRITE_BLOCK_IDLE_SEC', 0, fileEnv),
    kaRewriteBlockEnabled: readBool('KA_REWRITE_BLOCK_ENABLED', false, fileEnv),

    proxyPort: readInt('PROXY_PORT', 5050, fileEnv),
    proxyHost: read('PROXY_HOST', '127.0.0.1', fileEnv),

    healthHeartbeatSec: readInt('HEALTH_HEARTBEAT_SEC', 30, fileEnv),

    credentialsPath: expandHome(read('CLAUDE_CREDENTIALS_PATH', '~/.claude/.credentials.json', fileEnv)),

    anthropicBaseUrl: read('ANTHROPIC_UPSTREAM_URL', 'https://api.anthropic.com', fileEnv),
  }

  return _cached
}

/** For testing — reset cached config. */
export function _resetConfig(): void { _cached = null }
