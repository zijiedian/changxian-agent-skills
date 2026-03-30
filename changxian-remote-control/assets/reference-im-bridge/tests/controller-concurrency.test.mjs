import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { RuntimeController } from '../src/controller.mjs';

const DEFAULT_COMMAND_PREFIX = 'codex-acp';

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
    setChatCommandPrefix() {},
    getChatWorkdir() { return ''; },
    setChatWorkdir() {},
    getActiveRole() { return ''; },
    roleExists() { return false; },
    getRole() { return ''; },
    ensureDefaultRoles() {},
    getChatSession() { return ''; },
    setChatSession() {},
    clearChatSession() {},
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

test('runScheduledJob does not emit generic thinking progress updates', async () => {
  const controller = createController();

  const sink = createSink();
  const result = await controller.runScheduledJob({
    id: 'job-3',
    chat_id: 'chat-1',
    prompt_template: 'run scheduled job without progress',
    role: '',
    memory_scope: '',
    workdir: os.tmpdir(),
    command_prefix: DEFAULT_COMMAND_PREFIX,
    session_policy: 'fresh',
  }, sink, {
    host: 'telegram',
    taskHost: 'scheduler:job-3',
    hostName: 'Telegram scheduled runtime',
  });

  assert.equal(result.success, true);
  assert.deepEqual(sink.progressCalls, []);
  assert.equal(sink.finalCalls.length, 1);
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

test('runTask queues an interactive telegram task behind another interactive task in the same chat', async () => {
  const controller = createController();
  const firstTask = createDeferred();
  let runCount = 0;
  controller.backendProvider = () => ({
    async runTask({ abortSignal }) {
      runCount += 1;
      if (runCount === 1) {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          abortSignal?.addEventListener('abort', onAbort, { once: true });
          firstTask.promise.then(resolve, reject).finally(() => {
            abortSignal?.removeEventListener('abort', onAbort);
          });
        });
      }
      return { output: 'second run ok', sessionId: '' };
    },
  });

  const sink1 = createSink();
  const sink2 = createSink();

  const firstPromise = controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: 'first',
  }, sink1, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  await Promise.resolve();

  const secondPromise = controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: 'second',
  }, sink2, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  await Promise.resolve();

  assert.equal(sink2.finalCalls.length, 0);
  assert.equal(sink2.progressCalls[0]?.text, '当前会话忙碌中，已加入队列，等待当前任务完成。');

  firstTask.resolve({ output: 'first run ok', sessionId: '' });

  const firstResult = await firstPromise;
  const secondResult = await secondPromise;

  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.equal(sink1.finalCalls[0]?.text, 'first run ok');
  assert.equal(sink2.finalCalls[0]?.text, 'second run ok');
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

test('switching backend clears incompatible saved chat sessions', () => {
  let cleared = 0;
  const store = createStore();
  store.clearChatSession = () => { cleared += 1; };
  const controller = new RuntimeController(createConfig(), store);

  const message = controller.applyBackendSelection('chat-1', 'pi');
  assert.match(message, /Pi ACP/);
  assert.equal(cleared, 1);
});

test('runTask rejects legacy non-ACP codex prefixes', async () => {
  const controller = createController();
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
    commandPrefix: 'codex -a never --search exec -s danger-full-access --skip-git-repo-check',
  });

  assert.equal(result.success, false);
  assert.match(result.errorText || '', /Legacy codex command prefixes are no longer supported/);
});

test('runTask forwards rendered progress events without crashing the task', async () => {
  const controller = createController();
  controller.backendProvider = () => ({
    async runTask(options) {
      await options.onEvent?.({
        type: 'text',
        content: '正在查看远控状态',
      });
      return { output: '远控状态正常', sessionId: '' };
    },
  });
  const sink = createSink();

  const result = await controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: '查看远控状态',
  }, sink, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  assert.equal(result.success, true);
  assert.equal(sink.progressCalls.length, 2);
  assert.equal(sink.progressCalls[1]?.text, '正在查看远控状态');
  assert.equal(typeof sink.progressCalls[1]?.elapsedSeconds, 'number');
  assert.equal(sink.finalCalls.length, 1);
  assert.equal(sink.finalCalls[0]?.text, '远控状态正常');
});

