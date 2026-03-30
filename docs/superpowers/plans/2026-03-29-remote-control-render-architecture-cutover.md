# Remote Control Render Architecture Cutover Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the migrated render architecture the single source of truth for `changxian-remote-control` runtime rendering, while preserving current Telegram and WeCom behavior.

**Architecture:** Keep host-specific delivery state in adapter sinks, but move rendering ownership to `MessageTransformer`, `TelegramRenderer`, and `WeComRenderer`. ACP updates become normalized events, controller renders them through host renderers, and legacy render modules shrink into compatibility wrappers.

**Tech Stack:** Node.js ESM, grammy, @wecom/aibot-node-sdk, ACP SDK, Node built-in test runner

---

## File Structure

### New files

- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/tests/render-pipeline.test.mjs`

### Modified files

- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/acp-provider.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.wecom.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/index.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/base-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/telegram-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/wecom-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/message-transformer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.telegram.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.wecom.mjs`

### Verification commands

- `node --test ./tests/render-pipeline.test.mjs`
- `node --test ./tests/adapters.telegram.test.mjs`
- `node --test ./tests/render.telegram.test.mjs`
- `npm test`
- `node --no-warnings --experimental-strip-types ../../scripts/remote-control.ts status`
- `curl -fsS http://127.0.0.1:${RC_PORT:-18001}/healthz`

## Chunk 1: Make the new render architecture observable with tests

### Task 1: Add failing pipeline tests

**Files:**
- Create: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/tests/render-pipeline.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover:

- ACP session update to normalized event conversion
- `MessageTransformer` event to `OutgoingMessage`
- host renderer output for Telegram and WeCom
- legacy wrapper delegation to renderer-owned legacy methods

- [ ] **Step 2: Run the new test file and confirm failure**

Run: `node --test ./tests/render-pipeline.test.mjs`

Expected: FAIL because the event pipeline helpers / delegating wrappers are not complete yet.

## Chunk 2: Cut over rendering ownership into `src/render/`

### Task 2: Convert legacy renderer modules into thin wrappers

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.telegram.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.wecom.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/telegram-renderer.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/wecom-renderer.mjs`

- [ ] **Step 1: Export any renderer-owned helper APIs needed by compatibility callers**

- [ ] **Step 2: Replace duplicated legacy logic with renderer delegation**

Requirements:

- `renderTelegramPayload()` delegates to `TelegramRenderer`
- `renderWeComPayload()` delegates to `WeComRenderer`
- helper re-exports needed by adapters remain available

- [ ] **Step 3: Re-run the new pipeline tests**

Run: `node --test ./tests/render-pipeline.test.mjs`

Expected: PASS for wrapper delegation assertions.

### Task 3: Ensure render core remains valid and host-aware

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/index.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/base-renderer.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/message-transformer.mjs`

- [ ] **Step 1: Keep `render/index.mjs` as the single entrypoint for renderer construction**

- [ ] **Step 2: Ensure `BaseRenderer.render()` covers all outgoing message types used by remote-control**

- [ ] **Step 3: Keep `MessageTransformer` aligned with the events emitted by ACP provider**

- [ ] **Step 4: Re-run targeted tests**

Run: `node --test ./tests/render-pipeline.test.mjs`

Expected: PASS.

## Chunk 3: Switch the controller/provider main path to event rendering

### Task 4: Emit normalized events from the ACP provider

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/acp-provider.mjs`

- [ ] **Step 1: Add an event conversion helper for ACP session updates**

- [ ] **Step 2: Add an `onEvent` callback path to `runTask()`**

- [ ] **Step 3: Preserve existing final answer aggregation**

- [ ] **Step 4: Run the new pipeline tests and confirm the provider path is covered**

Run: `node --test ./tests/render-pipeline.test.mjs`

Expected: PASS.

### Task 5: Make the controller render progress through `MessageTransformer -> Renderer`

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`

- [ ] **Step 1: Add host renderer selection helpers**

- [ ] **Step 2: Render normalized progress events through the host renderer**

- [ ] **Step 3: Keep final rich preview delivery working through renderer-owned legacy rendering**

- [ ] **Step 4: Preserve scheduler and non-chat host behavior**

- [ ] **Step 5: Run controller and pipeline tests**

Run: `node --test ./tests/render-pipeline.test.mjs`

Expected: PASS.

## Chunk 4: Cut adapters over to the new rendered-event model

### Task 6: Update Telegram sinks to consume rendered-event progress and renderer-owned final output

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs`

- [ ] **Step 1: Teach progress handling to accept renderer-produced progress events**

- [ ] **Step 2: Keep draft text, pagination, and image sending behavior intact**

- [ ] **Step 3: Route channel publishing through renderer-owned legacy rendering, not duplicated legacy modules**

- [ ] **Step 4: Run Telegram regression tests**

Run: `node --test ./tests/adapters.telegram.test.mjs && node --test ./tests/render.telegram.test.mjs`

Expected: PASS.

### Task 7: Update WeCom sinks to consume rendered-event progress and renderer-owned final output

**Files:**
- Modify: `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.wecom.mjs`

- [ ] **Step 1: Teach WeCom progress path to consume rendered-event payloads**

- [ ] **Step 2: Keep stream fallback and final-page proactive delivery behavior intact**

- [ ] **Step 3: Run targeted WeCom and full test suite**

Run: `npm test`

Expected: Relevant render-path tests pass; report any unrelated existing failures separately.

## Chunk 5: Runtime verification

### Task 8: Restart and verify the live remote-control runtime

**Files:**
- Modify: none

- [ ] **Step 1: Restart the launchd-managed bridge**

Run: `launchctl kickstart -k gui/$(id -u)/com.changxian.remote-control.bridge`

- [ ] **Step 2: Verify status**

Run: `node --no-warnings --experimental-strip-types changxian-agent-skills/changxian-remote-control/scripts/remote-control.ts status`

Expected: `runtime: running`

- [ ] **Step 3: Verify health**

Run: `curl -fsS http://127.0.0.1:${RC_PORT:-18001}/healthz`

Expected: JSON with `ok: true` and `ready: true`
