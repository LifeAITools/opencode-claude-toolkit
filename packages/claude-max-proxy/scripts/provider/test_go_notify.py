"""Проверки go_notify — форма события и то, что проба не глушит настоящую тревогу.

Сеть подставлена: вместо relay — функция, которая запоминает тело и отвечает кодом.

Запуск: cd litellm && python3 -m pytest test_go_notify.py -q
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import go_notify as gn  # noqa: E402

NOW = datetime(2026, 10, 8, 3, 40, tzinfo=timezone.utc)
TEXT = "go_refresher: продление пропуска OpenCode Go не удалось\nОТКАЗ: сервер входа ответил 400\n"


def recorder(status: int) -> tuple[list[dict[str, object]], gn.Post]:
    seen: list[dict[str, object]] = []

    def post(url: str, token: str, body: bytes) -> int:
        seen.append({"url": url, "token": token, "event": json.loads(body)})
        return status

    return seen, post


def test_event_matches_the_relay_contract() -> None:
    event = gn.build_event(TEXT, drill=False, host="kiberos", now=NOW, event_id="abc")
    assert set(event) == {"v", "id", "host", "app", "kind", "source", "severity", "subject", "payload", "ts"}
    assert event["v"] == 1
    assert event["kind"] == "go-refresher:failed"
    assert event["severity"] == "warning"
    assert event["subject"] == "go_refresher: продление пропуска OpenCode Go не удалось"
    assert event["payload"] == {
        "owner": "vibe-kiberos-app-owner",
        "lines": ["ОТКАЗ: сервер входа ответил 400"],
        "drill": False,
    }
    assert event["ts"] == "2026-10-08T03:40:00Z"


def test_the_owner_routes_both_drill_and_alert_to_our_room() -> None:
    for drill in (True, False):
        event = gn.build_event(TEXT, drill=drill, host="kiberos", now=NOW, event_id="x")
        assert event["payload"]["owner"] == "vibe-kiberos-app-owner"  # type: ignore[index]


def test_a_drill_never_shares_an_id_or_kind_with_a_real_alert() -> None:
    drill = gn.build_event(TEXT, drill=True, host="kiberos", now=NOW, event_id="same")
    real = gn.build_event(TEXT, drill=False, host="kiberos", now=NOW, event_id="same")
    assert drill["id"] != real["id"]
    assert drill["kind"] != real["kind"]
    assert str(drill["subject"]).startswith("ПРОБА")


def test_every_send_mints_a_fresh_id() -> None:
    seen, post = recorder(202)
    gn.send(TEXT, drill=False, url="u", token="t", post=post)
    gn.send(TEXT, drill=False, url="u", token="t", post=post)
    first, second = (entry["event"] for entry in seen)
    assert first["id"] != second["id"]  # type: ignore[index]


def test_accepted_only_on_2xx() -> None:
    _, ok = recorder(202)
    _, refused = recorder(401)
    _, duplicate = recorder(409)
    assert gn.send(TEXT, drill=False, url="u", token="t", post=ok)[0] is True
    assert gn.send(TEXT, drill=False, url="u", token="t", post=refused) == (False, "relay не пустил (401): токен отозван или не тот")
    assert gn.send(TEXT, drill=False, url="u", token="t", post=duplicate)[0] is False


def test_a_missing_token_is_named_not_sent() -> None:
    seen, post = recorder(202)
    accepted, line = gn.send(TEXT, drill=False, url="u", token=None, post=post)
    assert accepted is False
    assert gn.TOKEN_ENV in line
    assert seen == []


def test_an_unreachable_relay_is_a_failure() -> None:
    def post(url: str, token: str, body: bytes) -> int:
        raise OSError("connection refused")

    accepted, line = gn.send(TEXT, drill=False, url="u", token="t", post=post)
    assert accepted is False
    assert "connection refused" in line
