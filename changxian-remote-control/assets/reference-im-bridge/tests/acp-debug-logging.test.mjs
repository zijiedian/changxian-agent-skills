import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Helper: run a script with environment variables and capture stderr
function runWithEnv(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--no-warnings', '--input-type=module', '-e', script], {
      cwd: '/Users/wanwenjie/projects/changxian-agent/changxian-agent-skills/changxian-remote-control/assets/reference-im-bridge',
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', reject);
  });
}

test('ACP_DEBUG=1 enables sessionUpdate debug logging', async () => {
  const script = `
import { triggerDebugLog } from '../src/agent/base.mjs';
triggerDebugLog('sessionUpdate', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
`.trim();

  const result = await runWithEnv(script, { ACP_DEBUG: '1' });

  assert.ok(result.stderr.includes('[ACP-DEBUG]'), 'Should output [ACP-DEBUG] prefix');
  assert.ok(result.stderr.includes('sessionUpdate triggered'), 'Should log sessionUpdate event');
  assert.ok(result.stderr.includes('agent_message_chunk'), 'Should include actual update type');
  assert.ok(result.stderr.includes('hello'), 'Should include content text');
});

test('ACP_DEBUG=1 enables permission request debug logging', async () => {
  const script = `
import { triggerDebugLog } from '../src/agent/base.mjs';
triggerDebugLog('requestPermission', {
  toolCall: { kind: 'read', locations: [{ path: '/test/file.txt' }] },
  options: [{ optionId: 'test-opt', kind: 'allow_once' }]
});
`.trim();

  const result = await runWithEnv(script, { ACP_DEBUG: '1' });

  assert.ok(result.stderr.includes('[ACP-DEBUG]'), 'Should output [ACP-DEBUG] prefix');
  assert.ok(result.stderr.includes('requestPermission triggered'), 'Should log permission event');
  assert.ok(result.stderr.includes('/test/file.txt'), 'Should include path from request');
  assert.ok(result.stderr.includes('allow_once'), 'Should include option kind');
});

test('isDebugMode returns true when ACP_DEBUG=1', async () => {
  const script = `
import { isDebugMode } from '../src/agent/base.mjs';
console.error('[DEBUG-MODE]', isDebugMode());
`.trim();

  const result = await runWithEnv(script, { ACP_DEBUG: '1' });

  assert.ok(result.stderr.includes('[DEBUG-MODE] true'), 'Should report debug mode enabled');
});

test('Without ACP_DEBUG, no debug logs are emitted', async () => {
  const script = `import { triggerDebugLog, isDebugMode } from '../src/agent/base.mjs';
console.error('[DEBUG-MODE]', isDebugMode());
triggerDebugLog('sessionUpdate', { test: true });`;

  const result = await runWithEnv(script, {});

  assert.ok(!result.stderr.includes('[ACP-DEBUG]'), 'Should NOT output [ACP-DEBUG] when disabled');
  // Check for either format: "[DEBUG-MODE] false" or "DEBUG-MODE false"
  assert.ok(result.stderr.includes('false'), 'Should report debug mode disabled');
});

test('Debug output includes full JSON structure', async () => {
  const script = `
import { triggerDebugLog } from '../src/agent/base.mjs';
triggerDebugLog('sessionUpdate', {
  sessionUpdate: 'tool_call',
  kind: 'read',
  title: 'read_file',
  rawInput: { path: '/etc/passwd', limit: 10 },
  status: 'running'
});
`.trim();

  const result = await runWithEnv(script, { ACP_DEBUG: '1' });

  assert.ok(result.stderr.includes('"path": "/etc/passwd"'), 'Should include nested path');
  assert.ok(result.stderr.includes('"limit": 10'), 'Should include limit value');
  assert.ok(result.stderr.includes('"status": "running"'), 'Should include status');
});
