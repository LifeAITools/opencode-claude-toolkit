#!/usr/bin/env bash
# cloud-exchange — обмен файлами с облачным агентом ЧЕРЕЗ ВЕТКИ РЕПОЗИТОРИЯ.
#
# ЗАЧЕМ (слово фаундера 18.10 голосом): «папка обмена — он кладёт, ты читаешь, кладёшь reply,
# и пишешь ему личное сообщение». Идея верна, но папка НЕ МОЖЕТ быть на нашем диске: облачный
# агент живёт в машине Anthropic и видит ТОЛЬКО репозиторий. Поэтому папка обмена — ВНУТРИ
# репозитория, а носитель — git-ветка.
#
# 🔴 ЧТО ЭТО РЕШАЕТ: чтение переписки (`--teleport`) берёт КОПИЮ сессии и ОБРЫВАЕТ ход живого
# агента (замер 18.10). Здесь чтения сессии нет вовсе: агент сам выкладывает состояние в файлы
# и отправляет ветку, а мы забираем её обычным `git fetch` — это чтение с диска, агента не касается.
#
# 🔴 ДВА НАПРАВЛЕНИЯ — ДВЕ РАЗНЫЕ ВЕТКИ, И ЭТО НАРОЧНО: если писать в ТУ ЖЕ ветку, куда агент
# отправляет свои чекпоинты, наши отправки будут сталкиваться с его (не-ff, конфликты) и портить
# ему работу. Поэтому «наружу» — ветка сессии, «внутрь» — отдельная ветка входящих.
#
# СОГЛАШЕНИЕ О ПУТЯХ (его же надо вложить в задание агенту):
#   .cloud-exchange/outbox/   — агент кладёт СЮДА (состояние, diff, вопросы)
#   .cloud-exchange/inbox/    — мы кладём СЮДА (ответы, уточнения)
#
# ИСПОЛЬЗОВАНИЕ:
#   cloud-exchange pull <session_id> --dir <репо> --branch <ветка-сессии> [--remote <r>]   # по умолчанию: origin, если он есть; иначе — ВСЕ remotes по очереди
#       — забрать ветку и показать НОВЫЕ файлы из outbox (что уже видели — не повторяет)
#   cloud-exchange say <session_id> "текст" --dir <репо> [--remote <r>]   # по умолчанию: origin, если он есть; иначе — ВСЕ remotes по очереди [--inbox-branch <b>] [--org <acct>]
#       — положить ответ в inbox, отправить ветку и ПОЗВАТЬ агента (сообщение в очередь, ход не рвётся)
#   cloud-exchange seen <session_id>            — что уже прочитано (маркер)
#
# НАСТРОЙКИ (env): CLAUDE_CLOUD_WRAPPER, CLAUDE_CLOUD_EXCHANGE_DIR (маркеры, по умолчанию ~/.claude/cloud-exchange)
set -euo pipefail

WRAP="${CLAUDE_CLOUD_WRAPPER:-/home/relishev/projects/vibe/claude-code-sdk/scripts/claude-cloud.sh}"
MARK_DIR="${CLAUDE_CLOUD_EXCHANGE_DIR:-$HOME/.claude/cloud-exchange}"
OUTBOX=".cloud-exchange/outbox"
INBOX=".cloud-exchange/inbox"

CMD="${1:-}"; shift || true
SID=""; DIR="$PWD"; BRANCH=""; INBOX_BRANCH=""; REMOTE=""; ORG=""; TEXT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir требует путь}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch требует имя}"; shift 2 ;;
    --inbox-branch) INBOX_BRANCH="${2:?}"; shift 2 ;;
    --remote) REMOTE="${2:?}"; shift 2 ;;
    --org) ORG="${2:?}"; shift 2 ;;
    session_*) SID="$1"; shift ;;
    *) [ -z "$TEXT" ] && TEXT="$1" || TEXT="$TEXT $1"; shift ;;
  esac
done
[ -n "$SID" ] || { echo "usage: cloud-exchange {pull|say|seen} <session_id> …" >&2; exit 2; }
git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || { echo "не git-репозиторий: $DIR" >&2; exit 2; }
mkdir -p "$MARK_DIR"
MARK="$MARK_DIR/${SID}.seen"

# 🔴 REMOTE НЕ УГАДЫВАЕТСЯ, А ВЫБИРАЕТСЯ (замер vibe-kiberos-app-owner 18.10): дефолт `origin`
# молча уходил не туда на ЛЮБОМ нашем репо без `origin` (у kiberos-app их три: gitea-local,
# github, upstream), и это читалось как «агент ничего не выложил» — то есть как ПУСТОЙ ОТВЕТ,
# а не как ошибка. Худший класс: отсутствие выглядит как результат.
remotes_all="$(git -C "$DIR" remote 2>/dev/null || true)"
resolve_remotes() {
  if [ -n "$REMOTE" ]; then printf '%s\n' "$REMOTE"; return; fi
  if printf '%s\n' "$remotes_all" | grep -qx origin; then printf '%s\n' origin; return; fi
  printf '%s\n' "$remotes_all"
}
CANDIDATES="$(resolve_remotes)"

