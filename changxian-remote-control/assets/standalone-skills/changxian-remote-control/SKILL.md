---
name: changxian-remote-control
description: Operate changxian-agent from a remote host or bridge such as chat, bot, webhook, remote UI, or scheduled runtime. Use when work runs outside a local terminal and the host may support task submission, streaming progress, cancellation, session reset, media input, workdir changes, runtime toggles, or scheduled execution.
---

# Changxian Remote Control

Use this skill only for remote-host behavior. Do not manage durable memory, reusable roles, or schedule state here unless the active host explicitly asks for those host-side actions.

## Working Model

- Treat the host as a control surface with a concrete capability set.
- Read the current host contract before assuming command names or flows.
- Talk in terms of capabilities when the exact adapter commands are unknown.
- Separate immediate actions from persistent host settings.

## Response Style

- Keep progress updates short and easy to scan.
- Surface assumptions that matter for remote execution.
- Prefer incremental updates over long monologues.
- Keep the final handoff action-oriented.

## Host Rules

- Confirm which capabilities are actually available before using them.
- If the host supports workdir, permissions, or runtime toggles, name the setting being changed.
- If the host supports media input, explain briefly how the file or image affects the task.
- If the host supports scheduled execution, make scheduled prompts self-contained and deterministic.
- If a capability is absent, adapt the workflow instead of pretending it exists.

## References

Resolve relative paths against this skill directory, not the current runtime workdir.

- `references/host-bridge-contract.md` for the generic host capability model.
- `references/telegram-adapter-example.md` for one Telegram-style adapter profile.
- `references/standalone-install.md` for standalone installation details.

## Standalone Runtime

Use `scripts/install_reference_telegram_bridge.py` to install the bundled reference Telegram bridge runtime when a standalone deployment is needed.

## Example Requests

- “以后默认在这个目录下远程处理这个项目。”
- “我给你发一张截图，你帮我远程定位问题。”
- “把接下来的执行过程用适合手机阅读的短进度更新返回给我。”
