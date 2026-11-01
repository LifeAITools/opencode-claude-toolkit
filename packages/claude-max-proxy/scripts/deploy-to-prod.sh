#!/bin/bash
# deploy-to-prod — выкатка образа прокси на kiberos.ai ОДНОЙ ПОВТОРЯЕМОЙ командой.
#
# ЗАЧЕМ. До 01.11.2026 пути на сервер не было вовсе: локально жили deploy-from-source.sh
# (машина) и build-image.sh (образ), а прод обновлялся руками через `docker save | ssh |
# docker load`. Это ровно то, что запрещают правила проекта: разовая храбрость вместо
# команды, и следующая выкатка снова требует вспоминать порядок. Первый живой повод —
# версия 1.1.68 на проде против 1.2.4 в репозитории, из-за которой дверь на сервере не
# умеет ни держать выдачу на стене, ни снимать её на первом 429.
#
# ЧТО ДЕЛАЕТ, по шагам:
#   1. проверяет, что локальный образ нужной версии СОБРАН (сборка — build-image.sh);
#   2. на СЕРВЕРЕ вешает текущий образ откатным тегом `rollback-<дата>` ДО `docker load`;
#   3. везёт образ и загружает его;
#   4. переписывает ОДНУ строку `image:` в compose (единственное место, где живёт тег);
#   5. пересоздаёт контейнер через `docker compose up -d --no-deps`;
#   6. ПРОВЕРЯЕТ ЖИВЬЁМ: /version из контейнера посредника (не с хоста — на kiberos.ai
#      127.0.0.1:5050 занят ssh-туннелем на рабочую машину и покажет ЧУЖИЕ числа),
#      /health с go-door.configured, и по желанию один настоящий вызов модели;
#   7. при любой неудаче после пересоздания — САМ возвращает compose и контейнер на
#      откатный тег и проверяет, что вернулось.
#
# Usage:
#   bash deploy-to-prod.sh --dry-run        # показать план, ничего не менять
#   bash deploy-to-prod.sh                  # выкатить версию из package.json
#   VERSION=1.2.4 bash deploy-to-prod.sh    # выкатить названную версию
#   bash deploy-to-prod.sh --smoke          # + один настоящий вызов модели после проверок
#   bash deploy-to-prod.sh --rollback       # вернуть последний откатный тег
#   bash deploy-to-prod.sh --rollback rollback-20261101-1045
#
# Переменные: HOST (kiberos.ai), REPO (kiberos/claude-max-proxy),
#             COMPOSE (/opt/kiberos-app/docker-compose.claude-proxy.yml),
#             SERVICE (kiberos-claude-max-proxy), PROBE (kiberos-litellm).
set -euo pipefail

