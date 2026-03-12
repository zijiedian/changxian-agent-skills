---
name: changxian-remote-control
description: Operate changxian-agent through Telegram, WeCom, chat bots, webhooks, remote UI, or scheduled runtime. Use when the user asks to enable remote control, start or restart the Telegram/WeCom bridge, check remote runtime health, inspect bridge status, change remote workdir/runtime settings, or run tasks through a remote host instead of the local terminal. Also trigger for Chinese requests such as “开启远控”, “启动 Telegram 机器人”, “重启桥接”, “查看远控状态”, “检查 healthz”, or “远程处理这个项目”.
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

## Quick Start

- When the request is about enabling or restoring remote control, first identify the active host and the runtime directory before changing anything.
- Check the current bridge process and `/healthz` before and after a start or restart.
- Prefer the bundled JavaScript runtime in `assets/reference-im-bridge/` unless the host explicitly uses another deployment.
- Treat runtime config, state dir, PID, and health endpoint as the minimum facts to report back after startup work.

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
- `references/wecom-adapter-example.md` for one WeCom intelligent robot profile.
- `references/standalone-install.md` for the JavaScript standalone runtime layout and startup flow.

## Bundled Runtime

- The bundled runtime lives in `assets/reference-im-bridge/`.
- It is a unified JavaScript bridge for Telegram and WeCom with shared auth, memory, role, and schedule state.
- Prefer running this runtime directly or copying it as a standalone bundle. The legacy Python bridge assets have been removed.

## Example Requests

- “开启远控，帮我把 Telegram 桥接跑起来。”
- “重启远控桥接，顺手检查 healthz。”
- “查看远控状态，看看机器人是不是还在线。”
- “把这个项目接到企微里远程处理。”
- “以后默认在这个目录下远程处理这个项目。”
- “我给你发一张截图，你帮我远程定位问题。”
- “把接下来的执行过程用适合手机阅读的短进度更新返回给我。”