case "$CMD" in
  seen)
    [ -f "$MARK" ] && cat "$MARK" || echo "(ещё ничего не читали)"
    ;;

  pull)
    [ -n "$BRANCH" ] || { echo "pull: нужен --branch <ветка-сессии>" >&2; exit 2; }
    ref=""; tried=""
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      tried="$tried $r"
      if git -C "$DIR" fetch -q "$r" "$BRANCH" 2>/dev/null; then ref="$r/$BRANCH"; break; fi
    done <<< "$CANDIDATES"
    if [ -z "$ref" ]; then
      echo "ветка '$BRANCH' НЕ НАЙДЕНА ни на одном remote. Пробовал:$tried" >&2
      echo "  Это НЕ «агент ничего не выложил»: проверьте имя ветки и список remotes (git remote -v)." >&2
      exit 3
    fi
    [ "$(printf '%s\n' "$CANDIDATES" | grep -c .)" -gt 1 ] && echo "(ветка нашлась на remote '$ref' — смотрел все, потому что origin нет)"
    files="$(git -C "$DIR" ls-tree -r --name-only "$ref" -- "$OUTBOX" 2>/dev/null | sort || true)"
    [ -n "$files" ] || { echo "в $ref нет файлов в $OUTBOX (агент ещё не выкладывал)"; exit 0; }
    new="$(comm -13 <(sort "$MARK" 2>/dev/null || true) <(printf '%s\n' "$files"))"
    if [ -z "$new" ]; then echo "нового нет — всё из $ref уже читали"; exit 0; fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      echo "=== $f ==="
      git -C "$DIR" show "$ref:$f" 2>/dev/null || echo "(не прочитался)"
      echo
    done <<< "$new"
    printf '%s\n' "$files" > "$MARK"
    echo "— прочитано, маркер обновлён ($MARK)"
    ;;

  say)
    [ -n "$TEXT" ] || { echo "say: нужен текст" >&2; exit 2; }
    ib="${INBOX_BRANCH:-cloud-inbox-$SID}"
    f="$INBOX/$(date -u +%Y%m%dT%H%M%SZ)-owner.md"
    # 🔴 РАБОТАЕМ В ОТДЕЛЬНОМ WORKTREE, А НЕ В ТЕКУЩЕМ ДЕРЕВЕ. Иначе ответ коммитился бы в ту
    # ветку, где сейчас стоит человек (обычно main) — и «обменный» коммит уезжал бы в основную
    # историю. Здесь коммит живёт только в ветке входящих.
    WT="$(mktemp -d /tmp/cloud-exchange-XXXXXX)"
    git -C "$DIR" worktree add -q --detach "$WT" HEAD
    mkdir -p "$WT/$(dirname "$f")"
    { printf '# Ответ владельца двери\n\n%s\n' "$TEXT"; } > "$WT/$f"
    git -C "$WT" add "$f"
    git -C "$WT" -c user.name="cloud-exchange" -c user.email="cloud-exchange@kiberos.local" \
      commit -q -m "cloud-exchange: ответ облачной сессии $SID"
    sha="$(git -C "$WT" rev-parse HEAD)"
    # Для отправки берём первый кандидат (origin, если он есть; иначе единственный remote).
    push_remote="$(printf '%s\n' "$CANDIDATES" | grep -m1 . || true)"
    [ -n "$push_remote" ] || { echo "у репозитория нет ни одного remote — ответ некуда отправить" >&2; exit 3; }
    if git -C "$WT" push -q "$push_remote" "$sha:refs/heads/$ib" 2>/dev/null; then
      echo "ответ уложен и отправлен: $push_remote/$ib ($f)"
    else
      echo "НЕ ОТПРАВИЛОСЬ в $push_remote/$ib — проверьте доступ к remote (для GitHub-клона нужен App)" >&2
      git -C "$DIR" worktree remove --force "$WT" 2>/dev/null || true
      exit 3
    fi
    git -C "$DIR" worktree remove --force "$WT" 2>/dev/null || true
    # Зовём агента: это ЗАПИСЬ в очередь, ход живого агента она НЕ обрывает.
    opts=""; [ -n "$ORG" ] && opts="--org $ORG"
    "$WRAP" $opts -p "Проверь ветку $ib — в $INBOX лежит ответ. Продолжай." --cloud "$SID" 2>&1 | tail -3 || \
      echo "ПОЗВАТЬ НЕ УДАЛОСЬ (сообщение не ушло) — файл всё равно лежит в ветке $ib" >&2
    ;;

  *) echo "usage: cloud-exchange {pull|say|seen} <session_id> …" >&2; exit 2 ;;
esac
