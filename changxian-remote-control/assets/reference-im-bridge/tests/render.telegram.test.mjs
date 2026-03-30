import test from 'node:test';
import assert from 'node:assert/strict';

import * as renderIndex from '../src/render/index.mjs';
import { renderTelegramPayload } from '../src/render/telegram-renderer.mjs';

test('render.telegram exports helper APIs consumed by the telegram adapter', () => {
  assert.equal(typeof renderIndex.TelegramRenderer, 'function');
  assert.equal(typeof renderIndex.BaseRenderer, 'function');
  assert.equal(typeof renderIndex.createRenderer, 'function');
  assert.equal(typeof renderIndex.MessageTransformer, 'function');
});

test('render.telegram preserves direct string finals instead of placeholder html', () => {
  const rendered = renderTelegramPayload({ status: 'Done', text: 'Authentication successful\nValid for 12h' });

  assert.match(rendered.html, /Authentication successful/);
  assert.match(rendered.html, /Valid for 12h/);
  assert.doesNotMatch(rendered.html, /暂无输出/);
});
