#!/usr/bin/env bun
/**
 * Cross-compile claude-max-proxy for multiple platforms.
 *
 * Builds TWO entrypoints per target — the proxy server and the quota-watcher
 * (Stage 2 of the quota pipeline runs as its own systemd unit):
 *   claude-max-proxy-<os>-<arch>
 *   claude-max-quota-watcher-<os>-<arch>
 *
 * The package version is inlined at build time via
 * `--define process.env.CLAUDE_MAX_PROXY_BUILD_VERSION` so /version reports
 * the real version (compiled binaries can't read package.json at runtime).
 *
 * Usage:
 *   bun run scripts/build-proxy.ts              # build for current platform
 *   bun run scripts/build-proxy.ts --all        # build all 4 targets
 *   bun run scripts/build-proxy.ts --target=bun-darwin-arm64
 */

import { $ } from 'bun'
import { mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const SRC = join(import.meta.dir, '..', 'src')
const DIST = join(import.meta.dir, '..', 'dist')
const PKG = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))
const VERSION = PKG.version ?? '0.0.0'

const ENTRIES = [
  { name: 'claude-max-proxy', entry: join(SRC, 'server.ts') },
  { name: 'claude-max-quota-watcher', entry: join(SRC, 'quota-watcher.ts') },
] as const

const ALL_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
] as const

type Target = typeof ALL_TARGETS[number]
type Entry = typeof ENTRIES[number]

function outName(entry: Entry, target: Target): string {
  const [, os, arch] = target.split('-')
  return `${entry.name}-${os}-${arch}`
}

async function buildOne(entry: Entry, target: Target): Promise<{ path: string; size: number; sha256: string }> {
  const outFile = join(DIST, outName(entry, target))
  console.log(`\n  Building ${entry.name} ${target} → ${outFile}`)

  const versionDefine = JSON.stringify(VERSION)
  const result = await $`bun build --compile --target=${target} --minify --define process.env.CLAUDE_MAX_PROXY_BUILD_VERSION=${versionDefine} ${entry.entry} --outfile ${outFile}`.quiet()
  if (result.exitCode !== 0) {
    console.error(`  ❌ Build failed for ${entry.name} ${target}:`, result.stderr.toString())
    throw new Error(`Build failed: ${entry.name} ${target}`)
  }

  const stat = statSync(outFile)
  const hash = createHash('sha256').update(readFileSync(outFile)).digest('hex')

  console.log(`  ✅ ${outName(entry, target)}  ${(stat.size / 1024 / 1024).toFixed(1)}MB  sha256:${hash.slice(0, 12)}...`)
  return { path: outFile, size: stat.size, sha256: hash }
}

// ── Parse args ────────────────────────────────────────────────

const args = process.argv.slice(2)
const buildAll = args.includes('--all')
const specificTarget = args.find(a => a.startsWith('--target='))?.split('=')[1] as Target | undefined

let targets: Target[]
if (buildAll) {
  targets = [...ALL_TARGETS]
} else if (specificTarget) {
  if (!ALL_TARGETS.includes(specificTarget)) {
    console.error(`Unknown target: ${specificTarget}. Available: ${ALL_TARGETS.join(', ')}`)
    process.exit(1)
  }
  targets = [specificTarget]
} else {
  const { platform, arch } = process
  const bunArch = arch === 'arm64' ? 'arm64' : 'x64'
  const bunOs = platform === 'darwin' ? 'darwin' : 'linux'
  targets = [`bun-${bunOs}-${bunArch}` as Target]
}

// ── Build ─────────────────────────────────────────────────────

console.log(`\nclaude-max-proxy v${VERSION} — building ${ENTRIES.length} entrypoint(s) × ${targets.length} target(s)`)
mkdirSync(DIST, { recursive: true })

const results: { name: string; target: string; size: number; sha256: string }[] = []
for (const t of targets) {
  for (const e of ENTRIES) {
    const r = await buildOne(e, t)
    results.push({ name: outName(e, t), target: t, size: r.size, sha256: r.sha256 })
  }
}

console.log(`\n══════════════════════════════════════`)
console.log(`  ${results.length} binaries built → ${DIST}/`)
for (const r of results) {
  console.log(`  ${r.name.padEnd(40)} ${(r.size / 1024 / 1024).toFixed(1)}MB`)
}
console.log(`══════════════════════════════════════\n`)
