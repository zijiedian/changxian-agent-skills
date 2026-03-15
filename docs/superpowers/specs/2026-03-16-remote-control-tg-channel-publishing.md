# Changxian Remote Control Telegram Channel Publishing Design

## Background

`changxian-remote-control` already has a working Telegram adapter for chat-based task execution and push delivery, but it does not yet provide an explicit capability for publishing content into Telegram channels.

The current runtime can:

- receive Telegram chat messages
- reply with paginated task output
- push scheduled-task results back to Telegram chats

What is missing is a stable, reusable publishing layer for channel operations. Without that layer, later “bot-driven channel automation” would force channel delivery logic to be reimplemented ad hoc inside commands, schedules, or task code.

The user wants a first version that supports publishing to Telegram channels safely, without allowing arbitrary runtime targets.

## Goal

Add a reusable Telegram channel publishing capability to `changxian-remote-control` so the bridge can send text and image-bearing Telegram payloads to preconfigured Telegram channels by alias.

This first version should make it practical to automate channel operations later, without building a full editorial workflow today.

## Non-Goals

1. Do not support arbitrary runtime-provided channel ids or usernames.
2. Do not implement approval workflows, editorial review, or publishing queues.
3. Do not implement automatic content fetching or auto-posting logic.
4. Do not build a general social-media publishing system across multiple platforms.

## Recommended Approach

Use:

**Preconfigured Telegram channel targets + reusable channel publisher + command surface**

This is preferred over a one-off `/channel send` shortcut because it creates a durable publishing capability that other runtime features can reuse later.

## Capability Model

The runtime should expose a reusable `telegram channel publisher` abstraction with these responsibilities:

1. Resolve channel aliases to Telegram targets
2. Validate whether the alias is configured
3. Render outgoing payloads through the existing Telegram renderer
4. Send one or more Telegram channel messages using Bot API
5. Return a concise publish result summary

This capability is distinct from:

- chat replies
- progress updates
- scheduled chat push sinks

## Configuration

First version uses only preconfigured channels.

### Required env additions

- `TG_CHANNEL_TARGETS`
- `TG_DEFAULT_CHANNEL` (optional)
- `TG_CHANNEL_ALLOWED_OPERATOR_IDS` (optional)

### Recommended format

`TG_CHANNEL_TARGETS` should be JSON:

```env
TG_CHANNEL_TARGETS={"daily":"@my_daily_channel","news":"-1001234567890"}
TG_DEFAULT_CHANNEL=daily
TG_CHANNEL_ALLOWED_OPERATOR_IDS=123456789,987654321
```

### Design rationale

- alias-based routing is safer than arbitrary target input
- aliases are easier for later automation prompts
- JSON keeps the config explicit and machine-readable

## Command Surface

Add a new `/channel` command family.

### Commands

- `/channel`
- `/channel list`
- `/channel preview <alias> | <content>`
- `/channel send <alias> | <content>`
- `/channel test <alias>`

### Behavior

#### `/channel`

Show configured publishing capability and usage:

- whether Telegram publishing is enabled
- default channel alias if configured
- number of configured aliases
- usage examples

#### `/channel list`

List configured aliases and their resolved Telegram targets, redacting nothing except when future secrets become relevant.

#### `/channel preview <alias> | <content>`

Do not publish to the channel.

Instead:

- render the content using the existing Telegram renderer
- show the first page in the current control chat
- summarize how many pages/images would be sent
- identify the resolved target alias

This keeps preview safe and useful for drafting.

#### `/channel send <alias> | <content>`

Publish the rendered content to the configured Telegram channel target.

#### `/channel test <alias>`

Send a short diagnostic message to verify that the bot has posting rights in the target channel.

## Input Format

Use `|` as the delimiter for `preview` and `send` commands:

- `/channel preview daily | 今日 AI 热点摘要`
- `/channel send daily | 今日 AI 热点摘要`

This avoids ambiguity with message bodies that contain spaces.

## Security Rules

First version should enforce:

1. Existing remote-control second-factor auth still applies
2. Publishing only works for configured aliases
3. Optional operator allowlist applies when `TG_CHANNEL_ALLOWED_OPERATOR_IDS` is configured

If allowlist is present and the current operator is not allowed, the runtime must refuse publish operations.

## Output Behavior

Channel publishing should not reuse the chat progress-editing flow.

### Chat replies

- can edit existing messages
- can paginate with buttons
- can emit progress

### Channel publishing

- final-only delivery
- no progress edits
- no pagination buttons
- if the rendered payload has multiple pages, send them sequentially
- if the payload includes images, send them sequentially as channel posts

This keeps channel posts stable and avoids awkward control UI in public channels.

## Integration Points

## Telegram adapter

The Telegram adapter already has the required Bot API access. It should expose or register a channel publisher capability, not merely a chat sink.

## Runtime controller

The controller should:

- own the `/channel` command logic
- call the reusable publisher
- remain host-agnostic so WeCom or future hosts can trigger Telegram channel publishing too, when allowed

## Scheduler compatibility

This design should leave room for a future second phase where scheduled jobs can deliver final output to:

- Telegram chats
- Telegram channels

That future phase is not part of this implementation, but the publisher API should be reusable enough to support it.

## Files Expected to Change

### Skill and docs

- `changxian-remote-control/SKILL.md`
- `changxian-remote-control/agents/openai.yaml`
- `changxian-remote-control/references/telegram-adapter-example.md`
- `changxian-remote-control/references/telegram-operations.md`
- `changxian-remote-control/assets/reference-im-bridge/.env.example`
- `changxian-remote-control/assets/reference-im-bridge/README.md`

### Runtime

- `changxian-remote-control/assets/reference-im-bridge/src/config.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/commands.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`

### New runtime helpers

Recommended additions:

- `changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs`
- tests under `changxian-remote-control/assets/reference-im-bridge/tests/`

## Testing Strategy

Minimum test coverage should include:

1. parse `TG_CHANNEL_TARGETS`
2. resolve channel alias
3. reject unknown alias
4. reject malformed `/channel send` input without `|`
5. verify allowlist enforcement
6. verify preview does not publish
7. verify send publishes through the publisher

## Acceptance Criteria

Implementation is complete when:

1. `/channel list`, `/channel preview`, `/channel send`, and `/channel test` work
2. runtime only publishes to preconfigured aliases
3. preview uses current chat, not the channel
4. final publish sends rendered Telegram payload to the configured channel
5. docs and env example describe the feature clearly
6. runtime tests pass