test('runTask suppresses session info update events from user-facing progress', async () => {
  const controller = createController();
  controller.backendProvider = () => ({
    async runTask(options) {
      await options.onEvent?.({
        type: 'session_info_update',
        title: '00:07',
      });
      return { output: '远控状态正常', sessionId: '' };
    },
  });
  const sink = createSink();

  const result = await controller.runTask({
    host: 'wecom',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: '查看远控状态',
  }, sink, {
    hostName: 'wecom',
    taskHost: 'wecom',
  });

  assert.equal(result.success, true);
  assert.equal(sink.progressCalls.length, 1);
  assert.equal(sink.progressCalls[0]?.text, 'thinking...');
  assert.equal(sink.finalCalls.length, 1);
  assert.equal(sink.finalCalls[0]?.text, '远控状态正常');
});

test('cancel stops the running task and lets the next queued task continue', async () => {
  const controller = createController();
  let runCount = 0;
  controller.backendProvider = () => ({
    async runTask({ abortSignal }) {
      runCount += 1;
      if (runCount === 1) {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          abortSignal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { output: 'queued run ok', sessionId: '' };
    },
  });

  const runningSink = createSink();
  const queuedSink = createSink();
  const cancelSink = createSink();

  const runningPromise = controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: 'running',
  }, runningSink, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  await Promise.resolve();

  const queuedPromise = controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: 'queued',
  }, queuedSink, {
    hostName: 'telegram',
    taskHost: 'telegram',
  });

  await controller.handleInput({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: '/cancel',
  }, cancelSink);

  const runningResult = await runningPromise;
  const queuedResult = await queuedPromise;

  assert.equal(cancelSink.finalCalls[0], '已请求取消当前任务。');
  assert.equal(runningResult.success, false);
  assert.equal(runningResult.errorText, 'cancelled');
  assert.equal(runningSink.finalCalls.at(-1), '任务已取消。');
  assert.equal(queuedResult.success, true);
  assert.equal(queuedSink.finalCalls[0]?.text, 'queued run ok');
});

test('runTask suppresses pi skill inventory chunks from user-facing progress', async () => {
  const controller = createController();
  controller.backendProvider = () => ({
    async runTask(options) {
      await options.onEvent?.({
        type: 'text',
        content: '## Skills\n- /Users/wanwenjie/.pi/agent/skills/shadcn/SKILL.md\n- /Users/wanwenjie/.agents/skills/test-driven-development/SKILL.md',
      });
      await options.onEvent?.({
        type: 'thought',
        content: '正在查看当前配置',
      });
      return { output: '远控状态正常', sessionId: '' };
    },
  });
  const sink = createSink();

  const result = await controller.runTask({
    host: 'telegram',
    chatId: 'chat-1',
    externalChatId: 'chat-1',
    externalUserId: 'user-1',
    text: '查看远控状态',
  }, sink, {
    hostName: 'telegram',
    taskHost: 'telegram',
    commandPrefix: 'pi-acp',
  });

  assert.equal(result.success, true);
  assert.equal(sink.progressCalls.length, 2);
  assert.equal(sink.progressCalls[0]?.text, 'thinking...');
  assert.equal(sink.progressCalls[1]?.text, '正在查看当前配置');
  assert.equal(sink.finalCalls.length, 1);
  assert.equal(sink.finalCalls[0]?.text, '远控状态正常');
});

test('handleSettingCommand uses ACP naming consistently', () => {
  const controller = createController();
  const output = controller.handleSettingCommand();

  assert.match(output, /codex_acp:/);
  assert.match(output, /claude_acp:/);
  assert.match(output, /pi_acp:/);
  assert.doesNotMatch(output, /codex_sdk:/);
  assert.doesNotMatch(output, /claude_sdk:/);
  assert.doesNotMatch(output, /pi_cli:/);
});

test('handleScheduleCommand list returns all jobs without truncation', async () => {
  const store = createStore();
  store.listJobs = () => Array.from({ length: 11 }, (_, index) => ({
    id: `job-${index + 1}`,
    enabled: true,
    schedule_type: 'cron',
    schedule_expr: `${index} 9 * * *`,
    timezone: 'Asia/Shanghai',
  }));

  const controller = new RuntimeController(createConfig(), store);
  const output = await controller.handleScheduleCommand('chat-1', 'list');

  assert.match(output, /job-1 \[enabled\]/);
  assert.match(output, /job-11 \[enabled\]/);
});
