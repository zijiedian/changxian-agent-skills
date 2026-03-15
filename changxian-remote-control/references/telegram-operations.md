# Telegram Operations

## Interactive Use

- Send plain text to start a task.
- Send an image with an optional caption to start an image-aware task.
- Use `/status` to inspect progress.
- Use `/cancel` to stop the current task.
- Use `/new` to reset the Codex session.

## Configuration Controls

- `/cwd <path>` changes the working directory.
- `/cmd low|readonly|high` switches the Codex permission tier.
- `/setting output_file on|off` toggles output-file upload.
- `/setting memory on|off` toggles memory injection.
- `/setting scheduler on|off` toggles the scheduler.

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

## Collaboration With Other Skills

- Use `changxian-remote-control` for durable preferences and facts stored in the bridge.
- Use `changxian-remote-control` for persistent reusable roles.
- Use `changxian-remote-control` for persistent scheduled-job management.
