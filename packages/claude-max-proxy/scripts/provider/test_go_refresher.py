"""Проверки решений go_refresher — там, где ошибка стоит дороже всего.

Сеть здесь не трогается вовсе: продление и отдача посреднику подставлены
заглушками, а всё остальное — настоящий код, настоящий файл состояния и
настоящая база sqlite в формате opencode.

Запуск: cd litellm && python3 -m pytest test_go_refresher.py -q
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import go_refresher as gr  # noqa: E402

NOW_MS = 1_760_000_000_000
DAY_MS = 86_400_000


def registry_file(tmp_path: Path) -> Path:
    path = tmp_path / "go-orgs.yaml"
    path.write_text(
        """
active: console-a
credential_name: cred-go-active
usage_url: https://opencode.ai/inference/go/v1/usage
orgs:
  - name: console-a
    email: console-a@example.com
    workspace: wrk_CONSOLE
    synqtask_org_uid: uid-console-a
    auth: console
    account_id: acc_A
    account_url: https://opencode.ai/console
    base_url: https://opencode.ai/inference/go/openai/v1
    priority: 1
  - name: apikey-b
    email: apikey-b@example.com
    workspace: wrk_APIKEY
    synqtask_org_uid: uid-apikey-b
    auth: api_key
    env: OPENCODE_GO_KEY
    base_url: https://opencode.ai/zen/go/v1
    priority: 2
