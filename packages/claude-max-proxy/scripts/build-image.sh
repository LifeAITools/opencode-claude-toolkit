#!/bin/bash
# build-image — сборка образа прокси + САМООЧИСТКА старых версий.
#
# Заказ фаундера (голосом, 27.10.2026): «кто собирает образы — тот должен иметь скрипт
# сборки, который сам убирает старые версии». Эталон логики — `scripts/deploy-image.sh`
# в vibe/kiberos-app (две метки: текущая и откатная, остальные снимаются); здесь то же
# правило, но с одним отличием: чистим только ТЕГИ версий этого репозитория и НИКОГДА не
# трогаем образ, на котором стоит контейнер (в т.ч. остановленный).
#
# Зачем вообще нужен скрипт, а не одна команда: Dockerfile требует СОБРАННЫЙ бинарь
# (dist/claude-max-proxy-linux-x64), его делает build-proxy.ts. Порядок «билет → образ →
# снятие старых» держать в голове нельзя — 30.10 на этой машине висели четыре тега
# (1.1.66, 1.1.67, 1.1.68, latest), три из них давно не соответствовали живому коду.
#
# Usage:
#   bash build-image.sh                      # собрать текущую версию + вычистить старые
#   bash build-image.sh --dry-run            # показать, что будет снято, и выйти
#   KEEP=3 bash build-image.sh               # оставить три версии вместо двух
#   REPO=tixi-cold/claude-max-proxy bash build-image.sh
set -euo pipefail

PKG_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=${REPO:-kiberos/claude-max-proxy}
KEEP=${KEEP:-2}
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

log(){ echo "[$(date +%H:%M:%S)] $*"; }

VERSION=$(grep -o '"version": "[^"]*"' "$PKG_DIR/package.json" | head -1 | cut -d'"' -f4)
[ -n "$VERSION" ] || { log "не смог прочитать версию из $PKG_DIR/package.json"; exit 1; }
log "версия $VERSION, репозиторий $REPO, держим $KEEP версий"

# Что уже есть. Только числовые теги — `latest` это псевдоним, а не версия.
mapfile -t TAGS < <(docker images --format '{{.Repository}}:{{.Tag}}' "$REPO" 2>/dev/null \
  | sed "s|^$REPO:||" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V)
log "сейчас тегов: ${#TAGS[@]}${TAGS[*]:+ (${TAGS[*]})}"

if [ "$DRY" = 1 ]; then
  N=$(( ${#TAGS[@]} + 1 ))
  if [ "$N" -gt "$KEEP" ]; then
    log "DRY-RUN — снял бы: $(printf '%s\n' "${TAGS[@]}" | head -n $(( N - KEEP )) | paste -sd' ' -)"
  else
    log "DRY-RUN — снимать нечего"
  fi
  exit 0
fi

# 1. Бинарь: образ собирается из уже скомпилированного dist.
log "собираю бинарь (bun build --compile)"
( cd "$PKG_DIR" && bun run scripts/build-proxy.ts --target=bun-linux-x64 >/dev/null ) \
  || { log "СБОРКА БИНАРЯ УПАЛА — образ не собираю"; exit 1; }

# 2. Образ. Контекст — каталог пакета (Dockerfile копирует dist/...).
log "docker build"
docker build -t "$REPO:$VERSION" -t "$REPO:latest" -f "$PKG_DIR/Dockerfile" "$PKG_DIR" >/dev/null \
  || { log "DOCKER BUILD УПАЛ"; exit 1; }
log "образ готов: $REPO:$VERSION (+ :latest)"

# 3. Снятие старых. Условия, при которых версию НЕ трогаем:
#    - она среди последних KEEP по номеру (текущая точно попадает: она только что собрана);
#    - на её образе стоит хоть один контейнер, включая остановленный.
mapfile -t TAGS < <(docker images --format '{{.Repository}}:{{.Tag}}' "$REPO" \
  | sed "s|^$REPO:||" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V)
DROP=$(( ${#TAGS[@]} - KEEP ))
[ "$DROP" -le 0 ] && { log "снимать нечего"; exit 0; }

removed=0; kept=0
for tag in "${TAGS[@]:0:$DROP}"; do
  id=$(docker images --format '{{.ID}}' "$REPO:$tag" | head -1)
  used=$(docker ps -a --filter "ancestor=$id" --format '{{.Names}}' | paste -sd, -)
  if [ -n "$used" ]; then
    log "оставляю $tag — на образе стоит контейнер: $used"
    kept=$((kept+1)); continue
  fi
  docker rmi "$REPO:$tag" >/dev/null && { log "снят $tag"; removed=$((removed+1)); }
done
log "итог: снято $removed, оставлено сверх нормы $kept; тегов сейчас: $(docker images --format '{{.Repository}}:{{.Tag}}' "$REPO" | grep -c .)"
