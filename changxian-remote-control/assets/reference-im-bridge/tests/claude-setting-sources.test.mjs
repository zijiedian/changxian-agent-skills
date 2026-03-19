import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClaudeSettingSources } from '../src/claude-sdk-provider.mjs';

test('resolveClaudeSettingSources falls back to user project local', () => {
  assert.deepEqual(resolveClaudeSettingSources(''), ['user', 'project', 'local']);
  assert.deepEqual(resolveClaudeSettingSources(' ,  '), ['user', 'project', 'local']);
});

test('resolveClaudeSettingSources parses explicit values', () => {
  assert.deepEqual(resolveClaudeSettingSources('user,project,local'), ['user', 'project', 'local']);
  assert.deepEqual(resolveClaudeSettingSources('user, local'), ['user', 'local']);
});
