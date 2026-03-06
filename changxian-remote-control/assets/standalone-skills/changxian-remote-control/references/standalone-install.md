# Standalone Install

`changxian-remote-control` includes a reference Telegram bridge runtime plus bundled companion skills so the skill can be installed and used on its own.

## Included Resources

- `assets/reference-telegram-bridge/` - standalone bridge runtime copied from the current changxian-agent bridge
- `assets/standalone-skills/` - vendored copies of:
  - `changxian-memory-manager`
  - `changxian-role-manager`
  - `changxian-remote-control`
- `scripts/install_reference_telegram_bridge.py` - installs the standalone bridge into a target directory

## Install

```bash
python scripts/install_reference_telegram_bridge.py --path ~/changxian-telegram-bridge
```

## Result

The installer creates a target directory containing:

- the bridge runtime files
- a `changxian-agent-skills/` folder next to the bridge

This layout allows the copied bridge to run without depending on the original `tg-codex` repository.
