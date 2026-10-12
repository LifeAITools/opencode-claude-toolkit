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
#   cloud-run --org <ref> "<задача>"          # под аккаунтом из org-vault (напр. --org berez)
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
ORG=""
BYPASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)    DIR="${2:?--dir требует путь}"; shift 2 ;;
    --org)    ORG="${2:?--org требует аккаунт (orgId-префикс/почта/имя)}"; shift 2 ;;
    --bypass) BYPASS=1; shift ;;
    *)        break ;;
  esac
done
TASK="${1:?usage: cloud-run [--dir <repo>] [--org <acct>] [--bypass] \"<task>\"}"

[ -x "$WRAP" ] || { echo "обёртка не найдена: $WRAP" >&2; exit 2; }
mkdir -p "$(dirname "$REG")"

SESSION="cloud-$(date +%s)-$$"
tmux new-session -d -s "$SESSION" -x 220 -y 50
# Ширина решает: узкая панель переносит строку «Resume with: … session_<id>» и рвёт id пополам.
tmux resize-window -t "$SESSION" -x 220 -y 50 2>/dev/null || true
# Обёртка принимает --org (свой CLAUDE_CONFIG_DIR из org-vault) и пропускает флаги claude.
WRAP_OPTS=""
[ -n "$ORG" ] && WRAP_OPTS="--org $(printf '%q' "$ORG")"
[ -n "$BYPASS" ] && WRAP_OPTS="$WRAP_OPTS --dangerously-skip-permissions"
tmux send-keys -t "$SESSION" "cd $(printf '%q' "$DIR") && $(printf '%q' "$WRAP") $WRAP_OPTS --cloud $(printf '%q' "$TASK")" Enter

accepted_bypass=0
for _ in $(seq 1 $(( TIMEOUT / 2 ))); do
  pane="$(tmux capture-pane -pt "$SESSION" -S -200 2>/dev/null || true)"
  # Окно принятия Bypass Permissions (появляется с --dangerously-skip-permissions):
  # по умолчанию стоит «No, exit» — поднимаемся на «Yes, I accept» и подтверждаем.
  if [ "$accepted_bypass" -eq 0 ] && printf '%s' "$pane" | grep -q 'Bypass Permissions mode'; then
    tmux send-keys -t "$SESSION" Up; sleep 0.4; tmux send-keys -t "$SESSION" Enter; accepted_bypass=1
    sleep 2; continue
  fi
  # id берём из строки View (кончается на ?from=cli — надёжная граница) и требуем длину ≥16:
  # так обрезанный переносом фрагмент (< 16) не уйдёт в реестр.
  sid="$(printf '%s' "$pane" | grep -oE 'claude\.ai/code/session_[A-Za-z0-9]{16,}' | head -1 | sed 's#.*/##' || true)"
  [ -n "$sid" ] || sid="$(printf '%s' "$pane" | grep -oE 'session_[A-Za-z0-9]{16,}' | head -1 || true)"
  if [ -n "$sid" ]; then
    url="https://claude.ai/code/$sid"
    # Приложение-колонка account — ЧТОБЫ ЗНАТЬ, под кем сессия; первые 4 колонки не тронуты.
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -Is)" "$sid" "$DIR" "$TASK" "account=${ORG:-global}" >> "$REG"
    echo "OK session_id=$sid"
    echo "account=${ORG:-global (CLI-вход)}"
    [ -n "$url" ] && echo "url=$url"
    echo "tmux=$SESSION  registry=$REG"
    # Панель своя и уже пуста (CLI вернулся в приглашение после создания сессии) — закрываем,
    # чтобы пустые панели не копились. Имя своё (`cloud-*`), чужого не трогаем.
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    exit 0
  fi
  sleep 2
done

echo "TIMEOUT: session_id не появился за ${TIMEOUT}s; панель '$SESSION' оставлена для осмотра" >&2
tmux capture-pane -pt "$SESSION" -S -40 2>/dev/null | tail -20 >&2 || true
exit 1
