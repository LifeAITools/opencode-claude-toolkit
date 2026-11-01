#!/bin/bash
# quiet-latency-probe — база латентности ступеней памяти В ТИХОМ ОКНЕ.
#
# ЗАЧЕМ. Замеры в загруженном окне дают разброс вдесятеро: 01.11.2026 один и тот же mimo
# показывал от 2.3 с до 24 с при loadavg 25–42, и порядок цепочки, подобранный по такому
# снимку, через час неверен. Поэтому базу снимаем только когда машина свободна, а не когда
# удобно.
#
# ЧТО ДЕЛАЕТ. Ждёт loadavg(1) < ПОРОГ (по умолчанию 4), затем делает ПОСЛЕДОВАТЕЛЬНО
# (не в батче — батч сам создаёт нагрузку) по N вызовов каждой модели через медиатор :4000,
# пишет каждую пробу строкой JSON и в конце сводку p50/p90/max.
#
# ГРАНИЦА: пробы идут с max_tokens=1 и одинаковым коротким промптом, то есть меряют ОТВЕТ
# ступени, а не генерацию. Нагрузку сам почти не создаёт; если во время прогона loadavg
# поднимется выше порога, прогон помечается как ГРЯЗНЫЙ — цифры остаются, вывод по ним — нет.
#
# Usage:
#   bash quiet-latency-probe.sh            # ждать окна до 8 часов и снять базу
#   bash quiet-latency-probe.sh --now      # снять сразу, без ожидания (для проверки самого прибора)
#   THRESHOLD=4 SAMPLES=10 bash quiet-latency-probe.sh
set -uo pipefail

