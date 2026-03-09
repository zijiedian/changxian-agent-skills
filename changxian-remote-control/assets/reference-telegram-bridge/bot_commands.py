from dataclasses import dataclass

from telegram import BotCommand


@dataclass(frozen=True)
class CommandSpec:
    name: str
    menu_description: str
    help_markup: str


COMMAND_SPECS: tuple[CommandSpec, ...] = (
    CommandSpec(
        "start",
        "Show help and available commands",
        "<code>/start</code> show help and available commands",
    ),
    CommandSpec(
        "run",
        "Execute a prompt",
        "<code>/run &lt;prompt&gt;</code> execute a prompt",
    ),
    CommandSpec(
        "new",
        "Start a fresh Codex session",
        "<code>/new</code> start a fresh Codex session",
    ),
    CommandSpec(
        "cwd",
        "Show or change working directory",
        "<code>/cwd</code> show or change working directory",
    ),
    CommandSpec(
        "skill",
        "List installed Codex skills",
        "<code>/skill</code> list installed Codex skills",
    ),
    CommandSpec(
        "status",
        "Show current task status",
        "<code>/status</code> show current task status",
    ),
    CommandSpec(
        "cancel", "Stop current task", "<code>/cancel</code> stop current task"
    ),
    CommandSpec(
        "id", "Show current chat/user id", "<code>/id</code> show current chat/user id"
    ),
    CommandSpec(
        "auth",
        "Unlock execution",
        "<code>/auth &lt;passphrase&gt;</code> unlock execution",
    ),
    CommandSpec(
        "cmd",
        "Show or update command prefix",
        "<code>/cmd</code> show or update command prefix",
    ),
    CommandSpec(
        "setting",
        "Show or update bridge settings",
        "<code>/setting</code> show or update runtime settings",
    ),
    CommandSpec(
        "backend",
        "Switch between Codex and OpenCode",
        "<code>/backend codex|opencode</code> switch execution backend",
    ),
)

BOT_MENU_COMMANDS: tuple[BotCommand, ...] = tuple(
    BotCommand(spec.name, spec.menu_description) for spec in COMMAND_SPECS
)


def start_help_lines() -> tuple[str, ...]:
    return tuple(f"- {spec.help_markup}" for spec in COMMAND_SPECS)
