import test from 'node:test';
import assert from 'node:assert/strict';

import { autoApprovePermissionRequest, formatToolOutput } from '../src/acp-provider.mjs';

test('autoApprovePermissionRequest allows trusted read access within workdir', () => {
  const decision = autoApprovePermissionRequest({
    toolCall: {
      kind: 'read',
      locations: [{ path: '/workspace/project/src/index.ts' }],
      rawInput: { path: '/workspace/project/src/index.ts' },
    },
    options: [
      { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
    ],
  }, {
    config: {
      permissionAutoApproveTrustedReads: true,
      permissionTrustedRoots: [],
      stateDir: '/bridge/state',
    },
    workingDirectory: '/workspace/project',
  });

  assert.equal(decision?.option?.optionId, 'allow-1');
  assert.match(String(decision?.reason || ''), /trusted/i);
});

test('autoApprovePermissionRequest rejects edits even inside trusted roots', () => {
  const decision = autoApprovePermissionRequest({
    toolCall: {
      kind: 'edit',
      locations: [{ path: '/workspace/project/src/index.ts' }],
      rawInput: { path: '/workspace/project/src/index.ts' },
    },
    options: [
      { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
    ],
  }, {
    config: {
      permissionAutoApproveTrustedReads: true,
      permissionTrustedRoots: [],
      stateDir: '/bridge/state',
    },
    workingDirectory: '/workspace/project',
  });

  assert.equal(decision, null);
});

test('autoApprovePermissionRequest does not allow trusted reads outside configured roots', () => {
  const decision = autoApprovePermissionRequest({
    toolCall: {
      kind: 'read',
      locations: [{ path: '/private/secrets/notes.txt' }],
      rawInput: { path: '/private/secrets/notes.txt' },
    },
    options: [
      { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
    ],
  }, {
    config: {
      permissionAutoApproveTrustedReads: true,
      permissionTrustedRoots: ['/workspace/project'],
      stateDir: '/bridge/state',
    },
    workingDirectory: '/workspace/project',
  });

  assert.equal(decision, null);
});

test('formatToolOutput removes key labels and localizes status text', () => {
  const output = formatToolOutput({
    kind: 'tool',
    title: 'read_file',
    rawInput: {
      path: '/tmp/demo.txt',
      limit: 20,
      options: {
        mode: 'text',
      },
    },
    status: 'Running',
  });

  assert.equal(output, 'tool\nread_file\n/tmp/demo.txt\n20\ntext\n执行中');
  assert.doesNotMatch(output, /kind:|title:|Running|in_progress|⏳/);
});
