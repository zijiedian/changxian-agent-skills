# Telegram Operations

## Interactive Use

- Send plain text to start a task.
- Send an image with an optional caption to start an image-aware task.
- Do not require `/run`; plain text already executes unless the message is a slash command.
- Use `/status` to inspect progress.
- Use `/cancel` to stop the current task.
- Use `/new` to reset the current backend session.

## Configuration Controls

- `/cwd <path>` changes the working directory.
- `/cmd low|readonly|high` switches the Codex permission tier when the chat uses the Codex backend.
- `/cmd <custom-prefix>` can point the current chat at `claude-agent-acp`, `pi-acp`, `opencode acp`, or `npx -y opencode-ai acp`.
- `/backend claude|codex|opencode-acp|pi|default` switches the execution backend for the current chat.
- `/skill list|enable|disable` inspects or toggles system skills.
- `/mcp list|enable|disable` inspects or toggles MCP servers.
- `/setting output_file on|off` toggles output-file upload.
- `/setting memory on|off` toggles memory injection.
- `/setting scheduler on|off` toggles the scheduler.

## Claude ACP

- Install and authenticate Claude ACP with `npm install -g @zed-industries/claude-agent-acp` plus `claude auth login`.
- Use `/backend claude` to switch the current chat to Claude ACP.
- Set `RC_DEFAULT_BACKEND=claude` to make Claude ACP the bridge default.
- Set `RC_CLAUDE_COMMAND_PREFIX=claude-agent-acp` to change the Claude ACP executable or wrapping command.

See `references/claude-backend.md` for the full backend-specific setup and behavior notes.

## OpenCode ACP

- Use `/backend claude` to switch away from Claude ACP when needed.
- Install and authenticate OpenCode with `opencode auth login`.
- Use `/backend opencode-acp` to switch the current chat to OpenCode ACP.
- Use `/backend codex` to switch back to the Codex ACP backend.
- Set `RC_DEFAULT_BACKEND=opencode-acp` to make OpenCode ACP the bridge default.
- Set `OPENCODE_ACP_COMMAND_PREFIX=npx -y opencode-ai acp` when the global `opencode` binary is unavailable.
- When OpenCode asks for tool approval, Telegram now renders the ACP permission options as inline buttons instead of auto-approving `allow_once`.

See `references/opencode-acp.md` for the full backend-specific setup and behavior notes.

## Pi ACP

- Install Pi ACP with `npm install -g pi-acp`.
- Use `/backend pi` to switch the current chat to Pi ACP.
- Use `/backend codex` or `/backend claude` to switch away when needed.
- Set `RC_DEFAULT_BACKEND=pi` to make Pi the bridge default.
- Set `RC_PI_COMMAND_PREFIX=pi-acp` to change the Pi ACP executable or wrapping command.

See `references/pi-backend.md` for the full backend-specific setup and behavior notes.

## Channel Publishing

- `/channel list` shows configured Telegram channel aliases
- `/channel preview <alias> | <content>` renders and previews content in the current control chat
- `/channel send <alias> | <content>` publishes content to a configured Telegram channel
- `/channel test <alias>` sends a short publish test message to the configured channel

Recommended config:

```env
TG_CHANNEL_TARGETS={"daily":"@my_daily_channel","news":"-1001234567890"}
TG_DEFAULT_CHANNEL=daily
TG_CHANNEL_ALLOWED_OPERATOR_IDS=123456789
```

Rules:

- publish only to configured aliases
- preview in the current chat before sending when content matters
- keep the allowlist enabled for operator safety when multiple humans share the bridge

## Scheduled Jobs

Use `/schedule` commands or emit `rc-schedule-ops` blocks through `changxian-remote-control` to manage scheduled jobs.

Example operation block:

```rc-schedule-ops
{"ops":[{"op":"create_job","schedule_type":"cron","schedule_expr":"0 9 * * *","prompt":"check deployment health and summarize failures","timezone":"Asia/Shanghai"}]}
```

Run an existing job immediately without changing its schedule:

```rc-schedule-ops
{"ops":[{"op":"run_job","job_id":"daily-health-check"}]}
```

## Collaboration With Other Skills

- Use `changxian-remote-control` for durable preferences and facts stored in the bridge.
- Use `changxian-remote-control` for persistent reusable roles.
- Use `changxian-remote-control` for persistent scheduled-job management.
