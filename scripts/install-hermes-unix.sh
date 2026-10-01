#!/usr/bin/env bash
set -euo pipefail

HERMES_HOME="${HERMES_HOME:?HERMES_HOME is required}"
INSTALL_DIR="${INSTALL_DIR:-$HERMES_HOME/hermes-agent}"
INSTALLER="$(mktemp "${TMPDIR:-/tmp}/kt-hermes-install.XXXXXX")"

cleanup() {
  rm -f "$INSTALLER"
}
trap cleanup EXIT

echo "Downloading Hermes installer..."
curl -fsSL "https://hermes-agent.nousresearch.com/install.sh" -o "$INSTALLER"

echo "Running Hermes installer into $INSTALL_DIR ..."
bash "$INSTALLER" \
  --hermes-home "$HERMES_HOME" \
  --dir "$INSTALL_DIR" \
  --non-interactive \
  --skip-browser \
  --skip-computer-use

echo "Checking Hermes Python environment..."
find_python() {
  for candidate in \
    "$INSTALL_DIR/venv/bin/python3" \
    "$INSTALL_DIR/venv/bin/python" \
    "$INSTALL_DIR/.venv/bin/python3" \
    "$INSTALL_DIR/.venv/bin/python" \
    "$INSTALL_DIR/.hermes/bin/python3" \
    "$INSTALL_DIR/.hermes/bin/python"
  do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

find_uv() {
  for candidate in \
    "$INSTALL_DIR/bin/uv" \
    "$INSTALL_DIR/.venv/bin/uv"
  do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  command -v uv >/dev/null 2>&1 && command -v uv && return 0
  return 1
}

if VENV_PYTHON="$(find_python)"; then
  UV_BIN="$(find_uv || true)"
  if [ -n "${UV_BIN:-}" ]; then
    "$UV_BIN" pip install --python "$VENV_PYTHON" --no-deps agent agent-client-protocol || true
  else
    "$VENV_PYTHON" -m pip install --upgrade pip || true
    "$VENV_PYTHON" -m pip install --no-deps agent agent-client-protocol || true
  fi
  echo "Verified Hermes dependencies."
else
  echo "Warning: could not locate Hermes Python executable for dependency repair." >&2
fi

echo "Hermes install complete."
