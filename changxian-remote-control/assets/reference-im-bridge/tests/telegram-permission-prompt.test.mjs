import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPermissionPromptText,
  createTelegramPermissionRegistry,
  permissionOptionLabel,
} from '../src/adapters/telegram/permission-prompt.mjs';

test('permissionOptionLabel maps ACP kinds to Chinese labels', () => {
  assert.equal(permissionOptionLabel({ kind: 'allow_once' }), '允许一次');
  assert.equal(permissionOptionLabel({ kind: 'allow_always' }), '总是允许');
  assert.equal(permissionOptionLabel({ kind: 'reject_once' }), '拒绝');
  assert.equal(permissionOptionLabel({ kind: 'reject_always' }), '总是拒绝');
});

test('buildPermissionPromptText includes tool title and description', () => {
  const text = buildPermissionPromptText({
    toolCall: {
      title: 'bash',
      rawInput: {
        description: 'Print current working directory',
      },
    },
  });

  assert.match(text, /bash/);
  assert.match(text, /Print current working directory/);
});

test('permission registry resolves selected option for matching chat', async () => {
  const registry = createTelegramPermissionRegistry();
  const request = {
    options: [
      { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
    ],
  };

  const pending = registry.create('chat-1', request);
  const result = registry.resolveWithOption(pending.token, 'chat-1', 0);

  assert.equal(result.ok, true);
  assert.equal(result.option.optionId, 'allow-1');
  assert.deepEqual(await pending.promise, {
    outcome: { outcome: 'selected', optionId: 'allow-1' },
    option: request.options[0],
    reason: 'selected',
  });
});

test('permission registry rejects wrong chat selections and allows cancel', async () => {
  const registry = createTelegramPermissionRegistry();
  const pending = registry.create('chat-1', {
    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' }],
  });

  assert.deepEqual(registry.resolveWithOption(pending.token, 'chat-2', 0), { ok: false, reason: 'wrong-chat' });
  assert.deepEqual(registry.cancel(pending.token, 'chat-1', 'manual-cancel'), { ok: true });
  assert.deepEqual(await pending.promise, {
    outcome: { outcome: 'cancelled' },
    reason: 'manual-cancel',
  });
});

test('permission registry expires stale prompts', async () => {
  const registry = createTelegramPermissionRegistry({ ttlMs: 5 });
  const pending = registry.create('chat-1', {
    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' }],
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  registry.prune();

  assert.equal(registry.get(pending.token), null);
  assert.deepEqual(await pending.promise, {
    outcome: { outcome: 'cancelled' },
    reason: 'expired',
  });
});
