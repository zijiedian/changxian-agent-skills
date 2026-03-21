# Pi Backend

Use this reference when the Telegram or WeCom bridge should drive [Pi CLI](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) instead of Codex, Claude, or OpenCode ACP.

## What Pi Is

- Pi is a coding agent CLI from `badlogic/pi-mono`.
- Install package: `@mariozechner/pi-coding-agent`
- Main executable: `pi`
- For bridge integration, prefer JSON event mode: `pi --mode json`

## Switching to Pi

Use the backend command in chat:

```text
/backend pi
```

To restore the default backend:

```text
/backend default
```

## Runtime Config

Recommended environment:

```bash
RC_DEFAULT_BACKEND=pi
RC_PI_COMMAND_PREFIX="pi --mode json"
RC_PI_TIMEOUT_SECONDS=21600
```

If `pi` is not on `PATH`:

```bash
RC_PI_EXECUTABLE=/absolute/path/to/pi
```

## Common Prefix Variants

- `pi --mode json`
- `pi --mode json --provider anthropic --model sonnet`
- `pi --mode json --model openai/gpt-4o`

## Authentication

Pi can use provider API keys directly from environment variables, or an existing Pi login/session on the host.

Typical host setup:

```bash
npm install -g @mariozechner/pi-coding-agent
pi --version
```

Then either:

- export provider API keys before starting the bridge
- or authenticate through Pi in an interactive shell if the chosen provider supports Pi's login flow

## Notes

- Pi does not use the Codex or Claude permission tier flags, so the bridge treats it as a managed backend similar to OpenCode ACP.
- The bridge runs Pi in JSON mode and keeps Pi sessions in a bridge-owned session directory under the runtime state dir.
- When backend switching is involved, mention the exact command prefix being used if the user cares about provider or model routing.
