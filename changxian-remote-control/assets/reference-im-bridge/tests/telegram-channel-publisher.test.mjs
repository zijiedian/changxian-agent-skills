import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTelegramChannelTargets,
  normalizeTelegramChannelAllowlist,
  createTelegramChannelPublisher,
  parseChannelCommandInput,
} from '../src/telegram-channel-publisher.mjs';

test('parseTelegramChannelTargets parses alias map from JSON', () => {
  const result = parseTelegramChannelTargets('{"daily":"@daily","news":"-10042"}');
  assert.deepEqual(result, {
    daily: '@daily',
    news: '-10042',
  });
});

test('normalizeTelegramChannelAllowlist parses comma-separated ids', () => {
  const result = normalizeTelegramChannelAllowlist('123, 456 ,, 789');
  assert.deepEqual([...result], ['123', '456', '789']);
});

test('parseChannelCommandInput extracts alias and content from pipe syntax', () => {
  const result = parseChannelCommandInput('daily | hello world');
  assert.deepEqual(result, {
    alias: 'daily',
    content: 'hello world',
  });
});

test('preview does not publish and returns render summary', async () => {
  const sent = [];
  const bot = {
    api: {
      sendMessage: async (...args) => sent.push(['message', ...args]),
      sendPhoto: async (...args) => sent.push(['photo', ...args]),
    },
  };
  const publisher = createTelegramChannelPublisher({
    bot,
    config: {
      tgChannelTargets: { daily: '@daily' },
      tgDefaultChannel: 'daily',
      tgChannelAllowedOperatorIds: new Set(),
    },
  });

  const result = await publisher.preview({
    alias: 'daily',
    payload: 'hello',
    operatorId: '123',
  });

  assert.equal(result.target, '@daily');
  assert.equal(result.pages.length, 1);
  assert.equal(sent.length, 0);
});

test('send publishes rendered payload to configured target', async () => {
  const sent = [];
  const bot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(['message', ...args]);
        return { message_id: sent.length };
      },
      sendPhoto: async (...args) => {
        sent.push(['photo', ...args]);
        return { message_id: sent.length };
      },
    },
  };
  const publisher = createTelegramChannelPublisher({
    bot,
    config: {
      tgChannelTargets: { daily: '@daily' },
      tgDefaultChannel: 'daily',
      tgChannelAllowedOperatorIds: new Set(['123']),
    },
  });

  const result = await publisher.send({
    alias: 'daily',
    payload: 'hello',
    operatorId: '123',
  });

  assert.equal(result.target, '@daily');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'message');
  assert.equal(sent[0][1], '@daily');
});

test('send rejects operators outside allowlist', async () => {
  const bot = {
    api: {
      sendMessage: async () => ({ message_id: 1 }),
      sendPhoto: async () => ({ message_id: 2 }),
    },
  };
  const publisher = createTelegramChannelPublisher({
    bot,
    config: {
      tgChannelTargets: { daily: '@daily' },
      tgDefaultChannel: 'daily',
      tgChannelAllowedOperatorIds: new Set(['123']),
    },
  });

  await assert.rejects(
    () => publisher.send({ alias: 'daily', payload: 'hello', operatorId: '999' }),
    /not allowed/i,
  );
});
