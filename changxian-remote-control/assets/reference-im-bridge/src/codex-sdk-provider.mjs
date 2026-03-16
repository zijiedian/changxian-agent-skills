import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildStructuredPreview, splitShellArgs } from './utils.mjs';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DEFAULT_TRANSIENT_RETRY_LIMIT = 2;
const DEFAULT_DIAGNOSTICS = Object.freeze({
  initialized: false,
  sdkModuleLoaded: false,
  modelPassthrough: false,
  authSource: 'codex-login',
  baseUrlSource: 'default',
  lastInitError: '',
  lastResumeSkipReason: '',
  lastTransientRetryReason: '',
});

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { value, source: name };
  }
  return { value: '', source: '' };
}

function envFlag(...names) {
  const { value } = firstEnv(...names);
  return TRUE_VALUES.has(String(value || '').toLowerCase());
}

function resolveApiKeyConfig() {
  const resolved = firstEnv('RC_CODEX_API_KEY', 'CTI_CODEX_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY');
  if (!resolved.value) return { apiKey: undefined, source: 'codex-login' };
  return { apiKey: resolved.value, source: resolved.source };
}

function resolveBaseUrlConfig() {
  const resolved = firstEnv('RC_CODEX_BASE_URL', 'CTI_CODEX_BASE_URL');
  if (!resolved.value) return { baseUrl: undefined, source: 'default' };
  return { baseUrl: resolved.value, source: resolved.source };
}

function shouldPassModelToCodex() {
  return envFlag('RC_CODEX_PASS_MODEL', 'CTI_CODEX_PASS_MODEL');
}

function looksLikeClaudeModel(model) {
  return !!String(model || '').trim() && /^claude[-_]/i.test(String(model || '').trim());
}

function looksLikeCodexThreadId(threadId) {
  const value = String(threadId || '').trim();
  if (!value) return false;
  return /^[0-9a-f]{8,}-[0-9a-f-]{12,}$/i.test(value);
}

function parseCommandPrefix(prefix) {
  const args = splitShellArgs(prefix);
  const options = {
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
    model: undefined,
    skipGitRepoCheck: false,
    webSearchEnabled: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    const next = String(args[index + 1] || '').trim();
    if ((token === '-a' || token === '--ask-for-approval') && next) {
      options.approvalPolicy = next;
      index += 1;
      continue;
    }
    if ((token === '-s' || token === '--sandbox' || token === '--sandbox-mode') && next) {
      options.sandboxMode = next;
      index += 1;
      continue;
    }
    if ((token === '-m' || token === '--model') && next) {
      options.model = next;
      index += 1;
      continue;
    }
    if (token === '--skip-git-repo-check') {
      options.skipGitRepoCheck = true;
      continue;
    }
    if (token === '--search') {
      options.webSearchEnabled = true;
    }
  }

  return options;
}

function supportImage(file) {
  return file && typeof file === 'object' && typeof file.type === 'string' && file.type.startsWith('image/') && typeof file.data === 'string';
}

