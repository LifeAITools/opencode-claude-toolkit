#!/usr/bin/env python3
"""
ToolSearch — на каком языке флот ищет свои инструменты

Поиск инструментов внутри Claude Code сверяет слова буквально и кириллицу
НЕ индексирует вовсе: русский запрос возвращает пустоту, неотличимую от
"такого инструмента нет" (замер 2026-08-22, проба на tg_look). Отсюда правило
для флота — искать по точному имени (`select:<имя>`) либо по-английски.

Этот скрипт отвечает, соблюдается ли правило на самом деле. Читает тела
запросов, которые складывает прокси (~/.claude-local/proxy-body-dumps),
и раскладывает вызовы ToolSearch по способу запроса.

🔴 СЧЁТ ИДЁТ ПО УНИКАЛЬНОМУ id БЛОКА tool_use, а не по вхождениям в телах.
В каждом теле лежит вся история разговора, поэтому счёт "по строкам" завышает
в десятки раз, и тем сильнее, чем активнее агент (оплаченная ошибка 22.08.2026).

Usage:
  python3 scripts/tool-search-language.py               # markdown за всё, что лежит в дампах
  python3 scripts/tool-search-language.py --since 2026-08-23
  python3 scripts/tool-search-language.py --json
  python3 scripts/tool-search-language.py --dumps /path/to/proxy-body-dumps
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

DUMPS = Path.home() / ".claude-local" / "proxy-body-dumps"

CYRILLIC = re.compile(r"[Ѐ-ӿ]")

BY_NAME = "по точному имени (select:)"
LATIN = "латиницей / по-английски"
CYR = "кириллицей"


def classify(query: str) -> str:
    if query.startswith("select:"):
        return BY_NAME
    if CYRILLIC.search(query):
        return CYR
    return LATIN


def collect(dumps: Path, since: datetime | None):
    """→ {tool_use_id: (query, mtime)} — один вызов считается ровно один раз."""
    calls: dict[str, tuple[str, float]] = {}
    files = 0
    for path in dumps.glob("*.json"):
        if path.name.endswith(".meta.json"):
            continue
        mtime = path.stat().st_mtime
        if since and datetime.fromtimestamp(mtime, timezone.utc) < since:
            continue
        files += 1
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for message in body.get("messages", []):
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_use" or block.get("name") != "ToolSearch":
                    continue
                query = (block.get("input") or {}).get("query", "")
                block_id = block.get("id")
                if block_id and block_id not in calls:
                    calls[block_id] = (query, mtime)
    return calls, files


def report(calls, files, dumps, as_json: bool):
    total = len(calls)
    buckets = Counter(classify(q) for q, _ in calls.values())
    cyrillic_queries = sorted({q for q, _ in calls.values() if classify(q) == CYR})
    stamps = [m for _, m in calls.values()]
    span = (
        (
            datetime.fromtimestamp(min(stamps), timezone.utc).isoformat(),
            datetime.fromtimestamp(max(stamps), timezone.utc).isoformat(),
        )
        if stamps
        else (None, None)
    )

    if as_json:
        json.dump(
            {
                "dumps": str(dumps),
                "files_read": files,
                "unique_calls": total,
                "span": {"from": span[0], "to": span[1]},
                "by_kind": dict(buckets),
                "cyrillic_queries": cyrillic_queries,
            },
            sys.stdout,
            ensure_ascii=False,
            indent=2,
        )
        print()
        return

    print("# ToolSearch — язык запросов флота\n")
    print(f"Тел прочитано: {files} · уникальных вызовов: {total}")
    if span[0]:
        print(f"Окно: {span[0]} — {span[1]}")
    print()
    if not total:
        print("Вызовов ToolSearch в этих телах нет — сказать нечего.")
        print("Это НЕ значит «поиском не пользуются»: дампы тел живут коротко,")
        print("и окно выше может просто не покрывать рабочий день.")
        return
    print("| способ запроса | вызовов | доля |")
    print("|---|---:|---:|")
    for kind in (BY_NAME, LATIN, CYR):
        n = buckets.get(kind, 0)
        print(f"| {kind} | {n} | {n * 100 // total}% |")
    if cyrillic_queries:
        print("\nЗапросы кириллицей (каждый почти наверняка вернул пустоту):")
        for q in cyrillic_queries:
            print(f"  · {q}")
        print(
            "\n🔴 Прежде чем считать это нарушением правила — отсей СВОИ СОБСТВЕННЫЕ пробы:"
            "\n   наблюдатель пишет в тот же журнал, что и наблюдаемое."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dumps", type=Path, default=DUMPS, help="каталог с телами запросов")
    parser.add_argument("--since", help="дата YYYY-MM-DD — считать только тела не старше её")
    parser.add_argument("--json", action="store_true", help="машиночитаемый вывод")
    args = parser.parse_args()

    if not args.dumps.is_dir():
        sys.exit(f"нет каталога с телами запросов: {args.dumps}")

    since = None
    if args.since:
        since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    calls, files = collect(args.dumps, since)
    report(calls, files, args.dumps, args.json)


if __name__ == "__main__":
    main()
