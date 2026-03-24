import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { buildStructuredPreview, splitShellArgs, truncateText } from './utils.mjs';

const DEFAULT_DIAGNOSTICS = Object.freeze({
  backend: 'unknown',
  transport: 'acp',
  initialized: false,
  sdkModuleLoaded: false,
  agentName: '',
  agentVersion: '',
  authMethods: [],
  cliPath: '',
  lastInitError: '',
  lastResumeSkipReason: '',
  lastPermissionDecision: '',
  lastStopReason: '',
});

function supportImage(file) {
  return file && typeof file === 'object' && typeof file.type === 'string' && file.type.startsWith('image/') && typeof file.data === 'string';
}

function clipText(text, limit = 1200) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 13)).trimEnd()}\n\n[truncated]`;
}

function oneLine(text, limit = 140) {
  const value = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function selectPermissionOption(options = []) {
  return options.find((option) => option?.kind === 'allow_once')
    || options.find((option) => option?.kind === 'allow_always')
    || null;
}

function updatePayload(marker, text, status = 'Running') {
  const content = clipText(text, 1600);
  if (!content) return null;
  return {
    status,
    marker,
    text: oneLine(content, 120) || content,
    preview: buildStructuredPreview(content, { status, marker }),
  };
}

function extractToolContent(update) {
  const contentItems = Array.isArray(update?.content) ? update.content : [];
  const nested = contentItems
    .map((item) => item?.content?.text || item?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (nested) return nested;
  const rawOutput = update?.rawOutput?.output;
  if (rawOutput) return String(rawOutput).trim();
  const rawInput = update?.rawInput;
  if (rawInput?.command) return `${rawInput.command}`;
  return '';
}

function payloadFromSessionUpdate(update) {
  if (!update || typeof update !== 'object') return null;

  if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
    return updatePayload('thinking', update.content.text);
  }

  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    return updatePayload('assistant', update.content.text);
  }

  if (update.sessionUpdate === 'tool_call') {
    const summary = [String(update.title || 'tool').trim(), String(update.status || '').trim()].filter(Boolean).join(' · ');
    return updatePayload('exec', summary || '工具调用中');
  }

  if (update.sessionUpdate === 'tool_call_update') {
    const header = [String(update.title || update.rawInput?.description || update.rawInput?.command || 'tool').trim(), String(update.status || '').trim()].filter(Boolean).join(' · ');
    const detail = extractToolContent(update);
    return updatePayload('exec', [header, detail].filter(Boolean).join('\n'));
  }

  if (update.sessionUpdate === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const lines = entries
      .map((entry) => `- ${String(entry?.content || entry?.title || '').trim()}`.trim())
      .filter((line) => line !== '-');
    return updatePayload('thinking', ['执行计划', ...lines].join('\n'));
  }

  if (update.sessionUpdate === 'current_mode_update') {
    return updatePayload('thinking', `模式切换: ${String(update.mode?.name || update.modeId || '').trim()}`);
  }

  return null;
}

function createPromptBlocks(prompt, files = []) {
  const blocks = [];
  const text = String(prompt || '').trim();
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const file of files.filter(supportImage)) {
    blocks.push({
      type: 'image',
      data: file.data,
      mimeType: file.type,
      uri: file.name || file.filename || undefined,
    });
  }
  return blocks;
}

function readPartialTextFile(filePath, line = null, limit = null) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const startIndex = Math.max(0, Number(line || 1) - 1);
  const endIndex = limit == null ? lines.length : Math.max(startIndex, startIndex + Number(limit || 0));
  return lines.slice(startIndex, endIndex).join('\n');
}

async function waitForExit(child, timeoutMs = 3000) {
  if (!child || child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

class BridgeAcpClient {
  constructor(provider, context) {
    this.provider = provider;
    this.context = context;
  }

  async requestPermission(params) {
    if (typeof this.context.onPermissionRequest === 'function') {
      return this.context.onPermissionRequest(params, { signal: this.context.abortSignal });
    }
    const option = selectPermissionOption(params?.options || []);
    const message = option
      ? `自动授权: ${option.name || option.kind || option.optionId}`
      : '权限请求已取消';
    this.provider.diagnostics = {
      ...this.provider.diagnostics,
      lastPermissionDecision: message,
    };
    const payload = updatePayload('exec', message);
    if (payload) await this.context.onProgress?.(payload);
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params) {
    const update = params?.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.context.assistantParts.push(String(update.content.text || ''));
    }
    const payload = payloadFromSessionUpdate(update);
    if (payload) await this.context.onProgress?.(payload);
  }

  async writeTextFile(params) {
    const target = path.resolve(String(params?.path || '').trim());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(params?.content || ''), 'utf8');
    return {};
  }

  async readTextFile(params) {
    const target = path.resolve(String(params?.path || '').trim());
    return {
      content: readPartialTextFile(target, params?.line, params?.limit),
    };
  }
}

export class AgentAcpProvider {
  constructor(config, buildExecutionEnv, options = {}) {
    this.config = config;
    this.buildExecutionEnv = buildExecutionEnv;
    this.options = {
      backend: options.backend || 'unknown',
      displayName: options.displayName || 'ACP',
      authHint: typeof options.authHint === 'function' ? options.authHint : (() => ''),
    };
    this.sdkModule = null;
    this.initPromise = null;
    this.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      backend: this.options.backend,
    };
  }

  getDiagnostics() {
    return {
      ...this.diagnostics,
      authMethods: [...(this.diagnostics.authMethods || [])],
    };
  }

  async ensureSdk() {
    if (this.sdkModule) return this.sdkModule;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          this.sdkModule = await import('@agentclientprotocol/sdk');
          this.diagnostics = {
            ...this.diagnostics,
            sdkModuleLoaded: true,
            lastInitError: '',
          };
          return this.sdkModule;
        } catch (error) {
          const detail = error?.message || String(error);
          this.diagnostics = {
            ...this.diagnostics,
            sdkModuleLoaded: false,
            initialized: false,
            lastInitError: detail,
          };
          throw new Error(`${this.options.displayName} ACP SDK init failed: ${detail}`);
        }
      })();
    }

    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  async runTask(params) {
    const {
      prompt,
      commandPrefix,
      workingDirectory,
      sessionId,
      abortSignal,
      onProgress,
      onPermissionRequest,
      files = [],
    } = params;

    const acp = await this.ensureSdk();
    const args = splitShellArgs(commandPrefix);
    if (!args.length) throw new Error(`${this.options.displayName} ACP command prefix is empty`);

    const executable = args[0];
    const spawnArgs = args.slice(1);
    const child = spawn(executable, spawnArgs, {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildExecutionEnv(process.env),
    });
    this.diagnostics = {
      ...this.diagnostics,
      cliPath: executable,
    };

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-12000);
    });

    const context = {
      assistantParts: [],
      onProgress,
      onPermissionRequest,
      abortSignal,
    };
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = new acp.ClientSideConnection(() => new BridgeAcpClient(this, context), stream);

    let activeSessionId = String(sessionId || '').trim();
    const initialSessionId = activeSessionId;
    const promptBlocks = createPromptBlocks(prompt, files);
    const abortHandler = () => {
      if (!activeSessionId) {
        child.kill('SIGINT');
        return;
      }
      connection.cancel({ sessionId: activeSessionId }).catch(() => {});
      child.kill('SIGINT');
    };

    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    try {
      const init = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });

      this.diagnostics = {
        ...this.diagnostics,
        initialized: true,
        agentName: String(init?.agentInfo?.name || this.options.displayName),
        agentVersion: String(init?.agentInfo?.version || '').trim(),
        authMethods: Array.isArray(init?.authMethods) ? init.authMethods.map((item) => String(item?.id || '').trim()).filter(Boolean) : [],
        lastInitError: '',
      };

      let sessionResponse = null;
      if (activeSessionId && this.config.enableSessionResume && init?.agentCapabilities?.sessionCapabilities?.resume) {
        try {
          sessionResponse = await connection.unstable_resumeSession({
            sessionId: activeSessionId,
            cwd: workingDirectory,
            mcpServers: [],
          });
        } catch (error) {
          const detail = error?.message || String(error);
          this.diagnostics = {
            ...this.diagnostics,
            lastResumeSkipReason: detail,
          };
          activeSessionId = '';
        }
      }

      if (!sessionResponse) {
        sessionResponse = await connection.newSession({
          cwd: workingDirectory,
          mcpServers: [],
        });
      }
      activeSessionId = String(sessionResponse?.sessionId || activeSessionId || '').trim();

      const result = await connection.prompt({
        sessionId: activeSessionId,
        prompt: promptBlocks,
      });

      this.diagnostics = {
        ...this.diagnostics,
        lastStopReason: String(result?.stopReason || '').trim(),
      };

      return {
        sessionId: activeSessionId,
        output: context.assistantParts.join('').trim(),
        usage: result?.usage || null,
      };
    } catch (error) {
      const detail = error?.message || String(error);
      const stderrSummary = truncateText(stderr, 500);
      const authHint = this.options.authHint(detail, stderrSummary);
      this.diagnostics = {
        ...this.diagnostics,
        initialized: false,
        lastInitError: detail,
      };
      throw new Error(`${this.options.displayName} ACP run failed: ${detail}${stderrSummary ? `\n${stderrSummary}` : ''}${authHint}`.trim());
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler);
      child.kill('SIGINT');
      await waitForExit(child);
      if (initialSessionId && initialSessionId !== activeSessionId) {
        this.diagnostics = {
          ...this.diagnostics,
          lastResumeSkipReason: '',
        };
      }
    }
  }
}
