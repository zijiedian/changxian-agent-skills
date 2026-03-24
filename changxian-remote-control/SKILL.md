---
name: changxian-remote-control
description: "Operate changxian-agent through Telegram, WeCom, and related remote bridges, including runtime management, durable memory, reusable roles, scheduled jobs, Telegram channel publishing, and backend switching across Claude, Codex, OpenCode ACP, and Pi. Use for remote-control setup or status, backend or workdir changes, remote task execution, memory or role updates, schedule management, Telegram channel preview or publish, or when a turn includes `[MEMORY STATE]`, `[ROLE STATE]`, or `[SCHEDULE STATE]`."
---

# Changxian Remote Control

Use this skill for both remote-host bridge behavior and the persistent bridge state that lives behind it.

## Working Model

- Treat the host as a control surface with a concrete capability set.
- Read the current host contract before assuming command names or flows.
- Talk in terms of capabilities when the exact adapter commands are unknown.
- Separate immediate execution from persistent bridge state.

## Response Style

- Keep progress updates short and easy to scan.
- Surface assumptions that matter for remote execution.
- Prefer incremental updates over long monologues.
- Keep the final handoff action-oriented.
- When Telegram channel publishing is involved, distinguish clearly between preview and live publish.
- Do not tell the user to use `/run`; plain text input already executes normally unless it starts with a slash command.

## Quick Start

- When the request is about enabling or restoring remote control, first identify the active host and the runtime directory before changing anything.
- Check the current bridge process and `/healthz` before and after a start or restart.
- Prefer the bundled JavaScript runtime in `assets/reference-im-bridge/` unless the host explicitly uses another deployment.
- Treat runtime config, state dir, PID, and health endpoint as the minimum facts to report back after startup work.
- When the request is about publishing to Telegram channels, verify that channel aliases are configured before attempting to publish.
- When the request is about backend switching through Telegram or WeCom, confirm whether the bridge should use `claude`, `codex`, `opencode-acp`, or `pi`, then load the matching backend reference before changing config or backend selection.

## Persistent State

- Treat `[MEMORY STATE]`, `[ROLE STATE]`, and `[SCHEDULE STATE]` as the authoritative saved state for the current bridge scope.
- Keep durable memory for stable preferences, facts, and constraints. Do not save secrets or one-off task details.
- When recent dialogue clearly reveals a durable preference, stable project fact, owned resource, recurring constraint, default language/style choice, or long-lived operating habit, prefer saving or updating memory even if the user did not literally say “remember this”.
- When auto memory extraction is enabled, prefer updating an existing memory over creating a near-duplicate. Reuse the closest matching memory when the new turn obviously refines the same fact.
- Keep saved roles reusable and stable across turns. Use lowercase hyphenated role names.
- Keep schedules explicit and auditable. Prefer concrete `once`, `every`, or `cron` expressions.
- If the user asks to run a scheduled job right now, prefer `run_job` against the existing job instead of rewriting its schedule.
- If the user asks to "run now and keep the schedule", emit only `run_job` unless they also asked for another change.
- If the user asks to "rerun" or "补跑", treat it as immediate execution of an existing job unless they explicitly want a new one-time schedule.
- If the user only wants to inspect state, reply normally and do not emit an ops block.
- Briefly explain real state changes in user-facing prose.

## Scheduled Job Workflow

- Match immediate-execution requests such as "run now", "trigger this job", "立即执行", "现在跑一次", or "补跑昨天的任务" to `run_job`.
- Use `create_job` only when the user wants a new schedule, not when they want to fire an existing job immediately.
- Keep direct execution separate from schedule edits: do not pause, resume, or rewrite the job unless the user asked for that too.
- When `[SCHEDULE STATE]` is present, resolve the job by the saved id or the closest unambiguous name before emitting `run_job`.
- If the user names a job ambiguously, explain the ambiguity briefly instead of guessing which job to trigger.

## Output Protocol

When bridge-backed state should change, append exactly one fenced ops block for the changed state at the very end of the answer.

For memory specifically, this can happen in two modes:

