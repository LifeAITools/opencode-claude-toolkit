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
#   cloud-run --model <m> "<задача>"          # переопределить модель (по умолчанию opus = Opus 5.5)
#
# 🔴 Задача уходит как `--cloud=<текст>` (склейка через `=`), поэтому текст, начинающийся
# с `-` (напр. YAML-заголовок `---`), НЕ читается парсером как опция (иначе: unknown option '---').
#
# НАСТРОЙКИ (env):
#   CLAUDE_CLOUD_WRAPPER   путь к обёртке (по умолчанию scripts/claude-cloud.sh рядом с проектом)
#   CLAUDE_CLOUD_REGISTRY  файл реестра (по умолчанию ~/.claude/cloud-sessions.log)
#   CLAUDE_CLOUD_TIMEOUT   сколько секунд ждать session_id (по умолчанию 240)
#   CLAUDE_CLOUD_MODEL     модель облака (по умолчанию `opus` = Opus 5.5)
#
# ВАЖНО: запуск (--cloud) ветку не меняет; читать/продолжать надо `--teleport` — и ТОЛЬКО
# из отдельного worktree (он переключает ветку), см. оговорку в RECON.md.
#
# ─── ЧТО ЗНАТЬ ДО ЗАПУСКА (18.10.2026; подробности — локальный RECON.md и журнал смены) ───
# 🔴 АККАУНТ. Облако берёт ВХОД CLI, а не токен прокси, поэтому идёт под `--org <алиас>`
#   из org-vault. Живой аккаунт для создания может быть ОДИН — проверяй ФАКТОМ (создай
#   пробную сессию), а не по прошлой записи: 12.10 не работал один, 18.10 — другой.
# 🔴 ОСТАТОК БОНУСА НЕ ЧИТАЕТСЯ НИОТКУДА (проверено три пути: нет команды у CLI, панель
#   /usage-credits числа не даёт, в реестре его нет). Не выдумывай число. Признак, что
#   бонус кончился, — НЕ ошибка кредита, а ВОЗВРАТ К ЛИМИТУ: `You've hit your weekly limit`.
#   Пока создание проходит при выбранном недельном лимите — горит бонус, а не лимит.
# 🔴 ВОЗВРАТ КОДА. Ветку вернёт только GitHub-КЛОН репо, на котором стоит Claude GitHub App
#   (на `LifeAITools` он есть с 18.10). Не-GitHub (локальный Gitea) — ТОЛЬКО текстом:
#   проси `git diff` целиком. Проверять фактом: появилась ли ветка на remote.
# 🔴 НАРЕЗКА (слово фаундера 18.10): ОДИН агент на ОБЛАСТЬ, не много узких сессий — иначе
#   домен изучается заново в каждой. Пример: «весь promptera», а не по одной задаче.
# 🔴 ЗАДАЧА ПИШЕТСЯ САМОДОСТАТОЧНО: облачный агент видит только репозиторий — ни журнала,
#   ни знаний проекта у него нет. Всё, что ему нужно знать, вкладывай в текст задачи.
# 🔴 ОБМЕН БЕЗ ОБРЫВА (слово фаундера 18.10 голосом; ручка `scripts/cloud-exchange.sh`):
#   чтобы вести агента, НЕ прерывая его, вложи в задачу соглашение о путях —
#   «складывай состояние и вопросы в `.cloud-exchange/outbox/` и отправляй ветку `cloud/<id>`;
#   ответы ищи в `.cloud-exchange/inbox/` в ветке `cloud-inbox-<id>`». Тогда мы читаем `git fetch`
#   (с диска, агента не касается), отвечаем `cloud-exchange say`, а зовём его `-p` — запись в
#   очередь, ход НЕ обрывает. Обмен идёт ЧЕРЕЗ GIT, поэтому он уместен только в ПРИВАТНОМ репо:
#   в публичном всё, что через него пройдёт, станет видно всем.
set -euo pipefail

