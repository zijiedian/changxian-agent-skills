# Pi ACP

Use this reference when the Telegram or WeCom bridge should drive `pi-acp` instead of Codex, Claude, or OpenCode ACP.

## What Pi Is

- `pi-acp` is an ACP adapter for Pi.
- Install package: `pi-acp`
- Main executable: `pi-acp`

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
RC_PI_COMMAND_PREFIX="pi-acp"
RC_PI_TIMEOUT_SECONDS=21600
```

## Common Prefix Variants

- `pi-acp`
- `npx -y pi-acp`

## Authentication

Pi ACP relies on the underlying Pi environment and provider credentials configured on the host.

Typical host setup:

```bash
npm install -g pi-acp
pi-acp --help
```

Then either:

- export provider API keys before starting the bridge
- or authenticate through Pi in an interactive shell if the chosen provider supports Pi's login flow

## Notes

- Pi ACP does not use the Codex or Claude permission tier flags, so the bridge treats it as a managed backend similar to OpenCode ACP.
- Session handling is delegated to the ACP adapter and runtime.
- When backend switching is involved, mention the exact command prefix being used if the user cares about provider or model routing.
