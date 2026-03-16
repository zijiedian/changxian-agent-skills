import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStructuredPreview } from '../src/utils.mjs';

test('buildStructuredPreview does not summarize command activity as 执行命令', () => {
  const preview = buildStructuredPreview('执行命令：git status', { status: 'Running', marker: 'exec' });
  assert.notEqual(preview.summary, '执行命令');
  assert.notEqual(preview.summary, '命令执行完成');
  assert.equal(/^正在执行命令/.test(String(preview.summary || '')), false);
});
