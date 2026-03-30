import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntimeControlKeyboard } from '../src/adapters/telegram/controls.mjs';

function callbackDataSet(keyboard) {
  return new Set(
    (keyboard?.inline_keyboard || [])
      .flat()
      .map((button) => button.callback_data)
      .filter(Boolean),
  );
}

test('runtime control keyboard includes backend, permission, and quick command buttons', () => {
  const keyboard = buildRuntimeControlKeyboard({
    runtimeControlState() {
      return {
        backend: 'codex',
        permissionKind: 'codex',
        permissionLevel: 'high',
        permissionOptions: [
          { value: 'readonly', label: '只读' },
          { value: 'low', label: '标准' },
          { value: 'high', label: '高权限' },
        ],
      };
    },
  }, 'chat-1');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:backend:codex'), true);
  assert.equal(callbacks.has('rcctl:backend:claude'), true);
  assert.equal(callbacks.has('rcctl:backend:opencode-acp'), true);
  assert.equal(callbacks.has('rcctl:backend:pi'), true);
  assert.equal(callbacks.has('rcctl:perm:readonly'), true);
  assert.equal(callbacks.has('rcctl:perm:low'), true);
  assert.equal(callbacks.has('rcctl:perm:high'), true);
  assert.equal(callbacks.has('rcctl:cmd:setting'), true);
  assert.equal(callbacks.has('rcctl:cmd:cli'), true);
  assert.equal(callbacks.has('rcctl:cmd:schedule'), true);
  assert.equal(callbacks.has('rcctl:cmd:channel'), true);
  assert.equal(callbacks.has('rcctl:cmd:skill'), true);
  assert.equal(callbacks.has('rcctl:cmd:mcp'), true);
  assert.equal(callbacks.has('rcctl:cmd:cancel'), true);
  assert.equal(callbacks.has('rcctl:session:new'), true);
});

test('runtime control keyboard omits permission presets for managed backends', () => {
  const keyboard = buildRuntimeControlKeyboard({
    runtimeControlState() {
      return {
        backend: 'opencode-acp',
        permissionKind: 'opencode-acp',
        permissionLevel: 'managed',
        permissionLabel: '后端控制',
        permissionOptions: [],
      };
    },
  }, 'chat-1');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:perm:readonly'), false);
  assert.equal(callbacks.has('rcctl:refresh:status'), true);
  assert.equal(callbacks.has('rcctl:cmd:cli'), true);
});
