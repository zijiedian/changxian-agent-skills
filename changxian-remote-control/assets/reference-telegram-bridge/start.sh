#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd -P)"
START_PY="$SCRIPT_DIR/start.py"
BIN="$SCRIPT_DIR/dist/remote-control"
ROOT_BIN="$SCRIPT_DIR/remote-control"
WANTS_RELOAD=0

for arg in "$@"; do
  if [[ "$arg" == "--reload" ]]; then
    WANTS_RELOAD=1
    break
  fi
done

if [[ -x "$SCRIPT_DIR/.venv/bin/python3" ]]; then
  exec "$SCRIPT_DIR/.venv/bin/python3" "$START_PY" "$@"
fi
if [[ -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
  exec "$SCRIPT_DIR/.venv/bin/python" "$START_PY" "$@"
fi
if command -v python3 >/dev/null 2>&1; then
  exec "$(command -v python3)" "$START_PY" "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec "$(command -v python)" "$START_PY" "$@"
fi

if [[ "$WANTS_RELOAD" -eq 1 ]]; then
  echo "Error: Python 3 is required for --reload." >&2
  exit 1
fi
if [[ -x "$BIN" ]]; then
  exec "$BIN" "$@"
fi
if [[ -x "$ROOT_BIN" ]]; then
  exec "$ROOT_BIN" "$@"
fi

echo "Error: Python 3 not found and no remote-control bridge binary is available." >&2
echo "Install Python 3 or use a prebuilt bridge release binary." >&2
exit 1
