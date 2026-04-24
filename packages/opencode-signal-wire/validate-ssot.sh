#!/usr/bin/env bash
# Validation: 6 checks from SIGNAL-WIRE-CORE-MIGRATION.md (step 8).
#
# Usage: validate-ssot.sh [PID]
#   PID defaults to the most recent running opencode binary pid
#   that has activity in the signal-wire debug log.
#
# Exits 0 if all checks pass; non-zero on any failure.

set -u

LOG_FILE="$HOME/.claude/signal-wire-debug.log"
STATS_FILE="$HOME/.claude/claude-max-stats.log"
SSOT="/home/relishev/packages/signal-wire-core/rules/signal-wire-rules.json"

if [[ -n "${1:-}" ]]; then
  PID="$1"
else
  # Pick the most recent BANNER line in the log and extract its pid.
  # -a forces text mode; handles null bytes gracefully.
  PID=$(grep -aE "BANNER sw-core|ADAPTER_BANNER" "$LOG_FILE" 2>/dev/null | tail -1 | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
fi

if [[ -z "$PID" ]]; then
  echo "FAIL: no pid found in log; pass one explicitly" >&2
  exit 1
fi

echo "Validating pid=$PID against SSOT $SSOT"

PASS=0
FAIL=0

check() {
  local name="$1" rc="$2" detail="$3"
  if [[ "$rc" == "0" ]]; then
    echo "  [PASS] $name — $detail"
    ((PASS++))
  else
    echo "  [FAIL] $name — $detail"
    ((FAIL++))
  fi
}

# 1. Identity chain
ic=$(grep -aE "pid=$PID" "$LOG_FILE" | grep -cE "ENGINE_SELECT|ADAPTER_BANNER|BANNER sw-core")
[[ "$ic" -ge 3 ]]; check "identity chain" $? "$ic banner lines (≥3 required)"

# 2. ENGINE_SELECT=CORE
grep -aE "pid=$PID" "$LOG_FILE" | grep -q "ENGINE_SELECT=CORE"
check "engine=CORE" $? "ENGINE_SELECT=CORE present"

# 3. Rules count matches SSOT (with platform filter applied)
# A rule applies to a platform if `platforms` is absent/null (= all), or
# contains the platform name. For opencode adapter: expected = count of
# rules where platforms is null OR includes "opencode".
RULES_IN_LOG=$(grep -aE "pid=$PID" "$LOG_FILE" | grep -oE "rules_loaded=[0-9]+" | head -1 | cut -d= -f2)
RULES_IN_SSOT_TOTAL=$(jq '.rules | length' "$SSOT")
RULES_FOR_OPENCODE=$(jq '[.rules[] | select(.platforms == null or (.platforms | index("opencode")))] | length' "$SSOT")
[[ "$RULES_IN_LOG" == "$RULES_FOR_OPENCODE" ]]; check "rules count SSOT" $? "log=$RULES_IN_LOG expected=$RULES_FOR_OPENCODE (ssot_total=$RULES_IN_SSOT_TOTAL, opencode-applicable)"

# 4. No duplicate rules.json in opencode-claude
DUP1="/home/relishev/projects/vibe/claude-code-sdk/packages/opencode-claude/signal-wire-rules.json"
DUP2="/home/relishev/projects/vibe/claude-code-sdk/packages/opencode-claude/dist/signal-wire-rules.json"
[[ ! -f "$DUP1" && ! -f "$DUP2" ]]; check "no duplicates" $? "duplicate rules.json files absent"

# 5. Rule evaluation works — probe by invoking sw-cli directly via the
# bundled hook wrapper. This is a deterministic check: if SSOT loads and
# the engine evaluates, a UserPromptSubmit event will fire the
# session-start-checklist rule (which has no match filter).
# (Historical note: a pid-scoped grep of "rule fired:" was misleading
# because only Consumer-1 logs fires; Consumer-2/sw-cli doesn't write
# into the shared debug log.)
HOOK_SH="/home/relishev/.claude-local/plugins/marketplaces/lifeaitools/hooks/signal-wire-hook.sh"
if [[ -x "$HOOK_SH" ]]; then
  PROBE_OUT=$(echo '{"session_id":"validator-probe","prompt":"probe"}' | "$HOOK_SH" --event UserPromptSubmit 2>&1 | head -c 500)
  echo "$PROBE_OUT" | grep -q "mandatory-checklist"
  check "rule fires (via sw-cli probe)" $? "engine evaluates, session-start-checklist returned"
else
  echo "  [SKIP] rule fires — $HOOK_SH not executable"
fi

# 6. No unclean stream stops
STOPS=$(grep -aE "pid=$PID" "$STATS_FILE" | grep -oE "stop=[a-z_]+" | sort -u)
BAD=""
for s in $STOPS; do
  case "$s" in
    stop=end_turn|stop=tool_use) ;;
    *) BAD="$BAD $s" ;;
  esac
done
[[ -z "$BAD" ]]; check "clean stops" $? "stops: $STOPS${BAD:+  (bad: $BAD)}"

echo
echo "Result: $PASS pass / $FAIL fail"
exit $FAIL
