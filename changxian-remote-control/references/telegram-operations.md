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

Examples:

- `/schedule add every 1h | summarize the latest logs`
- `/schedule add once 2026-03-07 09:30 | review open pull requests`
- `/schedule add cron 0 9 * * * | check deployment health`
- `/schedule set <job_id> role | reviewer`
- `/schedule set <job_id> memory_scope | project:changxian-agent`
- `/schedule run <job_id>`
- `/schedule pause <job_id>`
- `/schedule resume <job_id>`
- `/schedule rm <job_id>`

## Collaboration With Other Skills

- Use `changxian-memory-manager` for durable preferences and facts.
- Use `changxian-role-manager` for persistent reusable roles.
