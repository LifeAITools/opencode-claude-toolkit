#!/usr/bin/env python3
"""Rename ONE organisation key across the Go registry and both token stores.

WHY THIS EXISTS (founder 2026-10-22): «организация у нас должна только целиком называться,
никогда не Hello, потому что у нас Hello много организаций». One entry is still named `hello`
while its address is `hello@myfamily.quest`, next to `hello@kiberos.app` and
`hello@uniclowd.com` — three organisations sharing one local part.

🔴 IT IS A KEY MIGRATION, NOT A COSMETIC RENAME. The name is the ROUTING key: it travels in the
agent's `KIBEROS_GO_ORG`, in the `x-kiberos-go-org` header, in `active:` and as the key of the
token stores. `go_orgs.py:213-233` answers HTTP 400 for a request that names an org the registry
does not have — so an agent still carrying the OLD name starts failing the moment the key is
renamed. That is why the script only ever REPORTS live agents and never touches them: their birth
is the launcher's job, in a window where the two steps happen back to back.

SAFETY: dry-run by default; refuses when the target name already exists; writes `.backup` copies
before applying; verifies by re-reading what it wrote.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

def _read_tokens(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))

def _plan(registry: Path, old: str, new: str) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    lines = registry.read_text(encoding="utf-8").splitlines(keepends=True)
    hits = [i for i, ln in enumerate(lines) if ln.strip() == f"- name: {old}"]
    if len(hits) != 1:
        errors.append(f"registry: expected exactly ONE line `- name: {old}`, found {len(hits)}")
    if any(ln.strip() == f"- name: {new}" for ln in lines):
        errors.append(f"registry: `{new}` already exists — refusing to merge two organisations")
    return errors, [str(registry)]

def migrate(registry: Path, tokens: list[Path], old: str, new: str, apply: bool) -> int:
    errors, _ = _plan(registry, old, new)
    stores = {}
    for p in tokens:
        d = _read_tokens(p)
        orgs = d.get("orgs") or {}
        if old in orgs and new in orgs:
            errors.append(f"{p.name}: both `{old}` and `{new}` exist — refusing")
        stores[p] = (d, old in orgs)
    if errors:
        for e in errors:
            print(f"ОТКАЗ: {e}", file=sys.stderr)
        return 2

    print(f"переименование: {old} → {new}")
    print(f"  реестр:        {registry}  (строка `- name: {old}`)")
    for p, (_, present) in stores.items():
        print(f"  хранилище:     {p.name}  (ключ: {'есть' if present else 'НЕТ — пропуск'})")
    if not apply:
        print("\nЭТО ПРОГОН ВХОЛОСТУЮ. Ничего не записано. Повтори с --apply.")
        return 0

    shutil.copy2(registry, registry.with_suffix(registry.suffix + ".backup"))
    text = registry.read_text(encoding="utf-8")
    text = text.replace(f"  - name: {old}\n", f"  - name: {new}\n", 1)
    registry.write_text(text, encoding="utf-8")

    for p, (d, present) in stores.items():
        if not present:
            continue
        shutil.copy2(p, p.with_suffix(p.suffix + ".backup"))
        orgs = d["orgs"]
        orgs[new] = orgs.pop(old)
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # VERIFY by re-reading: a rename that only looks done is the failure this guards against.
    ok = True
    lines = registry.read_text(encoding="utf-8").splitlines()
    if not any(ln.strip() == f"- name: {new}" for ln in lines):
        print("ПРОВЕРКА ПРОВАЛЕНА: в реестре нет новой записи", file=sys.stderr); ok = False
    if any(ln.strip() == f"- name: {old}" for ln in lines):
        print("ПРОВЕРКА ПРОВАЛЕНА: старое имя осталось в реестре", file=sys.stderr); ok = False
    for p in tokens:
        orgs = (_read_tokens(p).get("orgs") or {})
        if new not in orgs and old in orgs:
            print(f"ПРОВЕРКА ПРОВАЛЕНА: {p.name} потерял организацию", file=sys.stderr); ok = False
        if old in orgs:
            print(f"ПРОВЕРКА ПРОВАЛЕНА: {p.name} всё ещё держит {old}", file=sys.stderr); ok = False
    print("проверка по перечитыванию: " + ("OK" if ok else "ЕСТЬ ПРОБЛЕМЫ"))
    return 0 if ok else 3

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", required=True, type=Path)
    ap.add_argument("--tokens", nargs="*", default=[], type=Path)
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    return migrate(a.registry, a.tokens, a.old, a.new, a.apply)

if __name__ == "__main__":
    raise SystemExit(main())
