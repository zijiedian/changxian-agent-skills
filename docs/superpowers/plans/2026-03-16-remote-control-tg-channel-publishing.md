# Remote Control Telegram Channel Publishing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, reusable Telegram channel publishing capability to `changxian-remote-control` using preconfigured channel aliases and a `/channel` command surface.

**Architecture:** Extend runtime config with Telegram channel target parsing and optional operator allowlist, add a reusable channel-publisher helper, wire it into the Telegram adapter/controller, then document the new capability in the skill and runtime docs. Preview remains chat-local while send/test publish to configured Telegram channels. 

**Tech Stack:** Node.js ESM, grammy, dotenv, existing Telegram renderer, Node built-in test runner

---

## File Structure

### New files

- `changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs`
- `changxian-remote-control/assets/reference-im-bridge/tests/telegram-channel-publisher.test.mjs`

### Modified files

- `changxian-remote-control/SKILL.md`
- `changxian-remote-control/agents/openai.yaml`
- `changxian-remote-control/references/telegram-adapter-example.md`
- `changxian-remote-control/references/telegram-operations.md`
- `changxian-remote-control/assets/reference-im-bridge/.env.example`
- `changxian-remote-control/assets/reference-im-bridge/README.md`
- `changxian-remote-control/assets/reference-im-bridge/package.json`
- `changxian-remote-control/assets/reference-im-bridge/src/config.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/commands.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`
- `changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`

### Verification commands

- `npm test`
- `npm run check`
- `node --no-warnings --experimental-strip-types ../../scripts/remote-control.ts help`

## Chunk 1: Config parsing and publisher helper with TDD

### Task 1: Add failing tests for Telegram channel target parsing and publishing

**Files:**
- Create: `changxian-remote-control/assets/reference-im-bridge/tests/telegram-channel-publisher.test.mjs`
- Modify: `changxian-remote-control/assets/reference-im-bridge/package.json`

- [ ] **Step 1: Write failing tests**

Cover these cases:

- parse `TG_CHANNEL_TARGETS` JSON into alias map
- reject malformed target JSON
- resolve known alias
- reject unknown alias
- enforce optional operator allowlist
- preview does not call publish API
- send/test produce publish calls

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test`

Expected: FAIL because publisher helper and/or test script are missing.

- [ ] **Step 3: Add test script if missing**

Add to `package.json`:

```json
"test": "node --test ./tests/*.test.mjs"
```

- [ ] **Step 4: Implement minimal helper**

Create `src/telegram-channel-publisher.mjs` with:

- target parsing
- alias resolution
- allowlist check
- publish API
- preview summary helper

- [ ] **Step 5: Re-run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add changxian-remote-control/assets/reference-im-bridge/package.json \
  changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs \
  changxian-remote-control/assets/reference-im-bridge/tests/telegram-channel-publisher.test.mjs
git commit -m "feat: add telegram channel publisher helper"
```

## Chunk 2: Runtime config and command surface

### Task 2: Extend runtime config with Telegram channel settings

**Files:**
- Modify: `changxian-remote-control/assets/reference-im-bridge/src/config.mjs`
- Modify: `changxian-remote-control/assets/reference-im-bridge/.env.example`
- Modify: `changxian-remote-control/assets/reference-im-bridge/README.md`

- [ ] **Step 1: Add config fields**

Add:

- `tgChannelTargets`
- `tgDefaultChannel`
- `tgChannelAllowedOperatorIds`

- [ ] **Step 2: Update env example**

Document:

- `TG_CHANNEL_TARGETS`
- `TG_DEFAULT_CHANNEL`
- `TG_CHANNEL_ALLOWED_OPERATOR_IDS`

- [ ] **Step 3: Update runtime README**

Document:

- alias-based publishing
- preview vs send
- channel prerequisites

- [ ] **Step 4: Verify runtime syntax**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add changxian-remote-control/assets/reference-im-bridge/src/config.mjs \
  changxian-remote-control/assets/reference-im-bridge/.env.example \
  changxian-remote-control/assets/reference-im-bridge/README.md
