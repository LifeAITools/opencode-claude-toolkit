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
DIRTY=0
for m in $MODELS; do
  for i in $(seq 1 "$SAMPLES"); do
    before=$(load1)
    ms=$(curl -s -o /dev/null -w '%{time_total}' -m 90 "$URL" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}")
    ms=$(awk -v s="$ms" 'BEGIN{printf "%d", s*1000}')
    after=$(load1)
    printf '{"ts":"%s","model":"%s","ms":%s,"load_before":%s,"load_after":%s}\n' \
      "$(date -u +%FT%TZ)" "$m" "$ms" "$before" "$after" >> "$OUT"
    awk -v a="$after" -v b="$THRESHOLD" 'BEGIN{exit !(a>=b)}' && DIRTY=1
    sleep 2
  done
done

echo "" | tee -a "$SUM"
for m in $MODELS; do
  vals=$(grep "\"model\":\"$m\"" "$OUT" | grep -o '"ms":[0-9]*' | cut -d: -f2 | sort -n)
  n=$(printf '%s\n' "$vals" | grep -c .)
  [ "$n" -gt 0 ] || { printf '%-28s нет проб\n' "$m" | tee -a "$SUM"; continue; }
  awk -v m="$m" -v n="$n" '{a[NR]=$1} END{
    printf "%-28s n=%d p50=%d мс p90=%d мс max=%d мс\n", m, n, a[int((n+1)*0.5)], a[int((n+1)*0.9)], a[n]
  }' <<< "$vals" | tee -a "$SUM"
done
[ "$DIRTY" = 1 ] && echo "🔴 ГРЯЗНЫЙ прогон: во время проб loadavg перевалил $THRESHOLD — цифры есть, вывод по ним нет" | tee -a "$SUM"
echo "строки: $OUT" | tee -a "$SUM"
echo "сводка: $SUM" | tee -a "$SUM"
