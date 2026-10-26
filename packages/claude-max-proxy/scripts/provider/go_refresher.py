#!/usr/bin/env python3
"""Рабочая организация OpenCode Go у посредника: какая, чем ходит и сколько у неё осталось.

ЗАЧЕМ. У первой организации Go ключ API — он не кончается. У второй входят через
`opencode console login`, и это НЕ ключ: это пропуск консоли, который живёт около
тридцати суток. Если его не продлевать, в один день модели этой организации
перестанут отвечать, и снаружи это будет выглядеть не как «истёк пропуск», а как
«модель сломалась» — потому что посредник отдаст обычный отказ поставщика.

🔴 ПОСРЕДНИК ХОДИТ К GO ЧЕРЕЗ ОДНУ ОРГАНИЗАЦИЮ, И ПЕРЕКЛЮЧАЕТ ЕЁ ТОЛЬКО ЧЕЛОВЕК.
Решение фаундера 09.10.2026: автоматического перехода на другую организацию не
бывает — длинная сессия, молча переехавшая, переписывает весь свой кэш за чужой
счёт. Рабочая организация названа в реестре (`active:`), а её дверь, пропуск и
заголовки лежат в ОДНОЙ записи учётных данных посредника, на которую ссылаются
все модели Go. Упёрлась организация в предел — посредник отвечает отказом.

ЧТО ДЕЛАЕТ. Действия, и каждое можно позвать отдельно:

  status   — показывает по каждой организации: рабочая ли она, чем ходит, до
             какого числа годна и сколько квоты осталось по окнам поставщика.
             `--json` — то же одним документом для сборщиков квоты. Значений
             токенов не печатает НИКОГДА — только последние четыре знака и длину.
  use      — ЯВНО переключает посредника на другую организацию: переписывает
             запись у посредника, потом строку `active:` в реестре.
  refresh  — продлевает те пропуски, которым осталось меньше порога (по умолчанию
             семь суток; `--force` — продлить несмотря на срок), сохраняет НОВЫЙ
             refresh-токен; пропуск РАБОЧЕЙ организации кладёт посреднику.
  push     — заново отдаёт посреднику рабочую организацию (после подъёма на
             чистой базе).
  seed     — разовый перенос: берёт пропуск из базы самого opencode
             (`--from-opencode-db`) в наше хранилище состояния.

🔴 REFRESH-ТОКЕН МЕНЯЕТСЯ ПРИ КАЖДОМ ПРОДЛЕНИИ. Поставщик отдаёт новый и
обесценивает старый. Сохранить новый — не аккуратность, а условие работы: не
сохранил — следующее продление провалится, и пропуск умрёт в тишине. Поэтому
состояние пишется АТОМАРНО (временный файл рядом + rename) и только с правами 0600.

🔴 ПРОВАЛ ПРОДЛЕНИЯ ОБЯЗАН БЫТЬ ГРОМКИМ. Выход ненулевой, строка в журнале
начинается с «ОТКАЗ», и если задан `--notify-cmd`, та же строка уходит ему на
вход — отсюда оркестратор вешает оповещение в Telegram.

ГДЕ ЧТО ЛЕЖИТ (пути задаются, здесь — только значения по умолчанию):
  реестр организаций   litellm/go-orgs.yaml            (в репозитории, без секретов)
  состояние пропусков  litellm/.go-tokens.json         (0600, НЕ в репозитории)
  хранилище посредника  POST/PATCH http://127.0.0.1:4000/credentials

ЗАПУСК по расписанию — systemd-таймер пользователя, см. deploy/go-refresher.*.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Final, Iterable, Sequence

import yaml

REPO_ROOT: Final = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY: Final = REPO_ROOT / "litellm" / "go-orgs.yaml"
DEFAULT_STATE: Final = REPO_ROOT / "litellm" / ".go-tokens.json"
DEFAULT_ENV_FILE: Final = REPO_ROOT / "litellm" / ".env"
DEFAULT_PROXY_URL: Final = "http://127.0.0.1:4000"
DEFAULT_THRESHOLD_DAYS: Final = 7.0
DEFAULT_TIMEOUT_SECONDS: Final = 30.0
# Адреса новой организации-консоли: и вход (за продлением), и дверь к моделям. Значения
# совпадают с записями реестра, но нужны здесь, чтобы `onboard` завёл запись сам, а не
# требовал, чтобы её сперва вписал человек.
DEFAULT_ACCOUNT_URL: Final = "https://opencode.ai/console"
DEFAULT_GO_BASE_URL: Final = "https://opencode.ai/inference/go/openai/v1"
# Проба квоты — украшение отчёта, а не работа: ей дано вдвое меньше времени, чтобы
# молчащий поставщик не держал человека, пришедшего посмотреть сроки.
DEFAULT_PROBE_TIMEOUT_SECONDS: Final = 15.0

# База входов opencode — там лежит вход в организацию, который караулит сторож.
DEFAULT_ONBOARD_DB: Final = Path(os.environ.get("GO_ONBOARD_DB", "~/.local/share/opencode/opencode.db")).expanduser()
# Замок состояния: ОДИН на всех писателей, а не только на сторожа. `watch` и `refresh`
# пишут файл пропусков ЦЕЛИКОМ (read-modify-write), поэтому накладываться нельзя ни им
# друг с другом, ни двум проходам одного из них. Имя файла историческое — оно уже лежит
# на машине, где идёт таймер; переименование развело бы новый проход со старым.
DEFAULT_STATE_LOCK: Final = REPO_ROOT / "litellm" / ".go-onboard-watch.lock"
# Пересборка отчёта квоты после онбординга. Дверь чужая — её держит claude-max-proxy
# (`opencode-go-quota.ts`), — поэтому зовём её КАК ЕСТЬ, а не пересказываем её работу.
DEFAULT_QUOTA_REBUILD_CMD: Final = os.environ.get(
    "GO_QUOTA_REBUILD_CMD", "systemctl --user start claude-max-opencode-go-quota.service"
)

# Клиент, которым сам opencode просит продление у своего сервера входа. Взят из
# двоичного файла opencode (строка рядом с `/auth/device/token`, замер 08.10.2026).
# Это не секрет — это имя приложения; поставщик различает по нему своих клиентов.
CONSOLE_CLIENT_ID: Final = "opencode-cli"

# 🔴 ИМЯ, КОТОРЫМ МЫ НАЗЫВАЕМ СЕБЯ, ОБЯЗАТЕЛЬНО В КАЖДОМ ЗАПРОСЕ — БЕЗ НЕГО НАС
# НЕ ПУСКАЮТ ВОВСЕ. Замер 08.10.2026: сервер входа ответил на продление 403 и
# «Error 1010: browser_signature_banned — your user-agent has been banned by the
# site owner». Причина не в токене и не в адресе: python по умолчанию называет себя
# `Python-urllib/3.12`, и это имя у поставщика в запрете. Беда была бы отложенной и
# тихой — пропуск годен ещё тридцать суток, и первое НАСТОЯЩЕЕ продление провалилось
# бы через три недели, в ночь по таймеру, когда никто не смотрит. Поэтому имя задано
# здесь одной строкой для ВСЕХ запросов, а не только для вызовов моделей.
USER_AGENT: Final = os.environ.get("KIBEROS_AGENT_NAME", "kiberos-chat/1.0")

# Шлюз Go отказывает запросу без `x-opencode-session` («MissingSessionID», замер
# 09.10.2026) — имя сессии посредника одно на все его вызовы.
PROXY_SESSION: Final = "kiberos-litellm-subagents"

MS_PER_DAY: Final = 86_400_000.0


# ─────────────────────────── реестр и состояние ───────────────────────────


@dataclass(frozen=True)
class Org:
    """Одна организация Go — как она описана в реестре."""

    name: str
    workspace: str
    auth: str
    base_url: str
    priority: int
    # Почта владельца организации. Поле ЗАПИСИ, а не украшение: фаундер 21.10.2026 —
    # «организации должны писаться как email целиком», иначе в отчёте девять «Русланов»
    # подряд и непонятно, какая организация чья.
    email: str | None = None
    account_id: str | None = None
    account_url: str | None = None
    env: str | None = None
    # UID организации в SynqTask — часть ЗАПИСИ реестра, а не отдельный файл (решение 13.10).
    # Из него `scripts/build-go-org-uids.mjs` производит карту имя→uid для подвала агентов.
    synqtask_org_uid: str | None = None
    notes: str = ""

    @property
    def is_console(self) -> bool:
        return self.auth == "console"

    def provider_headers(self) -> dict[str, str]:
        """Заголовки, без которых поставщик не примет запрос этой организации.

        Пропуск консоли сам по себе организацию не называет: без `x-opencode-org-id`
        дверь отвечает 403 «Workspace selection is required», с чужой — «Workspace
        access denied» (замер 09.10.2026). Ключу API заголовок не нужен — он и есть
        организация.
        """
        headers: Final[dict[str, str]] = {
            "User-Agent": USER_AGENT,
            "x-opencode-session": PROXY_SESSION,
        }
        if self.is_console:
            headers["x-opencode-org-id"] = self.workspace
        return headers


@dataclass(frozen=True)
class Registry:
    """Реестр целиком: организации и та ОДНА, через которую сейчас ходит посредник."""

    orgs: Sequence[Org]
    active: str
    credential_name: str
    usage_url: str

    def find(self, name: str) -> Org:
        for org in self.orgs:
            if org.name == name:
                return org
        known: Final = ", ".join(org.name for org in self.orgs)
        raise ValueError(f"организации «{name}» в реестре нет (есть: {known})")

    @property
    def active_org(self) -> Org:
        return self.find(self.active)


@dataclass
class ConsoleToken:
    """Пропуск консоли одной организации — то, что живёт в файле состояния."""

    access_token: str
    refresh_token: str
    expiry_ms: int
    refreshed_at_ms: int | None = None
    pushed_at_ms: int | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expiry_ms": self.expiry_ms,
            "refreshed_at_ms": self.refreshed_at_ms,
            "pushed_at_ms": self.pushed_at_ms,
        }


@dataclass(frozen=True)
class Usage:
    """Остаток квоты организации: окна поставщика как есть, либо почему их нет."""

    windows: dict[str, dict[str, object]] = field(default_factory=dict)
    error: str | None = None

    @property
    def exhausted(self) -> list[str]:
        """Окна, в которые организация упёрлась: запрос через неё сейчас получит 429."""
        return [name for name, window in self.windows.items() if window.get("status") != "ok"]

    def describe(self) -> str:
        if self.error:
            return self.error
        parts: Final = [
            f"{name} {window.get('percent')}%{' — УПЁРЛАСЬ' if window.get('status') != 'ok' else ''}"
            f" (до {window.get('resetsAt')})"
            for name, window in self.windows.items()
        ]
        return "; ".join(parts) or "поставщик не назвал ни одного окна"


def load_registry(path: Path) -> Registry:
    raw: Final = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries: Final = raw.get("orgs") or []
    if not entries:
        raise ValueError(f"в реестре {path} нет ни одной организации (ключ orgs)")
    orgs: Final[list[Org]] = []
    for entry in entries:
        known = {field_name for field_name in Org.__dataclass_fields__}
        orgs.append(Org(**{key: value for key, value in entry.items() if key in known}))
    for org in orgs:
        if org.is_console and not org.account_url:
            raise ValueError(f"организация {org.name}: auth=console требует account_url")
    active: Final = raw.get("active")
    credential_name: Final = raw.get("credential_name")
    usage_url: Final = raw.get("usage_url")
    if not isinstance(usage_url, str) or not usage_url:
        raise ValueError(f"в реестре {path} не назван адрес остатка квоты (ключ usage_url)")
    if not isinstance(active, str) or not active:
        raise ValueError(f"в реестре {path} не названа рабочая организация (ключ active)")
    if not isinstance(credential_name, str) or not credential_name:
        raise ValueError(f"в реестре {path} не названа запись у посредника (ключ credential_name)")
    registry: Final = Registry(
        orgs=sorted(orgs, key=lambda item: item.priority),
        active=active,
        credential_name=credential_name,
        usage_url=usage_url,
    )
    registry.find(active)
    return registry


def set_active_in_file(path: Path, name: str) -> None:
    """Переписывает в реестре ОДНУ строку `active:` — комментарии вокруг остаются как были."""
    text: Final = path.read_text(encoding="utf-8")
    updated, count = re.subn(r"(?m)^active:[ \t]*\S+[ \t]*$", f"active: {name}", text)
    if count != 1:
        raise ValueError(f"в реестре {path} строка `active:` найдена {count} раз, ожидалась одна")
    path.write_text(updated, encoding="utf-8")


def _org_block_bounds(lines: Sequence[str], name: str) -> tuple[int, int] | None:
    """Границы записи организации в строках реестра: от `- name: <name>` до следующей записи.

    Запись реестра — это `  - name: X` вместе со следующими за ним полями; конец — строка
    следующей записи либо конец файла. Правим построчно именно поэтому: комментарии вокруг
    (зачем организация была, чем ходит) остаются нетронутыми, а они и есть причина, по
    которой реестр ведут руками, а не собирают из YAML заново.
    """
    start: int | None = None
    for index, line in enumerate(lines):
        if re.match(rf"^\s*- name:\s*{re.escape(name)}\s*$", line):
            start = index
            break
    if start is None:
        return None
    end: Final = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^\s*- name:\s*\S", lines[index]):
            return start, index
    return start, end


def forget_org_in_file(path: Path, name: str) -> bool:
    """Вычёркивает запись организации из реестра. Возвращает, была ли она там вовсе.

    Лишняя запись — не безобидный мусор: `onboard` считает по ней «уже заведено», сборщик
    квоты даёт по ней отказ, а карта имя→uid падает на пустом uid. Поэтому вычёркивание —
    отдельная дверь, а не правка руками мимо скрипта.
    """
    lines: Final = path.read_text(encoding="utf-8").splitlines(keepends=True)
    bounds: Final = _org_block_bounds(lines, name)
    if bounds is None:
        return False
    start, end = bounds
    while end > start and lines[end - 1].strip() == "":  # разделительную пустоту — тоже
        end -= 1
    path.write_text("".join(lines[:start] + lines[end:]), encoding="utf-8")
    return True


def set_uid_in_file(path: Path, name: str, uid: str) -> bool:
    """Вписывает `synqtask_org_uid` в запись организации, не пересобирая YAML.

    UID заводит SynqTask (дверь `org_upsert`), а реестр — наше ЗЕРКАЛО этого факта, значит
    должна быть дверь, чтобы зеркало обновить. Правка построчная: собрать YAML заново значило
    бы стереть комментарии. Возвращает False, если записи нет.
    """
    lines: Final = path.read_text(encoding="utf-8").splitlines(keepends=True)
    bounds: Final = _org_block_bounds(lines, name)
    if bounds is None:
        return False
    start, end = bounds
    for index in range(start + 1, end):
        if re.match(r"^\s+synqtask_org_uid:\s*\S*\s*$", lines[index]):
            indent: Final = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
            lines[index] = f"{indent}synqtask_org_uid: {uid}\n"
            break
    else:
        anchor: Final = start  # нет поля — встаём сразу после `workspace`, иначе после `- name`
        for index in range(start + 1, end):
            if re.match(r"^\s+workspace:\s", lines[index]):
                anchor = index
                break
        lines.insert(anchor + 1, f"    synqtask_org_uid: {uid}\n")
    path.write_text("".join(lines), encoding="utf-8")
    return True


def load_state(path: Path) -> dict[str, ConsoleToken]:
    if not path.exists():
        return {}
    raw: Final = json.loads(path.read_text(encoding="utf-8")) or {}
    return {
        name: ConsoleToken(
            access_token=str(entry["access_token"]),
            refresh_token=str(entry["refresh_token"]),
            expiry_ms=int(entry["expiry_ms"]),
            refreshed_at_ms=entry.get("refreshed_at_ms"),
            pushed_at_ms=entry.get("pushed_at_ms"),
        )
        for name, entry in (raw.get("orgs") or {}).items()
    }


def incoming_path_for(state_path: Path) -> Path:
    """Где лежат новые входы, которых ещё нет в основном хранилище."""
    return state_path.with_name(f"{state_path.stem}.incoming.json")


def effective_state(state_path: Path) -> dict[str, ConsoleToken]:
    """Состояние для ЧТЕНИЯ: основное хранилище плюс новые входы, которых в нём нет.

    🔴 ЗАЧЕМ. После переезда Go основное хранилище пишет чужая дверь, а сторож на машине
    кладёт новые входы в `incoming` (`GO_TOKENS_INCOMING=1`). Никто их не сливает — и
    организация, заведённая только что, невидима для `pick`/`status` и не получает квоту,
    пока человек не сольёт руками. Замер 2026-10-22 00:48Z: ровно так и вышло на
    `hello@kiberos.app`.
    Поэтому читаем ПРОЕКЦИЮ: свои записи главнее (их мог продлить владелец), `incoming`
    закрывает только пробелы. Писать сюда ничего не нужно — и нельзя: два писателя на
    один файл снова сошлись бы.
    """
    merged: Final = dict(load_state(state_path))
    for name, token in load_state(incoming_path_for(state_path)).items():
        merged.setdefault(name, token)
    return merged


def merge_incoming_into_state(state_path: Path, journal: Journal) -> list[str]:
    """Слить очередь новых входов в основное хранилище — ТЕМ ЖЕ писателем, что его пишет.

    🔴 ЗАЧЕМ (23.10). Вход в opencode кладётся в `.go-tokens.incoming.json`, а основное
    хранилище до слияния его не содержит. Дверь прокси очередь ТЕПЕРЬ ЧИТАЕТ (1.1.72),
    поэтому флот работает и без слияния — но файл висит вечно, и у любого, кто читает
    ТОЛЬКО хранилище, организация невидима. Слить вправе лишь писатель хранилища; сегодня
    это МЫ (продление на стороне прокси выключено), поэтому слияние делаем здесь.

    🔴 УСЛОВИЕ: слияние включается только пока писатель — мы. Если `GO_TOKEN_REFRESH_ENABLED`
    станет `true`, писателем станет прокси, и второй писатель здесь снова сойдётся с первым
    на одном файле (риск R8) — тогда слияние НЕ делается, и это не тишина: сказано в журнале.

    Побеждает запись с БОЛЬШИМ сроком: очередь могла пролежать, пока мы продлевали ту же
    организацию, и тогда её запись старее той, что уже в хранилище.
    """
    if os.environ.get("GO_TOKEN_REFRESH_ENABLED", "").strip().lower() == "true":
        return []
    incoming_path: Final = incoming_path_for(state_path)
    if not incoming_path.exists():
        return []
    try:
        incoming: Final = load_state(incoming_path)
    except Exception as error:  # noqa: BLE001 — битый файл не повод падать
        journal.fail(f"{incoming_path.name} не читается как состояние: {error}")
        return []
    if not incoming:
        try:
            incoming_path.unlink()
        except OSError:
            pass
        return []
    state: Final = load_state(state_path)
    merged: list[str] = []
    for name, token in incoming.items():
        own: Final = state.get(name)
        if own is None or token.expiry_ms > own.expiry_ms:
            state[name] = token
            merged.append(name)
    if merged:
        save_state(state_path, state)
    try:
        incoming_path.unlink()
    except OSError:
        pass
    journal.say(
        f"очередь входов слита: {len(merged)} из {len(incoming)} "
        f"({', '.join(merged) if merged else 'всё уже свежее'})"
    )
    return merged

def save_state(path: Path, state: dict[str, ConsoleToken]) -> None:
    """Пишет состояние атомарно и только для своего пользователя.

    Атомарно — потому что на этом файле держится возможность следующего продления:
    обрыв записи посередине оставил бы половину нового refresh-токена, то есть
    пропуск, который уже нельзя продлить ничем.
    """
    body: Final = json.dumps(
        {"orgs": {name: token.to_json() for name, token in state.items()}},
        ensure_ascii=False,
        indent=1,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Final = path.with_name(path.name + ".tmp")
    handle: Final = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def read_env_file(path: Path) -> dict[str, str]:
    """Достаёт значения из env-файла, не исполняя его.

    Нужен ровно за двумя строками — мастер-ключ посредника и ключ первой
    организации, — поэтому разбор нарочно примитивный: `ИМЯ=значение`, без
    подстановок и без кавычек-внутри-кавычек.
    """
    if not path.exists():
        return {}
    found: Final[dict[str, str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match and not line.lstrip().startswith("#"):
            found[match.group(1)] = match.group(2).strip('"').strip("'")
    return found


# ─────────────────────────── решения (без сети) ───────────────────────────


def days_left(expiry_ms: int, now_ms: int) -> float:
    return (expiry_ms - now_ms) / MS_PER_DAY


def needs_refresh(expiry_ms: int, now_ms: int, threshold_days: float, force: bool = False) -> bool:
    """Пора ли продлевать. Единственное место, где это решается."""
    if force:
        return True
    return days_left(expiry_ms, now_ms) < threshold_days


def apply_rotation(token: ConsoleToken, response: dict[str, object], now_ms: int) -> ConsoleToken:
    """Складывает ответ поставщика в новое состояние пропуска.

    🔴 refresh_token берётся из ответа ОБЯЗАТЕЛЬНО: поставщик выдаёт новый и гасит
    старый. Если в ответе его нет — это не «оставим прежний», это сломанный ответ,
    и притворяться, что всё хорошо, значит потерять организацию через месяц.
    """
    access: Final = response.get("access_token")
    refresh: Final = response.get("refresh_token")
    expires_in: Final = response.get("expires_in")
    if not isinstance(access, str) or not access:
        raise ValueError("в ответе на продление нет access_token")
    if not isinstance(refresh, str) or not refresh:
        raise ValueError("в ответе на продление нет refresh_token — продлевать дальше будет нечем")
    if not isinstance(expires_in, (int, float)) or expires_in <= 0:
        raise ValueError(f"в ответе на продление негодный expires_in: {expires_in!r}")
    return ConsoleToken(
        access_token=access,
        refresh_token=refresh,
        expiry_ms=now_ms + int(expires_in * 1000),
        refreshed_at_ms=now_ms,
        pushed_at_ms=token.pushed_at_ms,
    )


def tail(value: str | None, keep: int = 4) -> str:
    """Как показать секрет, не показав его."""
    if not value:
        return "—"
    return f"…{value[-keep:]} (длина {len(value)})"


def when(ms: int | None) -> str:
    if not ms:
        return "—"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ms / 1000))


# ─────────────────────────── границы с сетью ───────────────────────────


def http_json(
    url: str,
    body: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    method: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[int, dict[str, object] | str]:
    """Один HTTP-запрос с разбором JSON. Отказ поставщика — это ОТВЕТ, а не исключение.

    Возвращает (код, тело). 🔴 Код 0 означает, что ответа не было вовсе — обрыв связи
    или истёкшее ожидание. Это отдельный случай, и он нарочно не исключение: отчёт
    `status` обходит все организации, и первое же молчащее соединение не должно
    обрывать обход — замер 08.10.2026, проба к поставщику не ответила за 30 секунд и
    уронила весь отчёт вместе со второй организацией, о которой ещё не было сказано
    ни слова. Решение по коду 0 принимает ВЫЗЫВАЮЩИЙ: продление считает это провалом,
    проба квоты — просто неизвестностью.
    """
    data: Final = json.dumps(body).encode() if body is not None else None
    request: Final = urllib.request.Request(
        url,
        data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _as_json(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, _as_json(error.read().decode())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, f"связи нет: {error}"


def _as_json(text: str) -> dict[str, object] | str:
    try:
        parsed = json.loads(text)
    except ValueError:
        return text[:800]
    return parsed if isinstance(parsed, dict) else {"body": parsed}


RefreshCall = Callable[[str, str], dict[str, object]]
PushCall = Callable[[Org, str], None]
UsageCall = Callable[[Org, str | None], Usage]


def refresh_over_network(account_url: str, refresh_token: str) -> dict[str, object]:
    """Просит у сервера входа новый пропуск по refresh-токену."""
    status, body = http_json(
        f"{account_url.rstrip('/')}/auth/device/token",
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CONSOLE_CLIENT_ID,
        },
    )
    if status == 0:
        raise RuntimeError(f"сервер входа не ответил: {_safe(body)}")
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"сервер входа ответил {status}: {_safe(body)}")
    return body


def credential_values(org: Org, secret: str) -> dict[str, object]:
    """Всё, чем посредник ходит к организации, — одной записью.

    🔴 ОРГАНИЗАЦИЯ ЖИВЁТ В ЗАПИСИ, А НЕ В МОДЕЛЯХ. Записи моделей в config.yaml
    называют только имя записи; адрес двери, пропуск и заголовки организации
    посредник берёт отсюда (замер 09.10.2026: и chat/completions, и Responses
    отвечают 200 через запись без единого заголовка в самой модели). Поэтому
    переключение организации — это переписать ОДНУ запись, а не две модели.
    """
    return {
        "api_key": secret,
        "api_base": org.base_url,
        "extra_headers": org.provider_headers(),
    }


def push_to_proxy(proxy_url: str, master_key: str, credential_name: str, org: Org, secret: str) -> None:
    """Кладёт рабочую организацию в хранилище учётных данных посредника.

    Сначала правка существующей записи, и только если её нет — создание. Посредник
    держит запись и в базе, и в памяти, поэтому новое значение начинает действовать
    сразу, без перезапуска.
    """
    headers: Final = {"Authorization": f"Bearer {master_key}"}
    payload: Final[dict[str, object]] = {
        "credential_name": credential_name,
        "credential_info": {"source": "go_refresher", "org": org.name, "auth": org.auth},
        "credential_values": credential_values(org, secret),
    }
    status, body = http_json(
        f"{proxy_url.rstrip('/')}/credentials/{credential_name}",
        payload,
        headers=headers,
        method="PATCH",
    )
    if status == 200:
        return
    if status == 0:
        raise RuntimeError(f"посредник не ответил на {proxy_url}: {_safe(body)}")
    if status != 404:
        raise RuntimeError(f"правка учётной записи «{credential_name}» отклонена, {status}: {_safe(body)}")

    status, body = http_json(f"{proxy_url.rstrip('/')}/credentials", payload, headers=headers)
    if status not in (200, 201):
        raise RuntimeError(
            f"создание учётной записи «{credential_name}» "
            f"{'не дошло — посредник молчит' if status == 0 else f'отклонено, {status}'}: {_safe(body)}"
        )


def probe_usage(org: Org, secret: str | None, usage_url: str, timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS) -> Usage:
    """Сколько квоты у организации осталось — по двери остатка самого поставщика.

    Вызов модели здесь НЕ делается: дверь остатка отвечает числами по каждому окну
    (пять часов, неделя, месяц) и квоту не тратит. Замер 09.10.2026: она одна и та же
    для обеих организаций — ключ API первой и пропуск консоли второй (с заголовком
    организации) получают по 200 на `/inference/go/v1/usage`. Ожидание короткое: это
    строка отчёта, а не работа, и непрошедшая проба — «неизвестно», а не «сломано».
    """
    if not secret:
        return Usage(error="нет пропуска — проба не делалась")
    headers: Final = {**org.provider_headers(), "Authorization": f"Bearer {secret}"}
    status, body = http_json(usage_url, headers=headers, timeout=timeout)
    if status == 0:
        return Usage(error=f"неизвестно — поставщик не ответил за {timeout:g} с ({_safe(body, 120)})")
    windows: Final = body.get("usage") if isinstance(body, dict) else None
    if status != 200 or not isinstance(windows, dict):
        kind: Final = _error_type(body)
        return Usage(error=f"отказ {status}{f' / {kind}' if kind else ''}: {_safe(body, 160)}")
    return Usage(windows={name: window for name, window in windows.items() if isinstance(window, dict)})


def _error_type(body: dict[str, object] | str) -> str | None:
    if not isinstance(body, dict):
        return None
    error: Final = body.get("error")
    if isinstance(error, dict) and isinstance(error.get("type"), str):
        return str(error["type"])
    return str(body["type"]) if isinstance(body.get("type"), str) else None


def _safe(body: dict[str, object] | str, limit: int = 300) -> str:
    """Тело ответа для журнала — без того, что похоже на секрет."""
    text: Final = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    masked: Final = re.sub(r"(oc_[A-Za-z0-9_\-]{6,}|sk-[A-Za-z0-9_\-]{6,})", "…скрыто…", text)
    return masked[:limit]


# ─────────────────────────── перенос из базы opencode ───────────────────────────


def read_opencode_accounts(db_path: Path) -> list[dict[str, object]]:
    """Читает входы из базы opencode, НЕ меняя её (режим только для чтения)."""
    connection: Final = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows: Final = connection.execute(
            "select a.id, a.email, a.url, a.access_token, a.refresh_token, a.token_expiry, "
            "       (select active_org_id from account_state where active_account_id = a.id) "
            "from account a"
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "account_id": row[0],
            "email": row[1],
            "account_url": row[2],
            "access_token": row[3],
            "refresh_token": row[4],
            "expiry_ms": int(row[5]),
            "workspace": row[6],
        }
        for row in rows
    ]


@dataclass(frozen=True)
class ActiveDerivation:
    """Какая организация РАБОЧАЯ — по ЗАПИСИ О ВХОДЕ, а не по хранимому флагу.

    Решение фаундера 22.10.2026: «активная организация не имеет права храниться».
    Строка `active:` в реестре — РЕШЕНИЕ о маршруте (её пишет `use`, и переводит
    посредника только человек), а не измерение. Показывать её как «сейчас работаем
    через эту» нельзя: после входа человека в другую организацию строка остаётся
    прежней, и подвал объявляет стену там, где у человека ноль.

    Поэтому показ выводит организацию из `account_state` (кто входил последним и в
    какую организацию) в МОМЕНТ ЧТЕНИЯ. Расхождение с реестром — не повод выбрать
    «прежнюю»: значение тогда `неизвестно` (`org=None`), а обе стороны названы.
    """

    org: str | None
    source: str
    """`account_state` — выведено и сходится; `conflict` — запись и реестр разошлись;
    `unknown` — прочитать запись не удалось (нет строки, нет таблицы, нет файла)."""
    reason: str | None = None
    stored: str | None = None
    """Что объявляет строка `active:` реестра (маршрутное решение, не измерение)."""
    recorded: str | None = None
    """Что следует из записи о входе. Едет и при расхождении — иначе не с чем сверять."""


def read_active_pair(db_path: Path) -> tuple[str, str] | None:
    """(active_account_id, active_org_id) из `account_state`. None — прочитать не удалось.

    Только для чтения: база opencode принадлежит чужой двери, и писать в неё отсюда
    нельзя (`mode=ro`). Пустая строка или пустое поле — та же неизвестность, что и
    отсутствие файла: «не смогли прочитать», а НЕ «организаций нет».
    """
    try:
        connection: Final = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row: Final = connection.execute(
            "select active_account_id, active_org_id from account_state limit 1"
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        connection.close()
    if row is None:
        return None
    account_id, org_id = row[0], row[1]
    if not isinstance(account_id, str) or not isinstance(org_id, str):
        return None
    if not account_id.strip() or not org_id.strip():
        return None
    return account_id, org_id


def derive_active(
    orgs: Sequence[Org], stored: str | None, db_path: Path
) -> ActiveDerivation:
    """Вывести рабочую организацию из записи о входе и сверить с реестром.

    Пара из `account_state` — (учётка, организация). В реестре обе половины есть:
    `account_id` и `workspace`, поэтому сверяется ПАРА, а не одно имя. Организацию
    ищем по `workspace` = идентификатор организации из записи; `account_id` уточняет
    выбор, только если под тот же workspace подходят несколько записей (в старых
    записях реестра `account_id` бывает устаревшим — требовать его всегда нельзя).
    """
    pair: Final = read_active_pair(db_path)
    if pair is None:
        return ActiveDerivation(
            org=None,
            source="unknown",
            stored=stored,
            reason=f"запись о входе не прочитана ({db_path}) — рабочая организация неизвестна",
        )
    account_id, org_id = pair
    candidates: Final = [org for org in orgs if org.workspace == org_id]
    if len(candidates) > 1:
        candidates = [org for org in candidates if org.account_id == account_id]
    if len(candidates) != 1:
        return ActiveDerivation(
            org=None,
            source="unknown",
            stored=stored,
            reason=(
                f"в записи о входе пара {account_id} / {org_id}, "
                f"а однозначной записи в реестре под неё нет (подошло {len(candidates)})"
            ),
        )
    recorded: Final = candidates[0].name
    if stored != recorded:
        return ActiveDerivation(
            org=None,
            source="conflict",
            stored=stored,
            recorded=recorded,
            reason=(
                f"реестр объявляет «{stored}», запись о входе — «{recorded}»: "
                "расхождение, рабочая организация неизвестна"
            ),
        )
    return ActiveDerivation(org=recorded, source="account_state", stored=stored, recorded=recorded)


def match_account(accounts: Iterable[dict[str, object]], org: Org) -> dict[str, object] | None:
    """Какой вход из базы opencode относится к этой организации реестра."""
    for account in accounts:
        if org.account_id and account.get("account_id") == org.account_id:
            return account
    for account in accounts:
        if account.get("workspace") == org.workspace:
            return account
    return None


# ─────────────────────────── громкий отказ ───────────────────────────


# Истина выставляется разбором аргументов: `--json` означает, что stdout — только данные.
MACHINE_OUTPUT: bool = False


@dataclass
class Journal:
    """Журнал запуска: что сказано человеку и что считать провалом."""

    notify_cmd: str | None = None
    failures: list[str] = field(default_factory=list)

    def say(self, message: str) -> None:
        # 🔴 stdout ПРИНАДЛЕЖИТ ДАННЫМ, ЖУРНАЛ ИДЁТ В stderr. Замер 24.10.2026 (нашёл
        # vibe-claude-code-sdk-owner): `status --json` печатал русскую строку в тот же
        # поток, что и JSON, и сборщик отчёта получал «Unrecognized token 'о'» — отчёт
        # записывался БЕЗ массива orgs, 15 организаций превращались в ноль, и выбиратель
        # на пять минут становился слепым ровно в момент, когда ждали подхвата свежей.
        # Правило: при `--json` в stdout не попадает НИ ОДНОЙ человеческой строки.
        print(message, file=sys.stderr if MACHINE_OUTPUT else sys.stdout, flush=True)

    def fail(self, message: str) -> None:
        line: Final = f"ОТКАЗ: {message}"
        print(line, file=sys.stderr, flush=True)
        self.failures.append(line)

    def finish(self) -> int:
        if not self.failures:
            return 0
        if self.notify_cmd:
            body = "go_refresher: продление пропуска OpenCode Go не удалось\n" + "\n".join(self.failures)
            try:
                subprocess.run(
                    self.notify_cmd,
                    shell=True,
                    input=body,
                    text=True,
                    timeout=60,
                    check=False,
                )
            except Exception as error:  # noqa: BLE001 — оповещение не должно съесть сам отказ
                print(f"ОТКАЗ: оповещение не ушло: {error}", file=sys.stderr, flush=True)
        return 1


# ─────────────────────────── действия ───────────────────────────


@dataclass(frozen=True)
class Context:
    registry: Registry
    registry_path: Path
    state_path: Path
    state: dict[str, ConsoleToken]
    proxy_url: str
    master_key: str | None
    env_values: dict[str, str]
    threshold_days: float
    now_ms: int

    @property
    def orgs(self) -> Sequence[Org]:
        return self.registry.orgs

    def secret_of(self, org: Org) -> str | None:
        """Чем ходить к организации: пропуск консоли из состояния или ключ API из окружения."""
        if org.is_console:
            token = self.state.get(org.name)
            return token.access_token if token else None
        return os.environ.get(org.env or "") or self.env_values.get(org.env or "")


def command_status(context: Context, journal: Journal, usage_call: UsageCall | None) -> None:
    active: Final = context.registry.active
    journal.say(f"реестр: {len(context.orgs)} организаций, состояние: {context.state_path}")
    journal.say(f"посредник ходит через: {active} (запись «{context.registry.credential_name}»)")
    for org in context.orgs:
        journal.say("")
        journal.say(f"[{org.priority}] {org.name}  ({org.auth}){'  ← РАБОЧАЯ' if org.name == active else ''}")
        journal.say(f"    почта:           {org.email or '— не записана'}")
        journal.say(f"    рабочая область: {org.workspace}")
        journal.say(f"    дверь:           {org.base_url}")
        if org.is_console:
            token = context.state.get(org.name)
            if token is None:
                journal.fail(f"{org.name}: пропуска в состоянии нет — нужен `seed --from-opencode-db <путь>`")
            else:
                left = days_left(token.expiry_ms, context.now_ms)
                journal.say(f"    пропуск:         {tail(token.access_token)}")
                journal.say(f"    refresh:         {tail(token.refresh_token)}")
                journal.say(f"    годен до:        {when(token.expiry_ms)}  (осталось {left:.1f} сут)")
                journal.say(f"    продлён:         {when(token.refreshed_at_ms)}")
                journal.say(f"    отдан посреднику:{when(token.pushed_at_ms)}")
                if left < 0:
                    journal.fail(f"{org.name}: пропуск УЖЕ истёк {when(token.expiry_ms)}")
                elif needs_refresh(token.expiry_ms, context.now_ms, context.threshold_days):
                    journal.say(f"    🔴 пора продлевать (порог {context.threshold_days:g} сут)")
        else:
            secret = context.secret_of(org)
            journal.say(f"    ключ {org.env}:  {tail(secret)}")
            journal.say("    срока годности нет — продлевать нечего")
            if not secret:
                journal.fail(f"{org.name}: ключ {org.env} не найден ни в окружении, ни в env-файле")
        if usage_call is not None:
            journal.say(f"    остаток квоты:   {usage_call(org, context.secret_of(org)).describe()}")


def choose_org(context: Context, usage_call: UsageCall) -> tuple[Org, Usage] | None:
    """Организация со СВОБОДНОЙ квотой — куда пустить новую (пере)сессию.

    🔴 ЗАЧЕМ ОТДЕЛЬНО ОТ `use`. `use` переключает посредника руками и на живых сессиях
    запрещён без подтверждения: тихий переезд переписывает кэш за чужой счёт (решение
    09.10). Здесь другое: выбираем, КУДА ПУСТИТЬ НОВУЮ сессию. Живая при этом не
    переезжает — выбор делает тот, кто поднимает агента, ДО первого запроса.

    🔴 ПОРЯДОК СРАВНЕНИЯ — ПО САМОМУ КОРОТКОМУ ОКНУ, ЗАТЕМ ПО ДЛИННОМУ. Первым смотрится
    неделя: она кончается раньше месяца и именно ею упёрлась не одна организация. Месяц
    разрешает ничьи. Сортировать по сумме процентов нельзя: занятая на 90% неделя и
    пустой месяц — это «вот-вот кончится», а 0% недели и 90% месяца — «неделю проживёт».

    🔴 УПЁРШАЯСЯ ОРГАНИЗАЦИЯ НЕ ВЫБИРАЕТСЯ ВООБЩЕ. Не «выбирается с меньшим приоритетом»:
    запрос через неё получит 429 сразу, и пускать туда новую сессию — это заведомо
    сломанный старт. Если свободных нет вовсе — возвращаем `None`, и это честный ответ
    «пускать некуда», а не «возьмём хоть что-нибудь».
    """
    best: tuple[Org, Usage] | None = None
    best_key: tuple[int, int] | None = None
    for org in context.orgs:
        if org.is_console:
            token = context.state.get(org.name)
            if token is None or token.expiry_ms <= context.now_ms:
                continue
        usage = usage_call(org, context.secret_of(org))
        if usage.error is not None or usage.exhausted:
            continue
        weekly: Final = usage.windows.get("weekly") or {}
        monthly: Final = usage.windows.get("monthly") or {}
        key: Final = (int(weekly.get("percent") or 0), int(monthly.get("percent") or 0))
        if best_key is None or key < best_key:
            best_key = key
            best = (org, usage)
    return best


def append_org_to_file(
    path: Path,
    *,
    name: str,
    workspace: str,
    account_id: str,
    account_url: str,
    base_url: str,
    priority: int,
    date: str,
    email: str = "",
) -> None:
    """Дописывает запись организации в реестр, НЕ трогая комментарии и прежние записи.

    🔴 ПОЧЕМУ ДОПИСЫВАНИЕ, А НЕ ПЕРЕЗАПИСЬ. Реестр ведётся руками и несёт комментарии,
    объясняющие решения (почему организация есть, чем ходит, до какого числа). Разобрать
    YAML и собрать его заново значило бы стереть эти объяснения — и следующий читатель
    увидел бы список без причин. Ключ `orgs:` в файле последний, поэтому запись встаёт в
    конец списка, а не в середину.

    UID в SynqTask здесь НЕ ставится: он заводится дверью `org_upsert` и дописывается
    отдельным шагом, потому что заведение учётной записи в SynqTask — чужая дверь.
    """
    text: Final = path.read_text(encoding="utf-8")
    email_line: Final = f"    email: {email}\n" if email else ""
    block: Final = (
        f"\n  - name: {name}\n"
        f"{email_line}"
        f"    workspace: {workspace}\n"
        f"    auth: console\n"
        f"    account_id: {account_id}\n"
        f"    account_url: {account_url}\n"
        f"    base_url: {base_url}\n"
        f"    priority: {priority}\n"
        f"    notes: >-\n      Заведена `onboard` {date}.\n"
    )
    path.write_text(text.rstrip("\n") + "\n" + block, encoding="utf-8")


# ─────────────── реестр SynqTask: ensure организации (дверь владельца SynqTask) ───────────────
#
# 🔴 ЗАЧЕМ. Организация, найденная на стороне поставщика, — это ИМЯ. Привязать агента можно
# только по UID (`PATCH /api/members/:id/org` пишет `orgUid`), а карта имя→uid собирается из
# поля `synqtask_org_uid` ЭТОГО реестра. Пока uid некому завести, цепочка «нашли → привязали»
# рвётся: замер 20.10.2026 — `org-assign-refused reason=set_org rejected for luxeresit`, и
# агент рождался на мёртвой организации, хотя новая была единственной со свободной квотой.
#
# 🔴 ПОРЯДОК ШАГОВ НЕЛЬЗЯ ПЕРЕСТАВЛЯТЬ (он и есть весь смысл):
#   ensure{name} → uid → запись uid в `synqtask_org_uid` → пересборка карты → (лаунчер: set_org)
# Каждый пропущенный шаг даёт свой разрыв, и все три выглядят по-разному:
#   без ensure        — привязывать нечего, имя в дверь присвоения не годится;
#   без записи в реестр — организация в SynqTask есть, а карта шестиэлементная и привязка опять
#                        получает None — тот же разрыв, только на шаг позже и труднее для поиска;
#   без пересборки    — карта устарела, и `set_org` не узнает uid до следующего таймера.
DEFAULT_SYNQTASK_URL: Final = os.environ.get("SYNQTASK_URL", "http://127.0.0.1:3747")
# Модель организации при СОЗДАНИИ дверь требует обязательно и сама не выдумывает: это модель,
# на которой организация будет работать (как у остальных записей реестра).
DEFAULT_ORG_MAIN_MODEL: Final = os.environ.get("GO_ORG_MAIN_MODEL", "kiberos-go/deepseek-v4.1-flash-go")
DEFAULT_ORG_UIDS_CMD: Final = os.environ.get("GO_ORG_UIDS_CMD", "systemctl --user start go-org-uids.service")


def ensure_registry_uid(
    name: str,
    *,
    main_model: str,
    member_id: str,
    secret: str,
    base_url: str | None = None,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    http: Callable[..., tuple[int, dict[str, object] | str]] | None = None,
) -> tuple[str | None, str]:
    """GET-OR-CREATE организации в реестре SynqTask → (uid, причина отказа).

    Дверь идемпотентна: на существующем имени отвечает `created:false` и тем же uid, запись
    не трогает. Гейт — `system_admin` ИЛИ `org.assign`; у службы сторожа ВТОРОЕ и только оно.

    🔴 ОТКАЗ ПО ПРАВАМ ГОВОРИТСЯ ВСЛУХ (просьба владельца SynqTask). Если пропуск службы
    потерял грант, автоподхват перестаёт заводить организации, а снаружи это неотличимо от
    «новых входов нет»: сторож отработает зелёным и промолчит. Строка «ensure отказал по
    правам» ставит эту деградацию на вид в журнале, а не в чужом 403 через недели.
    """
    call: Final = http or http_json
    url: Final = f"{(base_url or DEFAULT_SYNQTASK_URL).rstrip('/')}/api/orgs/ensure"
    try:
        status, body = call(
            url,
            body={"name": name, "mainModel": main_model},
            headers={
                "Content-Type": "application/json",
                "X-Agent-Id": member_id,
                "X-Agent-Secret": secret,
            },
            method="POST",
            timeout=timeout,
        )
    except Exception as error:  # noqa: BLE001 — сторож не имеет права упасть на этой двери
        return None, f"ensure не смог обратиться к реестру SynqTask: {error}"
    if status in (401, 403):
        return None, f"ensure отказал по правам (HTTP {status}): {named_cause(status, body)}"
    if not 200 <= status < 300:
        return None, f"ensure не принят (HTTP {status}): {named_cause(status, body)}"
    uid: Final = str(body.get("uid") or "").strip() if isinstance(body, dict) else ""
    if not uid:
        return None, "ensure ответил без uid — привязывать нечего"
    return uid, "uid получен"


def write_registry_uid(path: Path, name: str, uid: str) -> bool:
    """Вписывает `synqtask_org_uid` в запись `name`, не трогая ни комментариев, ни соседей.

    🔴 ПОЧЕМУ ВСТАВКА, А НЕ ПЕРЕСБОРКА. Реестр ведётся руками и несёт объяснения решений;
    разобрать YAML и собрать заново — стереть их. Поэтому ищем блок записи и вставляем одну
    строку после `workspace:` (там её и ждёт `build-go-org-uids.mjs`). Уже вписанный uid не
    дублируем: повторный проход сторожа — норма, а не повод испортить файл.
    """
    text: Final = path.read_text(encoding="utf-8")
    lines: Final = text.splitlines(keepends=True)
    start: Final = None
    for index, line in enumerate(lines):
        if re.match(rf"^  - name:\s*{re.escape(name)}\s*$", line.rstrip("\n")):
            start = index
            break
    if start is None:
        return False
    end: Final = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^  - name:", lines[index]) or re.match(r"^[A-Za-z_]", lines[index]):
            end = index
            break
    block: Final = lines[start:end]
    if any("synqtask_org_uid:" in line for line in block):
        return False
    insert_at: Final = start + 1
    for offset, line in enumerate(block):
        if re.match(r"^    workspace:", line):
            insert_at = start + offset + 1
            break
    lines.insert(insert_at, f"    synqtask_org_uid: {uid}\n")
    path.write_text("".join(lines), encoding="utf-8")
    return True


def named_cause(status: int, body: dict[str, object] | str) -> str:
    """Причина отказа одной строкой, если поставщик её назвал.

    🔴 ОДНА СТРОКА, А НЕ ТЕЛО ОТВЕТА ЦЕЛИКОМ. Живой замер 16.10.2026: проба новой
    организации вернула 400 с телом про «requires Global regions» — то есть причина была
    не в пропуске и не в сети, а в тумблере Privacy в консоли, и починить её может только
    человек. Человеку нужна ЭТА причина, а не стена JSON: тело ответа он не читает.

    🔴 ТЕЛО ПРИХОДИТ РАЗНЫМ. `http_json` отдаёт разобранный JSON словарём, подставленная
    проба — строкой; приведение к строке здесь, а не у вызывающего: иначе разбор по образцу
    упал бы на словаре (`TypeError`), и настоящая причина отказа спряталась бы за поломкой
    показа. Найдено 17.10.2026 вместе с ошибкой вызова ниже.
    """
    text: Final = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    match: Final = re.search(r'"(?:message|error_description|detail)"\s*:\s*"([^"]{1,300})"', text)
    if match:
        return match.group(1)
    trimmed: Final = text.strip().replace("\n", " ")
    return trimmed[:200] if trimmed else f"HTTP {status} без объяснения"


def probe_door(
    org: Org,
    secret: str | None,
    *,
    model: str,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    fetch: Callable[[str, dict[str, str], bytes, float], tuple[int, str]] | None = None,
) -> tuple[bool, str]:
    """Живая проба: малый запрос через дверь организации. Отвечает (прошла, причина).

    🔴 ПРОБА ИДЁТ В ДВЕРЬ, А НЕ В НАШ ПОСРЕДНИК. Смысл пробы — проверить САМУ организацию:
    её пропуск, её тумблеры, её доступ к модели. Через посредник мы проверяли бы ещё и
    свою проводку, и красный ответ не сказал бы, чья сторона виновата.

    🔴 ЗДЕСЬ БЫЛА ПОЛОМКА, И ОНА СТОЯЛА ПОСЛЕ ПЕРЕЕЗДА. Первая редакция звала
    `http_json("POST", url, headers=…, body=…, timeout=…)`, а у той первым идёт `url`:
    метод уезжал в адрес, адрес — в тело, и вызов падал `TypeError: http_json() got
    multiple values for argument 'body'`. Проба — ПОСЛЕДНИЙ шаг `onboard`, то есть
    посредник уже переключён, а подтверждения нет: состояние меняется молча, и это
    худший вид поломки (замер home-general 17.10: шаг «переезд» прошёл, проба упала).
    Тело запроса отдаётся словарём — `http_json` сериализует его сам; в подставленную
    пробу по-прежнему уходят готовые байты, как она и ждёт.
    """
    url: Final = f"{org.base_url.rstrip('/')}/chat/completions"
    request_body: Final = {
        "model": model,
        "messages": [{"role": "user", "content": "1"}],
        "max_tokens": 1,
    }
    headers: Final = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {secret or ''}",
        **org.provider_headers(),
    }
    if fetch is not None:
        status, body = fetch(url, headers, json.dumps(request_body).encode("utf-8"), timeout)
    else:
        status, body = http_json(url, body=request_body, headers=headers, method="POST", timeout=timeout)
    if 200 <= status < 300:
        return True, "ответ получен"
    return False, f"HTTP {status}: {named_cause(status, body)}"


def org_display_name(email: object, account_id: object, taken: Iterable[str]) -> str:
    """Имя организации — ПОЛНОЕ ИМЯ УЧЁТКИ, а не одна левая часть адреса.

    🔴 СЛОВО ФАУНДЕРА 2026-10-21: «надо чтобы организация называлась по полному имени учётки».
    И это же — корень дефекта, стоившего ему двух перезапусков: реестр, карта имя→uid и имя
    пропуска в посреднике сопоставляются СТРОКОЙ, а сторож брал часть адреса до собачки. Две
    разные подписки (`hello@myfamily.quest` и `hello@kiberos.app`) сводились к одному `hello`,
    вторая молча выбрасывалась строкой «запись с таким именем уже в реестре» — и в пуле её не
    было. Замер 2026-10-21 21:40Z.
    Поэтому имя = адрес целиком; повтор того же адреса (два входа под одной учёткой) различаем
    номером входа, а вход без адреса называем его же account_id — но НЕ обрезаем адрес.
    """
    busy = set(taken)
    address = str(email or "").strip()
    if address and address not in busy:
        return address
    if not address:
        fallback = str(account_id or "").strip() or "org"
        if fallback not in busy:
            return fallback
        address = fallback
    suffix = 2
    candidate = f"{address}#{account_id}" if account_id else f"{address}#{suffix}"
    while candidate in busy:
        candidate = f"{address}#{account_id or ''}{suffix}"
        suffix += 1
    return candidate


def command_onboard(
    context: Context,
    journal: Journal,
    *,
    db_path: Path,
    model: str,
    probe_call: Callable[[Org, str | None], tuple[bool, str]],
    push: Callable[[Org, str], None],
    usage_call: UsageCall | None = None,
    switch_active: bool | Callable[[], bool] = True,
) -> int:
    """Онбординг новой организации ОДНИМ прогоном: вход → запись → пропуск → проба → переезд.

    Порядок шагов повторяет ручной прогон 16.10.2026, но ПРОБА СТОИТ ПЕРЕД ПЕРЕЕЗДОМ
    (замер 21.10.2026). Свежая рабочая область отвечала 400 «This Go model requires
    Global regions», проба падала — а посредник к тому моменту уже был переведён:
    состояние и запись расходились, и весь флот оставался на непроверенной организации.
    Теперь организация, которая не ответила, переезда не получает: рабочей остаётся
    прежняя, и журнал говорит правду. Непроверенная организация уже записана в реестре,
    поэтому дождётся следующего прогона или руки человека, а не тихо станет рабочей.

    🔴 ПЕРЕЕЗД ПОСРЕДНИКА — РЕШАЕМОЕ, А НЕ ОБЯЗАТЕЛЬНОЕ. Общий посредник ходит через ОДНУ
    организацию (её берут те, кто идёт без своего заголовка), и перевод переписывает им кэш.
    Поэтому `switch_active` можно задать не «да/нет», а ВОПРОСОМ (`Callable[[], bool]`): его
    спросят ровно тогда, когда новый вход уже найден, — чтобы проверка живости не стоила
    сетевого обращения на каждом пустом проходе. Ручной `onboard` переводит всегда (в этом
    его смысл), сторож — только когда прежняя организация мертва (см. `active_org_is_dead`).

    Возвращает число заведённых организаций: 0 — новых входов не было, и это не ошибка.
    """
    accounts: Final = read_opencode_accounts(db_path)
    journal.say(f"в базе {db_path} входов: {len(accounts)}")
    known: Final = {org.account_id for org in context.orgs if org.account_id}
    known |= {org.workspace for org in context.orgs}
    names: Final = {org.name for org in context.orgs}
    fresh: Final[list[tuple[dict[str, object], str]]] = []
    for account in accounts:
        workspace: Final = str(account.get("workspace") or "").strip()
        if account["account_id"] in known or account["workspace"] in known:
            continue
        # 🔴 БЕЗ РАБОЧЕЙ ОБЛАСТИ ЗАВОДИТЬ НЕЧЕГО. `active_org_id` в базе opencode есть только
        # у входа, который СЕЙЧАС АКТИВЕН; у прочих он пуст, и запись вышла бы с
        # `workspace: None` — ровно та, из-за которой 16.10 завёлся дубль `relishev`: он
        # числится организацией, но никуда не ходит (дверь отвечает 400). Лекарство одно —
        # войти в ту организацию, тогда она станет активной и её область появится.
        if not workspace or workspace == "None":
            # Адрес, а не короткое имя: по одному слову не видно, КАКОЙ вход пропущен.
            journal.say(
                f"{account.get('email') or account['account_id']}: вход без рабочей области — "
                f"заводить нечего, пропускаю"
            )
            continue
        # 🔴 ИМЯ — ПЕРВИЧНЫЙ КЛЮЧ ПОКАЗА, поэтому оно обязано быть УНИКАЛЬНЫМ: два входа с
        # одинаковой левой частью адреса сводились к одному имени и второй терялся.
        name: Final = org_display_name(account.get("email"), account["account_id"], names)
        names.add(name)
        fresh.append((account, name))
    if not fresh:
        journal.say("новых входов нет — заводить нечего")
        return 0
    priority: Final = max((org.priority for org in context.orgs), default=0) + 1
    today: Final = time.strftime("%Y-%m-%d", time.gmtime(context.now_ms / 1000))
    # Сколько uid вписали в реестр — от этого зависит, надо ли пересобирать карту имя→uid.
    uids_written: int = 0
    for account, name in fresh:
        append_org_to_file(
            context.registry_path,
            name=name,
            workspace=str(account["workspace"]),
            email=str(account.get("email") or ""),
            account_id=str(account["account_id"]),
            account_url=str(account.get("account_url") or DEFAULT_ACCOUNT_URL),
            base_url=str(account.get("base_url") or DEFAULT_GO_BASE_URL),
            priority=priority,
            date=today,
        )
        priority += 1
        journal.say(f"{name}: запись добавлена в {context.registry_path}")
        # 🔴 МОЛЧАНИЕ ЗДЕСЬ СТОИТ ДОРОГО. `synqtask_org_uid` заводит чужая дверь (`org_upsert`),
        # и до её ответа запись живёт БЕЗ uid. А карта имя→uid (`build-go-org-uids.mjs`) на
        # записи без uid ПАДАЕТ ЦЕЛИКОМ — то есть пропадает показ организации не у одной новой,
        # а у ВСЕХ сразу (13.10 решили падать громко именно за этим). Пока uid не вписан, об
        # этом надо говорить на каждом онбординге, иначе связь «завёл орг» → «сломался подвал»
        # не видна тому, кто читает журнал.
        # 🔴 UID ЗАВОДИТСЯ ЗДЕСЬ, А НЕ РУКАМИ. Порядок (ensure → uid → реестр → карта) записан
        # над `ensure_registry_uid`; переставлять нельзя. Пока uid не было, организация
        # заведена, а привязать её нечем — замер 20.10: `set_org rejected for luxeresit`.
        service_id: Final = os.environ.get("GO_ONBOARD_SERVICE_MEMBER_ID", "").strip()
        service_secret: Final = os.environ.get("GO_ONBOARD_SERVICE_SECRET", "").strip()
        if not (service_id and service_secret):
            journal.say(
                f"{name}: ⚠️ пропуск службы не задан (GO_ONBOARD_SERVICE_*) — uid в SynqTask не заведён; "
                f"карта имя→uid останется без этой организации, пока uid не впишут: `set-uid {name} <uid>`"
            )
        else:
            uid, cause = ensure_registry_uid(
                name,
                main_model=DEFAULT_ORG_MAIN_MODEL,
                member_id=service_id,
                secret=service_secret,
            )
            if uid is None:
                # Права — это деградация автоподхвата, и она обязана быть видна (просьба
                # владельца SynqTask): иначе сторож отработает зелёным и промолчит.
                if "по правам" in cause:
                    journal.fail(f"{name}: {cause}")
                else:
                    journal.say(f"{name}: {cause}")
            elif write_registry_uid(context.registry_path, name, uid):
                journal.say(f"{name}: uid SynqTask {uid} вписан в реестр")
                uids_written += 1
            else:
                journal.say(f"{name}: uid SynqTask {uid} уже в реестре — файл не тронут")
                uids_written += 1
    reloaded: Final = load_registry(context.registry_path)
    # 🔴 БЕЗ ЭТОГО ШАГА UID ЕСТЬ, А КАРТА СТАРАЯ. Лаунчер берёт uid из отчёта, отчёт — из
    # карты; вписанный в реестр uid сам в карту не попадёт, и привязка опять получила бы None
    # до следующего таймера (15 минут тишины на ровном месте). Зовём как есть, не пересказываем.
    if uids_written:
        try:
            subprocess.run(DEFAULT_ORG_UIDS_CMD, shell=True, check=False, timeout=DEFAULT_TIMEOUT_SECONDS)
            journal.say(f"карта имя→uid пересобрана ({uids_written} uid вписано)")
        except Exception as error:  # noqa: BLE001 — карта обновится своим таймером; это ускорение
            journal.say(f"карту имя→uid пересобрать не удалось ({error}) — обновится своим таймером")
    new_tokens: Final = {}
    for account, name in fresh:
        new_tokens[name] = ConsoleToken(
            access_token=str(account["access_token"]),
            refresh_token=str(account["refresh_token"]),
            expiry_ms=int(account["expiry_ms"]),
            refreshed_at_ms=None,
            pushed_at_ms=None,
        )
        journal.say(f"{name}: пропуск взят из базы opencode, годен до {when(int(account['expiry_ms']))}")

    # 🔴 ПОСЛЕ ПЕРЕЕЗДА ПРОПУСКА ПИШЕТ ЧУЖАЯ ДВЕРЬ, А НЕ МЫ. Сторож остаётся хозяином
    # discovery (новый вход ловится только на машине), но основное хранилище не трогает:
    # кладёт новые входы в ОТДЕЛЬНЫЙ incoming, который сливает тот, кому принадлежит запись.
    # Иначе два писателя на один файл снова сойдутся — тихо и с валидным JSON.
    if os.environ.get("GO_TOKENS_INCOMING", "").strip() == "1":
        incoming_path: Final = incoming_path_for(context.state_path)
        incoming: Final = load_state(incoming_path) if incoming_path.exists() else {}
        incoming.update(new_tokens)
        save_state(incoming_path, incoming)
        journal.say(
            f"{len(new_tokens)} новых входов положено в {incoming_path.name}; "
            f"{context.state_path.name} не тронут — его пишет владелец продления"
        )
        # Проба и переключение идут по СОСТАВНОМУ в памяти: пропуск только что взят из базы,
        # и без него новая организация не пробуется вовсе (а файл при этом не трогаем).
        refreshed: Final = replace(
            context, registry=reloaded, state={**context.state, **new_tokens}
        )
    else:
        state: Final = dict(context.state)
        state.update(new_tokens)
        save_state(context.state_path, state)
        refreshed = replace(context, registry=reloaded, state=load_state(context.state_path))
    try:
        active_name: Final = refreshed.registry.active
    except Exception:  # noqa: BLE001 — рабочей организации может не быть вовсе
        active_name = "нет рабочей"
    for account, name in fresh:
        org: Final = reloaded.find(name)
        token: Final = refreshed.state.get(org.name)
        if token is None:
            continue
        ok, cause = probe_call(org, token.access_token)
        if not ok:
            journal.fail(
                f"{org.name}: проба НЕ прошла — {cause}; посредник НЕ переведён "
                f"(рабочей осталась {active_name})"
            )
            continue
        journal.say(f"{org.name}: проба прошла — организация готова")
        allowed: Final = switch_active() if callable(switch_active) else switch_active
        if allowed:
            command_use(
                refreshed,
                journal,
                org.name,
                False,
                usage_call or (lambda o, s: probe_usage(o, s, reloaded.usage_url)),
                push,
            )
        else:
            journal.say(
                f"{org.name}: посредник НЕ переведён — организация заведена, а выбор остаётся "
                f"рождению агента (перевести вручную: `use {org.name}`)"
            )
    return len(fresh)


def active_org_is_dead(context: Context, usage_call: UsageCall) -> bool:
    """Упёрлась ли ТЕКУЩАЯ рабочая организация — вопрос, от которого зависит переезд сторожа.

    🔴 ПОЧЕМУ ПЕРЕЕЗД — НЕ АВТОМАТ. Общий посредник ходит через одну организацию; перевод
    переписывает кэш всякому, кто идёт без своего заголовка, а фаундер 17.10 сказал прямо:
    живую сессию не переводим, выбор — один раз при рождении. Поэтому сторож переводит
    посредника ТОЛЬКО когда прежняя организация мертва (её не жалко, и это и был ручной
    сценарий 16.10), а в остальных случаях лишь заводит новую и оставляет выбор рождениям.
    Неизвестность (проба не ответила) — тоже НЕ «мертва»: переезд не оправдан.
    """
    try:
        active: Final = context.registry.active_org  # свойство: бросает ValueError, если рабочей нет
    except Exception:  # noqa: BLE001 — нет рабочей организации — не повод городить переезд
        return False
    usage: Final = usage_call(active, context.secret_of(active))
    return usage.error is None and bool(usage.exhausted)


def command_watch(
    context: Context,
    journal: Journal,
    *,
    db_path: Path,
    model: str,
    probe_call: Callable[[Org, str | None], tuple[bool, str]],
    push: PushCall,
    usage_call: UsageCall,
    rebuild: Callable[[], None] | None,
) -> None:
    """Один проход сторожа: вход в базу opencode → организация в строю БЕЗ руки человека.

    🔴 ЗАЧЕМ. 17.10 фаундер вошёл в новую организацию, а флот её не видел до ручного
    `onboard`: все прежние организации упёрлись, посредник отвечал 400, агенты не работали.
    Его слово: «почему организация не подхватывается автоматически?». Проход сторожа делает
    ровно то, что делал человек, — и ровно тем же кодом (`command_onboard`), чтобы путь был
    ОДИН: заводит запись, кладёт пропуск, пробует дверь, и только если она ответила —
    переводит посредника на живую, и просит пересобрать отчёт квоты, чтобы новая
    организация сразу стала видна тому, кто выбирает её на рождении агента.

    Проход отвечает на ОДИН вопрос — «есть ли новый вход» — и не ждёт: его зовёт таймер.
    """
    added: Final = command_onboard(
        context,
        journal,
        db_path=db_path,
        model=model,
        probe_call=probe_call,
        push=push,
        usage_call=usage_call,
        # Переезд общего посредника — только когда прежняя организация мертва: иначе новая
        # заводится «в запас», а выбор остаётся рождению агента (слово фаундера 17.10).
        switch_active=lambda: active_org_is_dead(context, usage_call),
    )
    if not added:
        journal.say("новых входов нет — пересборка отчёта не нужна")
        return
    journal.say(f"заведено новых организаций: {added}")
    if rebuild is None:
        journal.say("пересборка отчёта квоты не задана — он обновится своим таймером")
        return
    try:
        rebuild()
        journal.say("отчёт квоты пересобран")
    except Exception as error:  # noqa: BLE001 — отчёт обновится и сам; это ускорение, а не условие
        journal.say(f"отчёт квоты пересобрать не удалось ({error}) — он обновится своим таймером")



def fresh_context(context: "Context") -> "Context":
    """Перечитать реестр и состояние ПОД ЗАМКОМ.

    🔴 СНИМОК, ВЗЯТЫЙ ДО ЗАМКА, — ТА ЖЕ ПОТЕРЯ ЗАПИСИ. Оба прохода пишут файл состояния
    ЦЕЛИКОМ (`save_state`), а состояние читается при сборке контекста, то есть ДО того, как
    взят замок. Проход, прождавший замок, писал бы свой устаревший снимок поверх чужого
    продления — молча: файл валиден, JSON цел, а пропуск уже мёртв.
    """
    return replace(
        context,
        registry=load_registry(context.registry_path),
        state=load_state(context.state_path),
        now_ms=int(time.time() * 1000),
    )


def with_lock(path: Path, body: Callable[[], int]) -> int:
    """Один проход сторожа в один момент: замок взяли — идём, не взяли — этот пропущен.

    Таймер может позвать сторож, пока предыдущий проход ещё переводит посредника и пробует
    дверь. Второй проход в это время не нужен и вреден — он читал бы состояние на середине.
    Не взятый замок — не отказ: следующий тик догонит, и журнал это скажет.
    """
    import fcntl  # noqa: PLC0415 — POSIX-замок нужен только на этом пути

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("проход сторожа уже идёт — этот пропущен", file=sys.stderr, flush=True)
            return 0
        return body()


def command_pick(context: Context, journal: Journal, usage_call: UsageCall, as_json: bool) -> None:
    """Печатает организацию, через которую пускать новую сессию. Ничего не переключает."""
    chosen: Final = choose_org(context, usage_call)
    if chosen is None:
        journal.fail("свободной организации нет: все упёрлись в предел или пропуск истёк")
        return
    org, usage = chosen
    if as_json:
        print(
            json.dumps(
                {
                    "org": org.name,
                    "workspace": org.workspace,
                    "synqtask_org_uid": org.synqtask_org_uid,
                    "active": org.name == context.registry.active,
                    "usage": usage.windows,
                },
                ensure_ascii=False,
                indent=1,
            )
        )
        return
    journal.say(f"пускать через: {org.name} ({org.workspace})")
    journal.say(f"    остаток: {usage.describe()}")
    if org.synqtask_org_uid:
        journal.say(f"    uid в SynqTask: {org.synqtask_org_uid}")


def status_document(context: Context, usage_call: UsageCall | None) -> dict[str, object]:
    """Тот же отчёт для машины: кто РАБОЧИЙ и сколько у каждого осталось.

    Это дверь для сборщиков квоты: они читают ОДИН документ и не лезут ни в файл
    пропусков, ни в реестр. Значений секретов в нём нет вовсе.

    🔴 UID SynqTask ЕДЕТ В ДОКУМЕНТЕ. Организацию в реестре и отчёте называют ИМЕНЕМ, а
    у члена организации личность — uid; показ и подвал склеивают одно с другим, и без uid
    в отчёте склейка остаётся на догадке (замер 17.10: карту имя→uid приходилось собирать
    отдельным файлом). Поэтому uid едет здесь, вместе с остальным.
    """
    orgs: Final[list[dict[str, object]]] = []
    for org in context.orgs:
        token = context.state.get(org.name) if org.is_console else None
        usage = usage_call(org, context.secret_of(org)) if usage_call is not None else None
        orgs.append(
            {
                "name": org.name,
                "email": org.email,
                "workspace": org.workspace,
                "synqtask_org_uid": org.synqtask_org_uid,
                "auth": org.auth,
                "active": org.name == context.registry.active,
                "expires_at_ms": token.expiry_ms if token else None,
                "usage": usage.windows if usage else None,
                "usage_error": usage.error if usage else None,
                "exhausted": usage.exhausted if usage else None,
            }
        )
    return {
        "active": context.registry.active,
        "credential_name": context.registry.credential_name,
        "measured_at_ms": context.now_ms,
        "orgs": orgs,
    }


def command_refresh(
    context: Context,
    journal: Journal,
    force: bool,
    refresh_call: RefreshCall,
    push_call: PushCall,
) -> dict[str, ConsoleToken]:
    """Продлевает пропуски, которым пора, и отдаёт посреднику ТОЛЬКО рабочую организацию.

    Пропуск нерабочей организации продлевается тоже — иначе к моменту, когда на неё
    переключатся, он окажется мёртвым, — но посреднику не отдаётся: туда идёт одна
    организация, та, что названа в реестре.
    """
    state: Final = dict(context.state)
    touched = False
    for org in context.orgs:
        if not org.is_console:
            journal.say(f"{org.name}: ключ API, продление не требуется")
            continue
        token = state.get(org.name)
        if token is None:
            journal.fail(f"{org.name}: пропуска в состоянии нет — нужен `seed --from-opencode-db <путь>`")
            continue
        left = days_left(token.expiry_ms, context.now_ms)
        if not needs_refresh(token.expiry_ms, context.now_ms, context.threshold_days, force):
            journal.say(f"{org.name}: годен ещё {left:.1f} сут (порог {context.threshold_days:g}) — не трогаем")
            continue
        journal.say(f"{org.name}: продлеваем (осталось {left:.1f} сут{', принудительно' if force else ''})")
        try:
            response = refresh_call(org.account_url or "", token.refresh_token)
            renewed = apply_rotation(token, response, context.now_ms)
        except Exception as error:  # noqa: BLE001 — любой провал продления громкий и поимённый
            journal.fail(f"{org.name}: продлить не удалось: {error}")
            continue
        state[org.name] = renewed
        touched = True
        save_state(context.state_path, state)
        journal.say(
            f"{org.name}: продлён до {when(renewed.expiry_ms)}, пропуск {tail(renewed.access_token)}, "
            f"refresh {tail(renewed.refresh_token)} — сохранено"
        )
        if org.name != context.registry.active:
            journal.say(f"{org.name}: не рабочая — посреднику не отдаётся")
            continue
        try:
            push_call(org, renewed.access_token)
        except Exception as error:  # noqa: BLE001
            journal.fail(f"{org.name}: пропуск продлён, но посреднику НЕ отдан: {error}")
            continue
        state[org.name] = replace(renewed, pushed_at_ms=context.now_ms)
        save_state(context.state_path, state)
        journal.say(f"{org.name}: отдан посреднику в запись «{context.registry.credential_name}»")
    if not touched:
        journal.say("продлевать было нечего")
    return state


def command_push(context: Context, journal: Journal, push_call: PushCall) -> None:
    """Отдать посреднику рабочую организацию — то, что уже лежит в состоянии и окружении.

    Нужно после подъёма посредника на чистой базе и после смены рабочей организации.
    """
    org: Final = context.registry.active_org
    secret: Final = context.secret_of(org)
    if not secret:
        journal.fail(f"{org.name}: {'пропуска в состоянии' if org.is_console else f'ключа {org.env}'} нет — нечего отдавать")
        return
    try:
        push_call(org, secret)
    except Exception as error:  # noqa: BLE001
        journal.fail(f"{org.name}: посреднику не отдан: {error}")
        return
    if org.is_console:
        context.state[org.name] = replace(context.state[org.name], pushed_at_ms=context.now_ms)
        save_state(context.state_path, context.state)
    journal.say(f"{org.name}: отдан посреднику в запись «{context.registry.credential_name}», {tail(secret)}")


def command_use(
    context: Context,
    journal: Journal,
    name: str,
    confirm_exhausted: bool,
    usage_call: UsageCall,
    push_call: PushCall,
) -> None:
    """ЯВНОЕ переключение посредника на другую организацию — единственный путь к нему.

    🔴 АВТОМАТИЧЕСКОГО ПЕРЕХОДА НЕТ, И ЭТО РЕШЕНИЕ ФАУНДЕРА (09.10.2026): длинная
    сессия, молча переехавшая на другую организацию, переписывает весь свой кэш за
    чужой счёт, и её владелец об этом даже не узнаёт. Поэтому исчерпанная
    организация отвечает отказом, а переезд делает человек этой командой.

    Переключиться на организацию, которая сама упёрлась в предел, бессмысленно —
    такой переезд отказывается без `--confirm-exhausted`. Порядок: сперва запись у
    посредника, потом строка в реестре — если посредник не принял, реестр не врёт.
    """
    try:
        org: Final = context.registry.find(name)
    except ValueError as error:
        journal.fail(str(error))
        return
    secret: Final = context.secret_of(org)
    if not secret:
        journal.fail(f"{org.name}: {'пропуска в состоянии' if org.is_console else f'ключа {org.env}'} нет — переключаться не на что")
        return
    usage: Final = usage_call(org, secret)
    journal.say(f"{org.name}: остаток квоты — {usage.describe()}")
    if usage.exhausted and not confirm_exhausted:
        journal.fail(
            f"{org.name} сама упёрлась в {', '.join(usage.exhausted)} — переключение отменено; "
            "если это осознанно, повтори с --confirm-exhausted"
        )
        return
    try:
        push_call(org, secret)
    except Exception as error:  # noqa: BLE001
        journal.fail(f"{org.name}: посредник не принял, рабочей осталась {context.registry.active}: {error}")
        return
    set_active_in_file(context.registry_path, org.name)
    if org.is_console:
        context.state[org.name] = replace(context.state[org.name], pushed_at_ms=context.now_ms)
        save_state(context.state_path, context.state)
    journal.say(
        f"посредник теперь ходит через {org.name} (было: {context.registry.active}); "
        "длинные сессии на моделях Go перепишут кэш один раз"
    )


def command_seed(context: Context, journal: Journal, db_path: Path) -> None:
    accounts: Final = read_opencode_accounts(db_path)
    journal.say(f"в базе {db_path} входов: {len(accounts)}")
    state: Final = dict(context.state)
    for org in context.orgs:
        if not org.is_console:
            continue
        account = match_account(accounts, org)
        if account is None:
            journal.fail(f"{org.name}: в базе opencode нет входа ни по account_id, ни по рабочей области")
            continue
        state[org.name] = ConsoleToken(
            access_token=str(account["access_token"]),
            refresh_token=str(account["refresh_token"]),
            expiry_ms=int(account["expiry_ms"]),
            refreshed_at_ms=None,
            pushed_at_ms=None,
        )
        journal.say(
            f"{org.name}: взят вход {account['email']} ({account['account_id']}), "
            f"годен до {when(int(account['expiry_ms']))}, пропуск {tail(str(account['access_token']))}"
        )
    save_state(context.state_path, state)
    journal.say(f"состояние записано: {context.state_path} (права 0600)")


def command_forget(context: Context, journal: Journal, name: str) -> None:
    """Вычёркивает лишнюю запись организации: нет записи в реестре — нет и её пропуска.

    🔴 РАБОЧУЮ НЕ ТРОГАЕМ. Пока организация названа в `active`, её вычёркивание оставило бы
    посредника с записью, на которую ссылаются все модели Go, и без организации в реестре:
    сперва `use` на другую, потом вычёркивание.
    """
    if context.registry.active == name:
        journal.fail(f"«{name}» — рабочая организация; сперва переключись (`use`), потом вычёркивай")
        return
    if not forget_org_in_file(context.registry_path, name):
        journal.fail(f"«{name}» в реестре {context.registry_path} нет")
        return
    state: Final = load_state(context.state_path)
    if name in state:
        del state[name]
        save_state(context.state_path, state)
        journal.say(f"{name}: пропуск убран из состояния")
    journal.say(f"{name}: запись вычеркнута из реестра")
    try:
        load_registry(context.registry_path)
    except Exception as error:  # noqa: BLE001 — сломанный реестр обязан быть громким, а не тихим
        journal.fail(f"после вычёркивания реестр не читается: {error}")


def command_set_uid(context: Context, journal: Journal, name: str, uid: str) -> None:
    """Вписывает uid SynqTask в запись организации: uid заводит SynqTask, реестр — зеркало."""
    if not set_uid_in_file(context.registry_path, name, uid):
        journal.fail(f"«{name}» в реестре {context.registry_path} нет")
        return
    try:
        load_registry(context.registry_path)
    except Exception as error:  # noqa: BLE001 — битый YAML обязан быть громким
        journal.fail(f"после вписи uid реестр не читается: {error}")
        return
    journal.say(f"{name}: uid {uid} вписан в реестр")


# ─────────────────────────── запуск ───────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser: Final = argparse.ArgumentParser(
        prog="go_refresher",
        description="Реестр организаций OpenCode Go: рабочая организация посредника, продление пропуска, остаток квоты.",
    )
    parser.add_argument("--registry", type=Path, default=Path(os.environ.get("GO_REGISTRY", DEFAULT_REGISTRY)))
    parser.add_argument("--state", type=Path, default=Path(os.environ.get("GO_STATE", DEFAULT_STATE)))
    parser.add_argument("--env-file", type=Path, default=Path(os.environ.get("GO_ENV_FILE", DEFAULT_ENV_FILE)))
    parser.add_argument("--proxy-url", default=os.environ.get("LITELLM_PROXY_URL", DEFAULT_PROXY_URL))
    parser.add_argument(
        "--threshold-days",
        type=float,
        default=float(os.environ.get("GO_REFRESH_THRESHOLD_DAYS", DEFAULT_THRESHOLD_DAYS)),
        help="продлевать, когда осталось меньше этого числа суток (по умолчанию 7)",
    )
    parser.add_argument("--notify-cmd", default=os.environ.get("GO_NOTIFY_CMD"), help="команда оболочки; текст отказа приходит ей на вход")
    subparsers: Final = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="рабочая организация, сроки пропусков и остаток квоты")
    status.add_argument("--no-probe", action="store_true", help="не спрашивать остаток у поставщика")
    status.add_argument("--json", action="store_true", help="один JSON-документ для сборщиков квоты, без секретов")

    refresh = subparsers.add_parser("refresh", help="продлить пропуски, которым пора; рабочую — отдать посреднику")
    refresh.add_argument("--force", action="store_true", help="продлить, не глядя на срок")
    refresh.add_argument("--dry-run", action="store_true", help="только сказать, что сделал бы")
    # 🔴 ТОТ ЖЕ ЗАМОК, ЧТО У СТОРОЖА. Без этого объявления `refresh` падал на `arguments.lock`
    # (`AttributeError: 'Namespace' object has no attribute 'lock'`) — то есть продление по
    # таймеру не работало вовсе, а падало уже ПОСЛЕ того, как тесты на `command_refresh`
    # проходили: они зовут функцию, а не разбор командной строки. Замер 2026-10-22 00:48Z.
    refresh.add_argument("--lock", type=Path, default=DEFAULT_STATE_LOCK)

    subparsers.add_parser("push", help="отдать посреднику рабочую организацию заново")

    use = subparsers.add_parser("use", help="ЯВНО переключить посредника на другую организацию")
    use.add_argument("org", help="имя организации из реестра")
    use.add_argument(
        "--confirm-exhausted",
        action="store_true",
        help="переключиться, даже если эта организация сама упёрлась в предел",
    )

    seed = subparsers.add_parser("seed", help="разовый перенос пропуска из базы opencode")
    seed.add_argument("--from-opencode-db", type=Path, required=True)

    forget = subparsers.add_parser("forget", help="вычеркнуть лишнюю запись организации из реестра и состояния")
    forget.add_argument("org", help="имя организации из реестра")

    set_uid = subparsers.add_parser("set-uid", help="вписать uid SynqTask в запись организации")
    set_uid.add_argument("org", help="имя организации из реестра")
    set_uid.add_argument("uid", help="uid организации в SynqTask (заводит его SynqTask)")

    watch = subparsers.add_parser(
        "watch", help="сторож: новый вход в базе opencode → организация заводится сама"
    )
    watch.add_argument("--from-opencode-db", type=Path, default=DEFAULT_ONBOARD_DB)
    watch.add_argument("--model", default=os.environ.get("GO_PROBE_MODEL", "deepseek-v4.1-flash"))
    watch.add_argument(
        "--rebuild-cmd",
        default=DEFAULT_QUOTA_REBUILD_CMD,
        help="чем пересобрать отчёт квоты после онбординга (пусто — не пересобирать вовсе)",
    )
    watch.add_argument("--lock", type=Path, default=DEFAULT_STATE_LOCK)

    pick = subparsers.add_parser(
        "pick", help="организация со свободной квотой — куда пустить новую (пере)сессию"
    )
    pick.add_argument("--json", action="store_true", help="один JSON-документ для пускателя")

    onboard = subparsers.add_parser(
        "onboard", help="завести новую организацию одним прогоном: запись, пропуск, переезд, живая проба"
    )
    onboard.add_argument("--from-opencode-db", type=Path, required=True)
    onboard.add_argument(
        "--model",
        default=os.environ.get("GO_PROBE_MODEL", "deepseek-v4.1-flash"),
        help="малая модель группы для живой пробы (по умолчанию deepseek-v4.1-flash)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments: Final = build_parser().parse_args(argv)
    journal: Final = Journal(notify_cmd=arguments.notify_cmd)
    env_values: Final = read_env_file(arguments.env_file)
    master_key: Final = os.environ.get("LITELLM_MASTER_KEY") or env_values.get("LITELLM_MASTER_KEY")

    try:
        registry = load_registry(arguments.registry)
    except Exception as error:  # noqa: BLE001 — без реестра делать нечего, и это тоже громко
        journal.fail(f"реестр {arguments.registry} не прочитан: {error}")
        return journal.finish()

    # Очередь новых входов сливается ДО чтения состояния: иначе организация, заведённая
    # на этой машине, до слияния невидима тому, кто читает только хранилище.
    merge_incoming_into_state(arguments.state, journal)

    context: Final = Context(
        registry=registry,
        registry_path=arguments.registry,
        state_path=arguments.state,
        state=load_state(arguments.state),
        proxy_url=arguments.proxy_url,
        master_key=master_key,
        env_values=env_values,
        threshold_days=arguments.threshold_days,
        now_ms=int(time.time() * 1000),
    )

    def push(org: Org, secret: str) -> None:
        if not master_key:
            raise RuntimeError("мастер-ключ посредника не найден (LITELLM_MASTER_KEY в окружении или env-файле)")
        push_to_proxy(context.proxy_url, master_key, registry.credential_name, org, secret)

    def usage(org: Org, secret: str | None) -> Usage:
        return probe_usage(org, secret, registry.usage_url)

    if arguments.command in ("status", "pick"):
        # 🔴 ЧИТАЮЩИЕ КОМАНДЫ ВИДЯТ И НОВЫЕ ВХОДЫ. После переезда основное хранилище пишет
        # чужая дверь, а сторож кладёт новые входы в `incoming`; без этой проекции заведённая
        # организация невидима для `pick`/`status` и не получает квоту (`hello@kiberos.app`,
        # замер 2026-10-22 00:48Z). ПИШУЩИЕ команды (`refresh`, `use`) остаются на строгом
        # состоянии: продлить чужую запись локально — значит выдать ей refresh-токен, которого
        # сервер не увидит, и молча убить организацию.
        context = replace(context, state=effective_state(arguments.state))

    global MACHINE_OUTPUT
    MACHINE_OUTPUT = bool(getattr(arguments, "json", False))

    if arguments.command == "status":
        usage_call = None if arguments.no_probe else usage
        if arguments.json:
            print(json.dumps(status_document(context, usage_call), ensure_ascii=False, indent=1))
            return 0
        command_status(context, journal, usage_call)
    elif arguments.command == "refresh":
        if arguments.dry_run:
            for org in context.orgs:
                token = context.state.get(org.name)
                if not org.is_console or token is None:
                    continue
                verdict = (
                    "продлил бы"
                    if needs_refresh(token.expiry_ms, context.now_ms, context.threshold_days, arguments.force)
                    else "не трогал бы"
                )
                journal.say(f"{org.name}: {verdict} (осталось {days_left(token.expiry_ms, context.now_ms):.1f} сут)")
        else:
            # 🔴 ОБЩИЙ ЗАМОК С `watch`: оба пишут ОДИН файл состояния целиком, и до этого
            # `refresh` замка не брал вовсе — то есть мог столкнуться со сторожем на той же
            # машине и потерять свежий пропуск.
            def run_refresh() -> int:
                command_refresh(
                    fresh_context(context), journal, arguments.force, refresh_over_network, push
                )
                return journal.finish()

            return with_lock(arguments.lock, run_refresh)
    elif arguments.command == "push":
        command_push(context, journal, push)
    elif arguments.command == "use":
        command_use(context, journal, arguments.org, arguments.confirm_exhausted, usage, push)
    elif arguments.command == "seed":
        command_seed(context, journal, arguments.from_opencode_db)
    elif arguments.command == "forget":
        command_forget(context, journal, arguments.org)
    elif arguments.command == "set-uid":
        command_set_uid(context, journal, arguments.org, arguments.uid)
    elif arguments.command == "pick":
        command_pick(context, journal, usage, arguments.json)
    elif arguments.command == "onboard":
        command_onboard(
            context,
            journal,
            db_path=arguments.from_opencode_db,
            model=arguments.model,
            probe_call=lambda org, secret: probe_door(org, secret, model=arguments.model),
            push=push,
        )
    elif arguments.command == "watch":
        def rebuild() -> None:
            if arguments.rebuild_cmd:
                subprocess.run(shlex.split(arguments.rebuild_cmd), check=True)

        def run_watch() -> int:
            command_watch(
                fresh_context(context),
                journal,
                db_path=arguments.from_opencode_db,
                model=arguments.model,
                probe_call=lambda org, secret: probe_door(org, secret, model=arguments.model),
                push=push,
                usage_call=usage,
                rebuild=rebuild if arguments.rebuild_cmd else None,
            )
            return journal.finish()

        return with_lock(arguments.lock, run_watch)

    return journal.finish()


if __name__ == "__main__":
    sys.exit(main())
