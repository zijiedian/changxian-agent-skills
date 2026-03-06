import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Set
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

from constants import (
    DEFAULT_AUTH_TTL_SECONDS,
    DEFAULT_CODEX_TIMEOUT_SECONDS,
    DEFAULT_MAX_BUFFERED_OUTPUT_CHARS,
    DEFAULT_MAX_CONCURRENT_TASKS,
    MIN_AUTH_PASSPHRASE_LENGTH,
)
from codex_runner import _validate_codex_prefix


@dataclass
class Settings:
    bot_token: str
    webhook_url: str
    webhook_secret: str
    allowed_chat_ids: Set[int]
    allowed_user_ids: Set[int]
    admin_chat_ids: Set[int]
    admin_user_ids: Set[int]
    codex_command_prefix: str
    codex_timeout_seconds: int
    allow_plain_text: bool
    allow_cmd_override: bool
    max_image_bytes: int
    max_buffered_output_chars: int
    max_concurrent_tasks: int
    enable_output_file: bool
    enable_session_resume: bool
    enable_memory: bool
    memory_auto_save: bool
    memory_max_items: int
    memory_max_chars: int
    enable_scheduler: bool
    scheduler_poll_seconds: int
    default_timezone: str
    auth_passphrase: str
    auth_ttl_seconds: int


LEGACY_STATE_ENTRIES = (
    ".env",
    "agent_state.sqlite3",
    "agent_state.sqlite3-shm",
    "agent_state.sqlite3-wal",
    "chat_roles.json",
    "chat_sessions.json",
    "chat_workdirs.json",
    "page_sessions.json",
    "roles",
)


def _parse_allowed_ids(value: str) -> Set[int]:
    if not value.strip():
        return set()
    result: Set[int] = set()
    for item in value.split(","):
        item = item.strip()
        if item:
            result.add(int(item))
    return result


def _parse_duration_seconds(raw: str, env_name: str) -> int:
    value = raw.strip()
    match = re.fullmatch(r"(?i)(\d+)\s*([smhd]?)", value)
    if not match:
        raise RuntimeError(
            f"{env_name} must be a positive duration, e.g. 3600, 60s, 30m, 2h, 7d"
        )

    amount = int(match.group(1))
    unit = (match.group(2) or "s").lower()
    multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    seconds = amount * multipliers[unit]
    if seconds <= 0:
        raise RuntimeError(f"{env_name} must be positive")
    return seconds


def runtime_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


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


def _copy_if_missing(src: Path, dst: Path) -> None:
    if dst.exists() or not src.exists():
        return
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


def ensure_state_base_dir() -> Path:
    state_dir = state_base_dir()
    state_dir.mkdir(parents=True, exist_ok=True)

    # One-time migration: preserve existing state from the legacy runtime directory.
    legacy_dir = runtime_base_dir()
    if legacy_dir != state_dir:
        for name in LEGACY_STATE_ENTRIES:
            src = legacy_dir / name
            dst = state_dir / name
            try:
                _copy_if_missing(src, dst)
            except OSError:
                continue
    return state_dir


def state_env_path() -> Path:
    return ensure_state_base_dir() / ".env"


def resource_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        bundle_dir = getattr(sys, "_MEIPASS", "")
        if bundle_dir:
            return Path(bundle_dir)
    return Path(__file__).resolve().parent


