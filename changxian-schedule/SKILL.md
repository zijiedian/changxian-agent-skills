---
name: changxian-schedule
description: Manage scheduled jobs for changxian-agent. Use when a turn includes `[SCHEDULE STATE]` or the user asks to create, inspect, update, pause, resume, run, or delete one-time, interval, or cron jobs.
---

# Changxian Schedule

Use this skill only for scheduled-job lifecycle management. Treat every job as an explicit, auditable record.

## Scheduling Rules

- Treat `[SCHEDULE STATE]` as the authoritative schedule state for the current chat.
- Prefer concrete schedules: `once`, `every`, or `cron` with explicit expressions.
- Keep recurring prompts stable, self-contained, and deterministic.
- Prefer `set_job` over delete-and-recreate when editing an existing job.
- Reuse an existing job when the requested schedule is effectively the same.
- Emit no schedule block when the user only wants to inspect or explain existing jobs.
- Briefly explain real schedule changes in user-facing prose.

## Output Protocol

When schedule state should change, append exactly one fenced block at the very end of the answer:

```rc-schedule-ops
{"ops":[...]}
```

The host runtime consumes `rc-schedule-ops` and persists the resulting job changes.

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
- `name`: optional job name or lookup key
- `query` or `contains`: optional fallback matcher when `job_id` is absent
- `schedule_type`: `once`, `every`, or `cron`
- `schedule_expr`: schedule expression for the selected schedule type
- `timezone`: optional IANA timezone; default to the host timezone when omitted
- `prompt` or `prompt_template`: job prompt
- `title` or `name`: optional display name for the job
- `role`: optional host-defined role string; treat it as plain metadata unless the host specifies more
- `memory_scope`: optional host-defined memory scope string
- `session_policy`: optional `resume-job` or `fresh`
- `enabled`: optional boolean when creating or updating a job

## Examples

User says: “每天早上 9 点检查 changxian-agent issue，并总结给我。”

```rc-schedule-ops
{"ops":[{"op":"create_job","schedule_type":"cron","schedule_expr":"0 9 * * *","timezone":"Asia/Shanghai","prompt":"check changxian-agent open issues and send a concise summary"}]}
```

User says: “把 job_123 改成每 6 小时执行一次。”

```rc-schedule-ops
{"ops":[{"op":"set_job","job_id":"job_123","schedule_type":"every","schedule_expr":"6h"}]}
```
