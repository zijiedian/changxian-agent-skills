import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { buildStructuredPreview, truncateText } from './utils.mjs';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DEFAULT_DIAGNOSTICS = Object.freeze({
  initialized: false,
  cliPath: '',
  cliVersion: '',
  authSource: 'unknown',
  lastInitError: '',
  lastResumeSkipReason: '',
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

function findAllInPath() {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveClaudeCliPath() {
  const fromEnv = process.env.RC_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const isWindows = process.platform === 'win32';
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
      ];

  const seen = new Set();
  const candidates = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    candidates.push(p);
  }

  for (const p of candidates) {
    if (p && isExecutable(p)) {
      const version = getCliVersion(p);
      if (version && parseCliMajorVersion(version) >= 2) {
        return p;
      }
    }
  }
  return undefined;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getCliVersion(cliPath) {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function parseCliMajorVersion(versionOutput) {
  const m = String(versionOutput || '').match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function looksLikeClaudeSessionId(sessionId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(sessionId || '').trim());
}

export function resolveClaudeSettingSources(raw = process.env.RC_CLAUDE_SETTING_SOURCES || '') {
  const normalized = String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length ? normalized : ['user', 'project', 'local'];
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
  return path.join(os.tmpdir(), `rc-claude-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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

function parseCommandPrefix(prefix) {
  const args = prefix.trim().split(/\s+/).filter(Boolean);
  const options = {
    permissionMode: 'default',
    skipGitRepoCheck: false,
  };

  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '');
    const next = String(args[i + 1] || '').trim();
    if ((token === '--permission-mode' || token === '-p') && next) {
      options.permissionMode = next;
      i += 1;
      continue;
    }
    if (token === '--skip-git-repo-check') {
      options.skipGitRepoCheck = true;
    }
  }
  return options;
}

async function runQuery(params) {
  const {
    prompt,
    workingDirectory,
    sessionId,
    abortSignal,
    cliPath,
    permissionMode,
    onProgress,
    files = [],
  } = params;

  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const cleanEnv = buildSubprocessEnv();
  const imageFiles = files.filter(supportImage);

  let promptInput = prompt;
  if (imageFiles.length > 0) {
    const contentBlocks = [];
    for (const file of imageFiles) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.type === 'image/jpg' ? 'image/jpeg' : file.type,
          data: file.data,
        },
      });
    }
    if (prompt.trim()) {
      contentBlocks.push({ type: 'text', text: prompt });
    }
    promptInput = (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: contentBlocks },
        parent_tool_use_id: null,
        session_id: '',
      };
    })();
  }

  const queryOptions = {
    cwd: workingDirectory,
    resume: sessionId || undefined,
    abortController: abortSignal ? { signal: abortSignal } : undefined,
    permissionMode: permissionMode || 'default',
    settingSources: resolveClaudeSettingSources(),
    includePartialMessages: true,
    env: cleanEnv,
    canUseTool: async (toolName, input, opts) => {
      if (typeof onProgress === 'function') {
        await onProgress({
          status: 'Running',
          marker: 'exec',
          text: `权限请求: ${toolName}`,
          preview: buildStructuredPreview(`工具: ${toolName}\n输入: ${JSON.stringify(input).slice(0, 200)}`, { status: 'Running', marker: 'exec' }),
        });
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };

  if (cliPath) {
    queryOptions.pathToClaudeCodeExecutable = cliPath;
  }

  const q = query({
    prompt: promptInput,
    options: queryOptions,
  });

  const assistantParts = [];
  let lastAssistantText = '';
  let resultSessionId = '';
  let usage = null;
  let hasReceivedResult = false;

  for await (const msg of q) {
    switch (msg.type) {
      case 'stream_event': {
        const event = msg.event;
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          assistantParts.push(event.delta.text);
          if (typeof onProgress === 'function') {
            const partialText = assistantParts.join('').slice(-500);
            await onProgress({
              status: 'Running',
              marker: 'assistant',
              text: oneLine(partialText, 120) || 'thinking...',
              preview: buildStructuredPreview(partialText, { status: 'Running', marker: 'assistant' }),
            });
          }
        }
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          if (typeof onProgress === 'function') {
            await onProgress({
              status: 'Running',
              marker: 'exec',
              text: `工具: ${event.content_block.name}`,
              preview: buildStructuredPreview(`工具调用: ${event.content_block.name}`, { status: 'Running', marker: 'exec' }),
            });
          }
        }
        break;
      }
      case 'assistant': {
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              lastAssistantText += block.text;
            } else if (block.type === 'tool_use') {
              if (typeof onProgress === 'function') {
                await onProgress({
                  status: 'Running',
                  marker: 'exec',
                  text: `工具: ${block.name}`,
                  preview: buildStructuredPreview(`工具: ${block.name}\n输入: ${JSON.stringify(block.input || {}).slice(0, 200)}`, { status: 'Running', marker: 'exec' }),
                });
              }
            }
          }
        }
        break;
      }
      case 'user': {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              const text = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? '');
              if (typeof onProgress === 'function') {
                await onProgress({
                  status: 'Running',
                  marker: 'exec',
                  text: `结果: ${oneLine(text, 80)}`,
                  preview: buildStructuredPreview(text, { status: 'Running', marker: 'exec' }),
                });
              }
            }
          }
        }
        break;
      }
      case 'result': {
        hasReceivedResult = true;
        resultSessionId = msg.session_id || '';
        if (msg.subtype === 'success') {
          usage = {
            input_tokens: msg.usage?.input_tokens || 0,
            output_tokens: msg.usage?.output_tokens || 0,
            cache_read_input_tokens: msg.usage?.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens ?? 0,
          };
        }
        break;
      }
      case 'system': {
        if (msg.subtype === 'init' && msg.session_id) {
          resultSessionId = msg.session_id;
        }
        break;
      }
    }
  }

  return {
    sessionId: resultSessionId,
    output: lastAssistantText.trim() || assistantParts.join('').trim(),
    usage,
  };
}

function buildSubprocessEnv() {
  const mode = process.env.RC_ENV_ISOLATION || 'inherit';
  const out = {};

  if (mode === 'inherit') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (['CLAUDECODE'].includes(k)) continue;
      out[k] = v;
    }
  } else {
    const whitelist = new Set([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
      'LANG', 'LC_ALL', 'LC_CTYPE',
      'TMPDIR', 'TEMP', 'TMP',
      'TERM', 'COLORTERM',
      'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'SSH_AUTH_SOCK',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (whitelist.has(k)) { out[k] = v; continue; }
      if (k.startsWith('RC_')) { out[k] = v; continue; }
      if (k.startsWith('ANTHROPIC_')) { out[k] = v; continue; }
    }
  }
  return out;
}

export class ClaudeSdkProvider {
  constructor(config, buildExecutionEnv) {
    this.config = config;
    this.buildExecutionEnv = buildExecutionEnv;
    this.cliPath = null;
    this.cliVersion = '';
    this.diagnostics = { ...DEFAULT_DIAGNOSTICS };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  resolveCli() {
    if (this.cliPath) return this.cliPath;

    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      this.cliPath = cliPath;
      this.cliVersion = getCliVersion(cliPath) || '';
      this.diagnostics = {
        ...this.diagnostics,
        initialized: true,
        cliPath,
        cliVersion: this.cliVersion,
        authSource: 'cli',
        lastInitError: '',
      };
    } else {
      this.diagnostics = {
        ...this.diagnostics,
        initialized: false,
        cliPath: '',
        cliVersion: '',
        authSource: 'unknown',
        lastInitError: 'Claude CLI not found. Install Claude Code CLI or set RC_CLAUDE_CODE_EXECUTABLE.',
      };
    }
    return this.cliPath;
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

    const cliPath = this.resolveCli();
    if (!cliPath) {
      throw new Error(this.diagnostics.lastInitError || 'Claude CLI not found');
    }

    const prefixOptions = parseCommandPrefix(commandPrefix || '');
    let activeSessionId = String(sessionId || '').trim();
    if (activeSessionId && !looksLikeClaudeSessionId(activeSessionId)) {
      const reason = `skip incompatible saved session: ${activeSessionId}`;
      this.diagnostics = {
        ...this.diagnostics,
        lastResumeSkipReason: reason,
      };
      console.warn(`[claude-sdk] ${reason}`);
      activeSessionId = '';
    } else {
      this.diagnostics = {
        ...this.diagnostics,
        lastResumeSkipReason: '',
      };
    }
    const tempFiles = [];

    try {
      const result = await runQuery({
        prompt,
        workingDirectory,
        sessionId: activeSessionId,
        abortSignal,
        cliPath,
        permissionMode: prefixOptions.permissionMode,
        onProgress,
        files,
      });

      return {
        sessionId: result.sessionId,
        output: result.output,
        usage: result.usage,
      };
    } finally {
      for (const tempPath of tempFiles) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
    }
  }
}
