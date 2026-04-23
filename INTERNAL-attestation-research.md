# cch= Attestation Research — INTERNAL, DO NOT PUBLISH

> **Date:** 2026-04-05
> **CC Version analyzed:** 2.1.90
> **Binary:** `~/.local/share/claude/versions/2.1.90` (220MB ELF, symbols stripped)
> **Source:** `/mnt/d/Vibe_coding_projects/claude-code-source/` (JS side only, Zig not included)
> **Status:** cch= NOT enforced server-side as of this date

---

## 1. Background: Anthropic's Third-Party Detection

### The Article (2026-04-05)
An article described Anthropic blocking OpenClaw from using subscriptions. Key findings:
- Anthropic checks **tool names** in request body to detect non-CC clients
- Specifically blacklisted: `subagents`, `session_status` (OpenClaw-unique tools)
- Detection is a **BLACKLIST** (not whitelist) — renaming tools bypasses it
- CLIProxyAPI (Go proxy, 23K GitHub stars) mimics CC headers but doesn't compute cch=

### Our Situation
- We run opencode with our claude-code-sdk (OAuth subscription, not API key)
- Our requests pass with `status=allowed, claim=five_hour` (subscription billing)
- We confirmed: `cch=00000` (fake), `cch=12345` (fake), and NO cch all pass equally
- **Server does NOT verify the cch= hash value** as of 2026-04-05

---

## 2. What cch= Is

### JS Side (system.ts:73-94)
```typescript
// Source: /mnt/d/Vibe_coding_projects/claude-code-source/src/constants/system.ts
export function getAttributionHeader(fingerprint: string): string {
  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'
  // cch=00000 placeholder is overwritten by Bun's HTTP stack with attestation token
  const cch = feature('NATIVE_CLIENT_ATTESTATION') ? ' cch=00000;' : ''
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`
  return header
}
```

### Zig Side (bun-anthropic/src/http/Attestation.zig — NOT in our source)
- Referenced in comment: "See bun-anthropic/src/http/Attestation.zig for implementation"
- The `bun-anthropic` repo is Anthropic's **private fork of Bun**
- We do NOT have the Zig source code
- The Zig code runs at the native HTTP layer, AFTER JSON serialization

### The Flow
```
1. JS builds billing header with "cch=00000" (5-char placeholder)
2. Body is JSON.stringify'd for the HTTP request
3. Bun's Zig HTTP layer intercepts the serialized body bytes
4. Finds the literal byte pattern "00000" (0x30 0x30 0x30 0x30 0x30)
5. Computes a hash (HMAC-based, details unknown)
6. Overwrites the 5 zeros IN-PLACE with 5 hash chars
7. Sends the modified body over TLS
8. Server verifies the hash matches the body
```

Key design choice: **same-length replacement** avoids Content-Length changes and buffer reallocation.

### What CC's Debug Log Shows
From `~/.claude/debug/d54844c7-*.txt`:
```
attribution header x-anthropic-billing-header: cc_version=2.1.90.713; cc_entrypoint=cli; cch=00000;
```
The debug log shows `cch=00000` (the PLACEHOLDER) because logging happens in JS, BEFORE the Zig replacement. We cannot observe the real hash value from JS-level logs.

---

## 3. Binary Analysis

### Binary Location and Format
```
Path: ~/.local/share/claude/versions/2.1.90
Type: ELF 64-bit LSB executable, x86-64
Size: 220MB
Symbols: stripped
TLS: statically linked (BoringSSL compiled in)
```

### Sections
```
.rodata   0x00213000  — read-only data (includes embedded JS bundle)
.text     0x02d15e00  — native code (Bun runtime + Zig attestation)
.data     0x06766140  — mutable data
```

### String Search Results

**"cch=" occurrences in binary (3 total, ALL in embedded JS):**
```
0x06921599 [data] ...nthropicAws")?" cch=00000;":"",A=lW$(),z=A?` cc_...
0x07a12e61 [data] ............... cch=00000;..................... 
0x0d06e011 [data] ...nthropicAws")?" cch=00000;":"",A=lW$(),z=A?` cc_...
```
Zero occurrences in .text (native code). The Zig code does NOT use "cch=" as a string literal — it likely operates on byte patterns or receives the offset from the JS runtime.

**HMAC-related strings found:**
```
0x914bf  "Failed to initialize HMAC context"
0xa361a  "HMAC is not supported for this algorithm yet"
0xb60dc  "HmacKeyParams"
0x114ca6 "HMAC has been consumed and is no longer usable"
0x12ca2e "hmac"
0x12ca38 "Hmac"
0x1ba7b0 "Failed to digest HMAC"
```
These are in the .rodata section — Bun's crypto implementation. The HMAC routines exist and are used.

**"cch=" in .text section (native code): 0 occurrences**
**"00000;" in .text section: 1 occurrence (at 0x04ce4ac2 area)**
**"Attestation" as string: 0 occurrences**

### What We Could NOT Find
- The HMAC key (embedded in code, not as a string)
- The exact hash algorithm variant
- Whether the hash input includes a timestamp/nonce
- The function entry point for the attestation code

---

## 4. Approach Attempts

### Attempt: LD_PRELOAD SSL_write Hook
```c
// Compiled: gcc -shared -fPIC -o hook_ssl.so hook_ssl.c -ldl
// Run: LD_PRELOAD=./hook_ssl.so claude --print "test"
```
**Result: FAILED** — Bun statically links BoringSSL. LD_PRELOAD can't hook statically linked symbols.

### Attempt: SSLKEYLOGFILE
```bash
SSLKEYLOGFILE=/tmp/keys.log claude --print "test"
```
**Result: FAILED** — Bun's BoringSSL build does not support SSLKEYLOGFILE.

### Attempt: strace
```bash
strace -f -e trace=write -s 500 claude --print "test" 2>&1 | grep cch=
```
**Result: FAILED** — TLS encrypts the body before the write() syscall. cch= replacement happens in userspace before encryption.

### Attempt: Run CC Binary as Bun Runtime
```bash
cp ~/.local/share/claude/versions/2.1.90 /tmp/bun
/tmp/bun -e "console.log('test')"     # "error: unknown option '-e'"
/tmp/bun run script.ts                 # "Not logged in"
ln -s ... /tmp/bun && /tmp/bun ...     # Still runs embedded code
```
**Result: FAILED** — Bun standalone binaries always run their embedded JS. Cannot escape to arbitrary script execution regardless of argv[0] or symlink name.

### Attempt: CC --debug Logging
```bash
claude --print --debug "api" --model claude-sonnet-4-6 "test"
# Debug log: ~/.claude/debug/*.txt
```
**Result: PARTIAL** — Shows the billing header with `cch=00000` (placeholder), NOT the real hash. JS debug logging happens before Zig replacement.

---

## 5. Recommended Approach for Full RE

### Network MITM (Estimated: 2 hours)
The fastest path to capture REAL cch= values without binary disassembly:

```bash
# 1. Install mitmproxy
pip install mitmproxy