PKG_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOST=${HOST:-kiberos.ai}
REPO=${REPO:-kiberos/claude-max-proxy}
COMPOSE=${COMPOSE:-/opt/kiberos-app/docker-compose.claude-proxy.yml}
SERVICE=${SERVICE:-kiberos-claude-max-proxy}
PROBE=${PROBE:-kiberos-litellm}
KEEP_ROLLBACK=${KEEP_ROLLBACK:-2}
DRY=0
SMOKE=0
MODE=deploy
ROLLBACK_TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --smoke) SMOKE=1 ;;
    --rollback)
      MODE=rollback
      shift
      [ $# -gt 0 ] && [ "${1#-}" = "$1" ] && { ROLLBACK_TAG="$1"; }
      ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "неизвестный аргумент: $1"; exit 2 ;;
  esac
  shift
done

log(){ echo "[$(date +%H:%M:%S)] $*"; }
die(){ echo "[$(date +%H:%M:%S)] ОТКАЗ: $*" >&2; exit 1; }
sshx(){ ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "$@"; }

VERSION=${VERSION:-$(grep -o '"version": "[^"]*"' "$PKG_DIR/package.json" | head -1 | cut -d'"' -f4)}
[ -n "$VERSION" ] || die "не смог прочитать версию из $PKG_DIR/package.json"
STAMP=$(date +%Y%m%d-%H%M)
ROLLBACK_NEW="rollback-$STAMP"

# Живая проверка — ТОЛЬКО из сети контейнеров. С хоста kiberos.ai порт 5050 держит
# ssh-туннель на рабочую машину: ответ будет выглядеть зелёным, показывая чужие числа.
probe_version(){ sshx "docker exec $PROBE python3 -c \"import urllib.request,json;d=json.load(urllib.request.urlopen('http://$SERVICE:5050/version',timeout=8));print(d.get('version'))\"" 2>/dev/null | tr -d '\r' | tail -1; }
probe_health(){ sshx "docker exec $PROBE python3 -c \"import urllib.request,json;d=json.load(urllib.request.urlopen('http://$SERVICE:5050/health',timeout=8));print(json.dumps(d))\"" 2>/dev/null | tr -d '\r' | tail -1; }
compose_tag(){ sshx "grep -m1 -E '^[[:space:]]*image:[[:space:]]*$REPO:' $COMPOSE | sed 's/.*$REPO://'" 2>/dev/null | tr -d '\r' | tail -1; }
set_compose_tag(){ sshx "sed -i.bak-deploy-$STAMP -E 's#^([[:space:]]*image:[[:space:]]*$REPO):.*#\\1:$1#' $COMPOSE" ; }
recreate(){ sshx "cd $(dirname "$COMPOSE") && docker compose -f $COMPOSE up -d --no-deps $SERVICE" >/dev/null; }

log "хост $HOST, сервис $SERVICE, образ $REPO, версия $VERSION"

# ── РЕЖИМ ОТКАТА ────────────────────────────────────────────────────────────────────────
if [ "$MODE" = rollback ]; then
  if [ -z "$ROLLBACK_TAG" ]; then
    ROLLBACK_TAG=$(sshx "docker images $REPO --format '{{.Tag}}' | grep '^rollback-' | sort | tail -1" | tr -d '\r')
  fi
  [ -n "$ROLLBACK_TAG" ] || die "на сервере нет ни одного откатного тега"
  CUR=$(compose_tag)
  log "откат: $CUR → $ROLLBACK_TAG"
  if [ "$DRY" = 1 ]; then log "DRY-RUN — ничего не меняю"; exit 0; fi
  set_compose_tag "$ROLLBACK_TAG"
  recreate
  sleep 3
  GOT=$(probe_version)
  log "после отката дверь отвечает версией: ${GOT:-<нет ответа>}"
  [ "$GOT" = "$ROLLBACK_TAG" ] || log "ВНИМАНИЕ: версия не совпала с откатным тегом — проверь /health и логи"
  exit 0
fi

# ── ПРЕДПОЛЁТНЫЕ ПРОВЕРКИ ──────────────────────────────────────────────────────────────
docker image inspect "$REPO:$VERSION" >/dev/null 2>&1 \
  || die "локального образа $REPO:$VERSION нет — сначала: bash $(dirname "${BASH_SOURCE[0]}")/build-image.sh"
sshx true 2>/dev/null || die "нет SSH до $HOST"
RUNTAG=$(sshx "docker inspect $SERVICE --format '{{.Config.Image}}'" 2>/dev/null | sed "s#.*$REPO:##" | tr -d '\r' | tail -1)
[ -n "$RUNTAG" ] || die "не смог прочитать текущий образ контейнера $SERVICE"
LIVE_BEFORE=$(probe_version)
log "на сервере сейчас: тег контейнера $RUNTAG, отвечает версией ${LIVE_BEFORE:-<нет ответа>}"

if [ "$RUNTAG" = "$VERSION" ] && [ "$LIVE_BEFORE" = "$VERSION" ]; then
  log "версия уже в бою — делать нечего (идемпотентно)"; exit 0
fi

if [ "$DRY" = 1 ]; then
  log "DRY-RUN. Было бы: откатный тег $RUNTAG → $ROLLBACK_NEW; docker save | load;"
  log "         compose публикует $REPO:$VERSION; up -d --no-deps $SERVICE;"
  log "         проверки: /version=$VERSION, go-door.configured, smoke=$SMOKE"
  exit 0
fi

# ── 1. ОТКАТНЫЙ ТЕГ НА СЕРВЕРЕ (до загрузки нового) ────────────────────────────────────
sshx "docker tag $REPO:$RUNTAG $REPO:$ROLLBACK_NEW" \
  || die "не смог повесить откатный тег $ROLLBACK_NEW на $RUNTAG — выкатку не начинаю"
log "откатный тег на сервере: $REPO:$ROLLBACK_NEW (== $RUNTAG)"

# ── 2. ПЕРЕВОЗКА ОБРАЗА ────────────────────────────────────────────────────────────────
log "везу образ (docker save | ssh docker load)"
docker save "$REPO:$VERSION" | sshx "docker load" >/dev/null || die "загрузка образа упала"
sshx "docker tag $REPO:$VERSION $REPO:latest" >/dev/null 2>&1 || true
log "образ на сервере: $(sshx "docker images $REPO:$VERSION --format '{{.ID}} {{.Size}}'" | tr -d '\r')"

# ── 3. ТЕГ В COMPOSE И ПЕРЕСОЗДАНИЕ ────────────────────────────────────────────────────
set_compose_tag "$VERSION"
recreate

# ── 4. ПРОВЕРКИ ЖИВЬЁМ (без них выкатка не считается сделанной) ───────────────────────
FAIL=""
for i in $(seq 1 20); do
  GOT=$(probe_version); [ "$GOT" = "$VERSION" ] && break; sleep 1
done
[ "$GOT" = "$VERSION" ] || FAIL="дверь отвечает версией ${GOT:-<нет ответа>}, ожидалась $VERSION"

if [ -z "$FAIL" ]; then
  HEALTH=$(probe_health)
  case "$HEALTH" in
    *'"configured": true'*|*'"configured":true'*) log "go-door.configured: true" ;;
    *) FAIL="дверь поднялась, но /health не говорит go-door.configured: true — $HEALTH" ;;
  esac
