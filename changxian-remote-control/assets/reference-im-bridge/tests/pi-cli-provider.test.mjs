import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PiCliProvider } from '../src/pi-cli-provider.mjs';

function makeTempPiCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-provider-'));
  const file = path.join(dir, 'pi');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "pi 0.60.0"',
    '  exit 0',
    'fi',
    'printf \'{"type":"session","id":"pi-session-123"}\\n\'',
    'printf \'{"type":"thinking_delta","delta":"用户说 hello，我应该先打招呼。"}\\n\'',
    'printf \'{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}\\n\'',
    'printf \'{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":" Pi"}}\\n\'',
    'printf \'{"type":"tool_execution_start","toolName":"read","args":{"path":"README.md"}}\\n\'',
    'printf \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"用户说 hello，我应该先打招呼。"},{"type":"text","text":"Hello Pi"}]}}\\n\'',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

test('pi cli provider parses session id, text deltas, and final output', async () => {
  const executable = makeTempPiCli();
  const progress = [];
  const provider = new PiCliProvider({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-state-')),
    piExecutable: executable,
  }, (env) => env);

  const result = await provider.runTask({
    prompt: 'hello',
    commandPrefix: `${executable} --mode json`,
    workingDirectory: os.tmpdir(),
    sessionId: '',
    abortSignal: null,
    onProgress: async (payload) => {
      progress.push(payload);
    },
    files: [],
  });

  assert.equal(result.sessionId, 'pi-session-123');
  assert.equal(result.output, 'Hello Pi');
  assert.equal(progress.some((entry) => entry.marker === 'thinking'), true);
  assert.equal(progress.some((entry) => entry.preview?.phase === 'thinking' && /用户说 hello/.test(String(entry.preview?.content || ''))), true);
  assert.equal(progress.some((entry) => entry.marker === 'exec' && /read/.test(String(entry.text || ''))), true);
});

test('pi cli provider retries fresh session when saved session is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-provider-retry-'));
  const file = path.join(dir, 'pi');
  const stateFile = path.join(dir, 'retry-state');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `STATE_FILE="${stateFile}"`,
    'if [ "$1" = "--version" ]; then',
    '  echo "pi 0.60.0"',
    '  exit 0',
    'fi',
    'HAS_SESSION=0',
    'SESSION_ID=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--session" ]; then',
    '    HAS_SESSION=1',
    '    SESSION_ID="$2"',
    '    break',
    '  fi',
    '  shift',
    'done',
    'if [ ! -f "$STATE_FILE" ] && [ "$HAS_SESSION" -eq 1 ]; then',
    '  touch "$STATE_FILE"',
    `  echo "No session found matching '$SESSION_ID'" >&2`,
    '  exit 1',
    'fi',
    'printf \'{"type":"session","id":"pi-session-fresh"}\\n\'',
    'printf \'{"type":"message_end","message":{"role":"assistant","content":"Fresh run ok"}}\\n\'',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const provider = new PiCliProvider({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-state-')),
    piExecutable: file,
  }, (env) => env);

  const result = await provider.runTask({
    prompt: 'hello',
    commandPrefix: `${file} --mode json`,
    workingDirectory: os.tmpdir(),
    sessionId: '019d039b-55fb-7b70-bddb-e9297a70fc3f',
    abortSignal: null,
    onProgress: async () => {},
    files: [],
  });

  assert.equal(result.sessionId, 'pi-session-fresh');
  assert.equal(result.output, 'Fresh run ok');
  assert.match(provider.getDiagnostics().lastResumeSkipReason, /No session found matching/i);
});
