import test from 'node:test';
import assert from 'node:assert/strict';

import { eventFromSessionUpdate } from '../src/agent/base.mjs';
import { createMessageTransformer, createRenderer } from '../src/render/index.mjs';
import { renderTelegramPayload } from '../src/render/index.mjs';
import { renderWeComPayload } from '../src/render/index.mjs';

test('eventFromSessionUpdate converts tool_call updates into normalized agent events', () => {
  const event = eventFromSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'bash',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'ls -la' },
    content: [{ content: { text: 'listing files' } }],
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.kind, 'execute');
  assert.equal(event.status, 'in_progress');
  assert.equal(event.rawInput.command, 'ls -la');
});

test('telegram pipeline renders ACP mode updates through message transformer and renderer', () => {
  const event = eventFromSessionUpdate({
    sessionUpdate: 'current_mode_update',
    modeId: 'review',
    mode: { name: 'Review' },
  });
  const transformer = createMessageTransformer();
  const renderer = createRenderer('telegram');

  const outgoing = transformer.transform(event);
  const rendered = renderer.render(outgoing, 'medium');

  assert.equal(outgoing.type, 'mode_change');
  assert.equal(rendered.format, 'html');
  assert.match(rendered.body, /Mode/i);
  assert.match(rendered.body, /review|Review/);
});

test('wecom pipeline renders model updates through message transformer and renderer', () => {
  const transformer = createMessageTransformer();
  const renderer = createRenderer('wecom');

  const outgoing = transformer.transform({
    type: 'model_update',
    modelId: 'gpt-5.4',
  });
  const rendered = renderer.render(outgoing, 'medium');

  assert.equal(outgoing.type, 'model_update');
  assert.equal(rendered.format, 'plain');
  assert.match(rendered.body, /Model/);
  assert.match(rendered.body, /gpt-5\.4/);
});

test('legacy telegram wrapper delegates to renderer-owned legacy rendering', () => {
  const payload = {
    status: 'Done',
    marker: 'assistant',
    text: '最终结果',
    preview: {
      summary: '最终结果',
      content: '最终结果',
      proseMarkdown: '最终结果',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 3,
  };

  const renderer = createRenderer('telegram');
  const wrapped = renderTelegramPayload(payload);
  const direct = renderer.renderLegacyPayload(payload);

  assert.deepEqual(wrapped, direct);
});

test('legacy wecom wrapper delegates to renderer-owned legacy rendering', () => {
  const payload = {
    status: 'Done',
    marker: 'assistant',
    text: '完成',
    preview: {
      summary: '完成',
      content: '完成',
      proseMarkdown: '完成',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 2,
  };

  const renderer = createRenderer('wecom');
  const wrapped = renderWeComPayload(payload);
  const direct = renderer.renderLegacyPayload(payload);

  assert.deepEqual(wrapped, direct);
});
