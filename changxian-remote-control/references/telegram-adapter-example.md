# Telegram Adapter Example

## Why This Exists

This is an example adapter profile for Telegram-style chat bridges. It is not required by `changxian-remote-control`, but it shows how a concrete host may expose the generic host-bridge contract.

## Example Capabilities

A Telegram bridge may expose controls such as:

- plain-text messages to submit tasks
- image messages as media input
- status commands
- cancel commands
- session reset commands
- workdir commands
- runtime setting commands
- scheduled-job commands

## Example Command Surface

One Telegram adapter may choose commands like:

- `/status`
- `/cancel`
- `/new`
- `/cwd <path>`
- `/cmd ...`
- `/setting ...`
- skill-driven `rc-schedule-ops` blocks via `changxian-remote-control`

These names are only examples. Another bridge may expose different command names or button-based controls.

## Practical Guidance

When a Telegram adapter is active:

- keep progress updates compact
- avoid oversized responses when frequent edits are expected
- make scheduled prompts explicit because the user may trigger them long after the original chat turn
