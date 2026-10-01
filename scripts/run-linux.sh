#!/usr/bin/env bash
# Launch KnightTrader Propr on Linux without requiring FUSE/libfuse2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE=""
for candidate in "$SCRIPT_DIR"/*.AppImage "$SCRIPT_DIR"/KnightTrader*.AppImage; do
  if [ -f "$candidate" ]; then
    APPIMAGE="$candidate"
    break
  fi
done

if [ -z "$APPIMAGE" ]; then
  echo "No AppImage found next to this script." >&2
  exit 1
fi

chmod +x "$APPIMAGE"
if "$APPIMAGE" --appimage-extract-and-run --version >/dev/null 2>&1; then
  exec "$APPIMAGE" --appimage-extract-and-run "$@"
fi

exec "$APPIMAGE" "$@"
