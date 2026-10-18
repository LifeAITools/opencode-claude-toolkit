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
# 🔴 ЭТО PULL-КОПИЯ, А НЕ ПАССИВНОЕ ЧТЕНИЕ. teleport снимает копию (fetch ветки С REMOTE +
# история; «The terminal gets its own copy of the session»). 🔴 ЗАМЕРЕНО 18.10
# (vibe-mermaid-ink-owner, живая сессия dia): teleport ЖИВОЙ сессии её ПРЕРЫВАЕТ — в переписке
# агента дважды встало «Interrupted · What should Claude do instead?» ровно на середине хода
# (один раз на прогоне тестов, второй на правке файла); сессия поднялась сама («Session
# resumed») и работу довела, но КАЖДЫЙ просмотр стоил ей оборванного хода. Поэтому:
#   • по ЖИВОЙ сессии teleport НЕ гонять;
#   • состояние живой смотреть `--status` (ниже) — он не трогает сессию;
#   • teleport — по ЗАВЕРШЁННОЙ (или когда обрыв хода приемлем).
# 🔴 У НЕ-пушащего репо (не-GitHub, только локальный remote) канала НЕТ ВООБЩЕ — teleport'у
# нечего fetch'ить; тогда остаётся только ждать конца сессии (или спасать код текстом).
#
# ИСПОЛЬЗОВАНИЕ:
#   cloud-read <session_id> --status         # дёшево и НЕ трогает сессию: что известно извне
#   cloud-read <session_id> [--org <acct>] [--dir <repo>] [--wait <sec>] [--close]   # teleport
#
# НАСТРОЙКИ (env):
#   CLAUDE_CLOUD_WRAPPER   путь к обёртке (по умолчанию scripts/claude-cloud.sh)
set -euo pipefail

WRAP="${CLAUDE_CLOUD_WRAPPER:-/home/relishev/projects/vibe/claude-code-sdk/scripts/claude-cloud.sh}"
WAIT=45
CLOSE=0
STATUS=0
ORG=""
REPO=""
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --org)   ORG="${2:?--org требует аккаунт}"; shift 2 ;;
    --dir)   REPO="${2:?--dir требует путь}"; shift 2 ;;
    --wait)  WAIT="${2:?--wait требует секунды}"; shift 2 ;;
    --close) CLOSE=1; shift ;;
    --status) STATUS=1; shift ;;
    session_*) SID="$1"; shift ;;
    *) echo "непонятный аргумент: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SID" ] || { echo "usage: cloud-read session_<id> [--org <acct>] [--dir <repo>] [--wait <sec>] [--close|--status]" >&2; exit 2; }
[ -x "$WRAP" ] || { echo "обёртка не найдена: $WRAP" >&2; exit 2; }