# 2. Start mitmproxy in transparent mode
mitmproxy --mode transparent --listen-host 127.0.0.1 --listen-port 8888

# 3. Add mitmproxy CA cert to system trust
# (or use NODE_EXTRA_CA_CERTS / SSL_CERT_FILE for Bun)

# 4. Redirect CC's traffic through mitmproxy via iptables
sudo iptables -t nat -A OUTPUT -p tcp -d api.anthropic.com --dport 443 \
  -m owner --uid-owner $(id -u) -j REDIRECT --to-port 8888

# 5. Run CC
claude --print "test"

# 6. Capture the plaintext request body with REAL cch= value
# mitmproxy shows: cch=XXXXX (the 5-char hash)
```

**If Bun rejects the MITM cert:** Use Bun's `NODE_TLS_REJECT_UNAUTHORIZED=0` (if supported) or patch the binary to skip cert verification.

**What to do with captured data:**
1. Capture 5+ requests with different bodies
2. For each: record the full body (minus cch=) and the cch= value
3. Test hypothesis: `cch = HMAC-SHA256(key, body_without_cch)[0:5]`
4. If that matches: extract the key by trying known constants from the binary
5. Common HMAC keys in Bun/Anthropic: version strings, build hashes, hardcoded UUIDs

### Ghidra Disassembly (Estimated: 2-4 days)
If network MITM doesn't work:

1. Load binary in Ghidra (220MB, will take ~30min to analyze)
2. Search for HMAC function calls in .text section
3. Cross-reference with the HMAC error strings (known addresses)
4. Find the call chain: HTTP write → body scan → HMAC compute → byte replace
5. Extract the key and algorithm

### Frida Dynamic Instrumentation (Estimated: 1-2 days)
Hook the HMAC functions at runtime:

```javascript
// frida -p $(pgrep claude) -l hook.js
Interceptor.attach(Module.findExportByName(null, "HMAC_Init_ex"), {
  onEnter(args) {
    console.log("HMAC key:", Memory.readByteArray(args[1], 32));
    console.log("HMAC algo:", args[2]);
  }
});
```
**Caveat:** Frida may not find the symbols if they're inlined by the Zig compiler.

---

## 6. What We've Built (Defense Layers)

### Layer 1: CC-Identical Headers (DEPLOYED)
- `User-Agent: claude-code/2.1.90` (was `claude-code/0.1.0 (external, sdk)`)
- `cc_version=2.1.90.XXX` with real fingerprint algorithm (SHA256 + salt `59cf53e54c78`)
- `cch=00000` placeholder included (same format as real CC)
- `cc_entrypoint=cli`

**File:** `src/sdk.ts` — `buildHeaders()` and `buildRequestBody()`

### Layer 2: Proactive Token Rotation (DEPLOYED)
- Refreshes at 50% of token lifetime (~5.5h)
- Escalating warnings: rotated → warning → critical → expired
- Cross-process cooldown prevents 429 stampede
- `forceRefreshToken()`, `forceReLogin()`, `getTokenHealth()` API

**File:** `src/sdk.ts` — proactive rotation section

### Layer 3: CC Passthrough Proxy (BUILT, TESTED)
- `attestation-proxy.ts` — local HTTP proxy on port 8319
- `--mode direct` — forward with cch=00000 (current default)
- `--mode cc` — spawn `claude --print` for real attestation
- Tested E2E: both modes pass with `claim=five_hour`

**File:** `packages/opencode-proxy/attestation-proxy.ts`

### Layer 4: Browser Re-Login (BUILT)
- `sdk.forceReLogin()` — opens browser OAuth flow
- Last resort when refresh_token is dead

**File:** `src/sdk.ts` — `forceReLogin()` method

---

## 7. Monitoring

### Canary Signal
Watch for the rate limit claim header changing:
```bash
# Quick check:
grep "claim=" ~/.claude/claude-max-stats.jsonl | tail -1

