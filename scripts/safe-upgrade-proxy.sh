#!/bin/bash
# safe-upgrade-proxy — proxy SDK 0.11 → 0.15 upgrade with circuit breaker.
#
# Why surgical: the installed proxy at /home/relishev/.local/share/claude-max-proxy
# uses SDK 0.11 which has CACHE_TTL_MS hardcoded to 5min (300_000ms). Source
# proxy 0.8.1 uses SDK 0.14+ which has live-reload from keepalive.json.
# This script bumps the SDK in installed node_modules, but with safety guards:
#
#   1. Pre-upgrade baseline: measure current cache_write/sec rate over last 5min.
#      Used as comparison threshold for circuit breaker.
#   2. Full backup of installed proxy + its node_modules SDK.
#   3. Apply: copy new dist files, restart proxy.
#   4. Monitor first 5 minutes post-restart:
#      - If cache_write/sec exceeds 3× baseline → AUTO-ROLLBACK.
#      - If util5h delta > 5% in 5 min → AUTO-ROLLBACK.
#      - If KA_DISARM rate > 3× baseline → AUTO-ROLLBACK.
#   5. If all clean → keep upgrade; else restore backup + restart.
#
# Usage:
#   bash safe-upgrade-proxy.sh --dry-run    # show what would happen, NO writes
#   bash safe-upgrade-proxy.sh --baseline   # measure baseline only, print
#   bash safe-upgrade-proxy.sh              # full execute (with circuit breaker)
#
# Manual rollback if you've already committed:
#   bash safe-upgrade-proxy.sh --rollback   # restore last backup, restart

set -euo pipefail

SOURCE=/home/relishev/projects/vibe/claude-code-sdk
SOURCE_PROXY=$SOURCE/packages/claude-max-proxy
INSTALLED=/home/relishev/.local/share/claude-max-proxy
PROXY_LOG=/home/relishev/.claude-local/claude-max-proxy.log
BACKUP_ROOT=/home/relishev/.claude-local/proxy-backups

DRY_RUN=0
BASELINE_ONLY=0
ROLLBACK=0
MONITOR_SEC=2400  # 40 min post-upgrade watch — must exceed native CC 5min TTL × 8 to catch idle-fire pattern
BURN_THRESHOLD=3  # 3× baseline cache_write triggers rollback
UTIL5H_THRESHOLD=0.05  # 5% delta triggers rollback
DISARM_THRESHOLD=3   # 3× baseline KA_DISARM triggers rollback
SINGLE_FIRE_WRITE_LIMIT=100000  # any single KA fire writing > 100K tokens → ROLLBACK (catches the 528K bad-fire pattern)

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --baseline) BASELINE_ONLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    *) echo "unknown arg: $arg" ; exit 2 ;;
  esac
done

# ─── helpers ───────────────────────────────────────────────────────

log() { echo "[$(date +%H:%M:%S)] $*" ; }

strip_ansi() { sed -u 's/\x1b\[[0-9;]*m//g' ; }

measure_baseline() {
  # Calculate cache_write/sec rate over last 5 min from proxy log
  local now_utc cutoff_utc
  now_utc=$(date -u +%s)
  cutoff_utc=$((now_utc - 300))   # 5 min ago

  local total_writes=0 total_reads=0 disarms=0 errors=0 turns=0

  # Read proxy log; filter to last 5 min by parsing HH:MM:SS timestamps
  # (proxy log uses UTC HH:MM:SS without date)
  local hh_mm_now hh_mm_cutoff
  hh_mm_now=$(date -u +%H:%M)
  hh_mm_cutoff=$(date -u -d "@$cutoff_utc" +%H:%M)

  # Simple: use last 1000 lines as approximation of "recent"
  while IFS= read -r line; do
    if [[ "$line" == *"REAL_REQUEST_COMPLETE"* ]]; then
      local w r
      w=$(echo "$line" | grep -oE 'cacheCreationInputTokens":[0-9]+' | grep -oE '[0-9]+' || echo 0)
      r=$(echo "$line" | grep -oE 'cacheReadInputTokens":[0-9]+' | grep -oE '[0-9]+' || echo 0)
      total_writes=$((total_writes + ${w:-0}))
      total_reads=$((total_reads + ${r:-0}))
      turns=$((turns + 1))
    fi
    if [[ "$line" == *"KA_DISARM"* ]]; then disarms=$((disarms + 1)); fi
    if [[ "$line" == *"REAL_REQUEST_ERROR"* ]]; then errors=$((errors + 1)); fi
  done < <(tail -2000 "$PROXY_LOG" | strip_ansi)

  echo "$total_writes $total_reads $turns $disarms $errors"
}

snapshot_state() {
  local label="$1"
  log "── $label ──"
  curl -s http://127.0.0.1:5050/health 2>/dev/null || echo "(proxy not reachable)"
  curl -s http://127.0.0.1:5050/version 2>/dev/null || echo
  echo
  log "util state: $(curl -s http://127.0.0.1:5050/stats 2>/dev/null | jq -c '.rateLimit | {util5h: .utilization5h, util7d: .utilization7d, status}')"
}

