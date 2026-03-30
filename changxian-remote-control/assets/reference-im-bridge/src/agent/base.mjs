import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { buildStructuredPreview, splitShellArgs, truncateText } from '../utils/utils.mjs';

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

// 调试日志开关 - 可通过环境变量 ACP_DEBUG=1 开启
const DEBUG_ENABLED = process.env.ACP_DEBUG === '1';

function debugLog(...args) {
  if (DEBUG_ENABLED) {
    console.error('[ACP-DEBUG]', new Date().toISOString(), ...args);
  }
}

function supportImage(file) {
  return file && typeof file === 'object' && typeof file.type === 'string' && file.type.startsWith('image/') && typeof file.data === 'string';
}

function clipText(text, limit = 1200) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 13)).trimEnd()}\n\n[truncated]`;
}

// 检测内容是否为代码
function isCodeContent(text) {
  if (!text || typeof text !== 'string') return false;
  const codePatterns = [
    /^(import|export|const|let|var|function|class|interface|type|enum|def|fn|pub|struct|impl|async|await|return|if|else|for|while|switch|case|try|catch|throw|new|this|self|->|=>)\s/m,
    /^\s*(import|from|require|include|#include|using|namespace|package)\s/m,
    /^\s*(\/{2,}|\/\*|#|<!--)/m,
    /^\s*(\.[a-zA-Z]|\$\(|@|@@|#)\w/m,
    /^(function\s+\w+|def\s+\w+|fn\s+\w+|func\s+\w+|class\s+\w+)/m,
  ];
  const lines = text.split('\n');
  if (lines.length < 1) return false;
  // 如果有多行且大部分行以缩进开头，可能是代码
  const indentedLines = lines.filter(line => /^\s{2,}\S/.test(line));
  if (lines.length > 2 && indentedLines.length / lines.length > 0.3) return true;
  // 如果匹配代码模式
  return codePatterns.some(pattern => pattern.test(text));
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

function selectPreferredPermissionOption(options = [], preferredKind = 'allow_once') {
  const normalized = String(preferredKind || '').trim().toLowerCase();
  return options.find((option) => String(option?.kind || '').trim().toLowerCase() === normalized)
    || selectPermissionOption(options);
}

function pushResolvedPath(targets, candidate, workingDirectory = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return;
  const base = String(workingDirectory || '').trim() || process.cwd();
  const resolved = path.resolve(base, raw);
  if (!targets.includes(resolved)) targets.push(resolved);
}

function extractPermissionPaths(request, workingDirectory = '') {
  const targets = [];
  const toolCall = request?.toolCall || {};
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  for (const location of locations) {
    pushResolvedPath(targets, location?.path, workingDirectory);
  }

  const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const pathKeys = ['path', 'cwd', 'root', 'directory', 'fromPath', 'toPath', 'oldPath', 'newPath', 'targetPath', 'sourcePath', 'destinationPath'];
  for (const key of pathKeys) {
    pushResolvedPath(targets, rawInput[key], workingDirectory);
  }

  return targets;
}

function normalizeTrustedRoots(config = {}, workingDirectory = '') {
  const roots = [];
  pushResolvedPath(roots, workingDirectory, workingDirectory);
  pushResolvedPath(roots, config?.stateDir, workingDirectory);
  const extraRoots = Array.isArray(config?.permissionTrustedRoots) ? config.permissionTrustedRoots : [];
  for (const root of extraRoots) pushResolvedPath(roots, root, workingDirectory);
  return roots;
}

function isPathWithinRoot(targetPath, rootPath) {
  const target = path.resolve(String(targetPath || '').trim());
  const root = path.resolve(String(rootPath || '').trim());
  if (!target || !root) return false;
  if (target === root) return true;
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function autoApprovePermissionRequest(request, { config = {}, workingDirectory = '' } = {}) {
  if (!config?.permissionAutoApproveTrustedReads) return null;

  const kind = String(request?.toolCall?.kind || '').trim().toLowerCase();
  if (!['read', 'search', 'fetch'].includes(kind)) return null;

  const paths = extractPermissionPaths(request, workingDirectory);
  if (!paths.length) return null;

  const roots = normalizeTrustedRoots(config, workingDirectory);
  if (!roots.length) return null;

  const trusted = paths.every((target) => roots.some((root) => isPathWithinRoot(target, root)));
  if (!trusted) return null;

  const option = selectPreferredPermissionOption(request?.options || [], config?.permissionAutoApproveOptionKind || 'allow_once');
  if (!option) return null;

  return {
    option,
    reason: `trusted-${kind}-within-root`,
    paths,
    roots,
  };
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

function localizeToolStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['pending'].includes(normalized)) return '准备中';
  if (['running', 'in_progress', 'in progress'].includes(normalized)) return '执行中';
  if (['done', 'completed', 'complete', 'succeeded', 'success'].includes(normalized)) return '已完成';
  if (['failed', 'error'].includes(normalized)) return '失败';
  return String(status || '').trim();
}

function appendDisplayValues(target, seen, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => appendDisplayValues(target, seen, item));
    return;
  }
  if (typeof value === 'object') {
    const values = Object.values(value);
    if (!values.length) return;
    values.forEach((item) => appendDisplayValues(target, seen, item));
    return;
  }
  const text = String(value).trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  target.push(text);
}

function formatRawInputValues(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return '';
  const parts = [];
  const seen = new Set();

  appendDisplayValues(parts, seen, rawInput.description);
  appendDisplayValues(parts, seen, rawInput.command);

  const pathKeys = ['path', 'cwd', 'root', 'directory', 'fromPath', 'toPath', 'oldPath', 'newPath', 'targetPath', 'sourcePath', 'destinationPath', 'file', 'filePath', 'target', 'source', 'destination'];
  for (const key of pathKeys) {
    appendDisplayValues(parts, seen, rawInput[key]);
  }

  const skipKeys = ['description', 'command', ...pathKeys];
  const otherKeys = Object.keys(rawInput).filter((key) => !skipKeys.includes(key) && rawInput[key] !== undefined && rawInput[key] !== null);
  for (const key of otherKeys) {
    appendDisplayValues(parts, seen, rawInput[key]);
  }

  return parts.join('\n');
}

export function formatToolOutput(update) {
  const lines = [];
  const seen = new Set();

  appendDisplayValues(lines, seen, update?.kind);
  appendDisplayValues(lines, seen, update?.title);

  // 内容
  const content = extractToolContent(update);
  if (content) {
    if (isCodeContent(content)) {
      lines.push('```');
      lines.push(content);
      lines.push('```');
    } else {
      lines.push(content);
    }
  }
  
  // 原始输入（如果内容为空则显示）
  if (!content) {
    const rawInputFormatted = formatRawInputValues(update.rawInput);
    if (rawInputFormatted) {
      if (isCodeContent(rawInputFormatted)) {
        lines.push('```');
        lines.push(rawInputFormatted);
        lines.push('```');
      } else {
        lines.push(rawInputFormatted);
      }
    }
  }
  
  appendDisplayValues(lines, seen, localizeToolStatus(update?.status));

  return lines.join('\n');
}

