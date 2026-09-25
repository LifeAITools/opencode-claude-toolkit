#!/bin/bash
# Defense-in-depth dump/snapshot rotation for Claude proxy + opencode.
#
# Foundation-first: per-component pruning exists (SDK pruneOldBodyDumps,
# body-capture TTL sweep, KA snapshot recursive sweep), but this hourly
# systemd backstop GUARANTEES rotation even if a component's auto-prune is
# disabled, crashes, or runs an older build. It is the single safety net for
# every ephemeral dump dir so none can silently fill the disk.
#
# Called hourly via systemd user timer.
# SOURCE OF TRUTH: claude-code-sdk/packages/claude-max-proxy/scripts/ — installed to
# ~/.local/bin by deploy-from-source.sh. Never edit the installed copy.
# See ~/.config/systemd/user/claude-body-dumps-prune.{service,timer}.

set -u
HOME_DIR=/home/relishev
LOG="$HOME_DIR/.claude-local/claude-max-debug.log"

# Primary body-dumps dir also gets a hard size cap (high write volume).
PRIMARY_DIR="$HOME_DIR/.claude-local/proxy-body-dumps"
MAX_GB=${CLAUDE_BODY_DUMP_MAX_GB:-2}

# Backstop targets: "dir:retention_hours". Recursive age-based prune.
# Retention here is the OUTER bound — components prune sooner on their own.
DUMP_TARGETS=(
  "$HOME_DIR/.claude-local/body-dumps:${CLAUDE_BODY_DUMP_RETENTION_HOURS:-24}"
  "$HOME_DIR/.claude/body-dumps:24"
  "$HOME_DIR/.claude-local/proxy-body-dumps:24"
  "$HOME_DIR/.claude/snapshots:24"
  "$HOME_DIR/.local/share/opencode/tool-output:72"
  "$HOME_DIR/.claude-local/rewrite-guard-blocks:168"
)

total_deleted=0
total_freed_mb=0
summary=""

for entry in "${DUMP_TARGETS[@]}"; do
  dir="${entry%:*}"
  hours="${entry##*:}"
  [ -d "$dir" ] || continue

  before_b=$(du -sb "$dir" 2>/dev/null | cut -f1)
  before_n=$(find "$dir" -type f 2>/dev/null | wc -l)

  # Age-based recursive prune (covers subdirs like snapshots/bodies).
  find "$dir" -type f -mmin +$((hours * 60)) -delete 2>/dev/null

  after_b=$(du -sb "$dir" 2>/dev/null | cut -f1)
  after_n=$(find "$dir" -type f 2>/dev/null | wc -l)

  d=$((before_n - after_n))
  f=$(( (before_b - after_b) / 1024 / 1024 ))
  if [ "$d" -gt 0 ]; then
    total_deleted=$((total_deleted + d))
    total_freed_mb=$((total_freed_mb + f))
    summary="$summary ${dir##*/}=${d}f/${f}MB"
  fi
done

# Hard size cap on the primary high-volume dir: delete oldest until under cap.
if [ -d "$PRIMARY_DIR" ]; then
  cur_b=$(du -sb "$PRIMARY_DIR" 2>/dev/null | cut -f1)
  max_b=$((MAX_GB * 1024 * 1024 * 1024))
  if [ "$cur_b" -gt "$max_b" ]; then
    overage=$((cur_b - max_b))
    while IFS= read -r file && [ "$overage" -gt 0 ]; do
      sz=$(stat -c%s "$file" 2>/dev/null || echo 0)
      rm -f "$file"
      overage=$((overage - sz))
      total_deleted=$((total_deleted + 1))
    done < <(find "$PRIMARY_DIR" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-)
    summary="$summary capEnforced"
  fi
fi

# Opencode DB backups: keep 1 daily + 2 hourly (opencode creates these itself).
# Was 3 + 6 = 9 copies of a 3.1 GB database = 26 GB; on 2026-09-25 the system
# disk hit 99% and photo3d could not build an image (measured by vibe-kibctl-owner).
# Three copies still cover "last night" and "the last two hours".
OC_BACKUP_DIR="$HOME_DIR/.local/share/opencode/backups"
if [ -d "$OC_BACKUP_DIR" ]; then
  oc_del=0
  for pattern in "daily" "hourly"; do
    keep=$( [ "$pattern" = "daily" ] && echo "${OC_BACKUP_KEEP_DAILY:-1}" || echo "${OC_BACKUP_KEEP_HOURLY:-2}" )
    while IFS= read -r f; do
      rm -f "$f"; oc_del=$((oc_del + 1))
    done < <(ls -t "$OC_BACKUP_DIR"/opencode.db.${pattern}-* 2>/dev/null | tail -n +$((keep + 1)))
  done
  if [ "$oc_del" -gt 0 ]; then
    total_deleted=$((total_deleted + oc_del))
    summary="$summary oc-backups=${oc_del}f"
  fi
fi

if [ "$total_deleted" -gt 0 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] DUMP_PRUNE_TIMER source=systemd deleted=$total_deleted freedMb=$total_freed_mb maxGb=$MAX_GB dirs:$summary" >> "$LOG"
fi
