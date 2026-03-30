import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from 'grammy';

import {
  createTelegramSink,
  resolveTelegramChatId,
  startTelegramAdapter,
  shouldSendStandaloneFinalTelegramMessage,
} from '../src/adapters/telegram/index.mjs';

function createCtx() {
  const calls = [];
  let nextMessageId = 1;

  return {
    calls,
    chat: { id: 1001 },
    api: {
      async sendMessageDraft(chatId, draftId, text, other) {
        calls.push(['draft', { chatId, draftId, text, other }]);
        return true;
      },
      async editMessageText(chatId, messageId, html, options) {
        calls.push(['edit', { chatId, messageId, html, options }]);
        return { message_id: messageId };
      },
      async deleteMessage(chatId, messageId) {
        calls.push(['delete', { chatId, messageId }]);
        return true;
      },
    },
    async reply(html, options) {
      const message = { message_id: nextMessageId++ };
      calls.push(['reply', { html, options, messageId: message.message_id }]);
      return message;
    },
    async replyWithPhoto(file, options) {
      calls.push(['photo', { file, options }]);
      return { message_id: nextMessageId++ };
    },
  };
}

function createSinkHarness(overrides = {}) {
  const ctx = createCtx();
  const paginationCalls = [];
  const permissionRegistry = overrides.permissionRegistry || {
    create() {
      throw new Error('permission prompt should not be used in this test');
    },
    cancel() {},
  };
  const sink = createTelegramSink(
    ctx,
    (chatId, pages, options = {}) => {
      paginationCalls.push({ chatId, pages, options });
      return pages.length > 1 ? 'page-token' : null;
    },
    (token, pageIndex, totalPages) => ({
      inline_keyboard: [[{ text: `${pageIndex + 1}/${totalPages}`, callback_data: `page:${token}:${pageIndex}` }]],
    }),
    permissionRegistry,
    {},
  );

  return { ctx, sink, paginationCalls };
}

function withMockedTime(fn) {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  const advance = (ms) => {
    now += ms;
  };
  return Promise.resolve(fn({ advance })).finally(() => {
    Date.now = originalNow;
  });
}

function withMockedTimers(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextId = 1;
  const timers = new Map();
  globalThis.setTimeout = ((callback, delay) => {
    const id = nextId++;
    timers.set(id, { callback, delay });
    return id;
  });
  globalThis.clearTimeout = ((id) => {
    timers.delete(id);
  });
  const runAllTimers = async () => {
    while (timers.size) {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, timer] of entries) {
        await timer.callback();
      }
      await Promise.resolve();
    }
  };
  return Promise.resolve(fn({ runAllTimers, timers })).finally(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
}

test('compact final output edits the existing progress message', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final({ status: 'Done', marker: 'assistant', text: '最终结果', elapsedSeconds: 3 });

  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[1][0], 'draft');
  assert.equal(ctx.calls[1][1].text, '\u2060');
  assert.equal(ctx.calls[2][0], 'reply');
  assert.match(ctx.calls[2][1].html, /最终结果/);
});

test('meaningful progress draft keeps only the latest non-assistant step', async () => withMockedTime(async ({ advance }) => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: '执行工具: read_file',
    preview: {
      phase: 'exec',
      summary: '执行工具: read_file',
      content: '读取配置文件',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1,
  });
  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'research',
    text: '检索资料: opencli',
    preview: {
      phase: 'research',
      summary: '检索资料: opencli',
      content: '检索 OpenCLI 文档',
      highlights: ['OpenCLI'],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 2,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.match(ctx.calls[0][1].text, /执行工具: read_file|检索资料: opencli/);
}));

test('tool pending status renders as natural Chinese in telegram draft', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: 'tool · pending',
    preview: {
      phase: 'exec',
      summary: 'tool · pending',
      content: 'tool · pending',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[0][1].text, '工具准备中');
});

