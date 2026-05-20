#!/bin/bash
# proxy-upgrade — sync ONLY the body-capture feature from source to installed.
#
# Why surgical: source 0.8.1 and installed 0.5.2 have drifted across many files
# (config.ts, upstream.ts, etc.) for unrelated reasons. Mass overwrite would
# bring in untested changes. This script only touches what's required for
# body-capture: a single new file. The server.ts hook is already in installed
# (separately patched earlier). After this, `systemctl --user restart` activates.
#
# Safe to re-run; idempotent. Verifies file integrity via cmp.

set -euo pipefail

SOURCE=/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy
INSTALLED=/home/relishev/.local/share/claude-max-proxy

echo "── claude-max-proxy body-capture sync ──"
echo "source:    $SOURCE   v$(jq -r .version "$SOURCE/package.json")"
echo "installed: $INSTALLED   v$(jq -r .version "$INSTALLED/package.json")"
echo

if [[ ! -f "$SOURCE/src/body-capture.ts" ]]; then
  echo "ERROR: source body-capture.ts missing — source is out of date"
  exit 1
fi

# Already identical? Skip.
if cmp -s "$SOURCE/src/body-capture.ts" "$INSTALLED/src/body-capture.ts" 2>/dev/null; then
  echo "✓ body-capture.ts already in sync"
else
  echo "→ copying body-capture.ts to installed"
  cp "$SOURCE/src/body-capture.ts" "$INSTALLED/src/body-capture.ts"
fi

# Verify server.ts has the import + hook (was applied earlier).
if ! grep -q "captureBody" "$INSTALLED/src/server.ts"; then
  echo "✗ installed server.ts MISSING captureBody hook — manual patch needed"
  echo "  See $SOURCE/src/server.ts for the canonical pattern"
  exit 1
fi
echo "✓ installed server.ts has captureBody hook"

# Verify heartbeat.ts has PROXY_KA_TICK per-session emit.
if ! grep -q "PROXY_KA_TICK" "$INSTALLED/src/heartbeat.ts"; then
  echo "✗ installed heartbeat.ts MISSING PROXY_KA_TICK per-session ticks — manual patch needed"
  echo "  See $SOURCE/src/heartbeat.ts for the canonical pattern"
  exit 1
fi
echo "✓ installed heartbeat.ts emits PROXY_KA_TICK per session"

echo
echo "── ready to restart ──"
echo "Run: systemctl --user restart claude-max-proxy"
echo
echo "Or to verify after restart:"
echo "  bun run $SOURCE/../../scripts/proxy-doctor.ts"