- explicit mode: the user asked to remember, forget, pin, or update memory
- auto mode: the dialogue itself revealed a durable memory-worthy fact and saving it will improve future turns

Memory:

```rc-memory-ops
{"ops":[...]}
```

Supported ops: `upsert`, `delete`, `pin`, `unpin`

For `upsert`, prefer these target rules:

- use `memory_id` when the exact memory is already known
- otherwise use `query` or `contains` to target the closest existing memory and refine it
- if nothing matches, create a new memory

Role:

```rc-role-ops
{"ops":[...]}
```

Supported ops: `upsert_role`, `use_role`, `clear_role`, `delete_role`

Schedule:

```rc-schedule-ops
{"ops":[...]}
```

Supported ops: `create_job`, `set_job`, `pause_job`, `resume_job`, `run_job`, `delete_job`

Immediate run example:

```rc-schedule-ops
{"ops":[{"op":"run_job","job_id":"daily-health-check"}]}
```

## Host Rules

- Confirm which capabilities are actually available before using them.
- If the host supports workdir, permissions, or runtime toggles, name the setting being changed.
- If the host supports media input, explain briefly how the file or image affects the task.
- If the host supports scheduled execution, make scheduled prompts self-contained and deterministic.
- If a capability is absent, adapt the workflow instead of pretending it exists.
- For Telegram channel publishing, only use preconfigured aliases and never invent or guess raw channel ids.
- If the runtime exposes recent dialogue context, use it to decide whether a memory candidate is truly durable before emitting `rc-memory-ops`.
- If the user wants to inspect or control installed skills or MCP servers, use `/skill` and `/mcp` style workflows instead of treating them as generic text tasks.

## References

Resolve relative paths against this skill directory, not the current runtime workdir.

- `references/host-bridge-contract.md` for the generic host capability model.
- `references/telegram-adapter-example.md` for one Telegram-style adapter profile.
- `references/telegram-operations.md` for day-to-day Telegram operations including channel publishing.
- `references/memory-autosave.md` for the auto memory extraction rules, merge heuristics, and safe examples.
- `references/opencode-acp.md` for switching the bridge to OpenCode ACP and configuring the ACP command prefix.
- `references/pi-backend.md` for switching the bridge to Pi ACP and configuring the Pi command prefix.
- `references/claude-backend.md` for switching to Claude ACP backend and configuring the Claude command prefix.
- `references/wecom-adapter-example.md` for one WeCom intelligent robot profile.
- `references/standalone-install.md` for the JavaScript standalone runtime layout and startup flow.

## Bundled Runtime

- The bundled runtime lives in `assets/reference-im-bridge/`.
- It is a unified JavaScript bridge for Telegram and WeCom plus a shared state store that handles `rc-memory-ops`, `rc-role-ops`, and `rc-schedule-ops` inside the same skill.
- Prefer running this runtime directly or copying it as a standalone bundle. Do not split bridge state management into separate sibling skills.

## Standalone Script

- Use `scripts/remote-control.ts` as the standalone launcher for start, stop, restart, and health checks.
- Run it with `node --no-warnings --experimental-strip-types scripts/remote-control.ts help`.

## Example Requests

- “开启远控，帮我把 Telegram 桥接跑起来。”
- “重启远控桥接，顺手检查 healthz。”
- “查看远控状态，看看机器人是不是还在线。”
- “把这个项目接到企微里远程处理。”
- “把这段内容发到 Telegram 频道 daily。”
- “先预览频道消息，再发到 TG 频道。”
- “记住以后默认中文回答，并固定在这个桥接会话里。”
- “创建一个 reviewer 角色，以后默认用它。”
- “每天早上 9 点自动检查远控服务状态并总结给我。”
- “现在直接执行 daily-health-check 这个定时任务。”
- “把昨晚那条定时任务补跑一次，但别改原来的 cron。”
- “以后默认在这个目录下远程处理这个项目。”
- “我给你发一张截图，你帮我远程定位问题。”
- “把接下来的执行过程用适合手机阅读的短进度更新返回给我。”
- “切换到 Claude 后端。”
- “切回 Codex 后端。”
- “切到 Pi 后端。”
- “查看当前后端状态。”
