#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def codex_home_dir() -> Path:
    configured = os.getenv("CODEX_HOME", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".codex"


def state_base_dir() -> Path:
    configured = os.getenv("TG_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return codex_home_dir() / "changxian-agent" / "remote-control"


ENV_FILE = state_base_dir() / ".env"
LEGACY_ENV_FILE = SCRIPT_DIR / ".env"
EXAMPLE_FILE = SCRIPT_DIR / ".env.example"
REQUIREMENTS_FILE = SCRIPT_DIR / "requirements.txt"
VENV_DIR = SCRIPT_DIR / ".venv"
STAMP_FILE = VENV_DIR / ".runtime-requirements.sha256"
LOG_LEVELS = ["critical", "error", "warning", "info", "debug", "trace"]


def is_placeholder(value: str) -> bool:
    stripped = value.strip()
    return bool(stripped) and stripped.startswith("<") and stripped.endswith(">")


def venv_python_path() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python3"


def binary_candidates() -> list[Path]:
    if os.name == "nt":
        return [
            SCRIPT_DIR / "dist" / "remote-control.exe",
            SCRIPT_DIR / "remote-control.exe",
        ]
    return [
        SCRIPT_DIR / "dist" / "remote-control",
        SCRIPT_DIR / "remote-control",
    ]


def find_binary() -> Path | None:
    for candidate in binary_candidates():
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def load_env_token() -> str:
    for candidate in (ENV_FILE, LEGACY_ENV_FILE):
        if not candidate.exists():
            continue
        for raw_line in candidate.read_text(encoding="utf-8").splitlines():
            if not raw_line.startswith("TG_BOT_TOKEN="):
                continue
            value = raw_line.split("=", 1)[1].strip()
            return "" if is_placeholder(value) else value
    return ""


def copy_env_template() -> None:
    if ENV_FILE.exists() or not EXAMPLE_FILE.exists():
        return
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(EXAMPLE_FILE, ENV_FILE)
    sanitize_env_file()


def sanitize_env_file() -> None:
    if not ENV_FILE.exists():
        return
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    for line in lines:
        if "=" not in line:
            output.append(line)
            continue
        key, value = line.split("=", 1)
        if key in {"TG_BOT_TOKEN", "TG_WEBHOOK_SECRET"} and is_placeholder(value):
            output.append(f"{key}=")
        else:
            output.append(line)
    ENV_FILE.write_text("\n".join(output) + "\n", encoding="utf-8")
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass


def requirements_hash() -> str:
    payload = REQUIREMENTS_FILE.read_bytes()
    return hashlib.sha256(payload).hexdigest()


def ensure_runtime_venv() -> Path:
    python_bin = venv_python_path()
    if not python_bin.exists():
        print("[remote-control] Creating Python virtual environment...", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True, cwd=str(SCRIPT_DIR))
    expected_hash = requirements_hash()
    current_hash = ""
    if STAMP_FILE.exists():
        current_hash = STAMP_FILE.read_text(encoding="utf-8").strip()
    if current_hash != expected_hash:
        print("[remote-control] Installing runtime dependencies...", file=sys.stderr)
        subprocess.run(
            [str(python_bin), "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)],
            check=True,
            cwd=str(SCRIPT_DIR),
        )
        STAMP_FILE.write_text(expected_hash + "\n", encoding="utf-8")
    return python_bin


def format_quick_start() -> str:
    if os.name == "nt":
        return ".\\start.ps1 -Token <TG_BOT_TOKEN> -Port 18000"
    return "./start.sh --token <TG_BOT_TOKEN> --port 18000"


def child_args(args: argparse.Namespace, passthrough: list[str]) -> list[str]:
    result: list[str] = ["--host", args.host, "--port", str(args.port), "--log-level", args.log_level]
    if args.token:
        result.extend(["--token", args.token])
    if args.reload:
        result.append("--reload")
    result.extend(passthrough)
    return result


def choose_mode(args: argparse.Namespace) -> str:
    if args.mode != "auto":
        return args.mode
    if args.reload:
        return "python"
    if find_binary() is not None:
        return "binary"
    return "python"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="start.py",
        description="Cross-platform remote-control launcher for source bundles and local installs.",
    )
    parser.add_argument("--token", help="TG_BOT_TOKEN for first start")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18000)
    parser.add_argument("--reload", action="store_true", help="force Python reload mode")
    parser.add_argument("--mode", choices=["auto", "python", "binary"], default="auto")
    parser.add_argument("--log-level", choices=LOG_LEVELS, default="info")
    return parser


def main() -> int:
    parser = build_parser()
    args, passthrough = parser.parse_known_args()

    if ENV_FILE.exists():
        sanitize_env_file()
    effective_token = (args.token or os.getenv("TG_BOT_TOKEN", "")).strip() or load_env_token()
    if not effective_token:
        if not ENV_FILE.exists():
            copy_env_template()
            print(f"Created {ENV_FILE} from template.", file=sys.stderr)
        print(f"TG_BOT_TOKEN is required. Run: {format_quick_start()}", file=sys.stderr)
        return 1

    mode = choose_mode(args)
    if mode == "binary":
        if args.reload:
            parser.error("--reload requires Python mode")
        binary = find_binary()
        if binary is None:
            parser.error("no bridge binary found; rerun with --mode python or use start.py without --mode")
        cmd = [str(binary), *child_args(args, passthrough)]
        return subprocess.call(cmd, cwd=str(SCRIPT_DIR))

    python_bin = ensure_runtime_venv()
    cmd = [str(python_bin), str(SCRIPT_DIR / "cli.py"), *child_args(args, passthrough)]
    return subprocess.call(cmd, cwd=str(SCRIPT_DIR))


if __name__ == "__main__":
    raise SystemExit(main())