fi

if [ -z "$FAIL" ] && [ "$SMOKE" = 1 ]; then
  log "smoke: один настоящий вызов через /go (this стоит квоты — только по --smoke)"
  CODE=$(sshx "docker exec $PROBE python3 -c \"
import urllib.request,json
r=urllib.request.Request('http://$SERVICE:5050/go/chat/completions',
  data=json.dumps({'model':'deepseek-v4.1-flash','messages':[{'role':'user','content':'Say OK'}],'max_tokens':5}).encode(),
  headers={'Content-Type':'application/json','x-opencode-session-id':'deploy-smoke-$STAMP'})
try:
  print(urllib.request.urlopen(r,timeout=60).status)
except Exception as e:
  print(getattr(e,'code','ERR'))
\"" 2>/dev/null | tr -d '\r' | tail -1)
  [ "$CODE" = "200" ] || FAIL="smoke-вызов /go вернул $CODE (ожидался 200)"
fi

# ── 5. ОТКАТ ПРИ НЕУДАЧЕ ───────────────────────────────────────────────────────────────
if [ -n "$FAIL" ]; then
  log "ПРОВЕРКА НЕ ПРОШЛА: $FAIL"
  log "возвращаю $ROLLBACK_NEW ($RUNTAG)"
  set_compose_tag "$ROLLBACK_NEW" || die "не смог вернуть compose — ВМЕШИВАЙСЯ РУКАМИ"
  recreate || log "пересоздание при откате упало — проверь вручную"
  sleep 3
  BACK=$(probe_version)
  log "после отката дверь отвечает: ${BACK:-<нет ответа>}"
  die "выкатка отменена, откат выполнен"
fi

# ── 6. ЧИСТКА СТАРЫХ ОТКАТНЫХ ТЕГОВ (держим KEEP_ROLLBACK, самый свежий всегда остаётся) ─
OLD=$(sshx "docker images $REPO --format '{{.Tag}}' | grep '^rollback-' | sort | head -n -$KEEP_ROLLBACK" | tr -d '\r' || true)
for t in $OLD; do sshx "docker rmi $REPO:$t" >/dev/null 2>&1 && log "снят старый откатный тег $t"; done

log "ГОТОВО: $REPO:$VERSION в бою, откат — $ROLLBACK_NEW"
log "если что-то не так: bash $0 --rollback $ROLLBACK_NEW"
