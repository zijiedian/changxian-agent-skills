import asyncio
import shlex
import time
from pathlib import Path, PurePath
from typing import AsyncIterator, Optional


def _command_parts(prefix: str) -> list[str]:
    parts = shlex.split(prefix)
    if not parts:
        raise ValueError("command prefix cannot be empty")
    return parts


def _is_opencode_prefix(prefix: str) -> bool:
    try:
        parts = _command_parts(prefix)
    except ValueError:
        return False
    return "opencode" in PurePath(parts[0]).name.lower()


def _validate_codex_prefix(prefix: str) -> list[str]:
    parts = _command_parts(prefix)
    first = PurePath(parts[0]).name.lower()
    if "codex" not in first:
        raise ValueError("command prefix must start with a codex executable")
    if "exec" not in parts:
        raise ValueError("command prefix must include exec")
    if "--dangerously-skip-permissions" in parts:
        raise ValueError("command prefix cannot use --dangerously-skip-permissions")

    exec_idx = parts.index("exec")
    if "--search" in parts and parts.index("--search") > exec_idx:
        raise ValueError(
            "invalid option order: --search must appear before exec. "
            "Use: codex -a never --search exec -s danger-full-access --skip-git-repo-check"
        )

    approval_mode = ""
    if "-a" in parts:
        idx = parts.index("-a")
        approval_mode = parts[idx + 1] if idx + 1 < len(parts) else ""
    if "--ask-for-approval" in parts:
        idx = parts.index("--ask-for-approval")
        approval_mode = parts[idx + 1] if idx + 1 < len(parts) else ""
    if approval_mode and approval_mode != "never":
        raise ValueError("command prefix must keep approval mode as never")
    return parts


def _validate_opencode_prefix(prefix: str) -> list[str]:
    """Validate an OpenCode command prefix for this local CLI."""
    parts = _command_parts(prefix)
    first = PurePath(parts[0]).name.lower()
    if "opencode" not in first:
        raise ValueError("command prefix must start with opencode executable")
    if "run" not in parts:
        raise ValueError("command prefix must include run")
    if "--dir" not in parts:
        raise ValueError("command prefix must include --dir")
    dir_idx = parts.index("--dir")
    if dir_idx + 1 >= len(parts) or not parts[dir_idx + 1].strip():
        raise ValueError("command prefix must provide a directory after --dir")
    return parts


def _validate_command_prefix(prefix: str) -> list[str]:
    if _is_opencode_prefix(prefix):
        return _validate_opencode_prefix(prefix)
    return _validate_codex_prefix(prefix)


async def run_codex_stream(
    cmd: list[str], timeout_seconds: int, cwd: Optional[Path] = None
) -> AsyncIterator[str]:
    tool_name = Path(cmd[0]).name if cmd else "command"
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(cwd) if cwd else None,
        )
    except FileNotFoundError as err:
        raise RuntimeError(f"{tool_name} command not found: {cmd[0]}") from err
    if proc.stdout is None:
        proc.kill()
        await proc.wait()
        raise RuntimeError("codex subprocess stdout is unavailable")

    # Timeout is enforced on both total runtime and stdout reads.
    start = time.monotonic()
    try:
        while True:
            elapsed = time.monotonic() - start
            if elapsed >= timeout_seconds:
                proc.kill()
                await proc.wait()
                raise TimeoutError(f"codex command timed out after {timeout_seconds}s")
            remaining = timeout_seconds - elapsed
            read_timeout = min(1.0, remaining)
            try:
                line = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=read_timeout
                )
            except asyncio.TimeoutError:
                # Heartbeat: keep UI updates (spinner/timer) flowing while waiting for next chunk.
                yield ""
                continue
            if not line:
                break
            yield line.decode("utf-8", errors="replace")
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise

    code = await proc.wait()
    if code != 0:
        raise RuntimeError(f"{tool_name} exited with code {code}")
