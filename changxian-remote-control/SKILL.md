---
name: changxian-remote-control
description: Operate changxian-agent remotely over Telegram through tg-codex. Use when the task is meant to be executed interactively in Telegram, needs remote status updates, or should be scheduled for later execution.
---

# Changxian Remote Control

## When To Use

Use this skill when the agent is being driven through tg-codex on Telegram, especially for:

- interactive back-and-forth execution over Telegram
- remote repository work where the user wants progress updates in chat
- image-assisted prompts sent from Telegram
- scheduled or recurring runs through the Telegram scheduler
- workflows that should also cooperate with `changxian-memory-manager` and `changxian-role-manager`

## Core Capabilities

### 1. Interactive Telegram Execution

Assume the user can send plain text directly to the bot to start a task.
Prefer short, incremental progress and concise final summaries because Telegram is the primary UI.

### 2. Session Controls

Remember the control surface available in tg-codex:

- `/start` shows help
- `/status` checks the current run
- `/cancel` stops the current run
- `/new` starts a fresh Codex session
- `/cwd` changes the working directory
- `/cmd` changes the Codex command prefix and permission tier
- `/setting` adjusts runtime toggles
- `/skill` lists installed skills

### 3. Role And Memory Cooperation

When the user expresses durable preferences or reusable working modes, rely on:

- `changxian-memory-manager` for long-term memory updates
- `changxian-role-manager` for reusable role definitions and activation

Do not duplicate their responsibilities in this skill. Instead, coordinate with them.

### 4. Scheduled Jobs

The Telegram bridge supports scheduled jobs. Use this when the user asks for:

- one-time future runs
- recurring jobs
- cron-like automation
- delayed follow-up checks

Keep scheduled prompts self-contained. Mention role and memory expectations if they matter for future execution.

## Operating Style

- Prefer concise status-friendly responses.
- Call out assumptions that matter for remote execution.
- If the user asks for repeated or delayed work, suggest using the scheduler.
- If the task benefits from durable preferences, suggest remembering them.
- If the task benefits from a reusable persona, suggest creating a role.

## Scheduler Cheatsheet

Reference `references/telegram-operations.md` for command examples and remote-operation guidance.

## Examples

- “每天早上 9 点帮我检查 changxian-agent 的 issue”
- “以后默认在 `/workspace/api` 下工作，然后帮我修这个 bug”
- “创建一个 reviewer 角色，以后用它审查 PR”
- “把这张截图发给你，你帮我定位问题”