""",
        encoding="utf-8",
    )
    return path


def context(tmp_path: Path, state: dict[str, gr.ConsoleToken], threshold: float = 7.0) -> gr.Context:
    state_path = tmp_path / ".go-tokens.json"
    if state:
        gr.save_state(state_path, state)
    registry_path = registry_file(tmp_path)
    return gr.Context(
        registry=gr.load_registry(registry_path),
        registry_path=registry_path,
        state_path=state_path,
        state=gr.load_state(state_path),
        proxy_url="http://127.0.0.1:4000",
        master_key="sk-test",
        env_values={"OPENCODE_GO_KEY": "sk-old-key-value"},
        threshold_days=threshold,
        now_ms=NOW_MS,
    )


# ── решение «пора или не пора» ──


@pytest.mark.parametrize(
    ("days", "force", "expected"),
    [
        (30.0, False, False),
        (7.1, False, False),
        (6.9, False, True),
        (0.0, False, True),
        (-3.0, False, True),
        (30.0, True, True),
    ],
)
def test_needs_refresh(days: float, force: bool, expected: bool) -> None:
    expiry = NOW_MS + int(days * DAY_MS)
    assert gr.needs_refresh(expiry, NOW_MS, 7.0, force) is expected


def test_threshold_is_configurable() -> None:
    expiry = NOW_MS + 10 * DAY_MS
    assert gr.needs_refresh(expiry, NOW_MS, 7.0) is False
    assert gr.needs_refresh(expiry, NOW_MS, 14.0) is True


# ── ротация refresh-токена ──


def test_rotation_takes_the_new_refresh_token() -> None:
    old = gr.ConsoleToken("acc-old", "ref-old", NOW_MS + DAY_MS)
    new = gr.apply_rotation(old, {"access_token": "acc-new", "refresh_token": "ref-new", "expires_in": 2_592_000}, NOW_MS)
    assert new.access_token == "acc-new"
    assert new.refresh_token == "ref-new"
    assert new.expiry_ms == NOW_MS + 2_592_000_000
    assert new.refreshed_at_ms == NOW_MS


@pytest.mark.parametrize(
    "response",
    [
        {"access_token": "acc-new", "expires_in": 100},
        {"access_token": "acc-new", "refresh_token": "", "expires_in": 100},
        {"refresh_token": "ref-new", "expires_in": 100},
        {"access_token": "acc-new", "refresh_token": "ref-new"},
        {"access_token": "acc-new", "refresh_token": "ref-new", "expires_in": 0},
    ],
)
def test_rotation_refuses_an_answer_it_cannot_continue_from(response: dict[str, object]) -> None:
    old = gr.ConsoleToken("acc-old", "ref-old", NOW_MS + DAY_MS)
    with pytest.raises(ValueError):
        gr.apply_rotation(old, response, NOW_MS)


# ── сохранение ротации на диск ──


def test_state_file_is_private_and_round_trips(tmp_path: Path) -> None:
    path = tmp_path / ".go-tokens.json"
    gr.save_state(path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + DAY_MS, NOW_MS, NOW_MS)})
    assert oct(os.stat(path).st_mode)[-3:] == "600"
    back = gr.load_state(path)
    assert back["console-a"].refresh_token == "ref"
    assert back["console-a"].pushed_at_ms == NOW_MS
    assert not list(tmp_path.glob("*.tmp"))


def test_refresh_persists_the_rotated_token_before_touching_the_proxy(tmp_path: Path) -> None:
    """Порядок важен: сначала на диск, потом посреднику.

    Если посредник недоступен, новый refresh-токен всё равно обязан быть сохранён —
    старый поставщик уже погасил, и потеря нового означает мёртвую организацию.
    """
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc-old", "ref-old", NOW_MS + DAY_MS)})
    journal = gr.Journal()

    def refresh(account_url: str, refresh_token: str) -> dict[str, object]:
        assert account_url == "https://opencode.ai/console"
        assert refresh_token == "ref-old"
        return {"access_token": "acc-new", "refresh_token": "ref-new", "expires_in": 2_592_000}

    def push(org: gr.Org, access_token: str) -> None:
        raise RuntimeError("посредник лежит")

    gr.command_refresh(ctx, journal, force=False, refresh_call=refresh, push_call=push)

    saved = gr.load_state(ctx.state_path)["console-a"]
    assert saved.refresh_token == "ref-new"
    assert saved.access_token == "acc-new"
    assert saved.pushed_at_ms is None
    assert journal.finish() == 1
    assert any("НЕ отдан" in line for line in journal.failures)


def test_refresh_marks_pushed_when_the_proxy_accepts(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc-old", "ref-old", NOW_MS + DAY_MS)})
    journal = gr.Journal()
    pushed: list[tuple[str, str]] = []

    gr.command_refresh(
        ctx,
        journal,
        force=False,
        refresh_call=lambda url, token: {"access_token": "acc-new", "refresh_token": "ref-new", "expires_in": 2_592_000},
        push_call=lambda org, token: pushed.append((org.name, token)),
    )

    assert pushed == [("console-a", "acc-new")]
    assert gr.load_state(ctx.state_path)["console-a"].pushed_at_ms == NOW_MS
    assert journal.finish() == 0


def test_a_healthy_token_is_left_alone(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    journal = gr.Journal()
    calls: list[str] = []

    gr.command_refresh(
        ctx,
        journal,
        force=False,
        refresh_call=lambda url, token: calls.append("refreshed") or {},
        push_call=lambda name, token: calls.append("pushed"),
    )

    assert calls == []
    assert gr.load_state(ctx.state_path)["console-a"].refresh_token == "ref"
    assert journal.finish() == 0


def test_failed_refresh_is_loud_and_notifies(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + DAY_MS)})
    marker = tmp_path / "notified.txt"
    journal = gr.Journal(notify_cmd=f"cat > {marker}")

    def refresh(account_url: str, refresh_token: str) -> dict[str, object]:
        raise RuntimeError("сервер входа ответил 400")

    gr.command_refresh(ctx, journal, force=False, refresh_call=refresh, push_call=lambda name, token: None)

    assert journal.finish() == 1
    assert "сервер входа ответил 400" in marker.read_text(encoding="utf-8")
    assert gr.load_state(ctx.state_path)["console-a"].refresh_token == "ref"


def test_a_missing_token_is_a_failure_not_a_silent_skip(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_refresh(ctx, journal, force=False, refresh_call=lambda url, token: {}, push_call=lambda n, t: None)
    assert journal.finish() == 1
    assert any("seed" in line for line in journal.failures)


def test_api_key_org_is_never_refreshed(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    journal = gr.Journal()
    seen: list[str] = []
    gr.command_refresh(
        ctx,
        journal,
        force=False,
        refresh_call=lambda url, token: seen.append(url) or {},
        push_call=lambda name, token: None,
    )
    assert seen == []
    assert journal.finish() == 0


# ── перенос из базы opencode ──


def opencode_db(tmp_path: Path) -> Path:
    path = tmp_path / "opencode.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "create table account (id text primary key, email text, url text, access_token text, "
        "refresh_token text, token_expiry integer, time_created integer, time_updated integer)"
    )
    connection.execute("create table account_state (id integer primary key, active_account_id text, active_org_id text)")
    connection.execute(
        "insert into account values ('acc_A','a@example.com','https://opencode.ai/console','acc-db','ref-db',?,0,0)",
        (NOW_MS + 30 * DAY_MS,),
    )
    connection.execute("insert into account_state values (1,'acc_A','wrk_CONSOLE')")
    connection.commit()
    connection.close()
    return path


def test_seed_imports_the_console_login(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_seed(ctx, journal, opencode_db(tmp_path))
    saved = gr.load_state(ctx.state_path)["console-a"]
    assert saved.access_token == "acc-db"
    assert saved.refresh_token == "ref-db"
    assert saved.expiry_ms == NOW_MS + 30 * DAY_MS
    assert journal.finish() == 0


def test_seed_does_not_write_to_the_opencode_db(tmp_path: Path) -> None:
    db = opencode_db(tmp_path)
    before = db.stat().st_mtime_ns
    gr.read_opencode_accounts(db)
    assert db.stat().st_mtime_ns == before


def test_match_account_falls_back_to_the_workspace(tmp_path: Path) -> None:
    accounts = gr.read_opencode_accounts(opencode_db(tmp_path))
    org = gr.Org(
        name="console-a",
        workspace="wrk_CONSOLE",
        auth="console",
        base_url="https://opencode.ai/inference/go/openai/v1",
        priority=1,
        account_url="https://opencode.ai/console",
        account_id="acc_UNKNOWN",
    )
    assert gr.match_account(accounts, org) is not None


# ── реестр ──


def test_registry_is_ordered_by_priority(tmp_path: Path) -> None:
    orgs = gr.load_registry(registry_file(tmp_path)).orgs
    assert [org.name for org in orgs] == ["console-a", "apikey-b"]
    assert orgs[0].is_console and not orgs[1].is_console


def test_registry_refuses_a_console_org_without_an_account_url(tmp_path: Path) -> None:
    path = tmp_path / "broken.yaml"
    path.write_text(
        "active: x\ncredential_name: c\nusage_url: https://u\n"
        "orgs:\n  - name: x\n    workspace: w\n    auth: console\n    base_url: https://e\n    priority: 1\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="account_url"):
        gr.load_registry(path)


@pytest.mark.parametrize(
    ("head", "complaint"),
    [
        ("credential_name: c\nusage_url: https://u\n", "active"),
        ("active: nobody\ncredential_name: c\nusage_url: https://u\n", "nobody"),
        ("active: x\nusage_url: https://u\n", "credential_name"),
        ("active: x\ncredential_name: c\n", "usage_url"),
    ],
)
def test_registry_must_name_exactly_one_working_org(tmp_path: Path, head: str, complaint: str) -> None:
    """Без названной рабочей организации посредник не знает, через кого ходить, — и это громко."""
    path = tmp_path / "broken.yaml"
    path.write_text(
        head + "orgs:\n  - name: x\n    workspace: w\n    auth: api_key\n    env: K\n    base_url: https://e\n    priority: 1\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match=complaint):
        gr.load_registry(path)


def test_the_real_registry_in_this_repo_parses() -> None:
    # 🔴 РЕЕСТР БОЛЬШЕ НЕ ЛЕЖИТ РЯДОМ СО СКРИПТОМ (26.10.2026). Скрипт переехал в
    # claude-code-sdk, а сам файл остался на месте по условию владельца kiberos-app:
    # его compose монтирует ЭТОТ каталог только на чтение. Поэтому путь берём такой же,
    # каким его видит сам скрипт: GO_REGISTRY, иначе значение по умолчанию.
    real = Path(os.environ.get("GO_REGISTRY") or (Path(__file__).resolve().parent / "go-orgs.yaml"))
    if not real.exists():
        pytest.skip(f"реестр не найден по пути {real} — проверять нечего (файл живёт вне репозитория)")
    registry = gr.load_registry(real)
    orgs = registry.orgs
    assert registry.active_org.name == registry.active
    names = [org.name for org in orgs]
    assert names == sorted(names, key=lambda n: [o.priority for o in orgs if o.name == n][0])
    assert any(org.is_console for org in orgs)
    assert any(org.auth == "api_key" for org in orgs)
    # Требование фаундера 21.10.2026: организация писается адресом, а не кличкой.
    # Без этого поля отчёт снова схлопывается в девять «Русланов».
    nameless = [org.name for org in orgs if not (org.email or "").strip() or "@" not in org.email]
    assert not nameless, f"у организаций нет почты: {nameless}"


# ── секреты в выводе ──


def test_tail_never_shows_the_whole_value() -> None:
    assert gr.tail("oc_supersecretvalue") == "…alue (длина 19)"
    assert gr.tail(None) == "—"


def test_bodies_in_the_journal_are_masked() -> None:
    assert "oc_" not in gr._safe({"error": "token oc_abcdef123456 rejected"})
    assert "sk-" not in gr._safe("key sk-abcdef123456 bad")


def test_every_request_names_us_to_the_provider() -> None:
    """Имя в User-Agent обязано стоять на КАЖДОМ запросе, включая продление.

    Замер 08.10.2026: сервер входа ответил на продление 403 «Error 1010:
    browser_signature_banned» — поставщик держит в запрете стандартное имя python
    `Python-urllib/…`. Беда отложенная: пропуск был годен ещё тридцать суток, и
    провалилось бы ПЕРВОЕ настоящее продление, ночью по таймеру. С нашим именем тот
    же запрос ответил 400 invalid_grant, то есть дошёл и был разобран.
    """
    seen: dict[str, str] = {}

    class Capture(urllib.request.BaseHandler):
        def default_open(self, request: urllib.request.Request):  # noqa: ANN202
            seen.update(request.headers)
            raise urllib.error.URLError("не ходим в сеть")

    opener = urllib.request.build_opener(Capture())
    original = urllib.request.urlopen
    urllib.request.urlopen = lambda req, timeout=None: opener.open(req, timeout=timeout)  # type: ignore[assignment]
    try:
        gr.http_json("https://opencode.ai/console/auth/device/token", {"grant_type": "refresh_token"})
    finally:
        urllib.request.urlopen = original  # type: ignore[assignment]

    agent = next(value for key, value in seen.items() if key.lower() == "user-agent")
    assert "python" not in agent.lower()
    assert agent == gr.USER_AGENT


def test_a_silent_provider_does_not_abort_the_report(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Проба, которая не дождалась ответа, — строка отчёта, а не конец отчёта.

    Замер 08.10.2026: поставщик молчал тридцать секунд, исключение вылетало из
    первой же пробы, и человек не узнавал ничего о ВТОРОЙ организации.
    """
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    journal = gr.Journal()
    original = gr.http_json
    gr.http_json = lambda *args, **kwargs: (0, "связи нет: timed out")  # type: ignore[assignment]
    try:
        gr.command_status(ctx, journal, lambda org, secret: gr.probe_usage(org, secret, ctx.registry.usage_url))
    finally:
        gr.http_json = original  # type: ignore[assignment]
    out = capsys.readouterr().out
    assert out.count("неизвестно — поставщик не ответил") == 2
    assert "apikey-b" in out
    assert journal.finish() == 0


