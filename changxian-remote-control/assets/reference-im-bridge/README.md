# reference-im-bridge

Unified JavaScript runtime for changxian remote-control.

- Telegram adapter: `grammy`
- WeCom adapter: `@wecom/aibot-node-sdk`
- Shared state: `better-sqlite3`
- Shared auth, command registry, and host state store
- Durable memory, reusable roles, and scheduled jobs are managed inside `changxian-remote-control` via `rc-memory-ops`, `rc-role-ops`, and `rc-schedule-ops`

## Quick Start

```bash
cp .env.example .env
npm install
npm run start
```

Set credentials in `.env` before starting:

- `TG_BOT_TOKEN` to enable Telegram
- `WECOM_BOT_ID` and `WECOM_BOT_SECRET` to enable WeCom
- `RC_AUTH_PASSPHRASE` to require authentication in chat before tasks can run

Only adapters with valid credentials are started.

## Runtime State

- Default state dir: `$CODEX_HOME/changxian-agent/remote-control-js` or `~/.codex/changxian-agent/remote-control-js`
- Health endpoint: `http://127.0.0.1:<RC_PORT>/healthz`
- Start command: `node ./src/index.mjs`
- Wrapper command: `node --experimental-strip-types ../scripts/remote-control.ts start`
