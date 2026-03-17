import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { RuntimeController } from '../src/controller.mjs';

const DEFAULT_COMMAND_PREFIX = 'codex -a never --search exec -s danger-full-access --skip-git-repo-check';

function createConfig() {
  return {
    defaultWorkdir: os.tmpdir(),
    defaultBackend: 'codex',
    codexCommandPrefix: DEFAULT_COMMAND_PREFIX,
    opencodeCommandPrefix: 'opencode acp',
    enableMemory: false,
    authPassphrase: '',
    authTtlSeconds: 3600,
    defaultTimezone: 'Asia/Shanghai',
  };
}

function createStore() {
  return {
    getChatCommandPrefix() { return ''; },
    getChatWorkdir() { return ''; },
    setChatWorkdir() {},
    getActiveRole() { return ''; },
    roleExists() { return false; },
    getRole() { return ''; },
    ensureDefaultRoles() {},
    getChatSession() { return ''; },
    setChatSession() {},
    getJobSession() { return ''; },
    setJobSession() {},
    saveHostBinding() {},
  };
}

function createSink() {
  return {
    progressCalls: [],
    finalCalls: [],
    async progress(payload) {
      this.progressCalls.push(payload);
    },
    async final(payload) {
      this.finalCalls.push(payload);
    },
  };
}

function createController() {
  const controller = new RuntimeController(createConfig(), createStore());
  controller.commandPreflight = () => ({
    ok: true,
    checks: [],
    redactedCommandPrefix: DEFAULT_COMMAND_PREFIX,
    workdir: os.tmpdir(),
  });
  controller.backendProvider = () => ({
    async runTask() {
      return { output: 'scheduled run ok', sessionId: '' };
    },
  });
  return controller;
}

function runningEntry(host, chatId) {
  return {
    host,
    chatId: String(chatId),
    startedAt: Date.now(),
    cancel() {},
  };
}

test('runScheduledJob bypasses an active telegram task in the same chat', async () => {
  const controller = createController();
  controller.tasks.set(controller.makeTaskKey('telegram', 'chat-1'), runningEntry('telegram', 'chat-1'));

  const sink = createSink();
  const result = await controller.runScheduledJob({
    id: 'job-1',
    chat_id: 'chat-1',
    prompt_template: 'run scheduled job',
    role: '',
    memory_scope: '',
    workdir: os.tmpdir(),
    command_prefix: DEFAULT_COMMAND_PREFIX,
    session_policy: 'fresh',
  }, sink, {
    host: 'telegram',
    taskHost: 'scheduler:job-1',
    hostName: 'Telegram scheduled runtime',
  });

  assert.equal(result.success, true);
  assert.equal(result.skipped, undefined);
  assert.equal(sink.finalCalls.length, 1);
  assert.notEqual(sink.finalCalls[0]?.text, '当前会话已有任务在运行，请稍后重试。');
});

test('runTask still blocks an interactive telegram task while a scheduler task is running', async () => {
  const controller = createController();
  controller.tasks.set(controller.makeTaskKey('scheduler:job-1', 'chat-1'), runningEntry('scheduler:job-1', 'chat-1'));

  const sink = createSink();
  const result = await controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: 'hello',
  }, sink, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.summary, 'chat busy');
  assert.equal(result.errorText, 'chat already has a running task');
  assert.equal(sink.finalCalls[0], '当前会话已有任务在运行，请稍后重试。');
});

test('runScheduledJob remains blocked by another scheduler task in the same chat', async () => {
  const controller = createController();
  controller.tasks.set(controller.makeTaskKey('scheduler:job-1', 'chat-1'), runningEntry('scheduler:job-1', 'chat-1'));

  const sink = createSink();
  const result = await controller.runScheduledJob({
    id: 'job-2',
    chat_id: 'chat-1',
    prompt_template: 'run another scheduled job',
    role: '',
    memory_scope: '',
    workdir: os.tmpdir(),
    command_prefix: DEFAULT_COMMAND_PREFIX,
    session_policy: 'fresh',
  }, sink, {
    host: 'telegram',
    taskHost: 'scheduler:job-2',
    hostName: 'Telegram scheduled runtime',
  });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.summary, 'chat busy');
  assert.equal(sink.finalCalls[0], '当前会话已有任务在运行，请稍后重试。');
});