def test_env_file_is_parsed_without_executing_it(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text('# комментарий\nA=1\nB="two"\nC=$(rm -rf /)\n', encoding="utf-8")
    values = gr.read_env_file(path)
    assert values == {"A": "1", "B": "two", "C": "$(rm -rf /)"}


def test_status_reports_both_orgs_without_network(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc-value", "ref-value", NOW_MS + 29 * DAY_MS)})
    journal = gr.Journal()
    gr.command_status(ctx, journal, None)
    out = capsys.readouterr().out
    assert "console-a" in out and "apikey-b" in out
    assert "acc-value" not in out and "ref-value" not in out
    assert "осталось 29.0 сут" in out
    assert journal.finish() == 0


def test_state_json_holds_no_extra_fields(tmp_path: Path) -> None:
    path = tmp_path / ".go-tokens.json"
    gr.save_state(path, {"console-a": gr.ConsoleToken("a", "r", NOW_MS)})
    body = json.loads(path.read_text(encoding="utf-8"))
    assert set(body) == {"orgs"}
    assert set(body["orgs"]["console-a"]) == {
        "access_token",
        "refresh_token",
        "expiry_ms",
        "refreshed_at_ms",
        "pushed_at_ms",
    }


# ── рабочая организация и явное переключение ──


def usage_of(status: str) -> gr.UsageCall:
    def call(org: gr.Org, secret: str | None) -> gr.Usage:
        return gr.Usage(windows={"weekly": {"status": status, "percent": 100 if status != "ok" else 30}})

    return call


def test_only_the_working_org_reaches_the_proxy(tmp_path: Path) -> None:
    """Продление нерабочей организации не должно подменить рабочую у посредника."""
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc-old", "ref-old", NOW_MS + DAY_MS)})
    ctx = replace(ctx, registry=replace(ctx.registry, active="apikey-b"))
    pushed: list[str] = []
    journal = gr.Journal()
    gr.command_refresh(
        ctx,
        journal,
        force=False,
        refresh_call=lambda url, token: {"access_token": "acc-new", "refresh_token": "ref-new", "expires_in": 2_592_000},
        push_call=lambda org, token: pushed.append(org.name),
    )
    assert pushed == []
    assert gr.load_state(ctx.state_path)["console-a"].refresh_token == "ref-new"
    assert journal.finish() == 0


def test_use_switches_the_proxy_first_and_the_registry_second(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    pushed: list[tuple[str, str]] = []
    journal = gr.Journal()
    gr.command_use(ctx, journal, "apikey-b", False, usage_of("ok"), lambda org, secret: pushed.append((org.name, secret)))
    assert pushed == [("apikey-b", "sk-old-key-value")]
    assert gr.load_registry(ctx.registry_path).active == "apikey-b"
    assert journal.finish() == 0


def test_use_keeps_the_registry_honest_when_the_proxy_refuses(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    journal = gr.Journal()

    def push(org: gr.Org, secret: str) -> None:
        raise RuntimeError("посредник лежит")

    gr.command_use(ctx, journal, "apikey-b", False, usage_of("ok"), push)
    assert gr.load_registry(ctx.registry_path).active == "console-a"
    assert journal.finish() == 1


def test_use_refuses_an_exhausted_org_without_confirmation(tmp_path: Path) -> None:
    """Переезд на организацию, которая сама упёрлась, — не спасение, а вторая потеря кэша."""
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + 29 * DAY_MS)})
    pushed: list[str] = []
    journal = gr.Journal()
    gr.command_use(ctx, journal, "apikey-b", False, usage_of("rate-limited"), lambda org, secret: pushed.append(org.name))
    assert pushed == []
    assert gr.load_registry(ctx.registry_path).active == "console-a"
    assert any("--confirm-exhausted" in line for line in journal.failures)

    confirmed = gr.Journal()
    gr.command_use(ctx, confirmed, "apikey-b", True, usage_of("rate-limited"), lambda org, secret: pushed.append(org.name))
    assert pushed == ["apikey-b"]
    assert confirmed.finish() == 0


def test_use_of_an_unknown_org_names_the_known_ones(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_use(ctx, journal, "nobody", False, usage_of("ok"), lambda org, secret: None)
    assert any("console-a" in line and "apikey-b" in line for line in journal.failures)


def test_set_active_rewrites_one_line_and_keeps_comments(tmp_path: Path) -> None:
    path = tmp_path / "r.yaml"
    path.write_text("# шапка\nactive: a\n# active: старая заметка\norgs: []\n", encoding="utf-8")
    gr.set_active_in_file(path, "b")
    assert path.read_text(encoding="utf-8") == "# шапка\nactive: b\n# active: старая заметка\norgs: []\n"


def test_credential_carries_the_whole_org(tmp_path: Path) -> None:
    """Модели Go называют только имя записи — значит запись обязана нести дверь и заголовок организации."""
    orgs = {org.name: org for org in gr.load_registry(registry_file(tmp_path)).orgs}
    console = gr.credential_values(orgs["console-a"], "acc")
    assert console["api_base"] == "https://opencode.ai/inference/go/openai/v1"
    assert console["extra_headers"]["x-opencode-org-id"] == "wrk_CONSOLE"  # type: ignore[index]
    assert console["extra_headers"]["x-opencode-session"]  # type: ignore[index]
    apikey = gr.credential_values(orgs["apikey-b"], "sk")
    assert "x-opencode-org-id" not in apikey["extra_headers"]  # type: ignore[operator]


def test_status_document_names_the_working_org_and_holds_no_secrets(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc-value", "ref-value", NOW_MS + 29 * DAY_MS)})
    document = gr.status_document(ctx, usage_of("ok"))
    body = json.dumps(document)
    assert document["active"] == "console-a"
    assert [org["active"] for org in document["orgs"]] == [True, False]  # type: ignore[index]
    assert document["orgs"][0]["usage"]["weekly"]["percent"] == 30  # type: ignore[index]
    # Почта едет в документе: подвал показывает «имя (адрес)», и склеивать её из клички нельзя.
    assert document["orgs"][0]["email"] == "console-a@example.com"  # type: ignore[index]
    assert "acc-value" not in body and "ref-value" not in body and "sk-old-key-value" not in body


# ── выбор организации со свободной квотой (pick) ──


def usage_map(by_name: dict[str, dict[str, dict[str, object]]]) -> gr.UsageCall:
    def call(org: gr.Org, secret: str | None) -> gr.Usage:
        if org.name not in by_name:
            return gr.Usage(error="поставщик не ответил")
        return gr.Usage(windows=by_name[org.name])

    return call


def free(weekly: int, monthly: int = 0) -> dict[str, dict[str, object]]:
    return {
        "weekly": {"status": "ok", "percent": weekly},
        "monthly": {"status": "ok", "percent": monthly},
    }


def busy(window: str = "weekly") -> dict[str, dict[str, object]]:
    return {window: {"status": "rate-limited", "percent": 100}}


def live_pass() -> dict[str, gr.ConsoleToken]:
    return {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS + DAY_MS)}


def test_pick_chooses_the_least_busy_org(tmp_path: Path) -> None:
    """Новую сессию пускают туда, где свободнее: неделя решает первой."""
    ctx = context(tmp_path, live_pass())
    chosen = gr.choose_org(ctx, usage_map({"console-a": free(70), "apikey-b": free(10)}))
    assert chosen is not None
    assert chosen[0].name == "apikey-b"


def test_pick_never_chooses_an_exhausted_org(tmp_path: Path) -> None:
    """Упёршаяся организация получит 429 сразу — пускать туда значит сломать старт."""
    ctx = context(tmp_path, live_pass())
    chosen = gr.choose_org(ctx, usage_map({"console-a": busy(), "apikey-b": free(90)}))
    assert chosen is not None
    assert chosen[0].name == "apikey-b"


def test_pick_skips_a_console_org_whose_pass_expired(tmp_path: Path) -> None:
    """Истёкший пропуск консоли — это не «свободная квота», а неработающий вход."""
    ctx = context(tmp_path, {"console-a": gr.ConsoleToken("acc", "ref", NOW_MS - DAY_MS)})
    chosen = gr.choose_org(ctx, usage_map({"console-a": free(0), "apikey-b": free(90)}))
    assert chosen is not None
    assert chosen[0].name == "apikey-b"


def test_pick_says_nothing_is_free_instead_of_guessing(tmp_path: Path) -> None:
    ctx = context(tmp_path, live_pass())
    chosen = gr.choose_org(ctx, usage_map({"console-a": busy(), "apikey-b": busy("monthly")}))
    assert chosen is None


def test_pick_breaks_a_weekly_tie_by_the_month(tmp_path: Path) -> None:
    ctx = context(tmp_path, live_pass())
    chosen = gr.choose_org(ctx, usage_map({"console-a": free(20, 80), "apikey-b": free(20, 5)}))
    assert chosen is not None
    assert chosen[0].name == "apikey-b"


def test_pick_json_names_the_org_its_uid_and_nothing_secret(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пускателю нужны имя, рабочая область и uid — секретов в документе быть не должно."""
    ctx = context(tmp_path, live_pass())
    journal = gr.Journal()
    gr.command_pick(ctx, journal, usage_map({"console-a": free(5), "apikey-b": free(90)}), as_json=True)
    out = json.loads(capsys.readouterr().out)
    assert out["org"] == "console-a"
    assert out["synqtask_org_uid"] == "uid-console-a"
    assert out["active"] is True
    assert "acc" not in json.dumps(out)
    assert journal.finish() == 0


def test_pick_fails_loudly_when_nothing_is_free(tmp_path: Path) -> None:
    ctx = context(tmp_path, live_pass())
    journal = gr.Journal()
    gr.command_pick(ctx, journal, usage_map({"console-a": busy(), "apikey-b": busy()}), as_json=False)
    assert journal.finish() != 0


# ── онбординг новой организации одним прогоном ──


def opencode_db_with_new_login(tmp_path: Path) -> Path:
    """База opencode со ВХОДОМ, которого нет в реестре, — то, ради чего онбординг и нужен."""
    path = tmp_path / "opencode-new.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "create table account (id text primary key, email text, url text, access_token text, "
        "refresh_token text, token_expiry integer, time_created integer, time_updated integer)"
    )
    connection.execute("create table account_state (id integer primary key, active_account_id text, active_org_id text)")
    connection.execute(
        "insert into account values ('acc_NEW','new@example.com','https://opencode.ai/console','acc-new','ref-new',?,0,0)",
        (NOW_MS + 30 * DAY_MS,),
    )
    connection.execute("insert into account_state values (1,'acc_NEW','wrk_NEW')")
    connection.commit()
    connection.close()
    return path


def test_named_cause_reads_the_message_out_of_the_body() -> None:
    """Человеку нужна причина, а не тело ответа: по нему он и починит тумблер."""
    body = '{"error":{"message":"This account requires Global regions","type":"invalid_request"}}'
    assert gr.named_cause(400, body) == "This account requires Global regions"


def test_named_cause_never_returns_an_empty_line() -> None:
    assert gr.named_cause(500, "") == "HTTP 500 без объяснения"
    """Тело без разметки отдаётся как есть — это всё, что поставщик сказал."""
    assert "bad gateway" in gr.named_cause(502, "  <html>bad gateway</html> ")


def test_append_org_keeps_comments_and_stays_parseable(tmp_path: Path) -> None:
    """Реестр ведётся руками и несёт объяснения — перезапись YAML стёрла бы их."""
    path = registry_file(tmp_path)
    before = path.read_text(encoding="utf-8")
    gr.append_org_to_file(
        path,
        name="console-new",
        workspace="wrk_NEW",
        account_id="acc_NEW",
        account_url="https://opencode.ai/console",
        base_url="https://opencode.ai/inference/go/openai/v1",
        priority=3,
        date="2026-10-16",
        email="console-new@example.com",
    )
    after = path.read_text(encoding="utf-8")
    assert before in after  # прежнее содержимое цело, включая комментарии
    registry = gr.load_registry(path)
    assert registry.find("console-new").workspace == "wrk_NEW"
    assert registry.find("console-new").priority == 3
    assert registry.find("console-new").email == "console-new@example.com"


def test_probe_door_passes_on_success() -> None:
    org = gr.Org(
        name="console-a",
        workspace="wrk",
        auth="console",
        base_url="https://opencode.ai/inference/go/openai/v1",
        priority=1,
        account_id="acc_A",
    )
    ok, cause = gr.probe_door(
        org,
        "acc",
        model="m",
        fetch=lambda url, headers, payload, timeout: (200, '{"choices":[]}'),
    )
    assert ok is True


def test_probe_door_names_the_cause_on_refusal() -> None:
    org = gr.Org(
        name="console-a",
        workspace="wrk",
        auth="console",
        base_url="https://opencode.ai/inference/go/openai/v1",
        priority=1,
        account_id="acc_A",
    )
    ok, cause = gr.probe_door(
        org,
        "acc",
        model="m",
        fetch=lambda url, headers, payload, timeout: (
            400,
            '{"error":{"message":"requires Global regions"}}',
        ),
    )
    assert ok is False
    assert "requires Global regions" in cause


def test_onboard_writes_the_entry_seeds_switches_and_probes(tmp_path: Path) -> None:
    """Один прогон: появилась запись, пришёл пропуск, посредник переехал, проба сказала слово."""
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    probed: list[str] = []
    pushed: list[str] = []
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="deepseek-v4.1-flash",
        probe_call=lambda org, secret: (probed.append(org.name) or (True, "ответ получен")),
        push=lambda org, secret: pushed.append(org.name),
        usage_call=lambda org, secret: gr.Usage(
            windows={"weekly": {"status": "ok", "percent": 1}, "monthly": {"status": "ok", "percent": 1}}
        ),
    )
    registry = gr.load_registry(ctx.registry_path)
    assert registry.find("new@example.com").auth == "console"
    assert gr.load_state(ctx.state_path)["new@example.com"].access_token == "acc-new"
    assert pushed == ["new@example.com"]
    assert probed == ["new@example.com"]
    assert journal.finish() == 0


def test_onboard_probes_before_moving_and_keeps_the_old_org_when_the_probe_fails(
    tmp_path: Path,
) -> None:
    """Проба не прошла — посредник НЕ переехал, и журнал это говорит.

    Замер 21.10.2026: свежая рабочая область ответила 400 «requires Global regions»,
    а порядок был «переезд → проба». Посредник уже ходил через непроверенную
    организацию, журнал говорил «ОТКАЗ» — состояние и запись расходились, и разбирать
    это приходилось человеку. Теперь проба идёт первой: не ответила — не переезжаем.
    """
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    events: list[str] = []
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="deepseek-v4.1-flash",
        probe_call=lambda org, secret: (events.append("probe") or (False, "HTTP 400: нужен Global")),
        push=lambda org, secret: events.append("push"),
        usage_call=lambda org, secret: gr.Usage(
            windows={"weekly": {"status": "ok", "percent": 1}, "monthly": {"status": "ok", "percent": 1}}
        ),
    )
    registry = gr.load_registry(ctx.registry_path)
    assert events == ["probe"], "переезда быть не должно, пока проба не ответила"
    assert registry.find("new@example.com").auth == "console", "запись в реестре остаётся — вход не потерян"
    assert registry.active == "console-a", "рабочей осталась прежняя организация"
    assert journal.finish() == 1, "отказ пробы обязан быть виден в журнале"
    """Вход уже заведён — заводить нечего, и это не ошибка."""
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db(tmp_path),
        model="deepseek-v4.1-flash",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    assert journal.finish() == 0


# ── живая проба двери: тело уходит в http_json словарём, а не разобранным вручную ──


def test_probe_door_gives_http_json_a_url_and_a_dict_body(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сторож поломки 17.10: `http_json("POST", url, …, body=…)` ронял пробу `TypeError`.

    Проба — ПОСЛЕДНИЙ шаг `onboard`, то есть посредник уже переключён, а подтверждения
    нет. Поэтому проверяется не «проба зелёная», а КАКИЕ аргументы уходят в `http_json`:
    адрес первым, метод в `method`, тело словарём.
    """
    seen: dict[str, object] = {}

    def fake(url: str, body: dict[str, object] | None = None, **kwargs: object) -> tuple[int, dict[str, object]]:
        seen.update(url=url, body=body, **kwargs)
        return 200, {"choices": []}

    monkeypatch.setattr(gr, "http_json", fake)
    org = gr.Org(
        name="console-a",
        workspace="wrk",
        auth="console",
        base_url="https://opencode.ai/inference/go/openai/v1",
        priority=1,
        account_id="acc_A",
    )
    ok, _ = gr.probe_door(org, "acc", model="m")
    assert ok is True
    assert seen["url"] == "https://opencode.ai/inference/go/openai/v1/chat/completions"
    assert seen["method"] == "POST"
    assert isinstance(seen["body"], dict) and seen["body"]["model"] == "m"  # type: ignore[index]


def test_named_cause_reads_a_json_body_that_came_back_as_a_dict() -> None:
    """`http_json` отдаёт разобранный JSON словарём — разбор причины обязан его принять."""
    assert gr.named_cause(400, {"error": {"message": "requires Global regions"}}) == "requires Global regions"


def test_status_document_carries_the_synqtask_uid(tmp_path: Path) -> None:
    """Показ склеивает организацию (по имени) с членом (по uid) — uid обязан ехать в отчёте."""
    ctx = context(tmp_path, live_pass())
    document = gr.status_document(ctx, usage_map({"console-a": free(5), "apikey-b": free(90)}))
    by_name = {str(org["name"]): org for org in document["orgs"]}  # type: ignore[union-attr]
    assert by_name["console-a"]["synqtask_org_uid"] == "uid-console-a"
    assert by_name["apikey-b"]["synqtask_org_uid"] == "uid-apikey-b"


# ── вычёркивание лишней записи и uid в реестр ──


def test_forget_removes_only_that_entry_and_keeps_the_rest(tmp_path: Path) -> None:
    """Лишняя запись — не мусор: по ней onboard считает «заведено», а карта имя→uid падает."""
    path = registry_file(tmp_path)
    assert gr.forget_org_in_file(path, "apikey-b") is True
    after = path.read_text(encoding="utf-8")
    assert "apikey-b" not in after and "console-a" in after
    assert [org.name for org in gr.load_registry(path).orgs] == ["console-a"]  # YAML цел


def test_forget_says_no_when_the_entry_is_absent(tmp_path: Path) -> None:
    assert gr.forget_org_in_file(registry_file(tmp_path), "nobody") is False


def test_forget_refuses_the_working_organization(tmp_path: Path) -> None:
    """Рабочую не вычёркиваем: посредник остался бы с записью без организации в реестре."""
    ctx = context(tmp_path, live_pass())
    journal = gr.Journal()
    gr.command_forget(ctx, journal, "console-a")
    assert journal.finish() != 0
    assert gr.load_registry(ctx.registry_path).find("console-a")  # на месте


def test_forget_drops_the_pass_from_the_state(tmp_path: Path) -> None:
    ctx = context(tmp_path, {"apikey-b": gr.ConsoleToken("acc", "ref", NOW_MS + DAY_MS)})
    journal = gr.Journal()
    gr.command_forget(ctx, journal, "apikey-b")
    assert journal.finish() == 0
    assert "apikey-b" not in gr.load_state(ctx.state_path)


def test_set_uid_inserts_the_field_and_keeps_yaml_parsable(tmp_path: Path) -> None:
    path = registry_file(tmp_path)
    assert gr.set_uid_in_file(path, "relishev-less", "uid-new") is False  # записи нет
    assert gr.set_uid_in_file(path, "apikey-b", "uid-new") is True
    assert gr.load_registry(path).find("apikey-b").synqtask_org_uid == "uid-new"


def test_set_uid_replaces_an_existing_value(tmp_path: Path) -> None:
    path = registry_file(tmp_path)
    assert gr.set_uid_in_file(path, "console-a", "uid-changed") is True
    assert "uid-console-a" not in path.read_text(encoding="utf-8")
    assert gr.load_registry(path).find("console-a").synqtask_org_uid == "uid-changed"


# ── онбординг не заводит мусор (дубль `relishev`, 16.10) ──


def opencode_db_with(tmp_path: Path, *, email: str, account_id: str, workspace: str | None) -> Path:
    path = tmp_path / "opencode-probe.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "create table account (id text primary key, email text, url text, access_token text, "
        "refresh_token text, token_expiry integer, time_created integer, time_updated integer)"
    )
    connection.execute("create table account_state (id integer primary key, active_account_id text, active_org_id text)")
    connection.execute(
        "insert into account values (?,?, 'https://opencode.ai/console','acc-new','ref-new',?,0,0)",
        (account_id, email, NOW_MS + 30 * DAY_MS),
    )
    if workspace is not None:
        connection.execute("insert into account_state values (1,?,?)", (account_id, workspace))
    else:
        connection.execute("insert into account_state values (1,?,NULL)", (account_id,))
    connection.commit()
    connection.close()
    return path


def test_onboard_skips_a_login_without_a_workspace(tmp_path: Path) -> None:
    """Вход без рабочей области дал бы запись `workspace: None` — ровно дубль `relishev`."""
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with(tmp_path, email="ghost@example.com", account_id="acc_GHOST", workspace=None),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    assert journal.finish() == 0
    assert [org.name for org in gr.load_registry(ctx.registry_path).orgs] == ["console-a", "apikey-b"]


def test_onboard_says_the_uid_is_missing_when_the_service_pass_is_absent(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Молчание тут стоило бы дорого: карта имя→uid падает ЦЕЛИКОМ на записи без uid.

    С 20.10 uid заводит сам сторож (`ensure`), поэтому «нет uid» теперь означает ровно
    одно — нет ПРОПУСКА службы. Это и должно быть слышно, иначе поиск уйдёт в грант двери.
    """
    monkeypatch.delenv("GO_ONBOARD_SERVICE_MEMBER_ID", raising=False)
    monkeypatch.delenv("GO_ONBOARD_SERVICE_SECRET", raising=False)
    ctx = context(tmp_path, {})
    gr.command_onboard(
        ctx,
        gr.Journal(),
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    out = capsys.readouterr().out
    assert "пропуск службы не задан" in out and "set-uid new@example.com" in out


def test_onboard_writes_the_uid_into_the_registry_and_rebuilds_the_map(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Порядок шагов проверяется по ПОБОЧНЫМ ЭФФЕКТАМ: uid в реестре + пересборка карты.

    Без записи в реестр организация есть в SynqTask, а карта шестиэлементная, и лаунчер
    опять получает None — тот же разрыв, только на шаг позже.
    """
    monkeypatch.setenv("GO_ONBOARD_SERVICE_MEMBER_ID", "4ed24740-9860-4199-bab5-be8fdd5acae6")
    monkeypatch.setenv("GO_ONBOARD_SERVICE_SECRET", "s3cret")
    rebuilt: list[str] = []

    def fake_run(command, **kwargs):  # noqa: ANN001
        rebuilt.append(str(command))
        return None

    monkeypatch.setattr(gr.subprocess, "run", fake_run)
    monkeypatch.setattr(
        gr,
        "ensure_registry_uid",
        lambda name, **kwargs: ("uid-new", "uid получен"),
    )

    ctx = context(tmp_path, {})
    gr.command_onboard(
        ctx,
        gr.Journal(),
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )

    text = ctx.registry_path.read_text(encoding="utf-8")
    assert "synqtask_org_uid: uid-new" in text
    assert rebuilt and "go-org-uids" in rebuilt[0]
    assert "пересобрана" in capsys.readouterr().out


def test_onboard_is_loud_when_ensure_is_refused_by_rights(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Потеря гранта не должна выглядеть как «новых входов нет» — она валит проход громко."""
    monkeypatch.setenv("GO_ONBOARD_SERVICE_MEMBER_ID", "m")
    monkeypatch.setenv("GO_ONBOARD_SERVICE_SECRET", "s")
    monkeypatch.setattr(
        gr,
        "ensure_registry_uid",
        lambda name, **kwargs: (None, "ensure отказал по правам (HTTP 403): org.assign required"),
    )
    journal = gr.Journal()
    gr.command_onboard(
        context(tmp_path, {}),
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    captured = capsys.readouterr()
    assert "ensure отказал по правам" in captured.out + captured.err
    assert journal.finish() != 0


def test_onboard_names_the_org_by_the_full_account_not_the_local_part(tmp_path: Path) -> None:
    """Слово фаундера 21.10: организация называется ПОЛНЫМ именем учётки.

    Старое поведение («второй `console-a` не заводим») и было дефектом: `console-a@example.com`
    — ДРУГАЯ подписка, и её выбрасывало из пула из-за совпадения левой части адреса с записью
    `console-a`. Замер 21.10 21:40Z на живой hello@kiberos.app.
    """
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with(tmp_path, email="console-a@example.com", account_id="acc_OTHER", workspace="wrk_OTHER"),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    assert [org.name for org in gr.load_registry(ctx.registry_path).orgs] == [
        "console-a",
        "apikey-b",
        "console-a@example.com",
    ]


# ── сторож: вход в новую организацию → в строю без руки человека (bff16c6a) ──


def watch(
    tmp_path: Path,
    ctx: gr.Context,
    journal: gr.Journal,
    db_path: Path,
    rebuilt: list[str],
    rebuild=None,  # type: ignore[no-untyped-def]
    pushed: list[str] | None = None,
) -> int:
    pushed = pushed if pushed is not None else []
    gr.command_watch(
        ctx,
        journal,
        db_path=db_path,
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: pushed.append(org.name),
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
        rebuild=rebuild if rebuild is not None else (lambda: rebuilt.append("yes")),
    )
    return journal.finish()


def test_watch_onboards_a_new_login_and_rebuilds_the_report(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    rebuilt, pushed = [], []
    assert watch(tmp_path, ctx, gr.Journal(), opencode_db_with_new_login(tmp_path), rebuilt, pushed=pushed) == 0
    assert rebuilt == ["yes"]
    assert gr.load_registry(ctx.registry_path).find("new@example.com").auth == "console"
    assert pushed == []  # рабочая жива — общего посредника не трогаем (слово фаундера 17.10)


def test_watch_writes_new_logins_to_incoming_after_the_handover(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """После переезда сторож кладёт новый вход в ОТДЕЛЬНЫЙ файл, а хранилище не трогает.

    Иначе он снова становится вторым писателем на `.go-tokens.json` — тем самым, от которого
    мы уходили: его снимок состояния затирал бы продлённый чужой дверью пропуск, и файл при
    этом оставался бы валидным JSON.
    """
    ctx = context(tmp_path, {})
    before = ctx.state_path.read_text(encoding="utf-8") if ctx.state_path.exists() else None
    monkeypatch.setenv("GO_TOKENS_INCOMING", "1")
    rebuilt: list[str] = []
    assert watch(tmp_path, ctx, gr.Journal(), opencode_db_with_new_login(tmp_path), rebuilt) == 0

    incoming = ctx.state_path.with_name(f"{ctx.state_path.stem}.incoming.json")
    assert incoming.exists()
    assert "new@example.com" in gr.load_state(incoming)

    after = ctx.state_path.read_text(encoding="utf-8") if ctx.state_path.exists() else None
    assert after == before


def test_new_logins_are_visible_to_readers_before_any_hand_merge(tmp_path: Path) -> None:
    """Новый вход виден читателям СРАЗУ, хотя основное хранилище не тронуто.

    Замер 2026-10-22 00:48Z: после переезда сторож кладёт новые входы в `incoming`, а сливать
    их некому — организация, заведённая только что, невидима для `pick`/`status` и не получает
    квоту, пока человек не сольёт руками (`hello@kiberos.app`, две пустые перезагрузки).
    """
    ctx = context(tmp_path, live_pass())
    incoming = gr.incoming_path_for(ctx.state_path)
    gr.save_state(
        incoming,
        {
            "new@example.com": gr.ConsoleToken("acc-new", "ref-new", NOW_MS + 30 * DAY_MS),
            # Уже известная организация НЕ перетирается: её запись могла быть продлена.
            "console-a": gr.ConsoleToken("acc-stale", "ref-stale", NOW_MS),
        },
    )
    seen = gr.effective_state(ctx.state_path)
    assert seen["new@example.com"].access_token == "acc-new"
    assert seen["console-a"].access_token != "acc-stale", "своя запись главнее incoming"
    assert gr.effective_state(ctx.state_path).get("console-a") is not None


def test_onboard_probes_a_login_that_only_lives_in_incoming(tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    """Проба и переключение идут по только что взятому пропуску, а не по пустому хранилищу.

    До этого в режиме `incoming` проба не запускалась вовсе: `refreshed.state` собирался из
    старого файла, пропуска там не было, и цикл молча шёл дальше (`continue`). Новый вход
    оставался непроверенным, а рабочей организацией так и не становился.
    """
    monkeypatch.setenv("GO_TOKENS_INCOMING", "1")
    ctx = context(tmp_path, {})
    probed: list[str] = []
    journal = gr.Journal()
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: probed.append(org.name) or (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
        switch_active=False,  # переезд посредника проверяется отдельно; здесь — только проба
    )
    assert journal.finish() == 0
    assert probed == ["new@example.com"]


def test_watch_moves_the_mediator_only_when_the_active_org_is_dead(tmp_path: Path) -> None:
    """Переезд общего посредника — цена живых сессий, поэтому только на мёртвой прежней."""
    ctx = context(tmp_path, {})
    rebuilt, pushed = [], []
    journal = gr.Journal()
    gr.command_watch(
        ctx,
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: pushed.append(org.name),
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "rate-limited", "percent": 100}})
        if org.name == "console-a"
        else gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
        rebuild=lambda: rebuilt.append("yes"),
    )
    assert journal.finish() == 0
    assert pushed == ["new@example.com"]
    assert rebuilt == ["yes"]


def test_active_org_is_dead_reads_exhaustion_and_mistrusts_unknown(tmp_path: Path) -> None:
    ctx = context(tmp_path, live_pass())
    dead = lambda org, secret: gr.Usage(windows={"weekly": {"status": "rate-limited", "percent": 100}})  # noqa: E731
    alive = lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}})  # noqa: E731
    unknown = lambda org, secret: gr.Usage(error="поставщик не ответил")  # noqa: E731
    assert gr.active_org_is_dead(ctx, dead) is True
    assert gr.active_org_is_dead(ctx, alive) is False
    assert gr.active_org_is_dead(ctx, unknown) is False  # неизвестность — не оправдание переезда


def test_onboard_can_register_without_moving_the_mediator(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    journal = gr.Journal()
    pushed: list[str] = []
    gr.command_onboard(
        ctx,
        journal,
        db_path=opencode_db_with_new_login(tmp_path),
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: pushed.append(org.name),
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
        switch_active=False,
    )
    assert journal.finish() == 0
    assert pushed == []
    assert gr.load_registry(ctx.registry_path).find("new@example.com") is not None  # запись всё равно есть


def test_watch_is_quiet_when_there_is_nothing_new(tmp_path: Path) -> None:
    ctx = context(tmp_path, {})
    rebuilt: list[str] = []
    assert watch(tmp_path, ctx, gr.Journal(), opencode_db(tmp_path), rebuilt) == 0
    assert rebuilt == []


def test_watch_survives_a_failed_report_rebuild(tmp_path: Path) -> None:
    """Пересборка отчёта — ускорение, а не условие: её провал сторож не роняет."""

    def boom() -> None:
        raise RuntimeError("systemctl недоступен")

    ctx = context(tmp_path, {})
    rebuilt: list[str] = []
    assert watch(tmp_path, ctx, gr.Journal(), opencode_db_with_new_login(tmp_path), rebuilt, rebuild=boom) == 0


def test_with_lock_lets_one_pass_in_and_skips_the_next(tmp_path: Path) -> None:
    """Таймер не должен запускать второй проход, пока идёт первый."""
    path = tmp_path / ".lock"
    calls: list[int] = []

    def body() -> int:
        assert gr.with_lock(path, lambda: calls.append(2) or 0) == 0  # замок занят — пропуск
        calls.append(1)
        return 7

    assert gr.with_lock(path, body) == 7
    assert calls == [1]


def test_refresh_is_runnable_from_the_command_line(tmp_path: Path) -> None:
    """`refresh` обязан ЗАПУСКАТЬСЯ, а не только вызываться как функция.

    Замер 2026-10-22 00:48Z: `go_refresher.py refresh` падал на
    `AttributeError: 'Namespace' object has no attribute 'lock'` — объявления `--lock`
    у подкоманды не было, а `main` его читает. Тесты на `command_refresh` этого не ловили
    и поймать не могли: они зовут функцию напрямую и разбора командной строки не касаются.
    Поэтому здесь идёт настоящий `main([...])` — настоящая командная строка и файлы, —
    а состояние подобрано так, чтобы никуда не ходить по сети.
    """
    import time  # noqa: PLC0415 — срок берётся от настоящего «сейчас», как у `main`

    state_path = tmp_path / ".go-tokens.json"
    gr.save_state(
        state_path,
        {"console-a": gr.ConsoleToken("acc-a", "ref-a", int(time.time() * 1000) + 30 * DAY_MS)},
    )
    code = gr.main(
        [
            "--registry",
            str(registry_file(tmp_path)),
            "--state",
            str(state_path),
            "--env-file",
            str(tmp_path / "absent.env"),
            "refresh",
            "--lock",
            str(tmp_path / ".go-state.lock"),
        ]
    )
    assert code == 0




# ─── ensure организации в реестре SynqTask (порядок шагов: ensure → uid → реестр → карта) ───


def test_ensure_asks_the_door_with_the_service_pass_and_the_org_model() -> None:
    """Дверь зовётся пропуском СЛУЖБЫ и с моделью организации.

    Модель обязательна при создании: реестр её не выдумывает, и организация без модели —
    это агент без пина, тихая половина факта.
    """
    captured: dict[str, object] = {}

    def fake_http(url, body=None, headers=None, method=None, timeout=None):  # noqa: ANN001
        captured.update({"url": url, "body": body, "headers": headers, "method": method})
        return 200, {"uid": "64c1e57c-3f92-4f38-a1a0-600f23eadcad", "created": False}

    uid, cause = gr.ensure_registry_uid(
        "luxeresit",
        main_model="kiberos-go/deepseek-v4.1-flash-go",
        member_id="4ed24740-9860-4199-bab5-be8fdd5acae6",
        secret="s3cret",
        http=fake_http,
    )

    assert uid == "64c1e57c-3f92-4f38-a1a0-600f23eadcad"
    assert cause == "uid получен"
    assert str(captured["url"]).endswith("/api/orgs/ensure")
    assert captured["method"] == "POST"
    assert captured["body"] == {"name": "luxeresit", "mainModel": "kiberos-go/deepseek-v4.1-flash-go"}
    headers = captured["headers"]
    assert headers["X-Agent-Id"] == "4ed24740-9860-4199-bab5-be8fdd5acae6"
    assert headers["X-Agent-Secret"] == "s3cret"


def test_ensure_refusal_by_rights_is_named_so_the_watcher_cannot_go_quiet() -> None:
    """403 называется «по правам»: это деградация автоподхвата, и она обязана быть видна.

    Снаружи потеря гранта неотличима от «новых входов нет» — сторож отработал бы зелёным
    и промолчал. Признак «по правам» и есть то, по чему вызывающий делает строку громкой.
    """
    uid, cause = gr.ensure_registry_uid(
        "luxeresit",
        main_model="kiberos-go/deepseek-v4.1-flash-go",
        member_id="m",
        secret="s",
        http=lambda *a, **k: (403, {"error": "System admin or the 'org.assign' capability required"}),
    )
    assert uid is None
    assert "по правам" in cause
    assert "org.assign" in cause


def test_ensure_without_uid_is_a_refusal_not_an_empty_pin() -> None:
    uid, cause = gr.ensure_registry_uid(
        "x", main_model="kiberos-go/m", member_id="m", secret="s",
        http=lambda *a, **k: (200, {"name": "x"}),
    )
    assert uid is None
    assert "без uid" in cause


def test_write_registry_uid_puts_the_field_after_workspace_and_keeps_comments(tmp_path: Path) -> None:
    """uid встаёт в СВОЮ запись, после `workspace:`, и ни один комментарий не теряется."""
    registry = tmp_path / "go-orgs.yaml"
    original = (
        "active: a\n"
        "orgs:\n"
        "  # объяснение, которое обязано выжить\n"
        "  - name: a\n"
        "    workspace: wrk_a\n"
        "    auth: console\n"
        "  - name: b\n"
        "    workspace: wrk_b\n"
        "    auth: console\n"
    )
    registry.write_text(original, encoding="utf-8")

    assert gr.write_registry_uid(registry, "b", "uid-b") is True
    text = registry.read_text(encoding="utf-8")

    assert "# объяснение, которое обязано выжить" in text
    # поле b — между workspace и auth внутри записи b
    b_block = text.split("- name: b", 1)[1]
    assert "    workspace: wrk_b\n    synqtask_org_uid: uid-b\n    auth: console\n" in b_block
    # запись a не получила чужой uid
    assert "uid-b" not in text.split("- name: b", 1)[0]


def test_write_registry_uid_is_idempotent_and_never_duplicates(tmp_path: Path) -> None:
    registry = tmp_path / "go-orgs.yaml"
    registry.write_text(
        "orgs:\n  - name: a\n    workspace: wrk_a\n    synqtask_org_uid: old\n    auth: console\n",
        encoding="utf-8",
    )
    assert gr.write_registry_uid(registry, "a", "new") is False
    assert registry.read_text(encoding="utf-8").count("synqtask_org_uid:") == 1


def test_write_registry_uid_does_not_touch_an_unknown_org(tmp_path: Path) -> None:
    registry = tmp_path / "go-orgs.yaml"
    before = "orgs:\n  - name: a\n    workspace: wrk_a\n    auth: console\n"
    registry.write_text(before, encoding="utf-8")
    assert gr.write_registry_uid(registry, "нет-такой", "uid-x") is False
    assert registry.read_text(encoding="utf-8") == before


def test_org_display_name_is_the_full_account_address() -> None:
    """Слово фаундера: организация называется ПОЛНЫМ именем учётки, не левой частью."""
    assert gr.org_display_name("hello@myfamily.quest", "acc_1", {"console-a"}) == "hello@myfamily.quest"


def test_org_display_name_keeps_two_hellos_apart_by_their_domain() -> None:
    """Замер 2026-10-21 21:40Z: hello@kiberos.app была в базе, а в пул не попала.

    Сторож брал часть адреса до собачки — оба входа становились `hello`, имя было занято,
    и новая подписка выбрасывалась строкой «запись с таким именем уже в реестре».
    """
    taken = {"hello@myfamily.quest"}
    assert gr.org_display_name("hello@kiberos.app", "acc_2", taken) == "hello@kiberos.app"


def test_org_display_name_falls_back_to_account_id_without_an_address() -> None:
    assert gr.org_display_name("", "acc_NOEMAIL", set()) == "acc_NOEMAIL"


def test_org_display_name_separates_two_logins_of_the_same_account() -> None:
    taken = {"hello@kiberos.app"}
    assert gr.org_display_name("hello@kiberos.app", "acc_2", taken) == "hello@kiberos.app#acc_2"


def test_onboard_registers_both_logins_sharing_a_local_part(tmp_path: Path) -> None:
    """Один проход, два входа `hello@…` — в реестре обе организации, имена = адреса."""
    db = tmp_path / "opencode-two-hellos.db"
    connection = sqlite3.connect(db)
    connection.execute(
        "create table account (id text primary key, email text, url text, access_token text, "
        "refresh_token text, token_expiry integer, time_created integer, time_updated integer)"
    )
    connection.execute(
        "create table account_state (id integer primary key, active_account_id text, active_org_id text)"
    )
    for index, (account_id, email, workspace) in enumerate(
        (
            ("acc_H1", "hello@myfamily.quest", "wrk_1"),
            ("acc_H2", "hello@kiberos.app", "wrk_2"),
        )
    ):
        connection.execute(
            "insert into account values (?,?, 'https://opencode.ai/console','acc','ref',?,?,0)",
            (account_id, email, NOW_MS + 30 * DAY_MS, index),
        )
        connection.execute(
            "insert into account_state values (?,?,?)", (index + 1, account_id, workspace)
        )
    connection.commit()
    connection.close()

    ctx = context(tmp_path, {})
    gr.command_onboard(
        ctx,
        gr.Journal(),
        db_path=db,
        model="m",
        probe_call=lambda org, secret: (True, "ответ получен"),
        push=lambda org, secret: None,
        usage_call=lambda org, secret: gr.Usage(windows={"weekly": {"status": "ok", "percent": 1}}),
    )
    names = [org.name for org in gr.load_registry(ctx.registry_path).orgs]
    assert "hello@myfamily.quest" in names and "hello@kiberos.app" in names
    assert len(names) == len(set(names))


# ── слияние очереди новых входов (23.10) ──


def _journal():
    return gr.Journal(notify_cmd=None)


def test_merge_incoming_moves_new_login_into_state(tmp_path: Path) -> None:
    """Вход в opencode лежит в очереди; хранилище до слияния его не знает.

    Замер 23.10 (hello@torqhub.net): организация оплачена, дверь отвечает, а в хранилище
    её нет — потому что слияние делать было некому. Здесь оно делается тем же писателем.
    """
    state = tmp_path / ".go-tokens.json"
    incoming = tmp_path / ".go-tokens.incoming.json"
    gr.save_state(state, {"console-a": gr.ConsoleToken("acc-a", "ref-a", NOW_MS + DAY_MS)})
    gr.save_state(incoming, {"console-new": gr.ConsoleToken("acc-n", "ref-n", NOW_MS + 2 * DAY_MS)})
    merged = gr.merge_incoming_into_state(state, _journal())
    assert merged == ["console-new"]
    assert set(gr.load_state(state)) == {"console-a", "console-new"}
    assert not incoming.exists()


def test_merge_does_not_overwrite_a_fresher_store_entry(tmp_path: Path) -> None:
    """Очередь могла пролежать, пока мы продлевали ту же организацию: побеждает больший срок."""
    state = tmp_path / ".go-tokens.json"
    incoming = tmp_path / ".go-tokens.incoming.json"
    gr.save_state(state, {"console-a": gr.ConsoleToken("fresh", "ref-fresh", NOW_MS + 5 * DAY_MS)})
    gr.save_state(incoming, {"console-a": gr.ConsoleToken("stale", "ref-stale", NOW_MS + DAY_MS)})
    assert gr.merge_incoming_into_state(state, _journal()) == []
    assert gr.load_state(state)["console-a"].access_token == "fresh"
    assert not incoming.exists()


def test_merge_is_off_when_the_proxy_becomes_the_writer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Два писателя на один файл обесценивают ротируемый ключ (риск R8) — и это не тишина."""
    state = tmp_path / ".go-tokens.json"
    incoming = tmp_path / ".go-tokens.incoming.json"
    gr.save_state(state, {})
    gr.save_state(incoming, {"console-new": gr.ConsoleToken("acc", "ref", NOW_MS + DAY_MS)})
    monkeypatch.setenv("GO_TOKEN_REFRESH_ENABLED", "true")
    assert gr.merge_incoming_into_state(state, _journal()) == []
    assert incoming.exists(), "очередь обязан слить её владелец, не мы"
