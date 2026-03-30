import test from 'node:test';
import assert from 'node:assert/strict';

import { startWeixinAdapter } from '../src/adapters/weixin.mjs';

test('startWeixinAdapter bridges inbound chat into runtime controller and returns final text', async () => {
  let capturedAgent = null;
  let startOptions = null;
  const controllerCalls = [];

  const adapter = await startWeixinAdapter({
    weixinEnabled: true,
    weixinAccountId: 'wx-account-1',
  }, {
    async handleInput(request, sink) {
      controllerCalls.push(request);
      await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...' });
      await sink.final({
        status: 'Done',
        marker: 'assistant',
        text: '微信侧最终回复',
      });
    },
  }, {
    async start(agent, options) {
      capturedAgent = agent;
      startOptions = options;
    },
  });

  assert.equal(adapter.name, 'weixin');
  assert.equal(startOptions.accountId, 'wx-account-1');
  const response = await capturedAgent.chat({
    conversationId: 'wx-conv-1',
    text: '你好',
  });

  assert.equal(controllerCalls.length, 1);
  assert.equal(controllerCalls[0].host, 'weixin');
  assert.equal(controllerCalls[0].externalChatId, 'wx-conv-1');
  assert.equal(response.text, '微信侧最终回复');

  await adapter.stop();
});
