import asyncio
import html
import hmac
import json
import mimetypes
import os
import re
import shlex
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from dataclasses import dataclass
from textwrap import dedent
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Optional
from zoneinfo import ZoneInfo

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, InputFile, Update
from telegram.constants import ParseMode
from telegram.error import BadRequest, TelegramError
from telegram.ext import ContextTypes

from bot_commands import start_help_lines
from codex_runner import (
    _is_opencode_prefix,
    _validate_codex_prefix,
    _validate_command_prefix,
    _validate_opencode_prefix,
    run_codex_stream,
)
from constants import (
    ANSI_ESCAPE_RE,
    CODE_INDENT_RE,
    CODE_KEYWORD_RE,
    CONFIG_CONTEXT_NOISE_RE,
    DEFAULT_AUTH_TTL_SECONDS,
    DEFAULT_CODEX_COMMAND_PREFIX,
    DIFF_HEADER_RE,
    EDIT_THROTTLE_SECONDS,
    FINAL_OUTPUT_CHUNK_LIMIT,
    IDLE_EDIT_THROTTLE_SECONDS,
    LONG_SECRET_RE,
    MARKDOWN_BULLET_RE,
    MARKDOWN_FENCE_CLOSE_RE,
    MARKDOWN_FENCE_RE,
    MARKDOWN_HEADING_RE,
    MARKDOWN_ORDERED_RE,
    MARKDOWN_RULE_RE,
    MIN_AUTH_PASSPHRASE_LENGTH,
    OUTPUT_FILE_MIN_CHARS,
    OPENCODE_PROJECT_PATH_PLACEHOLDER,
    PAGE_SESSION_TTL_SECONDS,
    PATCH_ADD_PREFIX,
    PATCH_BEGIN_MARKER,
    PATCH_DELETE_PREFIX,
    PATCH_END_MARKER,
    PATCH_END_OF_FILE_MARKER,
    PATCH_MOVE_PREFIX,
    PATCH_UPDATE_PREFIX,
    PREVIEW_DIVIDER_RE,
    PREVIEW_LINE_CHAR_LIMIT,
    PREVIEW_NOISE_PATTERNS,
    REQUEST_DEDUP_SECONDS,
    SENSITIVE_OPTION_RE,
    SESSION_ID_RE,
    SHELL_PROMPT_RE,
    STREAM_PREVIEW_LIMIT,
    STREAM_PROGRESS_IO_TIMEOUT_SECONDS,
    STREAM_PREVIEW_LINE_LIMIT,
    TELEGRAM_MESSAGE_LIMIT,
    THINKING_DETAIL_MAX_CHARS,
    THINKING_DETAIL_MAX_LINES,
    THINKING_SPINNER_FRAMES,
    TRACE_SECTION_MARKERS,
    TRACE_SKIP_SECTION_MARKERS,
    OPENCODE_COMMAND_PREFIX,
)
from memory_store import MemoryRecord, MemoryStore
from scheduler import ScheduledJob, SchedulerService, SchedulerStore, parse_schedule_spec
from settings import Settings, ensure_state_base_dir, resource_base_dir, runtime_base_dir


@dataclass
class PageSession:
    chat_id: int
    message_id: int
    pages: list[str]
    created_at: float
    last_access: float
    current_index: int = 0


@dataclass
class TraceSection:
    marker: str
    lines: list[str]

    @property
    def content(self) -> str:
        return "\n".join(self.lines).strip()


@dataclass
class SkillInfo:
    name: str
    description: str
    skill_md: Path
    is_system: bool


@dataclass
class ExecutionRequest:
    chat_id: int
    prompt: str
    source: str
    thread_id: Optional[int] = None
    draft_enabled: bool = False
    draft_id: Optional[int] = None
    status_message_id: Optional[int] = None
    cleanup_paths: Optional[list[Path]] = None
    workdir: Optional[Path] = None
    command_prefix: Optional[str] = None
    session_mode: str = "chat"
    session_ref: str = ""
    memory_scope: str = ""
    role: str = ""
    owner_user_id: Optional[int] = None


@dataclass
class ExecutionResult:
    success: bool
    cleaned_output: str = ""
    summary: str = ""
    error_text: str = ""
    output_file: str = ""
    diagnostic_file: str = ""
    session_id: str = ""
    status_message_id: Optional[int] = None
    skipped: bool = False


def clip_for_telegram(text: str, limit: int = 3600) -> str:
    if len(text) <= limit:
        return text
    return "...\n" + text[-limit:]


def clip_for_inline(text: str, limit: int = 240) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


ROLE_TEMPLATES = {
    "reviewer": dedent(
        """
        You are a repository reviewer.
        Prioritize concrete findings, risks, regressions, and missing tests.
        Keep summaries brief and put findings first.
        """
    ).strip(),
    "writer": dedent(
        """
        You are a technical writer.
        Explain decisions clearly, remove fluff, and keep the structure easy to scan.
        Prefer practical examples over abstract language.
        """
    ).strip(),
    "researcher": dedent(
        """
        You are a research assistant.
        Gather evidence carefully, separate facts from inference, and cite concrete sources when available.
        """
    ).strip(),
}

MEMORY_SKILL_NAME = "changxian-memory-manager"
ROLE_SKILL_NAME = "changxian-role-manager"
SCHEDULE_SKILL_NAME = "changxian-schedule"
REMOTE_CONTROL_SKILL_NAME = "changxian-remote-control"
MEMORY_OPS_BLOCK_RE = re.compile(r"```tg-memory-ops\s*(.*?)```", re.IGNORECASE | re.DOTALL)
ROLE_OPS_BLOCK_RE = re.compile(r"```tg-role-ops\s*(.*?)```", re.IGNORECASE | re.DOTALL)
SCHEDULE_OPS_BLOCK_RE = re.compile(r"```tg-schedule-ops\s*(.*?)```", re.IGNORECASE | re.DOTALL)
ROLE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ROLE_SYNC_INTENT_RE = re.compile(
    r"(?i)(?:/role\b|\brole\b|roles\b|use role|activate role|switch role|clear role|delete role|create role|update role|角色|人设|扮演)"
)
SCHEDULE_SYNC_ACTION_RE = re.compile(
    r"(?i)(?:create job|add job|new job|update job|set job|pause job|resume job|run job|trigger job|delete job|remove job|"
    r"新建(?:计划)?任务|创建(?:计划)?任务|添加(?:计划)?任务|新增(?:计划)?任务|更新(?:计划)?任务|修改(?:计划)?任务|编辑(?:计划)?任务|"
    r"暂停(?:计划)?任务|恢复(?:计划)?任务|启用(?:计划)?任务|禁用(?:计划)?任务|删除(?:计划)?任务|移除(?:计划)?任务|触发(?:计划)?任务|"
    r"创建定时|新增定时|添加定时|更新定时|修改定时|暂停定时|恢复定时|删除定时|设置定时)"
)
SCHEDULE_SYNC_SCHEDULE_RE = re.compile(
    r"(?i)(?:\bcron\b|\bevery\b|\bonce\b|每天|每周|每月|每隔)"
)
SCHEDULE_SYNC_READONLY_RE = re.compile(
    r"(?i)(?:查看|显示|列出|罗列|详情|细节|状态|有哪些|show|display|list|detail|details|status|inspect)"
)
MEMORY_SYNC_INTENT_RE = re.compile(
    r"(?i)(?:/memory\b|\bmemory\b|remember|forget|saved memory|记忆|记住|忘记|遗忘)"
)