WRAP="${CLAUDE_CLOUD_WRAPPER:-/home/relishev/projects/vibe/claude-code-sdk/scripts/claude-cloud.sh}"
REG="${CLAUDE_CLOUD_REGISTRY:-$HOME/.claude/cloud-sessions.log}"
TIMEOUT="${CLAUDE_CLOUD_TIMEOUT:-240}"
# Модель облака — Opus 5.5 (слово фаундера 12.10: «последняя модель, которая у них есть»).
# Алиас `opus` указывает на latest opus = 5.5; переопределяется CLAUDE_CLOUD_MODEL.
MODEL="${CLAUDE_CLOUD_MODEL:-opus}"

DIR="$PWD"
ORG=""
BYPASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)    DIR="${2:?--dir требует путь}"; shift 2 ;;
    --org)    ORG="${2:?--org требует аккаунт (orgId-префикс/почта/имя)}"; shift 2 ;;
    --model)  MODEL="${2:?--model требует модель}"; shift 2 ;;
    --bypass) BYPASS=1; shift ;;
    -h|--help) echo 'usage: cloud-run [--dir <repo>] [--org <acct>] [--model <m>] [--bypass] "<task>"'; exit 0 ;;
    *)        break ;;
  esac
done
TASK="${1:?usage: cloud-run [--dir <repo>] [--org <acct>] [--model <m>] [--bypass] \"<task>\"}"

[ -x "$WRAP" ] || { echo "обёртка не найдена: $WRAP" >&2; exit 2; }
mkdir -p "$(dirname "$REG")"

SESSION="cloud-$(date +%s)-$$"
tmux new-session -d -s "$SESSION" -x 220 -y 50
# Ширина решает: узкая панель переносит строку «Resume with: … session_<id>» и рвёт id пополам.
tmux resize-window -t "$SESSION" -x 220 -y 50 2>/dev/null || true
# Обёртка принимает --org (свой CLAUDE_CONFIG_DIR из org-vault) и пропускает флаги claude.
WRAP_OPTS=""
[ -n "$ORG" ] && WRAP_OPTS="--org $(printf '%q' "$ORG")"
[ -n "$MODEL" ] && WRAP_OPTS="$WRAP_OPTS --model $(printf '%q' "$MODEL")"
[ -n "$BYPASS" ] && WRAP_OPTS="$WRAP_OPTS --dangerously-skip-permissions"
# 🔴 PATH ПЕРЕДАЁТСЯ В ПАНЕЛЬ ЯВНО (замер vibe-kiberos-app-owner 18.10): панель наследует
# окружение СЕРВЕРА tmux, а не наше, поэтому 1 прогон из 11 упал `exec: claude: not found`.
# Явный PATH + абсолютный путь в обёртке закрывают это с двух сторон.
tmux send-keys -t "$SESSION" "export PATH=$(printf '%q' "$PATH"); cd $(printf '%q' "$DIR") && $(printf '%q' "$WRAP") $WRAP_OPTS --cloud=$(printf '%q' "$TASK")" Enter

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
# 🔴 ПРИЧИНУ НАЗЫВАЕМ, А НЕ ОСТАВЛЯЕМ ЧИТАТЕЛЮ (18.10): самый частый молчаливый отказ —
# бинарник/команда не найдены (панель унаследовала чужое окружение). Тогда в панели лежит
# `… not found`, и это надо сказать вслух, иначе прогон выглядит как «просто не пошёл».
pane_tail="$(tmux capture-pane -pt "$SESSION" -S -60 2>/dev/null | grep -vE '^[[:space:]]*$' | tail -20 || true)"
if printf '%s' "$pane_tail" | grep -qiE 'not found|command not found|No such file|Permission denied'; then
  echo "ПРИЧИНА: в панели виден отказ запуска (бинарник или команда не найдены) — проверьте PATH/CLAUDE_BIN." >&2
fi
printf '%s\n' "$pane_tail" >&2
exit 1
