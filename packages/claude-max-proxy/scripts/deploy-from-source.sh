#!/bin/bash
# deploy-from-source — the ONE repeatable way to deploy claude-max-proxy.
#
# WHY THIS EXISTS (Rule #15 deploy-and-verify-live):
# The live install at $INSTALLED was historically hand-edited in place, so it
# silently drifted from source — which once dropped the stats-emitter startup and
# killed the quota pipeline for 27h unnoticed. This script makes deploy a pure,
# repeatable function of source: full recursive src sync (incl. modules/), SDK
# bundle, a hash MANIFEST (so startup can detect later hand-edits), restart, verify.
#
# NEVER hand-edit $INSTALLED/src again. Edit source, run this.
#
# Usage:
#   bash deploy-from-source.sh --dry-run   # show what would change, no writes
#   bash deploy-from-source.sh             # backup -> deploy -> manifest -> restart -> verify
set -euo pipefail

SRC_REPO=/home/relishev/projects/vibe/claude-code-sdk
PROXY_SRC=$SRC_REPO/packages/claude-max-proxy/src
PROXY_PKG=$SRC_REPO/packages/claude-max-proxy/package.json
SDK_DIST=$SRC_REPO/dist
SDK_PKG=$SRC_REPO/package.json
INSTALLED=/home/relishev/.local/share/claude-max-proxy
SDK_DST=$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk
MANIFEST=$INSTALLED/.deploy-manifest.json
BACKUP_ROOT=/home/relishev/.claude-local/proxy-backups

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
cp -a "$SDK_DST/dist" "$BK/sdk-dist"
log "backup -> $BK"

# 2. Sync src (recursive, incl. modules/). Additive — NOT --delete: the live
#    tree holds non-source state that must survive (.claude/ hook state, *.bak
#    manual backups). Stale source-removed files are surfaced by the dry-run diff
#    above for manual review instead of being auto-nuked.
rsync -a --exclude='.claude' --exclude='*.bak*' --exclude='*.broken' "$PROXY_SRC/" "$INSTALLED/src/"
cp "$PROXY_PKG" "$INSTALLED/package.json"
log "src synced"

# 3. Rebuild + sync SDK bundle + version.
#    ALWAYS rebuild from source first: copying a stale $SDK_DIST is how a
#    committed-but-unbuilt fix gets "deployed" yet never reaches live (the
#    2026-05-28 thinking-block flood — fix in source, stale bundle on disk).
log "building SDK bundle from source"
( cd "$SRC_REPO" && bun run build >/dev/null 2>&1 ) || { log "SDK BUILD FAILED — aborting deploy"; exit 1; }
rm -rf "$SDK_DST/dist"; cp -a "$SDK_DIST" "$SDK_DST/dist"
cp "$SDK_PKG" "$SDK_DST/package.json"
log "SDK synced ($(grep -o '"version": "[^"]*"' "$SDK_DST/package.json" | head -1))"

# 4. Write deploy manifest (sha256 of every live src file + the SDK bundle).
#    Startup compares against this to detect post-deploy hand-edits.
COMMIT=$(git -C "$SRC_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
{
  echo "{"
  echo "  \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"sourceCommit\": \"$COMMIT\","
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

# 5. Restart both services (proxy + quota-watcher run from $INSTALLED/src)
systemctl --user restart claude-max-proxy.service
systemctl --user restart claude-max-quota-watcher.service 2>/dev/null || true
log "restarted"

# 6. Verify
for i in $(seq 1 20); do curl -s -m2 http://127.0.0.1:5050/health >/dev/null 2>&1 && break; sleep 0.5; done
H=$(curl -s -m3 http://127.0.0.1:5050/health 2>/dev/null || echo '{}')
log "health: $H"
echo "$H" | grep -q '"ok":true' || { log "UNHEALTHY — rollback: cp -a $BK/src $INSTALLED/src && restart"; exit 1; }

# 7. Smoke the thinking-block regression against the DEPLOYED artifacts (no upstream
#    traffic, no impact on the running proxy — pure transform probe). Guards against
#    the 2026-05-28 flood ever silently shipping again.
log "smoke: thinking-block survives enrich + ttl-upgrade"
bun "$SRC_REPO/packages/claude-max-proxy/scripts/smoke-thinking-block.ts" \
  || { log "SMOKE FAILED — deployed code mutates thinking blocks. rollback: cp -a $BK/src/. $INSTALLED/src/ && cp -a $BK/sdk-dist/. $SDK_DST/dist/ && systemctl --user restart claude-max-proxy"; exit 1; }

log "deploy OK (rollback if needed: cp -a $BK/src/. $INSTALLED/src/ && systemctl --user restart claude-max-proxy)"
