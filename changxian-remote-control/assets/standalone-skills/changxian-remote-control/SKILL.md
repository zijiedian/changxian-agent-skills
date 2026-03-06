---
name: changxian-remote-control
description: Operate changxian-agent through a remote host bridge. Use when the task runs in chat, a bot, a remote UI, or a scheduled automation surface that streams progress, accepts follow-up input, or triggers future jobs.
---

# Changxian Remote Control

## When To Use

Use this skill when changxian-agent is operating through a remote host instead of a local terminal, especially when the host provides one or more of these capabilities:

- message-based task submission
- incremental progress updates
- cancellation or reset controls
- media input such as images or files
- saved runtime settings
- scheduled or recurring execution

This skill is host-agnostic. It does not require a specific bridge implementation and can be adapted to chat-style, bot-style, or custom remote-control hosts.

## Core Model

Treat the host as a control surface with an adapter contract.

A host may provide:

- task submission
- progress streaming
- status inspection
- cancellation
- session reset
- working-directory changes
- runtime setting toggles
- permission-tier switching
- scheduled jobs
- media input

Do not assume every host supports every capability. Adapt to the active host contract.

## Operating Style

- Prefer concise, status-friendly responses because the host may have limited screen space.
- Surface assumptions that matter for remote execution.
- Favor incremental updates over long monologues when the host streams progress.
- Keep final handoff messages scannable and action-oriented.
- If the host exposes scheduling, suggest it for repeated or delayed work.

## Scheduling Guidance

If the active host exposes scheduled execution:

- make scheduled prompts self-contained
- include the intended role or memory expectations when they matter later
- distinguish one-time follow-up work from recurring automation
- prefer stable, deterministic instructions for recurring jobs

## Cooperation With Other Skills

When the host also supports durable state:

- use `changxian-memory-manager` for long-term preferences and facts
- use `changxian-role-manager` for reusable working modes and personas

Do not duplicate those responsibilities here. Coordinate with them.

## Host Adaptation Rules

- Read the current host contract before assuming command names or control flows.
- If a host-specific reference is available, prefer it over generic assumptions.
- If only the generic contract is available, talk in terms of capabilities rather than exact commands.

## References

- `references/host-bridge-contract.md` defines the generic host capabilities this skill expects.
- `references/telegram-adapter-example.md` shows one concrete adapter profile built on Telegram-style controls.

## Standalone Bundle

This skill also includes a standalone reference Telegram bridge runtime plus vendored companion skills, so installing `changxian-remote-control` alone is enough to deploy a working bridge.

Use:

- `scripts/install_reference_telegram_bridge.py` to install the bundled runtime
- `references/standalone-install.md` for the standalone layout and usage

The bundled standalone package includes:

- the bridge runtime copied from the current changxian-agent bridge
- vendored copies of `changxian-memory-manager`, `changxian-role-manager`, and `changxian-remote-control`

## Examples

- “每天早上 9 点帮我做一次健康检查，如果失败就给我摘要”
- “以后默认在某个工作目录下远程处理这个项目” 
- “创建一个 reviewer 角色，今后远程审查都优先用它”
- “我给你发截图，你帮我远程定位问题”