def load_settings() -> Settings:
    env_path = state_env_path()
    load_dotenv(env_path)
    if env_path.exists():
        try:
            os.chmod(env_path, 0o600)
        except OSError:
            pass
    token = os.getenv("TG_BOT_TOKEN", "").strip()
    webhook_url = os.getenv("TG_WEBHOOK_URL", "").strip()
    webhook_secret = os.getenv("TG_WEBHOOK_SECRET", "").strip()
    allowed_chat_ids = _parse_allowed_ids(os.getenv("TG_ALLOWED_CHAT_IDS", ""))
    allowed_user_ids_raw = os.getenv("TG_ALLOWED_USER_IDS", "").strip()
    allowed_user_ids = _parse_allowed_ids(allowed_user_ids_raw) if allowed_user_ids_raw else set(allowed_chat_ids)
    admin_chat_ids_raw = os.getenv("TG_ADMIN_CHAT_IDS", "").strip()
    admin_chat_ids = _parse_allowed_ids(admin_chat_ids_raw) if admin_chat_ids_raw else set(allowed_chat_ids)
    admin_user_ids_raw = os.getenv("TG_ADMIN_USER_IDS", "").strip()
    admin_user_ids = _parse_allowed_ids(admin_user_ids_raw) if admin_user_ids_raw else set(allowed_user_ids)
    codex_prefix = os.getenv(
        "CODEX_COMMAND_PREFIX",
        "codex -a never --search exec -s danger-full-access --skip-git-repo-check",
    ).strip()
    codex_timeout = int(os.getenv("CODEX_TIMEOUT_SECONDS", str(DEFAULT_CODEX_TIMEOUT_SECONDS)))
    allow_plain_text = os.getenv("TG_ALLOW_PLAIN_TEXT", "1").strip().lower() in {"1", "true", "yes"}
    allow_cmd_override = os.getenv("TG_ALLOW_CMD_OVERRIDE", "1").strip().lower() in {"1", "true", "yes"}
    max_image_bytes = int(os.getenv("TG_MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))
    max_buffered_output_chars = int(os.getenv("TG_MAX_BUFFERED_OUTPUT_CHARS", str(DEFAULT_MAX_BUFFERED_OUTPUT_CHARS)))
    max_concurrent_tasks = int(os.getenv("TG_MAX_CONCURRENT_TASKS", str(DEFAULT_MAX_CONCURRENT_TASKS)))
    enable_output_file = os.getenv("TG_ENABLE_OUTPUT_FILE", "0").strip().lower() in {"1", "true", "yes"}
    enable_session_resume = os.getenv("TG_ENABLE_SESSION_RESUME", "1").strip().lower() in {"1", "true", "yes"}
    enable_memory = os.getenv("TG_ENABLE_MEMORY", "1").strip().lower() in {"1", "true", "yes"}
    memory_auto_save = os.getenv("TG_MEMORY_AUTO_SAVE", "1").strip().lower() in {"1", "true", "yes"}
    memory_max_items = int(os.getenv("TG_MEMORY_MAX_ITEMS", "6"))
    memory_max_chars = int(os.getenv("TG_MEMORY_MAX_CHARS", "2400"))
    enable_scheduler = os.getenv("TG_ENABLE_SCHEDULER", "1").strip().lower() in {"1", "true", "yes"}
    scheduler_poll_seconds = int(os.getenv("TG_SCHEDULER_POLL_SECONDS", "5"))
    default_timezone = os.getenv("TG_DEFAULT_TIMEZONE", "Asia/Shanghai").strip() or "Asia/Shanghai"
    auth_passphrase = os.getenv("TG_AUTH_PASSPHRASE", "").strip()
    auth_ttl_raw = os.getenv("TG_AUTH_TTL_SECONDS", str(DEFAULT_AUTH_TTL_SECONDS))
    auth_ttl_seconds = _parse_duration_seconds(auth_ttl_raw, "TG_AUTH_TTL_SECONDS")

    if not token:
        raise RuntimeError("TG_BOT_TOKEN is required")
    if not allowed_chat_ids:
        raise RuntimeError("TG_ALLOWED_CHAT_IDS is required and cannot be empty")
    if not allowed_user_ids:
        raise RuntimeError("TG_ALLOWED_USER_IDS resolves to empty set")
    if not admin_chat_ids:
        raise RuntimeError("TG_ADMIN_CHAT_IDS resolves to empty set")
    if not admin_user_ids:
        raise RuntimeError("TG_ADMIN_USER_IDS resolves to empty set")
    if not admin_chat_ids.issubset(allowed_chat_ids):
        raise RuntimeError("TG_ADMIN_CHAT_IDS must be a subset of TG_ALLOWED_CHAT_IDS")
    if not admin_user_ids.issubset(allowed_user_ids):
        raise RuntimeError("TG_ADMIN_USER_IDS must be a subset of TG_ALLOWED_USER_IDS")
    if webhook_url and not webhook_secret:
        raise RuntimeError("TG_WEBHOOK_SECRET is required when TG_WEBHOOK_URL is set")
    if webhook_secret and len(webhook_secret) < 16:
        raise RuntimeError("TG_WEBHOOK_SECRET must be at least 16 characters")
    if max_image_bytes <= 0:
        raise RuntimeError("TG_MAX_IMAGE_BYTES must be positive")
    if max_buffered_output_chars < 20_000:
        raise RuntimeError("TG_MAX_BUFFERED_OUTPUT_CHARS must be >= 20000")
    if max_concurrent_tasks <= 0:
        raise RuntimeError("TG_MAX_CONCURRENT_TASKS must be positive")
    if memory_max_items <= 0:
        raise RuntimeError("TG_MEMORY_MAX_ITEMS must be positive")
    if memory_max_chars <= 0:
        raise RuntimeError("TG_MEMORY_MAX_CHARS must be positive")
    if scheduler_poll_seconds <= 0:
        raise RuntimeError("TG_SCHEDULER_POLL_SECONDS must be positive")
    try:
        ZoneInfo(default_timezone)
    except Exception as err:
        raise RuntimeError(f"TG_DEFAULT_TIMEZONE is invalid: {default_timezone}") from err
    if auth_passphrase and len(auth_passphrase) < MIN_AUTH_PASSPHRASE_LENGTH:
        raise RuntimeError(f"TG_AUTH_PASSPHRASE must be at least {MIN_AUTH_PASSPHRASE_LENGTH} characters")
    _validate_codex_prefix(codex_prefix)

    return Settings(
        bot_token=token,
        webhook_url=webhook_url,
        webhook_secret=webhook_secret,
        allowed_chat_ids=allowed_chat_ids,
        allowed_user_ids=allowed_user_ids,
        admin_chat_ids=admin_chat_ids,
        admin_user_ids=admin_user_ids,
        codex_command_prefix=codex_prefix,
        codex_timeout_seconds=codex_timeout,
        allow_plain_text=allow_plain_text,
        allow_cmd_override=allow_cmd_override,
        max_image_bytes=max_image_bytes,
        max_buffered_output_chars=max_buffered_output_chars,
        max_concurrent_tasks=max_concurrent_tasks,
        enable_output_file=enable_output_file,
        enable_session_resume=enable_session_resume,
        enable_memory=enable_memory,
        memory_auto_save=memory_auto_save,
        memory_max_items=memory_max_items,
        memory_max_chars=memory_max_chars,
        enable_scheduler=enable_scheduler,
        scheduler_poll_seconds=scheduler_poll_seconds,
        default_timezone=default_timezone,
        auth_passphrase=auth_passphrase,
        auth_ttl_seconds=auth_ttl_seconds,
    )
