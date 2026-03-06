#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
ASSETS_DIR = SKILL_DIR / "assets"
BRIDGE_SRC = ASSETS_DIR / "reference-telegram-bridge"
SKILLS_SRC = ASSETS_DIR / "standalone-skills"


def copy_tree(src: Path, dst: Path, overwrite: bool) -> None:
    if not src.exists():
        raise FileNotFoundError(f"missing source: {src}")
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            if target.exists() and overwrite:
                shutil.rmtree(target)
            if not target.exists():
                shutil.copytree(item, target)
            else:
                copy_tree(item, target, overwrite)
            continue
        if target.exists() and not overwrite:
            continue
        shutil.copy2(item, target)


def chmod_if_exists(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the bundled Telegram bridge from changxian-remote-control.")
    parser.add_argument("--path", required=True, help="Target directory for the standalone bridge")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing files in the target directory")
    args = parser.parse_args()

    target_dir = Path(args.path).expanduser().resolve()
    bridge_target = target_dir
    skills_target = target_dir / "changxian-agent-skills"

    copy_tree(BRIDGE_SRC, bridge_target, overwrite=args.overwrite)
    copy_tree(SKILLS_SRC, skills_target, overwrite=args.overwrite)

    chmod_if_exists(bridge_target / "start.sh", 0o755)
    chmod_if_exists(bridge_target / "build_binary.sh", 0o755)
    chmod_if_exists(bridge_target / ".env.example", 0o600)

    print(f"[OK] Installed standalone bridge to {bridge_target}")
    print(f"[OK] Installed bundled skills to {skills_target}")
    print("Next steps:")
    print(f"1. cd {bridge_target}")
    print("2. cp .env.example .env")
    print("3. Edit .env and fill your Telegram settings")
    print("4. ./start.sh --token <TG_BOT_TOKEN>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
