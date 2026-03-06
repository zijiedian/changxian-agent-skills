# Standalone Install

`changxian-remote-control` includes a reference Telegram bridge runtime plus bundled companion skills so the skill can be installed and used on its own.

## Included Resources

- `assets/reference-telegram-bridge/` - standalone bridge runtime copied from the current changxian-agent bridge
- `assets/standalone-skills/` - vendored copies of:
  - `changxian-memory-manager`
  - `changxian-role-manager`
  - `changxian-remote-control`
- `scripts/install_reference_telegram_bridge.py` - installs the standalone bridge into a target directory

## Fastest Path

macOS / Linux:

```bash
python3 scripts/install_reference_telegram_bridge.py --path ~/changxian-telegram-bridge --token <TG_BOT_TOKEN> --run
```

Windows（PowerShell）：

```powershell
py .\scripts\install_reference_telegram_bridge.py --path $HOME\changxian-telegram-bridge --token <TG_BOT_TOKEN> --run
```

This will:

- copy the bridge runtime and bundled skills
- create `.env` from the template
- prefill `TG_BOT_TOKEN` when provided
- start via `start.py`, which reuses an existing binary or falls back to Python mode
- persist memory/role/session state under `$CODEX_HOME/changxian-agent/remote-control` (or `~/.codex/changxian-agent/remote-control`)

## Manual Start After Install

- macOS / Linux: `./start.sh --token <TG_BOT_TOKEN> --port 18000`
- Windows（PowerShell）: `.\start.ps1 -Token <TG_BOT_TOKEN> -Port 18000`
- Windows（cmd）: `start.cmd --token <TG_BOT_TOKEN> --port 18000`
- Cross-platform: `python start.py --token <TG_BOT_TOKEN> --port 18000`

## Result

The installer creates a target directory containing:

- the bridge runtime files
- a `changxian-agent-skills/` folder next to the bridge

This layout allows the copied bridge to run without depending on the original remote-control repository.
