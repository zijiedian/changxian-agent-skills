# reference-im-bridge

Unified JavaScript runtime for changxian remote-control.

- Telegram adapter: `grammy`
- WeCom adapter: `@wecom/aibot-node-sdk`
- Weixin adapter: `weixin-agent-sdk`
- Shared state: `better-sqlite3`
- Backend runtimes: Codex ACP, Claude Agent ACP, OpenCode ACP, and Pi ACP
- Shared auth, command registry, and host state store
- Durable memory, reusable roles, and scheduled jobs are managed inside `changxian-remote-control` via `rc-memory-ops`, `rc-role-ops`, and `rc-schedule-ops`
- When `RC_MEMORY_AUTO_SAVE=1`, recent dialogue is surfaced back into the prompt so the assistant can auto-capture durable memory and refine existing memories with `rc-memory-ops`

## Quick Start

```bash
cp .env.example .env
npm install
npm run start
```

Set credentials in `.env` before starting:

- `TG_BOT_TOKEN` to enable Telegram
- `RC_DEFAULT_BACKEND=claude` to make Claude Agent ACP the default backend
- `RC_CLAUDE_COMMAND_PREFIX=claude-agent-acp` to configure the Claude ACP adapter
- `RC_DEFAULT_BACKEND=pi` to make Pi ACP the default backend
- `RC_PI_COMMAND_PREFIX=pi-acp` to configure the Pi ACP adapter
- `RC_PI_TIMEOUT_SECONDS` to control Pi task timeout
- `RC_DEFAULT_BACKEND=opencode-acp` to make OpenCode ACP the default backend
- `OPENCODE_ACP_COMMAND_PREFIX=opencode acp` to run the OpenCode ACP backend
- `OPENCODE_ACP_TIMEOUT_SECONDS` to control ACP task timeout
- `CODEX_COMMAND_PREFIX=codex-acp` to run the Codex ACP adapter
- `TG_CHANNEL_TARGETS` to enable alias-based Telegram channel publishing
- `TG_DEFAULT_CHANNEL` to set the default publishing alias
- `TG_CHANNEL_ALLOWED_OPERATOR_IDS` to restrict who can publish
- `WECOM_BOT_ID` and `WECOM_BOT_SECRET` to enable WeCom
- `WEIXIN_ENABLED=1` and optional `WEIXIN_ACCOUNT_ID=<account>` to enable Weixin after running the SDK login flow
- `RC_AUTH_PASSPHRASE` to require authentication in chat before tasks can run
- `RC_MEMORY_AUTO_SAVE=1` to allow memory extraction from recent dialogue context, not only explicit `/memory add`

Only adapters with valid credentials are started.

## Claude Agent ACP

Claude Agent ACP can be used as the execution backend for Telegram, WeCom, or Weixin chats.

Recommended setup:

```bash
npm install -g @zed-industries/claude-agent-acp
claude auth login
```

Bridge config:

```bash
RC_DEFAULT_BACKEND=claude
RC_CLAUDE_COMMAND_PREFIX=claude-agent-acp
```

Per-chat switching:

- `/backend claude`
- `/backend codex`
- `/backend pi`
- `/backend opencode-acp`
- `/backend default`

## Pi ACP

Pi ACP can be used as the execution backend for Telegram, WeCom, or Weixin chats.

Recommended setup:

```bash
npm install -g pi-acp
pi-acp --help
```

Authenticate with your preferred provider through Pi itself, for example by exporting an API key or using Pi's `/login` flow in an interactive shell.

Bridge config:

```bash
RC_DEFAULT_BACKEND=pi
RC_PI_COMMAND_PREFIX=pi-acp
```

Per-chat switching:

- `/backend pi`
- `/backend codex`
- `/backend claude`
- `/backend opencode-acp`
- `/backend default`

## OpenCode ACP

OpenCode ACP can be used as the execution backend for Telegram, WeCom, or Weixin chats.

Recommended setup:

```bash
npm install -g opencode-ai
opencode auth login
```

Bridge config:

```bash
RC_DEFAULT_BACKEND=opencode-acp
OPENCODE_ACP_COMMAND_PREFIX=opencode acp
```

Per-chat switching:

- `/backend claude`
- `/backend opencode-acp`
- `/backend codex`
- `/backend default`

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

## Weixin

Weixin support is powered by `weixin-agent-sdk`.

Recommended setup:

```bash
npm install -g weixin-agent-sdk
```

Then log in once using the SDK's QR login flow and enable the adapter:

```bash
WEIXIN_ENABLED=1
WEIXIN_ACCOUNT_ID=<your-account-id>
```

## Runtime State

- Default state dir: `$CODEX_HOME/changxian-agent/remote-control` or `~/.codex/changxian-agent/remote-control`
- Health endpoint: `http://127.0.0.1:<RC_PORT>/healthz`
- Start command: `node ./src/index.mjs`
- Wrapper command: `node --experimental-strip-types ../scripts/remote-control.ts start`
