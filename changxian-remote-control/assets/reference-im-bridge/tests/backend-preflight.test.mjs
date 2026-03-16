import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { runCommandPreflight } from '../src/preflight.mjs';

test('runCommandPreflight recognizes opencode acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'opencode acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'opencode-acp');
});

test('runCommandPreflight recognizes npx opencode acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'npx -y opencode-ai acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'opencode-acp');
});
