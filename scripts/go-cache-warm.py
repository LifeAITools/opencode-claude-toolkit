#!/usr/bin/env python3
"""go-cache-warm — прогрев кэша OpenCode Go (задача b08418ac, часть 3).

ЗАЧЕМ. Кэш Go живёт ~45–60 минут (замер 19.10: обрыв между 45 и 75 мин на больших
префиксах). После простоя агент платит холодную ЗАПИСЬ большого префикса. Прогрев
повторяет ТО ЖЕ тело, что агент уже послал, — и кэш остаётся тёплым.

ОТКУДА ТЕЛО. Спул посредника: `capture/go-body/<сессия>.json` — его наполняет
`spool_body()` в `kiberos-app/litellm/go_orgs.py` (часть 1, влита и проверена живьём).

🔴 ПРАВИЛА, БЕЗ КОТОРЫХ ЭТО НЕЛЬЗЯ ВКЛЮЧАТЬ (слово владельца репозитория и фаундера):
  1. ПРОГРЕВ НЕ ИМЕЕТ ПРАВА СЛОМАТЬ ЖИВОЙ ВЫЗОВ: он идёт отдельной дверью, вне пути вызова;
  2. ОСТАНОВИТЬ, КОГДА АГЕНТ УШЁЛ: файл не переписывался дольше TTL — сессия ушла, греть
     нечего и незачем;
  3. ЛЮБОЕ ПЕРЕКЛЮЧЕНИЕ — С ОТКАТОМ: прогрев НЕ переключает организации и не меняет
     реестр; он лишь повторяет тело. Откат здесь — просто «перестать звать».

ПО УМОЛЧАНИЮ НИЧЕГО НЕ ШЛЁТ: нужен явный `--fire`. Без него — показывает, что послал бы.

ЗАПУСК:
  python3 scripts/go-cache-warm.py                 # что послал бы (ничего не шлёт)
  python3 scripts/go-cache-warm.py --fire          # послать
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SPOOL = Path.home() / "projects/vibe/kiberos-app/litellm/capture/go-body"
DEFAULT_ENDPOINT = "http://127.0.0.1:4000/v1/chat/completions"
DEFAULT_MASTER_KEY = Path.home() / "projects/vibe/kiberos-app/litellm/.master-key.local"


def pick(spool: Path, idle_min: int, ttl_min: int, now: float | None = None) -> list[dict]:
    """Сессии, которым прогрев нужен ПРЯМО СЕЙЧАС: простой от idle_min до ttl_min.

    Ниже idle — агент только что ходил, греть незачем (кэш и так тёплый).
    Выше ttl — файл не переписывался дольше срока: сессия ушла, греть НЕЧЕГО.
    """
    now = now if now is not None else time.time()
    out: list[dict] = []
    for path in sorted(spool.glob("*.json")):
        try:
            st = path.stat()
        except OSError:
            continue
        idle = (now - st.st_mtime) / 60.0
        if not (idle_min <= idle < ttl_min):
            continue
        out.append({"session": path.stem, "path": path, "idle_min": round(idle, 1),
                    "bytes": st.st_size})
    return out


def fire_one(item: dict, endpoint: str, master_key: str, timeout: int = 120) -> tuple[bool, str]:
    """Повторить тело через посредник. Ничего не меняет: только тот же запрос ещё раз."""
    try:
        body = json.loads(Path(item["path"]).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return False, f"тело не прочитано: {e}"
    # Заголовок сессии — тот же, которым её звал агент: иначе повтор ляжет в ЧУЖУЮ сессию.
    req = urllib.request.Request(
        endpoint, data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-api-key": master_key,
                 "x-opencode-session-id": item["session"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:160]}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:160]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spool", type=Path, default=DEFAULT_SPOOL)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--idle-min", type=int, default=40, help="раньше этого срока не греем")
    ap.add_argument("--ttl-min", type=int, default=120, help="позже этого — агент ушёл, не греем")
    ap.add_argument("--fire", action="store_true", help="послать по-настоящему (по умолчанию — показать)")
    a = ap.parse_args()

    if not a.spool.is_dir():
        print(f"спул не найден: {a.spool}")
        return 0
    items = pick(a.spool, a.idle_min, a.ttl_min)
    print(f"к прогреву: {len(items)} (окно простоя {a.idle_min}–{a.ttl_min} мин)")
    if not a.fire:
        for it in items:
            print(f"  [показал бы] {it['session']}  простой {it['idle_min']} мин  {it['bytes']} Б")
        print("  (ничего не послано — нужен --fire)")
        return 0

    key = DEFAULT_MASTER_KEY.read_text(encoding="utf-8").strip() if DEFAULT_MASTER_KEY.exists() else os.environ.get("LITELLM_MASTER_KEY", "")
    if not key:
        print("нет ключа посредника (нет .master-key.local и LITELLM_MASTER_KEY) — не шлю")
        return 1
    ok = bad = 0
    for it in items:
        good, detail = fire_one(it, a.endpoint, key)
        print(f"  {'OK  ' if good else 'ОТКАЗ'} {it['session']}  простой {it['idle_min']} мин — {detail}")
        ok += 1 if good else 0
        bad += 0 if good else 1
    print(f"итог: {ok} ок, {bad} отказ(ов)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
