import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RuntimeController } from '../src/controller.mjs';
import { StateStore } from '../src/store.mjs';
import { applyAssistantOps } from '../src/assistant_ops.mjs';

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-memory-autosave-'));
  const store = new StateStore(dir);
  store.init();
  return { dir, store };
}

function makeConfig() {
  return {
    defaultWorkdir: os.tmpdir(),
    defaultBackend: 'codex',
    codexCommandPrefix: 'codex -a never --search exec -s danger-full-access --skip-git-repo-check',
    claudeCommandPrefix: 'claude',
    opencodeCommandPrefix: 'opencode acp',
    authPassphrase: '',
    authTtlSeconds: 3600,
    defaultTimezone: 'Asia/Shanghai',
    enableMemory: true,
    memoryAutoSave: true,
    memoryMaxItems: 6,
    memoryMaxChars: 2400,
  };
}

test('state store keeps recent dialogue messages for memory analysis', () => {
  const { store } = makeTempStore();
  for (let index = 0; index < 8; index += 1) {
    store.appendConversationMessage('chat-1', index % 2 === 0 ? 'user' : 'assistant', `message-${index}`, { maxItems: 4 });
  }

  const rows = store.listConversationMessages('chat-1', { limit: 10 });
  assert.deepEqual(rows.map((row) => row.content), ['message-4', 'message-5', 'message-6', 'message-7']);
});

test('buildPrompt exposes memory ids and recent dialogue when auto memory is enabled', () => {
  const { store } = makeTempStore();
  store.ensureDefaultRoles('chat-1');
  store.addMemory({
    chatId: 'chat-1',
    scope: 'chat:chat-1',
    kind: 'preference',
    title: '默认中文',
    content: '以后默认中文回答',
    pinned: true,
  });
  store.appendConversationMessage('chat-1', 'user', '以后代码评审默认用 reviewer 角色', { maxItems: 6 });
  store.appendConversationMessage('chat-1', 'assistant', '好的，我会按 reviewer 方式给出结论。', { maxItems: 6 });

  const controller = new RuntimeController(makeConfig(), store);
  const prompt = controller.buildPrompt('chat-1', '帮我继续看这个仓库', 'telegram');

  assert.match(prompt, /\[MEMORY CONTEXT\]/);
  assert.match(prompt, /mem_/);
  assert.match(prompt, /\[RECENT DIALOGUE\]/);
  assert.match(prompt, /以后代码评审默认用 reviewer 角色/);
  assert.match(prompt, /You may emit rc-memory-ops even without an explicit remember request/);
});

test('memory upsert can refine an existing memory through query matching', async () => {
  const { store } = makeTempStore();
  const controller = new RuntimeController(makeConfig(), store);
  const existing = store.addMemory({
    chatId: 'chat-1',
    scope: 'chat:chat-1',
    kind: 'preference',
    title: '默认中文',
    content: '默认中文回答',
    tags: ['auto'],
  });

  const output = [
    '已记录。',
    '```rc-memory-ops',
    JSON.stringify({
      ops: [
        {
          op: 'upsert',
          query: '默认中文',
          kind: 'preference',
          title: '默认中文',
          content: '以后默认中文回答，回答尽量简洁。',
          tags: ['auto', 'language'],
          importance: 2,
        },
      ],
    }),
    '```',
  ].join('\n');

  const result = await applyAssistantOps({
    output,
    chatId: 'chat-1',
    request: {
      host: 'telegram',
      externalUserId: 'user-1',
      externalChatId: 'chat-1',
    },
    controller,
    store,
    scheduler: null,
    config: makeConfig(),
  });

  assert.equal(result.counts.memory, 1);
  assert.equal(store.countMemories('chat-1'), 1);
  const updated = store.getMemory('chat-1', existing.id);
  assert.equal(updated.content, '以后默认中文回答，回答尽量简洁。');
  assert.deepEqual(updated.tags, ['auto', 'language']);
  assert.equal(Number(updated.importance), 2);
});