# ─── rollback path ─────────────────────────────────────────────────

if [[ $ROLLBACK -eq 1 ]]; then
  log "ROLLBACK requested"
  # IMPORTANT: -d ensures directory listings only and -t sorts by mtime.
  # Original bug: ls -t without -d listed directory contents on glob match → returned 'src' alone.
  latest_backup=$(ls -td "$BACKUP_ROOT"/proxy-* 2>/dev/null | head -1)
  if [[ -z "$latest_backup" || ! -d "$latest_backup" ]]; then
    log "ERROR: no backup found in $BACKUP_ROOT"
    exit 1
  fi
  log "restoring from: $latest_backup"
  rm -rf "$INSTALLED/src.broken" 2>/dev/null || true
  mv "$INSTALLED/src" "$INSTALLED/src.broken"
  cp -a "$latest_backup/src" "$INSTALLED/src"
  cp -a "$latest_backup/package.json" "$INSTALLED/package.json"
  if [[ -d "$latest_backup/node_modules-sdk" ]]; then
    rm -rf "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk.broken" 2>/dev/null || true
    mv "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk.broken"
    cp -a "$latest_backup/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk"
  fi
  systemctl --user restart claude-max-proxy
  sleep 3
  log "rollback complete. health:"
  curl -s http://127.0.0.1:5050/health
  exit 0
fi

# ─── baseline measurement ──────────────────────────────────────────

log "measuring 5-min baseline..."
read -r b_writes b_reads b_turns b_disarms b_errors < <(measure_baseline)
log "baseline: turns=$b_turns writes=$b_writes reads=$b_reads disarms=$b_disarms errors=$b_errors"
if (( b_turns > 0 )); then
  log "  avg_write_per_turn=$((b_writes / b_turns)) avg_read_per_turn=$((b_reads / b_turns))"
fi

if [[ $BASELINE_ONLY -eq 1 ]]; then
  log "BASELINE ONLY mode — exiting"
  exit 0
fi

# ─── dry-run ────────────────────────────────────────────────────────

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — would perform:"
  log "  1. backup $INSTALLED → $BACKUP_ROOT/proxy-\$(date)"
  log "  2. backup node_modules SDK 0.11 → backup dir"
  log "  3. copy source dist → $INSTALLED/src + $INSTALLED/package.json"
  log "  4. update SDK in node_modules to source dist 0.15"
  log "  5. systemctl --user restart claude-max-proxy"
  log "  6. monitor $MONITOR_SEC seconds for cache_write/disarm/util spikes"
  log "  7. auto-rollback if thresholds exceeded:"
  log "     - cache_write/sec > $BURN_THRESHOLD× baseline"
  log "     - util5h delta > $UTIL5H_THRESHOLD"
  log "     - KA_DISARM rate > $DISARM_THRESHOLD× baseline"
  exit 0
fi

# ─── EXECUTE upgrade ────────────────────────────────────────────────

