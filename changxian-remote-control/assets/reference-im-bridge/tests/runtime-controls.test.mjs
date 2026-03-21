import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudePermissionPrefix,
  buildCodexPermissionPrefix,
  buildRuntimeControlState,
  detectClaudePermissionLevel,
  detectCodexPermissionLevel,
} from '../src/runtime-controls.mjs';

test('detectCodexPermissionLevel recognizes standard presets', () => {
  assert.equal(detectCodexPermissionLevel('codex -a on-request --search exec -s read-only --skip-git-repo-check'), 'readonly');
  assert.equal(detectCodexPermissionLevel('codex -a on-request --search exec -s workspace-write --skip-git-repo-check'), 'low');
  assert.equal(detectCodexPermissionLevel('codex -a never --search exec -s danger-full-access --skip-git-repo-check'), 'high');
});

test('buildCodexPermissionPrefix switches only the permission tier preset', () => {
  assert.equal(buildCodexPermissionPrefix('readonly', {}, '/custom/codex -a never -s danger-full-access'), '/custom/codex -a on-request --search exec -s read-only --skip-git-repo-check');
  assert.equal(buildCodexPermissionPrefix('high', {}, 'codex -a on-request -s workspace-write'), 'codex -a never --search exec -s danger-full-access --skip-git-repo-check');
});

test('detectClaudePermissionLevel recognizes supported modes', () => {
  assert.equal(detectClaudePermissionLevel('claude --permission-mode default'), 'default');
  assert.equal(detectClaudePermissionLevel('claude --permission-mode plan'), 'plan');
  assert.equal(detectClaudePermissionLevel('claude --permission-mode acceptEdits'), 'accept');
});

test('buildClaudePermissionPrefix preserves executable path', () => {
  assert.equal(buildClaudePermissionPrefix('plan', {}, '/opt/homebrew/bin/claude --permission-mode default'), '/opt/homebrew/bin/claude --permission-mode plan');
  assert.equal(buildClaudePermissionPrefix('accept', {}, 'claude'), 'claude --permission-mode acceptEdits');
});

test('buildRuntimeControlState reports backend-specific permission labels', () => {
  assert.equal(buildRuntimeControlState('codex', 'codex -a on-request --search exec -s workspace-write --skip-git-repo-check').permissionLabel, '标准');
  assert.equal(buildRuntimeControlState('claude', 'claude --permission-mode plan').permissionLabel, 'Plan');
  assert.equal(buildRuntimeControlState('opencode-acp', 'opencode acp').permissionLabel, '后端控制');
  assert.equal(buildRuntimeControlState('pi', 'pi --mode json').permissionLabel, '后端控制');
});
