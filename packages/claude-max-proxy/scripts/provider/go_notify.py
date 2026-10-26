#!/usr/bin/env python3
"""Доставляет отказ продления OpenCode Go в комнату проекта через relay kibctl.

ЗАЧЕМ. go_refresher при провале отдаёт текст отказа на вход команде из
`GO_NOTIFY_CMD`. Эта команда — мы: читаем текст со входа и шлём его событием в
центральный приём уведомлений (https://relay.kiberos.ai, POST /v1/events). Сурфейс
сам забирает событие из очереди и рисует его в теме kiberos-app. Напрямую в Telegram
служба не ходит нарочно: дверь сурфейса живёт на домашней машине, а ключ агента в
файле службы на двух машинах — лишний ключ (решение владельца сурфейса, 08.10.2026).

КУДА ПРИДЁТ. Комнату выбирают relay и сурфейс по полю `payload.owner` — имени агента,
чья тема примет событие. Без него событие падает дежурному kibctl (тема 171): замер
08.10.2026, обе первые пробы легли туда, хотя подпись говорила «kiberos-app». Поле
`app` в комнату не ведёт, оно только для подписи и группировки.

🔴 ТОКЕН — ТОЛЬКО ИЗ ОКРУЖЕНИЯ (`KIBCTL_RELAY_TOKEN_GO_REFRESHER`), никогда не
аргументом: аргументы видны в списке процессов любому на машине. Юнит берёт его из
EnvironmentFile; команда, запущенная руками из оболочки, переменную НЕ наследует —
поднимите окружение сами, иначе получите «токен не задан», а не «токен неверный».

🔴 ПРОБА И НАСТОЯЩАЯ ТРЕВОГА НИКОГДА НЕ ДЕЛЯТ ИДЕНТИФИКАТОР. Приёмник отвечает 409
на уже виденный id, и отправитель читает это как успех. Детерминированный id (вид +
текст + час) превратил бы пробу в 10:05 в глушитель настоящего отказа в 10:40 — замер
владелицы belova, 2026-09-02. Поэтому id случайный на каждое событие, а проба ещё и
носит в нём и в виде события свою пометку.

Запуск:  echo "текст" | python3 litellm/go_notify.py [--drill]
Выход:   0 — приёмник принял; 1 — не принял или не дошли (go_refresher это напечатает).
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Callable, Final, Sequence

DEFAULT_RELAY_URL: Final = "https://relay.kiberos.ai/v1/events"
TOKEN_ENV: Final = "KIBCTL_RELAY_TOKEN_GO_REFRESHER"
PROTOCOL_VERSION: Final = 1
SOURCE: Final = "go-refresher"
KIND: Final = "go-refresher:failed"
OWNER: Final = "vibe-kiberos-app-owner"
SUBJECT_LIMIT: Final = 200
TIMEOUT_SECONDS: Final = 20

Post = Callable[[str, str, bytes], int]


def build_event(text: str, *, drill: bool, host: str, now: datetime, event_id: str) -> dict[str, object]:
    """Собирает событие relay. Первая строка текста — то, что человек увидит в списке."""
    lines: Final = [line for line in text.strip().splitlines() if line.strip()]
    headline: Final = lines[0] if lines else "go_refresher: продление пропуска OpenCode Go не удалось"
    prefix: Final = "ПРОБА — " if drill else ""
    return {
        "v": PROTOCOL_VERSION,
        "id": f"{'drill-' if drill else ''}{event_id}",
        "host": host,
        "app": "kiberos-app",
        "kind": f"{KIND}:drill" if drill else KIND,
        "source": SOURCE,
        "severity": "info" if drill else "warning",
        "subject": (prefix + headline)[:SUBJECT_LIMIT],
        "payload": {"owner": OWNER, "lines": lines[1:], "drill": drill},
        "ts": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def post_json(url: str, token: str, body: bytes) -> int:
    request: Final = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)


def send(text: str, *, drill: bool, url: str, token: str | None, post: Post = post_json) -> tuple[bool, str]:
    """Шлёт одно событие. Возвращает (принято ли, строку для журнала)."""
    if not token:
        return False, f"токен не задан: переменная {TOKEN_ENV} пуста (юнит берёт её из EnvironmentFile)"
    event: Final = build_event(
        text,
        drill=drill,
        host=socket.gethostname(),
        now=datetime.now(timezone.utc),
        event_id=str(uuid.uuid4()),
    )
    try:
        status = post(url, token, json.dumps(event, ensure_ascii=False).encode("utf-8"))
    except Exception as error:  # noqa: BLE001 — недоступность приёмника называем, а не роняем
        return False, f"relay недоступен: {error}"
    if 200 <= status < 300:
        return True, f"relay принял событие {event['id']} (код {status})"
    if status == 401:
        return False, "relay не пустил (401): токен отозван или не тот"
    return False, f"relay ответил {status} на событие {event['id']}"


def main(argv: Sequence[str] | None = None) -> int:
    parser: Final = argparse.ArgumentParser(prog="go_notify", description="Отказ продления OpenCode Go → relay kibctl.")
    parser.add_argument("--drill", action="store_true", help="пробное событие: свой вид и свой id, тише настоящего")
    parser.add_argument("--url", default=os.environ.get("KIBCTL_RELAY_URL", DEFAULT_RELAY_URL))
    arguments: Final = parser.parse_args(argv)

    accepted, line = send(
        sys.stdin.read(),
        drill=arguments.drill,
        url=arguments.url,
        token=os.environ.get(TOKEN_ENV),
    )
    print(f"[go_notify] {line}", file=sys.stdout if accepted else sys.stderr, flush=True)
    return 0 if accepted else 1


if __name__ == "__main__":
    sys.exit(main())
