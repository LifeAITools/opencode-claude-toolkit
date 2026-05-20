#!/usr/bin/env bash
# check-cc-compat — compares CC_COMPAT_VERSION constant to installed @anthropic-ai/claude-code package version.
# Exits 0 if matched OR if installed package not found (warn).
# Exits 1 if minor-version drift (e.g. installed 2.1.115 vs constant 2.1.90 → drift +25 patch versions).
# Run: bash packages/opencode-claude/scripts/check-cc-compat.sh
set -eo pipefail

CC_PKG="${HOME}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json"
SDK_FILE="$(cd "$(dirname "$0")/../../.." && pwd)/src/sdk.ts"

if [ ! -f "$CC_PKG" ]; then
  echo "WARN: @anthropic-ai/claude-code not installed at $CC_PKG; skipping check" >&2
  exit 0
fi

INSTALLED=$(jq -r .version "$CC_PKG")
SDK_VERSION=$(grep -oE "CC_COMPAT_VERSION = '[0-9.]+'" "$SDK_FILE" | grep -oE "[0-9.]+")

if [ -z "$SDK_VERSION" ]; then
  echo "ERROR: could not extract CC_COMPAT_VERSION from $SDK_FILE" >&2
  exit 2
fi

echo "Installed: $INSTALLED  SDK constant: $SDK_VERSION"

if [ "$INSTALLED" != "$SDK_VERSION" ]; then
  # Compute patch-version drift if same major.minor
  INST_MM=$(echo "$INSTALLED" | cut -d. -f1-2)
  SDK_MM=$(echo "$SDK_VERSION" | cut -d. -f1-2)
  if [ "$INST_MM" != "$SDK_MM" ]; then
    echo "DRIFT: major.minor differs ($SDK_MM vs $INST_MM). Bump CC_COMPAT_VERSION in src/sdk.ts." >&2
    exit 1
  fi
  INST_PATCH=$(echo "$INSTALLED" | cut -d. -f3)
  SDK_PATCH=$(echo "$SDK_VERSION" | cut -d. -f3)
  DRIFT=$((INST_PATCH - SDK_PATCH))
  if [ "$DRIFT" -gt 5 ] || [ "$DRIFT" -lt -5 ]; then
    echo "DRIFT: patch versions differ by $DRIFT (>5). Consider bumping CC_COMPAT_VERSION." >&2
    exit 1
  fi
  echo "INFO: small patch drift ($DRIFT). OK."
fi

exit 0
