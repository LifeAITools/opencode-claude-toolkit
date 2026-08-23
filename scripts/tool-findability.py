#!/usr/bin/env python3
"""
Найдётся ли твой инструмент, если агент не знает его имени

Поиск инструментов сверяет слова буквально. Значит найти дверь по смыслу можно
только по ЛАТИНСКИМ словам, которые говорят, ЧТО ОНА ДЕЛАЕТ. Не считаются:
имя самого инструмента (по нему поиск и так совпадает) и имена параметров
(`cells`, `bbox`, `imageFile` — по ним никто не ищет). Кириллица не считается
вовсе: тело описания индексируется, а русские слова из него — нет.

🔴 КРИТЕРИЙ ИМЕННО ТАКОЙ, А НЕ «ЕСТЬ ЛИ КИРИЛЛИЦА». Замер
vibe-telegram-mcp-service-owner 23.08.2026: по признаку «есть кириллица»
подозреваемых 21, а настоящих пробелов 3 — в семь раз меньше. У девяти русский
абзац стоит внутри английского описания и находится прекрасно; а у трёх
латинские слова БЫЛИ, но это были имена параметров.

🔴 ОТКУДА БРАТЬ СПИСОК. По умолчанию скрипт читает тела запросов — но там видны
ТОЛЬКО инструменты, которые кто-то реально подтянул: с отложенной загрузкой
полный каталог в запросы не едет. Полный список знает сама служба, поэтому
свой набор проверяй так: выгрузи ответ `tools/list` в файл и передай --tools.

Usage:
  python3 scripts/tool-findability.py                    # что видно в телах запросов
  python3 scripts/tool-findability.py --tools list.json  # ответ tools/list своей службы
  python3 scripts/tool-findability.py --threshold 5 --json
"""

import argparse
import glob
import json
import re
import sys
from pathlib import Path

DUMPS = Path.home() / ".claude-local" / "proxy-body-dumps"

# сколько знаков описания вообще доезжает до агента (жёсткий предел Claude Code)
DELIVERED = 2048

# служебные слова: они есть в любом описании и ни о чём не говорят
STOP = set(
    "the a an and or of to in for on with by is are be it this that you your not no if when "
    "then than as at from into out only never always all any each both use used using can "
    "cannot do does one two per via so but also more most less same other another".split()
)

CYRILLIC = re.compile(r"[Ѐ-ӿ]")
LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{2,}")
CAMEL = re.compile(r"([a-z])([A-Z])")


def meaningful_words(name: str, description: str, params: list[str]) -> set[str]:
    """Латинские слова описания, по которым дверь реально можно найти."""
    head = description[:DELIVERED]
    own = {p.lower() for p in re.split(r"[_\W]+", name) if p}
    own |= {p.lower() for p in params}
    own |= {w.lower() for p in params for w in re.findall(r"[A-Za-z]+", CAMEL.sub(r"\1 \2", p))}
    return {w.lower() for w in LATIN_WORD.findall(head)} - STOP - own


def from_dumps(dumps: Path):
    """Инструменты, которые РЕАЛЬНО доехали до агентов (неполный список — см. docstring)."""
    tools: dict[str, tuple[str, list[str]]] = {}
    files = 0
    for path in glob.glob(str(dumps / "*.json")):
        if path.endswith(".meta.json"):
            continue
        files += 1
        try:
            body = json.loads(Path(path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for tool in body.get("tools") or []:
            name, desc = tool.get("name"), tool.get("description") or ""
            if not name:
                continue
            if name not in tools or len(desc) > len(tools[name][0]):
                props = (tool.get("input_schema") or {}).get("properties") or {}
                tools[name] = (desc, list(props))
    return tools, f"тел запросов прочитано: {files} (виден только подтянутый набор, не весь каталог)"


def from_tools_file(path: Path):
    """Ответ tools/list своей службы — полный и авторитетный список."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("tools") if isinstance(raw, dict) else raw
    tools = {}
    for tool in items or []:
        schema = tool.get("inputSchema") or tool.get("input_schema") or {}
        tools[tool["name"]] = (tool.get("description") or "", list(schema.get("properties") or {}))
    return tools, f"список службы: {path}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tools", type=Path, help="файл с ответом tools/list своей службы")
    parser.add_argument("--dumps", type=Path, default=DUMPS, help="каталог с телами запросов")
    parser.add_argument("--threshold", type=int, default=5, help="сколько смысловых слов считать достаточным")
    parser.add_argument("--json", action="store_true", help="машиночитаемый вывод")
    args = parser.parse_args()

    if args.tools:
        tools, source = from_tools_file(args.tools)
    else:
        if not args.dumps.is_dir():
            sys.exit(f"нет каталога с телами запросов: {args.dumps}")
        tools, source = from_dumps(args.dumps)

    rows = []
    for name, (desc, params) in tools.items():
        found_by = meaningful_words(name, desc, params)
        rows.append(
            {
                "tool": name,
                "meaningful_latin_words": len(found_by),
                "cyrillic_chars": len(CYRILLIC.findall(desc[:DELIVERED])),
                "description_chars": len(desc),
                "truncated": len(desc) > DELIVERED,
                "findable": len(found_by) >= args.threshold,
            }
        )
    rows.sort(key=lambda r: r["meaningful_latin_words"])
    weak = [r for r in rows if not r["findable"]]

    if args.json:
        json.dump({"source": source, "threshold": args.threshold, "tools": rows}, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return

    print("# Найдётся ли инструмент, если агент не знает имени\n")
    print(f"Источник: {source}")
    print(f"Инструментов: {len(rows)} · порог: {args.threshold} смысловых слов\n")
    if not rows:
        print("Список пуст — сказать нечего. Это НЕ значит «всё хорошо».")
        return
    if not weak:
        print("Пробелов нет: у каждого инструмента есть латинские слова о том, что он делает.")
        return
    print(f"🔴 Найти по смыслу НЕЛЬЗЯ — {len(weak)} шт.:\n")
    print("| инструмент | смысловых лат. слов | кириллицы | описание |")
    print("|---|---:|---:|---:|")
    for r in weak:
        print(f"| {r['tool']} | {r['meaningful_latin_words']} | {r['cyrillic_chars']} | {r['description_chars']} |")
    print(
        "\nЛечится не переводом: русский текст оставь, он объясняет тому, кто дверь уже видит."
        "\nДобавь РЯДОМ ведущую латинскую фразу о том, что инструмент делает."
    )


if __name__ == "__main__":
    main()
