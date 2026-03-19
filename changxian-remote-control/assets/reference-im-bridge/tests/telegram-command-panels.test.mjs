import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommandPanelKeyboard } from '../src/telegram-command-panels.mjs';

function callbackDataSet(keyboard) {
  return new Set(
    (keyboard?.inline_keyboard || [])
      .flat()
      .map((button) => button.callback_data)
      .filter(Boolean),
  );
}

test('schedule panel exposes run/show/toggle actions for jobs', () => {
  const keyboard = buildCommandPanelKeyboard({
    store: {
      listJobs() {
        return [
          { id: 'job_a', name: 'daily report', enabled: true },
          { id: 'job_b', name: 'weekly sync', enabled: false },
        ];
      },
    },
  }, 'chat-1', 'schedule');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:schedule:run:job_a'), true);
  assert.equal(callbacks.has('rcctl:schedule:show:job_a'), true);
  assert.equal(callbacks.has('rcctl:schedule:toggle:job_a'), true);
  assert.equal(callbacks.has('rcctl:schedule:toggle:job_b'), true);
});

test('role panel exposes use/show/clear actions', () => {
  const keyboard = buildCommandPanelKeyboard({
    activeRoleName() {
      return 'reviewer';
    },
    store: {
      listRoles() {
        return ['reviewer', 'writer'];
      },
    },
  }, 'chat-1', 'role');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:role:use:reviewer'), true);
  assert.equal(callbacks.has('rcctl:role:show:writer'), true);
  assert.equal(callbacks.has('rcctl:role:clear:active'), true);
});

test('channel panel exposes test actions for aliases', () => {
  const keyboard = buildCommandPanelKeyboard({
    telegramChannelPublisher: {
      listTargets() {
        return [
          { alias: 'daily', target: '@daily' },
          { alias: 'news', target: '@news' },
        ];
      },
    },
  }, 'chat-1', 'channel');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:channel:test:daily'), true);
  assert.equal(callbacks.has('rcctl:channel:test:news'), true);
  const inlineQueries = (keyboard?.inline_keyboard || [])
    .flat()
    .map((button) => button.switch_inline_query_current_chat)
    .filter(Boolean);
  assert.equal(inlineQueries.includes('/channel preview daily | '), true);
  assert.equal(inlineQueries.includes('/channel send news | '), true);
});

test('memory panel exposes show pin and delete actions', () => {
  const keyboard = buildCommandPanelKeyboard({
    store: {
      listMemories() {
        return [
          { id: 'mem_1', title: '默认中文回答', pinned: true },
          { id: 'mem_2', title: '项目目录', pinned: false },
        ];
      },
    },
  }, 'chat-1', 'memory');

  const callbacks = callbackDataSet(keyboard);
  assert.equal(callbacks.has('rcctl:memory:show:mem_1'), true);
  assert.equal(callbacks.has('rcctl:memory:pin:mem_1'), true);
  assert.equal(callbacks.has('rcctl:memory:delete:mem_2'), true);
});
