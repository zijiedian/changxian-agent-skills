import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommandPreflight } from '../src/utils/preflight.mjs';

test('runCommandPreflight recognizes opencode acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'opencode acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'opencode-acp');
});

test('runCommandPreflight recognizes codex acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'codex-acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'codex');
});

test('runCommandPreflight recognizes claude agent acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'claude-agent-acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'claude');
});

test('runCommandPreflight recognizes pi acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'pi-acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'pi');
});

test('runCommandPreflight recognizes npx opencode acp backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'npx -y opencode-ai acp',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'opencode-acp');
});

test('runCommandPreflight recognizes claude backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'claude',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'claude');
});

test('runCommandPreflight recognizes pi backend', () => {
  const result = runCommandPreflight({
    commandPrefix: 'pi --mode json',
    workdir: os.tmpdir(),
    includeAuthProbe: false,
  });

  assert.equal(result.backend, 'pi');
});

test('runCommandPreflight accepts a working claude executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-claude-preflight-'));
  const executable = path.join(dir, 'claude');
  fs.writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "claude 2.0.0"',
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  echo "loggedIn: true"',
      '  exit 0',
      'fi',
      'echo "ok"',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = runCommandPreflight({
    commandPrefix: executable,
    workdir: os.tmpdir(),
    includeAuthProbe: true,
  });

  assert.equal(result.backend, 'claude');
  assert.equal(result.ok, true);
  assert.equal(result.resolvedPath, executable);
  assert.match(result.version, /claude 2\.0\.0/);
  assert.match(result.auth, /loggedIn: true/);
});
