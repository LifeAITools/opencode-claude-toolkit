#!/usr/bin/env bun
/**
 * Build SDK into a single minified + obfuscated JS bundle for npm distribution.
 * 
 * Output:
 *   dist/index.js     — minified bundle (no source maps)
 *   dist/index.d.ts   — type declarations (from tsc)
 * 
 * Usage: bun run scripts/build-sdk.ts
 */

import { build } from 'esbuild'
import { minify } from 'terser'
import { readFile, writeFile, mkdir, cp, readdir, unlink } from 'fs/promises'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const SRC_ENTRY = join(ROOT, 'src/index.ts')
const DIST = join(ROOT, 'dist')

async function main() {
  console.log('[build] Step 1: esbuild bundle...')
  
  // Bundle all TS into a single JS file
  const result = await build({
    entryPoints: [SRC_ENTRY],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    outfile: join(DIST, 'index.tmp.js'),
    sourcemap: false,
    minifySyntax: true,     // simplify syntax (ternaries, etc.)
    minifyWhitespace: false, // terser does better
    treeShaking: true,
    // Keep class names for error instanceof checks
    keepNames: true,
    external: [],  // bundle everything — zero deps
  })

  if (result.errors.length) {
    console.error('[build] esbuild errors:', result.errors)
    process.exit(1)
  }

  console.log('[build] Step 2: terser minify + obfuscate...')
  
  const bundled = await readFile(join(DIST, 'index.tmp.js'), 'utf-8')
  
  const minified = await minify(bundled, {
    ecma: 2022,
    module: true,
    compress: {
      passes: 3,
      drop_console: false,   // keep console.error for debugging
      dead_code: true,
      unused: true,
      collapse_vars: true,
    },
    mangle: {
      // Obfuscate local variable/function names
      toplevel: true,
      // Preserve exported names and class names
      keep_classnames: true,
      keep_fnames: false,
      // Property mangling intentionally DISABLED. The `_`-prefixed
      // introspection getters (_cacheTtlMs, _registry, _timer, _inFlight,
      // _cacheTtlOverridden, ...) are the SDK's contract with external
      // consumers — claude-max-proxy's heartbeat + /stats read them by name.
      // Mangling them (was: properties.regex /^_[a-z]/) silently broke that
      // contract: the proxy read `undefined` and fell back to wrong defaults
      // (e.g. heartbeat ttlSec hardcoded to 3600 regardless of real TTL).
      // Local-variable mangling (toplevel) still gives the size win.
    },
    format: {
      comments: false,        // strip all comments
      beautify: false,
      ecma: 2022,
    },
  })

  if (minified.code) {
    // Add a header
    const header = `/**
 * claude-code-sdk — TypeScript SDK for Claude Code API
 * (c) ${new Date().getFullYear()} Kiberos. Compiled distribution.
 * Source access: see REQUEST-SOURCE.md in the GitHub repo.
 */\n`
    await writeFile(join(DIST, 'index.js'), header + minified.code)
    console.log(`[build] Bundle: ${(Buffer.byteLength(minified.code) / 1024).toFixed(1)} KB`)
  }

  // Cleanup temp
  await unlink(join(DIST, 'index.tmp.js')).catch(() => {})

  console.log('[build] Step 3: tsc declarations...')
  
  // Generate .d.ts files using tsc
  const proc = Bun.spawn(['bun', 'run', 'tsc', '--emitDeclarationOnly', '--declaration', '--outDir', DIST], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    console.error('[build] tsc declaration errors:', stderr)
    process.exit(1)
  }

  console.log('[build] Done!')
  
  // Show dist contents
  const files = await readdir(DIST, { recursive: true })
  for (const f of files) {
    console.log(`  dist/${f}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
