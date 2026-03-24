# Standalone Install

`changxian-remote-control` is the single bundled skill for the bridge runtime and its persistent state.

## Included Resources

- `assets/reference-im-bridge/` - unified JavaScript runtime for Telegram and WeCom
- `changxian-remote-control/` - skill metadata, references, launcher script, and bundled runtime

## Run In Place

If you are working inside this repository already, run the bundled runtime directly:

```bash
cd changxian-remote-control/assets/reference-im-bridge
cp .env.example .env
npm install
cd ../..
npm run start
```

Fill in `.env` before starting:

- `TG_BOT_TOKEN` to enable Telegram
- `WECOM_BOT_ID` and `WECOM_BOT_SECRET` to enable WeCom
- `RC_AUTH_PASSPHRASE` to require chat authentication before use
- optional runtime settings such as `RC_DEFAULT_WORKDIR`, `RC_STATE_DIR`, and `RC_PORT`

Only the adapters with valid credentials are started.

## Copy As A Standalone Bundle

macOS / Linux:

```bash
SKILLS_ROOT=/path/to/changxian-agent-skills
mkdir -p ~/changxian-im-bridge ~/changxian-im-bridge/changxian-agent-skills
cp -R "$SKILLS_ROOT/changxian-remote-control/assets/reference-im-bridge/." ~/changxian-im-bridge/
cp -R "$SKILLS_ROOT/changxian-remote-control" ~/changxian-im-bridge/changxian-agent-skills/
cd ~/changxian-im-bridge
cp .env.example .env
npm install
npm run start
```

Windows (PowerShell):

```powershell
$skillsRoot = 'C:\path\to\changxian-agent-skills'
$bridgeDir = Join-Path $HOME 'changxian-im-bridge'
$skillsDir = Join-Path $bridgeDir 'changxian-agent-skills'
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
Copy-Item (Join-Path $skillsRoot 'changxian-remote-control\assets\reference-im-bridge\*') $bridgeDir -Recurse -Force
Copy-Item (Join-Path $skillsRoot 'changxian-remote-control') $skillsDir -Recurse -Force
Set-Location $bridgeDir
Copy-Item .env.example .env
npm install
npm run start
```

## State And Health

- Default state dir: `$CODEX_HOME/changxian-agent/remote-control` or `~/.codex/changxian-agent/remote-control`
- Health endpoint: `http://127.0.0.1:<RC_PORT>/healthz`
- The bridge runtime stores host bindings, durable memory, reusable roles, and scheduled jobs in the same state directory.

## Notes

- Keep `assets/reference-im-bridge/node_modules/` out of git; install dependencies locally with `npm install`.
- The legacy Telegram and WeCom Python bridge assets and installer scripts are intentionally removed.