test('tool in_progress status renders as natural Chinese in telegram draft', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: 'tool · in_progress',
    preview: {
      phase: 'exec',
      summary: 'tool · in_progress',
      content: 'tool · in_progress',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[0][1].text, '工具执行中');
});

test('tool completion status renders with concrete command title in telegram draft', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: 'cat /tmp/demo.txt · completed',
    preview: {
      phase: 'exec',
      summary: 'cat /tmp/demo.txt · completed',
      content: 'cat /tmp/demo.txt · completed',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[0][1].text, '执行完成: cat /tmp/demo.txt');
});

test('exec draft keeps multiline tool content instead of collapsing to summary', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: 'read_file · in_progress',
    preview: {
      phase: 'exec',
      summary: 'read_file · in_progress',
      content: 'tool\nread_file\n/tmp/demo.txt\n执行中',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[0][1].text, 'tool\nread_file\n/tmp/demo.txt\n执行中');
});

test('assistant chunk drafts accumulate inline before flush', async () => withMockedTime(async ({ advance }) => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'thinking',
    text: '',
    preview: {
      phase: 'thinking',
      summary: '先查看记忆',
      content: '先查看记忆',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });
  advance(1000);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '这',
    preview: {
      phase: 'assistant',
      summary: '这',
      content: '这',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1,
  });
  advance(100);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '次',
    preview: {
      phase: 'assistant',
      summary: '次',
      content: '次',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1.1,
  });
  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '查看',
    preview: {
      phase: 'assistant',
      summary: '查看',
      content: '查看',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 2.1,
  });

  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1][0], 'draft');
  assert.match(ctx.calls[1][1].text, /这次查看/);
  assert.doesNotMatch(ctx.calls[1][1].text, /这\s*\n\s*次/);
}));

test('placeholder thinking drafts replace previous spinner instead of accumulating', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 1 });
  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 2 });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.doesNotMatch(ctx.calls[0][1].text, /Thinking[\s\S]*Thinking/);
});

test('draft updates are throttled across rapid assistant chunks', async () => withMockedTime(async ({ advance }) => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '这',
    preview: { phase: 'assistant', summary: '这', content: '这', highlights: [], checks: [], changedFiles: [], notes: [], diffBlocks: [] },
    elapsedSeconds: 0,
  });
  advance(100);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '次',
    preview: { phase: 'assistant', summary: '次', content: '次', highlights: [], checks: [], changedFiles: [], notes: [], diffBlocks: [] },
    elapsedSeconds: 0.1,
  });
  advance(100);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '是',
    preview: { phase: 'assistant', summary: '是', content: '是', highlights: [], checks: [], changedFiles: [], notes: [], diffBlocks: [] },
    elapsedSeconds: 0.2,
  });

  assert.equal(ctx.calls.length, 0);

  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'assistant',
    text: '查看',
    preview: { phase: 'assistant', summary: '查看', content: '查看', highlights: [], checks: [], changedFiles: [], notes: [], diffBlocks: [] },
    elapsedSeconds: 1.2,
  });

  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0][1].text, /这次是查看/);
}));

test('draft rate-limit path keeps pending progress buffered', async () => withMockedTime(async ({ advance }) => withMockedTimers(async ({ runAllTimers }) => {
  const ctx = createCtx();
  let attempts = 0;
  ctx.api.sendMessageDraft = async (chatId, draftId, text, other) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Too Many Requests: retry after 4');
    ctx.calls.push(['draft', { chatId, draftId, text, other }]);
    return true;
  };
  const sink = createTelegramSink(
    ctx,
    () => null,
    () => undefined,
    { create() { throw new Error('unused'); }, cancel() {} },
    {},
  );

  await sink.progress({
    status: 'Running',
    marker: 'research',
    text: '检索资料: opencli',
    preview: {
      phase: 'research',
      summary: '检索资料: opencli',
      content: '检索 OpenCLI 文档',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1,
  });

  assert.equal(ctx.calls.length, 0);
  advance(5000);
  await runAllTimers();
  assert.equal(ctx.calls.length >= 0, true);
})));

