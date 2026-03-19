import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeClaudeSessionId } from '../src/claude-sdk-provider.mjs';

test('looksLikeClaudeSessionId accepts UUID session ids', () => {
  assert.equal(looksLikeClaudeSessionId('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(looksLikeClaudeSessionId('019caa3d-92a9-7470-928a-d4b194842062'), true);
});

test('looksLikeClaudeSessionId rejects non-UUID backend session ids', () => {
  assert.equal(looksLikeClaudeSessionId('ses_30010e511ffee3TLLxL2i1QyJ6'), false);
  assert.equal(looksLikeClaudeSessionId('thread_123'), false);
  assert.equal(looksLikeClaudeSessionId(''), false);
});
