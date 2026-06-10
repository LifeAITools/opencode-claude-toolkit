#!/bin/bash
# deploy-from-source — the ONE repeatable way to deploy claude-max-proxy.
#
# WHY THIS EXISTS (Rule #15 deploy-and-verify-live):
# The live install at $INSTALLED was historically hand-edited in place, so it
# silently drifted from source — which once dropped the stats-emitter startup and
# killed the quota pipeline for 27h unnoticed. This script makes deploy a pure,
# repeatable function of source.
#
# RUNTIME = COMPILED BINARIES (since 2026-06-10). The systemd units run
# self-contained binaries from $INSTALLED/bin/ — the service has ZERO runtime
# dependency on $INSTALLED/node_modules. (On 2026-06-10 a partial dependency
# sync import-crashed the src-mode proxy 129 times until systemd StartLimit.)
# src/ + node_modules are still synced for the TUI (`claude-max watch`),
# debugging, and as a documented fallback — but the service never reads them.
#
# NEVER hand-edit $INSTALLED again. Edit source, run this.
#
# Usage:
#   bash deploy-from-source.sh --dry-run   # show what would change, no writes
#   bash deploy-from-source.sh             # backup -> build -> deploy -> restart -> verify
set -euo pipefail

SRC_REPO=/home/relishev/projects/vibe/claude-code-sdk
PROXY_PKG_DIR=$SRC_REPO/packages/claude-max-proxy
PROXY_SRC=$PROXY_PKG_DIR/src
PROXY_PKG=$PROXY_PKG_DIR/package.json
SDK_DIST=$SRC_REPO/dist
SDK_PKG=$SRC_REPO/package.json
INSTALLED=/home/relishev/.local/share/claude-max-proxy
SDK_DST=$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk
MANIFEST=$INSTALLED/.deploy-manifest.json
BACKUP_ROOT=/home/relishev/.claude-local/proxy-backups
UNIT_DIR=$HOME/.config/systemd/user
BUN=$HOME/.bun/bin/bun

PLATFORM_SUFFIX=linux-x64
PROXY_BIN_NAME=claude-max-proxy-$PLATFORM_SUFFIX
WATCHER_BIN_NAME=claude-max-quota-watcher-$PLATFORM_SUFFIX

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
log(){ echo "[$(date +%H:%M:%S)] $*"; }

# Preview drift before doing anything
log "diff: live src vs source src"
diff -rq "$INSTALLED/src" "$PROXY_SRC" 2>/dev/null | grep -vE '\.bak|\.broken|node_modules' || log "  (in sync)"

if [ "$DRY" = 1 ]; then log "DRY-RUN — no changes"; exit 0; fi

# 1. Backup
BK="$BACKUP_ROOT/deploy-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp -a "$INSTALLED/src" "$BK/src"
cp -a "$INSTALLED/package.json" "$BK/package.json"
[ -d "$SDK_DST/dist" ] && cp -a "$SDK_DST/dist" "$BK/sdk-dist"
[ -d "$INSTALLED/bin" ] && cp -a "$INSTALLED/bin" "$BK/bin"
log "backup -> $BK"

# 2. Sync src (recursive, incl. modules/). Additive — NOT --delete: the live
#    tree holds non-source state that must survive (.claude/ hook state, *.bak
#    manual backups). Stale source-removed files are surfaced by the dry-run diff
#    above for manual review instead of being auto-nuked.
rsync -a --exclude='.claude' --exclude='*.bak*' --exclude='*.broken' "$PROXY_SRC/" "$INSTALLED/src/"
cp "$PROXY_PKG" "$INSTALLED/package.json"
log "src synced (TUI/debug/fallback only — service runs the binary)"

# 3a. Install registry deps with the FULL transitive closure (TUI deps).
#     Hand-syncing individual packages is FORBIDDEN here: on 2026-06-10 a
#     partial sync (ucm-schema+zod+ajv without ajv's fast-deep-equal)
#     import-crashed the proxy 129 times until systemd StartLimit.
log "bun install (full dependency closure, TUI/fallback)"
( cd "$INSTALLED" && "$BUN" install --no-save >/dev/null 2>&1 ) \
  || { log "BUN INSTALL FAILED in $INSTALLED — aborting deploy"; exit 1; }

