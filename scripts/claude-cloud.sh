#!/usr/bin/env bash
# claude-cloud — обёртка для облачных операций Claude Code (--cloud / --teleport).
#
# ЗАЧЕМ: ~/.claude/settings.json кладёт env.ANTHROPIC_AUTH_TOKEN (прокси-токен) и
# ANTHROPIC_BASE_URL (http://127.0.0.1:4000). Этот токен у CLI ГЛАВНЕЕ входа в
# claude.ai, поэтому claude.ai-коннекторы и облачные функции глушатся, а
# `claude --teleport` отваливается: «claude.ai connectors are disabled because
# ANTHROPIC_API_KEY or another auth source is set and takes precedence».
#
# ЧТО ДЕЛАЕМ: на время облачного вызова грузим ДОПОЛНИТЕЛЬНЫЙ settings-файл, где эти
# две переменные пусты — вход в claude.ai снова становится главным. Обычный путь
# флота (ходы через прокси :4000) НЕ трогается: правится только этот вызов.
#
# ИСПОЛЬЗОВАНИЕ:
#   claude-cloud --cloud "задача"          # создать облачную сессию (нужен живой TTY)
#   claude-cloud --teleport <session-id>   # втянуть сессию к себе (нужен живой TTY)
#   claude-cloud -p "текст" --cloud <id>   # записать в готовую сессию (TTY не нужен)
#   claude-cloud --org <ref> --cloud "…"   # под АККАУНТОМ из org-vault (свой CLAUDE_CONFIG_DIR)
#
# --org <ref>: облако берёт ВХОД CLI, а не токен прокси. Этот флаг разворачивает
# изолированный каталог конфигурации для аккаунта, чей ключ уже лежит в org-vault
# (общий вход флота не трогается) — входить в браузере не нужно.
set -euo pipefail

if [ "${1:-}" = "--org" ]; then
  ORG="${2:?--org требует orgId-префикс/почту/имя организации}"
  shift 2
  ACCOUNT="${CLAUDE_CLOUD_ACCOUNT:-$(dirname "$0")/cloud-account.sh}"
  [ -x "$ACCOUNT" ] || { echo "cloud-account.sh не найден: $ACCOUNT" >&2; exit 2; }
  export CLAUDE_CONFIG_DIR="$("$ACCOUNT" "$ORG")"
fi

CFG="${CLAUDE_CLOUD_SETTINGS:-$HOME/.claude/cloud-settings.json}"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  printf '%s' '{"env":{"ANTHROPIC_AUTH_TOKEN":"","ANTHROPIC_BASE_URL":""}}' > "$CFG"
fi

# 🔴 БИНАРНИК ИЩЕТСЯ ЯВНО (замер vibe-kiberos-app-owner 18.10): 1 прогон из 11 упал
# пустым выводом — `exec: claude: not found` (строка 39), потому что панель tmux
# унаследовала окружение СЕРВЕРА tmux, а не нашей оболочки, и `~/.local/bin` в PATH
# не оказался. Непостоянство опаснее постоянной поломки: выглядит как «прогон не пошёл».
# Поэтому: абсолютный путь + ГРОМКИЙ отказ, а не молчаливое «claude не найден».
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$HOME/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "claude-cloud: бинарник claude не найден (искали в PATH и в $HOME/.local/bin)." >&2
  echo "  Передайте CLAUDE_BIN=/путь/к/claude или поправьте PATH." >&2
  exit 127
fi

exec "$CLAUDE_BIN" --settings "$CFG" "$@"
