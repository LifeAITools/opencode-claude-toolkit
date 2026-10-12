#!/usr/bin/env bash
# cloud-read — прочитать ТРАНСКРИПТ и СТАТУС облачной сессии, и продолжить её.
#
# ЗАЧЕМ: облачная сессия — не чёрный ящик. `claude --teleport <id>` втягивает её к
# нам и отдаёт всю переписку: видно и отправленные вопросы, и ответы агента, и его
# состояние. Attach (`claude --cloud <id>`) у части аккаунтов закрыт («Attaching to
# an existing cloud session is not enabled for your account») — teleport работает.
#
# ВАЖНО: teleport ПЕРЕКЛЮЧАЕТ ВЕТКУ в дереве, откуда запущен. Поэтому втягиваем в
# ОТДЕЛЬНОМ worktree (из --dir) либо во временном каталоге (если репозитория нет).
# Панель остаётся открытой — через неё сессию можно продолжить.
#
# ИСПОЛЬЗОВАНИЕ:
#   cloud-read <session_id> [--org <acct>] [--dir <repo>] [--wait <sec>] [--close]
#
# НАСТРОЙКИ (env):
#   CLAUDE_CLOUD_WRAPPER   путь к обёртке (по умолчанию scripts/claude-cloud.sh)
set -euo pipefail

WRAP="${CLAUDE_CLOUD_WRAPPER:-/home/relishev/projects/vibe/claude-code-sdk/scripts/claude-cloud.sh}"
WAIT=45
CLOSE=0
ORG=""
REPO=""
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --org)   ORG="${2:?--org требует аккаунт}"; shift 2 ;;
    --dir)   REPO="${2:?--dir требует путь}"; shift 2 ;;
    --wait)  WAIT="${2:?--wait требует секунды}"; shift 2 ;;
    --close) CLOSE=1; shift ;;
    session_*) SID="$1"; shift ;;
    *) echo "непонятный аргумент: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SID" ] || { echo "usage: cloud-read session_<id> [--org <acct>] [--dir <repo>] [--wait <sec>] [--close]" >&2; exit 2; }
[ -x "$WRAP" ] || { echo "обёртка не найдена: $WRAP" >&2; exit 2; }

# Отдельное дерево для teleport: в живом оно переключило бы ветку чужой работе.
if [ -n "$REPO" ] && git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  DEST="$(mktemp -d /tmp/cloud-read-XXXXXX)"
  # Ветка ИМЕНОВАННАЯ, не detached: teleport чекаутит ветку сессии — детальный HEAD мешает.
  git -C "$REPO" worktree add -f -b "cloud-read-$(date +%s)-$$" "$DEST" HEAD >/dev/null 2>&1 \
    || { echo "worktree не создался" >&2; exit 3; }
else
  DEST="$(mktemp -d /tmp/cloud-read-XXXXXX)"
fi

PANE="cloud-read-$(date +%s)-$$"
tmux new-session -d -s "$PANE" -x 220 -y 50
tmux resize-window -t "$PANE" -x 220 -y 50 2>/dev/null || true
WRAP_OPTS=""
[ -n "$ORG" ] && WRAP_OPTS="--org $(printf '%q' "$ORG")"
tmux send-keys -t "$PANE" "cd $(printf '%q' "$DEST") && $(printf '%q' "$WRAP") $WRAP_OPTS --teleport $(printf '%q' "$SID")" Enter

# Ждём, пока втянется («Teleporting session…» → «Session resumed») или истечёт время.
for _ in $(seq 1 "$WAIT"); do
  pane="$(tmux capture-pane -pt "$PANE" -S -400 2>/dev/null || true)"
  printf '%s' "$pane" | grep -qE 'Session resumed|not enabled for your account|Error:' && break
  sleep 1
done

echo "=== cloud-read $SID (tmux=$PANE, dir=$DEST) ==="
printf '%s\n' "$pane" | sed '/^$/d'
echo "=== /cloud-read ==="
[ "$CLOSE" -eq 1 ] && tmux kill-session -t "$PANE" 2>/dev/null || true
exit 0
