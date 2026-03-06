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

## Scheduled Jobs

The reference bridge no longer exposes `/schedule` commands.
Use `changxian-schedule` with `tg-schedule-ops` blocks to manage scheduled jobs.

Example operation block:

```tg-schedule-ops
{"ops":[{"op":"create_job","schedule_type":"cron","schedule_expr":"0 9 * * *","prompt":"check deployment health and summarize failures","timezone":"Asia/Shanghai"}]}
```

## Collaboration With Other Skills

- Use `changxian-memory-manager` for durable preferences and facts.
- Use `changxian-role-manager` for persistent reusable roles.
- Use `changxian-schedule` for persistent scheduled-job management.