function normalizePlanEntries(entries = []) {
  return entries
    .map((entry) => ({
      content: String(entry?.content || entry?.title || '').trim(),
      status: String(entry?.status || 'pending').trim() || 'pending',
      priority: entry?.priority ? String(entry.priority).trim() : undefined,
    }))
    .filter((entry) => entry.content);
}

function normalizedToolEvent(update, type) {
  const kind = String(update?.kind || '').trim();
  const name = String(update?.title || update?.name || kind || 'Tool').trim() || 'Tool';
  const status = String(update?.status || (type === 'tool_call' ? 'pending' : 'in_progress')).trim() || 'pending';
  const rawInput = update?.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};
  const content = extractToolContent(update);
  const displaySummary = formatToolOutput(update) || content || name;
  const displayTitle = [name, localizeToolStatus(status)].filter(Boolean).join(' · ');
  return {
    type,
    id: String(update?.toolCallId || update?.id || '').trim(),
    name,
    kind,
    status,
    content,
    rawInput,
    locations: Array.isArray(update?.locations) ? update.locations : Array.isArray(update?.toolCall?.locations) ? update.toolCall.locations : [],
    meta: {
      displaySummary,
      displayTitle,
      displayKind: kind,
    },
  };
}

export function eventFromSessionUpdate(update) {
  if (!update || typeof update !== 'object') return null;

  if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
    return { type: 'thought', content: String(update.content.text || '') };
  }

  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    return { type: 'text', content: String(update.content.text || '') };
  }

  if (update.sessionUpdate === 'tool_call') {
    return normalizedToolEvent(update, 'tool_call');
  }

  if (update.sessionUpdate === 'tool_call_update') {
    return normalizedToolEvent(update, 'tool_update');
  }

  if (update.sessionUpdate === 'plan') {
    return {
      type: 'plan',
      entries: normalizePlanEntries(Array.isArray(update.entries) ? update.entries : []),
    };
  }

  if (update.sessionUpdate === 'current_mode_update') {
    return {
      type: 'current_mode_update',
      modeId: String(update.modeId || update.mode?.id || update.mode?.name || '').trim(),
      mode: update.mode || null,
    };
  }

  if (update.sessionUpdate === 'model_update') {
    return {
      type: 'model_update',
      modelId: String(update.modelId || update.model?.id || update.model?.name || '').trim(),
    };
  }

  if (update.sessionUpdate === 'session_info_update') {
    return {
      type: 'session_info_update',
      title: String(update.title || '').trim(),
      updatedAt: update.updatedAt || update.timestamp || '',
    };
  }

  if (update.sessionUpdate === 'config_option_update') {
    return {
      type: 'config_option_update',
      options: Array.isArray(update.options) ? update.options : [],
    };
  }

  if (update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text') {
    return {
      type: 'user_message_chunk',
      content: String(update.content.text || ''),
    };
  }

  if (update.sessionUpdate === 'resource_content') {
    return {
      type: 'resource_content',
      name: String(update.name || '').trim(),
      uri: String(update.uri || '').trim(),
      text: update.text ? String(update.text) : '',
      blob: update.blob || null,
      mimeType: String(update.mimeType || '').trim(),
    };
  }

  if (update.sessionUpdate === 'resource_link') {
    return {
      type: 'resource_link',
      name: String(update.name || update.title || '').trim(),
      uri: String(update.uri || '').trim(),
      mimeType: String(update.mimeType || '').trim(),
      title: String(update.title || '').trim(),
      description: String(update.description || '').trim(),
      size: update.size,
    };
  }

  if (update.sessionUpdate === 'usage') {
    return {
      type: 'usage',
      tokensUsed: Number(update.tokensUsed || update.usage?.tokensUsed || 0) || 0,
      contextSize: Number(update.contextSize || update.usage?.contextSize || 0) || 0,
      cost: update.cost || update.usage?.cost || null,
    };
  }

  if (update.sessionUpdate === 'commands_update') {
    return {
      type: 'commands_update',
      commands: Array.isArray(update.commands) ? update.commands : [],
    };
  }

  if (update.sessionUpdate === 'system_message') {
    return {
      type: 'system_message',
      message: String(update.message || update.content?.text || '').trim(),
    };
  }

  if (update.sessionUpdate === 'error') {
    return {
      type: 'error',
      message: String(update.message || update.error || '').trim(),
    };
  }

  return null;
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
    // 简化显示: kind/title代码块, path/内容, 状态图标
    const output = formatToolOutput(update);
    return updatePayload('exec', output || 'tool');
  }

  if (update.sessionUpdate === 'tool_call_update') {
    // 简化显示: kind/title代码块, path/内容, 状态图标
    const output = formatToolOutput(update);
    return updatePayload('exec', output || '工具执行中...');
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
    // 调试日志: 打印原始 permission request JSON
    debugLog('requestPermission received:', JSON.stringify(params, null, 2));

    const autoApproval = autoApprovePermissionRequest(params, {
      config: this.provider.config,
      workingDirectory: this.context.workingDirectory,
    });
    if (autoApproval?.option) {
      this.provider.diagnostics = {
        ...this.provider.diagnostics,
        lastPermissionDecision: `自动授权(${autoApproval.reason}): ${autoApproval.option.name || autoApproval.option.kind || autoApproval.option.optionId}`,
      };
      return {
        outcome: {
          outcome: 'selected',
          optionId: autoApproval.option.optionId,
        },
      };
    }

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
    // 调试日志: 打印原始 sessionUpdate JSON
    debugLog('sessionUpdate received:', JSON.stringify(params, null, 2));

    const update = params?.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.context.assistantParts.push(String(update.content.text || ''));
    }

    const event = eventFromSessionUpdate(update);
    const hasStructuredEventHandler = typeof this.context.onEvent === 'function';
    if (event && hasStructuredEventHandler) {
      await this.context.onEvent(event);
    }

    // When the caller opts into structured events, treat that as the single
    // progress source and keep legacy payload streaming as a fallback only.
    if (event && hasStructuredEventHandler) {
      return;
    }

    // 处理工具调用更新：追加而不是替换
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (typeof this.context.onProgress !== 'function') return;
      const output = formatToolOutput(update);
      if (output) {
        // 新的工具调用开始时清空历史
        if (update.sessionUpdate === 'tool_call') {
          this.provider._lastToolOutputs = [];
        }
        // 追加到历史
        this.provider._lastToolOutputs.push(output);
        // 合并所有输出
        const mergedOutput = this.provider._lastToolOutputs.join('\n\n---\n\n');
        const payload = updatePayload('exec', mergedOutput);
        if (payload) await this.context.onProgress?.(payload);
      }
      return;
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
    this._lastToolOutputs = []; // 存储工具输出历史，用于追加显示
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
      onEvent,
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
      onEvent,
      onPermissionRequest,
      abortSignal,
      workingDirectory,
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

// 导出调试日志函数，供测试使用
export function triggerDebugLog(type, data) {
  debugLog(`${type} triggered:`, JSON.stringify(data, null, 2));
}

// 导出检查调试模式是否开启
export function isDebugMode() {
  return DEBUG_ENABLED;
}
