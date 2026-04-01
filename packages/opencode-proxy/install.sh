#!/bin/bash
# Script: install.sh
# Created: 2026-04-01
# Purpose: Install opencode-claude launcher to ~/.local/bin
# Keywords: opencode, proxy, install, launcher
# Status: active

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
TARGET="${BIN_DIR}/opencode-claude"

mkdir -p "$BIN_DIR"

cat > "$TARGET" << EOF
#!/bin/bash
exec /home/relishev/.bun/bin/bun run "${SCRIPT_DIR}/launch.ts" "\$@"
EOF

chmod +x "$TARGET"

# Ensure ~/.local/bin is in PATH
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  echo ""
  echo "⚠️  Add to your shell profile (~/.bashrc or ~/.zshrc):"
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "✅ Installed: opencode-claude"
echo ""
echo "Usage:"
echo "  opencode-claude                          # auto-detect opencode + start proxy"
echo "  opencode-claude --model claude-opus-4-6  # specify default model"
echo "  opencode-claude --port 4041              # custom port"
echo "  opencode-claude -- --cwd /my/project     # pass args to opencode"
echo ""
echo "Or use proxy standalone:"
echo "  bun run ${SCRIPT_DIR}/server.ts"
echo "  LOCAL_ENDPOINT=http://localhost:4040/v1 opencode"
