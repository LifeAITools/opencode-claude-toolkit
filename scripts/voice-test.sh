#!/bin/bash
# Voice Input Pre-flight Check & Launch
# Usage: bash scripts/voice-test.sh [project-dir]

set -e

PROJECT_DIR="${1:-$HOME/test-cache}"
PLUGIN_DIR="/mnt/d/Vibe_coding_projects/claude-code-sdk/packages/opencode-claude"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "   $1"; }

echo "═══════════════════════════════════════"
echo "  Voice Input — Pre-flight Check"
echo "═══════════════════════════════════════"
echo ""

ERRORS=0

# 1. Audio recording tool
echo "1. Audio Recording"
if which rec >/dev/null 2>&1; then
  pass "SoX (rec) installed: $(which rec)"
elif which arecord >/dev/null 2>&1; then
  pass "arecord installed: $(which arecord)"
else
  warn "No recording tool found — attempting auto-install..."
  if which apt-get >/dev/null 2>&1; then
    sudo apt-get install -y sox alsa-utils 2>/dev/null && pass "Installed sox + alsa-utils" || { fail "Auto-install failed. Run: sudo apt install sox"; ERRORS=$((ERRORS+1)); }
  elif which brew >/dev/null 2>&1; then
    brew install sox 2>/dev/null && pass "Installed sox via brew" || { fail "Auto-install failed. Run: brew install sox"; ERRORS=$((ERRORS+1)); }
  else
    fail "No package manager found. Install manually: sudo apt install sox"
    ERRORS=$((ERRORS+1))
  fi
fi

# 2. OAuth credentials
echo ""
echo "2. OAuth Credentials"
CRED_FILE="$HOME/.claude/.credentials.json"
if [ -f "$CRED_FILE" ]; then
  TOKEN=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); t=d.get('claudeAiOauth',{}).get('accessToken',''); print(t[:20]+'...' if t else '')" 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    pass "OAuth token found: $TOKEN"
  else
    fail "Credential file exists but no accessToken. Run: opencode providers login -p claude-max"
    ERRORS=$((ERRORS+1))
  fi
else
  fail "No credentials at $CRED_FILE. Run: opencode providers login -p claude-max"
  ERRORS=$((ERRORS+1))
fi

# 3. Plugin files
echo ""
echo "3. Plugin Files"
if [ -f "$PLUGIN_DIR/voice-tui.tsx" ]; then
  LINES=$(wc -l < "$PLUGIN_DIR/voice-tui.tsx")
  pass "voice-tui.tsx exists ($LINES lines)"
else
  fail "voice-tui.tsx not found at $PLUGIN_DIR"
  ERRORS=$((ERRORS+1))
fi

if [ -f "$PLUGIN_DIR/tui.tsx" ]; then
  pass "tui.tsx exists (cache sidebar)"
fi

# 4. Compile check
echo ""
echo "4. Compile Check"
if which bun >/dev/null 2>&1; then
  RESULT=$(cd /mnt/d/Vibe_coding_projects/claude-code-sdk && bun build --no-bundle packages/opencode-claude/voice-tui.tsx --outdir /tmp/voice-check 2>&1)
  if echo "$RESULT" | grep -q "Transpiled"; then
    pass "voice-tui.tsx compiles OK"
  else
    fail "Compile error: $RESULT"
    ERRORS=$((ERRORS+1))
  fi
else
  warn "bun not found — skipping compile check"
fi

# 5. Project setup
echo ""
echo "5. Test Project Setup"
mkdir -p "$PROJECT_DIR/.opencode"

# Create project-level tui.json with voice plugin
cat > "$PROJECT_DIR/.opencode/tui.json" << EOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "$PLUGIN_DIR",
    "$PLUGIN_DIR/voice-tui.tsx"
  ]
}
EOF
pass "Created $PROJECT_DIR/.opencode/tui.json"
info "  Cache plugin: $PLUGIN_DIR (./tui export)"
info "  Voice plugin: $PLUGIN_DIR/voice-tui.tsx"

# 6. Microphone test
echo ""
echo "6. Microphone Quick Test"
if which rec >/dev/null 2>&1; then
  # Record 1 second, check if we get data
  TEMPFILE=$(mktemp /tmp/mic-test-XXXXXX.raw)
  timeout 2 rec -q -r 16000 -c 1 -b 16 -e signed-integer -t raw "$TEMPFILE" trim 0 1 2>/dev/null || true
  SIZE=$(stat -c%s "$TEMPFILE" 2>/dev/null || stat -f%z "$TEMPFILE" 2>/dev/null || echo "0")
  rm -f "$TEMPFILE"
  if [ "$SIZE" -gt 1000 ]; then
    pass "Microphone working ($SIZE bytes captured in 1s)"
  else
    warn "Microphone may not be available (got $SIZE bytes). Voice will fail if no mic access."
  fi
elif which arecord >/dev/null 2>&1; then
  TEMPFILE=$(mktemp /tmp/mic-test-XXXXXX.raw)
  timeout 2 arecord -f S16_LE -r 16000 -c 1 -t raw -q "$TEMPFILE" 2>/dev/null || true
  SIZE=$(stat -c%s "$TEMPFILE" 2>/dev/null || echo "0")
  rm -f "$TEMPFILE"
  if [ "$SIZE" -gt 1000 ]; then
    pass "Microphone working ($SIZE bytes captured)"
  else
    warn "Microphone may not be available. Check: arecord -l"
  fi
else
  warn "Skipping mic test — no recording tool"
fi

# Summary
echo ""
echo "═══════════════════════════════════════"
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}  All checks passed!${NC}"
  echo ""
  echo "  Launch:"
  echo -e "    ${YELLOW}cd $PROJECT_DIR && opencode${NC}"
  echo ""
  echo "  Inside opencode:"
  echo "    /voice    — toggle recording"
  echo "    /v        — same (alias)"
  echo "    Speak → wait 3s silence → text in prompt"
  echo ""
  echo "  After testing:"
  echo "    grep -i 'voice\|transcript' ~/.claude/claude-max-debug.log | tail -20"
else
  echo -e "${RED}  $ERRORS check(s) failed — fix before testing${NC}"
fi
echo "═══════════════════════════════════════"
