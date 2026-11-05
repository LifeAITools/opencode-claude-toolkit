#!/usr/bin/env bash
# Доставка состояния Go на muid: пропуска + реестр организаций.
#
# 🔴 РЕШЕНИЕ ФАУНДЕРА 05.11.2026 (голосом): обновление пропусков остаётся на ЭТОЙ машине
# («когда машина у нас запущена, она может периодически обновлять пропуска… и пересылать их
# туда на сервер, чтобы там всегда было актуально»).
#
# Поэтому писатель пропусков ОДИН — локальный `go-refresher.timer`. Серверная копия двери
# обновлять не умеет и не должна (`GO_TOKEN_REFRESH_ENABLED=false`): второй писатель ротирует
# одноразовый refresh-токен и убивает организацию (R8).
#
# Что делает этот скрипт:
#   .go-tokens.json → /opt/kiberos-claude-max-proxy/go/.go-tokens.json
#   go-orgs.yaml    → /opt/kiberos-claude-max-proxy/go/go-orgs.yaml
# Оба кладутся через временное имя + mv: дверь читает их на КАЖДОМ запросе, и половина файла
# в этот момент — это «нет пропуска» и 401 на живом ходу.
#
# Ничего не отправляется, если файл не разбирается или в нём нет ни одной организации с
# access_token: пустая/битая копия хуже старой — старая хотя бы работает, пока не истекла.
set -euo pipefail

TOKENS="${GO_TOKENS:-$HOME/projects/vibe/kiberos-app/litellm/.go-tokens.json}"
REGISTRY="${GO_REGISTRY:-$HOME/projects/vibe/kiberos-app/litellm/go-orgs.yaml}"
HOST="${MU:-muid.io}"
DIR="${GO_REMOTE_DIR:-/opt/kiberos-claude-max-proxy/go}"

[ -s "$TOKENS" ] || { echo "нет хранилища пропусков: $TOKENS" >&2; exit 1; }
[ -s "$REGISTRY" ] || { echo "нет реестра организаций: $REGISTRY" >&2; exit 1; }

# Проверка СОДЕРЖИМОГО, а не возраста: пропуск может законно лежать сутками неизменным.
COUNT=$(python3 - "$TOKENS" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print(-1); raise SystemExit(0)
orgs=d.get('orgs') if isinstance(d,dict) else None
if not isinstance(orgs,dict): print(-1); raise SystemExit(0)
print(sum(1 for v in orgs.values() if isinstance(v,dict) and v.get('access_token')))
PY
)
if [ "$COUNT" -lt 1 ]; then
  echo "ОТКАЗ: в хранилище пропусков нет ни одной организации с access_token (orgs=$COUNT) — не отправляю" >&2
  exit 2
fi

push() {
  local src="$1" dst="$2"
  base64 -w0 < "$src" | ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$HOST" \
    "base64 -d > '${dst}.tmp' && mv '${dst}.tmp' '${dst}' && chmod 600 '${dst}'"
}

push "$TOKENS"   "$DIR/.go-tokens.json"
push "$REGISTRY" "$DIR/go-orgs.yaml"

echo "отправлено на $HOST: пропусков ${COUNT}, $(stat -c %s "$TOKENS") б; реестр $(stat -c %s "$REGISTRY") б"