# 3b. Rebuild SDK from source — the compiled binary bundles the SDK via the
#     monorepo symlink (node_modules/@life-ai-tools/claude-code-sdk -> repo root,
#     entry = dist/index.js), so a stale dist = stale code INSIDE the binary.
#     (2026-05-28 thinking-block flood: fix in source, stale bundle deployed.)
log "building SDK bundle from source"
( cd "$SRC_REPO" && "$BUN" run build >/dev/null 2>&1 ) || { log "SDK BUILD FAILED — aborting deploy"; exit 1; }
rm -rf "$SDK_DST/dist"; cp -a "$SDK_DIST" "$SDK_DST/dist"
cp "$SDK_PKG" "$SDK_DST/package.json"
log "SDK synced ($(grep -o '"version": "[^"]*"' "$SDK_DST/package.json" | head -1))"

# 3c. Compile the runtime binaries (server + quota-watcher) and install them.
#     Version is inlined at build time (--define) so /version reports truth.
log "compiling binaries ($PLATFORM_SUFFIX)"
( cd "$PROXY_PKG_DIR" && "$BUN" run scripts/build-proxy.ts --target=bun-$PLATFORM_SUFFIX >/dev/null 2>&1 ) \
  || { log "BINARY BUILD FAILED — aborting deploy"; exit 1; }
mkdir -p "$INSTALLED/bin"
# Stage with a temp name then mv: replacing a running binary in place corrupts
# the mapped executable; mv is atomic on the same fs (and preserves the exec bit
# — `cat > file` does NOT, see kibctl deploy gotcha).
install -m 755 "$PROXY_PKG_DIR/dist/$PROXY_BIN_NAME" "$INSTALLED/bin/.claude-max-proxy.new"
install -m 755 "$PROXY_PKG_DIR/dist/$WATCHER_BIN_NAME" "$INSTALLED/bin/.claude-max-quota-watcher.new"
mv "$INSTALLED/bin/.claude-max-proxy.new" "$INSTALLED/bin/claude-max-proxy"
mv "$INSTALLED/bin/.claude-max-quota-watcher.new" "$INSTALLED/bin/claude-max-quota-watcher"
log "binaries -> $INSTALLED/bin/ ($(du -h "$INSTALLED/bin/claude-max-proxy" | cut -f1) + $(du -h "$INSTALLED/bin/claude-max-quota-watcher" | cut -f1))"

# 3d. Failure-alert hook (OnFailure= target). Fires when a unit exhausts its
#     restart budget and lands in 'failed' — the exact 2026-06-10 silent-crash-loop
#     scenario (129 restarts, zero alerts).
cat > "$INSTALLED/bin/.proxy-failure-alert.sh.new" <<'ALERT'
#!/bin/bash
# Invoked by systemd OnFailure= with the failed unit name as $1.
UNIT="${1:-claude-max-proxy.service}"
MSG="$UNIT FAILED (restart budget exhausted) — proxy down for all Claude sessions. journalctl --user -u $UNIT"
logger -p user.crit -t claude-max-alert "$MSG"
# Desktop notification (user systemd units have XDG_RUNTIME_DIR; point at the session bus)
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}"
notify-send -u critical "claude-max-proxy DOWN" "$MSG" 2>/dev/null || true
# kibctl notify (no-op until alert_email is configured on this machine)
/opt/kiberos/kibctl notify --subject "claude-max-proxy DOWN on $(hostname)" --body "$MSG" >/dev/null 2>&1 || true
exit 0
ALERT
chmod 755 "$INSTALLED/bin/.proxy-failure-alert.sh.new"
mv "$INSTALLED/bin/.proxy-failure-alert.sh.new" "$INSTALLED/bin/proxy-failure-alert.sh"

