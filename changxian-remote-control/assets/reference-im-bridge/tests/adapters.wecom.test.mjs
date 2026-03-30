import test from 'node:test';
import assert from 'node:assert/strict';

import { createWeComReplySink } from '../src/adapters.wecom.mjs';

function createClient() {
  const calls = [];
  return {
    calls,
    async replyStream(frame, streamId, content, finish) {
      calls.push(['stream', { frame, streamId, content, finish }]);
      return { ok: true };
    },
    async sendMessage(target, body) {
      calls.push(['send', { target, body }]);
      return { ok: true };
    },
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

function doneMessage(text) {
  return {
    status: 'Done',
    marker: 'assistant',
    preview: {
      summary: text,
      content: text,
      proseMarkdown: text,
      highlights: [],
      checks: [],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
    },
  };
}

test('wecom final prefers proactive markdown delivery when target exists', async () => {
  const client = createClient();
  const sink = createWeComReplySink(client, { headers: { req_id: 'req-1' } }, {
    chatId: 'chat-1',
    chattype: 'single',
    userid: 'user-1',
  });

  await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
  await sink.final(doneMessage('最终结果'));

  assert.equal(client.calls[0][0], 'stream');
  assert.equal(client.calls[1][0], 'send');
  assert.equal(client.calls[1][1].target, 'user-1');
  assert.match(client.calls[1][1].body.markdown.content, /最终结果/);
  assert.equal(client.calls.some(([type, entry]) => type === 'stream' && entry.finish === true), false);
});

test('wecom final falls back to stream when proactive target is unavailable', async () => {
  const client = createClient();
  const sink = createWeComReplySink(client, { headers: { req_id: 'req-2' } }, {
    chatId: 'chat-2',
    chattype: 'single',
  });

  await sink.final(doneMessage('备用结果'));

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0][0], 'stream');
  assert.equal(client.calls[0][1].finish, true);
  assert.match(client.calls[0][1].content, /备用结果/);
});

test('wecom sink preserves direct string finals for auth-style command responses', async () => {
  const client = createClient();
  const sink = createWeComReplySink(client, { headers: { req_id: 'req-3' } }, {
    chatId: 'chat-3',
    chattype: 'single',
    userid: 'user-3',
  });

  await sink.final('Authentication successful\nValid for 12h');

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0][0], 'send');
  assert.match(client.calls[0][1].body.markdown.content, /Authentication successful/);
  assert.match(client.calls[0][1].body.markdown.content, /Valid for 12h/);
});

test('wecom sink ignores late progress once final delivery has started', async () => {
  const delivery = createDeferred();
  const client = createClient();
  client.sendMessage = async (target, body) => {
    client.calls.push(['send', { target, body }]);
    await delivery.promise;
    return { ok: true };
  };

  const sink = createWeComReplySink(client, { headers: { req_id: 'req-4' } }, {
    chatId: 'chat-4',
    chattype: 'single',
    userid: 'user-4',
  });

  const finalPromise = sink.final(doneMessage('最终结果'));
  await Promise.resolve();
  await sink.progress({ status: 'Running', marker: 'thinking', text: 'Session updated: 00:07', elapsedSeconds: 7 });
  delivery.resolve();
  await finalPromise;

  assert.deepEqual(client.calls.map(([type]) => type), ['send']);
  assert.match(client.calls[0][1].body.markdown.content, /最终结果/);
});