git commit -m "feat: add telegram channel publishing config"
```

### Task 3: Add `/channel` command family

**Files:**
- Modify: `changxian-remote-control/assets/reference-im-bridge/src/commands.mjs`
- Modify: `changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`

- [ ] **Step 1: Add command spec**

Add `/channel` to:

- `COMMAND_SPECS`
- help lines
- Telegram menu sync path

- [ ] **Step 2: Implement command handling**

In controller, add:

- `/channel`
- `/channel list`
- `/channel preview <alias> | <content>`
- `/channel send <alias> | <content>`
- `/channel test <alias>`

- [ ] **Step 3: Keep behavior explicit**

Requirements:

- unknown alias -> explicit error
- missing `|` -> usage error
- preview -> no publish
- send/test -> publish through helper

- [ ] **Step 4: Re-run tests**

Run: `npm test && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add changxian-remote-control/assets/reference-im-bridge/src/commands.mjs \
  changxian-remote-control/assets/reference-im-bridge/src/controller.mjs
git commit -m "feat: add channel publishing commands"
```

## Chunk 3: Telegram adapter integration

### Task 4: Attach the channel publisher to the Telegram adapter/runtime

**Files:**
- Modify: `changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`
- Modify: `changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`

- [ ] **Step 1: Create Telegram-side publish implementation**

Requirements:

- use `bot.api.sendMessage`
- support sequential multi-page publish
- support image sends from rendered payload
- do not use progress-edit loops

- [ ] **Step 2: Register publisher with controller**

The controller should be able to invoke publishing regardless of whether the command came from Telegram chat or another host, as long as Telegram is configured.

- [ ] **Step 3: Keep chat reply flow unchanged**

Do not break:

- normal Telegram task messages
- push sinks
- pagination callbacks

- [ ] **Step 4: Verify runtime syntax**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs \
  changxian-remote-control/assets/reference-im-bridge/src/controller.mjs
git commit -m "feat: integrate telegram channel publishing into runtime"
```

## Chunk 4: Skill docs and references

### Task 5: Update the skill metadata and references

**Files:**
- Modify: `changxian-remote-control/SKILL.md`
- Modify: `changxian-remote-control/agents/openai.yaml`
- Modify: `changxian-remote-control/references/telegram-adapter-example.md`
- Modify: `changxian-remote-control/references/telegram-operations.md`

- [ ] **Step 1: Update skill trigger description**

Mention that the skill also applies when the user wants to publish or preview content for preconfigured Telegram channels.

- [ ] **Step 2: Update skill body**

Add guidance for:

- checking configured aliases
- preview before send
- channel-safe publishing assumptions

- [ ] **Step 3: Update UI metadata**

Ensure `agents/openai.yaml` still matches the updated skill scope.

- [ ] **Step 4: Update Telegram references**

Document:

- channel commands
- alias-based publishing
- preview vs send

- [ ] **Step 5: Commit**

```bash
git add changxian-remote-control/SKILL.md \
  changxian-remote-control/agents/openai.yaml \
  changxian-remote-control/references/telegram-adapter-example.md \
  changxian-remote-control/references/telegram-operations.md
git commit -m "docs: document telegram channel publishing"
```

## Chunk 5: Final verification

### Task 6: Fresh verification

**Files:**
- Review: all modified runtime and skill files

- [ ] **Step 1: Run runtime tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run runtime syntax check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Verify launcher help still works**

Run: `node --no-warnings --experimental-strip-types ../../scripts/remote-control.ts help`

Expected: HELP output renders, no module or syntax errors.

- [ ] **Step 4: Verify changed files**

Run: `git status --short`

Expected: only intended files changed.

- [ ] **Step 5: Commit final cleanups if needed**

```bash
git add changxian-remote-control
git commit -m "feat: complete telegram channel publishing support"
```

Plan complete and saved to `docs/superpowers/plans/2026-03-16-remote-control-tg-channel-publishing.md`. Ready to execute?