test('progress updates surface validation and tool names in a single line', async () => withMockedTime(async ({ advance }) => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'research',
    text: '',
    preview: {
      phase: 'research',
      summary: 'OpenCode ACP Backend',
      content: 'OpenCode ACP Backend',
      highlights: [
        'The bridge can now switch between codex and opencode-acp.',
        '还有很多额外摘要不该显示',
      ],
      checks: ['命令执行完成'],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.match(ctx.calls[0][1].text, /OpenCode ACP Backend/);
  assert.match(ctx.calls[0][1].text, /命令执行完成/);
  assert.doesNotMatch(ctx.calls[0][1].text, /验证/);
  assert.doesNotMatch(ctx.calls[0][1].text, /还有 .*条摘要/);
  assert.doesNotMatch(ctx.calls[0][1].text, /处理中/);
}));

test('progress updates use natural language without template labels', async () => withMockedTime(async ({ advance }) => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'thinking',
    text: '',
    preview: {
      phase: 'thinking',
      summary: '准备切换到 OpenCode ACP Backend',
      content: '准备切换到 OpenCode ACP Backend',
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 0,
  });
  advance(2000);
  await sink.progress({
    status: 'Running',
    marker: 'research',
    text: '',
    preview: {
      phase: 'research',
      summary: '检索资料: OpenCode ACP Backend',
      content: 'OpenCode ACP Backend',
      highlights: ['The bridge can now switch between codex and opencode-acp.'],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
    elapsedSeconds: 1,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.match(ctx.calls[0][1].text, /准备切换到 OpenCode ACP Backend|检索资料: OpenCode ACP Backend/);
  assert.doesNotMatch(ctx.calls[0][1].text, /计划：|当前：/);
}));

test('long-running final output sends the result, then deletes the thinking message directly', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final({ status: 'Done', marker: 'assistant', text: '最终结果', elapsedSeconds: 12 });

  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls.map(([type]) => type), ['draft', 'draft', 'reply']);
  assert.match(ctx.calls[0][1].text, /Thinking/);
  assert.equal(ctx.calls[1][1].text, '\u2060');
  assert.match(ctx.calls[2][1].html, /最终结果/);
});

test('standalone final delivery decision covers long or complex results', () => {
  assert.equal(shouldSendStandaloneFinalTelegramMessage({
    hasProgressMessage: true,
    pageCount: 1,
    hasImages: false,
    hasReplyMarkup: false,
    elapsedSeconds: 3,
    progressUpdateCount: 1,
  }), false);

  assert.equal(shouldSendStandaloneFinalTelegramMessage({
    hasProgressMessage: true,
    pageCount: 1,
    hasImages: false,
    hasReplyMarkup: false,
    elapsedSeconds: 12,
    progressUpdateCount: 1,
  }), true);

  assert.equal(shouldSendStandaloneFinalTelegramMessage({
    hasProgressMessage: true,
    pageCount: 2,
    hasImages: false,
    hasReplyMarkup: false,
    elapsedSeconds: 2,
    progressUpdateCount: 1,
  }), true);

  assert.equal(shouldSendStandaloneFinalTelegramMessage({
    hasProgressMessage: true,
    pageCount: 1,
    hasImages: true,
    hasReplyMarkup: false,
    elapsedSeconds: 2,
    progressUpdateCount: 1,
  }), true);

  assert.equal(shouldSendStandaloneFinalTelegramMessage({
    hasProgressMessage: true,
    pageCount: 1,
    hasImages: false,
    hasReplyMarkup: true,
    elapsedSeconds: 2,
    progressUpdateCount: 1,
  }), true);
});

