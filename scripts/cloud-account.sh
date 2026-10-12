#!/usr/bin/env bash
# cloud-account — собрать ИЗОЛИРОВАННЫЙ каталог конфигурации CLI (CLAUDE_CONFIG_DIR)
# для аккаунта Claude, чей ключ лежит в хранилище прокси (org-vault.json), чтобы
# `claude --cloud` ходил ПОД ЭТИМ аккаунтом, не трогая общий вход флота.
#
# ЗАЧЕМ: облачные операции (`claude --cloud` / `--teleport`) берут ВХОД CLI в
# claude.ai (~/.claude/.credentials.json), а НЕ токен прокси. Токены организаций у
# нас уже собран­ы в org-vault (их обновляет прокси), но лежат они ОТДЕЛЬНО от входа.
# Эта ручка переносит ключ нужной организации в свой каталог конфигурации — входить
# в браузере не нужно.
#
# ИСПОЛЬЗОВАНИЕ:
#   cloud-account <orgId-префикс | почта | имя организации>
# Печатает путь каталога (CLAUDE_CONFIG_DIR); описание — в stderr.
#
# НАСТРОЙКИ (env):
#   CLAUDE_ORG_VAULT   путь к хранилищу (по умолчанию ~/.claude-local/org-vault.json)
set -euo pipefail

VAULT="${CLAUDE_ORG_VAULT:-$HOME/.claude-local/org-vault.json}"
REF="${1:?usage: cloud-account <orgId-prefix|email|orgName>}"
[ -f "$VAULT" ] || { echo "хранилище не найдено: $VAULT" >&2; exit 2; }

python3 - "$VAULT" "$REF" <<'PY'
import json, sys, os, time
vault, ref = sys.argv[1], sys.argv[2].lower()
d = json.load(open(vault))
match = None
for oid, o in d.get('orgs', {}).items():
    hay = [str(oid), str(o.get('orgId', '')), str(o.get('accountEmail', '')), str(o.get('orgName', ''))]
    if any(ref in h.lower() or h.lower() in ref for h in hay):
        match = (oid, o)
        break
if not match:
    sys.stderr.write("ни одна организация не совпала с %r\n" % ref)
    sys.exit(3)
oid, o = match
slug = oid.split('-')[0]
cfg = os.path.expanduser('~/.claude-cloud-' + slug)
os.makedirs(cfg, exist_ok=True)
os.chmod(cfg, 0o700)

# Вход CLI: копируем ФОРМУ от текущего входа (scopes/subscriptionType), подставляем
# токены нужной организации из хранилища.
main_cred = os.path.expanduser('~/.claude/.credentials.json')
cur = {}
if os.path.exists(main_cred):
    cur = json.load(open(main_cred)).get('claudeAiOauth', {}) or {}
cred = {'claudeAiOauth': {
    'accessToken': o['accessToken'],
    'refreshToken': o.get('refreshToken', ''),
    'expiresAt': int(o['expiresAt']),
    'scopes': cur.get('scopes'),
    'subscriptionType': cur.get('subscriptionType', 'max'),
    'rateLimitTier': cur.get('rateLimitTier', 'default_claude_max_20x'),
}}
p = os.path.join(cfg, '.credentials.json')
json.dump(cred, open(p, 'w'))
os.chmod(p, 0o600)

# Состояние аккаунта (онбординг + доверие папкам) берём из общего конфига, чтобы
# облачный запуск не вставал на диалогах. Доверие ТЕКУЩЕЙ папке ставим явно.
main_cfg = os.path.expanduser('~/.claude.json')
if os.path.exists(main_cfg):
    m = json.load(open(main_cfg))
    m['hasCompletedOnboarding'] = True
    proj = m.setdefault('projects', {})
    proj.setdefault(os.getcwd(), {})['hasTrustDialogAccepted'] = True
    json.dump(m, open(os.path.join(cfg, '.claude.json'), 'w'))

mins = round((int(o['expiresAt']) / 1000 - time.time()) / 60)
sys.stderr.write("account=%s org=%s accessValidMin=%d cfg=%s\n"
                 % (o.get('accountEmail'), oid, mins, cfg))
print(cfg)
PY
