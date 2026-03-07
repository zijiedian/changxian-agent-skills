---
name: changxian-schedule
description: Manage scheduled jobs for changxian-agent. Use when a conversation includes schedule state, or when the user asks to create, update, pause, resume, trigger, or delete recurring/one-time jobs.
---

# Changxian Schedule

## When To Use

Use this skill whenever changxian-agent provides a `[SCHEDULE STATE]` block or the user asks to:

- create one-time or recurring jobs
- update schedule job fields
- pause or resume jobs
- trigger a job immediately
- delete a job

## Goals

- Keep scheduled jobs explicit, deterministic, and easy to audit.
- Reuse existing jobs where possible instead of creating accidental duplicates.
- Emit schedule operations only when state should really change.

## Scheduling Rules

- Treat `[SCHEDULE STATE]` as the authoritative schedule state for this chat.
- Prefer concrete schedules (`once`, `every`, `cron`) with explicit expressions.
- Prefer stable prompts for recurring jobs.
- When editing an existing job, prefer `set_job` over delete-and-recreate.
- Avoid no-op schedule operations that do not change job state.
- If the user request is not about scheduled jobs, never emit a schedule-ops block.
- If the user only asks to view, list, count, inspect, or explain existing jobs, never emit a schedule-ops block.
- When schedule state really changes, briefly explain the change points in user-facing prose.

## Output Protocol

When schedule state should change, append exactly one fenced block at the very end of the answer:

```tg-schedule-ops
{"ops":[...]}
```

Storage note: this skill emits schedule operations only. The host bridge consumes `tg-schedule-ops` and persists scheduled jobs in its scheduler store.

Supported operations:

- `create_job`
- `set_job`
- `pause_job`
- `resume_job`
- `run_job`
- `delete_job`

Supported fields:

- `op`: required operation name
- `job_id`: preferred target field for existing jobs
- `name`: optional job name (also used for lookup when `job_id` is absent)
- `query` or `contains`: optional fallback matcher when `job_id` is absent
- `schedule_type`: `once`, `every`, or `cron` (for `create_job`)
- `schedule_expr`: schedule expression (for `create_job` or `set_job`)
- `timezone`: optional IANA timezone (defaults to host timezone)
- `prompt` or `prompt_template`: job prompt (for `create_job` or `set_job`)
- `name` or `title`: optional job display name (for `create_job` or `set_job`)
- `role`: optional role override (`none` to clear)
- `memory_scope`: optional memory scope override
- `session_policy`: optional `resume-job` or `fresh`
- `enabled`: optional boolean when creating jobs

## Examples

User says: “每天早上 9 点检查 changxian-agent issue，并总结给我。”

```tg-schedule-ops
{"ops":[{"op":"create_job","schedule_type":"cron","schedule_expr":"0 9 * * *","timezone":"Asia/Shanghai","prompt":"check changxian-agent open issues and send a concise summary"}]}
```

User says: “把 job_123 的 role 改成 reviewer。”

```tg-schedule-ops
{"ops":[{"op":"set_job","job_id":"job_123","role":"reviewer"}]}
```

User says: “把 job_123 改成每 6 小时执行一次。”

```tg-schedule-ops
{"ops":[{"op":"set_job","job_id":"job_123","schedule_type":"every","schedule_expr":"6h"}]}
```

User says: “把 job_123 的日报 prompt 改一下。”

```tg-schedule-ops
{"ops":[{"op":"set_job","job_id":"job_123","prompt":"generate a concise AI and security daily brief with clickable source URLs"}]}
```

User says: “暂停 job_123。”

```tg-schedule-ops
{"ops":[{"op":"pause_job","job_id":"job_123"}]}
```
