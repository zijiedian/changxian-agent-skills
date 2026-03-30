import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStructuredPreview, buildExecProgressMarkdown } from '../src/utils/utils.mjs';

test('command-only previews do not emit 执行命令 style summaries', () => {
  const preview = buildStructuredPreview('```bash\ngit status\n```', { status: 'Running', marker: 'exec' });
  assert.equal(preview.summary, '');
  assert.equal(preview.commandPreview, 'git status');
});

test('exec progress markdown keeps bash command but removes command summary text', () => {
  const preview = buildStructuredPreview('```bash\ngit status\n```', { status: 'Running', marker: 'exec' });
  const markdown = buildExecProgressMarkdown(preview, {});
  assert.equal(markdown.includes('执行命令'), false);
  assert.equal(markdown.includes('查看 Git 状态'), false);
  assert.equal(markdown.includes('```bash\ngit status\n```'), true);
});
