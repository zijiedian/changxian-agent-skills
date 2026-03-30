import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWeComPayload } from '../src/render/index.mjs';

test('running wecom payload stays concise and keeps tool/check info', () => {
  const rendered = renderWeComPayload({
    status: 'Running',
    marker: 'exec',
    preview: {
      phase: 'exec',
      summary: '执行工具: read_file',
      content: '读取配置文件',
      highlights: ['读取配置文件'],
      checks: ['命令执行完成'],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
      proseMarkdown: '',
    },
    elapsedSeconds: 12,
  });

  assert.match(rendered.content, /执行工具: read_file/);
  assert.match(rendered.content, /命令执行完成/);
  assert.doesNotMatch(rendered.content, /\*\*/);
  assert.doesNotMatch(rendered.content, /变更节选/);
  assert.doesNotMatch(rendered.content, /\b00:12\b/);
  assert.doesNotMatch(rendered.content, /用时/);
});

test('final wecom payload prefers concise summary over verbose sections', () => {
  const rendered = renderWeComPayload({
    status: 'Done',
    marker: 'assistant',
    preview: {
      phase: 'assistant',
      summary: '找到 6 个任务，5 个启用，1 个暂停',
      content: '',
      highlights: ['github-trending-daily 尚未运行过', 'scan changxian-agent repos and auto commit 处于暂停'],
      checks: ['数据库读取成功'],
      changedFiles: [],
      notes: [],
      diffBlocks: [],
      proseMarkdown: '',
    },
  });

  assert.match(rendered.content, /找到 6 个任务，5 个启用，1 个暂停/);
  assert.match(rendered.content, /github-trending-daily 尚未运行过/);
  assert.match(rendered.content, /数据库读取成功/);
  assert.doesNotMatch(rendered.content, /变更节选/);
  assert.doesNotMatch(rendered.content, /还有 .*条摘要/);
});

test('wecom payload preserves direct string finals instead of falling back to placeholder', () => {
  const rendered = renderWeComPayload('Authentication successful\nValid for 12h');

  assert.match(rendered.content, /Authentication successful/);
  assert.match(rendered.content, /Valid for 12h/);
  assert.doesNotMatch(rendered.content, /暂无输出/);
});

test('wecom thinking payload matches telegram wording and omits elapsed time', () => {
  const rendered = renderWeComPayload({
    status: 'Running',
    marker: 'thinking',
    text: 'thinking...',
    elapsedSeconds: 7,
  });

  assert.match(rendered.content, /^[\-\\|/] Thinking$/);
  assert.doesNotMatch(rendered.content, /用时/);
  assert.doesNotMatch(rendered.content, /\b00:07\b/);
  assert.doesNotMatch(rendered.content, /Thinking\.\.\./);
});