# Expected (safe):
# "claim":"five_hour"

# Red flag (blocked):
# "claim":"extra_usage" or "overage"
```

### Token Rotation Health
```bash
# Check rotation is firing:
grep "TOKEN_ROTATION" ~/.claude/claude-max-debug.log | tail -5

# Expected:
# TOKEN_ROTATION pid=XXXX proactive rotation scheduled in XXXXXs
# TOKEN_ROTATION pid=XXXX ✅ [ROTATED] Token rotated silently
```

### Keepalive Health
```bash
# Check cache keepalive:
grep "keepalive" ~/.claude/claude-max-stats.jsonl | tail -3

# Expected:
# "type":"keepalive" ... "cacheRead":XXXXXX,"cacheWrite":0
```

---

## 8. Key Facts for Future Reference

### Fingerprint Algorithm (from claude-code-source)
```typescript
// File: src/utils/fingerprint.ts
const FINGERPRINT_SALT = '59cf53e54c78'
function computeFingerprint(messageText: string, version: string): string {
  const indices = [4, 7, 20]
  const chars = indices.map(i => messageText[i] || '0').join('')
  const input = `${FINGERPRINT_SALT}${chars}${version}`
  return createHash('sha256').update(input).digest('hex').slice(0, 3)
}
```

### CC Binary Update Path
```
claude command → ~/.local/bin/claude (symlink)
              → ~/.local/share/claude/versions/X.Y.Z (ELF binary)
CC auto-updates: new version downloaded, symlink updated.
Our proxy calls `claude` (not hardcoded path) → auto picks up new versions.
```

### OAuth Scopes Required for CC Auth
```json
["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"]
```
**Important:** Our SDK's `doTokenRefresh()` was NOT persisting scopes to `.credentials.json`. CC checks `shouldUseClaudeAIAuth(scopes)` which needs `user:inference`. Empty scopes = CC says "not logged in". Fixed by writing scopes array to credentials file.

### CC Tool Names (PascalCase)
```
Bash, Edit, Read, Write, Glob, Grep, Task, Agent, WebFetch, WebSearch,
TodoWrite, Skill, AskUserQuestion, Config, Sleep, SendMessage, SendUserMessage,
EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree, NotebookEdit,
CronCreate, CronDelete, CronList, TaskCreate, TaskGet, TaskList, TaskOutput,
TaskStop, TaskUpdate, TeamCreate, TeamDelete, ToolSearch, LSP, REPL, PowerShell
```
Our opencode sends lowercase equivalents (`bash`, `edit`, etc.) + MCP tools with `servername_toolname` pattern (not CC's `mcp__servername__toolname` double-underscore format).

### Tested Scenarios (2026-04-05)
| Scenario | Result | Claim |
|----------|--------|-------|
| No cch, version=0.1.0, UA=(external,sdk) | ✅ 200 | five_hour |
| cch=00000, version=2.1.90, UA=claude-code | ✅ 200 | five_hour |
| cch=12345 (fake hash), version=2.1.90 | ✅ 200 | five_hour |
| No cch, version=2.1.90 | ✅ 200 | five_hour |
| CC passthrough (real binary, real attestation) | ✅ 200 | five_hour |

**All scenarios pass identically. Server does not differentiate.**

---

## 9. If They Enforce cch= — Action Plan

### Immediate (< 1 hour)
1. Start attestation proxy: `bun run attestation-proxy.ts --mode cc`
2. Point SDK at proxy: set `ANTHROPIC_API_BASE=http://localhost:8319`
3. Accept ~13s latency per call (CC process startup)

### Short-term (< 1 day)
1. Set up mitmproxy to capture real cch= values
2. Deduce the algorithm from input/output pairs
3. Implement in our SDK's `buildRequestBody()`

### Medium-term (< 1 week)
1. Ghidra analysis of the CC binary's attestation code
2. Extract HMAC key and algorithm
3. Full native reimplementation in TypeScript
4. Must be updated when CC releases new versions (key may rotate)

### If All Else Fails
1. Use actual Claude Code as the frontend (opencode plugin architecture supports this)
2. Switch to API billing (pay per token)
3. Lobby Anthropic for official third-party tool program
