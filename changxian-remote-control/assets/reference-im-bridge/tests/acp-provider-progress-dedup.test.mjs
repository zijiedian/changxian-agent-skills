import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentAcpProvider } from '../src/acp-provider.mjs';

function createTestAgentScript() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-acp-agent-'));
  const scriptPath = path.join(tempDir, 'agent.mjs');
  const sdkPath = pathToFileURL(path.resolve(process.cwd(), 'node_modules/@agentclientprotocol/sdk/dist/acp.js')).href;
  const source = `
import * as acp from ${JSON.stringify(sdkPath)};
import { Readable, Writable } from 'node:stream';

class TestAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession() {
    return {
      sessionId: 'session-1',
    };
  }

  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'hello from agent',
        },
      },
    });
    return {
      stopReason: 'end_turn',
    };
  }

  async cancel() {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new TestAgent(connection), stream);
`.trim();
  fs.writeFileSync(scriptPath, `${source}\n`, 'utf8');
  return {
    scriptPath,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createProvider() {
  return new AgentAcpProvider(
    { enableSessionResume: false },
    (env) => env,
    { backend: 'test', displayName: 'Test' },
  );
}

test('runTask does not duplicate legacy progress updates when onEvent is provided', async () => {
  const agent = createTestAgentScript();
  const provider = createProvider();
  const events = [];
  const progressPayloads = [];

  try {
    const result = await provider.runTask({
      prompt: 'test',
      commandPrefix: `node ${agent.scriptPath}`,
      workingDirectory: process.cwd(),
      onEvent: async (event) => {
        events.push(event);
      },
      onProgress: async (payload) => {
        progressPayloads.push(payload);
      },
    });

    assert.match(result.output, /hello from agent/);
    assert.equal(events.length, 1);
    assert.equal(progressPayloads.length, 0);
  } finally {
    agent.cleanup();
  }
});

test('runTask still emits legacy progress updates when onEvent is absent', async () => {
  const agent = createTestAgentScript();
  const provider = createProvider();
  const progressPayloads = [];

  try {
    const result = await provider.runTask({
      prompt: 'test',
      commandPrefix: `node ${agent.scriptPath}`,
      workingDirectory: process.cwd(),
      onProgress: async (payload) => {
        progressPayloads.push(payload);
      },
    });

    assert.match(result.output, /hello from agent/);
    assert.equal(progressPayloads.length, 1);
    assert.equal(progressPayloads[0]?.marker, 'assistant');
    assert.match(String(progressPayloads[0]?.text || ''), /hello from agent/);
  } finally {
    agent.cleanup();
  }
});
