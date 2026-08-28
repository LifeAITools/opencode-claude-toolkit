#!/usr/bin/env bash
# claude-max — one-line installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://get.muid.io/claude-max | bash
#
# What it does (idempotent — safe to re-run):
#   1. Ensures Node.js + npm present (auto-installs via nvm if missing)
#   1.5 Ensures bun present (the claude-max CLI itself runs on bun — without it
#      nothing below can even start; `doctor` cannot bootstrap it, see step 1.5)
#   2. Configures ~/.npmrc to resolve @kiberos/* and @life-ai-tools/*
#      from https://npm.muid.io
#   3. Installs (or upgrades) @kiberos/claude-max-proxy globally
#   4. First invocation of `claude-max` auto-installs the claude CLI
#      + launchd/systemd service, then launches Claude Code with warm cache
#
# Supported: macOS (Intel/ARM), Linux (x86_64/aarch64)
# Unsupported: Windows (use WSL2)

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
step() { echo; echo -e "${BOLD}${CYAN}▸${RESET} ${BOLD}$*${RESET}"; }

# ─── Platform detection ─────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin)  PLATFORM=macos ;;
  Linux)   PLATFORM=linux ;;
  *)
    err "Unsupported OS: $OS (macOS and Linux only)"
    exit 1
    ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)   ARCH=x64 ;;
  arm64|aarch64)  ARCH=arm64 ;;
  *)
    warn "Unusual architecture: $ARCH — proceeding anyway"
    ;;
esac

echo
echo -e "  ${BOLD}${CYAN}claude-max${RESET} ${DIM}— warm-cache proxy for Claude Code CLI${RESET}"
echo -e "  ${DIM}Platform: ${PLATFORM}/${ARCH}${RESET}"
echo

# ─── 1. Node.js + npm ───────────────────────────────────────────
# Strategy: if npm exists and is callable, use it. Otherwise bootstrap via nvm
# into ~/.nvm (user-local, no sudo needed).

