# macOS audit — claude-max-proxy

Static audit performed on 2026-04-23 from Linux without access to a Mac.
Documents what was verified, what's assumed, and what requires real-Mac final validation.

## ✅ Verified statically

### plist XML structure
- Parses with `plistlib` (the same library launchd uses)
- Valid XML + DTD declared
- Required keys present: `Label`, `ProgramArguments`
- `Label` is reverse-DNS: `com.lifeaitools.claude-max-proxy`
- All path strings absolute (no `~` expansion inside plist — `${HOME}` is expanded at write-time in TS)
- `KeepAlive.SuccessfulExit=false` → launchd restarts on crash, not on clean exit

### Command syntax
| Command | macOS version | Status |
|---|---|---|
| `launchctl bootstrap gui/<uid> <plist>` | 10.10+ | ✅ modern |
| `launchctl bootout gui/<uid>/<label>` | 10.10+ | ✅ modern |
| `launchctl kickstart gui/<uid>/<label>` | 10.10+ | ✅ modern |
| `launchctl print gui/<uid>/<label>` | 11+ | ✅ with fallback |
| `launchctl list <label>` | legacy fallback | ✅ for older macOS |
| `launchctl load <plist>` | legacy fallback | ✅ if bootstrap fails |
| `launchctl unload <plist>` | legacy fallback | ✅ if bootout fails |
| `lsof -ti :PORT` | all macOS | ✅ pre-installed |
| `lsof -nP -iTCP:PORT -sTCP:ESTABLISHED -F p` | all macOS | ✅ flag compat with Linux |

### Filesystem paths
- `~/Library/LaunchAgents/` — canonical user-scope launchd location
- `~/.local/bin/` — created by our installer
- `~/.local/share/claude-max-proxy/` — created by our installer
- `~/.claude/` — created by native claude CLI

### Installer dependencies
- `bun` via `curl -fsSL https://bun.sh/install | bash` — Bun's official installer works identically on macOS, installs to `~/.bun/bin/bun`
- `claude` via `npm i -g @anthropic-ai/claude-code` — candidate paths cover:
  - `~/.npm-global/bin/claude` (custom npm prefix)
  - `/usr/local/bin/claude` (default Intel Mac)
  - `/opt/homebrew/bin/claude` (Apple Silicon Homebrew)

### Shell rc files
- `~/.zshrc` — macOS Catalina+ default
- `~/.bashrc` — pre-Catalina or opt-in bash users
- Both get `export PATH="$HOME/.local/bin:$PATH"` appended if absent

### Code signing / Gatekeeper
- `bun` binary from bun.sh is signed by Oven.sh — trusted by Gatekeeper
- `claude-max` wrapper is a plain `bun` shebang script — no binary, no notarization needed
- `claude` from npm is a Node.js script — same story

## ⚠ Known soft issues

None after the `launchctl bootstrap/bootout` migration (commit following this audit).

## 🔍 Requires real-Mac validation before npm publish

These cannot be proven without actually running on macOS:

1. **First-time `launchctl bootstrap`** behavior on newly-written plist  
   Expected: silent success. Risk: if launchd is strict about XML whitespace / encoding.

2. **Bun's `spawn()` with `stdio: 'inherit'`** on macOS Terminal.app / iTerm2  
   Expected: works (POSIX). Risk: none — Bun is well-tested on macOS.

3. **Blessed TUI** rendering on macOS Terminal  
   Expected: works — blessed is macOS-compatible. Risk: none.

4. **`process.getuid()`** returns sensible value (macOS user's UID, typically 501+)  
   Expected: works. Risk: none.

5. **Discovery state file** `fs.renameSync` atomicity on macOS (HFS+/APFS)  
   Expected: atomic rename is POSIX guaranteed on same-filesystem. Risk: none.

6. **Proxy auto-restart** when user logs out and back in (launchd KeepAlive)  
   Expected: works — that's the whole point of `RunAtLoad + KeepAlive`.

## Final Mac validation checklist (when Mac is available)

```bash
# 1. Clean state
rm -rf ~/.local/share/claude-max-proxy ~/.local/bin/claude-max
rm -f ~/Library/LaunchAgents/com.lifeaitools.claude-max-proxy.plist
rm -f ~/.claude/claude-max-proxy.json ~/.claude/claude-max-proxy.log

# 2. Install + run
claude-max --version
# Expected: install messages → "Proxy started via launchd" → "2.1.112 (Claude Code)"

# 3. Verify discovery
cat ~/.claude/claude-max-proxy.json
# Expected: {port, pid, startedAt, ...}

# 4. Verify launchd state
launchctl print gui/$UID/com.lifeaitools.claude-max-proxy | head -20
# Expected: state = running, pid matches discovery

# 5. Test auto-restart
kill -9 $(lsof -ti :5050)
sleep 2
lsof -ti :5050
# Expected: new PID — launchd KeepAlive kicked in

# 6. Test stop
claude-max stop -f
ls ~/.claude/claude-max-proxy.json 2>&1
# Expected: "No such file" — discovery cleaned

# 7. Test KA fire (use /tmp/fake-cc.ts from test dir)
# ... same as Linux validation

# 8. Test uninstall
claude-max uninstall
# Expected: plist removed, symlink removed, install dir removed
```
