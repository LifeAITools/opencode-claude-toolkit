#!/usr/bin/env bash
# cloud-run — пускатель облачных сессий Claude через tmux + реестр session_id.
#
# ЗАЧЕМ: `claude --cloud` требует ЖИВОГО терминала, и session_id печатает не сразу
# (1–2 мин молчания = создание). Эта ручка открывает панель tmux, запускает обёртку
# claude-cloud, ждёт session_id, печатает его и дописывает в реестр — прогон не теряется.
#
# ИСПОЛЬЗОВАНИЕ:
#   cloud-run "<задача>"                      # из текущего каталога (репозитория)
#   cloud-run --dir <путь-к-репо> "<задача>"
#
# НАСТРОЙКИ (env):
#   CLAUDE_CLOUD_WRAPPER   путь к обёртке (по умолчанию scripts/claude-cloud.sh рядом с проектом)
#   CLAUDE_CLOUD_REGISTRY  файл реестра (по умолчанию ~/.claude/cloud-sessions.log)
#   CLAUDE_CLOUD_TIMEOUT   сколько секунд ждать session_id (по умолчанию 240)
#
# ВАЖНО: запуск (--cloud) ветку не меняет; читать/продолжать надо `--teleport` — и ТОЛЬКО
# из отдельного worktree (он переключает ветку), см. оговорку в RECON.md.
set -euo pipefail

WRAP="${CLAUDE_CLOUD_WRAPPER:-/home/relishev/projects/vibe/claude-code-sdk/scripts/claude-cloud.sh}"
REG="${CLAUDE_CLOUD_REGISTRY:-$HOME/.claude/cloud-sessions.log}"
TIMEOUT="${CLAUDE_CLOUD_TIMEOUT:-240}"

DIR="$PWD"
if [ "${1:-}" = "--dir" ]; then DIR="${2:?--dir требует путь}"; shift 2; fi
TASK="${1:?usage: cloud-run [--dir <repo>] \"<task>\"}"

[ -x "$WRAP" ] || { echo "обёртка не найдена: $WRAP" >&2; exit 2; }
mkdir -p "$(dirname "$REG")"

SESSION="cloud-$(date +%s)-$$"
tmux new-session -d -s "$SESSION" -x 220 -y 50
# Ширина решает: узкая панель переносит строку «Resume with: … session_<id>» и рвёт id пополам.
tmux resize-window -t "$SESSION" -x 220 -y 50 2>/dev/null || true
tmux send-keys -t "$SESSION" "cd $(printf '%q' "$DIR") && $(printf '%q' "$WRAP") --cloud $(printf '%q' "$TASK")" Enter

for _ in $(seq 1 $(( TIMEOUT / 2 ))); do
  pane="$(tmux capture-pane -pt "$SESSION" -S -200 2>/dev/null || true)"
  # id берём из строки View (кончается на ?from=cli — надёжная граница) и требуем длину ≥16:
  # так обрезанный переносом фрагмент (< 16) не уйдёт в реестр.
  sid="$(printf '%s' "$pane" | grep -oE 'claude\.ai/code/session_[A-Za-z0-9]{16,}' | head -1 | sed 's#.*/##' || true)"
  [ -n "$sid" ] || sid="$(printf '%s' "$pane" | grep -oE 'session_[A-Za-z0-9]{16,}' | head -1 || true)"
  if [ -n "$sid" ]; then
    url="https://claude.ai/code/$sid"
    printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "$sid" "$DIR" "$TASK" >> "$REG"
    echo "OK session_id=$sid"
    [ -n "$url" ] && echo "url=$url"
    echo "tmux=$SESSION  registry=$REG"
    exit 0
  fi
  sleep 2
done

echo "TIMEOUT: session_id не появился за ${TIMEOUT}s; панель '$SESSION' оставлена для осмотра" >&2
tmux capture-pane -pt "$SESSION" -S -40 2>/dev/null | tail -20 >&2 || true
exit 1
