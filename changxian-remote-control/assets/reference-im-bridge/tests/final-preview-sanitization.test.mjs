import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizePreview } from '../src/utils/utils.mjs';

test('sanitizePreview strips inline thinking trace from final output and keeps the answer', () => {
  const output = 'thinking用户说“hello”，这是一个简单的问候。我应该用中文回复（根据记忆中的偏好设置），并且作为研究助手，我可以简短地打招呼并询问有什么可以帮助的。\n\n让我保持简洁和行动导向。reasoning你好！我是尝鲜AGENT，你的私人助理。\n\n有什么我可以帮你的吗？';

  const sanitized = sanitizePreview(output, 'Done');

  assert.equal(sanitized.includes('thinking用户说'), false);
  assert.equal(sanitized.includes('reasoning你好'), false);
  assert.equal(sanitized, '你好！我是尝鲜AGENT，你的私人助理。\n\n有什么我可以帮你的吗？');
});

test('sanitizePreview strips leaked skill inventory from pi final output', () => {
  const output = '## Skills\n- /Users/wanwenjie/.pi/agent/skills/shadcn/SKILL.md\n- /Users/wanwenjie/.pi/agent/skills/pi-skills/youtube-transcript/SKILL.md\n\n你好！我是尝鲜AGENT，你的私人助理。\n\n有什么我可以帮你的吗？';

  const sanitized = sanitizePreview(output, 'Done');

  assert.equal(sanitized.includes('## Skills'), false);
  assert.equal(sanitized.includes('SKILL.md'), false);
  assert.equal(sanitized, '你好！我是尝鲜AGENT，你的私人助理。\n\n有什么我可以帮你的吗？');
});