# 4. Write deploy manifest (sha256 of every live src file + the binaries).
#    Startup compares src hashes against this to detect post-deploy hand-edits.
COMMIT=$(git -C "$SRC_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
{
  echo "{"
  echo "  \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"sourceCommit\": \"$COMMIT\","
  echo "  \"runtime\": \"binary\","
  echo "  \"binaries\": {"
  echo "    \"bin/claude-max-proxy\": \"$(sha256sum "$INSTALLED/bin/claude-max-proxy" | cut -d' ' -f1)\","
  echo "    \"bin/claude-max-quota-watcher\": \"$(sha256sum "$INSTALLED/bin/claude-max-quota-watcher" | cut -d' ' -f1)\""
  echo "  },"
  echo "  \"files\": {"
  first=1
  while IFS= read -r f; do
    rel=${f#"$INSTALLED/"}
    h=$(sha256sum "$f" | cut -d' ' -f1)
    [ $first = 1 ] && first=0 || echo ","
    printf '    "%s": "%s"' "$rel" "$h"
  done < <(find "$INSTALLED/src" -name '*.ts' ! -name '*bak*' ! -name '*.broken' | sort)
  echo ""
  echo "  }"
  echo "}"
} > "$MANIFEST"
log "manifest -> $MANIFEST ($(find "$INSTALLED/src" -name '*.ts' ! -name '*bak*' | wc -l) files, commit $COMMIT)"

# 4b. systemd units — regenerated every deploy so unit drift is impossible.
#     ExecStart = the compiled binary; OnFailure = alert hook.
cat > "$UNIT_DIR/claude-max-proxy.service" <<UNIT
[Unit]
Description=claude-max-proxy — cache keepalive proxy for Claude Code CLI
After=network-online.target
Wants=network-online.target
OnFailure=claude-max-proxy-alert@%n.service

[Service]
Type=simple
ExecStart=$INSTALLED/bin/claude-max-proxy
Restart=on-failure
RestartSec=2
StandardOutput=append:$HOME/.claude/claude-max-proxy.log
StandardError=append:$HOME/.claude/claude-max-proxy.log
Environment=LOG_LEVEL=info
Environment=LOG_FORMAT=both
# Dump retention = 24h (proxy body-capture + SDK body-dumps).
Environment=CLAUDE_MAX_PROXY_CAPTURE_TTL_HOURS=24
Environment=CLAUDE_BODY_DUMP_RETENTION_MS=86400000

[Install]
WantedBy=default.target
UNIT

cat > "$UNIT_DIR/claude-max-quota-watcher.service" <<UNIT
[Unit]
Description=claude-max-quota-watcher — Stage 2 (PROCESSOR) of the quota pipeline
Documentation=file://$INSTALLED/src/quota-watcher.ts
# Stats stream is produced by the proxy's emitter; start after it when present.
After=network-online.target claude-max-proxy.service
Wants=network-online.target
OnFailure=claude-max-proxy-alert@%n.service

[Service]
Type=simple
ExecStart=$INSTALLED/bin/claude-max-quota-watcher
Restart=on-failure
RestartSec=2
StandardOutput=append:$HOME/.claude/claude-max-quota-watcher.log
StandardError=append:$HOME/.claude/claude-max-quota-watcher.log
Environment=CLAUDE_CREDENTIALS_PATH=$HOME/.claude/.credentials.json

[Install]
WantedBy=default.target
UNIT

cat > "$UNIT_DIR/claude-max-proxy-alert@.service" <<UNIT
[Unit]
Description=Alert hook — fires when %i exhausts its restart budget

[Service]
Type=oneshot
ExecStart=$INSTALLED/bin/proxy-failure-alert.sh %i
UNIT

systemctl --user daemon-reload
log "systemd units regenerated (binary ExecStart + OnFailure alert)"

# 5a. Guard: port 5050 must belong to the systemd unit. A stray manual
#     instance survives `systemctl restart` and EADDRINUSE-crash-loops
#     the unit until StartLimit (129 crashes on 2026-06-10). Fail loudly instead.
PORT_PID=$(ss -tlnp 2>/dev/null | grep -o ':5050 .*pid=[0-9]*' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
UNIT_PID=$(systemctl --user show claude-max-proxy.service -p MainPID --value 2>/dev/null || echo 0)
if [ -n "${PORT_PID:-}" ] && [ "$PORT_PID" != "$UNIT_PID" ]; then
  log "ABORT: port 5050 held by stray pid $PORT_PID (unit MainPID=$UNIT_PID)."
  log "A non-systemd proxy instance is running. Verify and stop it first: kill $PORT_PID"
  exit 1
fi

# 5. Restart both services
systemctl --user restart claude-max-proxy.service
systemctl --user restart claude-max-quota-watcher.service 2>/dev/null || true
log "restarted"

# 6. Verify: health + the running binary reports the SOURCE version (the
#    build-time stamp proves the new binary is actually the one serving).
for i in $(seq 1 20); do curl -s -m2 http://127.0.0.1:5050/health >/dev/null 2>&1 && break; sleep 0.5; done
H=$(curl -s -m3 http://127.0.0.1:5050/health 2>/dev/null || echo '{}')
log "health: $H"
echo "$H" | grep -q '"ok":true' || { log "UNHEALTHY — rollback: cp -a $BK/bin/. $INSTALLED/bin/ && systemctl --user restart claude-max-proxy"; exit 1; }
SRC_VER=$(grep -o '"version": "[^"]*"' "$PROXY_PKG" | head -1 | cut -d'"' -f4)
LIVE_VER=$(curl -s -m3 http://127.0.0.1:5050/version 2>/dev/null | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
log "version: live=$LIVE_VER source=$SRC_VER"
[ "$LIVE_VER" = "$SRC_VER" ] || { log "VERSION MISMATCH — live binary is not the one just built. rollback: cp -a $BK/bin/. $INSTALLED/bin/ && systemctl --user restart claude-max-proxy"; exit 1; }

# 7. Smoke the thinking-block regression against the DEPLOYED artifacts (no upstream
#    traffic, no impact on the running proxy — pure transform probe). Guards against
#    the 2026-05-28 flood ever silently shipping again.
log "smoke: thinking-block survives enrich + ttl-upgrade"
bun "$PROXY_PKG_DIR/scripts/smoke-thinking-block.ts" \
  || { log "SMOKE FAILED — deployed code mutates thinking blocks. rollback: cp -a $BK/bin/. $INSTALLED/bin/ && systemctl --user restart claude-max-proxy"; exit 1; }

log "deploy OK (rollback if needed: cp -a $BK/bin/. $INSTALLED/bin/ && systemctl --user restart claude-max-proxy)"