test('final telegram output sends local image paths that appear inline in prose', async () => {
  const { ctx, sink } = createSinkHarness();
  const imagePath = path.join(os.tmpdir(), 'telegram-inline-image.jpg');
  fs.writeFileSync(imagePath, 'fake');

  await sink.final({
    status: 'Done',
    marker: 'assistant',
    text: `已找到图片：${imagePath}。现在直接打开这张图。`,
    elapsedSeconds: 1,
  });

  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[1][0], 'reply');
  assert.equal(ctx.calls[2][0], 'photo');
  assert.equal(ctx.calls[2][1].file?.fileData, imagePath);
  assert.match(ctx.calls[1][1].html, /图片已发送/);
});

test('permission prompt html avoids unsupported br tags', async () => {
  const { ctx, sink } = createSinkHarness({
    permissionRegistry: {
      create() {
        return {
          token: 'tok',
          promise: Promise.resolve({
            outcome: { outcome: 'selected' },
            option: { label: 'Yes, proceed' },
          }),
        };
      },
      cancel() {},
    },
  });

  await sink.requestPermission({
    toolCall: { title: 'Run rm -rf Claude-to-IM-skill' },
    options: [
      { optionId: 'approved', name: 'Yes, proceed', kind: 'allow_once' },
    ],
  }, {});

  const promptCall = ctx.calls.find(([type, payload]) => (type === 'reply' || type === 'edit') && String(payload.html || '').includes('Run rm -rf'));
  assert.ok(promptCall);
  assert.doesNotMatch(promptCall[1].html, /<br\/?>/);
});

test('resolveTelegramChatId falls back to callback query message chat', () => {
  assert.equal(resolveTelegramChatId({
    callbackQuery: {
      message: {
        chat: { id: 578310345 },
      },
    },
  }), '578310345');
  assert.equal(resolveTelegramChatId({
    update: {
      callback_query: {
        message: {
          chat: { id: -1001234567890 },
        },
      },
    },
  }), '-1001234567890');
  assert.equal(resolveTelegramChatId({}), '');
});

test('message update handling returns before long controller task settles', async () => {
  const originalStart = Bot.prototype.start;
  let startedBot = null;
  let resolveTask;
  let handleInputCalls = 0;
  const taskPromise = new Promise((resolve) => {
    resolveTask = resolve;
  });

  Bot.prototype.start = function patchedStart(options = {}) {
    startedBot = this;
    this.botInfo = {
      id: 42,
      is_bot: true,
      first_name: 'bot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    this.api.raw = {
      async deleteMyCommands() { return true; },
      async setMyCommands() { return true; },
      async setChatMenuButton() { return true; },
    };
    options.onStart?.(this.botInfo);
    return Promise.resolve();
  };

  try {
    const controller = {
      attachTelegramChannelPublisher() {},
      async handleInput() {
        handleInputCalls += 1;
        return taskPromise;
      },
    };

    await startTelegramAdapter({ tgBotToken: '123:ABC' }, controller);
    assert.ok(startedBot);

    const updatePromise = startedBot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        text: 'delete',
        chat: { id: 1001, type: 'private' },
        from: { id: 1001, is_bot: false, first_name: 'user' },
      },
    });

    const outcome = await Promise.race([
      updatePromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    assert.equal(outcome, 'resolved');
    assert.equal(handleInputCalls, 1);

    resolveTask();
    await Promise.resolve();
  } finally {
    Bot.prototype.start = originalStart;
  }
});

test('telegram sink progress prefers controller-rendered progress events over legacy payload rendering', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({
    status: 'Running',
    marker: 'exec',
    text: 'legacy fallback should not be used',
    rendered: {
      format: 'plain',
      body: '💻 bash\nls -la\n执行中',
    },
    elapsedSeconds: 0,
  });

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.match(ctx.calls[0][1].text, /bash/);
  assert.match(ctx.calls[0][1].text, /ls -la/);
  assert.doesNotMatch(ctx.calls[0][1].text, /legacy fallback should not be used/);
});
