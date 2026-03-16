# OpenCode ACP Backend

Use this reference when the Telegram or WeCom bridge should drive OpenCode through ACP instead of the Codex SDK backend.

## What Changed

- The bridge can now switch between `codex` and `opencode-acp`.
- `opencode-acp` runs `opencode acp` (or any compatible ACP command prefix) as a child process and talks to it through ACP over stdio.
- Chat session resume works through `session/resume` and requires the current working directory.

## Required Setup

Preferred:

```bash
npm install -g opencode-ai
opencode auth login
```

Fallback without global install:

```bash
OPENCODE_ACP_COMMAND_PREFIX='npx -y opencode-ai acp'
```

Recommended bridge `.env`:

```env
RC_DEFAULT_BACKEND=opencode-acp
OPENCODE_ACP_COMMAND_PREFIX=opencode acp
OPENCODE_ACP_TIMEOUT_SECONDS=21600
```

## Runtime Commands

- `/backend` shows the current backend and command prefix
- `/backend opencode-acp` switches the current chat to OpenCode ACP
- `/backend codex` switches the current chat back to Codex SDK
- `/backend default` clears the per-chat override and falls back to `RC_DEFAULT_BACKEND`
- `/cmd <prefix>` overrides the command prefix for the current chat, so it can target:
  - `opencode acp`
  - `opencode -m openai/gpt-5.2 acp`
  - `npx -y opencode-ai acp`

## Behavior Notes

- OpenCode ACP supports image prompts, so Telegram image uploads can be forwarded as ACP `image` content blocks.
- Telegram chats now show ACP permission options as inline buttons. The bridge waits for the operator to tap a button before replying to OpenCode.
- Session resume is best-effort. If OpenCode reports that the stored session no longer exists, the bridge creates a fresh session for that chat.
- The bridge uses local file read/write ACP capabilities backed by the host filesystem.

## Operational Checks

Use these when diagnosing startup issues:

```bash
opencode acp --help
opencode auth login
```

If `opencode acp` is unavailable, check the global install or switch the bridge prefix to the `npx` fallback.
