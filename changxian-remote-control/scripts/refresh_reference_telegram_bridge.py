#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILL_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DST = SKILL_DIR / "assets" / "reference-telegram-bridge"
SKILLS_DST = SKILL_DIR / "assets" / "standalone-skills"

RUNTIME_FILES = [
    ".env.example",
    "README.md",
    "LICENSE",
    "__init__.py",
    "app_factory.py",
    "bot_commands.py",
    "bridge.py",
    "build_binary.sh",
    "cli.py",
    "codex_runner.py",
    "constants.py",
    "main.py",
    "memory_store.py",
    "requirements.txt",
    "scheduler.py",
    "settings.py",
    "start.py",
    "start.ps1",
    "start.cmd",
    "start.sh",
]

DEPENDENCY_SKILLS = [
    "changxian-memory-manager",
    "changxian-role-manager",
    "changxian-remote-control",
]


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def ignore_remote_control_copy(_dir: str, names: list[str]) -> set[str]:
    ignored = {".git", "__pycache__"}
    if Path(_dir).resolve() == (ROOT / "changxian-agent-skills" / "changxian-remote-control").resolve():
        ignored.update({"assets", "scripts"})
    return {name for name in names if name in ignored}


def main() -> int:
    reset_dir(BRIDGE_DST)
    for relative in RUNTIME_FILES:
        shutil.copy2(ROOT / relative, BRIDGE_DST / relative)

    reset_dir(SKILLS_DST)
    for skill_name in DEPENDENCY_SKILLS:
        src = ROOT / "changxian-agent-skills" / skill_name
        dst = SKILLS_DST / skill_name
        if skill_name == "changxian-remote-control":
            shutil.copytree(src, dst, ignore=ignore_remote_control_copy)
        else:
            shutil.copytree(src, dst)

    print("[OK] Refreshed reference bridge assets and bundled skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