# ─── --status: НЕ ТРОГАЕТ СЕССИЮ ────────────────────────────────────────────────
# 🔴 ЗАЧЕМ ОТДЕЛЬНО (запрос фаундера 18.10 голосом: «уточнять состояние … но при этом не
# прерывать связь с агентом»; замер vibe-mermaid-ink-owner: teleport живую ПРЕРЫВАЕТ).
# Что можно сказать, не касаясь сессии: запись в реестре и ветки на remote. Чего НЕЛЬЗЯ —
# «жива ли она сейчас»: публичного read-API у облака нет, а attach закрыт у части аккаунтов.
# Поэтому статус честно называет и то, что знает, и то, чего не знает.
if [ "$STATUS" -eq 1 ]; then
  REG="${CLAUDE_CLOUD_REGISTRY:-$HOME/.claude/cloud-sessions.log}"
  echo "=== cloud-read --status $SID (сессия НЕ тронута) ==="
  line="$(grep -m1 -F "$SID" "$REG" 2>/dev/null || true)"
  # 🔴 account берём не из первой строки: запись в реестре МНОГОСТРОЧНАЯ (в задаче есть
  # переводы строк), поэтому `account=` уезжает далеко вниз. Ищем awk-ом от строки с id.
  acc="$(awk -v s="$SID" 'index($0,s){f=1} f && match($0,/account=[A-Za-z0-9_-]+/){print substr($0,RSTART,RLENGTH); exit}' "$REG" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    echo "реестр: ${line%%$'\t'*}  ${acc:-account=не указан}"
    printf '  задача: %s\n' "$(printf '%s' "$line" | cut -f4 | cut -c1-200)"
  else
    echo "реестр: записи нет (не эта машина или сессия создана иначе)"
  fi
  if [ -n "$REPO" ] && git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    # 🔴 ВСЕ REMOTE, А НЕ ПЕРВЫЙ (замер vibe-kiberos-app-owner 18.10): у `kiberos-app` их три
    # (`gitea-local`, `github`, `upstream`), и первый по порядку — `gitea-local`, а облачная
    # сессия возвращает ветку на `github`. С одним remote это незаметно, поэтому и не всплыло.
    # Плюс называем то, что нельзя получить из ls-remote: свежести он не отдаёт — зато видно,
    # какая голова есть ТОЛЬКО на одном remote, а это и есть след вернувшейся сессии.
    remotes="$(git -C "$REPO" remote 2>/dev/null || true)"
    if [ -n "$remotes" ]; then
      tmp="$(mktemp)"; : > "$tmp"
      while IFS= read -r r; do
        [ -n "$r" ] || continue
        git -C "$REPO" ls-remote --heads "$r" 2>/dev/null | awk -v R="$r" '{print $2 "\t" R}' >> "$tmp" || true
      done <<< "$remotes"
      echo "remotes ($(printf '%s' "$remotes" | wc -w)) — головы по каждому:"
      while IFS= read -r r; do
        [ -n "$r" ] || continue
        n="$(awk -v R="$r" -F'\t' '$2==R' "$tmp" | wc -l)"
        printf '  %-14s %s голов\n' "$r" "$n"
      done <<< "$remotes"
      uniq_heads=""
      # Сравнение «только на одном remote» имеет смысл ТОЛЬКО при двух и более remote:
      # с одним remote каждый его ref формально «уникален», и список превращается в шум.
      if [ "$(printf '%s' "$remotes" | wc -w)" -ge 2 ]; then
        uniq_heads="$(cut -f1 "$tmp" | sort | uniq -c | awk '$1==1{print $2}')"
      fi
      if [ -n "$uniq_heads" ]; then
        # Список ограничиваем: у форкнутого репо уникальных голов на `upstream` сотни,
        # и без границы сигнал («появилась новая») тонет в шуме чужого форка.
        total_uniq="$(printf '%s\n' "$uniq_heads" | grep -c . || true)"
        echo "🔴 ЕСТЬ ТОЛЬКО НА ОДНОМ REMOTE (${total_uniq} шт., первые 10 — ищите знакомое имя):"
        while IFS= read -r h; do
          [ -n "$h" ] || continue
          printf '  %s  ← %s\n' "$h" "$(awk -v H="$h" -F'\t' '$1==H{print $2}' "$tmp" | paste -sd, -)"
        done <<< "$(printf '%s\n' "$uniq_heads" | head -10)"
        [ "$total_uniq" -gt 10 ] && echo "  … и ещё $(( total_uniq - 10 ))"
      fi
      rm -f "$tmp"
    fi
  else
    echo "репозиторий не указан (--dir) — ветки remote не проверял"
  fi
  echo "ЖИВА ЛИ СЕЙЧАС — отсюда НЕ видно: публичного read-API нет, attach у части аккаунтов закрыт."
  echo "Не трогая сессию, можно ещё НАПИСАТЬ ей: claude-cloud.sh --org <acct> -p \"текст\" --cloud $SID"
  exit 0
fi

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
