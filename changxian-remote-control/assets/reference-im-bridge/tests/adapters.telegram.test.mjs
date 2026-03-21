import test from 'node:test';
import assert from 'node:assert/strict';

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

test('compact final output edits the existing progress message', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final({ status: 'Done', marker: 'assistant', text: '最终结果', elapsedSeconds: 3 });

  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0][0], 'reply');
  assert.equal(ctx.calls[1][0], 'edit');
  assert.match(ctx.calls[1][1].html, /最终结果/);
});

test('meaningful progress updates append into the same message instead of replacing previous steps', async () => {
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
  assert.deepEqual(ctx.calls.map(([type]) => type), ['reply', 'edit', 'edit']);
  assert.match(ctx.calls[1][1].html, /执行工具: read_file/);
  assert.match(ctx.calls[2][1].html, /执行工具: read_file/);
  assert.match(ctx.calls[2][1].html, /检索资料: opencli/);
});

test('long-running final output sends the result, then deletes the thinking message directly', async () => {
  const { ctx, sink } = createSinkHarness();

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final({ status: 'Done', marker: 'assistant', text: '最终结果', elapsedSeconds: 12 });

  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls.map(([type]) => type), ['reply', 'reply', 'delete']);
  assert.match(ctx.calls[0][1].html, /Thinking/);
  assert.match(ctx.calls[1][1].html, /最终结果/);
  assert.equal(ctx.calls[2][1].messageId, 1);
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
