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
- `TG_CHANNEL_TARGETS` to enable alias-based Telegram channel publishing
- `TG_DEFAULT_CHANNEL` to set the default publishing alias
- `TG_CHANNEL_ALLOWED_OPERATOR_IDS` to restrict who can publish
- `WECOM_BOT_ID` and `WECOM_BOT_SECRET` to enable WeCom
- `RC_AUTH_PASSPHRASE` to require authentication in chat before tasks can run

Only adapters with valid credentials are started.

## Telegram Channel Publishing

The Telegram runtime can publish to preconfigured Telegram channels by alias.

Example:

```bash
TG_CHANNEL_TARGETS='{"daily":"@my_daily_channel","news":"-1001234567890"}'
TG_DEFAULT_CHANNEL=daily
TG_CHANNEL_ALLOWED_OPERATOR_IDS=123456789
```

Then use channel commands through the bridge:

- `/channel list`
- `/channel preview daily | 今日 AI 热点摘要`
- `/channel send daily | 今日 AI 热点摘要`
- `/channel test daily`

## Runtime State

- Default state dir: `$CODEX_HOME/changxian-agent/remote-control-js` or `~/.codex/changxian-agent/remote-control-js`
- Health endpoint: `http://127.0.0.1:<RC_PORT>/healthz`
- Start command: `node ./src/index.mjs`
- Wrapper command: `node --experimental-strip-types ../scripts/remote-control.ts start`
