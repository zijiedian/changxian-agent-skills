#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
ASSETS_DIR = SKILL_DIR / "assets"
BRIDGE_SRC = ASSETS_DIR / "reference-telegram-bridge"
SKILLS_SRC = ASSETS_DIR / "standalone-skills"
IGNORED_BRIDGE_NAMES = {
    ".DS_Store",
    ".env",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "remote-control.log",
    "remote-control.pid",
    "remote-control.spec",
}
IGNORED_SKILL_NAMES = {".DS_Store", ".git", "__pycache__"}


def is_placeholder(value: str) -> bool:
    stripped = value.strip()
    return bool(stripped) and stripped.startswith("<") and stripped.endswith(">")


def copy_tree(src: Path, dst: Path, overwrite: bool, ignored: set[str] | None = None) -> None:
    if not src.exists():
        raise FileNotFoundError(f"missing source: {src}")
    dst.mkdir(parents=True, exist_ok=True)
    ignored = ignored or set()
    for item in src.iterdir():
        if item.name in ignored:
            continue
        target = dst / item.name
        if item.is_dir():
            if target.exists() and overwrite:
                shutil.rmtree(target)
            if not target.exists():
                shutil.copytree(item, target)
            else:
                copy_tree(item, target, overwrite, ignored)
            continue
        if target.exists() and not overwrite:
            continue
        shutil.copy2(item, target)


def chmod_if_exists(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except OSError:
        pass


def sanitize_env_file(path: Path) -> None:
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
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
    path.write_text("\n".join(output) + "\n", encoding="utf-8")
    chmod_if_exists(path, 0o600)


def ensure_env_file(target_dir: Path) -> Path:
    env_path = target_dir / ".env"
    example_path = target_dir / ".env.example"
    if not env_path.exists() and example_path.exists():
        shutil.copy2(example_path, env_path)
    sanitize_env_file(env_path)
    return env_path


def upsert_env_value(path: Path, key: str, value: str) -> None:
    if not value:
        return
    lines: list[str] = []
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    replaced = False
    prefix = f"{key}="
    for line in lines:
        if line.startswith(prefix):
            output.append(prefix + value)
            replaced = True
        else:
            output.append(line)
    if not replaced:
        output.append(prefix + value)
    path.write_text("\n".join(output) + "\n", encoding="utf-8")
    chmod_if_exists(path, 0o600)


def quick_start_commands(port: int, token_supplied: bool) -> list[str]:
    if os.name == "nt":
        base = f".\\start.ps1 -Port {port}"
        if not token_supplied:
            base += " -Token <TG_BOT_TOKEN>"
        alt = f"py .\\start.py {'--token <TG_BOT_TOKEN> ' if not token_supplied else ''}--port {port}".strip()
        return [base, alt]
    base = "./start.sh"
    if not token_supplied:
        base += " --token <TG_BOT_TOKEN>"
    base += f" --port {port}"
    alt = f"python3 start.py {'--token <TG_BOT_TOKEN> ' if not token_supplied else ''}--port {port}".strip()
    return [base, alt]


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the bundled Telegram bridge from changxian-remote-control.")
    parser.add_argument("--path", required=True, help="Target directory for the standalone bridge")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing files in the target directory")
    parser.add_argument("--token", help="Optional TG_BOT_TOKEN to prefill into .env")
    parser.add_argument("--port", type=int, default=18000, help="Port passed to the launcher when using --run")
    parser.add_argument("--mode", choices=["auto", "python", "binary"], default="auto", help="Launcher mode used with --run")
    parser.add_argument("--run", action="store_true", help="Start the bridge immediately after installation")
    args = parser.parse_args()

    target_dir = Path(args.path).expanduser().resolve()
    bridge_target = target_dir
    skills_target = target_dir / "changxian-agent-skills"

    copy_tree(BRIDGE_SRC, bridge_target, overwrite=args.overwrite, ignored=IGNORED_BRIDGE_NAMES)
    copy_tree(SKILLS_SRC, skills_target, overwrite=args.overwrite, ignored=IGNORED_SKILL_NAMES)

    chmod_if_exists(bridge_target / "start.sh", 0o755)
    chmod_if_exists(bridge_target / "start.py", 0o755)
    chmod_if_exists(bridge_target / "build_binary.sh", 0o755)
    chmod_if_exists(bridge_target / ".env.example", 0o600)

    env_path = ensure_env_file(bridge_target)
    if args.token:
        upsert_env_value(env_path, "TG_BOT_TOKEN", args.token)

    print(f"[OK] Installed standalone bridge to {bridge_target}")
    print(f"[OK] Installed bundled skills to {skills_target}")
    if args.token:
        print("[OK] Prefilled TG_BOT_TOKEN into .env")

    if args.run:
        start_script = bridge_target / "start.py"
        cmd = [sys.executable, str(start_script), "--port", str(args.port), "--mode", args.mode]
        if args.token:
            cmd.extend(["--token", args.token])
        print(f"[OK] Starting bridge via {start_script}")
        return subprocess.call(cmd, cwd=str(bridge_target))

    print("Quick start:")
    print(f"1. cd {bridge_target}")
    commands = quick_start_commands(args.port, token_supplied=bool(args.token))
    print(f"2. {commands[0]}")
    print(f"3. {commands[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