snapshot_state "PRE-UPGRADE state"
PRE_UTIL5H=$(curl -s http://127.0.0.1:5050/stats 2>/dev/null | jq -r '.rateLimit.utilization5h // 0')
log "PRE_UTIL5H=$PRE_UTIL5H"

# Step 1: backup
mkdir -p "$BACKUP_ROOT"
BACKUP_DIR="$BACKUP_ROOT/proxy-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
log "backing up to $BACKUP_DIR"
cp -a "$INSTALLED/src" "$BACKUP_DIR/src"
cp -a "$INSTALLED/package.json" "$BACKUP_DIR/package.json"
if [[ -d "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk" ]]; then
  cp -a "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk" "$BACKUP_DIR/node_modules-sdk"
fi
log "backup complete ($(du -sh "$BACKUP_DIR" | cut -f1))"

# Step 2: apply
log "copying source files..."
for f in "$SOURCE_PROXY/src/"*.ts; do
  name=$(basename "$f")
  cp "$f" "$INSTALLED/src/$name"
done
cp "$SOURCE_PROXY/package.json" "$INSTALLED/package.json"

log "updating SDK 0.11 → 0.15 in node_modules..."
# Replace the bundled SDK dist
if [[ -d "$SOURCE/dist" ]]; then
  rm -rf "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk/dist"
  cp -a "$SOURCE/dist" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk/dist"
  cp "$SOURCE/package.json" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk/package.json"
  log "SDK updated to $(jq -r .version "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk/package.json")"
else
  log "ERROR: source dist/ not found at $SOURCE/dist"
  log "rolling back..."
  cp -a "$BACKUP_DIR/src" "$INSTALLED/src"
  exit 1
fi

# Step 3: restart
log "restarting claude-max-proxy..."
systemctl --user restart claude-max-proxy
sleep 3

if ! curl -s http://127.0.0.1:5050/health > /dev/null 2>&1; then
  log "ERROR: proxy unhealthy after restart — AUTO-ROLLBACK"
  cp -a "$BACKUP_DIR/src" "$INSTALLED/src"
  cp -a "$BACKUP_DIR/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk"
  systemctl --user restart claude-max-proxy
  sleep 3
  exit 1
fi

snapshot_state "POST-UPGRADE state"

# Step 4: monitor for $MONITOR_SEC seconds with circuit breaker
log "monitoring next $MONITOR_SEC seconds for cache/disarm anomalies..."
START_TS=$(date +%s)
END_TS=$((START_TS + MONITOR_SEC))

while (( $(date +%s) < END_TS )); do
  sleep 30
  read -r p_writes p_reads p_turns p_disarms p_errors < <(measure_baseline)
  # Baseline was 5-min summed; recent 30s = scale to compare per-sec rate
  baseline_write_per_min=$((b_writes / 5))
  recent_write_per_min=$((p_writes / 5))   # tail-2000 grabs ~5min still

  cur_util5h=$(curl -s http://127.0.0.1:5050/stats 2>/dev/null | jq -r '.rateLimit.utilization5h // 0')
  util_delta=$(awk "BEGIN{print $cur_util5h - $PRE_UTIL5H}")

  log "tick: writes_5min=$p_writes (baseline $b_writes) disarms=$p_disarms (baseline $b_disarms) util5h=$cur_util5h Δ=$util_delta"

  # Critical: catch single-fire heavy cache_write (the 528K bad-fire pattern).
  # Even if rate isn't 3× baseline, ANY single KA fire writing > SINGLE_FIRE_WRITE_LIMIT
  # tokens indicates cache was actually dead when fired (full rewrite) — rollback NOW.
  bad_fire=$(sed -u 's/\x1b\[[0-9;]*m//g' "$PROXY_LOG" 2>/dev/null | \
    tail -200 | \
    grep KA_FIRE_COMPLETE | \
    grep -oE 'cacheCreationInputTokens":[0-9]+' | \
    awk -F: 'NR==1{max=$2} $2>max{max=$2} END{print max+0}')
  if (( bad_fire > SINGLE_FIRE_WRITE_LIMIT )); then
    log "🔥 CIRCUIT BREAKER: single KA fire wrote ${bad_fire} tokens (>$SINGLE_FIRE_WRITE_LIMIT) — cache was dead, KA misfire → ROLLBACK"
    cp -a "$BACKUP_DIR/src" "$INSTALLED/src" 2>/dev/null || true
    cp -a "$BACKUP_DIR/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk" 2>/dev/null || true
    cp "$BACKUP_DIR/package.json" "$INSTALLED/package.json"
    systemctl --user restart claude-max-proxy
    log "rollback complete"
    exit 2
  fi

  # Circuit breakers
  if (( p_writes > b_writes * BURN_THRESHOLD )) && (( b_writes > 1000 )); then
    log "🔥 CIRCUIT BREAKER: cache_write spike $p_writes vs baseline $b_writes (>${BURN_THRESHOLD}×) — ROLLBACK"
    cp -a "$BACKUP_DIR/src" "$INSTALLED/src"
    cp -a "$BACKUP_DIR/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk"
    cp "$BACKUP_DIR/package.json" "$INSTALLED/package.json"
    systemctl --user restart claude-max-proxy
    log "rollback complete"
    exit 2
  fi

  if (( p_disarms > b_disarms * DISARM_THRESHOLD )) && (( p_disarms > 3 )); then
    log "🔥 CIRCUIT BREAKER: KA_DISARM spike $p_disarms vs baseline $b_disarms (>${DISARM_THRESHOLD}×) — ROLLBACK"
    cp -a "$BACKUP_DIR/src" "$INSTALLED/src"
    cp -a "$BACKUP_DIR/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk"
    cp "$BACKUP_DIR/package.json" "$INSTALLED/package.json"
    systemctl --user restart claude-max-proxy
    log "rollback complete"
    exit 2
  fi

  # awk comparison for float
  if awk "BEGIN{exit ($util_delta > $UTIL5H_THRESHOLD ? 0 : 1)}"; then
    log "🔥 CIRCUIT BREAKER: util5h delta $util_delta exceeds $UTIL5H_THRESHOLD — ROLLBACK"
    cp -a "$BACKUP_DIR/src" "$INSTALLED/src"
    cp -a "$BACKUP_DIR/node_modules-sdk" "$INSTALLED/node_modules/@life-ai-tools/claude-code-sdk"
    cp "$BACKUP_DIR/package.json" "$INSTALLED/package.json"
    systemctl --user restart claude-max-proxy
    log "rollback complete"
    exit 2
  fi
done

log "✅ monitoring complete — no anomalies detected"
log "upgrade SUCCESS"
log "backup retained at $BACKUP_DIR (delete when confident)"
log "to rollback later: bash $0 --rollback"