function tempImagePath(file) {
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  const ext = extMap[file.type] || '.png';
  return path.join(os.tmpdir(), `rc-codex-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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

function summarizeFileChange(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (!changes.length) return '文件已更新';
  return `文件变更: ${changes.length} 项`;
}

function summarizeMcp(item) {
  const server = String(item?.server || '').trim();
  const tool = String(item?.tool || '').trim();
  if (!server && !tool) return '调用外部工具';
  return `工具调用: ${server}${server && tool ? '/' : ''}${tool}`;
}

function stringifyUnknown(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shouldRetryFreshThread(errorMessage) {
  const message = String(errorMessage || '').toLowerCase();
  return (
    message.includes('resuming session with different model')
    || message.includes('no such session')
    || (message.includes('resume') && message.includes('session'))
  );
}

function isTransientStreamError(errorMessage) {
  const message = String(errorMessage || '').toLowerCase();
  return (
    message.includes('stream disconnected before completion')
    || message.includes('transport error:')
    || message.includes('error decoding response body')
    || message.includes('network error')
    || message.includes('connection reset')
    || message.includes('broken pipe')
    || message.includes('unexpected eof')
  );
}

function transientRetryLimit() {
  const { value } = firstEnv('RC_CODEX_TRANSIENT_RETRIES', 'CTI_CODEX_TRANSIENT_RETRIES');
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_TRANSIENT_RETRY_LIMIT;
}

function delayMsForRetry(attempt) {
  return Math.min(8000, 1000 * (2 ** Math.max(0, attempt - 1)));
}

async function sleepWithAbort(ms, signal) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makePreview({
  status = 'Running',
  marker = 'thinking',
  phase = '',
  content = '',
  summary = '',
  highlights = [],
  checks = [],
  notes = [],
  changedFiles = [],
  diffBlocks = [],
  commandPreview = '',
  commandPreviewLines = [],
  activities = [],
  sourceDomains = [],
}) {
  const normalizedContent = String(content || '').trim();
  const base = buildStructuredPreview(normalizedContent || summary || '', { status, marker });
  return {
    ...base,
    status,
    marker,
    phase: phase || base.phase || marker,
    content: normalizedContent || base.content || '',
    proseMarkdown: normalizedContent || base.proseMarkdown || '',
    summary: String(summary || base.summary || oneLine(normalizedContent) || '').trim(),
    highlights: Array.isArray(highlights) && highlights.length ? highlights : (base.highlights || []),
    checks: Array.isArray(checks) && checks.length ? checks : (base.checks || []),
    notes: Array.isArray(notes) && notes.length ? notes : (base.notes || []),
    changedFiles: Array.isArray(changedFiles) && changedFiles.length ? changedFiles : (base.changedFiles || []),
    diffBlocks: Array.isArray(diffBlocks) && diffBlocks.length ? diffBlocks : (base.diffBlocks || []),
    commandPreview: commandPreview || base.commandPreview || '',
    commandPreviewLines: Array.isArray(commandPreviewLines) && commandPreviewLines.length ? commandPreviewLines : (base.commandPreviewLines || []),
    activities: Array.isArray(activities) && activities.length ? activities : (base.activities || []),
    sourceDomains: Array.isArray(sourceDomains) && sourceDomains.length ? sourceDomains : (base.sourceDomains || []),
  };
}

function previewFromReasoning(item) {
  const text = clipText(item?.text || '', 1600);
  if (!text) return null;
  return makePreview({
    status: 'Running',
    marker: 'thinking',
    phase: 'thinking',
    content: text,
    summary: oneLine(text, 96) || '思考中',
  });
}

function previewFromCommandExecution(item, stage = 'completed') {
  const command = String(item?.command || '').trim();
  const output = clipText(item?.aggregated_output || '', stage === 'completed' ? 2000 : 1200);
  const exitCode = item?.exit_code;
  const checks = [];
  let summary = '';
  if (Number.isInteger(exitCode)) {
    checks.push(exitCode === 0 ? '命令执行完成' : `命令退出码: ${exitCode}`);
    if (exitCode !== 0) summary = '命令执行失败';
  } else if (stage === 'completed' && String(item?.status || '').toLowerCase() === 'failed') {
    checks.push('命令执行失败');
    summary = '命令执行失败';
  }
  return makePreview({
    status: 'Running',
    marker: 'exec',
    phase: 'exec',
    content: output,
    summary,
    checks,
    commandPreview: command,
    commandPreviewLines: command ? [command] : [],
  });
}

function previewFromFileChange(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const changedFiles = changes
    .map((change) => {
      const kind = String(change?.kind || '').trim();
      const filePath = String(change?.path || '').trim();
      return [kind, filePath].filter(Boolean).join(': ');
    })
    .filter(Boolean);
  const content = ['文件变更', ...changedFiles.map((entry) => `- ${entry}`)].join('\n');
  return makePreview({
    status: 'Running',
    marker: 'exec',
    phase: 'diff',
    content,
    summary: summarizeFileChange(item),
    changedFiles,
  });
}

function mcpPhase(item) {
  const combined = `${String(item?.server || '').trim()}/${String(item?.tool || '').trim()}`.toLowerCase();
  return /(search|browse|fetch|crawl|web|news|research)/.test(combined) ? 'research' : 'exec';
}

function previewFromMcpToolCall(item) {
  const summary = summarizeMcp(item);
  const resultText = clipText(
    stringifyUnknown(item?.result?.structured_content ?? item?.result?.content ?? item?.error?.message ?? ''),
    1400,
  );
  const phase = mcpPhase(item);
  const checks = [];
  if (item?.error?.message) {
    checks.push('工具调用失败');
  } else if (String(item?.status || '').toLowerCase() === 'completed') {
    checks.push('工具调用完成');
  }
  const content = [summary, resultText].filter(Boolean).join('\n');
  return makePreview({
    status: 'Running',
    marker: phase,
    phase,
    content,
    summary,
    checks,
  });
}

function previewFromWebSearch(item) {
  const query = String(item?.query || '').trim();
  if (!query) return null;
  return makePreview({
    status: 'Running',
    marker: 'research',
    phase: 'research',
    content: `检索资料\n- 查询: ${query}`,
    summary: `检索资料: ${oneLine(query, 100)}`,
    highlights: [query],
  });
}

function previewFromTodoList(item) {
  const todos = Array.isArray(item?.items) ? item.items : [];
  if (!todos.length) return null;
  const completed = todos.filter((todo) => Boolean(todo?.completed)).length;
  const lines = todos
    .map((todo) => `- [${todo?.completed ? 'x' : ' '}] ${String(todo?.text || '').trim()}`)
    .filter((line) => !/\[\s*\]\s*$/.test(line));
  return makePreview({
    status: 'Running',
    marker: 'thinking',
    phase: 'exec',
    content: ['待办更新', ...lines].join('\n'),
    summary: `待办进度: ${completed}/${todos.length}`,
    notes: lines.slice(0, 6),
  });
}

function previewFromErrorItem(item) {
  const message = clipText(item?.message || '', 1200);
  if (!message) return null;
  return makePreview({
    status: 'Running',
    marker: 'exec',
    phase: 'exec',
    content: `执行异常\n${message}`,
    summary: `执行异常: ${oneLine(message, 100)}`,
    checks: ['出现非致命错误'],
  });
}

function previewForItem(item, stage = 'completed') {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'reasoning':
      return previewFromReasoning(item);
    case 'command_execution':
      return previewFromCommandExecution(item, stage);
    case 'file_change':
      return previewFromFileChange(item);
    case 'mcp_tool_call':
      return previewFromMcpToolCall(item);
    case 'web_search':
      return previewFromWebSearch(item);
    case 'todo_list':
      return previewFromTodoList(item);
    case 'error':
      return previewFromErrorItem(item);
    default:
      return null;
  }
}

function progressPayloadForItem(item, stage = 'completed') {
  const preview = previewForItem(item, stage);
  if (!preview) return null;
  return {
    status: 'Running',
    marker: preview.marker || 'thinking',
    text: preview.summary || oneLine(preview.content, 120) || '处理中',
    preview,
  };
}

export class CodexSdkProvider {
  constructor(config, buildExecutionEnv) {
    this.config = config;
    this.buildExecutionEnv = buildExecutionEnv;
    this.sdkModule = null;
    this.codex = null;
    this.initPromise = null;
    this.ignoredModelNotice = '';
    this.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      modelPassthrough: shouldPassModelToCodex(),
    };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  async ensureCodex() {
    if (this.codex) return this.codex;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { apiKey, source: authSource } = resolveApiKeyConfig();
        const { baseUrl, source: baseUrlSource } = resolveBaseUrlConfig();
        this.diagnostics = {
          ...this.diagnostics,
          authSource,
          baseUrlSource,
          modelPassthrough: shouldPassModelToCodex(),
          lastInitError: '',
        };

        try {
          this.sdkModule = await import('@openai/codex-sdk');
          if (!this.sdkModule?.Codex) {
            throw new Error('missing Codex export');
          }
          const { Codex } = this.sdkModule;
          this.codex = new Codex({
            ...(apiKey ? { apiKey } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            env: this.buildExecutionEnv(process.env),
          });
          this.diagnostics = {
            ...this.diagnostics,
            initialized: true,
            sdkModuleLoaded: true,
            lastInitError: '',
          };
          console.info(`[codex-sdk] initialized auth=${authSource} base_url=${baseUrlSource} model_passthrough=${this.diagnostics.modelPassthrough ? 'on' : 'off'}`);
          return this.codex;
        } catch (error) {
          const detail = error?.message || String(error);
          this.diagnostics = {
            ...this.diagnostics,
            initialized: false,
            sdkModuleLoaded: Boolean(this.sdkModule),
            lastInitError: detail,
          };
          const actionHint = authSource === 'codex-login'
            ? 'Run `codex auth login` or set `CODEX_API_KEY` / `OPENAI_API_KEY`.'
            : `Check the configured credentials from ${authSource}.`;
          throw new Error(`Codex SDK init failed: ${detail}. ${actionHint}`);
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
      files = [],
    } = params;

    const codex = await this.ensureCodex();
    this.diagnostics = {
      ...this.diagnostics,
      lastTransientRetryReason: '',
    };
    const prefixOptions = parseCommandPrefix(commandPrefix);
    const modelPassthrough = shouldPassModelToCodex();
    this.diagnostics = {
      ...this.diagnostics,
      modelPassthrough,
    };
    const requestedModel = String(prefixOptions.model || '').trim();
    if (requestedModel && !modelPassthrough && this.ignoredModelNotice !== requestedModel) {
      this.ignoredModelNotice = requestedModel;
      console.info(`[codex-sdk] ignoring model from command prefix because RC_CODEX_PASS_MODEL is disabled: ${requestedModel}`);
    }

    const options = {
      ...(modelPassthrough && requestedModel ? { model: requestedModel } : {}),
      sandboxMode: prefixOptions.sandboxMode,
      workingDirectory,
      skipGitRepoCheck: prefixOptions.skipGitRepoCheck,
      webSearchEnabled: prefixOptions.webSearchEnabled,
      approvalPolicy: prefixOptions.approvalPolicy,
    };

    let activeSessionId = String(sessionId || '').trim();
    const initialSessionId = activeSessionId;
    if (activeSessionId && !looksLikeCodexThreadId(activeSessionId)) {
      const reason = `skip incompatible saved session: ${activeSessionId}`;
      this.diagnostics = {
        ...this.diagnostics,
        lastResumeSkipReason: reason,
      };
      console.warn(`[codex-sdk] ${reason}`);
      activeSessionId = '';
    } else if (activeSessionId && modelPassthrough && looksLikeClaudeModel(requestedModel)) {
      const reason = `skip resume because configured model looks like Claude: ${requestedModel}`;
      this.diagnostics = {
        ...this.diagnostics,
        lastResumeSkipReason: reason,
      };
      console.warn(`[codex-sdk] ${reason}`);
      activeSessionId = '';
    }

    let assistantText = '';
    let usage = null;
    const tempFiles = [];

    const inputImages = files.filter(supportImage);
    const input = inputImages.length
      ? [
          { type: 'text', text: prompt },
          ...inputImages.map((file) => {
            const tempPath = tempImagePath(file);
            fs.writeFileSync(tempPath, Buffer.from(file.data, 'base64'));
            tempFiles.push(tempPath);
            return { type: 'local_image', path: tempPath };
          }),
        ]
      : prompt;

    try {
      let retryFresh = false;
      let transientRetryCount = 0;
      const maxTransientRetries = transientRetryLimit();
      while (true) {
        let thread;
        let sawAnyEvent = false;
        let sawSideEffectRisk = false;
        let sawAssistantText = false;
        try {
          try {
            thread = activeSessionId
              ? codex.resumeThread(activeSessionId, options)
              : codex.startThread(options);
          } catch {
            thread = codex.startThread(options);
          }

          const { events } = await thread.runStreamed(input, { signal: abortSignal });
          for await (const event of events) {
            sawAnyEvent = true;
            if (abortSignal?.aborted) break;
            switch (event.type) {
              case 'thread.started': {
                activeSessionId = String(event.thread_id || '').trim() || activeSessionId;
                break;
              }
              case 'item.started':
              case 'item.updated': {
                const item = event.item || {};
                if (['command_execution', 'file_change', 'mcp_tool_call'].includes(String(item.type || ''))) {
                  sawSideEffectRisk = true;
                }
                const payload = progressPayloadForItem(item, 'running');
                if (payload) await onProgress?.(payload);
                break;
              }
              case 'item.completed': {
                const item = event.item || {};
                if (item.type === 'agent_message' && item.text) {
                  assistantText = [assistantText, String(item.text)].filter(Boolean).join('\n\n').trim();
                  sawAssistantText = true;
                }
                if (['command_execution', 'file_change', 'mcp_tool_call'].includes(String(item.type || ''))) {
                  sawSideEffectRisk = true;
                }
                const payload = progressPayloadForItem(item, 'completed');
                if (payload) await onProgress?.(payload);
                break;
              }
              case 'turn.completed': {
                usage = event.usage || null;
                break;
              }
              case 'turn.failed': {
                throw new Error(event.error?.message || event.message || 'Turn failed');
              }
              case 'error': {
                throw new Error(event.message || 'Thread error');
              }
              default:
                break;
            }
          }
          break;
        } catch (error) {
          const message = error?.message || String(error);
          if (activeSessionId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
            console.warn(`[codex-sdk] resume failed, retrying with fresh thread: ${message}`);
            this.diagnostics = {
              ...this.diagnostics,
              lastResumeSkipReason: `retry fresh after resume failure: ${message}`,
            };
            activeSessionId = '';
            retryFresh = true;
            continue;
          }
          if (
            !abortSignal?.aborted
            && transientRetryCount < maxTransientRetries
            && isTransientStreamError(message)
            && !sawSideEffectRisk
            && !sawAssistantText
          ) {
            transientRetryCount += 1;
            const delayMs = delayMsForRetry(transientRetryCount);
            const summary = `连接中断，正在重试 ${transientRetryCount}/${maxTransientRetries}`;
            const detail = `${summary}\n${clipText(message, 500)}`;
            console.warn(`[codex-sdk] transient stream error, retrying turn attempt=${transientRetryCount}/${maxTransientRetries}: ${message}`);
            this.diagnostics = {
              ...this.diagnostics,
              lastTransientRetryReason: detail,
            };
            await onProgress?.({
              status: 'Running',
              marker: 'thinking',
              text: summary,
              preview: makePreview({
                status: 'Running',
                marker: 'thinking',
                phase: 'thinking',
                content: detail,
                summary,
                notes: [`${Math.round(delayMs / 1000)} 秒后重试`],
              }),
            });
            activeSessionId = looksLikeCodexThreadId(initialSessionId) ? initialSessionId : '';
            await sleepWithAbort(delayMs, abortSignal);
            continue;
          }
          throw error;
        }
      }

      return {
        sessionId: activeSessionId,
        output: assistantText.trim(),
        usage,
      };
    } finally {
      for (const tempPath of tempFiles) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore temp cleanup failure
        }
      }
    }
  }
}
