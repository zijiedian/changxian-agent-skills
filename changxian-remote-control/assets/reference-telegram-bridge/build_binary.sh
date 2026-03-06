#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd -P)"

SKILLS_DIR=""
for candidate in \
  "$SCRIPT_DIR/changxian-agent-skills" \
  "$SCRIPT_DIR/../standalone-skills" \
  "$SCRIPT_DIR/../../../"; do
  if [[ -d "$candidate" ]]; then
    SKILLS_DIR="$candidate"
    break
  fi
done

if [[ -z "$SKILLS_DIR" ]]; then
  echo "Error: unable to locate changxian-agent-skills payload for PyInstaller"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 not found"
  exit 1
fi

if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
  python3 -m venv "$SCRIPT_DIR/.venv"
fi

VENV_PY="$SCRIPT_DIR/.venv/bin/python3"
if [[ ! -x "$VENV_PY" ]]; then
  echo "Detected broken virtualenv, recreating .venv"
  rm -rf "$SCRIPT_DIR/.venv"
  python3 -m venv "$SCRIPT_DIR/.venv"
fi

"$VENV_PY" -m pip install --upgrade pip >/dev/null
"$VENV_PY" -m pip install -r "$SCRIPT_DIR/requirements.txt" "pyinstaller>=6.0"

"$VENV_PY" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name remote-control \
  --collect-submodules uvicorn \
  --collect-submodules telegram \
  --collect-submodules httpx \
  --collect-submodules httpcore \
  --collect-submodules anyio \
  --add-data "$SCRIPT_DIR/.env.example:." \
  --add-data "$SKILLS_DIR:changxian-agent-skills" \
  "$SCRIPT_DIR/cli.py"

chmod +x "$SCRIPT_DIR/dist/remote-control" || true

echo "Build complete: $SCRIPT_DIR/dist/remote-control"
echo "Run: ./dist/remote-control --token <TG_BOT_TOKEN> --port 18000"
