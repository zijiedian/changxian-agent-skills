# Standalone Install

`changxian-remote-control` now ships a unified JavaScript bridge runtime plus bundled companion skills, so the remote-control stack can run without any Python runtime.

## Included Resources

- `assets/reference-im-bridge/` - unified JavaScript runtime for Telegram and WeCom
- `assets/standalone-skills/` - vendored copies of:
  - `changxian-memory-manager`
  - `changxian-role-manager`
  - `changxian-schedule`
  - `changxian-remote-control`

## Run In Place

If you are working inside this repository already, run the bundled runtime directly:

```bash
cd assets/reference-im-bridge
cp .env.example .env
npm install
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
mkdir -p ~/changxian-im-bridge ~/changxian-im-bridge/changxian-agent-skills
cp -R assets/reference-im-bridge/. ~/changxian-im-bridge/
cp -R assets/standalone-skills/. ~/changxian-im-bridge/changxian-agent-skills/
cd ~/changxian-im-bridge
cp .env.example .env
npm install
npm run start
```

Windows (PowerShell):

```powershell
$bridgeDir = Join-Path $HOME 'changxian-im-bridge'
$skillsDir = Join-Path $bridgeDir 'changxian-agent-skills'
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
Copy-Item assets/reference-im-bridge/* $bridgeDir -Recurse -Force
Copy-Item assets/standalone-skills/* $skillsDir -Recurse -Force
Set-Location $bridgeDir
Copy-Item .env.example .env
npm install
npm run start
```

## State And Health

- Default state dir: `$CODEX_HOME/changxian-agent/remote-control-js` or `~/.codex/changxian-agent/remote-control-js`
- Health endpoint: `http://127.0.0.1:<RC_PORT>/healthz`
- The scheduler, durable memory, roles, and host bindings are all stored in the same JavaScript runtime state directory.

## Notes

- Keep `assets/reference-im-bridge/node_modules/` out of git; install dependencies locally with `npm install`.
- The legacy Telegram and WeCom Python bridge assets and installer scripts are intentionally removed.
