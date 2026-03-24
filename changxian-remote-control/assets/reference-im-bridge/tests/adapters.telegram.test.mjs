import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTelegramSink,
  shouldSendStandaloneFinalTelegramMessage,
} from '../src/adapters.telegram.mjs';

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

function createSinkHarness() {
  const ctx = createCtx();
  const paginationCalls = [];
  const sink = createTelegramSink(
    ctx,
    (chatId, pages, options = {}) => {
      paginationCalls.push({ chatId, pages, options });
      return pages.length > 1 ? 'page-token' : null;
    },
    (token, pageIndex, totalPages) => ({
      inline_keyboard: [[{ text: `${pageIndex + 1}/${totalPages}`, callback_data: `page:${token}:${pageIndex}` }]],
    }),
    {
      create() {
        throw new Error('permission prompt should not be used in this test');
      },
      cancel() {},
    },
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
    const entries = [...timers.entries()];
    timers.clear();
    for (const [, timer] of entries) {
      await timer.callback();
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

  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0][0], 'draft');
  assert.equal(ctx.calls[1][0], 'reply');
  assert.match(ctx.calls[1][1].html, /最终结果/);
});

test('meaningful progress draft keeps only the latest non-assistant step', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
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

  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls.map(([type]) => type), ['draft', 'draft', 'draft']);
  assert.match(ctx.calls[1][1].text, /执行工具: read_file/);
  assert.match(ctx.calls[2][1].text, /检索资料: opencli/);
  assert.doesNotMatch(ctx.calls[2][1].text, /执行工具: read_file/);
  assert.equal(ctx.calls[0][1].draftId, ctx.calls[1][1].draftId);
  assert.equal(ctx.calls[1][1].draftId, ctx.calls[2][1].draftId);
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
  advance(1000);
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

  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.calls[2][0], 'draft');
  assert.match(ctx.calls[2][1].text, /这次查看/);
  assert.doesNotMatch(ctx.calls[2][1].text, /这\s*\n\s*次/);
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

  advance(1000);
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

test('draft resumes after retry-after cooldown instead of stopping permanently', async () => withMockedTime(async ({ advance }) => withMockedTimers(async ({ runAllTimers }) => {
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
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0][1].text, /检索资料: opencli/);
})));

test('progress updates surface validation and tool names in a single line', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
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

  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1][0], 'draft');
  assert.match(ctx.calls[1][1].text, /OpenCode ACP Backend/);
  assert.match(ctx.calls[1][1].text, /命令执行完成/);
  assert.doesNotMatch(ctx.calls[1][1].text, /验证/);
  assert.doesNotMatch(ctx.calls[1][1].text, /还有 .*条摘要/);
  assert.doesNotMatch(ctx.calls[1][1].text, /处理中/);
});

test('progress updates use natural language without template labels', async () => {
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

  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1][0], 'draft');
  assert.match(ctx.calls[1][1].text, /检索资料: OpenCode ACP Backend/);
  assert.doesNotMatch(ctx.calls[1][1].text, /计划：|当前：/);
});

test('long-running final output sends the result, then deletes the thinking message directly', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final({ status: 'Done', marker: 'assistant', text: '最终结果', elapsedSeconds: 12 });

  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls.map(([type]) => type), ['draft', 'reply']);
  assert.match(ctx.calls[0][1].text, /Thinking/);
  assert.match(ctx.calls[1][1].html, /最终结果/);
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

  assert.equal(ctx.calls[0][0], 'reply');
  assert.equal(ctx.calls[1][0], 'photo');
  assert.equal(ctx.calls[1][1].file?.fileData, imagePath);
  assert.match(ctx.calls[0][1].html, /图片已发送/);
});