install_node_via_nvm() {
  step "Bootstrapping Node.js via nvm (user-local, no sudo)"

  # Install nvm
  if [[ ! -d "$HOME/.nvm" ]]; then
    info "Downloading nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
  fi

  # Load nvm into this shell
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if ! command -v nvm >/dev/null 2>&1; then
    err "nvm install appears to have succeeded but nvm command not found."
    err "Open a new terminal and re-run this installer."
    exit 1
  fi

  # Install Node LTS
  info "Installing Node.js LTS via nvm…"
  nvm install --lts >/dev/null 2>&1
  nvm use --lts >/dev/null 2>&1
  nvm alias default lts/* >/dev/null 2>&1 || true

  ok "Node.js $(node --version) installed via nvm"
}

if ! command -v npm >/dev/null 2>&1; then
  warn "npm not found — will bootstrap Node.js via nvm"
  install_node_via_nvm
else
  NPM_V="$(npm --version 2>/dev/null || echo 'unknown')"
  NODE_V="$(node --version 2>/dev/null || echo 'unknown')"
  ok "npm ${NPM_V} + node ${NODE_V} present"
fi

# ─── 1.5. Bun — the CLI itself runs on it ───────────────────────
#
# 🔴 WHY THIS STEP EXISTS (measured 2026-08-28 on a clean machine, in a container).
# Step 5 below says "doctor will install bun", and that could never be true:
# `bin/claude-max` starts with `#!/usr/bin/env bun`, so the doctor cannot install
# bun — it cannot run without it. On a clean machine the install reached the end,
# printed "Setup complete", and the first thing the user saw was
# `/usr/bin/env: 'bun': No such file or directory` — after which no claude-max
# command worked at all. The chicken-and-egg can only be broken here, in the step
# that plain bash executes.
if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version) present"
else
  step "Installing bun (the claude-max CLI runs on it)"
  # bun's installer needs unzip; a bare image may not have it, and then it fails
  # with a message about unzip rather than about the network — say so up front.
  if ! command -v unzip >/dev/null 2>&1; then
    warn "unzip not found — bun's installer needs it"
    echo "    Debian/Ubuntu: ${DIM}sudo apt-get install -y unzip${RESET}"
    echo "    Fedora/RHEL:   ${DIM}sudo dnf install -y unzip${RESET}"
  fi
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "bun could not be installed automatically."
    echo "  Install it by hand, then re-run this installer:"
    echo "    ${DIM}curl -fsSL https://bun.sh/install | bash${RESET}"
    exit 1
  fi
  ok "bun $(bun --version) installed → ${BUN_INSTALL}/bin"
fi

# ─── 2. Configure private registry scopes ───────────────────────
NPMRC="${HOME}/.npmrc"
KIBEROS_LINE='@kiberos:registry=https://npm.muid.io/'
LIFEAITOOLS_LINE='@life-ai-tools:registry=https://npm.muid.io/'

touch "$NPMRC"

add_line_if_missing() {
  local line="$1" label="$2"
  if grep -qF "$line" "$NPMRC" 2>/dev/null; then
    ok "${label} scope already configured in ~/.npmrc"
  else
    info "Adding ${label} scope to ~/.npmrc"
    echo "$line" >> "$NPMRC"
  fi
}

add_line_if_missing "$KIBEROS_LINE"      "@kiberos"
add_line_if_missing "$LIFEAITOOLS_LINE"  "@life-ai-tools"

# ─── 3. Install (or upgrade) @kiberos/claude-max-proxy ──────────
step "Installing @kiberos/claude-max-proxy globally"

# Retry once with -g if plain install fails (e.g. permission issue on older setups)
if ! npm install -g @kiberos/claude-max-proxy 2>&1 | tail -3; then
  if [[ "$PLATFORM" == "linux" ]]; then
    err "npm install failed. Possible causes and fixes:"
    echo "  1. Permission denied on /usr/lib/node_modules:"
    echo "     sudo npm install -g @kiberos/claude-max-proxy"
    echo "  2. Or set a user-writable prefix:"
    echo "     mkdir -p ~/.npm-global"
    echo "     npm config set prefix ~/.npm-global"
    echo "     export PATH=~/.npm-global/bin:\$PATH"
    echo "     npm install -g @kiberos/claude-max-proxy"
  else
    err "npm install failed. Try:"
    echo "     sudo npm install -g @kiberos/claude-max-proxy"
  fi
  exit 1
fi
ok "Package installed"

# ─── 4. Verify claude-max on PATH ───────────────────────────────
if ! command -v claude-max >/dev/null 2>&1; then
  NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "~/.npm-global")
  warn "claude-max installed at ${NPM_PREFIX}/bin/ but not on PATH"
  echo
  echo "  Add this to your shell rc file:"
  echo "    ${DIM}export PATH=\"${NPM_PREFIX}/bin:\$PATH\"${RESET}"
  echo
  echo "  Or run directly: ${DIM}${NPM_PREFIX}/bin/claude-max${RESET}"
  echo
else
  CLAUDE_MAX_PATH="$(command -v claude-max)"
  ok "claude-max installed: ${CLAUDE_MAX_PATH}"
fi

# ─── 5. Run doctor (self-install claude CLI / service if missing) ─
step "Running claude-max doctor (auto-heal missing deps)"
echo

if command -v claude-max >/dev/null 2>&1; then
  # doctor auto-heals what it CAN reach from inside bun: the claude CLI, the
  # systemd/launchd unit, starting the proxy. bun itself is step 1.5's job — see
  # the note there.
  claude-max doctor || warn "doctor returned non-zero — check output above"
fi

# ─── Done ───────────────────────────────────────────────────────
echo
echo -e "  ${GREEN}${BOLD}Setup complete.${RESET}"
echo
echo -e "  ${BOLD}Next:${RESET} run ${CYAN}claude-max${RESET} — launches Claude Code with warm-cache proxy"
echo
echo -e "  ${DIM}Other commands:${RESET}"
echo -e "  ${DIM}  claude-max doctor    — self-check + auto-heal${RESET}"
echo -e "  ${DIM}  claude-max status    — current state${RESET}"
echo -e "  ${DIM}  claude-max watch     — live TUI dashboard${RESET}"
echo -e "  ${DIM}  claude-max logs -f   — tail proxy logs${RESET}"
echo -e "  ${DIM}  claude-max stop      — stop proxy service${RESET}"
echo
