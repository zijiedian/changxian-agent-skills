import test from 'node:test';
import assert from 'node:assert/strict';

import * as renderTelegram from '../src/render.telegram.mjs';

test('render.telegram exports helper APIs consumed by the telegram adapter', () => {
  assert.equal(typeof renderTelegram.buildPreviewSummaryMarkdown, 'function');
  assert.equal(typeof renderTelegram.buildStructuredPreview, 'function');
  assert.equal(typeof renderTelegram.previewHasProgressDetails, 'function');
  assert.equal(typeof renderTelegram.truncateText, 'function');
});

test('render.telegram preserves direct string finals instead of placeholder html', () => {
  const rendered = renderTelegram.renderTelegramPayload('Authentication successful\nValid for 12h');

  assert.match(rendered.html, /Authentication successful/);
  assert.match(rendered.html, /Valid for 12h/);
  assert.doesNotMatch(rendered.html, /暂无输出/);
});
