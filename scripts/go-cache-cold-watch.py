#!/usr/bin/env python3
"""go-cache-cold-watch — сторож холодных записей OpenCode Go (задача b08418ac).

ЗАЧЕМ. Слово фаундера 19.10: «отслеживать, если с нас вдруг начинают брать холодную
запись, то значит мы промахнулись со временем, надо это себе срочно выписать и потом
поправить». Это тот самый прибор. Он НЕ ГРЕЕТ кэш и НЕ ЗАВИСИТ от развилки «через
какую дверь ходит трафик Go» — он только ЧИТАЕТ и НАЗЫВАЕТ промахи.

ЧТО СЧИТАЕТ. Для каждой сессии — соседние вызовы по времени. Промах = предыдущий вызов
читал кэш (cached > 0), а следующий — НЕ читал (cached = 0) на БОЛЬШОМ префиксе
(>= --min-prompt, по умолчанию 20000 токенов; мелкие запросы кэш не греют и только
зашумят). Разрыв между ними — это то, СКОЛЬКО кэш не пережил.

ОТКУДА ДАННЫЕ. Журнал посредника `LiteLLM_SpendLogs`:
`metadata.usage_object.prompt_tokens_details.cached_tokens`. 🔴 Отдельной колонки кэша
НЕТ, а колонка `cache_hit` ЛЖЁТ (замер 19.10: False на 9573 из 9591 при попаданиях в
тысячах) — читать её нельзя. Причина названа владельцем посредника 25.10 по исходнику:
`cache_hit` ставится ТОЛЬКО собственным кэшем ответов LiteLLM, а раздел `cache:` у нас
не настроен, поэтому он False по построению.

🔴 NULL — ЭТО НЕ НОЛЬ. `cached_tokens IS NULL` значит «поставщик не отдал цифру», и такие
строки ИСКЛЮЧАЮТСЯ из ряда (раньше здесь стоял COALESCE(...,0), из-за которого
неизмеренное считалось промахом — та самая ложная аномалия 24.10). Сколько исключено —
печатается отдельной строкой, чтобы «нет данных» не выглядело как «всё хорошо».

ЗАПУСК:  python3 scripts/go-cache-cold-watch.py [--hours 24] [--min-prompt 20000] [--json]
Выход 0 всегда: это прибор, а не гейт. Ненулевой — только если база недоступна.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

DB_CONTAINER = "kiberos-litellm-db"
DB_USER = "litellm"
DB_NAME = "litellm"

QUERY = """
WITH c AS (
  SELECT session_id, "startTime" AS t,
    (metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens')::bigint AS cached,
    COALESCE((metadata->'usage_object'->>'prompt_tokens')::bigint, 0) AS ptok
  FROM "LiteLLM_SpendLogs"
  WHERE model LIKE '%deepseek%' AND "startTime" > now() - interval '__HOURS__ hours'
    AND metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens' IS NOT NULL
),
w AS (
  SELECT session_id, t, cached, ptok,
    lag(cached) OVER (PARTITION BY session_id ORDER BY t) AS pc,
    lag(t) OVER (PARTITION BY session_id ORDER BY t) AS pt
  FROM c
)
SELECT
  to_char(t, 'YYYY-MM-DD HH24:MI:SS') AS at,
  round(EXTRACT(EPOCH FROM (t - pt)) / 60.0, 1) AS gap_min,
  ptok AS prompt_tokens,
  left(session_id, 28) AS session
FROM w
WHERE pc > 0 AND cached = 0 AND ptok >= __MIN_PROMPT__ AND t > pt
ORDER BY t DESC
"""

QUERY_UNMEASURED = """
SELECT count(*)
FROM "LiteLLM_SpendLogs"
WHERE model LIKE '%deepseek%' AND "startTime" > now() - interval '__HOURS__ hours'
  AND metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens' IS NULL
"""


def run_sql(sql: str) -> list[list[str]]:
    """Одна дверь к базе: psql внутри контейнера посредника, вывод без рамок."""
    try:
        out = subprocess.run(
            ["docker", "exec", DB_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME,
             "-t", "-A", "-F", "\t", "-c", sql],
            capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        sys.stderr.write("go-cache-cold-watch: нет docker — база посредника недоступна\n")
        return []
    if out.returncode != 0:
        sys.stderr.write(f"go-cache-cold-watch: база ответила отказом: {out.stderr.strip()[:300]}\n")
        return []
    return [line.split("\t") for line in out.stdout.strip().splitlines() if line]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--min-prompt", type=int, default=20000)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rows = run_sql(QUERY.replace("__HOURS__", str(a.hours)).replace("__MIN_PROMPT__", str(a.min_prompt)))
    events = [
        {"at": r[0], "gap_min": float(r[1]), "prompt_tokens": int(r[2]), "session": r[3]}
        for r in rows
    ]
    unmeasured_rows = run_sql(QUERY_UNMEASURED.replace("__HOURS__", str(a.hours)))
    unmeasured = int(unmeasured_rows[0][0]) if unmeasured_rows and unmeasured_rows[0] else 0

    if a.json:
        print(json.dumps({"hours": a.hours, "min_prompt": a.min_prompt,
                          "count": len(events), "unmeasured_rows": unmeasured,
                          "events": events}, ensure_ascii=False, indent=1))
        return 0

    print(f"Холодные записи OpenCode Go за {a.hours} ч (префикс >= {a.min_prompt} токенов): {len(events)}")
    if unmeasured:
        print(f"  исключено неизмеренных строк (cached_tokens IS NULL — это НЕ ноль): {unmeasured}")
    if not events:
        print("  ни одной — либо кэш не промахивался, либо окно пустое (проверь --hours)")
        return 0
    print(f"  {'когда':<19} {'разрыв, мин':>11} {'префикс':>9}  сессия")
    for e in events[:40]:
        print(f"  {e['at']:<19} {e['gap_min']:>11.1f} {e['prompt_tokens']:>9}  {e['session']}")
    if len(events) > 40:
        print(f"  … ещё {len(events) - 40}")
    gaps = sorted(e["gap_min"] for e in events)
    print(f"  разрыв: медиана {gaps[len(gaps)//2]:.1f} мин, максимум {gaps[-1]:.1f} мин")
    print("  ЧИТАЙ ТАК (перемер 24.10, 39 863 крупных вызова): перелом 30–40 мин, к 45 — ноль.")
    print("             разрыв < 30 мин = промах НЕ по времени (префикс сменился сам);")
    print("             разрыв > 40 мин = кэш не дожил до хода.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