class Bridge:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.tasks: Dict[int, asyncio.Task] = {}
        self.default_command_prefix = settings.codex_command_prefix
        self.recent_requests: Dict[tuple[int, int], float] = {}
        self.auth_sessions: Dict[tuple[int, int], float] = {}
        self.skill_body_cache: Dict[str, tuple[Path, int, str]] = {}
        runtime_dir = runtime_base_dir()
        state_dir = ensure_state_base_dir()
        self.media_dir = runtime_dir / "incoming_media"
        self.output_dir = runtime_dir / "outputs"
        self.roles_dir = state_dir / "roles"
        self.env_path = state_dir / ".env"
        self.sessions_path = state_dir / "chat_sessions.json"
        self.workdirs_path = state_dir / "chat_workdirs.json"
        self.command_prefixes_path = state_dir / "chat_command_prefixes.json"
        self.roles_path = state_dir / "chat_roles.json"
        self.page_sessions_path = state_dir / "page_sessions.json"
        self.state_db_path = state_dir / "agent_state.sqlite3"
        self.diagnostics_dir = state_dir / "diagnostics"
        self.resource_dir = resource_base_dir()
        self.project_skills_dir = self.resource_dir / "changxian-agent-skills"
        self._ensure_default_roles()
        self.chat_sessions: Dict[int, str] = self._load_chat_sessions()
        self.chat_workdirs: Dict[int, str] = self._load_chat_workdirs()
        self.chat_command_prefixes: Dict[int, str] = self._load_chat_command_prefixes()
        self.chat_roles: Dict[int, str] = self._load_chat_roles()
        self.page_sessions: Dict[tuple[int, int], PageSession] = self._load_page_sessions()
        self.memory_store = MemoryStore(self.state_db_path)
        self.memory_store.initialize()
        self._ensure_project_skills()
        self.scheduler_store = SchedulerStore(self.state_db_path)
        self.scheduler_store.initialize()
        self.scheduler_service = SchedulerService(self, self.scheduler_store, settings)
        self.application = None

    def _default_workdir(self) -> Path:
        return Path(self.settings.default_workdir)

    def _default_command_prefix_for_chat(self, _: int) -> str:
        return self.default_command_prefix

    def _load_chat_sessions(self) -> Dict[int, str]:
        if not self.sessions_path.exists():
            return {}
        try:
            raw = json.loads(self.sessions_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, dict):
            return {}
        sessions: Dict[int, str] = {}
        for chat_key, session_id in raw.items():
            if not isinstance(chat_key, str) or not isinstance(session_id, str):
                continue
            if not SESSION_ID_RE.fullmatch(f"session id: {session_id}"):
                continue
            try:
                sessions[int(chat_key)] = session_id
            except ValueError:
                continue
        return sessions

    def _save_chat_sessions(self) -> None:
        payload = {str(chat_id): session_id for chat_id, session_id in self.chat_sessions.items()}
        self.sessions_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        try:
            os.chmod(self.sessions_path, 0o600)
        except OSError:
            pass

    def _set_chat_session(self, chat_id: int, session_id: str) -> None:
        self.chat_sessions[chat_id] = session_id
        self._save_chat_sessions()

    def _clear_chat_session(self, chat_id: int) -> bool:
        existed = chat_id in self.chat_sessions
        if existed:
            self.chat_sessions.pop(chat_id, None)
            self._save_chat_sessions()
        return existed

    def bind_application(self, application) -> None:
        self.application = application

    @staticmethod
    def _default_memory_scope(chat_id: int) -> str:
        return f"chat:{chat_id}"

    def _get_request_session_id(self, request: ExecutionRequest) -> str:
        if request.session_mode == "job" and request.session_ref:
            return self.scheduler_store.get_job_session(request.session_ref) or ""
        if request.session_mode == "chat" and self.settings.enable_session_resume:
            return self.chat_sessions.get(request.chat_id, "")
        return ""

    def _set_request_session_id(self, request: ExecutionRequest, session_id: str) -> None:
        if not session_id:
            return
        if request.session_mode == "job" and request.session_ref:
            self.scheduler_store.set_job_session(request.session_ref, session_id)
            return
        if request.session_mode == "chat" and self.settings.enable_session_resume:
            self._set_chat_session(request.chat_id, session_id)

    def _clear_request_session(self, request: ExecutionRequest) -> None:
        if request.session_mode == "job" and request.session_ref:
            self.scheduler_store.clear_job_session(request.session_ref)
            return
        if request.session_mode == "chat":
            self._clear_chat_session(request.chat_id)

    def _request_context(self):
        if self.application is None:
            raise RuntimeError("telegram application not bound")
        return SimpleNamespace(bot=self.application.bot, application=self.application)

    def _load_chat_workdirs(self) -> Dict[int, str]:
        if not self.workdirs_path.exists():
            return {}
        try:
            raw = json.loads(self.workdirs_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, dict):
            return {}

        workdirs: Dict[int, str] = {}
        for chat_key, workdir in raw.items():
            if not isinstance(chat_key, str) or not isinstance(workdir, str):
                continue
            normalized = workdir.strip()
            if not normalized:
                continue
            try:
                chat_id = int(chat_key)
            except ValueError:
                continue
            workdirs[chat_id] = normalized
        return workdirs

    def _load_chat_command_prefixes(self) -> Dict[int, str]:
        if not self.command_prefixes_path.exists():
            return {}
        try:
            raw = json.loads(self.command_prefixes_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, dict):
            return {}

        command_prefixes: Dict[int, str] = {}
        for chat_key, prefix in raw.items():
            if not isinstance(chat_key, str) or not isinstance(prefix, str):
                continue
            normalized = prefix.strip()
            if not normalized:
                continue
            try:
                chat_id = int(chat_key)
                _validate_command_prefix(normalized)
            except (ValueError, TypeError):
                continue
            command_prefixes[chat_id] = normalized
        return command_prefixes

    def _ensure_default_roles(self) -> None:
        self.roles_dir.mkdir(parents=True, exist_ok=True)
        for role_name, content in ROLE_TEMPLATES.items():
            role_path = self.roles_dir / f"{role_name}.md"
            if role_path.exists():
                continue
            role_path.write_text(content + "\n", encoding="utf-8")

    def _load_chat_roles(self) -> Dict[int, str]:
        if not self.roles_path.exists():
            return {}
        try:
            raw = json.loads(self.roles_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, dict):
            return {}
        roles: Dict[int, str] = {}
        for chat_key, role_name in raw.items():
            if not isinstance(chat_key, str) or not isinstance(role_name, str):
                continue
            try:
                chat_id = int(chat_key)
            except ValueError:
                continue
            normalized = role_name.strip().lower()
            if not normalized:
                continue
            if self._role_path(normalized).exists():
                roles[chat_id] = normalized
        return roles

    def _save_chat_roles(self) -> None:
        payload = {str(chat_id): role_name for chat_id, role_name in self.chat_roles.items()}
        self.roles_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        try:
            os.chmod(self.roles_path, 0o600)
        except OSError:
            pass

    def _role_path(self, role_name: str) -> Path:
        return self.roles_dir / f"{role_name.strip().lower()}.md"

    def _list_roles(self) -> list[str]:
        if not self.roles_dir.exists():
            return []
        names = [path.stem for path in self.roles_dir.glob("*.md") if path.is_file()]
        return sorted({name.strip().lower() for name in names if name.strip()})

    def _read_role_content(self, role_name: str) -> str:
        role_path = self._role_path(role_name)
        try:
            content = role_path.read_text(encoding="utf-8").strip()
        except OSError as err:
            raise ValueError(f"failed to read role {role_name}: {err}") from err
        if not content:
            raise ValueError(f"role {role_name} is empty")
        return content

    def _active_role_name(self, chat_id: int) -> str:
        role_name = self.chat_roles.get(chat_id, "").strip().lower()
        if role_name and self._role_path(role_name).exists():
            return role_name
        return ""

    def _set_chat_role(self, chat_id: int, role_name: str) -> None:
        normalized = role_name.strip().lower()
        if not normalized:
            self.chat_roles.pop(chat_id, None)
        else:
            self.chat_roles[chat_id] = normalized
        self._save_chat_roles()

    def _clear_chat_role(self, chat_id: int) -> bool:
        existed = chat_id in self.chat_roles
        if existed:
            self.chat_roles.pop(chat_id, None)
            self._save_chat_roles()
        return existed

    @staticmethod
    def _normalize_role_name(role_name: str) -> str:
        normalized = re.sub(r"[^a-z0-9-]+", "-", (role_name or "").strip().lower()).strip("-")
        if normalized.startswith("role-"):
            normalized = normalized[5:]
        if not normalized or not ROLE_NAME_RE.fullmatch(normalized):
            raise ValueError("role names must use lowercase letters, digits, or hyphens")
        return normalized

    def _write_role_content(self, role_name: str, content: str) -> str:
        normalized = self._normalize_role_name(role_name)
        body = content.strip()
        if not body:
            raise ValueError("role content cannot be empty")
        self.roles_dir.mkdir(parents=True, exist_ok=True)
        role_path = self._role_path(normalized)
        role_path.write_text(body + "\n", encoding="utf-8")
        try:
            os.chmod(role_path, 0o600)
        except OSError:
            pass
        return normalized

    def _delete_role(self, role_name: str) -> bool:
        normalized = self._normalize_role_name(role_name)
        role_path = self._role_path(normalized)
        if not role_path.exists():
            return False
        try:
            role_path.unlink()
        except OSError:
            return False
        affected = [chat_id for chat_id, current in self.chat_roles.items() if current == normalized]
        for chat_id in affected:
            self.chat_roles.pop(chat_id, None)
        if affected:
            self._save_chat_roles()
        return True

    def _role_summary(self, role_name: str) -> str:
        try:
            content = self._read_role_content(role_name)
        except ValueError:
            return "(failed to read role)"
        return self._truncate_text(" ".join(content.split()), limit=160)

    def _format_role_state(self, chat_id: int) -> str:
        current_role = self._active_role_name(chat_id)
        roles = self._list_roles()
        lines = [f"Current active role: {current_role or '(none)'}"]
        if not roles:
            lines.append("No saved roles are defined yet.")
            return "\n".join(lines)

        for role_name in roles:
            marker = " [active]" if role_name == current_role else ""
            lines.append(f"- {role_name}{marker}: {self._role_summary(role_name)}")
        return "\n".join(lines)

    def _save_chat_workdirs(self) -> None:
        payload = {str(chat_id): workdir for chat_id, workdir in self.chat_workdirs.items()}
        self.workdirs_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        try:
            os.chmod(self.workdirs_path, 0o600)
        except OSError:
            pass

    def _save_chat_command_prefixes(self) -> None:
        payload = {str(chat_id): prefix for chat_id, prefix in self.chat_command_prefixes.items()}
        self.command_prefixes_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        try:
            os.chmod(self.command_prefixes_path, 0o600)
        except OSError:
            pass

    def _load_page_sessions(self) -> Dict[tuple[int, int], PageSession]:
        if not self.page_sessions_path.exists():
            return {}
        try:
            raw = json.loads(self.page_sessions_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, list):
            return {}

        now = time.time()
        sessions: Dict[tuple[int, int], PageSession] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                chat_id = int(item.get("chat_id"))
                message_id = int(item.get("message_id"))
                created_at = float(item.get("created_at", now))
                last_access = float(item.get("last_access", created_at))
                current_index = int(item.get("current_index", 0))
            except (TypeError, ValueError):
                continue

            pages_raw = item.get("pages")
            if not isinstance(pages_raw, list):
                continue
            pages = [page for page in pages_raw if isinstance(page, str) and page.strip()]
            if not pages:
                continue

            if now - last_access > PAGE_SESSION_TTL_SECONDS:
                continue

            if current_index < 0:
                current_index = 0
            if current_index >= len(pages):
                current_index = len(pages) - 1

            key = (chat_id, message_id)
            sessions[key] = PageSession(
                chat_id=chat_id,
                message_id=message_id,
                pages=pages,
                created_at=created_at,
                last_access=last_access,
                current_index=current_index,
            )
        return sessions

    def _save_page_sessions(self) -> None:
        payload = [
            {
                "chat_id": session.chat_id,
                "message_id": session.message_id,
                "pages": session.pages,
                "created_at": session.created_at,
                "last_access": session.last_access,
                "current_index": session.current_index,
            }
            for session in sorted(
                self.page_sessions.values(),
                key=lambda value: (value.chat_id, value.message_id),
            )
        ]
        self.page_sessions_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        try:
            os.chmod(self.page_sessions_path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _parse_toggle_value(raw: str) -> Optional[bool]:
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on", "enable", "enabled"}:
            return True
        if normalized in {"0", "false", "no", "off", "disable", "disabled"}:
            return False
        return None

    @staticmethod
    def _parse_auth_ttl_setting(raw: str) -> Optional[tuple[int, str]]:
        value = raw.strip()
        match = re.fullmatch(r"(?i)(\d+)\s*([smhd]?)", value)
        if not match:
            return None

        amount = int(match.group(1))
        unit = (match.group(2) or "").lower()
        multipliers = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}
        seconds = amount * multipliers[unit]
        if seconds <= 0:
            return None

        env_value = f"{amount}{unit}" if unit else str(amount)
        return seconds, env_value

    def _upsert_env_settings(self, updates: Dict[str, str]) -> None:
        existing_lines: list[str] = []
        if self.env_path.exists():
            existing_lines = self.env_path.read_text(encoding="utf-8").splitlines()

        remaining = dict(updates)
        output_lines: list[str] = []
        for raw_line in existing_lines:
            stripped = raw_line.strip()
            if not stripped or stripped.startswith("#") or "=" not in raw_line:
                output_lines.append(raw_line)
                continue
            key, _ = raw_line.split("=", 1)
            normalized_key = key.strip()
            if normalized_key in remaining:
                output_lines.append(f"{normalized_key}={remaining.pop(normalized_key)}")
                continue
            output_lines.append(raw_line)

        for key in sorted(remaining):
            output_lines.append(f"{key}={remaining[key]}")

        payload = "\n".join(output_lines).rstrip("\n") + "\n"
        self.env_path.write_text(payload, encoding="utf-8")
        try:
            os.chmod(self.env_path, 0o600)
        except OSError:
            pass

        for key, value in updates.items():
            os.environ[key] = value

    def _get_chat_workdir(self, chat_id: int) -> Optional[Path]:
        raw = self.chat_workdirs.get(chat_id, "").strip()
        if not raw:
            return None
        try:
            path = Path(raw).expanduser().resolve()
        except OSError:
            return None
        if not path.exists() or not path.is_dir():
            return None
        return path

    def _set_chat_workdir(self, chat_id: int, workdir: Path) -> None:
        self.chat_workdirs[chat_id] = str(workdir)
        self._save_chat_workdirs()

    def _get_chat_command_prefix(self, chat_id: int) -> str:
        raw = self.chat_command_prefixes.get(chat_id, "").strip()
        if raw:
            return raw
        return self._default_command_prefix_for_chat(chat_id)

    def _set_chat_command_prefix(self, chat_id: int, command_prefix: str) -> None:
        normalized = command_prefix.strip()
        if not normalized or normalized == self._default_command_prefix_for_chat(chat_id):
            self.chat_command_prefixes.pop(chat_id, None)
        else:
            self.chat_command_prefixes[chat_id] = normalized
        self._save_chat_command_prefixes()

    def _clear_chat_command_prefix(self, chat_id: int) -> bool:
        existed = chat_id in self.chat_command_prefixes
        if existed:
            self.chat_command_prefixes.pop(chat_id, None)
            self._save_chat_command_prefixes()
        return existed

    def _clear_chat_workdir(self, chat_id: int) -> bool:
        existed = chat_id in self.chat_workdirs
        if existed:
            self.chat_workdirs.pop(chat_id, None)
            self._save_chat_workdirs()
        return existed

    def _resolve_target_workdir(self, chat_id: int, raw_path: str) -> Path:
        normalized = raw_path.strip()
        if not normalized:
            raise ValueError("directory path cannot be empty")
        base = self._get_chat_workdir(chat_id) or self._default_workdir()
        candidate = Path(normalized).expanduser()
        target = candidate if candidate.is_absolute() else (base / candidate)
        resolved = target.resolve()
        if not resolved.exists():
            raise ValueError(f"directory does not exist: {resolved}")
        if not resolved.is_dir():
            raise ValueError(f"not a directory: {resolved}")
        return resolved

    def _effective_workdir(self, chat_id: int) -> Path:
        return self._get_chat_workdir(chat_id) or self._default_workdir()

    @staticmethod
    def _opencode_parts_with_workdir(parts: list[str], workdir: Path) -> list[str]:
        resolved = list(parts)
        dir_idx = resolved.index("--dir")
        if dir_idx + 1 >= len(resolved):
            raise ValueError("command prefix must provide a directory after --dir")
        if resolved[dir_idx + 1] == OPENCODE_PROJECT_PATH_PLACEHOLDER:
            resolved[dir_idx + 1] = str(workdir)
        return resolved

    def _command_backend(self, command_prefix: str) -> str:
        return "opencode" if _is_opencode_prefix(command_prefix) else "codex"

    def _display_command_prefix(self, chat_id: int, command_prefix: str) -> str:
        prefix = command_prefix.strip()
        if not prefix:
            return ""
        if self._command_backend(prefix) != "opencode":
            return self._redacted_command_text(prefix)
        try:
            parts = self._opencode_parts_with_workdir(
                _validate_opencode_prefix(prefix),
                self._effective_workdir(chat_id),
            )
        except ValueError:
            return self._redacted_command_text(prefix)
        return self._redacted_command_text(shlex.join(parts))

    @staticmethod
    def _skills_root_dir() -> Path:
        codex_home = os.getenv("CODEX_HOME", "").strip()
        if codex_home:
            base = Path(codex_home).expanduser()
        else:
            base = Path.home() / ".codex"
        return base / "skills"

    def _ensure_project_skills(self) -> None:
        if not self.project_skills_dir.exists() or not self.project_skills_dir.is_dir():
            return
        skills_root = self._skills_root_dir()
        try:
            skills_root.mkdir(parents=True, exist_ok=True)
        except OSError:
            return

        for skill_dir in self.project_skills_dir.iterdir():
            if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").is_file():
                continue
            target_dir = skills_root / skill_dir.name
            try:
                shutil.copytree(skill_dir, target_dir, dirs_exist_ok=True)
            except OSError:
                continue

    @staticmethod
    def _strip_frontmatter(text: str) -> str:
        if not text.startswith("---"):
            return text.strip()
        lines = text.splitlines()
        if not lines or lines[0].strip() != "---":
            return text.strip()
        for index, raw in enumerate(lines[1:], start=1):
            if raw.strip() == "---":
                return "\n".join(lines[index + 1 :]).strip()
        return text.strip()

    def _skill_dir(self, skill_name: str) -> Optional[Path]:
        normalized = (skill_name or "").strip()
        if not normalized:
            return None

        installed = self._skills_root_dir() / normalized
        if (installed / "SKILL.md").is_file():
            return installed

        bundled = self.project_skills_dir / normalized
        if (bundled / "SKILL.md").is_file():
            return bundled
        return None

    def _read_skill_body(self, skill_name: str) -> str:
        skill_dir = self._skill_dir(skill_name)
        if skill_dir is None:
            return ""
        skill_path = skill_dir / "SKILL.md"
        try:
            stat = skill_path.stat()
        except OSError:
            return ""
        cached = self.skill_body_cache.get(skill_name)
        if cached is not None:
            cached_path, cached_mtime_ns, cached_body = cached
            if cached_path == skill_path and cached_mtime_ns == stat.st_mtime_ns:
                return cached_body
        try:
            content = skill_path.read_text(encoding="utf-8")
        except OSError:
            return ""
        body = self._strip_frontmatter(content)
        self.skill_body_cache[skill_name] = (skill_path, stat.st_mtime_ns, body)
        return body

    @staticmethod
    def _parse_skill_frontmatter(text: str) -> tuple[str, str]:
        lines = text.splitlines()
        if not lines or lines[0].strip() != "---":
            return "", ""

        name = ""
        description = ""
        for raw in lines[1:]:
            line = raw.strip()
            if line == "---":
                break
            if ":" not in raw:
                continue
            key, value = raw.split(":", 1)
            key = key.strip().lower()
            value = value.strip().strip('"').strip("'")
            if key == "name" and value and not name:
                name = value
            elif key == "description" and value and not description:
                description = value
        return name, description

    def _discover_installed_skills(self) -> tuple[Path, list[SkillInfo]]:
        skills_root = self._skills_root_dir()
        if not skills_root.exists() or not skills_root.is_dir():
            return skills_root, []

        skills: list[SkillInfo] = []
        for skill_md in sorted(skills_root.rglob("SKILL.md")):
            if not skill_md.is_file():
                continue
            try:
                relative = skill_md.relative_to(skills_root)
            except ValueError:
                continue

            relative_dir = relative.parent
            path_name = relative_dir.as_posix()
            if path_name.startswith(".system/"):
                path_name = path_name.split("/", 1)[1]
            if path_name in {"", "."}:
                path_name = skill_md.parent.name or "unknown-skill"

            metadata_name = ""
            metadata_desc = ""
            try:
                content = skill_md.read_text(encoding="utf-8")
            except OSError:
                content = ""
            if content:
                metadata_name, metadata_desc = self._parse_skill_frontmatter(content)

            name = metadata_name.strip() or path_name
            description = metadata_desc.strip() or "No description."
            is_system = bool(relative_dir.parts) and relative_dir.parts[0] == ".system"
            skills.append(
                SkillInfo(
                    name=name,
                    description=description,
                    skill_md=skill_md.resolve(),
                    is_system=is_system,
                )
            )

        skills.sort(key=lambda item: (item.is_system, item.name.lower()))
        return skills_root, skills

    @staticmethod
    def _format_skill_name_lines(skills: list[SkillInfo], start_index: int = 1) -> list[str]:
        lines: list[str] = []
        for idx, skill in enumerate(skills, start=start_index):
            lines.append(f"{idx}. <code>{html.escape(skill.name)}</code>")
        return lines

    @staticmethod
    def _truncate_text(text: str, limit: int = 120) -> str:
        stripped = " ".join(text.split())
        if len(stripped) <= limit:
            return stripped
        return stripped[: max(0, limit - 3)].rstrip() + "..."

    @staticmethod
    def _extract_session_id(output: str) -> Optional[str]:
        found = SESSION_ID_RE.findall(output)
        if not found:
            return None
        return found[-1]

    @staticmethod
    def _build_resume_command(prefix: list[str], session_id: str, prompt: str) -> Optional[list[str]]:
        cmd = list(prefix)
        if "exec" in cmd:
            exec_idx = cmd.index("exec")
            if exec_idx + 1 < len(cmd) and not cmd[exec_idx + 1].startswith("-"):
                # Prefix already specifies a concrete exec subcommand; avoid rewriting unexpectedly.
                return None
            # Keep all exec-level options in-place, then append resume subcommand.
            cmd.extend(["resume", session_id, prompt])
            return cmd
        cmd.extend(["exec", "resume", session_id, prompt])
        return cmd

    def _resolve_codex_command_for_request(self, request: ExecutionRequest, prompt: str) -> tuple[list[str], str, Path]:
        prefix = request.command_prefix or self._get_chat_command_prefix(request.chat_id)
        workdir = request.workdir or self._effective_workdir(request.chat_id)
        session_id = self._get_request_session_id(request)

        if self._command_backend(prefix) == "opencode":
            parts = _validate_opencode_prefix(prefix)
            parts = self._opencode_parts_with_workdir(parts, workdir)
            if parts[0] == "opencode":
                opencode_path = Path("~/.opencode/bin/opencode").expanduser()
                if opencode_path.exists():
                    parts[0] = str(opencode_path)
            return parts + [prompt], "", workdir

        base = _validate_codex_prefix(prefix)
        if request.session_mode != "fresh" and session_id:
            resume_cmd = self._build_resume_command(base, session_id, prompt)
            if resume_cmd is not None:
                return resume_cmd, session_id, workdir
        return base + [prompt], "", workdir

    def _resolve_codex_command(self, chat_id: int, prompt: str) -> tuple[list[str], str, Path]:
        request = ExecutionRequest(chat_id=chat_id, prompt=prompt, source="telegram")
        return self._resolve_codex_command_for_request(request, prompt)

    def is_allowed(self, chat_id: int) -> bool:
        return chat_id in self.settings.allowed_chat_ids

    def is_admin(self, chat_id: int) -> bool:
        return chat_id in self.settings.admin_chat_ids

    def is_user_allowed(self, user_id: Optional[int]) -> bool:
        return user_id is not None and user_id in self.settings.allowed_user_ids

    def is_admin_user(self, user_id: Optional[int]) -> bool:
        return user_id is not None and user_id in self.settings.admin_user_ids

    def _is_update_authorized(self, update: Update, require_admin: bool = False) -> bool:
        chat = update.effective_chat
        if chat is None or not self.is_allowed(chat.id):
            return False
        user = update.effective_user
        user_id = user.id if user else None
        if not self.is_user_allowed(user_id):
            return False
        if require_admin and (not self.is_admin(chat.id) or not self.is_admin_user(user_id)):
            return False
        return True

    @staticmethod
    def _mask_sensitive_args(args: list[str]) -> list[str]:
        redacted: list[str] = []
        mask_next = False
        for arg in args:
            if mask_next:
                redacted.append("***")
                mask_next = False
                continue

            lowered = arg.lower()
            if "=" in arg:
                key, value = arg.split("=", 1)
                if SENSITIVE_OPTION_RE.search(key):
                    redacted.append(f"{key}=***")
                    continue
                if SENSITIVE_OPTION_RE.search(lowered):
                    redacted.append(f"{key}=***")
                    continue
                if LONG_SECRET_RE.fullmatch(value):
                    redacted.append(f"{key}=***")
                    continue
                redacted.append(arg)
                continue

            if SENSITIVE_OPTION_RE.search(lowered):
                redacted.append(arg)
                mask_next = True
                continue

            if LONG_SECRET_RE.fullmatch(arg):
                redacted.append("***")
                continue

            redacted.append(arg)
        return redacted

    def _redacted_command_text(self, command: str) -> str:
        try:
            args = shlex.split(command)
        except ValueError:
            return command
        return shlex.join(self._mask_sensitive_args(args))

    def _ordered_memory_scopes(self, request: ExecutionRequest) -> list[str]:
        scopes: list[str] = []
        for scope in (
            request.memory_scope or self._default_memory_scope(request.chat_id),
            f"job:{request.session_ref}" if request.session_mode == "job" and request.session_ref else "",
            f"role:{request.role}" if request.role else "",
            self._default_memory_scope(request.chat_id),
            "global",
        ):
            normalized = (scope or "").strip()
            if normalized and normalized not in scopes:
                scopes.append(normalized)
        return scopes

    @staticmethod
    def _normalize_memory_tags(raw_tags) -> list[str]:
        if isinstance(raw_tags, str):
            candidates = [item.strip() for item in raw_tags.split(",")]
        elif isinstance(raw_tags, list):
            candidates = [str(item).strip() for item in raw_tags]
        else:
            candidates = []

        normalized: list[str] = []
        for tag in candidates:
            if tag and tag not in normalized:
                normalized.append(tag)
        return normalized[:8]

    def _format_memory_state(self, memories: list[MemoryRecord]) -> str:
        if not memories:
            return "No active memories are stored for this chat yet."

        lines: list[str] = []
        total_chars = 0
        for memory in memories:
            tag_text = ", ".join(memory.tags[:4]) if memory.tags else "-"
            content = self._truncate_text(" ".join(memory.content.split()), limit=320)
            entry = (
                f"- id={memory.id} scope={memory.scope} kind={memory.kind} "
                f"pinned={'yes' if memory.pinned else 'no'} importance={memory.importance} tags={tag_text}\n"
                f"  {content}"
            )
            if total_chars + len(entry) > self.settings.memory_max_chars:
                break
            lines.append(entry)
            total_chars += len(entry)

        return "\n".join(lines) if lines else "No active memories are stored for this chat yet."

    def _format_schedule_state(self, chat_id: int) -> str:
        if not self.settings.enable_scheduler:
            return "Scheduler is disabled for this bridge instance."

        jobs = self.scheduler_store.list_jobs(chat_id)
        if not jobs:
            return "No scheduled jobs are stored for this chat yet."

        lines: list[str] = []
        total_chars = 0
        max_chars = 2600
        for job in jobs:
            state = "enabled" if job.enabled else "paused"
            prompt_preview = self._truncate_text(" ".join(job.prompt_template.split()), limit=220)
            entry = (
                f"- id={job.id} state={state} schedule={job.schedule_type} {job.schedule_expr} tz={job.timezone} "
                f"next={self._format_timestamp(job.next_run_at, job.timezone)} role={job.role or '(none)'}\n"
                f"  memory_scope={job.memory_scope or '(none)'} session_policy={job.session_policy} prompt={prompt_preview}"
            )
            if total_chars + len(entry) > max_chars:
                break
            lines.append(entry)
            total_chars += len(entry)

        return "\n".join(lines) if lines else "No scheduled jobs are stored for this chat yet."

    def _build_prompt_with_memory(self, request: ExecutionRequest) -> tuple[str, list[MemoryRecord]]:
        prompt = request.prompt.strip()
        if not prompt:
            return prompt, []

        sections: list[str] = []
        compact_context = self._is_opencode_request(request)
        role_sync_intent = self._has_role_sync_intent(prompt)
        memory_sync_intent = self._has_memory_sync_intent(prompt)
        schedule_sync_intent = request.source == "schedule" or self._has_schedule_sync_intent(prompt)

        if compact_context:
            sections.append(
                "[REMOTE HOST]\n"
                "Running through Telegram remote control. Keep progress concise and action-oriented. "
                "Only emit tg-role-ops, tg-memory-ops, or tg-schedule-ops blocks when the user explicitly asks to change roles, memory, or schedules."
            )
        else:
            remote_skill_body = self._read_skill_body(REMOTE_CONTROL_SKILL_NAME)
            if remote_skill_body:
                sections.append(
                    "[REMOTE CONTROL SKILL]\n"
                    f"Skill name: {REMOTE_CONTROL_SKILL_NAME}\n"
                    "The following skill is preloaded by changxian-agent for host-bridge remote control and scheduled execution. Adapt it to the active host capabilities and control surface.\n\n"
                    + remote_skill_body
                )
        role_skill_body = ""
        if (not compact_context) or role_sync_intent:
            role_skill_body = self._read_skill_body(ROLE_SKILL_NAME)
        if role_skill_body:
            sections.append(
                "[ROLE SKILL]\n"
                f"Skill name: {ROLE_SKILL_NAME}\n"
                "The following skill is preloaded by changxian-agent for role management. Follow it when creating, updating, selecting, or clearing reusable roles.\n\n"
                + role_skill_body
            )
        if not compact_context or role_sync_intent:
            sections.append(
                "[ROLE STATE]\n"
                "This role state is loaded at conversation init and refreshed on each turn.\n"
                + self._format_role_state(request.chat_id)
            )

        if request.role:
            role_name = request.role.strip().lower()
            try:
                role_content = self._read_role_content(role_name)
            except ValueError:
                role_content = f"You are acting as: {role_name}"
            sections.append("[ACTIVE ROLE]\n" + role_content)

        memories: list[MemoryRecord] = []
        if self.settings.enable_memory:
            scopes = self._ordered_memory_scopes(request)
            include_memory_context = (not compact_context) or memory_sync_intent or request.source == "schedule"
            if include_memory_context:
                memories = self.memory_store.search_memories(
                    chat_id=request.chat_id,
                    scopes=scopes,
                    query="",
                    limit=self.settings.memory_max_items,
                )
            skill_body = ""
            if include_memory_context and ((not compact_context) or memory_sync_intent):
                skill_body = self._read_skill_body(MEMORY_SKILL_NAME)
            if skill_body:
                sections.append(
                    "[MEMORY SKILL]\n"
                    f"Skill name: {MEMORY_SKILL_NAME}\n"
                    "The following skill is preloaded by changxian-agent for this conversation. Follow it exactly when using or updating memory.\n\n"
                    + skill_body
                )
            if include_memory_context and memories:
                sections.append(
                    "[MEMORY STATE]\n"
                    "This memory state is loaded at conversation init and refreshed on each turn. Use it as the authoritative saved context for this chat.\n"
                    + self._format_memory_state(memories)
                )

        if self.settings.enable_scheduler and ((not compact_context) or schedule_sync_intent):
            skill_body = self._read_skill_body(SCHEDULE_SKILL_NAME)
            if skill_body:
                sections.append(
                    "[SCHEDULE SKILL]\n"
                    f"Skill name: {SCHEDULE_SKILL_NAME}\n"
                    "The following skill is preloaded by changxian-agent for scheduled-job management. Follow it when creating, updating, pausing, resuming, triggering, or deleting schedules.\n\n"
                    + skill_body
                )
            sections.append(
                "[SCHEDULE STATE]\n"
                "This schedule state is loaded at conversation init and refreshed on each turn. Use it as the authoritative scheduled-job state for this chat.\n"
                + self._format_schedule_state(request.chat_id)
            )

        sections.append("[CURRENT TASK]\n" + prompt)
        return "\n\n".join(section for section in sections if section.strip()), memories

    def _extract_role_ops(self, output: str) -> tuple[list[dict], str]:
        payloads: list[str] = []

        def _replace(match: re.Match[str]) -> str:
            payload = (match.group(1) or "").strip()
            if payload:
                payloads.append(payload)
            return ""

        stripped = ROLE_OPS_BLOCK_RE.sub(_replace, output)
        operations: list[dict] = []
        for payload in payloads:
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                raw_ops = parsed.get("ops", [])
            elif isinstance(parsed, list):
                raw_ops = parsed
            else:
                raw_ops = []
            if isinstance(raw_ops, list):
                operations.extend(item for item in raw_ops if isinstance(item, dict))
        compact = re.sub(r"\n{3,}", "\n\n", stripped).strip()
        return operations, compact

    @staticmethod
    def _has_role_sync_intent(prompt: str) -> bool:
        return bool(ROLE_SYNC_INTENT_RE.search(prompt or ""))

    @staticmethod
    def _has_schedule_sync_intent(prompt: str) -> bool:
        text = (prompt or "").strip()
        if not text:
            return False
        if SCHEDULE_SYNC_ACTION_RE.search(text):
            return True
        if SCHEDULE_SYNC_READONLY_RE.search(text):
            return False
        return bool(SCHEDULE_SYNC_SCHEDULE_RE.search(text))

    @staticmethod
    def _has_memory_sync_intent(prompt: str) -> bool:
        return bool(MEMORY_SYNC_INTENT_RE.search(prompt or ""))

    def _is_opencode_request(self, request: ExecutionRequest) -> bool:
        prefix = (request.command_prefix or self._get_chat_command_prefix(request.chat_id) or "").strip()
        if not prefix:
            return False
        return self._command_backend(prefix) == "opencode"

    @staticmethod
    def _normalize_schedule_signature_value(raw_value: object) -> str:
        return " ".join(str(raw_value or "").split()).strip().lower()

    def _find_duplicate_schedule_job(
        self,
        *,
        chat_id: int,
        schedule_type: str,
        schedule_expr: str,
        timezone: str,
        prompt_template: str,
        role: str,
        memory_scope: str,
        workdir: str,
        command_prefix: str,
        session_policy: str,
        exclude_job_id: str = "",
    ) -> Optional[ScheduledJob]:
        signature = (
            self._normalize_schedule_signature_value(schedule_type),
            self._normalize_schedule_signature_value(schedule_expr),
            self._normalize_schedule_signature_value(timezone),
            self._normalize_schedule_signature_value(prompt_template),
            self._normalize_schedule_signature_value(role),
            self._normalize_schedule_signature_value(memory_scope),
            self._normalize_schedule_signature_value(workdir),
            self._normalize_schedule_signature_value(command_prefix),
            self._normalize_schedule_signature_value(session_policy),
        )
        for job in self.scheduler_store.list_jobs(chat_id):
            if exclude_job_id and job.id == exclude_job_id:
                continue
            job_signature = (
                self._normalize_schedule_signature_value(job.schedule_type),
                self._normalize_schedule_signature_value(job.schedule_expr),
                self._normalize_schedule_signature_value(job.timezone),
                self._normalize_schedule_signature_value(job.prompt_template),
                self._normalize_schedule_signature_value(job.role),
                self._normalize_schedule_signature_value(job.memory_scope),
                self._normalize_schedule_signature_value(job.workdir),
                self._normalize_schedule_signature_value(job.command_prefix),
                self._normalize_schedule_signature_value(job.session_policy),
            )
            if job_signature == signature:
                return job
        return None

    def _apply_role_skill_ops(self, request: ExecutionRequest, operations: list[dict]) -> str:
        if not operations:
            return ""

        added = 0
        updated = 0
        activated = 0
        cleared = 0
        deleted = 0
        change_details: list[str] = []

        for op in operations:
            action = str(op.get("op") or op.get("action") or "").strip().lower()
            role_name_raw = str(op.get("name") or op.get("role") or op.get("role_name") or "").strip()

            if action in {"upsert_role", "save_role", "create_role", "update_role"}:
                content = str(op.get("content") or op.get("definition") or "").strip()
                if not role_name_raw or not content:
                    continue
                try:
                    normalized = self._normalize_role_name(role_name_raw)
                except ValueError:
                    continue

                role_path = self._role_path(normalized)
                existed_before = role_path.exists()
                if existed_before:
                    try:
                        existing_content = self._read_role_content(normalized)
                    except ValueError:
                        existing_content = ""
                    if existing_content != content:
                        try:
                            self._write_role_content(normalized, content)
                        except ValueError:
                            continue
                        updated += 1
                        change_details.append(f"updated role {normalized}: content")
                else:
                    try:
                        self._write_role_content(normalized, content)
                    except ValueError:
                        continue
                    added += 1
                    change_details.append(f"added role {normalized}")

                if bool(op.get("activate") or op.get("use") or op.get("select")):
                    current_role = self._active_role_name(request.chat_id)
                    if current_role != normalized:
                        self._set_chat_role(request.chat_id, normalized)
                        activated += 1
                        change_details.append(f"activated role {normalized}")
                continue

            if action in {"use_role", "select_role", "activate_role"}:
                if not role_name_raw:
                    continue
                try:
                    normalized = self._normalize_role_name(role_name_raw)
                except ValueError:
                    continue
                if not self._role_path(normalized).exists():
                    continue
                current_role = self._active_role_name(request.chat_id)
                if current_role == normalized:
                    continue
                self._set_chat_role(request.chat_id, normalized)
                activated += 1
                change_details.append(f"activated role {normalized}")
                continue

            if action in {"clear_role", "reset_role", "unset_role"}:
                previous_role = self._active_role_name(request.chat_id)
                if previous_role and self._clear_chat_role(request.chat_id):
                    cleared += 1
                    change_details.append(f"cleared active role ({previous_role})")
                continue

            if action in {"delete_role", "remove_role"}:
                if not role_name_raw:
                    continue
                try:
                    normalized = self._normalize_role_name(role_name_raw)
                except ValueError:
                    continue
                previous_role = self._active_role_name(request.chat_id)
                changed = self._delete_role(normalized)
                if changed:
                    deleted += 1
                    change_details.append(f"deleted role {normalized}")
                    if previous_role == normalized:
                        cleared += 1
                        change_details.append(f"cleared active role ({normalized})")
                continue

        if not change_details:
            return ""

        parts: list[str] = []
        if added:
            parts.append(f"added {added}")
        if updated:
            parts.append(f"updated {updated}")
        if activated:
            parts.append(f"activated {activated}")
        if cleared:
            parts.append(f"cleared {cleared}")
        if deleted:
            parts.append(f"deleted {deleted}")

        lines = [", ".join(parts) if parts else f"changed {len(change_details)}"]
        preview_count = min(6, len(change_details))
        for detail in change_details[:preview_count]:
            lines.append(f"- {detail}")
        if len(change_details) > preview_count:
            lines.append(f"- and {len(change_details) - preview_count} more changes")
        return "\n".join(lines)

    def _extract_schedule_ops(self, output: str) -> tuple[list[dict], str]:
        payloads: list[str] = []

        def _replace(match: re.Match[str]) -> str:
            payload = (match.group(1) or "").strip()
            if payload:
                payloads.append(payload)
            return ""

        stripped = SCHEDULE_OPS_BLOCK_RE.sub(_replace, output)
        operations: list[dict] = []
        for payload in payloads:
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                raw_ops = parsed.get("ops", [])
            elif isinstance(parsed, list):
                raw_ops = parsed
            else:
                raw_ops = []
            if isinstance(raw_ops, list):
                operations.extend(item for item in raw_ops if isinstance(item, dict))
        compact = re.sub(r"\n{3,}", "\n\n", stripped).strip()
        return operations, compact

    def _find_schedule_job_for_op(self, request: ExecutionRequest, op: dict) -> Optional[ScheduledJob]:
        job_id = str(op.get("job_id") or op.get("id") or "").strip()
        if job_id:
            return self.scheduler_store.get_job(request.chat_id, job_id)

        jobs = self.scheduler_store.list_jobs(request.chat_id)
        name = str(op.get("name") or op.get("job_name") or "").strip().lower()
        query = str(op.get("query") or op.get("contains") or op.get("match") or "").strip().lower()

        if name:
            for job in jobs:
                if job.name.strip().lower() == name:
                    return job
        if query:
            for job in jobs:
                haystack = f"{job.id}\n{job.name}\n{job.prompt_template}".lower()
                if query in haystack:
                    return job
        return None

    @staticmethod
    def _normalize_schedule_session_policy(raw_value: str) -> str:
        normalized = (raw_value or "").strip().lower()
        policy_aliases = {
            "resume": "resume-job",
            "resume-job": "resume-job",
            "fresh": "fresh",
        }
        return policy_aliases.get(normalized, "")

    async def _apply_schedule_skill_ops(self, request: ExecutionRequest, operations: list[dict]) -> str:
        if not self.settings.enable_scheduler or not operations:
            return ""

        created = 0
        reused = 0
        updated = 0
        paused = 0
        resumed = 0
        triggered = 0
        deleted = 0
        change_details: list[str] = []

        for op in operations:
            action = str(op.get("op") or op.get("action") or "").strip().lower()
            target = self._find_schedule_job_for_op(request, op)

            if action in {"create_job", "add_job"}:
                prompt_text = str(op.get("prompt") or op.get("prompt_template") or op.get("task") or "").strip()
                schedule_kind = str(op.get("schedule_type") or op.get("type") or op.get("kind") or "").strip().lower()
                schedule_expr = str(op.get("schedule_expr") or op.get("expr") or op.get("schedule") or "").strip()
                if not prompt_text or not schedule_kind or not schedule_expr:
                    continue

                timezone_name = str(op.get("timezone") or self.settings.default_timezone).strip() or self.settings.default_timezone
                try:
                    normalized_expr, next_run_at = parse_schedule_spec(
                        schedule_kind,
                        schedule_expr,
                        timezone_name,
                        int(time.time()),
                    )
                except ValueError:
                    continue

                role_value = str(op.get("role") or "").strip().lower()
                if role_value in {"default", "current"}:
                    role_value = self._active_role_name(request.chat_id)
                elif role_value in {"none", "off", "clear", "reset"}:
                    role_value = ""
                elif role_value and not self._role_path(role_value).exists():
                    continue
                elif not role_value:
                    role_value = self._active_role_name(request.chat_id)

                memory_scope = str(op.get("memory_scope") or request.memory_scope or self._default_memory_scope(request.chat_id)).strip()
                session_policy = self._normalize_schedule_session_policy(str(op.get("session_policy") or "resume-job")) or "resume-job"
                name = str(op.get("name") or "").strip() or self._truncate_text(prompt_text.splitlines()[0].strip() or "scheduled task", limit=48)
                effective_workdir = str(request.workdir or self._effective_workdir(request.chat_id))
                effective_command_prefix = request.command_prefix or self._get_chat_command_prefix(request.chat_id)

                duplicate_job = self._find_duplicate_schedule_job(
                    chat_id=request.chat_id,
                    schedule_type=schedule_kind,
                    schedule_expr=normalized_expr,
                    timezone=timezone_name,
                    prompt_template=prompt_text,
                    role=role_value,
                    memory_scope=memory_scope,
                    workdir=effective_workdir,
                    command_prefix=effective_command_prefix,
                    session_policy=session_policy,
                    exclude_job_id="",
                )
                if duplicate_job is not None:
                    reused += 1
                    change_details.append(f"ignored duplicate create for {duplicate_job.id}")
                    continue

                job = self.scheduler_store.add_job(
                    chat_id=request.chat_id,
                    owner_user_id=request.owner_user_id,
                    name=name,
                    schedule_type=schedule_kind,
                    schedule_expr=normalized_expr,
                    timezone=timezone_name,
                    prompt_template=prompt_text,
                    role=role_value,
                    memory_scope=memory_scope,
                    workdir=effective_workdir,
                    command_prefix=effective_command_prefix,
                    session_policy=session_policy,
                    concurrency_policy="skip",
                    next_run_at=next_run_at,
                )
                if "enabled" in op and not bool(op.get("enabled")):
                    self.scheduler_store.set_enabled(request.chat_id, job.id, False, job.next_run_at)
                created += 1
                change_details.append(f"created {job.id} ({self._truncate_text(job.name, limit=48)})")
                continue

            if action in {"set_job", "update_job"}:
                if target is None:
                    continue

                name_value = None
                schedule_type_value = None
                schedule_expr_value = None
                timezone_value = None
                prompt_template_value = None
                role_value = None
                memory_scope_value = None
                session_policy_value = None
                next_run_at_value = None
                changed_fields: list[str] = []

                if "name" in op or "title" in op or "job_name" in op:
                    raw_name = str(op.get("name") or op.get("title") or op.get("job_name") or "").strip()
                    if raw_name and raw_name != target.name:
                        name_value = raw_name
                        changed_fields.append("name")

                raw_schedule_type = None
                if any(key in op for key in ("schedule_type", "type", "kind")):
                    raw_schedule_type = str(op.get("schedule_type") or op.get("type") or op.get("kind") or "").strip().lower()
                raw_schedule_expr = None
                if any(key in op for key in ("schedule_expr", "expr", "schedule")):
                    raw_schedule_expr = str(op.get("schedule_expr") or op.get("expr") or op.get("schedule") or "").strip()
                raw_timezone = None
                if "timezone" in op:
                    raw_timezone = str(op.get("timezone") or "").strip()

                if raw_schedule_type is not None or raw_schedule_expr is not None or raw_timezone is not None:
                    effective_schedule_type = raw_schedule_type or target.schedule_type
                    effective_schedule_expr = raw_schedule_expr or target.schedule_expr
                    effective_timezone = raw_timezone or target.timezone
                    try:
                        normalized_expr, next_run_at = parse_schedule_spec(
                            effective_schedule_type,
                            effective_schedule_expr,
                            effective_timezone,
                            int(time.time()),
                        )
                    except ValueError:
                        continue
                    if effective_schedule_type != target.schedule_type:
                        schedule_type_value = effective_schedule_type
                        changed_fields.append("schedule_type")
                    if normalized_expr != target.schedule_expr:
                        schedule_expr_value = normalized_expr
                        changed_fields.append("schedule_expr")
                    if effective_timezone != target.timezone:
                        timezone_value = effective_timezone
                        changed_fields.append("timezone")
                    if (
                        schedule_type_value is not None
                        or schedule_expr_value is not None
                        or timezone_value is not None
                    ):
                        next_run_at_value = next_run_at

                if "prompt" in op or "prompt_template" in op or "task" in op:
                    raw_prompt = str(op.get("prompt") or op.get("prompt_template") or op.get("task") or "").strip()
                    if raw_prompt and raw_prompt != target.prompt_template:
                        prompt_template_value = raw_prompt
                        changed_fields.append("prompt")

                if "role" in op:
                    normalized = str(op.get("role") or "").strip().lower()
                    if normalized in {"", "none", "off", "clear", "reset"}:
                        role_value = ""
                    elif normalized in {"default", "current"}:
                        role_value = self._active_role_name(request.chat_id)
                    elif self._role_path(normalized).exists():
                        role_value = normalized
                    else:
                        role_value = None
                    if role_value is not None and role_value != target.role:
                        changed_fields.append("role")
                    else:
                        role_value = None

                if "memory_scope" in op or "scope" in op:
                    raw_scope = str(op.get("memory_scope") or op.get("scope") or "").strip()
                    if raw_scope.lower() in {"default", "chat", "chat:current", "reset"}:
                        raw_scope = request.memory_scope or self._default_memory_scope(request.chat_id)
                    if raw_scope and raw_scope != target.memory_scope:
                        memory_scope_value = raw_scope
                        changed_fields.append("memory_scope")

                if "session_policy" in op or "session" in op:
                    normalized_policy = self._normalize_schedule_session_policy(
                        str(op.get("session_policy") or op.get("session") or "")
                    )
                    if normalized_policy and normalized_policy != target.session_policy:
                        session_policy_value = normalized_policy
                        changed_fields.append("session_policy")

                if not changed_fields:
                    continue

                duplicate_job = self._find_duplicate_schedule_job(
                    chat_id=request.chat_id,
                    schedule_type=schedule_type_value or target.schedule_type,
                    schedule_expr=schedule_expr_value or target.schedule_expr,
                    timezone=timezone_value or target.timezone,
                    prompt_template=prompt_template_value or target.prompt_template,
                    role=role_value if role_value is not None else target.role,
                    memory_scope=memory_scope_value or target.memory_scope,
                    workdir=target.workdir,
                    command_prefix=target.command_prefix,
                    session_policy=session_policy_value or target.session_policy,
                    exclude_job_id=target.id,
                )
                if duplicate_job is not None:
                    reused += 1
                    change_details.append(f"ignored duplicate update for {duplicate_job.id}")
                    continue

                updated_job = self.scheduler_store.update_job_fields(
                    request.chat_id,
                    target.id,
                    name=name_value,
                    schedule_type=schedule_type_value,
                    schedule_expr=schedule_expr_value,
                    timezone=timezone_value,
                    prompt_template=prompt_template_value,
                    role=role_value,
                    memory_scope=memory_scope_value,
                    session_policy=session_policy_value,
                    next_run_at=next_run_at_value,
                )
                if updated_job is None:
                    continue
                if session_policy_value == "fresh" or prompt_template_value is not None:
                    self.scheduler_store.clear_job_session(updated_job.id)
                updated += 1
                change_details.append(f"updated {updated_job.id}: {', '.join(changed_fields)}")
                continue

            if action in {"pause_job", "disable_job"}:
                if target is None or not target.enabled:
                    continue
                if self.scheduler_store.set_enabled(request.chat_id, target.id, False, target.next_run_at):
                    paused += 1
                    change_details.append(f"paused {target.id}")
                continue

            if action in {"resume_job", "enable_job"}:
                if target is None or target.enabled:
                    continue
                now_ts = int(time.time())
                if target.schedule_type == "once":
                    if target.next_run_at is None or target.next_run_at <= now_ts:
                        continue
                    next_run_at = target.next_run_at
                else:
                    try:
                        _normalized_expr, next_run_at = parse_schedule_spec(
                            target.schedule_type,
                            target.schedule_expr,
                            target.timezone,
                            now_ts,
                        )
                    except ValueError:
                        continue
                if self.scheduler_store.set_enabled(request.chat_id, target.id, True, next_run_at):
                    resumed += 1
                    change_details.append(f"resumed {target.id}")
                continue

            if action in {"run_job", "trigger_job"}:
                if target is None:
                    continue
                try:
                    run_id = await self.scheduler_service.trigger_job_now(target)
                except RuntimeError:
                    continue
                triggered += 1
                change_details.append(f"triggered {target.id} (run {run_id})")
                continue

            if action in {"delete_job", "remove_job"}:
                if target is None:
                    continue
                if self.scheduler_store.delete_job(request.chat_id, target.id):
                    deleted += 1
                    change_details.append(f"deleted {target.id}")
                continue

        if not change_details:
            return ""

        parts: list[str] = []
        if created:
            parts.append(f"created {created}")
        if reused:
            parts.append(f"reused {reused}")
        if updated:
            parts.append(f"updated {updated}")
        if paused:
            parts.append(f"paused {paused}")
        if resumed:
            parts.append(f"resumed {resumed}")
        if triggered:
            parts.append(f"triggered {triggered}")
        if deleted:
            parts.append(f"deleted {deleted}")

        lines = [", ".join(parts) if parts else f"changed {len(change_details)}"]
        preview_count = min(6, len(change_details))
        for detail in change_details[:preview_count]:
            lines.append(f"- {detail}")
        if len(change_details) > preview_count:
            lines.append(f"- and {len(change_details) - preview_count} more changes")
        return "\n".join(lines)

    def _extract_memory_ops(self, output: str) -> tuple[list[dict], str]:
        payloads: list[str] = []

        def _replace(match: re.Match[str]) -> str:
            payload = (match.group(1) or "").strip()
            if payload:
                payloads.append(payload)
            return ""

        stripped = MEMORY_OPS_BLOCK_RE.sub(_replace, output)
        operations: list[dict] = []
        for payload in payloads:
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                raw_ops = parsed.get("ops", [])
            elif isinstance(parsed, list):
                raw_ops = parsed
            else:
                raw_ops = []
            if isinstance(raw_ops, list):
                operations.extend(item for item in raw_ops if isinstance(item, dict))
        compact = re.sub(r"\n{3,}", "\n\n", stripped).strip()
        return operations, compact

    def _resolve_memory_scope_for_op(self, request: ExecutionRequest, raw_scope: object) -> str:
        scope = str(raw_scope or "").strip()
        if not scope or scope in {"default", "chat", "chat:current"}:
            return request.memory_scope or self._default_memory_scope(request.chat_id)
        if scope == "role" and request.role:
            return f"role:{request.role}"
        return scope

    def _find_memory_for_op(self, request: ExecutionRequest, scope: str, op: dict) -> Optional[MemoryRecord]:
        memory_id = str(op.get("memory_id") or op.get("id") or "").strip()
        if memory_id:
            return self.memory_store.get_memory(request.chat_id, memory_id)

        records = self.memory_store.list_memories(request.chat_id, scope=scope or None, limit=100)
        title = str(op.get("title") or "").strip().lower()
        content = str(op.get("content") or op.get("match_content") or "").strip().lower()
        query = str(op.get("query") or op.get("match") or op.get("contains") or "").strip().lower()

        for record in records:
            if title and record.title.strip().lower() == title:
                return record
        for record in records:
            if content and record.content.strip().lower() == content:
                return record
        for record in records:
            haystack = f"{record.title}\n{record.content}".lower()
            if query and query in haystack:
                return record
            if title and title in haystack:
                return record
            if content and content in haystack:
                return record
        return None

    def _apply_memory_skill_ops(self, request: ExecutionRequest, operations: list[dict]) -> str:
        if not self.settings.enable_memory or not operations:
            return ""

        added = 0
        updated = 0
        deleted = 0
        pinned = 0
        change_details: list[str] = []

        def _memory_label(record: Optional[MemoryRecord] = None, *, title: str = "", content: str = "") -> str:
            raw_title = title.strip()
            raw_content = content.strip()
            if record is not None:
                raw_title = record.title.strip()
                raw_content = record.content.strip()
            label = raw_title or (raw_content.splitlines()[0].strip() if raw_content else "")
            if not label:
                label = "untitled"
            return self._truncate_text(label, limit=64)

        for op in operations:
            action = str(op.get("op") or op.get("action") or "").strip().lower()
            scope = self._resolve_memory_scope_for_op(request, op.get("scope"))
            target = self._find_memory_for_op(request, scope, op)

            if action in {"upsert", "add", "remember"}:
                content = str(op.get("content") or "").strip()
                if not content:
                    continue
                title = str(op.get("title") or "").strip() or self._truncate_text(content.splitlines()[0].strip(), limit=72)
                kind = str(op.get("kind") or "note").strip() or "note"
                tags = self._normalize_memory_tags(op.get("tags"))
                if "skill-managed" not in tags:
                    tags.append("skill-managed")
                if MEMORY_SKILL_NAME not in tags:
                    tags.append(MEMORY_SKILL_NAME)
                importance_raw = op.get("importance", 0)
                try:
                    importance = max(0, min(10, int(importance_raw)))
                except (TypeError, ValueError):
                    importance = 0
                pinned_flag = bool(op.get("pinned", False))

                if target is None:
                    created = self.memory_store.add_memory(
                        chat_id=request.chat_id,
                        scope=scope,
                        kind=kind,
                        title=title,
                        content=content,
                        tags=tags,
                        importance=importance,
                        pinned=pinned_flag,
                        source_type=f"skill:{MEMORY_SKILL_NAME}",
                        source_ref=request.session_ref or request.source,
                    )
                    added += 1
                    change_details.append(f"added {created.id} ({_memory_label(created)})")
                    continue

                merged_tags = list(target.tags)
                for tag in tags:
                    if tag not in merged_tags:
                        merged_tags.append(tag)

                next_scope = scope
                next_kind = kind
                next_title = title
                next_content = content
                next_tags = merged_tags
                next_importance = max(target.importance, importance)
                next_pinned = target.pinned or pinned_flag
                changed_fields: list[str] = []
                if target.scope != next_scope:
                    changed_fields.append("scope")
                if target.kind != next_kind:
                    changed_fields.append("kind")
                if target.title != next_title:
                    changed_fields.append("title")
                if target.content != next_content:
                    changed_fields.append("content")
                if target.tags != next_tags:
                    changed_fields.append("tags")
                if target.importance != next_importance:
                    changed_fields.append("importance")
                if target.pinned != next_pinned:
                    changed_fields.append("pinned")
                if not changed_fields:
                    continue

                self.memory_store.update_memory(
                    request.chat_id,
                    target.id,
                    scope=next_scope,
                    kind=next_kind,
                    title=next_title,
                    content=next_content,
                    tags=next_tags,
                    importance=next_importance,
                    pinned=next_pinned,
                    source_type=f"skill:{MEMORY_SKILL_NAME}",
                    source_ref=request.session_ref or request.source,
                )
                updated += 1
                field_list = ", ".join(changed_fields[:6])
                if len(changed_fields) > 6:
                    field_list += ", ..."
                change_details.append(f"updated {target.id} ({_memory_label(title=next_title, content=next_content)}): {field_list}")
                continue

            if action in {"delete", "forget", "remove"}:
                if target is None:
                    continue
                if self.memory_store.delete_memory(request.chat_id, target.id):
                    deleted += 1
                    change_details.append(f"deleted {target.id} ({_memory_label(target)})")
                continue

            if action in {"pin", "unpin"}:
                if target is None:
                    continue
                should_pin = action == "pin"
                if target.pinned == should_pin:
                    continue
                if self.memory_store.set_pinned(request.chat_id, target.id, pinned=should_pin):
                    pinned += 1
                    verb = "pinned" if should_pin else "unpinned"
                    change_details.append(f"{verb} {target.id} ({_memory_label(target)})")
                continue

        if not change_details:
            return ""

        parts: list[str] = []
        if added:
            parts.append(f"added {added}")
        if updated:
            parts.append(f"updated {updated}")
        if deleted:
            parts.append(f"deleted {deleted}")
        if pinned:
            parts.append(f"pin changes {pinned}")

        lines = [", ".join(parts) if parts else f"changed {len(change_details)}"]
        preview_count = min(6, len(change_details))
        for detail in change_details[:preview_count]:
            lines.append(f"- {detail}")
        if len(change_details) > preview_count:
            lines.append(f"- and {len(change_details) - preview_count} more changes")
        return "\n".join(lines)

    def _auto_save_execution_memory(self, request: ExecutionRequest, cleaned_output: str) -> None:
        if not self.settings.enable_memory or not self.settings.memory_auto_save:
            return
        if request.source != "schedule":
            return
        stripped = cleaned_output.strip()
        if not stripped:
            return
        summary = self._sanitize_output_for_preview(cleaned_output, "Completed").strip() or stripped
        summary = self._truncate_text(summary.replace("\x00", ""), limit=900)
        if len(summary) < 24:
            return
        scope = f"job:{request.session_ref}" if request.session_ref else (request.memory_scope or self._default_memory_scope(request.chat_id))
        title = self._truncate_text(request.prompt.splitlines()[0].strip() or "scheduled run", limit=72)
        tags = [request.source]
        if request.role:
            tags.append(request.role)
        self.memory_store.add_memory(
            chat_id=request.chat_id,
            scope=scope,
            kind="routine",
            title=title,
            content=summary,
            tags=tags,
            source_type="schedule",
            source_ref=request.session_ref,
        )

    async def notify_schedule_failure(self, job: ScheduledJob, reason: str) -> None:
        if self.application is None:
            return
        await self.application.bot.send_message(
            chat_id=job.chat_id,
            text=(
                "<b>Scheduled task failed</b>\n"
                f"Job: {self._code_inline(job.id)}\n"
                f"Reason: {self._code_inline(reason)}"
            ),
            parse_mode=ParseMode.HTML,
            disable_web_page_preview=True,
            read_timeout=30,
            write_timeout=30,
            connect_timeout=30,
            pool_timeout=5,
        )

    @staticmethod
    def _format_timestamp(timestamp: Optional[int], timezone_name: str) -> str:
        if timestamp is None:
            return "(n/a)"
        try:
            zone = ZoneInfo(timezone_name)
        except Exception:
            zone = ZoneInfo("UTC")
        return datetime.fromtimestamp(timestamp, zone).strftime("%Y-%m-%d %H:%M:%S %Z")

    def _is_second_factor_enabled(self) -> bool:
        return bool(self.settings.auth_passphrase)

    def _auth_key(self, update: Update) -> Optional[tuple[int, int]]:
        if update.effective_chat is None or update.effective_user is None:
            return None
        return (update.effective_chat.id, update.effective_user.id)

    def _cleanup_auth_sessions(self) -> None:
        now = time.monotonic()
        stale_keys = [key for key, expires_at in self.auth_sessions.items() if expires_at <= now]
        for key in stale_keys:
            self.auth_sessions.pop(key, None)

    def _auth_seconds_left(self, update: Update) -> int:
        if not self._is_second_factor_enabled():
            return 0
        key = self._auth_key(update)
        if key is None:
            return 0
        self._cleanup_auth_sessions()
        expires_at = self.auth_sessions.get(key, 0.0)
        return max(0, int(expires_at - time.monotonic()))

    async def _ensure_second_factor(self, update: Update) -> bool:
        if not self._is_second_factor_enabled():
            return True
        if self._auth_seconds_left(update) > 0:
            return True
        await self.send_html(
            update,
            "<b>Second-factor required</b>\n"
            "Use <code>/auth &lt;passphrase&gt;</code> to unlock execution.",
        )
        return False

    @staticmethod
    def _code_inline(value: str) -> str:
        return f"<code>{html.escape(value)}</code>"

    @staticmethod
    def _code_block(value: str) -> str:
        return f"<pre>{html.escape(value)}</pre>"

    @staticmethod
    def _code_block_with_language(value: str, language: str) -> str:
        safe_lang = language.strip().lower()
        if not re.fullmatch(r"[a-z0-9_+-]{1,32}", safe_lang):
            return Bridge._code_block(value)
        return f"<pre><code class=\"language-{safe_lang}\">{html.escape(value)}</code></pre>"

    @staticmethod
    def _looks_like_telegram_html(text: str) -> bool:
        return bool(re.search(r"</?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|a|code|pre)(?:\s|>|$)", text))

    def _coerce_telegram_html(self, text: str) -> str:
        stripped = text.strip()
        if not stripped:
            return ""
        if self._looks_like_telegram_html(stripped):
            return stripped
        return self._render_preview_html(stripped)

    async def send_html(self, update: Update, text: str) -> None:
        if update.effective_message is None:
            return
        await update.effective_message.reply_text(
            text=self._coerce_telegram_html(text),
            parse_mode=ParseMode.HTML,
            disable_web_page_preview=True,
        )

    async def _send_message_draft_raw(
        self,
        chat_id: int,
        draft_id: int,
        text: str,
        message_thread_id: Optional[int] = None,
    ) -> None:
        if not text.strip():
            return

        payload: dict[str, str] = {
            "chat_id": str(chat_id),
            "draft_id": str(draft_id),
            "text": self._coerce_telegram_html(text),
            "parse_mode": str(ParseMode.HTML),
        }
        if message_thread_id is not None:
            payload["message_thread_id"] = str(message_thread_id)

        def _post() -> None:
            url = f"https://api.telegram.org/bot{self.settings.bot_token}/sendMessageDraft"
            body = urllib.parse.urlencode(payload).encode("utf-8")
            request = urllib.request.Request(
                url=url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                    "User-Agent": "remote-control",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                detail = err.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"sendMessageDraft HTTP {err.code}: {detail}") from err
            except urllib.error.URLError as err:
                raise RuntimeError(f"sendMessageDraft request failed: {err}") from err
            except json.JSONDecodeError as err:
                raise RuntimeError("sendMessageDraft returned invalid JSON") from err

            if not isinstance(result, dict):
                raise RuntimeError("sendMessageDraft returned malformed payload")
            if result.get("ok"):
                return
            error_code = result.get("error_code")
            description = str(result.get("description", "unknown error"))
            if error_code is None:
                raise RuntimeError(f"sendMessageDraft failed: {description}")
            raise RuntimeError(f"sendMessageDraft failed ({error_code}): {description}")

        await asyncio.to_thread(_post)

    def _clean_output(self, output: str) -> str:
        text = ANSI_ESCAPE_RE.sub("", output).replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
        lines = text.splitlines()
        compact: list[str] = []
        previous: Optional[str] = None
        for line in lines:
            if CONFIG_CONTEXT_NOISE_RE.match(line.strip()):
                continue
            if line == previous:
                continue
            compact.append(line)
            previous = line
        return "\n".join(compact).strip()

    @staticmethod
    def _format_preview_lines(lines: list[str]) -> str:
        formatted: list[str] = []
        for line in lines:
            normalized = line.replace("\t", "  ").rstrip()
            if len(normalized) > PREVIEW_LINE_CHAR_LIMIT:
                normalized = normalized[: PREVIEW_LINE_CHAR_LIMIT - 1] + "…"
            formatted.append(normalized)
        return "\n".join(formatted).strip()

    @staticmethod
    def _slice_preview_lines(lines: list[str], max_lines: int) -> list[str]:
        if len(lines) <= max_lines:
            return list(lines)

        start = len(lines) - max_lines
        preview_lines = list(lines[start:])

        in_fence = False
        last_opening = "```"
        for line in lines[:start]:
            stripped = line.strip()
            if not MARKDOWN_FENCE_RE.match(stripped):
                continue
            if in_fence:
                in_fence = False
                last_opening = "```"
            else:
                in_fence = True
                last_opening = stripped or "```"

        if in_fence:
            preview_lines.insert(0, last_opening)

        if preview_lines and MARKDOWN_FENCE_CLOSE_RE.match(preview_lines[0].strip()) and not in_fence:
            preview_lines = preview_lines[1:]

        fence_open = False
        for line in preview_lines:
            stripped = line.strip()
            if not MARKDOWN_FENCE_RE.match(stripped):
                continue
            fence_open = not fence_open
        if fence_open:
            preview_lines.append("```")

        return preview_lines

    @staticmethod
    def _is_preview_noise_line(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        return any(pattern.match(stripped) for pattern in PREVIEW_NOISE_PATTERNS)

    @staticmethod
    def _normalize_trace_marker(line: str) -> Optional[str]:
        stripped = line.strip().lower()
        if not stripped:
            return None

        candidate = stripped.rstrip(":")
        if candidate in TRACE_SECTION_MARKERS:
            return candidate

        for prefix in ("role:", "section:", "trace:", "tool:"):
            if not stripped.startswith(prefix):
                continue
            candidate = stripped[len(prefix) :].strip().rstrip(":")
            if candidate in TRACE_SECTION_MARKERS:
                return candidate

        if stripped.startswith("[") and "]" in stripped:
            candidate = stripped.split("]", 1)[1].strip().rstrip(":")
            if candidate in TRACE_SECTION_MARKERS:
                return candidate

        return None

    def _parse_trace_sections(self, lines: list[str]) -> list[TraceSection]:
        sections: list[TraceSection] = []
        current_marker: Optional[str] = None
        current_lines: list[str] = []

        for line in lines:
            marker = self._normalize_trace_marker(line)
            if marker is not None:
                if current_marker and current_lines:
                    sections.append(TraceSection(marker=current_marker, lines=current_lines))
                current_marker = marker
                current_lines = []
                continue

            if current_marker is None:
                continue

            lowered = line.strip().lower()
            if lowered.startswith("tokens used"):
                if current_lines:
                    sections.append(TraceSection(marker=current_marker, lines=current_lines))
                current_marker = None
                current_lines = []
                continue

            if self._is_preview_noise_line(line):
                continue
            current_lines.append(line)

        if current_marker and current_lines:
            sections.append(TraceSection(marker=current_marker, lines=current_lines))

        return sections

    @staticmethod
    def _is_strong_code_line(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if CODE_INDENT_RE.match(line):
            return True
        if SHELL_PROMPT_RE.match(line):
            return True
        if CODE_KEYWORD_RE.match(stripped):
            return True
        if stripped in {"{", "}", "[", "]", "()", "[]", "{}", "};"}:
            return True
        return False

    @staticmethod
    def _line_looks_like_code(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if MARKDOWN_HEADING_RE.match(line) or MARKDOWN_BULLET_RE.match(line) or MARKDOWN_ORDERED_RE.match(line):
            return False
        if stripped.startswith(">"):
            return False
        if Bridge._is_strong_code_line(line):
            return True

        token_hits = sum(
            token in stripped for token in ("{", "}", "=>", "->", "::", "()", "[]", "==", "!=", "<=", ">=", " = ", ";")
        )
        if token_hits >= 2:
            return True

        if stripped.startswith(("SELECT ", "INSERT ", "UPDATE ", "DELETE ", "CREATE ", "ALTER ", "DROP ")):
            return True

        if stripped.startswith(("git ", "npm ", "pnpm ", "yarn ", "pip ", "python ", "go ", "cargo ", "kubectl ")):
            return True
        return False

    @staticmethod
    def _is_prose_line(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if MARKDOWN_HEADING_RE.match(line) or MARKDOWN_BULLET_RE.match(line) or MARKDOWN_ORDERED_RE.match(line):
            return True
        if stripped.startswith(("diff --git ", "index ", "--- ", "+++ ", "@@")):
            return False
        if Bridge._line_looks_like_code(line):
            return False
        if any("\u4e00" <= ch <= "\u9fff" for ch in stripped):
            return True
        if any(ch in stripped for ch in ("。", "，", "：", "；", "！", "？")):
            return True
        if re.search(r"[A-Za-z]", stripped) and " " in stripped and not re.search(r"[{}();=<>\[\]]", stripped):
            return True
        return False

    def _strip_accidental_outer_fence(self, text: str) -> str:
        normalized = text.strip()
        if "```" not in normalized:
            return normalized

        lines = normalized.splitlines()
        if len(lines) < 3:
            return normalized

        opening = lines[0].strip()
        closing = lines[-1].strip()
        if not MARKDOWN_FENCE_RE.match(opening) or not MARKDOWN_FENCE_CLOSE_RE.match(closing):
            return normalized

        body_lines = lines[1:-1]
        if not body_lines or any(MARKDOWN_FENCE_RE.match(line.strip()) for line in body_lines):
            return normalized

        opening_info = re.sub(r"^\s*`{3,}", "", opening).strip()
        if not opening_info:
            return normalized

        prose_hits = sum(1 for line in body_lines if self._is_prose_line(line))
        if prose_hits < 2:
            return normalized
        return "\n".join(body_lines).strip()

    def _fence_embedded_diff_blocks(self, text: str) -> str:
        normalized = text.strip()
        if not normalized:
            return normalized

        lines = normalized.splitlines()
        output: list[str] = []
        idx = 0
        in_fence = False
        while idx < len(lines):
            line = lines[idx]
            if MARKDOWN_FENCE_RE.match(line):
                in_fence = not in_fence
                output.append(line)
                idx += 1
                continue

            if in_fence:
                output.append(line)
                idx += 1
                continue

            stripped = line.strip()
            if not DIFF_HEADER_RE.match(stripped):
                output.append(line)
                idx += 1
                continue

            start = idx
            idx += 1
            saw_hunk = stripped.startswith("@@")
            while idx < len(lines):
                line = lines[idx]
                if MARKDOWN_FENCE_RE.match(line):
                    break
                stripped = line.strip()
                if DIFF_HEADER_RE.match(stripped):
                    if stripped.startswith("@@"):
                        saw_hunk = True
                    idx += 1
                    continue
                if line.startswith((" ", "+", "-")):
                    idx += 1
                    continue
                if saw_hunk and (line.startswith("    ") or line.startswith("\t")):
                    # Some outputs drop the leading diff marker; keep indented code as part of the hunk.
                    idx += 1
                    continue
                if not stripped and saw_hunk:
                    idx += 1
                    continue
                break

            block = "\n".join(lines[start:idx]).strip()
            if not block:
                continue
            if not self._looks_like_unfenced_diff(block):
                output.extend(lines[start:idx])
                continue
            if output and output[-1]:
                output.append("")
            output.append("```diff")
            output.extend(lines[start:idx])
            output.append("```")

        return "\n".join(output).strip()

    def _retag_fenced_diff_blocks(self, text: str) -> str:
        normalized = text.strip()
        if not normalized or "```" not in normalized:
            return normalized

        lines = normalized.splitlines()
        output: list[str] = []
        idx = 0
        while idx < len(lines):
            line = lines[idx]
            if not MARKDOWN_FENCE_RE.match(line):
                output.append(line)
                idx += 1
                continue

            opening = line.strip()
            body: list[str] = []
            idx += 1
            while idx < len(lines) and not MARKDOWN_FENCE_RE.match(lines[idx]):
                body.append(lines[idx])
                idx += 1
            closing = lines[idx] if idx < len(lines) else "```"
            if idx < len(lines):
                idx += 1

            body_text = "\n".join(body).strip()
            if body_text and self._looks_like_unfenced_diff(body_text):
                opening = "```diff"

            output.append(opening)
            output.extend(body)
            output.append(closing)

        return "\n".join(output).strip()

    def _ensure_diff_fence(self, text: str) -> str:
        normalized = text.strip()
        if not normalized or "```" in normalized:
            return normalized
        if self._looks_like_unfenced_diff(normalized):
            return f"```diff\n{normalized}\n```"
        return normalized

    def _normalize_preview_content(self, text: str) -> str:
        normalized = self._convert_apply_patch_sections(text.strip())
        normalized = self._strip_accidental_outer_fence(normalized)
        normalized = self._retag_fenced_diff_blocks(normalized)
        normalized = self._fence_embedded_diff_blocks(normalized)
        return self._ensure_diff_fence(normalized)

    @staticmethod
    def _looks_like_shell_command_line(line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if stripped.startswith(("$ ", "# ", "> ")):
            return True

        command = stripped.split()[0]
        if command.endswith(":"):
            return False

        common_shell_commands = {
            "bash",
            "sh",
            "zsh",
            "python",
            "python3",
            "pip",
            "uv",
            "git",
            "npm",
            "pnpm",
            "yarn",
            "go",
            "cargo",
            "docker",
            "kubectl",
            "ls",
            "cat",
            "cp",
            "mv",
            "rm",
            "mkdir",
            "sed",
            "awk",
            "grep",
            "rg",
            "curl",
            "wget",
            "chmod",
            "chown",
        }
        if command in common_shell_commands:
            return True

        if re.fullmatch(r"(?:\./|\.\./|/)?[A-Za-z0-9._/-]+", command) and len(command) >= 2:
            if any(ch in stripped for ch in ("|", "&&", "||", ";", ">", "<")):
                return True
            if len(stripped.split()) >= 2:
                return True
        return False

    def _format_exec_section(self, content: str) -> str:
        normalized = self._normalize_preview_content(content)
        normalized = self._strip_leading_command_echo(normalized)
        if not normalized:
            return ""
        if "```" in normalized:
            return normalized

        lines = [line for line in normalized.splitlines() if line.strip()]
        if lines and self._looks_like_shell_command_line(lines[0]):
            return f"```bash\n{normalized}\n```"
        return f"```\n{normalized}\n```"

    def _strip_leading_command_echo(self, content: str) -> str:
        lines = content.splitlines()
        first_nonempty = next((idx for idx, line in enumerate(lines) if line.strip()), None)
        if first_nonempty is None:
            return ""

        tail = lines[first_nonempty:]
        nonempty_count = sum(1 for line in tail if line.strip())
        if nonempty_count < 2:
            return "\n".join(tail).strip()

        if self._looks_like_shell_command_line(tail[0]):
            stripped_tail = "\n".join(tail[1:]).strip()
            if stripped_tail:
                return stripped_tail
        return "\n".join(tail).strip()

    @staticmethod
    def _strip_thinking_echo_lines(content: str) -> str:
        lines = content.splitlines()
        kept = [line for line in lines if line.strip().lower() not in {"thinking", "thinking..."}]
        return "\n".join(kept).strip()

    @staticmethod
    def _patch_header_lines(old_path: str, new_path: str) -> list[str]:
        old_ref = "/dev/null" if old_path == "/dev/null" else f"a/{old_path}"
        new_ref = "/dev/null" if new_path == "/dev/null" else f"b/{new_path}"
        return [
            f"diff --git {old_ref} {new_ref}",
            f"--- {old_ref}",
            f"+++ {new_ref}",
        ]

    def _convert_apply_patch_block(self, lines: list[str]) -> list[str]:
        output: list[str] = ["```diff"]
        idx = 0
        has_diff_content = False

        while idx < len(lines):
            stripped = lines[idx].strip()

            old_path: Optional[str] = None
            new_path: Optional[str] = None
            if stripped.startswith(PATCH_UPDATE_PREFIX):
                old_path = stripped[len(PATCH_UPDATE_PREFIX) :].strip()
                new_path = old_path
                idx += 1
                if idx < len(lines):
                    move_line = lines[idx].strip()
                    if move_line.startswith(PATCH_MOVE_PREFIX):
                        new_path = move_line[len(PATCH_MOVE_PREFIX) :].strip() or old_path
                        idx += 1
            elif stripped.startswith(PATCH_ADD_PREFIX):
                new_path = stripped[len(PATCH_ADD_PREFIX) :].strip()
                old_path = "/dev/null"
                idx += 1
            elif stripped.startswith(PATCH_DELETE_PREFIX):
                old_path = stripped[len(PATCH_DELETE_PREFIX) :].strip()
                new_path = "/dev/null"
                idx += 1
            else:
                idx += 1
                continue

            if not old_path or not new_path:
                continue

            has_diff_content = True
            if len(output) > 1:
                output.append("")
            output.extend(self._patch_header_lines(old_path, new_path))

            while idx < len(lines):
                body_line = lines[idx]
                body_stripped = body_line.strip()
                if (
                    body_stripped.startswith(PATCH_UPDATE_PREFIX)
                    or body_stripped.startswith(PATCH_ADD_PREFIX)
                    or body_stripped.startswith(PATCH_DELETE_PREFIX)
                ):
                    break
                if body_stripped == PATCH_END_OF_FILE_MARKER:
                    idx += 1
                    continue
                if body_line.startswith(("@@", "+", "-", " ")):
                    output.append(body_line)
                idx += 1

        output.append("```")
        return output if has_diff_content else []

    def _convert_apply_patch_sections(self, text: str) -> str:
        if PATCH_BEGIN_MARKER not in text:
            return text

        lines = text.splitlines()
        output: list[str] = []
        idx = 0
        while idx < len(lines):
            stripped = lines[idx].strip()
            if stripped != PATCH_BEGIN_MARKER:
                output.append(lines[idx])
                idx += 1
                continue

            idx += 1
            patch_lines: list[str] = []
            while idx < len(lines) and lines[idx].strip() != PATCH_END_MARKER:
                patch_lines.append(lines[idx])
                idx += 1
            if idx < len(lines) and lines[idx].strip() == PATCH_END_MARKER:
                idx += 1

            converted = self._convert_apply_patch_block(patch_lines)
            if converted:
                output.extend(converted)
            else:
                output.append(PATCH_BEGIN_MARKER)
                output.extend(patch_lines)
                output.append(PATCH_END_MARKER)

        return "\n".join(output).strip()

    @staticmethod
    def _latest_section_from_sections(sections: list[TraceSection], markers: set[str]) -> Optional[TraceSection]:
        for section in reversed(sections):
            if section.marker in markers and section.content:
                return section
        return None

    def _sanitize_output_for_preview(self, cleaned: str, status: str) -> str:
        lines = cleaned.splitlines()
        sections = self._parse_trace_sections(lines)
        if status == "Running":
            latest_section = self._latest_section_from_sections(sections, {"assistant", "codex", "thinking", "exec"})
            if latest_section:
                marker = latest_section.marker
                content = latest_section.content
                if marker in {"assistant", "codex"}:
                    return self._normalize_preview_content(content)
                if marker == "thinking":
                    thinking_content = self._strip_thinking_echo_lines(content)
                    if thinking_content:
                        return f"thinking\n{thinking_content}"
                    return "thinking..."
                if marker == "exec":
                    return self._format_exec_section(content)
            return ""

        assistant_section = self._latest_section_from_sections(sections, {"assistant", "codex"})
        if assistant_section:
            return self._normalize_preview_content(assistant_section.content)
        exec_section = self._latest_section_from_sections(sections, {"exec"})
        if exec_section:
            return self._format_exec_section(exec_section.content)

        filtered: list[str] = []
        index = 0
        in_banner = False
        banner_rule_count = 0

        while index < len(lines):
            line = lines[index]
            stripped = line.strip()
            lowered = stripped.lower()

            if stripped.startswith("OpenAI Codex v"):
                in_banner = True
                banner_rule_count = 0
                index += 1
                continue

            if in_banner:
                if PREVIEW_DIVIDER_RE.match(stripped):
                    banner_rule_count += 1
                    if banner_rule_count >= 2:
                        in_banner = False
                index += 1
                continue

            if lowered.startswith("tokens used"):
                if status != "Running":
                    break
                index += 1
                continue

            marker = self._normalize_trace_marker(line)
            if marker in TRACE_SKIP_SECTION_MARKERS:
                index += 1
                while index < len(lines):
                    next_line = lines[index]
                    next_marker = self._normalize_trace_marker(next_line)
                    if next_marker is not None or next_line.strip().lower().startswith("tokens used"):
                        break
                    index += 1
                continue

            if self._is_preview_noise_line(line):
                index += 1
                continue

            filtered.append(line)
            index += 1

        sanitized = "\n".join(filtered).strip()
        if not sanitized:
            return ""
        return self._normalize_preview_content(sanitized)

    @staticmethod
    def _format_inline_markup(text: str) -> str:
        code_parts: list[str] = []
        link_parts: list[str] = []
        rendered = text

        def stash_code(match: re.Match[str]) -> str:
            token = f"__CODE_{len(code_parts)}__"
            code_parts.append(f"<code>{html.escape(match.group(1))}</code>")
            return token

        def stash_link(match: re.Match[str]) -> str:
            label = html.escape(match.group(1).strip())
            url = html.escape(match.group(2).strip(), quote=True)
            token = f"__LINK_{len(link_parts)}__"
            link_parts.append(f'<a href="{url}">{label}</a>')
            return token

        rendered = re.sub(r"`([^`\n]+)`", stash_code, rendered)
        rendered = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", stash_link, rendered)
        rendered = html.escape(rendered)
        rendered = re.sub(r"\*\*([^\n*]+)\*\*", r"<b>\1</b>", rendered)
        rendered = re.sub(r"__([^\n_]+)__", r"<u>\1</u>", rendered)
        rendered = re.sub(r"\*([^\n*]+)\*", r"<i>\1</i>", rendered)
        rendered = re.sub(r"~~([^\n~]+)~~", r"<s>\1</s>", rendered)
        rendered = re.sub(r"\|\|([^\n|]+)\|\|", r"<tg-spoiler>\1</tg-spoiler>", rendered)

        for index, snippet in enumerate(link_parts):
            rendered = rendered.replace(f"__LINK_{index}__", snippet)
        for index, snippet in enumerate(code_parts):
            rendered = rendered.replace(f"__CODE_{index}__", snippet)
        return rendered

    def _markdown_to_telegram_html(self, text: str) -> str:
        if not text:
            return "<i>暂无输出</i>"

        lines = text.splitlines()
        html_lines: list[str] = []
        in_code_block = False
        code_lines: list[str] = []
        code_language = ""

        for line in lines:
            if in_code_block:
                if MARKDOWN_FENCE_CLOSE_RE.match(line):
                    code_body = "\n".join(code_lines)
                    if code_language:
                        html_lines.append(self._code_block_with_language(code_body, code_language))
                    else:
                        html_lines.append(self._code_block(code_body))
                    code_lines = []
                    code_language = ""
                    in_code_block = False
                else:
                    code_lines.append(line)
                continue

            if MARKDOWN_FENCE_RE.match(line):
                opening = line.strip()
                fence_info = re.sub(r"^\s*`{3,}", "", opening).strip()
                code_language = fence_info.split()[0] if fence_info else ""
                in_code_block = True
                continue

            stripped = line.strip()
            if not stripped:
                html_lines.append("")
                continue

            if MARKDOWN_RULE_RE.match(line):
                html_lines.append("———")
                continue

            heading_match = MARKDOWN_HEADING_RE.match(line)
            if heading_match:
                html_lines.append(f"<b>{self._format_inline_markup(heading_match.group(2).strip())}</b>")
                continue

            bullet_match = MARKDOWN_BULLET_RE.match(line)
            if bullet_match:
                html_lines.append(f"• {self._format_inline_markup(bullet_match.group(1).strip())}")
                continue

            ordered_match = MARKDOWN_ORDERED_RE.match(line)
            if ordered_match:
                number, content = ordered_match.groups()
                html_lines.append(f"{number}. {self._format_inline_markup(content.strip())}")
                continue

            if stripped.startswith(">"):
                quote_content = stripped.lstrip("> ").strip()
                html_lines.append(f"<i>{self._format_inline_markup(quote_content)}</i>")
                continue

            html_lines.append(self._format_inline_markup(line))

        if code_lines:
            code_body = "\n".join(code_lines)
            if code_language:
                html_lines.append(self._code_block_with_language(code_body, code_language))
            else:
                html_lines.append(self._code_block(code_body))

        return "\n".join(html_lines).strip() or "<i>暂无输出</i>"

    def _render_preview_html(self, preview: str) -> str:
        return self._markdown_to_telegram_html(preview)

    def _build_preview(self, output: str, status: str) -> tuple[str, int, int, bool, int]:
        cleaned = self._clean_output(output)
        sanitized = self._sanitize_output_for_preview(cleaned, status) if cleaned else ""
        if not sanitized:
            waiting_text = "thinking..." if status == "Running" else "(无输出)"
            return waiting_text, 0, 0, False, 0

        lines = sanitized.splitlines()
        line_count = len(lines)
        char_count = sum(len(line) for line in lines) + max(0, line_count - 1)
        preview_lines = self._slice_preview_lines(lines, STREAM_PREVIEW_LINE_LIMIT)
        preview = self._format_preview_lines(preview_lines)
        clipped = line_count > STREAM_PREVIEW_LINE_LIMIT
        if len(preview) > STREAM_PREVIEW_LIMIT:
            preview = clip_for_telegram(preview, limit=STREAM_PREVIEW_LIMIT)
            clipped = True
        return preview, line_count, char_count, clipped, len(preview_lines)

    def _format_thinking_detail_html(self, detail: str, compact: bool = False) -> str:
        lines = [line.strip() for line in detail.splitlines() if line.strip()]
        if not lines:
            return ""

        max_lines = 1 if compact else THINKING_DETAIL_MAX_LINES
        max_chars = 90 if compact else THINKING_DETAIL_MAX_CHARS
        tail = lines[-max_lines:]
        clipped_tail = [clip_for_inline(line, limit=max_chars) for line in tail]

        rendered: list[str] = []
        if len(lines) > len(tail):
            rendered.append("<i>…</i>")
        rendered.extend(f"• {self._format_inline_markup(line)}" for line in clipped_tail)
        return "\n".join(rendered)

    @staticmethod
    def _format_elapsed_seconds(elapsed_seconds: float) -> str:
        total = max(0, int(elapsed_seconds))
        hours = total // 3600
        minutes = (total % 3600) // 60
        seconds = total % 60
        if hours:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    @staticmethod
    def _append_elapsed_footer(body_html: str, elapsed_text: str, compact: bool = False) -> str:
        footer = f"<i><code>{elapsed_text}</code></i>" if compact else f"<i>{elapsed_text}</i>"
        if not body_html.strip():
            return footer
        return f"{body_html}\n{footer}"

    def _format_stream_text(self, status: str, output: str, elapsed_seconds: float) -> str:
        preview, *_ = self._build_preview(output, status)
        preview_stripped = preview.strip()
        preview_lower = preview_stripped.lower()
        elapsed_text = self._format_elapsed_seconds(elapsed_seconds)

        if status == "Running" and (preview_lower == "thinking..." or preview_lower.startswith("thinking\n")):
            thinking_detail = ""
            if "\n" in preview_stripped:
                thinking_detail = preview_stripped.split("\n", 1)[1].strip()
            frame = THINKING_SPINNER_FRAMES[int(elapsed_seconds * 2) % len(THINKING_SPINNER_FRAMES)]
            dots = "." * (int(elapsed_seconds * 2) % 3 + 1)
            detail_html = self._format_thinking_detail_html(thinking_detail, compact=False)
            if detail_html:
                text = f"<i>{html.escape(frame)} thinking{dots}</i>\n{detail_html}"
            else:
                text = f"<i>{html.escape(frame)} thinking{dots}</i>"
            text = self._append_elapsed_footer(text, elapsed_text, compact=True)
            if len(text) <= TELEGRAM_MESSAGE_LIMIT:
                return text
            compact_detail_html = self._format_thinking_detail_html(thinking_detail, compact=True)
            if compact_detail_html:
                compact = f"<i>{html.escape(frame)} thinking{dots}</i>\n{compact_detail_html}"
                return self._append_elapsed_footer(compact, elapsed_text, compact=True)
            return self._append_elapsed_footer(f"<i>{html.escape(frame)} thinking{dots}</i>", elapsed_text, compact=True)

        render_preview = preview
        if self._looks_like_unfenced_diff(render_preview):
            render_preview = f"```diff\n{render_preview}\n```"
        preview_html = self._render_preview_html(render_preview)

        text = preview_html
        if status == "Running":
            text = self._append_elapsed_footer(preview_html, elapsed_text)

        if len(text) <= TELEGRAM_MESSAGE_LIMIT:
            return text

        # Safety fallback for Telegram max message length: reduce preview aggressively.
        hard_limit_preview = clip_for_telegram(preview, limit=900)
        hard_limit_render = hard_limit_preview
        if self._looks_like_unfenced_diff(hard_limit_render):
            hard_limit_render = f"```diff\n{hard_limit_render}\n```"
        hard_limit_html = self._render_preview_html(hard_limit_render)
        if status == "Running":
            return self._append_elapsed_footer(hard_limit_html, elapsed_text)
        return hard_limit_html

    @staticmethod
    def _diff_metrics(lines: list[str]) -> tuple[int, int, int, bool, str]:
        nonempty = 0
        first_nonempty = ""
        diff_header_hits = 0
        plus_count = 0
        minus_count = 0
        saw_hunk = False
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if not first_nonempty:
                first_nonempty = stripped
            nonempty += 1
            if stripped.startswith("diff --git "):
                diff_header_hits += 2
            elif stripped.startswith(
                (
                    "--- ",
                    "+++ ",
                    "@@",
                    "index ",
                    "new file mode ",
                    "deleted file mode ",
                    "rename from ",
                    "rename to ",
                    "similarity index ",
                    "old mode ",
                    "new mode ",
                )
            ):
                diff_header_hits += 1
                if stripped.startswith("@@"):
                    saw_hunk = True
            elif stripped.startswith("+") and not stripped.startswith("+++"):
                plus_count += 1
            elif stripped.startswith("-") and not stripped.startswith("---"):
                minus_count += 1
        return nonempty, diff_header_hits, plus_count + minus_count, saw_hunk, first_nonempty

    @staticmethod
    def _is_diff_candidate(lines: list[str]) -> bool:
        nonempty, diff_header_hits, diff_body_hits, saw_hunk, first_nonempty = Bridge._diff_metrics(lines)
        if nonempty == 0:
            return False

        if first_nonempty and not first_nonempty.startswith(
            (
                "diff --git ",
                "index ",
                "--- ",
                "+++ ",
                "@@",
                "new file mode ",
                "deleted file mode ",
                "rename from ",
                "rename to ",
            )
        ):
            if nonempty > 6:
                return False

        diff_lines = diff_header_hits + diff_body_hits
        density = diff_lines / nonempty
        if saw_hunk and diff_body_hits >= 2 and density >= 0.5:
            return True
        if diff_header_hits >= 3 and density >= 0.45 and (diff_body_hits >= 1 or saw_hunk):
            return True
        if diff_header_hits >= 2 and diff_body_hits >= 2 and density >= 0.5:
            return True
        if nonempty <= 10 and diff_header_hits >= 4 and density >= 0.4:
            return True
        return False

    @staticmethod
    def _candidate_diff_windows(lines: list[str]) -> list[list[str]]:
        windows: list[list[str]] = []
        if lines:
            windows.append(lines)
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith(
                (
                    "diff --git ",
                    "index ",
                    "--- ",
                    "+++ ",
                    "@@",
                    "new file mode ",
                    "deleted file mode ",
                    "rename from ",
                    "rename to ",
                )
            ):
                tail = lines[idx:]
                if len(tail) >= 3:
                    windows.append(tail)
        return windows

    @staticmethod
    def _looks_like_unfenced_diff(text: str) -> bool:
        if "```" in text:
            return False

        lines = [line.rstrip() for line in text.splitlines() if line.strip()]
        if not lines:
            return False

        for window in Bridge._candidate_diff_windows(lines):
            if Bridge._is_diff_candidate(window):
                return True
        return False

    @staticmethod
    def _split_plain_text_chunks(text: str, limit: int) -> list[str]:
        normalized = text.strip()
        if not normalized:
            return []
        if len(normalized) <= limit:
            return [normalized]

        chunks: list[str] = []
        remaining = normalized
        while remaining:
            if len(remaining) <= limit:
                chunks.append(remaining)
                break

            split_at = remaining.rfind("\n\n", 0, limit)
            if split_at < int(limit * 0.5):
                split_at = remaining.rfind("\n", 0, limit)
            if split_at < int(limit * 0.3):
                split_at = limit

            chunk = remaining[:split_at].strip()
            if not chunk:
                chunk = remaining[:limit]
                split_at = len(chunk)

            chunks.append(chunk)
            remaining = remaining[split_at:].lstrip("\n")

        return chunks

    @staticmethod
    def _split_fenced_block_chunks(block: str, limit: int) -> list[str]:
        lines = block.splitlines()
        if len(lines) < 2:
            return Bridge._split_plain_text_chunks(block, limit)

        opening = lines[0]
        has_closing = bool(lines and MARKDOWN_FENCE_CLOSE_RE.match(lines[-1].strip()))
        closing = lines[-1] if has_closing else "```"
        body_lines = lines[1:-1] if has_closing else lines[1:]

        scaffold_len = len(opening) + len(closing) + 2
        if scaffold_len >= limit:
            return [block[:limit]]

        body_limit = limit - scaffold_len
        parts: list[str] = []
        current: list[str] = []
        current_len = 0

        def flush_current() -> None:
            nonlocal current, current_len
            if not current:
                return
            parts.append(f"{opening}\n" + "\n".join(current) + f"\n{closing}")
            current = []
            current_len = 0

        for line in body_lines:
            if len(line) > body_limit and not current:
                remaining_line = line
                while len(remaining_line) > body_limit:
                    piece = remaining_line[:body_limit]
                    parts.append(f"{opening}\n{piece}\n{closing}")
                    remaining_line = remaining_line[body_limit:]
                if remaining_line:
                    current = [remaining_line]
                    current_len = len(remaining_line)
                continue

            add_len = len(line) + (1 if current else 0)
            if current and current_len + add_len > body_limit:
                flush_current()
            current.append(line)
            current_len += len(line) + (1 if len(current) > 1 else 0)

        flush_current()
        return parts if parts else [f"{opening}\n{closing}"]

    @staticmethod
    def _split_output_chunks(text: str, limit: int = FINAL_OUTPUT_CHUNK_LIMIT) -> list[str]:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            return []
        if len(normalized) <= limit:
            return [normalized]

        segments: list[str] = []
        lines = normalized.splitlines()
        idx = 0
        while idx < len(lines):
            if MARKDOWN_FENCE_RE.match(lines[idx].strip()):
                start = idx
                idx += 1
                while idx < len(lines) and not MARKDOWN_FENCE_CLOSE_RE.match(lines[idx].strip()):
                    idx += 1
                if idx < len(lines):
                    idx += 1
                segment = "\n".join(lines[start:idx]).strip()
                if segment:
                    segments.append(segment)
                continue

            start = idx
            while idx < len(lines) and not MARKDOWN_FENCE_RE.match(lines[idx].strip()):
                idx += 1
            segment = "\n".join(lines[start:idx]).strip()
            if segment:
                segments.append(segment)

        expanded: list[str] = []
        for segment in segments:
            if len(segment) <= limit:
                expanded.append(segment)
                continue
            if segment.startswith("```"):
                expanded.extend(Bridge._split_fenced_block_chunks(segment, limit))
            else:
                expanded.extend(Bridge._split_plain_text_chunks(segment, limit))

        chunks: list[str] = []
        current = ""
        for segment in expanded:
            if not current:
                if len(segment) <= limit:
                    current = segment
                else:
                    chunks.extend(Bridge._split_plain_text_chunks(segment, limit))
                continue

            candidate = f"{current}\n\n{segment}"
            if len(candidate) <= limit:
                current = candidate
                continue

            chunks.append(current)
            if len(segment) <= limit:
                current = segment
            else:
                split_parts = Bridge._split_plain_text_chunks(segment, limit)
                if split_parts:
                    chunks.extend(split_parts[:-1])
                    current = split_parts[-1]
                else:
                    current = ""

        if current:
            chunks.append(current)
        return chunks

    def _prune_page_sessions(self) -> None:
        now = time.time()
        stale_keys = [
            key
            for key, session in self.page_sessions.items()
            if now - session.last_access > PAGE_SESSION_TTL_SECONDS
        ]
        if not stale_keys:
            return
        for key in stale_keys:
            self.page_sessions.pop(key, None)
        self._save_page_sessions()

    @staticmethod
    def _page_callback_data(message_id: int, index: int) -> str:
        return f"page:{message_id}:{index}"

    def _build_page_keyboard(self, message_id: int, index: int, total: int) -> Optional[InlineKeyboardMarkup]:
        if total <= 1:
            return None
        buttons: list[InlineKeyboardButton] = []
        if index > 0:
            buttons.append(InlineKeyboardButton("‹ Prev", callback_data=self._page_callback_data(message_id, index - 1)))
        if index < total - 1:
            buttons.append(InlineKeyboardButton("Next ›", callback_data=self._page_callback_data(message_id, index + 1)))
        if not buttons:
            return None
        return InlineKeyboardMarkup([buttons])

    def _render_paginated_html(self, content: str, index: int, total: int) -> str:
        page_html = self._render_preview_html(content)
        # 去掉 Page X/Y 提示，但保留翻页按钮功能
        return page_html

    async def _send_final_output_messages(
        self,
        context: ContextTypes.DEFAULT_TYPE,
        chat_id: int,
        message_id: int,
        cleaned_output: str,
    ) -> None:
        preview_text = self._sanitize_output_for_preview(cleaned_output, "Done") if cleaned_output else ""
        if not preview_text:
            await self.safe_edit(
                context,
                chat_id,
                message_id,
                "<i>暂无输出</i>",
                disable_web_page_preview=False,
            )
            return

        chunks = self._split_output_chunks(preview_text, FINAL_OUTPUT_CHUNK_LIMIT)
        if not chunks:
            await self.safe_edit(
                context,
                chat_id,
                message_id,
                "<i>暂无输出</i>",
                disable_web_page_preview=False,
            )
            return

        self._prune_page_sessions()
        session_key = (chat_id, message_id)
        if len(chunks) > 1:
            now = time.time()
            self.page_sessions[session_key] = PageSession(
                chat_id=chat_id,
                message_id=message_id,
                pages=chunks,
                created_at=now,
                last_access=now,
                current_index=0,
            )
            self._save_page_sessions()
        else:
            if session_key in self.page_sessions:
                self.page_sessions.pop(session_key, None)
                self._save_page_sessions()
        first_html = self._render_paginated_html(chunks[0], 0, len(chunks))
        reply_markup = self._build_page_keyboard(message_id, 0, len(chunks))
        await self.safe_edit(
            context,
            chat_id,
            message_id,
            first_html,
            reply_markup=reply_markup,
            disable_web_page_preview=False,
        )

    def _output_file_name(self, chat_id: int, message_id: int) -> str:
        timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        return f"codex-output-{chat_id}-{message_id}-{timestamp}.txt"

    def _diagnostic_file_name(self, chat_id: int) -> str:
        timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        return f"task-diagnostic-{chat_id}-{timestamp}.log"

    def _should_upload_output_file(self, cleaned_output: str) -> bool:
        if not self.settings.enable_output_file:
            return False
        stripped = cleaned_output.strip()
        if not stripped:
            return False
        return len(stripped) > OUTPUT_FILE_MIN_CHARS

    def _write_output_file(self, chat_id: int, message_id: int, cleaned_output: str) -> Path:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.output_dir, 0o700)
        except OSError:
            pass

        file_name = self._output_file_name(chat_id, message_id)
        output_path = self.output_dir / file_name
        output_text = cleaned_output if cleaned_output else "(empty output)"
        output_path.write_text(output_text, encoding="utf-8")
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        return output_path

    def _write_failure_diagnostic(
        self,
        request: ExecutionRequest,
        prepared_prompt: str,
        cmd_args: list[str],
        workdir: Path,
        output: str,
        err: Exception,
    ) -> Path:
        self.diagnostics_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.diagnostics_dir, 0o700)
        except OSError:
            pass

        path = self.diagnostics_dir / self._diagnostic_file_name(request.chat_id)
        cleaned_output = self._clean_output(output)
        lines = [
            f"timestamp: {datetime.now().isoformat()}",
            f"source: {request.source}",
            f"chat_id: {request.chat_id}",
            f"thread_id: {request.thread_id}",
            f"role: {request.role or '(none)'}",
            f"session_mode: {request.session_mode}",
            f"memory_scope: {request.memory_scope or '(none)'}",
            f"workdir: {workdir}",
            f"command: {self._redacted_command_text(shlex.join(cmd_args))}",
            f"error: {err}",
            f"prepared_prompt_chars: {len(prepared_prompt)}",
            "",
            "--- prepared prompt ---",
            prepared_prompt,
            "",
            "--- captured output ---",
            cleaned_output or "(empty output)",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return path

    def _error_output_excerpt(self, output: str) -> str:
        cleaned = self._clean_output(output)
        if not cleaned:
            return ""
        lines = [line for line in cleaned.splitlines() if line.strip()]
        if not lines:
            return ""
        excerpt = "\n".join(lines[-12:])
        return clip_for_telegram(excerpt, limit=900)

    async def _upload_output_file(
        self,
        context: ContextTypes.DEFAULT_TYPE,
        chat_id: int,
        output_path: Path,
    ) -> None:
        with output_path.open("rb") as fh:
            await context.bot.send_document(
                chat_id=chat_id,
                document=InputFile(fh, filename=output_path.name),
                caption=f"完整输出文件: {output_path.name}",
            )

    def _is_duplicate_request(self, chat_id: int, message_id: int) -> bool:
        now = time.monotonic()
        stale_keys = [key for key, seen_at in self.recent_requests.items() if now - seen_at > REQUEST_DEDUP_SECONDS]
        for key in stale_keys:
            self.recent_requests.pop(key, None)
        dedup_key = (chat_id, message_id)
        if dedup_key in self.recent_requests:
            return True
        self.recent_requests[dedup_key] = now
        return False

    async def safe_edit(
        self,
        context: ContextTypes.DEFAULT_TYPE,
        chat_id: int,
        message_id: int,
        text: str,
        reply_markup: Optional[InlineKeyboardMarkup] = None,
        disable_web_page_preview: bool = True,
    ) -> None:
        try:
            await context.bot.edit_message_text(
                chat_id=chat_id,
                message_id=message_id,
                text=self._coerce_telegram_html(text),
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=disable_web_page_preview,
                reply_markup=reply_markup,
                read_timeout=30,
                write_timeout=30,
                connect_timeout=30,
                pool_timeout=5,
            )
        except BadRequest as err:
            if "Message is not modified" not in str(err):
                raise
        except TelegramError:
            # Telegram API network/transient errors should not fail the whole task.
            return

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        auth_status = "ON" if self._is_second_factor_enabled() else "OFF"
        commands_markup = "\n".join(start_help_lines())
        run_mode_line = "Send plain text directly to execute a task.\n\n" if self.settings.allow_plain_text else "\n"
        plain_text_mode_line = (
            " (all non-<code>/xxx</code> text will run as prompt)."
            if self.settings.allow_plain_text
            else " (use <code>/run</code> instead)."
        )
        await self.send_html(
            update,
            "<b>remote-control</b>\n"
            "Use <code>/run &lt;prompt&gt;</code> to execute a task.\n"
            + run_mode_line
            +
            "Send an image (optional caption) to run an image prompt.\n\n"
            "<b>Commands</b>\n"
            f"{commands_markup}"
            f"\nCommand override: <b>{'ON' if self.settings.allow_cmd_override else 'OFF'}</b> (admin user + admin chat)"
            f"\nSecond-factor auth: <b>{auth_status}</b>"
            "\nMemory: <b>skill-managed</b> via <code>changxian-memory-manager</code>"
            "\nRole: <b>skill-managed</b> via <code>changxian-role-manager</code>"
            "\nSchedule: <b>skill-managed</b> via <code>changxian-schedule</code>"
            f"\n\nPlain text mode: <b>{'ON' if self.settings.allow_plain_text else 'OFF'}</b>"
            + plain_text_mode_line,
        )

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        task = self.tasks.get(chat_id)
        mode = "enabled"
        output_file_mode = "enabled" if self.settings.enable_output_file else "disabled"
        resume_mode = "enabled" if self.settings.enable_session_resume else "disabled"
        memory_mode = "enabled" if self.settings.enable_memory else "disabled"
        scheduler_mode = "enabled" if self.settings.enable_scheduler else "disabled"
        memory_count = self.memory_store.count_memories(chat_id)
        enabled_jobs = self.scheduler_store.count_jobs(chat_id, enabled_only=True)
        role_name = self._active_role_name(chat_id)
        role_text = self._code_inline(role_name) if role_name else "<code>(none)</code>"
        session_id = self.chat_sessions.get(chat_id, "")
        session_text = self._code_inline(session_id) if session_id else "<code>(new)</code>"
        workdir_text = self._code_inline(str(self._effective_workdir(chat_id)))
        command_prefix = self._get_chat_command_prefix(chat_id)
        backend = self._command_backend(command_prefix)
        display_prefix = self._display_command_prefix(chat_id, command_prefix)
        if self._is_second_factor_enabled():
            auth_left = self._auth_seconds_left(update)
            auth_state = f"authenticated ({auth_left}s left)" if auth_left > 0 else "locked"
        else:
            auth_state = "disabled"
        plain_text_mode = "enabled" if self.settings.allow_plain_text else "disabled"
        if backend == "opencode":
            resume_text = "<b>unsupported on OpenCode</b>"
            session_line = f"Saved Codex session: {session_text}"
        else:
            resume_text = f"<b>{resume_mode}</b>"
            session_line = f"Session: {session_text}"
        if task and not task.done():
            await self.send_html(
                update,
                "<b>Task Status</b>\n"
                "State: <b>Running</b>\n"
                f"Backend: <b>{backend.upper()}</b>\n"
                f"Command:\n{self._code_block(display_prefix)}\n"
                f"Workdir: {workdir_text}\n"
                f"Plain text mode: <b>{plain_text_mode}</b>\n"
                f"Output file upload: <b>{output_file_mode}</b>\n"
                f"Session resume: {resume_text}\n"
                f"Second-factor: <b>{auth_state}</b>\n"
                + session_line,
            )
        else:
            await self.send_html(
                update,
                "<b>Task Status</b>\n"
                "State: <b>Idle</b>\n"
                f"Backend: <b>{backend.upper()}</b>\n"
                f"Command:\n{self._code_block(display_prefix)}\n"
                f"Workdir: {workdir_text}\n"
                f"Plain text mode: <b>{plain_text_mode}</b>\n"
                f"Output file upload: <b>{output_file_mode}</b>\n"
                f"Session resume: {resume_text}\n"
                f"Second-factor: <b>{auth_state}</b>\n"
                + session_line,
            )

    async def paginate(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if query is None or query.message is None:
            return
        if not self._is_update_authorized(update):
            await query.answer("Access denied", show_alert=False)
            return

        data = query.data or ""
        match = re.fullmatch(r"page:(\d+):(\d+)", data)
        if not match:
            await query.answer()
            return

        message_id = int(match.group(1))
        index = int(match.group(2))
        chat_id = query.message.chat.id
        actual_message_id = query.message.message_id
        if actual_message_id != message_id:
            message_id = actual_message_id

        self._prune_page_sessions()
        session = self.page_sessions.get((chat_id, message_id))
        if session is None:
            await query.answer("Expired", show_alert=False)
            try:
                await context.bot.edit_message_reply_markup(
                    chat_id=chat_id,
                    message_id=actual_message_id,
                    reply_markup=None,
                )
            except BadRequest:
                pass
            return

        if index < 0 or index >= len(session.pages):
            await query.answer()
            return

        session.current_index = index
        session.last_access = time.time()
        self._save_page_sessions()
        page_html = self._render_paginated_html(session.pages[index], index, len(session.pages))
        reply_markup = self._build_page_keyboard(message_id, index, len(session.pages))
        await self.safe_edit(
            context,
            chat_id,
            message_id,
            page_html,
            reply_markup=reply_markup,
            disable_web_page_preview=False,
        )
        await query.answer()

    async def chat_id(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        user_id = update.effective_user.id if update.effective_user else None
        user_line = self._code_inline(str(user_id)) if user_id is not None else "<code>(unknown)</code>"
        await self.send_html(
            update,
            "<b>IDs</b>\n"
            f"Chat: {self._code_inline(str(update.effective_chat.id))}\n"
            f"User: {user_line}",
        )

    async def auth(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not self._is_second_factor_enabled():
            await self.send_html(
                update,
                "<b>/auth disabled</b>\nSet <code>TG_AUTH_PASSPHRASE</code> to enable second-factor auth.",
            )
            return

        key = self._auth_key(update)
        if key is None:
            await self.send_html(update, "<b>Auth failed</b>\nCannot resolve user identity.")
            return

        raw = " ".join(context.args).strip()
        if not raw:
            seconds_left = self._auth_seconds_left(update)
            if seconds_left > 0:
                await self.send_html(
                    update,
                    "<b>Already authenticated</b>\n"
                    f"Remaining: <code>{seconds_left}s</code>.",
                )
            else:
                await self.send_html(
                    update,
                    "<b>Usage</b>\n<code>/auth &lt;passphrase&gt;</code>\n"
                    f"Session TTL: <code>{self.settings.auth_ttl_seconds}s</code>.",
                )
            return

        if raw.lower() in {"logout", "revoke"}:
            self.auth_sessions.pop(key, None)
            await self.send_html(update, "<b>Authentication cleared</b>")
            return

        if hmac.compare_digest(raw, self.settings.auth_passphrase):
            self.auth_sessions[key] = time.monotonic() + self.settings.auth_ttl_seconds
            await self.send_html(
                update,
                "<b>Authentication successful</b>\n"
                f"Valid for <code>{self.settings.auth_ttl_seconds}s</code>.",
            )
            return

        await self.send_html(update, "<b>Authentication failed</b>")

    async def cancel(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        task = self.tasks.get(chat_id)
        if task and not task.done():
            task.cancel()
            await self.send_html(update, "<b>Cancellation requested</b>\nCurrent task is stopping.")
        else:
            await self.send_html(update, "<b>No running task</b>")

    async def new_session(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return
        task = self.tasks.get(chat_id)
        if task and not task.done():
            await self.send_html(update, "<b>Task is running</b>\nUse <code>/cancel</code> first, then run <code>/new</code>.")
            return

        existed = self._clear_chat_session(chat_id)
        backend = self._command_backend(self._get_chat_command_prefix(chat_id))
        if backend == "opencode":
            if existed:
                await self.send_html(
                    update,
                    "<b>OpenCode is stateless</b>\nCleared the saved Codex session for this chat.",
                )
            else:
                await self.send_html(
                    update,
                    "<b>OpenCode is stateless</b>\nNo saved Codex session was stored for this chat.",
                )
            return
        if existed:
            await self.send_html(
                update,
                "<b>Session reset</b>\nNext prompt will start a fresh Codex session.",
            )
            return
        await self.send_html(
            update,
            "<b>Already fresh</b>\nNo previous session found. Next prompt will start a fresh Codex session.",
        )

    async def cwd(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return

        raw = " ".join(context.args).strip()
        if not raw:
            current = self._effective_workdir(chat_id)
            await self.send_html(
                update,
                "<b>Working directory</b>\n"
                f"Current: {self._code_inline(str(current))}\n\n"
                "<b>Usage</b>\n"
                "<code>/cwd &lt;path&gt;</code>\n"
                "<code>/cwd reset</code>",
            )
            return

        if raw.lower() == "reset":
            existed = self._clear_chat_workdir(chat_id)
            current = self._effective_workdir(chat_id)
            if existed:
                await self.send_html(
                    update,
                    "<b>Working directory reset</b>\n"
                    f"Current: {self._code_inline(str(current))}",
                )
            else:
                await self.send_html(
                    update,
                    "<b>Already default</b>\n"
                    f"Current: {self._code_inline(str(current))}",
                )
            return

        try:
            target = self._resolve_target_workdir(chat_id, raw)
        except ValueError as err:
            await self.send_html(update, f"<b>Invalid directory</b>\n{self._code_inline(str(err))}")
            return

        self._set_chat_workdir(chat_id, target)
        await self.send_html(
            update,
            "<b>Working directory updated</b>\n"
            f"Current: {self._code_inline(str(target))}",
        )

    async def skill(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return

        raw_query = " ".join(context.args).strip()
        skills_root, installed = self._discover_installed_skills()

        if not installed:
            await self.send_html(
                update,
                "<b>Codex Skills</b>\n"
                "No installed skills found.\n"
                f"Path: {self._code_inline(str(skills_root))}",
            )
            return

        if not raw_query:
            custom_skills = [item for item in installed if not item.is_system]
            system_skills = [item for item in installed if item.is_system]
            lines = [
                "<b>Codex Skills</b>",
                f"Root: {self._code_inline(str(skills_root))}",
                (
                    f"Installed: <b>{len(installed)}</b> "
                    f"(custom: <b>{len(custom_skills)}</b>, system: <b>{len(system_skills)}</b>)"
                ),
                "",
            ]
            if custom_skills:
                lines.append("<b>Custom Skills</b>")
                lines.extend(self._format_skill_name_lines(custom_skills))
                lines.append("")
            if system_skills:
                lines.append("<b>System Skills</b>")
                lines.extend(self._format_skill_name_lines(system_skills, start_index=len(custom_skills) + 1))
                lines.append("")
            lines.append("Tip: use <code>/skill &lt;name&gt;</code> for details.")
            await self.send_html(update, "\n".join(lines).strip())
            return

        query = raw_query.lower()
        exact_matches = [item for item in installed if item.name.lower() == query]
        matches = exact_matches or [item for item in installed if query in item.name.lower()]
        if not matches:
            matches = [item for item in installed if query in item.description.lower()]

        if not matches:
            await self.send_html(
                update,
                "<b>Skill not found</b>\n"
                f"Query: {self._code_inline(raw_query)}\n"
                "Use <code>/skill</code> to view all installed skills.",
            )
            return

        if len(matches) == 1:
            skill = matches[0]
            description = html.escape(self._truncate_text(skill.description, limit=600))
            await self.send_html(
                update,
                "<b>Skill Details</b>\n"
                f"Name: {self._code_inline(skill.name)}\n"
                f"Category: <b>{'system' if skill.is_system else 'custom'}</b>\n"
                f"Path: {self._code_inline(str(skill.skill_md))}\n"
                f"Description: {description}",
            )
            return

        lines = [
            "<b>Skill Matches</b>",
            f"Query: {self._code_inline(raw_query)}",
            f"Matched: <b>{len(matches)}</b>",
            "",
        ]
        max_matches = 25
        shown_matches = matches[:max_matches]
        for idx, skill in enumerate(shown_matches, start=1):
            short_desc = html.escape(self._truncate_text(skill.description, limit=88))
            lines.append(f"{idx}. <code>{html.escape(skill.name)}</code> - {short_desc}")
        if len(matches) > max_matches:
            lines.append(f"... and <b>{len(matches) - max_matches}</b> more matches.")
        lines.append("")
        lines.append("Try a full name: <code>/skill &lt;exact-name&gt;</code>")
        await self.send_html(update, "\n".join(lines).strip())

    async def run(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_message is None:
            return
        await self._run_prompt(update, context, " ".join(context.args).strip())

    async def run_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_message is None:
            return
        if not self.settings.allow_plain_text:
            await self.send_html(
                update,
                "<b>Plain text mode disabled</b>\nUse <code>/run &lt;prompt&gt;</code> instead.",
            )
            return
        prompt = (update.effective_message.text or "").strip()
        if not prompt:
            return
        await self._run_prompt(update, context, prompt)

    @staticmethod
    def _normalize_suffix(suffix: str) -> str:
        normalized = suffix.lower().strip()
        if re.fullmatch(r"\.[a-z0-9]{1,8}", normalized):
            return normalized
        return ".jpg"

    @staticmethod
    def _build_image_prompt(image_path: Path, caption: str) -> str:
        request = caption if caption else "Please analyze this image."
        return (
            "Use the local image file below as input context.\n"
            f"Image path: {image_path.resolve()}\n\n"
            f"User request:\n{request}"
        )

    async def run_image(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None or update.effective_message is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return

        message = update.effective_message
        file_id: Optional[str] = None
        suffix = ".jpg"

        if message.photo:
            file_id = message.photo[-1].file_id
            file_size = message.photo[-1].file_size or 0
        elif message.document and (message.document.mime_type or "").startswith("image/"):
            file_id = message.document.file_id
            file_size = message.document.file_size or 0
            if message.document.file_name:
                suffix = self._normalize_suffix(Path(message.document.file_name).suffix)
            else:
                guessed = mimetypes.guess_extension(message.document.mime_type or "")
                if guessed:
                    suffix = self._normalize_suffix(guessed)
        else:
            file_size = 0

        if not file_id:
            return
        if file_size > self.settings.max_image_bytes:
            await self.send_html(
                update,
                "<b>Image rejected</b>\n"
                f"File too large: {self._code_inline(str(file_size))} bytes "
                f"(limit: {self._code_inline(str(self.settings.max_image_bytes))})",
            )
            return

        try:
            tg_file = await context.bot.get_file(file_id)
            if suffix == ".jpg" and tg_file.file_path:
                suffix = self._normalize_suffix(Path(tg_file.file_path).suffix)
            self.media_dir.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(self.media_dir, 0o700)
            except OSError:
                pass
            image_path = self.media_dir / f"tg-{chat_id}-{message.message_id}-{uuid.uuid4().hex[:8]}{suffix}"
            await tg_file.download_to_drive(custom_path=str(image_path))
            try:
                os.chmod(image_path, 0o600)
            except OSError:
                pass
        except Exception as err:
            await self.send_html(update, f"<b>Image download failed</b>\nReason: {self._code_inline(str(err))}")
            return

        caption = (message.caption or "").strip()
        prompt = self._build_image_prompt(image_path, caption)
        await self._run_prompt(update, context, prompt, cleanup_paths=[image_path])

    async def cmd(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None or update.effective_message is None:
            return
        if not self._is_update_authorized(update, require_admin=True):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return

        low_prefix = "codex -a never --search exec -s workspace-write --skip-git-repo-check"
        readonly_prefix = "codex -a never --search exec -s read-only --skip-git-repo-check"
        high_prefix = "codex -a never --search exec -s danger-full-access --skip-git-repo-check"
        chat_id = update.effective_chat.id
        preset_aliases = {
            "low": ("LOW", low_prefix),
            "readonly": ("READONLY", readonly_prefix),
            "ro": ("READONLY", readonly_prefix),
            "high": ("HIGH", high_prefix),
        }

        raw = " ".join(context.args).strip()
        if not raw:
            display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
            await self.send_html(
                update,
                "<b>Current command prefix for this chat</b>\n"
                f"{self._code_block(display_prefix)}\n"
                "<b>Permission profiles</b>\n"
                f"LOW (recommended): {self._code_inline(low_prefix)}\n"
                f"READONLY (audit/review): {self._code_inline(readonly_prefix)}\n"
                f"HIGH (danger-full-access): {self._code_inline(high_prefix)}\n\n"
                "<b>OpenCode backend</b>\n"
                f"{self._code_inline(OPENCODE_COMMAND_PREFIX)}\n\n"
                "<b>Usage</b>\n"
                "<code>/cmd &lt;command prefix&gt;</code>\n"
                "<code>/cmd low</code> / <code>/cmd readonly</code> / <code>/cmd high</code>\n"
                "<code>/cmd reset</code>\n"
                "<code>/cmd opencode run --dir &lt;PROJECT_PATH&gt; -m opencode/minimax-m2.5-free</code>\n\n"
                f"Override enabled: <b>{'yes' if self.settings.allow_cmd_override else 'no'}</b>",
            )
            return
        if not self.settings.allow_cmd_override:
            await self.send_html(update, "<b>Command override disabled</b>\nSet <code>TG_ALLOW_CMD_OVERRIDE=1</code> to enable.")
            return

        if raw.lower() == "reset":
            self._clear_chat_command_prefix(chat_id)
            display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
            await self.send_html(
                update,
                "<b>Command prefix reset for this chat</b>\n"
                f"{self._code_block(display_prefix)}",
            )
            return

        preset = preset_aliases.get(raw.lower())
        if preset is not None:
            level, preset_prefix = preset
            self._set_chat_command_prefix(chat_id, preset_prefix)
            display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
            await self.send_html(
                update,
                f"<b>Command prefix switched to {level} for this chat</b>\n"
                f"{self._code_block(display_prefix)}",
            )
            return

        try:
            _validate_command_prefix(raw)
        except ValueError as err:
            await self.send_html(update, f"<b>Invalid command prefix</b>\n{self._code_inline(str(err))}")
            return
        self._set_chat_command_prefix(chat_id, raw)
        display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
        await self.send_html(
            update,
            "<b>Command prefix updated for this chat</b>\n"
            f"{self._code_block(display_prefix)}",
        )

    async def setting(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None or update.effective_message is None:
            return
        if not self._is_update_authorized(update, require_admin=True):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return

        raw = " ".join(context.args).strip()
        if not raw:
            output_mode = "enabled" if self.settings.enable_output_file else "disabled"
            resume_mode = "enabled" if self.settings.enable_session_resume else "disabled"
            memory_mode = "enabled" if self.settings.enable_memory else "disabled"
            scheduler_mode = "enabled" if self.settings.enable_scheduler else "disabled"
            await self.send_html(
                update,
                "<b>Runtime settings</b>\n"
                f"TG_ENABLE_OUTPUT_FILE: <b>{output_mode}</b>\n"
                f"TG_AUTH_TTL_SECONDS: <code>{self.settings.auth_ttl_seconds}s</code>\n"
                f"TG_ENABLE_SESSION_RESUME: <b>{resume_mode}</b>\n"
                f"TG_ALLOW_PLAIN_TEXT: <b>{'enabled' if self.settings.allow_plain_text else 'disabled'}</b>\n"
                f"TG_ENABLE_MEMORY: <b>{memory_mode}</b>\n"
                f"TG_ENABLE_SCHEDULER: <b>{scheduler_mode}</b>\n"
                f"Env file: {self._code_inline(str(self.env_path))}\n\n"
                "<b>Usage</b>\n"
                "<code>/setting output_file on|off</code>\n"
                "<code>/setting auth_ttl 7d</code>\n"
                "<code>/setting session_resume on|off</code>\n"
                "<code>/setting plain_text on|off</code>\n"
                "<code>/setting memory on|off</code>\n"
                "<code>/setting scheduler on|off</code>",
            )
            return

        if len(context.args) < 2:
            await self.send_html(
                update,
                "<b>Usage</b>\n"
                "<code>/setting output_file on|off</code>\n"
                "<code>/setting auth_ttl 7d</code>\n"
                "<code>/setting session_resume on|off</code>\n"
                "<code>/setting plain_text on|off</code>\n"
                "<code>/setting memory on|off</code>\n"
                "<code>/setting scheduler on|off</code>",
            )
            return

        key_raw = context.args[0].strip().lower()
        value_raw = " ".join(context.args[1:]).strip()
        key_aliases = {
            "output": "TG_ENABLE_OUTPUT_FILE",
            "output_file": "TG_ENABLE_OUTPUT_FILE",
            "codex_output_file": "TG_ENABLE_OUTPUT_FILE",
            "tg_enable_output_file": "TG_ENABLE_OUTPUT_FILE",
            "auth_ttl": "TG_AUTH_TTL_SECONDS",
            "auth_ttl_seconds": "TG_AUTH_TTL_SECONDS",
            "tg_auth_ttl_seconds": "TG_AUTH_TTL_SECONDS",
            "session_resume": "TG_ENABLE_SESSION_RESUME",
            "tg_enable_session_resume": "TG_ENABLE_SESSION_RESUME",
            "plain_text": "TG_ALLOW_PLAIN_TEXT",
            "tg_allow_plain_text": "TG_ALLOW_PLAIN_TEXT",
            "memory": "TG_ENABLE_MEMORY",
            "tg_enable_memory": "TG_ENABLE_MEMORY",
            "scheduler": "TG_ENABLE_SCHEDULER",
            "tg_enable_scheduler": "TG_ENABLE_SCHEDULER",
        }
        env_key = key_aliases.get(key_raw)
        if env_key is None:
            await self.send_html(
                update,
                "<b>Unknown setting key</b>\n"
                f"Received: {self._code_inline(key_raw)}\n"
                "Supported keys: <code>output_file</code>, <code>auth_ttl</code>, <code>session_resume</code>, <code>plain_text</code>, <code>memory</code>, <code>scheduler</code>.",
            )
            return

        updates: Dict[str, str] = {}
        if env_key == "TG_AUTH_TTL_SECONDS":
            parsed = self._parse_auth_ttl_setting(value_raw)
            if parsed is None:
                await self.send_html(
                    update,
                    "<b>Invalid auth_ttl</b>\n"
                    "Use a positive duration like <code>3600</code>, <code>60s</code>, <code>30m</code>, <code>2h</code>, <code>7d</code>.",
                )
                return
            seconds, env_value = parsed
            self.settings.auth_ttl_seconds = seconds
            updates[env_key] = env_value
            applied_value = f"{seconds}s ({env_value})"
        else:
            toggle = self._parse_toggle_value(value_raw)
            if toggle is None:
                await self.send_html(
                    update,
                    "<b>Invalid toggle value</b>\n"
                    "Use one of: <code>on/off</code>, <code>1/0</code>, <code>true/false</code>.",
                )
                return
            updates[env_key] = "1" if toggle else "0"
            if env_key == "TG_ENABLE_OUTPUT_FILE":
                self.settings.enable_output_file = toggle
            elif env_key == "TG_ENABLE_SESSION_RESUME":
                self.settings.enable_session_resume = toggle
            elif env_key == "TG_ALLOW_PLAIN_TEXT":
                self.settings.allow_plain_text = toggle
            elif env_key == "TG_ENABLE_MEMORY":
                self.settings.enable_memory = toggle
            elif env_key == "TG_ENABLE_SCHEDULER":
                self.settings.enable_scheduler = toggle
            applied_value = "enabled" if toggle else "disabled"

        try:
            self._upsert_env_settings(updates)
        except OSError as err:
            await self.send_html(update, f"<b>Setting update failed</b>\nReason: {self._code_inline(str(err))}")
            return

        await self.send_html(
            update,
            "<b>Setting updated</b>\n"
            f"{self._code_inline(env_key)} = <code>{html.escape(updates[env_key])}</code>\n"
            f"Applied: <b>{html.escape(applied_value)}</b>",
        )

    async def backend(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Switch between Codex and OpenCode backend"""
        if update.effective_chat is None or update.effective_message is None:
            return
        if not self._is_update_authorized(update, require_admin=True):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return

        raw = " ".join(context.args).strip().lower() if context.args else ""
        chat_id = update.effective_chat.id
        current_prefix = self._get_chat_command_prefix(chat_id)
        current_backend = self._command_backend(current_prefix)
        
        if not raw or raw == "status":
            await self.send_html(
                update,
                "<b>Current backend</b>\n"
                f"{current_backend.upper()}\n\n"
                "<b>Usage</b>\n"
                "<code>/backend codex</code> - switch to Codex backend\n"
                "<code>/backend opencode</code> - switch to OpenCode backend\n"
                "<code>/backend status</code> - show current backend\n\n"
                "<b>Note</b>: OpenCode runs with <code>run --dir &lt;PROJECT_PATH&gt; -m opencode/minimax-m2.5-free</code> and resolves the current workdir at execution time.",
            )
            return

        if not self.settings.allow_cmd_override:
            await self.send_html(update, "<b>Backend switch disabled</b>\nSet <code>TG_ALLOW_CMD_OVERRIDE=1</code> to enable.")
            return

        if raw == "codex":
            codex_prefix = self.default_command_prefix
            if self._command_backend(codex_prefix) != "codex":
                codex_prefix = DEFAULT_CODEX_COMMAND_PREFIX
            self._set_chat_command_prefix(chat_id, codex_prefix)
            display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
            await self.send_html(
                update,
                "<b>Backend switched to Codex for this chat</b>\n"
                f"{self._code_block(display_prefix)}",
            )
            return

        if raw == "opencode":
            current_workdir = self._effective_workdir(chat_id)
            self._set_chat_command_prefix(chat_id, OPENCODE_COMMAND_PREFIX)
            display_prefix = self._display_command_prefix(chat_id, self._get_chat_command_prefix(chat_id))
            await self.send_html(
                update,
                f"<b>Backend switched to OpenCode for this chat</b>\n"
                f"Project path: {self._code_inline(str(current_workdir))}\n\n"
                f"{self._code_block(display_prefix)}",
            )
            return

        await self.send_html(
            update,
            "<b>Unknown backend</b>\n"
            "Available: <code>codex</code>, <code>opencode</code>\n\n"
            "<code>/backend codex</code> - switch to Codex backend\n"
            "<code>/backend opencode</code> - switch to OpenCode backend",
        )


    async def memory(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_chat is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return

        raw = " ".join(context.args).strip()
        default_scope = self._default_memory_scope(chat_id)
        if not raw:
            count = self.memory_store.count_memories(chat_id)
            await self.send_html(
                update,
                "<b>Memory</b>\n"
                f"Stored: <b>{count}</b>\n"
                f"Default scope: {self._code_inline(default_scope)}\n\n"
                "<b>Usage</b>\n"
                "<code>/memory list [query]</code>\n"
                "<code>/memory list &lt;scope&gt; | &lt;query&gt;</code>\n"
                "<code>/memory add &lt;content&gt;</code>\n"
                "<code>/memory add &lt;scope&gt; | &lt;content&gt;</code>\n"
                "<code>/memory pin &lt;id&gt;</code>\n"
                "<code>/memory forget &lt;id&gt;</code>\n"
                "<code>/memory clear [&lt;scope&gt;]</code>",
            )
            return

        sub = context.args[0].strip().lower()
        rest = " ".join(context.args[1:]).strip()

        if sub in {"list", "ls"}:
            scope = None
            query = rest
            if "|" in rest:
                scope_raw, query_raw = rest.split("|", 1)
                scope = scope_raw.strip() or None
                query = query_raw.strip()
            records = self.memory_store.list_memories(chat_id, scope=scope, query=query, limit=10)
            if not records:
                await self.send_html(update, "<b>No memories found</b>")
                return
            lines = ["<b>Memory Results</b>"]
            if scope:
                lines.append(f"Scope: {self._code_inline(scope)}")
            if query:
                lines.append(f"Query: {self._code_inline(query)}")
            lines.append("")
            for index, record in enumerate(records, start=1):
                pin_text = " <b>[pinned]</b>" if record.pinned else ""
                title = f"{html.escape(record.title)} - " if record.title else ""
                snippet = html.escape(self._truncate_text(record.content, limit=120))
                lines.append(
                    f"{index}. {self._code_inline(record.id)} {self._code_inline(record.scope)}{pin_text}\n"
                    f"{title}{snippet}"
                )
            await self.send_html(update, "\n\n".join(lines).strip())
            return

        if sub == "add":
            if not await self._ensure_second_factor(update):
                return
            scope = default_scope
            content = rest
            if "|" in rest:
                scope_raw, content_raw = rest.split("|", 1)
                scope = scope_raw.strip() or default_scope
                content = content_raw.strip()
            if not content:
                await self.send_html(
                    update,
                    "<b>Usage</b>\n"
                    "<code>/memory add &lt;content&gt;</code>\n"
                    "<code>/memory add &lt;scope&gt; | &lt;content&gt;</code>",
                )
                return
            record = self.memory_store.add_memory(
                chat_id=chat_id,
                scope=scope,
                kind="note",
                title=self._truncate_text(content.splitlines()[0].strip(), limit=72),
                content=content,
                tags=["manual"],
                source_type="telegram",
                source_ref=str(update.effective_message.message_id) if update.effective_message else "",
            )
            await self.send_html(
                update,
                "<b>Memory saved</b>\n"
                f"ID: {self._code_inline(record.id)}\n"
                f"Scope: {self._code_inline(record.scope)}",
            )
            return

        if sub in {"pin", "unpin"}:
            if not await self._ensure_second_factor(update):
                return
            if not rest:
                await self.send_html(update, "<b>Usage</b>\n<code>/memory pin &lt;id&gt;</code>")
                return
            changed = self.memory_store.set_pinned(chat_id, rest, pinned=(sub == "pin"))
            if not changed:
                await self.send_html(update, "<b>Memory not found</b>")
                return
            await self.send_html(update, f"<b>Memory {'pinned' if sub == 'pin' else 'unpinned'}</b>\nID: {self._code_inline(rest)}")
            return

        if sub in {"forget", "delete", "rm"}:
            if not await self._ensure_second_factor(update):
                return
            if not rest:
                await self.send_html(update, "<b>Usage</b>\n<code>/memory forget &lt;id&gt;</code>")
                return
            deleted = self.memory_store.delete_memory(chat_id, rest)
            if not deleted:
                await self.send_html(update, "<b>Memory not found</b>")
                return
            await self.send_html(update, f"<b>Memory removed</b>\nID: {self._code_inline(rest)}")
            return

        if sub == "clear":
            if not await self._ensure_second_factor(update):
                return
            scope = rest or default_scope
            deleted_count = self.memory_store.clear_scope(chat_id, scope)
            await self.send_html(
                update,
                "<b>Memory scope cleared</b>\n"
                f"Scope: {self._code_inline(scope)}\n"
                f"Deleted: <b>{deleted_count}</b>",
            )
            return

        await self.send_html(update, "<b>Unknown memory command</b>\nUse <code>/memory</code> for usage.")

    async def _run_prompt(
        self,
        update: Update,
        context: ContextTypes.DEFAULT_TYPE,
        prompt: str,
        cleanup_paths: Optional[list[Path]] = None,
    ) -> None:
        if update.effective_chat is None or update.effective_message is None:
            return
        chat_id = update.effective_chat.id
        if not self._is_update_authorized(update):
            await self.send_html(update, "<b>Access denied</b>")
            return
        if not await self._ensure_second_factor(update):
            return

        if not prompt:
            await self.send_html(update, "Usage: send plain text directly (non-<code>/xxx</code>).")
            return

        if self._is_duplicate_request(chat_id, update.effective_message.message_id):
            return

        if chat_id in self.tasks and not self.tasks[chat_id].done():
            await self.send_html(update, "<b>A task is already running</b>\nUse <code>/cancel</code> first.")
            return

        running_total = sum(1 for task in self.tasks.values() if not task.done())
        if running_total >= self.settings.max_concurrent_tasks:
            await self.send_html(
                update,
                "<b>System busy</b>\n"
                f"Too many running tasks (<code>{self.settings.max_concurrent_tasks}</code>). Try again later.",
            )
            return

        draft_enabled = update.effective_chat.type == "private"
        status_message_id: Optional[int] = None
        if not draft_enabled:
            msg = await update.effective_message.reply_text(
                text="<i>Running...</i>",
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=True,
            )
            status_message_id = msg.message_id

        request = ExecutionRequest(
            chat_id=chat_id,
            prompt=prompt,
            source="telegram",
            thread_id=update.effective_message.message_thread_id,
            draft_enabled=draft_enabled,
            draft_id=update.effective_message.message_id,
            status_message_id=status_message_id,
            cleanup_paths=list(cleanup_paths or []),
            workdir=self._effective_workdir(chat_id),
            command_prefix=self._get_chat_command_prefix(chat_id),
            session_mode="chat",
            memory_scope=self._default_memory_scope(chat_id),
            role=self._active_role_name(chat_id),
            owner_user_id=update.effective_user.id if update.effective_user else None,
        )
        task = context.application.create_task(self._execute_request_worker(context, request))
        self.tasks[chat_id] = task
        task.add_done_callback(lambda _task, chat_id=chat_id: self.tasks.pop(chat_id, None))

    async def _execute_request_worker(self, context, request: ExecutionRequest) -> ExecutionResult:
        chat_id = request.chat_id
        thread_id = request.thread_id
        status_message_id = request.status_message_id
        cleanup_targets = list(request.cleanup_paths or [])
        prepared_prompt, _used_memories = self._build_prompt_with_memory(request)
        cmd_args, _session_id, workdir = self._resolve_codex_command_for_request(request, prepared_prompt)
        output_path_str = ""

        async def _ensure_status_message_id(initial_text: str = "<i>Running...</i>") -> int:
            nonlocal status_message_id
            if status_message_id is not None:
                return status_message_id
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=initial_text,
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=True,
                message_thread_id=thread_id,
                read_timeout=30,
                write_timeout=30,
                connect_timeout=30,
                pool_timeout=5,
            )
            status_message_id = sent.message_id
            return status_message_id

        output = ""
        detected_session_id: Optional[str] = None
        last_progress_emit = 0.0
        last_stream_text = ""
        started = time.monotonic()
        output_truncated = False
        draft_available = request.draft_enabled
        draft_text = ""
        pending_progress_text: Optional[str] = None
        progress_update_task: Optional[asyncio.Task] = None

        async def _send_progress_text(stream_text: str) -> None:
            nonlocal draft_available, draft_text
            if request.draft_enabled and draft_available and request.draft_id is not None and stream_text != draft_text:
                try:
                    await asyncio.wait_for(
                        self._send_message_draft_raw(
                            chat_id=chat_id,
                            draft_id=request.draft_id,
                            text=stream_text,
                            message_thread_id=thread_id,
                        ),
                        timeout=STREAM_PROGRESS_IO_TIMEOUT_SECONDS,
                    )
                    draft_text = stream_text
                except Exception:
                    draft_available = False

            if not (request.draft_enabled and draft_available):
                try:
                    message_id = await asyncio.wait_for(
                        _ensure_status_message_id(),
                        timeout=STREAM_PROGRESS_IO_TIMEOUT_SECONDS,
                    )
                    await asyncio.wait_for(
                        self.safe_edit(
                            context,
                            chat_id,
                            message_id,
                            stream_text,
                        ),
                        timeout=STREAM_PROGRESS_IO_TIMEOUT_SECONDS,
                    )
                except Exception:
                    return

        async def _flush_progress_updates() -> None:
            nonlocal pending_progress_text, progress_update_task
            try:
                while pending_progress_text is not None:
                    text = pending_progress_text
                    pending_progress_text = None
                    await _send_progress_text(text)
            finally:
                progress_update_task = None

        def _queue_progress_update(stream_text: str) -> None:
            nonlocal pending_progress_text, progress_update_task
            pending_progress_text = stream_text
            if progress_update_task is None or progress_update_task.done():
                progress_update_task = context.application.create_task(_flush_progress_updates())

        async def _stop_progress_updates() -> None:
            nonlocal pending_progress_text, progress_update_task
            pending_progress_text = None
            task = progress_update_task
            progress_update_task = None
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        try:
            async for chunk in run_codex_stream(cmd_args, self.settings.codex_timeout_seconds, cwd=workdir):
                output += chunk
                if len(output) > self.settings.max_buffered_output_chars:
                    output = output[-self.settings.max_buffered_output_chars :]
                    output_truncated = True
                maybe_session_id = self._extract_session_id(chunk)
                if maybe_session_id:
                    detected_session_id = maybe_session_id
                now = time.monotonic()
                throttle_seconds = EDIT_THROTTLE_SECONDS if chunk else IDLE_EDIT_THROTTLE_SECONDS
                if now - last_progress_emit < throttle_seconds:
                    continue

                stream_text = self._format_stream_text("Running", output, now - started)
                if stream_text == last_stream_text:
                    continue

                last_progress_emit = now
                last_stream_text = stream_text
                _queue_progress_update(stream_text)

            await _stop_progress_updates()
            cleaned_output = self._clean_output(output)
            if output_truncated:
                cleaned_output = "[output truncated for safety]\n" + cleaned_output
            final_session_id = self._extract_session_id(cleaned_output) or detected_session_id
            role_ops, visible_output = self._extract_role_ops(cleaned_output)
            if role_ops and not self._has_role_sync_intent(request.prompt):
                role_ops = []
            role_sync_summary = self._apply_role_skill_ops(request, role_ops)
            request.role = self._active_role_name(request.chat_id)
            schedule_ops, visible_output = self._extract_schedule_ops(visible_output)
            if schedule_ops and not self._has_schedule_sync_intent(request.prompt):
                schedule_ops = []
            schedule_sync_summary = await self._apply_schedule_skill_ops(request, schedule_ops)
            memory_ops, visible_output = self._extract_memory_ops(visible_output)
            memory_sync_summary = self._apply_memory_skill_ops(request, memory_ops)
            if not visible_output and (role_sync_summary or schedule_sync_summary or memory_sync_summary):
                visible_output = "Role, schedule, or memory updated."
            final_message_id = await _ensure_status_message_id("<i>Finalizing...</i>")
            await self._send_final_output_messages(
                context=context,
                chat_id=chat_id,
                message_id=final_message_id,
                cleaned_output=visible_output,
            )
            if self._should_upload_output_file(visible_output):
                output_path = self._write_output_file(
                    chat_id=chat_id,
                    message_id=final_message_id,
                    cleaned_output=visible_output,
                )
                output_path_str = str(output_path)
                try:
                    await self._upload_output_file(
                        context=context,
                        chat_id=chat_id,
                        output_path=output_path,
                    )
                except Exception as err:
                    await context.bot.send_message(
                        chat_id=chat_id,
                        text=(
                            "<b>文件上传失败</b>\n"
                            f"输出已保存到本地: {self._code_inline(str(output_path))}\n"
                            f"Reason: {self._code_inline(str(err))}"
                        ),
                        parse_mode=ParseMode.HTML,
                        disable_web_page_preview=True,
                    )
            if final_session_id:
                self._set_request_session_id(request, final_session_id)
            self._auto_save_execution_memory(request, visible_output)
            sync_sections: list[str] = []
            if role_sync_summary:
                sync_sections.append(f"<b>Role synced</b>\n{html.escape(role_sync_summary)}")
            if schedule_sync_summary:
                sync_sections.append(f"<b>Schedule synced</b>\n{html.escape(schedule_sync_summary)}")
            if memory_sync_summary:
                sync_sections.append(f"<b>Memory synced</b>\n{html.escape(memory_sync_summary)}")
            if sync_sections:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text="\n\n".join(sync_sections),
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True,
                    message_thread_id=thread_id,
                    read_timeout=30,
                    write_timeout=30,
                    connect_timeout=30,
                    pool_timeout=5,
                )
            summary = self._sanitize_output_for_preview(visible_output, "Completed").strip()
            if not summary:
                summary = self._truncate_text(visible_output.strip(), limit=900)
            return ExecutionResult(
                success=True,
                cleaned_output=visible_output,
                summary=summary,
                output_file=output_path_str,
                session_id=final_session_id or "",
                status_message_id=status_message_id,
            )
        except asyncio.CancelledError:
            await _stop_progress_updates()
            cancel_text = "<b>Task cancelled</b>\nExecution stopped by user."
            if status_message_id is not None:
                await self.safe_edit(
                    context,
                    chat_id,
                    status_message_id,
                    cancel_text,
                )
            else:
                try:
                    await context.bot.send_message(
                        chat_id=chat_id,
                        text=cancel_text,
                        parse_mode=ParseMode.HTML,
                        disable_web_page_preview=True,
                        message_thread_id=thread_id,
                        read_timeout=30,
                        write_timeout=30,
                        connect_timeout=30,
                        pool_timeout=5,
                    )
                except TelegramError:
                    pass
            raise
        except Exception as err:
            await _stop_progress_updates()
            diagnostic_path = self._write_failure_diagnostic(request, prepared_prompt, cmd_args, workdir, output, err)
            error_sections = [
                "<b>Task failed</b>",
                f"Reason: {self._code_inline(str(err))}",
                f"Command: {self._code_inline(self._redacted_command_text(shlex.join(cmd_args)))}",
                f"Workdir: {self._code_inline(str(workdir))}",
            ]
            excerpt = self._error_output_excerpt(output)
            if excerpt:
                error_sections.append(f"Last output:\n{self._code_block(excerpt)}")
            error_sections.append(f"Diagnostic: {self._code_inline(str(diagnostic_path))}")
            error_text = "\n".join(error_sections)
            if status_message_id is not None:
                await self.safe_edit(
                    context,
                    chat_id,
                    status_message_id,
                    error_text,
                )
            else:
                try:
                    await context.bot.send_message(
                        chat_id=chat_id,
                        text=error_text,
                        parse_mode=ParseMode.HTML,
                        disable_web_page_preview=True,
                        message_thread_id=thread_id,
                        read_timeout=30,
                        write_timeout=30,
                        connect_timeout=30,
                        pool_timeout=5,
                    )
                except TelegramError:
                    pass
            return ExecutionResult(
                success=False,
                error_text=str(err),
                summary=self._truncate_text(str(err), limit=240),
                diagnostic_file=str(diagnostic_path),
                status_message_id=status_message_id,
            )
        finally:
            for path in cleanup_targets:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    continue

    async def run_scheduled_job(self, job: ScheduledJob) -> ExecutionResult:
        if self.application is None:
            raise RuntimeError("telegram application not ready")
        if not self.is_allowed(job.chat_id):
            raise RuntimeError("scheduled job chat is no longer allowed")
        if job.owner_user_id is not None and not self.is_user_allowed(job.owner_user_id):
            raise RuntimeError("scheduled job owner is no longer allowed")
        if job.chat_id in self.tasks and not self.tasks[job.chat_id].done():
            return ExecutionResult(success=False, error_text="chat already has a running task", summary="chat busy", skipped=True)
        running_total = sum(1 for task in self.tasks.values() if not task.done())
        if running_total >= self.settings.max_concurrent_tasks:
            return ExecutionResult(success=False, error_text="system busy", summary="system busy", skipped=True)

        request = ExecutionRequest(
            chat_id=job.chat_id,
            prompt=job.prompt_template,
            source="schedule",
            thread_id=None,
            draft_enabled=False,
            draft_id=None,
            status_message_id=None,
            cleanup_paths=[],
            workdir=Path(job.workdir) if job.workdir else self._effective_workdir(job.chat_id),
            command_prefix=job.command_prefix or self._get_chat_command_prefix(job.chat_id),
            session_mode="job" if job.session_policy == "resume-job" else "fresh",
            session_ref=job.id,
            memory_scope=job.memory_scope or self._default_memory_scope(job.chat_id),
            role=job.role,
            owner_user_id=job.owner_user_id,
        )
        context = self._request_context()
        current_task = asyncio.current_task()
        if current_task is None:
            raise RuntimeError("scheduler task unavailable")
        self.tasks[job.chat_id] = current_task
        try:
            return await self._execute_request_worker(context, request)
        finally:
            if self.tasks.get(job.chat_id) is current_task:
                self.tasks.pop(job.chat_id, None)
