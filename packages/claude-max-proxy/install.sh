#!/usr/bin/env bash
# claude-max — one-line installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/LifeAITools/opencode-claude-toolkit/main/packages/claude-max-proxy/install.sh | bash
#
# What it does (idempotent — safe to re-run):
#   1. Ensures npm is installed (bails with instructions if not).
#   2. Configures ~/.npmrc to resolve @kiberos/* from https://npm.muid.io
#   3. Installs (or upgrades) @kiberos/claude-max-proxy globally.
#   4. Prints next-steps (just run `claude-max`).
#
# This script ONLY installs the CLI entrypoint. First invocation of
# `claude-max` handles everything else (bun, launchd/systemd, proxy boot)
# automatically.

set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD='\033[1m'; DIM='\033[2m'; RED='\033[31m'; GREEN='\033[32m'
  YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

info() { echo -e "${CYAN}→${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }

echo
echo -e "  ${BOLD}${CYAN}claude-max${RESET} ${DIM}— warm-cache proxy for Claude Code CLI${RESET}"
echo

# ─── 1. Node.js + npm check ─────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found. Install Node.js first:"
  echo "    macOS:  brew install node"
  echo "    other:  https://nodejs.org"
  exit 1
fi
ok "npm $(npm --version) present"

# ─── 2. Configure private registry for @kiberos scope ───────────
NPMRC="${HOME}/.npmrc"
REGISTRY_LINE='@kiberos:registry=https://npm.muid.io/'

if [[ -f "$NPMRC" ]] && grep -qF "$REGISTRY_LINE" "$NPMRC"; then
  ok "~/.npmrc already has @kiberos scope configured"
else
  info "Adding @kiberos scope to ~/.npmrc"
  echo "$REGISTRY_LINE" >> "$NPMRC"
  ok "Appended registry config"
fi

# ─── 3. Install (or upgrade) @kiberos/claude-max-proxy ─────────
#
# Use `npm install -g` — bun/node-anything install unambiguously via npm.
# If already installed, this upgrades to latest.

info "Installing @kiberos/claude-max-proxy globally..."
if npm install -g @kiberos/claude-max-proxy 2>&1 | tail -5; then
  ok "Installed"
else
  err "npm install failed."
  echo "  If permission denied, try:  sudo npm install -g @kiberos/claude-max-proxy"
  echo "  or set npm prefix:          npm config set prefix ~/.npm-global"
  exit 1
fi

# ─── 4. Verify CLI is in PATH ───────────────────────────────────
if ! command -v claude-max >/dev/null 2>&1; then
  NPM_PREFIX=$(npm config get prefix)
  warn "claude-max binary installed at ${NPM_PREFIX}/bin/ but not in PATH"
  echo
  echo "  Add this to your shell rc (~/.zshrc on macOS, ~/.bashrc on Linux):"
  echo "    ${DIM}export PATH=\"${NPM_PREFIX}/bin:\$PATH\"${RESET}"
  echo
  echo "  Or just run:  ${DIM}${NPM_PREFIX}/bin/claude-max${RESET}"
else
  ok "claude-max installed: $(command -v claude-max)"
fi

# ─── Done ───────────────────────────────────────────────────────
echo
echo -e "  ${GREEN}${BOLD}Setup complete.${RESET}"
echo
echo -e "  ${BOLD}Next:${RESET} just run ${CYAN}claude-max${RESET}"
echo -e "  ${DIM}(first run auto-installs bun + claude CLI + launchd/systemd service,${RESET}"
echo -e "  ${DIM}then launches Claude Code with warm-cache proxy.)${RESET}"
echo
echo -e "  ${DIM}Other commands:${RESET}"
echo -e "  ${DIM}  claude-max doctor    — self-check${RESET}"
echo -e "  ${DIM}  claude-max watch     — live TUI dashboard${RESET}"
echo -e "  ${DIM}  claude-max status    — current state${RESET}"
echo
