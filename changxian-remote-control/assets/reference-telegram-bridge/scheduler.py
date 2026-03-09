import asyncio
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Optional
from zoneinfo import ZoneInfo

from telegram.ext import Application

if TYPE_CHECKING:
    from bridge import Bridge
    from settings import Settings


@dataclass
class ScheduledJob:
    id: str
    chat_id: int
    owner_user_id: Optional[int]
    name: str
    schedule_type: str
    schedule_expr: str
    timezone: str
    prompt_template: str
    role: str
    memory_scope: str
    workdir: str
    command_prefix: str
    session_policy: str
    concurrency_policy: str
    next_run_at: Optional[int]
    last_run_at: Optional[int]
    enabled: bool
    created_at: int
    updated_at: int


class SchedulerStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS scheduled_jobs (
                    id TEXT PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    owner_user_id INTEGER,
                    name TEXT NOT NULL,
                    schedule_type TEXT NOT NULL,
                    schedule_expr TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    prompt_template TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT '',
                    memory_scope TEXT NOT NULL DEFAULT '',
                    workdir TEXT NOT NULL DEFAULT '',
                    command_prefix TEXT NOT NULL DEFAULT '',
                    session_policy TEXT NOT NULL DEFAULT 'resume-job',
                    concurrency_policy TEXT NOT NULL DEFAULT 'skip',
                    next_run_at INTEGER,
                    last_run_at INTEGER,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS job_runs (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    finished_at INTEGER,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    output_file TEXT NOT NULL DEFAULT '',
                    error_text TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS job_sessions (
                    job_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            conn.commit()
        try:
            self.db_path.chmod(0o600)
        except OSError:
            pass

    def add_job(
        self,
        *,
        chat_id: int,
        owner_user_id: Optional[int],
        name: str,
        schedule_type: str,
        schedule_expr: str,
        timezone: str,
        prompt_template: str,
        role: str,
        memory_scope: str,
        workdir: str,
        command_prefix: str,
        session_policy: str,
        concurrency_policy: str,
        next_run_at: int,
    ) -> ScheduledJob:
        now = int(time.time())
        job = ScheduledJob(
            id=f"job_{uuid.uuid4().hex[:8]}",
            chat_id=chat_id,
            owner_user_id=owner_user_id,
            name=name.strip(),
            schedule_type=schedule_type.strip(),
            schedule_expr=schedule_expr.strip(),
            timezone=timezone.strip(),
            prompt_template=prompt_template.strip(),
            role=role.strip(),
            memory_scope=memory_scope.strip(),
            workdir=workdir.strip(),
            command_prefix=command_prefix.strip(),
            session_policy=session_policy.strip() or "resume-job",
            concurrency_policy=concurrency_policy.strip() or "skip",
            next_run_at=next_run_at,
            last_run_at=None,
            enabled=True,
            created_at=now,
            updated_at=now,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_jobs (
                    id, chat_id, owner_user_id, name, schedule_type, schedule_expr, timezone,
                    prompt_template, role, memory_scope, workdir, command_prefix,
                    session_policy, concurrency_policy, next_run_at, last_run_at,
                    enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.id,
                    job.chat_id,
                    job.owner_user_id,
                    job.name,
                    job.schedule_type,
                    job.schedule_expr,
                    job.timezone,
                    job.prompt_template,
                    job.role,
                    job.memory_scope,
                    job.workdir,
                    job.command_prefix,
                    job.session_policy,
                    job.concurrency_policy,
                    job.next_run_at,
                    job.last_run_at,
                    1,
                    job.created_at,
                    job.updated_at,
                ),
            )
            conn.commit()
        return job

    def list_jobs(self, chat_id: int) -> list[ScheduledJob]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_jobs WHERE chat_id = ? ORDER BY enabled DESC, next_run_at ASC, created_at DESC",
                (chat_id,),
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def get_job(self, chat_id: int, job_id: str) -> Optional[ScheduledJob]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_jobs WHERE chat_id = ? AND id = ?",
                (chat_id, job_id.strip()),
            ).fetchone()
        return self._row_to_job(row) if row is not None else None

    def get_job_by_id(self, job_id: str) -> Optional[ScheduledJob]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_jobs WHERE id = ?",
                (job_id.strip(),),
            ).fetchone()
        return self._row_to_job(row) if row is not None else None

    def update_job_fields(
        self,
        chat_id: int,
        job_id: str,
        *,
        name: Optional[str] = None,
        schedule_type: Optional[str] = None,
        schedule_expr: Optional[str] = None,
        timezone: Optional[str] = None,
        prompt_template: Optional[str] = None,
        role: Optional[str] = None,
        memory_scope: Optional[str] = None,
        session_policy: Optional[str] = None,
        next_run_at: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[ScheduledJob]:
        updates: dict[str, object] = {}
        if name is not None:
            updates["name"] = name.strip()
        if schedule_type is not None:
            updates["schedule_type"] = schedule_type.strip()
        if schedule_expr is not None:
            updates["schedule_expr"] = schedule_expr.strip()
        if timezone is not None:
            updates["timezone"] = timezone.strip()
        if prompt_template is not None:
            updates["prompt_template"] = prompt_template.strip()
        if role is not None:
            updates["role"] = role.strip()
        if memory_scope is not None:
            updates["memory_scope"] = memory_scope.strip()
        if session_policy is not None:
            updates["session_policy"] = session_policy.strip()
        if next_run_at is not None:
            updates["next_run_at"] = int(next_run_at)
        if enabled is not None:
            updates["enabled"] = 1 if enabled else 0
        if not updates:
            return self.get_job(chat_id, job_id)

        assignments = [f"{column} = ?" for column in updates]
        params: list[object] = list(updates.values())
        assignments.append("updated_at = ?")
        params.append(int(time.time()))
        params.extend([chat_id, job_id.strip()])
        with self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE scheduled_jobs SET {', '.join(assignments)} WHERE chat_id = ? AND id = ?",
                tuple(params),
            )
            conn.commit()
        if cursor.rowcount <= 0:
            return None
        return self.get_job(chat_id, job_id)

    def list_due_jobs(self, now_ts: int, limit: int = 20) -> list[ScheduledJob]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM scheduled_jobs
                WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
                ORDER BY next_run_at ASC
                LIMIT ?
                """,
                (int(now_ts), int(limit)),
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def update_schedule_state(
        self,
        *,
        job_id: str,
        next_run_at: Optional[int],
        enabled: bool,
        last_run_at: Optional[int] = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE scheduled_jobs
                SET next_run_at = ?, enabled = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ?
                WHERE id = ?
                """,
                (next_run_at, 1 if enabled else 0, last_run_at, int(time.time()), job_id.strip()),
            )
            conn.commit()

    def set_enabled(self, chat_id: int, job_id: str, enabled: bool, next_run_at: Optional[int]) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE scheduled_jobs
                SET enabled = ?, next_run_at = ?, updated_at = ?
                WHERE chat_id = ? AND id = ?
                """,
                (1 if enabled else 0, next_run_at, int(time.time()), chat_id, job_id.strip()),
            )
            conn.commit()
        return cursor.rowcount > 0

    def delete_job(self, chat_id: int, job_id: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM scheduled_jobs WHERE chat_id = ? AND id = ?",
                (chat_id, job_id.strip()),
            )
            conn.execute("DELETE FROM job_sessions WHERE job_id = ?", (job_id.strip(),))
            conn.commit()
        return cursor.rowcount > 0

    def create_run(self, job_id: str) -> str:
        run_id = f"run_{uuid.uuid4().hex[:10]}"
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO job_runs (id, job_id, started_at, status) VALUES (?, ?, ?, ?)",
                (run_id, job_id.strip(), int(time.time()), "running"),
            )
            conn.commit()
        return run_id

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        summary: str = "",
        output_file: str = "",
        error_text: str = "",
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE job_runs
                SET finished_at = ?, status = ?, summary = ?, output_file = ?, error_text = ?
                WHERE id = ?
                """,
                (int(time.time()), status.strip(), summary.strip(), output_file.strip(), error_text.strip(), run_id.strip()),
            )
            conn.commit()

    def get_job_session(self, job_id: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT session_id FROM job_sessions WHERE job_id = ?",
                (job_id.strip(),),
            ).fetchone()
        if row is None:
            return None
        return str(row["session_id"]).strip() or None

    def set_job_session(self, job_id: str, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO job_sessions (job_id, session_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    updated_at = excluded.updated_at
                """,
                (job_id.strip(), session_id.strip(), int(time.time())),
            )
            conn.commit()

    def clear_job_session(self, job_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM job_sessions WHERE job_id = ?", (job_id.strip(),))
            conn.commit()

    def count_jobs(self, chat_id: int, *, enabled_only: bool = False) -> int:
        sql = "SELECT COUNT(*) AS count FROM scheduled_jobs WHERE chat_id = ?"
        params: tuple[object, ...] = (chat_id,)
        if enabled_only:
            sql += " AND enabled = 1"
        with self._connect() as conn:
            row = conn.execute(sql, params).fetchone()
        return int(row["count"]) if row is not None else 0

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> ScheduledJob:
        return ScheduledJob(
            id=row["id"],
            chat_id=int(row["chat_id"]),
            owner_user_id=int(row["owner_user_id"]) if row["owner_user_id"] is not None else None,
            name=row["name"],
            schedule_type=row["schedule_type"],
            schedule_expr=row["schedule_expr"],
            timezone=row["timezone"],
            prompt_template=row["prompt_template"],
            role=row["role"] or "",
            memory_scope=row["memory_scope"] or "",
            workdir=row["workdir"] or "",
            command_prefix=row["command_prefix"] or "",
            session_policy=row["session_policy"] or "resume-job",
            concurrency_policy=row["concurrency_policy"] or "skip",
            next_run_at=int(row["next_run_at"]) if row["next_run_at"] is not None else None,
            last_run_at=int(row["last_run_at"]) if row["last_run_at"] is not None else None,
            enabled=bool(row["enabled"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )


class SchedulerService:
    def __init__(self, bridge: "Bridge", store: SchedulerStore, settings: "Settings"):
        self.bridge = bridge
        self.store = store
        self.settings = settings
        self._loop_task: Optional[asyncio.Task] = None
        self._running_jobs: dict[str, asyncio.Task] = {}
        self._application: Optional[Application] = None
        self._tick_lock = asyncio.Lock()

    async def start(self, application: Application) -> None:
        if not self.settings.enable_scheduler:
            return
        if self._loop_task and not self._loop_task.done():
            return
        self._application = application
        self._loop_task = application.create_task(self._run_loop())

    async def stop(self) -> None:
        task = self._loop_task
        self._loop_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        running = list(self._running_jobs.values())
        self._running_jobs.clear()
        for job_task in running:
            if job_task and not job_task.done():
                job_task.cancel()
        for job_task in running:
            if job_task and not job_task.done():
                try:
                    await job_task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
        self._application = None

    async def tick(self) -> None:
        if not self.settings.enable_scheduler:
            return
        application = self._application
        if application is None:
            return
        async with self._tick_lock:
            now_ts = int(time.time())
            due_jobs = self.store.list_due_jobs(now_ts, limit=20)
            for job in due_jobs:
                if job.id in self._running_jobs and not self._running_jobs[job.id].done():
                    if job.concurrency_policy == "skip":
                        next_run_at, enabled = compute_next_run(job, now_ts)
                        self.store.update_schedule_state(job_id=job.id, next_run_at=next_run_at, enabled=enabled)
                    continue

                next_run_at, enabled = compute_next_run(job, now_ts)
                self.store.update_schedule_state(
                    job_id=job.id,
                    next_run_at=next_run_at,
                    enabled=enabled,
                    last_run_at=now_ts,
                )
                run_id = self.store.create_run(job.id)
                task = application.create_task(self._run_job(job, run_id))
                self._running_jobs[job.id] = task
                task.add_done_callback(lambda _task, job_id=job.id: self._running_jobs.pop(job_id, None))

    async def trigger_job_now(self, job: ScheduledJob) -> str:
        application = self._application
        if application is None:
            raise RuntimeError("scheduler not started")
        if job.id in self._running_jobs and not self._running_jobs[job.id].done():
            raise RuntimeError("job is already running")
        run_id = self.store.create_run(job.id)
        task = application.create_task(self._run_job(job, run_id))
        self._running_jobs[job.id] = task
        task.add_done_callback(lambda _task, job_id=job.id: self._running_jobs.pop(job_id, None))
        return run_id

    async def _run_loop(self) -> None:
        while True:
            await self.tick()
            await asyncio.sleep(max(1, self.settings.scheduler_poll_seconds))

    async def _run_job(self, job: ScheduledJob, run_id: str) -> None:
        try:
            result = await self.bridge.run_scheduled_job(job)
        except asyncio.CancelledError:
            self.store.finish_run(run_id, status="cancelled", error_text="cancelled")
            raise
        except Exception as err:
            self.store.finish_run(run_id, status="failed", error_text=str(err))
            try:
                await self.bridge.notify_schedule_failure(job, str(err))
            except Exception:
                pass
            return

        if result.skipped:
            self.store.finish_run(
                run_id,
                status="skipped",
                summary=result.summary,
                output_file=result.output_file or "",
                error_text=result.error_text,
            )
            return

        status = "success" if result.success else "failed"
        self.store.finish_run(
            run_id,
            status=status,
            summary=result.summary,
            output_file=result.output_file or "",
            error_text=result.error_text,
        )
        if not result.success and result.error_text:
            try:
                await self.bridge.notify_schedule_failure(job, result.error_text)
            except Exception:
                pass


def parse_schedule_spec(kind: str, expr: str, timezone_name: str, now_ts: int) -> tuple[str, int]:
    schedule_type = (kind or "").strip().lower()
    if schedule_type not in {"once", "every", "cron"}:
        raise ValueError("schedule type must be once, every, or cron")

    if schedule_type == "every":
        seconds = parse_duration_seconds(expr)
        return expr.strip().lower(), now_ts + seconds

    if schedule_type == "once":
        zone = ZoneInfo(timezone_name)
        target = parse_once_datetime(expr, zone)
        ts = int(target.timestamp())
        if ts <= now_ts:
            raise ValueError("once schedule must be in the future")
        return expr.strip(), ts

    next_run = next_cron_timestamp(expr, timezone_name, now_ts)
    return normalize_cron_expression(expr), next_run


def compute_next_run(job: ScheduledJob, now_ts: int) -> tuple[Optional[int], bool]:
    schedule_type = job.schedule_type.strip().lower()
    if schedule_type == "once":
        return None, False
    if schedule_type == "every":
        seconds = parse_duration_seconds(job.schedule_expr)
        return now_ts + seconds, True
    if schedule_type == "cron":
        return next_cron_timestamp(job.schedule_expr, job.timezone, now_ts), True
    raise ValueError(f"unsupported schedule type: {job.schedule_type}")


def parse_duration_seconds(raw: str) -> int:
    text = (raw or "").strip().lower()
    if not text:
        raise ValueError("duration is required")
    unit = text[-1] if text[-1].isalpha() else "s"
    amount_text = text[:-1] if unit != "s" or not text[-1].isdigit() else text
    if unit == "s" and amount_text != text and not amount_text:
        amount_text = text[:-1]
    if unit not in {"s", "m", "h", "d"}:
        raise ValueError("duration must end with s, m, h, or d")
    if unit == "s" and amount_text == text:
        amount = int(text)
    else:
        amount = int(amount_text)
    multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    seconds = amount * multipliers[unit]
    if seconds <= 0:
        raise ValueError("duration must be positive")
    return seconds


def parse_once_datetime(raw: str, zone: ZoneInfo) -> datetime:
    value = (raw or "").strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            parsed = datetime.strptime(value, fmt)
        except ValueError:
            continue
        return parsed.replace(tzinfo=zone)
    raise ValueError("once schedule must look like 2026-03-07 09:30")


def normalize_cron_expression(expr: str) -> str:
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError("cron must contain 5 fields")
    parse_cron_field(fields[0], 0, 59)
    parse_cron_field(fields[1], 0, 23)
    parse_cron_field(fields[2], 1, 31)
    parse_cron_field(fields[3], 1, 12)
    parse_cron_field(fields[4], 0, 6)
    return " ".join(fields)


def next_cron_timestamp(expr: str, timezone_name: str, now_ts: int) -> int:
    normalized = normalize_cron_expression(expr)
    minute_field, hour_field, day_field, month_field, weekday_field = normalized.split()
    minute_values = parse_cron_field(minute_field, 0, 59)
    hour_values = parse_cron_field(hour_field, 0, 23)
    day_values = parse_cron_field(day_field, 1, 31)
    month_values = parse_cron_field(month_field, 1, 12)
    weekday_values = parse_cron_field(weekday_field, 0, 6)
    zone = ZoneInfo(timezone_name)
    candidate = datetime.fromtimestamp(now_ts, zone).replace(second=0, microsecond=0) + timedelta(minutes=1)
    max_checks = 525600
    for _ in range(max_checks):
        weekday = (candidate.weekday() + 1) % 7
        if (
            candidate.minute in minute_values
            and candidate.hour in hour_values
            and candidate.day in day_values
            and candidate.month in month_values
            and weekday in weekday_values
        ):
            return int(candidate.timestamp())
        candidate += timedelta(minutes=1)
    raise ValueError("unable to compute next cron run within one year")


def parse_cron_field(field: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    for part in field.split(","):
        token = part.strip()
        if not token:
            raise ValueError("invalid cron field")
        if token == "*":
            values.update(range(minimum, maximum + 1))
            continue
        step = 1
        base = token
        if "/" in token:
            base, step_raw = token.split("/", 1)
            step = int(step_raw)
            if step <= 0:
                raise ValueError("cron step must be positive")
        if base == "*":
            start = minimum
            end = maximum
        elif "-" in base:
            start_raw, end_raw = base.split("-", 1)
            start = int(start_raw)
            end = int(end_raw)
        else:
            start = int(base)
            end = int(base)
        if start < minimum or end > maximum or start > end:
            raise ValueError("cron field out of range")
        values.update(range(start, end + 1, step))
    if not values:
        raise ValueError("cron field resolves to empty set")
    return values
