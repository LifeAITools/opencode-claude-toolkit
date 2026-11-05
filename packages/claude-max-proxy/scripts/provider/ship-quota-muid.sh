#!/usr/bin/env bash
# Доставка отчёта квоты OpenCode Go на muid — к серверной копии двери.
#
# 🔴 ЗАЧЕМ (найдено 05.11.2026 сразу после переезда чата на muid). Дверь выбирает
# организацию по запасу ТОЛЬКО если рядом с хранилищем пропусков лежит отчёт квоты
# (`dirname(GO_TOKENS_PATH)/quota-status-opencode-go.json`). На muid его не было —
# и выбор молча выродился в `active:` реестра, то есть чат поехал на
# `hello@lifeaitools.com` при неделе 99% (по анализатору — 52 минуты до стены).
# Ровно тот случай, о котором предупреждает комментарий в go-door.ts.
#
# Пишет ОДИН хост (рабочая машина), как и с пропусками: второй писатель не нужен.
# Файл кладётся через временное имя + mv: дверь читает его на каждом запросе, и
# половина файла в этот момент = «замера нет».
set -euo pipefail
SRC="${QUOTA_SRC:-$HOME/.claude-local/quota-status-opencode-go.json}"
HOST="${MU:-muid.io}"
DST="${QUOTA_DST:-/opt/kiberos-claude-max-proxy/go/quota-status-opencode-go.json}"

[ -s "$SRC" ] || { echo "нет файла квоты: $SRC" >&2; exit 1; }

# Проверка свежести: старый отчёт хуже отсутствующего — он выглядит как замер.
AGE_LIMIT_SEC="${AGE_LIMIT_SEC:-1800}"
AGE=$(( $(date +%s) - $(stat -c %Y "$SRC") ))
if [ "$AGE" -gt "$AGE_LIMIT_SEC" ]; then
  echo "ОТКАЗ: отчёт квоты устарел на ${AGE}s (порог ${AGE_LIMIT_SEC}s) — не отправляю" >&2
  exit 2
fi

base64 -w0 < "$SRC" | ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$HOST" \
  "base64 -d > '${DST}.tmp' && mv '${DST}.tmp' '${DST}' && chmod 644 '${DST}'"

echo "отправлено: $(stat -c %s "$SRC") б, возраст ${AGE}s"