URL=${URL:-http://127.0.0.1:4000/v1/chat/completions}
THRESHOLD=${THRESHOLD:-4}
SAMPLES=${SAMPLES:-10}
MAX_WAIT_SEC=${MAX_WAIT_SEC:-28800}
MODELS=${MODELS:-"mimo-v2.6-flash qwen3.8-flash deepseek-v4.1-flash-go"}
SHAPES=${SHAPES:-"trivial workload reform"}
OUT_DIR=${OUT_DIR:-$HOME/.claude-local}
STAMP=$(date -u +%Y%m%d-%H%M)
OUT="$OUT_DIR/quiet-latency-$STAMP.jsonl"
SUM="$OUT_DIR/quiet-latency-$STAMP.summary.txt"
NOW=0
[ "${1:-}" = "--now" ] && NOW=1

mkdir -p "$OUT_DIR"

KEY=$(docker exec kiberos-litellm sh -lc 'echo $LITELLM_MASTER_KEY' 2>/dev/null)
[ -n "$KEY" ] || { echo "нет мастер-ключа — без него проба бессмысленна" >&2; exit 1; }

load1(){ awk '{print $1}' /proc/loadavg; }

if [ "$NOW" = 0 ]; then
  echo "жду окна: loadavg1 < $THRESHOLD (до $((MAX_WAIT_SEC/3600)) ч)" | tee -a "$SUM"
  started=$(date +%s)
  while :; do
    l=$(load1)
    awk -v a="$l" -v b="$THRESHOLD" 'BEGIN{exit !(a<b)}' && break
    if [ $(( $(date +%s) - started )) -gt "$MAX_WAIT_SEC" ]; then
      echo "окна не было за $((MAX_WAIT_SEC/3600)) ч (loadavg1=$l) — база не снята" | tee -a "$SUM"
      exit 3
    fi
    sleep 60
  done
fi

echo "прогон: $(date -u +%FT%TZ) loadavg=$(cat /proc/loadavg)" | tee -a "$SUM"
# 🔴 ШАПКА «ГДЕ И НА ЧЁМ»: без неё два числа из разных вселенных не сравниваются.
# Тот же урок, что у владельца движка: прогон обязан назвать машину, образ посредника и
# версию двери, иначе «стало быстрее» невозможно ни подтвердить, ни опровергнуть.
MEDIATOR=$(docker inspect kiberos-litellm --format '{{.Config.Image}}' 2>/dev/null || echo '?')
DOOR=$(curl -s -m 5 http://127.0.0.1:5050/version 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
# ТРИ ОБЩИХ ПОЛЯ С ВЛАДЕЛЬЦЕМ signal-wire (договорено 01.11): сборка, возраст, нагрузка.
# Без них два числа из разных прогонов несравнимы, а «стало быстрее» нельзя ни подтвердить,
# ни опровергнуть.
SHA=$(git -C "$(dirname "${BASH_SOURCE[0]}")/../../.." rev-parse --short HEAD 2>/dev/null || echo '?')
MSTART=$(docker inspect kiberos-litellm --format '{{.State.StartedAt}}' 2>/dev/null)
MUP='?'
if [ -n "$MSTART" ]; then
  MUP=$(python3 - "$MSTART" <<'PY' 2>/dev/null || echo '?'
import sys, datetime
s = sys.argv[1].split('.')[0].rstrip('Z')
t = datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() // 60))
PY
)
fi
DUP=$(curl -s -m 5 http://127.0.0.1:5050/health 2>/dev/null | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')
DUP=$(( ${DUP:-0} / 60 ))
echo "engine: $(hostname) · git_sha: ${SHA:-?} · mediator: ${MEDIATOR:-?} · up ${MUP}m · door: ${DOOR:-?} up ${DUP}m · cores: $(nproc)" | tee -a "$SUM"
DIRTY=0
# 🔴 ДВЕ ФОРМЫ НАГРУЗКИ, А НЕ ОДНА. «ping» меряет короткий ответ, а переформулировка памяти
# шлёт МНОГОТОКЕННЫЙ контекст и просит структурированный ответ — это другой профиль, и
# порядок ступеней по короткой форме может не совпадать с боевым. Поэтому меряем обе.
# Текст в workload ФИКСИРОВАН и одинаков для всех моделей, иначе сравниваем не модели,
# а разное содержимое.
mk_payload(){ # $1 = shape → печатает путь к JSON с заглушкой __MODEL__
  local shape="$1" f
  f=$(mktemp /tmp/probe-payload.XXXXXX.json)
  if [ "$shape" = "reform" ]; then
    # Форма «как у переформулировки памяти»: вход ~4к токенов, выход — структурированный
    # и длинный (замер владельца signal-wire: до 2 000 токенов). Короткая форма его скорость
    # завышает, поэтому замер по ней дал бы неверный порядок ступеней.
    python3 - "$f" <<'PY3'
import json, sys
filler = ("Пользователь обсуждает учёт расхода и кэш. " * 320)[:23000]
content = filler + "\n\nВерни JSON-массив из 20 объектов: у каждого поля id (число) и summary (2–3 предложения по существу)."
json.dump({"model": "__MODEL__", "messages": [{"role": "user", "content": content}],
           "max_tokens": 1024}, open(sys.argv[1], "w"), ensure_ascii=False)
PY3
  elif [ "$shape" = "workload" ]; then
    python3 - "$f" <<'PY2'
import json, sys
filler = ("Пользователь обсуждает учёт расхода и кэш. " * 320)[:23000]
content = filler + "\n\nОтветь строго JSON: {\"ok\":true}"
json.dump({"model": "__MODEL__", "messages": [{"role": "user", "content": content}],
           "max_tokens": 64}, open(sys.argv[1], "w"), ensure_ascii=False)
PY2
  else
    printf '%s' '{"model":"__MODEL__","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' > "$f"
  fi
  echo "$f"
}

# 🔴 МОДЕЛИ ЧЕРЕДУЮТСЯ, А НЕ ИДУТ БЛОКАМИ. Замер по блокам («десять раз A, потом десять
# раз B») сравнивает модели из РАЗНЫХ моментов окна: нагрузка за прогон уезжает, и разница
# между моделями смешивается с разницей во времени. Чередование разносит дрейф по всем
# одинаково — это то же правило, что «позиция фиксирована», только для времени, а не порядка.
for shape in $SHAPES; do
  BASE=$(mk_payload "$shape")
  declare -A PAYS=()
  for m in $MODELS; do
    PAYS[$m]=$(mktemp /tmp/probe-call.XXXXXX.json)
    sed "s/__MODEL__/$m/" "$BASE" > "${PAYS[$m]}"
  done
  for i in $(seq 1 "$SAMPLES"); do
    for m in $MODELS; do
      before=$(load1)
      ms=$(curl -s -o /dev/null -w '%{time_total}' -m 120 "$URL" \
        -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @"${PAYS[$m]}")
      ms=$(awk -v s="$ms" 'BEGIN{printf "%d", s*1000}')
      after=$(load1)
      printf '{"ts":"%s","shape":"%s","model":"%s","ms":%s,"load_before":%s,"load_after":%s}\n' \
        "$(date -u +%FT%TZ)" "$shape" "$m" "$ms" "$before" "$after" >> "$OUT"
      awk -v a="$after" -v b="$THRESHOLD" 'BEGIN{exit !(a>=b)}' && DIRTY=1
      sleep 2
    done
  done
  for m in $MODELS; do rm -f "${PAYS[$m]}"; done
  unset PAYS
  rm -f "$BASE"
done

echo "" | tee -a "$SUM"
for shape in $SHAPES; do
for m in $MODELS; do
  vals=$(grep "\"shape\":\"$shape\"" "$OUT" | grep "\"model\":\"$m\"" | grep -o '"ms":[0-9]*' | cut -d: -f2 | sort -n)
  n=$(printf '%s\n' "$vals" | grep -c .)
  [ "$n" -gt 0 ] || { printf '%-28s нет проб\n' "$m" | tee -a "$SUM"; continue; }
  awk -v m="$m" -v sh="$shape" -v n="$n" '{a[NR]=$1} END{
    printf "%-12s %-28s n=%d p50=%d мс p90=%d мс max=%d мс\n", sh, m, n, a[int((n+1)*0.5)], a[int((n+1)*0.9)], a[n]
  }' <<< "$vals" | tee -a "$SUM"
done
done
[ "$DIRTY" = 1 ] && echo "🔴 ГРЯЗНЫЙ прогон: во время проб loadavg перевалил $THRESHOLD — цифры есть, вывод по ним нет" | tee -a "$SUM"
echo "строки: $OUT" | tee -a "$SUM"
echo "сводка: $SUM" | tee -a "$SUM"
