import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function setupCodexHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-telegram-panels-'));
  fs.mkdirSync(path.join(dir, 'skills', 'alpha-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha\n---\n');
  fs.writeFileSync(path.join(dir, 'config.toml'), [
    '[[skills.config]]',
    `path = "${path.join(dir, 'skills', 'alpha-skill', 'SKILL.md')}"`,
    'enabled = true',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
    mcp: {
      playwright: {
        enabled: true,
        type: 'local',
        command: ['npx', '@playwright/mcp@latest'],
      },
    },
  }, null, 2));
  return dir;
}

test('skill panel exposes show and toggle actions', () => {
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = setupCodexHome();
  try {
    const keyboard = buildCommandPanelKeyboard({}, 'chat-1', 'skill');
    const callbacks = callbackDataSet(keyboard);
    assert.equal(callbacks.has('rcctl:skill:show:0|alpha-skill'), true);
    assert.equal(callbacks.has('rcctl:skill:toggle:0|alpha-skill'), true);
  } finally {
    if (original == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});

test('mcp panel exposes show and toggle actions', () => {
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = setupCodexHome();
  try {
    const keyboard = buildCommandPanelKeyboard({}, 'chat-1', 'mcp');
    const callbacks = callbackDataSet(keyboard);
    assert.equal(callbacks.has('rcctl:mcp:show:0|playwright'), true);
    assert.equal(callbacks.has('rcctl:mcp:toggle:0|playwright'), true);
  } finally {
    if (original == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});
