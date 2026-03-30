# Changxian Remote Control Render Architecture Cutover Design

## Background

`changxian-remote-control` already contains the main pieces of the migrated rendering architecture:

- `src/render/base-renderer.mjs`
- `src/render/telegram-renderer.mjs`
- `src/render/wecom-renderer.mjs`
- `src/render/message-transformer.mjs`
- `src/render/index.mjs`

But the runtime is still primarily driven by the legacy payload renderers:

- `src/render.telegram.mjs`
- `src/render.wecom.mjs`

The controller constructs `renderers` and `messageTransformer`, but the active runtime path does not use them as the primary pipeline. ACP progress still flows through legacy payload builders, while adapters and channel publishers still call the old renderer entrypoints directly.

This leaves the runtime in a split-brain state:

1. new architecture files exist
2. old renderer entrypoints still own the real behavior
3. duplicated Telegram and WeCom rendering logic can drift

## Goal

Make the migrated render architecture the single source of truth for remote-control runtime rendering.

Concretely:

1. the main progress path should use `MessageTransformer -> Renderer`
2. Telegram and WeCom adapters should consume the new render pipeline as the primary path
3. legacy `render.telegram.mjs` and `render.wecom.mjs` should become thin compatibility wrappers
4. the runtime should preserve current remote-control behavior: draft streaming, pagination, image delivery, permission prompts, channel publishing, and `/healthz` startup behavior

## Non-Goals

1. Do not rewrite ACP transport or backend provider selection.
2. Do not redesign Telegram or WeCom UX copy.
3. Do not refactor scheduler semantics beyond the render-path cutover.
4. Do not introduce OpenACP's full adapter base-class hierarchy into remote-control if it does not materially improve this runtime.

## Current Gap

### OpenACP target pattern

The OpenACP architecture is:

`AgentEvent -> MessageTransformer -> OutgoingMessage -> Adapter delivery using renderer`

### Current remote-control pattern

The current remote-control runtime is:

`ACP session update -> legacy payload builder -> adapter sink -> legacy payload renderer`

This means the migrated classes are mostly structural copies, not the live rendering path.

## Recommended Approach

Use a two-layer cutover:

### 1. Promote the new render modules to the primary implementation

- `src/render/telegram-renderer.mjs` owns Telegram rendering behavior
- `src/render/wecom-renderer.mjs` owns WeCom rendering behavior
- `src/render/message-transformer.mjs` owns event-to-message conversion

Legacy files stay only as wrappers.

### 2. Add a bridge-specific event rendering layer

Remote-control still has host-specific concerns that OpenACP core does not own:

- Telegram draft streaming
- paginated final output
- local image extraction and send
- WeCom stream fallback rules

So the cutover should not force raw OpenACP handlers directly onto this runtime. Instead, the runtime should:

1. convert ACP updates into `AgentEvent`
2. transform them into `OutgoingMessage`
3. render them with the host renderer
4. pass adapter sinks a normalized rendered event model

For final rich previews, the runtime may continue to use a host renderer's legacy-compatible final rendering method, but that logic must live inside the new renderer classes, not in duplicated legacy modules.

## Runtime Design

### ACP provider

The ACP provider should expose an event-oriented callback in addition to the current final-output aggregation.

It should:

- convert raw ACP session updates into normalized `AgentEvent` values
- emit those events upward
- continue aggregating assistant text chunks for the final answer body

This keeps backend transport stable while allowing the controller to own rendering.

### Controller

The controller should become the place where:

- host renderer is selected
- `MessageTransformer` is invoked
- rendered event payloads are constructed for sinks

The controller already owns host selection and sink invocation, so this is the natural place to cut the main path over.

### Adapter sinks

Telegram and WeCom sinks should accept a normalized rendered event payload for progress updates.

Requirements:

- Telegram continues to use drafts, throttled edits, pagination, and image sends
- WeCom continues to use stream updates with proactive fallback
- permission prompts remain adapter-native because they include inline controls and host-specific interaction state

### Legacy wrappers

`render.telegram.mjs` and `render.wecom.mjs` should remain only for compatibility:

- import the new renderer class
- delegate to renderer methods
- re-export only the helper APIs that existing callers still need during transition

No duplicated rendering logic should remain in those files after the cutover.

## Files Expected to Change

### Runtime

- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/acp-provider.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/controller.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.telegram.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/adapters.wecom.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/telegram-channel-publisher.mjs`

### Render architecture

- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/index.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/base-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/telegram-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/wecom-renderer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render/message-transformer.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.telegram.mjs`
- `changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge/src/render.wecom.mjs`

### Tests

- new render pipeline tests under `assets/reference-im-bridge/tests/`
- adapter regression tests updated where progress/final input shape changes

## Testing Strategy

Minimum verification must include:

1. failing tests for event-to-render pipeline
2. failing tests for legacy wrapper delegation
3. Telegram adapter regression tests
4. WeCom adapter regression tests for final/progress rendering
5. runtime test suite for the reference bridge package
6. remote-control restart and `/healthz` verification after cutover

## Risks

### Behavior regression risk

The largest risk is losing remote-control-specific UX:

- multiline tool progress
- assistant chunk drafting behavior
- final pagination
- images embedded in final output

This is why the migration should keep host-specific delivery behavior in sinks and move only rendering ownership, not all UI state.

### Partial cutover risk

If some callers still import old modules directly and those modules keep their own logic, the duplication problem remains.

The cutover is only complete when the old modules become wrappers and the live runtime path is sourced from `src/render/`.

## Success Criteria

The migration is complete when:

1. active progress rendering flows through `MessageTransformer` and the host renderer
2. final rich rendering is owned by the new renderer classes
3. legacy render modules are thin wrappers only
4. targeted tests cover the new path
5. remote-control starts cleanly and `/healthz` returns `ok=true ready=true`
