import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { resolveCommand, helpLines } from '../commands/specs.mjs';
import { applyAssistantOps } from '../commands/assistant-ops.mjs';
import {
  BACKEND_CODEX,
  BACKEND_OPENCODE_ACP,
  BACKEND_CLAUDE,
  BACKEND_PI,
  backendLabel,
  defaultCommandPrefixForBackend,
  detectBackend,
  isAcpCommandPrefix,
  normalizeBackendAlias,
} from '../utils/backend-detection.mjs';
import { CodexAcpProvider } from '../agent/codex.mjs';
import { ClaudeAgentAcpProvider } from '../agent/claude.mjs';
import { OpencodeAcpProvider } from '../agent/opencode.mjs';
import { PiAcpProvider } from '../agent/pi.mjs';
import { buildExecutionEnv, runCommandPreflight } from '../utils/preflight.mjs';
import { parseChannelCommandInput } from '../adapters/telegram/channel-publisher.mjs';
import { buildStructuredPreview, extractStructuredPreview, redactedCommandText, truncateText } from '../utils/utils.mjs';
import {
  buildClaudePermissionPrefix,
  buildCodexPermissionPrefix,
  buildRuntimeControlState,
  isClaudePermissionLevel,
  isCodexPermissionLevel,
} from '../utils/runtime-controls.mjs';
import { CliToolsManager, formatCliStatusLine, summarizeUpdateResult } from '../utils/cli-tools.mjs';
import {
  listSystemMcpServers,
  listSystemSkills,
  setSystemMcpEnabled,
  setSystemSkillEnabled,
} from '../utils/resource-registry.mjs';

// 新渲染架构
import { createRenderer, createMessageTransformer } from '../render/index.mjs';

const CONTEXT_PREVIEW_MARKERS = ['[REMOTE HOST]', '[ACTIVE ROLE]', '[MEMORY CONTEXT]', '[RECENT DIALOGUE]', '[CURRENT TASK]'];
const PREFLIGHT_CACHE_TTL_MS = 5 * 60 * 1000;
const TASK_STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes stale task cleanup
const TASK_CLEANUP_INTERVAL_MS = 60 * 1000; // cleanup every 60 seconds

/**
 * 过滤 Pi 后端结果中的思考过程和 Extension/Skills 输出
 */
function stripThinkingAndExtensions(text, backend = '') {
  let value = String(text || '').trim();
  if (!value) return value;

  // 过滤 <think>...</think> 标签内的思考内容
  value = value.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 过滤各种 thinking 标记行
  const thinkingLines = ['thinking', 'thinking...', 'thought', 'thoughts', 'reasoning', '思考中', '思考'];
  value = value
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim().toLowerCase();
      return !thinkingLines.includes(trimmed);
    })
    .join('\n');

  // 对于 Pi 后端，额外过滤 Extension 和 Skills 输出
  if (backend === BACKEND_PI) {
    const lines = value.split('\n');
    value = lines.filter(line => {
      const t = line.trim();
      if (/^Extensions?\s*$/i.test(t)) return false;
      if (/^Skills?\s*$/i.test(t)) return false;
      if (/^[^\n]*(?:Extensions|Skills)[^\n]*$/i.test(t)) return false;
      if (/^#{1,6}\s+[^\n]*(?:Extensions|Skills)/i.test(t)) return false;
      if (/^[•\-\*]/.test(t)) return false;
      if (/^(index\.ts|npm:[\w-]+)$/.test(t)) return false;
      if (/^\s+(npm:[\w-]+|index\.ts)/.test(line)) return false;
      return true;
    }).join('\n');
  }

  value = value.replace(/\n{3,}/g, '\n\n').trim();
  return value;
}

/**
 * 使用 macOS say 命令生成语音文件
 */
async function generateSpeech(text, voice = '') {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string' || !text.trim()) {
      resolve(null);
      return;
    }

    const maxLength = 300;
    const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;

    const cleaned = truncated
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/[#*_~>\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < 2) {
      resolve(null);
      return;
    }

    const tmpDir = os.tmpdir();
    const aiffFile = path.join(tmpDir, `tts_${Date.now()}.aiff`);
    const voiceName = voice || 'Tingting';

    // 直接用命令行参数传递文本
    const args = ['-v', voiceName, cleaned, '-o', aiffFile];
    const proc = spawn('say', args);

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(aiffFile)) {
        const stats = fs.statSync(aiffFile);
        console.info('[tts] generated aiff:', aiffFile, 'size:', stats.size);

        if (stats.size < 1000) {
          console.warn('[tts] aiff file too small');
          try { fs.unlinkSync(aiffFile); } catch {}
          resolve(null);
          return;
        }

        // 转换为 OGG
        const oggFile = aiffFile.replace('.aiff', '.ogg');
        const ffmpegProc = spawn('ffmpeg', [
          '-i', aiffFile,
          '-y',
          '-acodec', 'libopus',
          '-vn',
          '-ab', '32k',
          '-ar', '16000',
          oggFile
        ]);

        ffmpegProc.on('close', (oggCode) => {
          try { fs.unlinkSync(aiffFile); } catch {}

          if (oggCode === 0 && fs.existsSync(oggFile)) {
            resolve(oggFile);
          } else {
            console.warn('[tts] ffmpeg convert failed');
            resolve(null);
          }
        });

        ffmpegProc.on('error', (err) => {
          console.warn('[tts] ffmpeg error:', err.message);
          resolve(null);
        });
      } else {
        console.warn('[tts] say failed, code:', code);
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      console.warn('[tts] spawn error:', err.message);
      resolve(null);
    });
  });
}

function balanceMarkdownFences(text) {
  const value = String(text || '').trimEnd();
  const fenceCount = (value.match(/^\s*```/gm) || []).length;
  return fenceCount % 2 === 0 ? value : `${value}\n\`\`\``;
}

function clip(text, limit = 3500) {
  const value = String(text || '').trim() || '(empty)';
  if (value.length <= limit) return value;
  const clipped = balanceMarkdownFences(value.slice(0, Math.max(0, limit - 15)));
  return `${clipped}\n\n[truncated]`;
}

function parseParts(raw) {
  const text = String(raw || '').trim();
  if (!text) return ['', ''];
  const [head, ...tail] = text.split(/\s+/);
  return [head.toLowerCase(), tail.join(' ').trim()];
}

function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value % 86400 === 0 && value >= 86400) return `${value / 86400}d`;
  if (value % 3600 === 0 && value >= 3600) return `${value / 3600}h`;
  if (value % 60 === 0 && value >= 60) return `${value / 60}m`;
  return `${value}s`;
}

function timingSafeMatch(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function looksLikeContextPreview(text, prompt) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (CONTEXT_PREVIEW_MARKERS.some((marker) => value.includes(marker))) return true;

  const normalizedPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  const normalizedValue = value.replace(/\s+/g, ' ').trim();
  return Boolean(normalizedPrompt && (normalizedValue === normalizedPrompt || normalizedValue.startsWith(normalizedPrompt)));
}

function summarizeMemoryRecord(record) {
  const flags = [];
  if (record?.pinned) flags.push('pinned');
  if (record?.importance != null && Number(record.importance) > 0) flags.push(`importance=${Number(record.importance)}`);
  const header = [
    record?.id || '',
    record?.kind ? `[${record.kind}]` : '',
    flags.length ? `(${flags.join(', ')})` : '',
    record?.title || '',
  ].filter(Boolean).join(' ');
  const body = String(record?.content || '').replace(/\s+/g, ' ').trim();
  return `- ${header}\n  ${body}`;
}

function summarizeConversationMessage(entry) {
  const role = String(entry?.role || '').trim() || 'user';
  const content = String(entry?.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return '';
  return `- ${role}: ${truncateText(content, 220)}`;
}

function shortenHomePath(filePath = '') {
  const value = String(filePath || '').trim();
  if (!value) return '';
  const home = process.env.HOME || '';
  if (home && value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

function paginateItems(items = [], page = 0, pageSize = 4) {
  const total = Array.isArray(items) ? items.length : 0;
  const size = Math.max(1, Number(pageSize) || 4);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = currentPage * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: currentPage, pageSize: size, total, totalPages };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
}

function plainTextFromRenderedMessage(rendered) {
  const body = String(rendered?.body || '').trim();
  if (!body) return '';
  if (String(rendered?.format || '').trim().toLowerCase() !== 'html') return body;
  return decodeHtmlEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|pre|li|blockquote|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function progressMarkerForOutgoing(outgoing) {
  switch (String(outgoing?.type || '').trim().toLowerCase()) {
    case 'tool_call':
    case 'tool_update':
      return 'exec';
    case 'thought':
    case 'plan':
    case 'mode_change':
    case 'config_update':
    case 'model_update':
    case 'system_message':
      return 'thinking';
    case 'text':
    case 'user_replay':
    case 'resource':
    case 'resource_link':
      return 'assistant';
    default:
      return 'thinking';
  }
}

function progressTextForRenderedEvent(event, outgoing, rendered) {
  const renderedText = plainTextFromRenderedMessage(rendered);
  const metadata = outgoing?.metadata || {};
  switch (String(outgoing?.type || '').trim().toLowerCase()) {
    case 'tool_call':
    case 'tool_update':
      return String(metadata.displaySummary || event?.content || renderedText || outgoing?.text || '').trim();
    case 'thought':
    case 'text':
    case 'user_replay':
      return String(event?.content || renderedText || outgoing?.text || '').trim();
    case 'mode_change':
    case 'config_update':
    case 'model_update':
    case 'system_message':
    case 'plan':
    case 'resource':
    case 'resource_link':
      return String(renderedText || outgoing?.text || event?.message || '').trim();
    default:
      return String(renderedText || outgoing?.text || '').trim();
  }
}

function isPiSkillInventoryEvent(event, backend) {
  if (backend !== BACKEND_PI) return false;
  if (String(event?.type || '').trim().toLowerCase() !== 'text') return false;
  const content = String(event?.content || '').trim();
  if (!content.startsWith('## Skills')) return false;
  if (!/\/(?:\.pi\/agent|\.agents)\/skills\//.test(content)) return false;
  const skillPathMatches = content.match(/\/SKILL\.md\b/g) || [];
  return skillPathMatches.length >= 2;
}

function shouldSuppressProgressEvent(event, { backend = '' } = {}) {
  const type = String(event?.type || '').trim().toLowerCase();
  return type === 'session_info_update' || isPiSkillInventoryEvent(event, backend);
}

export class RuntimeController {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.tasks = new Map();
    this.taskQueues = new Map();
    this.authSessions = new Map();
    this.scheduler = null;
    this.preflightCache = new Map();
    this.staleTaskCleanupTimer = null;
    
    // ACP Providers
    this.codexAcp = new CodexAcpProvider(config, buildExecutionEnv);
    this.claudeAcp = new ClaudeAgentAcpProvider(config, buildExecutionEnv);
    this.opencodeAcp = new OpencodeAcpProvider(config, buildExecutionEnv);
    this.piAcp = new PiAcpProvider(config, buildExecutionEnv);
    
    // CLI Tools
    this.cliTools = new CliToolsManager(() => this.executionEnv());
    
    // 新渲染架构
    this.renderers = {
      telegram: createRenderer('telegram'),
      wecom: createRenderer('wecom'),
      base: createRenderer('base'),
    };
    this.messageTransformer = createMessageTransformer();
    
    // Channel Publisher
    this.telegramChannelPublisher = null;
    this.startStaleTaskCleanup();
  }

  attachScheduler(scheduler) {
    this.scheduler = scheduler || null;
  }

  startStaleTaskCleanup() {
    if (this.staleTaskCleanupTimer) return;
    this.staleTaskCleanupTimer = setInterval(() => this.cleanupStaleTasks(), TASK_CLEANUP_INTERVAL_MS);
    this.staleTaskCleanupTimer.unref?.();
  }

  stopStaleTaskCleanup() {
    if (this.staleTaskCleanupTimer) {
      clearInterval(this.staleTaskCleanupTimer);
      this.staleTaskCleanupTimer = null;
    }
  }

  cleanupStaleTasks() {
    const now = Date.now();
    let cleaned = 0;
    for (const [taskKey, entry] of this.tasks.entries()) {
      if (entry && now - entry.startedAt > TASK_STALE_TIMEOUT_MS) {
        console.warn(`[controller] stale task cleanup host=${entry.host} chat=${entry.chatId} age=${Math.round((now - entry.startedAt) / 1000)}s`);
        entry.cancel();
        this.tasks.delete(taskKey);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.info(`[controller] cleaned ${cleaned} stale tasks, remaining=${this.tasks.size}`);
    }
  }

  attachTelegramChannelPublisher(publisher) {
    this.telegramChannelPublisher = publisher || null;
  }

  rendererForHost(host) {
    const normalized = String(host || '').trim().toLowerCase();
    if (normalized === 'telegram') return this.renderers.telegram;
    if (normalized === 'wecom') return this.renderers.wecom;
    return this.renderers.base;
  }

  buildRenderedProgressPayload(host, event, { elapsedSeconds = 0, workingDirectory = '' } = {}) {
    const renderer = this.rendererForHost(host);
    const outgoing = this.messageTransformer.transform(event, {
      id: String(host || 'runtime'),
      workingDirectory,
    });
    const rendered = renderer.render(outgoing, 'medium');
    const marker = progressMarkerForOutgoing(outgoing);
    const text = progressTextForRenderedEvent(event, outgoing, rendered) || 'thinking...';
    return {
      status: 'Running',
      marker,
      text,
      preview: buildStructuredPreview(text, { status: 'Running', marker }),
      elapsedSeconds,
      event,
      outgoing,
      rendered,
    };
  }

  makeTaskKey(host, chatId) {
    return `${String(host)}:${String(chatId)}`;
  }

  isSchedulerTaskHost(host) {
    return String(host || '').startsWith('scheduler:');
  }

  hasRunningTaskForChat(chatId) {
    const target = String(chatId);
    return [...this.tasks.values()].some((entry) => entry?.chatId === target);
  }

  hasSchedulerTaskForChat(chatId) {
    const target = String(chatId);
    return [...this.tasks.values()].some((entry) => entry?.chatId === target && this.isSchedulerTaskHost(entry.host));
  }

  queuedTaskCount(chatId) {
    return (this.taskQueues.get(String(chatId)) || []).length;
  }

  hasConflictingRunningTaskForChat(chatId, taskHost) {
    const target = String(chatId);
    const currentIsScheduler = this.isSchedulerTaskHost(taskHost);
    for (const entry of this.tasks.values()) {
      if (entry?.chatId !== target) continue;
      const existingIsScheduler = this.isSchedulerTaskHost(entry.host);
      if (currentIsScheduler && !existingIsScheduler) continue;
      return true;
    }
    return false;
  }

  shouldQueueConflictingTask(chatId, taskHost, options = {}) {
    if (options.allowQueue === false) return false;
    if (this.isSchedulerTaskHost(taskHost)) return false;
    if (this.hasSchedulerTaskForChat(chatId)) return false;
    return true;
  }

  queueNoticeText(chatId) {
    const queued = this.queuedTaskCount(chatId);
    if (queued > 0) return `当前会话忙碌中，已加入队列，前方还有 ${queued} 个排队任务。`;
    return '当前会话忙碌中，已加入队列，等待当前任务完成。';
  }

  async enqueueTask(request, sink, options = {}) {
    const chatId = String(request.chatId);
    const queue = this.taskQueues.get(chatId) || [];
    const notice = this.queueNoticeText(chatId);
    try {
      await sink.progress({
        status: 'Queued',
        marker: 'thinking',
        text: notice,
        preview: buildStructuredPreview(notice, { status: 'Queued', marker: 'thinking' }),
        elapsedSeconds: 0,
      });
    } catch {
      // ignore queue acknowledgement failures
    }

    return await new Promise((resolve, reject) => {
      queue.push({
        request,
        sink,
        options: { ...options, allowQueue: false },
        resolve,
        reject,
      });
      this.taskQueues.set(chatId, queue);
    });
  }

  drainTaskQueue(chatId) {
    const target = String(chatId);
    if (this.hasRunningTaskForChat(target)) return;
    const queue = this.taskQueues.get(target);
    if (!queue?.length) return;

    const next = queue.shift();
    if (!queue.length) this.taskQueues.delete(target);

    queueMicrotask(() => {
      Promise.resolve()
        .then(() => this.runTask(next.request, next.sink, next.options))
        .then(next.resolve, next.reject)
        .finally(() => {
          if (!this.hasRunningTaskForChat(target)) this.drainTaskQueue(target);
        });
    });
  }

  getTaskForChat(chatId) {
    const target = String(chatId);
    for (const entry of this.tasks.values()) {
      if (entry?.chatId === target) return entry;
    }
    return null;
  }

  runningTaskCount() {
    return this.tasks.size;
  }

  rememberHostBinding(request) {
    if (!request?.host || !request?.chatId) return;
    this.store.saveHostBinding(request.host, request.chatId, {
      host: request.host,
      chatId: String(request.chatId),
      externalChatId: request.externalChatId || '',
      externalUserId: request.externalUserId || '',
    });
  }

  ensureChatState(chatId) {
    this.store.ensureDefaultRoles(chatId);
  }

  defaultMemoryScope(chatId) {
    return `chat:${chatId}`;
  }

  effectiveWorkdir(chatId) {
    const current = this.store.getChatWorkdir(chatId);
    const normalized = this.normalizeWorkdir(current);
    if (current && normalized !== current) {
      this.store.setChatWorkdir(chatId, normalized);
    }
    return normalized;
  }

  effectiveCommandPrefix(chatId) {
    return this.store.getChatCommandPrefix(chatId) || defaultCommandPrefixForBackend(this.config, this.config.defaultBackend);
  }

  displayCommandPrefix(chatId) {
    return redactedCommandText(this.effectiveCommandPrefix(chatId));
  }

  effectiveBackend(chatId) {
    return detectBackend(this.effectiveCommandPrefix(chatId));
  }

  runtimeControlState(chatId) {
    return buildRuntimeControlState(this.effectiveBackend(chatId), this.effectiveCommandPrefix(chatId), this.config);
  }

  backendProvider(backend, commandPrefix = '') {
    if (backend === BACKEND_CODEX) return this.codexAcp;
    if (backend === BACKEND_OPENCODE_ACP) return this.opencodeAcp;
    if (backend === BACKEND_CLAUDE) return this.claudeAcp;
    if (backend === BACKEND_PI) return this.piAcp;
    return null;
  }

  normalizeWorkdir(workdir) {
    const value = String(workdir || '').trim();
    if (!value) return this.config.defaultWorkdir;
    const resolved = path.resolve(value);
    const legacyRuntimeDirs = [
      path.resolve(this.config.defaultWorkdir, 'changxian-agent-skills/changxian-remote-control/assets/reference-telegram-bridge'),
      path.resolve(this.config.defaultWorkdir, 'changxian-agent-skills/changxian-remote-control/assets/reference-wecom-bot-bridge'),
    ];
    if (legacyRuntimeDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`))) {
      return this.config.defaultWorkdir;
    }
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return this.config.defaultWorkdir;
      }
    } catch {
      return this.config.defaultWorkdir;
    }
    return resolved;
  }

  activeRoleName(chatId) {
    const roleName = this.store.getActiveRole(chatId);
    return roleName && this.store.roleExists(chatId, roleName) ? roleName : '';
  }

  normalizeRoleName(roleName) {
    const normalized = String(roleName || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normalized || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) throw new Error('role names must use lowercase letters, digits, or hyphens');
    return normalized.startsWith('role-') ? normalized.slice(5) : normalized;
  }

  isSecondFactorEnabled() {
    return Boolean(this.config.authPassphrase);
  }

  authScopeKey(request) {
    return [request.host, request.chatId, request.externalUserId || request.externalChatId || request.chatId].map((part) => String(part || '')).join(':');
  }

  cleanupAuthSessions() {
    const now = Date.now();
    for (const [key, expiresAt] of this.authSessions.entries()) {
      if (expiresAt <= now) this.authSessions.delete(key);
    }
  }

  authSecondsLeft(request) {
    if (!this.isSecondFactorEnabled()) return 0;
    this.cleanupAuthSessions();
    const expiresAt = this.authSessions.get(this.authScopeKey(request)) || 0;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  isAuthenticated(request) {
    return !this.isSecondFactorEnabled() || this.authSecondsLeft(request) > 0;
  }

  authRequiredText() {
    return [
      'Authentication required',
      'Use /auth <passphrase> to unlock execution.',
      `Session TTL: ${formatSeconds(this.config.authTtlSeconds)}`,
    ].join('\n');
  }

  async ensureAuthenticated(request, sink) {
    if (this.isAuthenticated(request)) return true;
    await sink.final(this.authRequiredText());
    return false;
  }

  buildPrompt(chatId, prompt, hostName, { roleName = '', memoryScope = '' } = {}) {
    const sections = [];
    const autoMemoryPolicy = this.config.memoryAutoSave
      ? 'You may emit rc-memory-ops even without an explicit remember request when recent dialogue reveals durable preferences, stable facts, long-lived constraints, owned resources, recurring workdirs, style choices, or project context that will matter in future turns. Prefer updating an existing memory instead of creating duplicates when the new fact clearly refines something already stored. Never store secrets, tokens, one-off task outputs, or transient debugging details.'
      : 'Only emit rc-role-ops, rc-memory-ops, or rc-schedule-ops blocks when the user explicitly asks to change roles, memory, or schedules.';
    sections.push(`[REMOTE HOST]\nRunning through ${hostName}. Keep progress concise and action-oriented. ${autoMemoryPolicy}`);
    const activeRole = roleName || this.activeRoleName(chatId);
    if (activeRole) {
      const roleContent = this.store.getRole(chatId, activeRole);
      if (roleContent) sections.push(`[ACTIVE ROLE]\n${roleContent}`);
    }
    if (this.config.enableMemory) {
      const scope = memoryScope || this.defaultMemoryScope(chatId);
      const memories = this.store.listMemories(chatId, { scope, limit: Math.min(4, this.config.memoryMaxItems) });
      if (memories.length) {
        sections.push('[MEMORY CONTEXT]\n' + memories.map((record) => summarizeMemoryRecord(record)).join('\n'));
      }
    }
    const recentMessages = this.store.listConversationMessages?.(chatId, { limit: 6 }) || [];
    if (recentMessages.length) {
      const lines = recentMessages.map((entry) => summarizeConversationMessage(entry)).filter(Boolean);
      if (lines.length) sections.push('[RECENT DIALOGUE]\n' + lines.join('\n'));
    }
    sections.push(`[CURRENT TASK]\n${prompt}`);
    return sections.join('\n\n');
  }

  preflightCacheKey(commandPrefix, workdir) {
    return `${String(commandPrefix || '')}\n${String(workdir || '')}`;
  }

  executionEnv() {
    return buildExecutionEnv(process.env);
  }

  commandPreflight(commandPrefix, workdir) {
    const key = this.preflightCacheKey(commandPrefix, workdir);
    const cached = this.preflightCache.get(key);
    if (cached && Date.now() - cached.checkedAtMs < PREFLIGHT_CACHE_TTL_MS) {
      return cached.result;
    }
    const result = runCommandPreflight({
      commandPrefix,
      workdir,
      env: this.executionEnv(),
    });
    this.preflightCache.set(key, { checkedAtMs: Date.now(), result });
    return result;
  }

  async handleInput(request, sink) {
    this.ensureChatState(request.chatId);
    this.rememberHostBinding(request);
    if (request.text.startsWith('/')) {
      const handled = await this.handleCommand(request, sink);
      if (handled) return;
    }
    if (!await this.ensureAuthenticated(request, sink)) return;
    await this.runPrompt(request, sink);
  }

  async handleCommand(request, sink) {
    const [rawName, ...restParts] = String(request.text || '').trim().replace(/^\//, '').split(/\s+/);
    const spec = resolveCommand(rawName);
    if (!spec) return false;
    const rest = restParts.join(' ').trim();
    const chatId = request.chatId;
    const taskKey = `${request.host}:${chatId}`;

    if (!['start', 'auth'].includes(spec.name) && !this.isAuthenticated(request)) {
      await sink.final(this.authRequiredText());
      return true;
    }

    if (spec.name === 'start') {
      const lines = ['remote-control', ...helpLines(), '', this.buildRuntimePanelText(chatId)];
      if (this.isSecondFactorEnabled() && !this.isAuthenticated(request)) {
        lines.push('', this.authRequiredText());
      }
      await sink.final(lines.join('\n'), { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'status') {
      await sink.final(this.buildRuntimePanelText(chatId), { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'new') {
      this.store.clearChatSession(chatId);
      await sink.final('已重置当前会话。');
      return true;
    }
    if (spec.name === 'cancel') {
      const task = this.getTaskForChat(chatId);
      if (!task) {
        await sink.final('当前没有正在运行的任务。');
      } else {
        task.cancel();
        await sink.final('已请求取消当前任务。');
      }
      return true;
    }
    if (spec.name === 'cwd') {
      if (!rest) {
        await sink.final(String(this.effectiveWorkdir(chatId)));
        return true;
      }
      if (['clear', 'reset', 'default'].includes(rest.toLowerCase())) {
        this.store.clearChatWorkdir(chatId);
        await sink.final(`已恢复默认工作目录: ${this.effectiveWorkdir(chatId)}`);
        return true;
      }
      const target = path.resolve(this.effectiveWorkdir(chatId), rest);
      this.store.setChatWorkdir(chatId, target);
      await sink.final(`已设置工作目录: ${target}`);
      return true;
    }
    if (spec.name === 'id') {
      await sink.final(`host: ${request.host}\nchat_id: ${request.chatId}\nexternal_chat_id: ${request.externalChatId || '(none)'}\nexternal_user_id: ${request.externalUserId || '(none)'}`);
      return true;
    }
    if (spec.name === 'cmd') {
      if (!rest) {
        await sink.final(this.buildRuntimePanelText(chatId), { telegramControls: { chatId } });
        return true;
      }
      if (['clear', 'reset', 'default'].includes(rest.toLowerCase())) {
        this.store.clearChatCommandPrefix(chatId);
        await sink.final(this.buildRuntimePanelText(chatId, '已恢复默认命令前缀。'), { telegramControls: { chatId } });
        return true;
      }
      const permissionUpdate = this.applyPermissionLevel(chatId, rest);
      if (permissionUpdate) {
        await sink.final(this.buildRuntimePanelText(chatId, permissionUpdate), { telegramControls: { chatId } });
        return true;
      }
      this.store.setChatCommandPrefix(chatId, rest);
      await sink.final(this.buildRuntimePanelText(chatId, '已更新命令前缀。'), { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'backend') {
      if (!rest) {
        await sink.final(this.buildRuntimePanelText(chatId), { telegramControls: { chatId } });
        return true;
      }
      const updated = this.applyBackendSelection(chatId, rest);
      if (updated) {
        await sink.final(this.buildRuntimePanelText(chatId, updated), { telegramControls: { chatId } });
        return true;
      }
      await sink.final('Unsupported backend\nUsage\n/backend claude\n/backend codex\n/backend opencode-acp\n/backend pi\n/backend default', { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'memory') {
      await sink.final(await this.handleMemoryCommand(chatId, rest, request));
      return true;
    }
    if (spec.name === 'role') {
      await sink.final(await this.handleRoleCommand(chatId, rest));
      return true;
    }
    if (spec.name === 'schedule') {
      await sink.final(await this.handleScheduleCommand(chatId, rest));
      return true;
    }
    if (spec.name === 'channel') {
      await sink.final(await this.handleChannelCommand(request, rest));
      return true;
    }
    if (spec.name === 'skill') {
      await sink.final(this.handleSkillCommand(chatId, rest), {
        telegramControls: {
          chatId,
          commandPanelAction: 'skill',
          commandPanelPage: 0,
        },
      });
      return true;
    }
    if (spec.name === 'mcp') {
      await sink.final(this.handleMcpCommand(chatId, rest), {
        telegramControls: {
          chatId,
          commandPanelAction: 'mcp',
          commandPanelPage: 0,
        },
      });
      return true;
    }
    if (spec.name === 'setting') {
      await sink.final(`${this.handleSettingCommand()}\n\n${this.buildRuntimePanelText(chatId)}`, { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'cli') {
      await sink.final(this.buildCliPanelText(chatId, { checkLatest: true, force: true }), { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'upgrade') {
      await sink.final(this.runCliUpgrade(chatId), { telegramControls: { chatId } });
      return true;
    }
    if (spec.name === 'auth') {
      if (!this.isSecondFactorEnabled()) {
        await sink.final('Auth disabled\nSet RC_AUTH_PASSPHRASE, TG_AUTH_PASSPHRASE, or WECOM_AUTH_PASSPHRASE to enable second-factor auth.');
        return true;
      }
      if (!rest) {
        const secondsLeft = this.authSecondsLeft(request);
        if (secondsLeft > 0) {
          await sink.final(`Already authenticated\nRemaining: ${formatSeconds(secondsLeft)}`);
        } else {
          await sink.final(this.authRequiredText());
        }
        return true;
      }
      if (['logout', 'revoke', 'clear'].includes(rest.toLowerCase())) {
        this.authSessions.delete(this.authScopeKey(request));
        console.info(`[auth] cleared host=${request.host} chat=${request.chatId} user=${request.externalUserId || '-'}`);
        await sink.final('Authentication cleared');
        return true;
      }
      if (timingSafeMatch(rest, this.config.authPassphrase)) {
        this.authSessions.set(this.authScopeKey(request), Date.now() + (this.config.authTtlSeconds * 1000));
        console.info(`[auth] success host=${request.host} chat=${request.chatId} user=${request.externalUserId || '-'}`);
        await sink.final(`Authentication successful\nValid for ${formatSeconds(this.config.authTtlSeconds)}`);
        return true;
      }
      console.warn(`[auth] failed host=${request.host} chat=${request.chatId} user=${request.externalUserId || '-'}`);
      await sink.final('Authentication failed');
      return true;
    }
    return false;
  }

  handleSkillCommand(chatId, raw, options = {}) {
    const text = String(raw || '').trim();
    const skills = listSystemSkills();
    const page = Math.max(0, Number(options.page) || 0);
    const pageInfo = paginateItems(skills, page, 4);
    if (!text || ['list', 'ls'].includes(text.toLowerCase())) {
      if (!skills.length) return '技能\n当前没有可见 skill。';
      const enabledCount = skills.filter((skill) => skill.enabled).length;
      const disabledCount = skills.length - enabledCount;
      return [
        '技能',
        `第 ${pageInfo.page + 1}/${pageInfo.totalPages} 页 · 启用 ${enabledCount} · 停用 ${disabledCount}`,
        '可用下方按钮查看详情或直接启停。',
        '',
        ...pageInfo.items.map((skill, index) => `${pageInfo.page * pageInfo.pageSize + index + 1}. ${skill.enabled ? '🟢' : '⚪'} ${skill.name}\n${skill.backends.join('/')} · ${shortenHomePath(skill.path)}`),
      ].join('\n');
    }

    const [sub, rest] = parseParts(text);
    if (sub === 'show') {
      if (!rest) return 'Usage\n/skill show <name>';
      const lowered = rest.toLowerCase();
      const matches = skills.filter((skill) => String(skill.name || '').toLowerCase() === lowered || String(skill.name || '').toLowerCase().includes(lowered));
      if (!matches.length) return `Skill not found: ${rest}`;
      if (matches.length > 1) return `Multiple skills match: ${rest}`;
      const skill = matches[0];
      return [
        '🧩 技能详情',
        `${skill.name}`,
        `${skill.enabled ? '🟢 启用' : '⚪ 停用'} · ${skill.backends.join('/')}`,
        `${shortenHomePath(skill.path)}`,
      ].join('\n');
    }

    if (!['enable', 'disable'].includes(sub)) {
      return '用法\n/skill list\n/skill show <name>\n/skill enable <name>\n/skill disable <name>';
    }
    if (!rest) {
      return `用法\n/skill ${sub} <name>`;
    }

    try {
      const updated = setSystemSkillEnabled(rest, sub === 'enable');
      this.store.clearChatSession(chatId);
      return [
        `技能已${updated.enabled ? '启用' : '停用'}：${updated.name}`,
        `后端：${updated.backends.join('/')}`,
        '已清空当前 chat 会话，新任务会按新的 skill 状态启动。',
      ].join('\n');
    } catch (error) {
      return `技能更新失败\n原因：${error?.message || String(error)}`;
    }
  }

  handleMcpCommand(chatId, raw, options = {}) {
    const text = String(raw || '').trim();
    const servers = listSystemMcpServers();
    const page = Math.max(0, Number(options.page) || 0);
    const pageInfo = paginateItems(servers, page, 4);
    if (!text || ['list', 'ls'].includes(text.toLowerCase())) {
      if (!servers.length) return 'MCP\n当前没有可见 MCP Server。';
      const enabledCount = servers.filter((server) => server.enabled).length;
      const disabledCount = servers.length - enabledCount;
      return [
        'MCP',
        `第 ${pageInfo.page + 1}/${pageInfo.totalPages} 页 · 启用 ${enabledCount} · 停用 ${disabledCount}`,
        '可用下方按钮查看详情或直接启停。',
        '',
        ...pageInfo.items.map((server, index) => `${pageInfo.page * pageInfo.pageSize + index + 1}. ${server.enabled ? '🟢' : '⚪'} ${server.name}\n${server.backends.join('/')} · ${(server.command || []).join(' ')}`),
      ].join('\n');
    }

    const [sub, rest] = parseParts(text);
    if (sub === 'show') {
      if (!rest) return 'Usage\n/mcp show <name>';
      const lowered = rest.toLowerCase();
      const matches = servers.filter((server) => String(server.name || '').toLowerCase() === lowered || String(server.name || '').toLowerCase().includes(lowered));
      if (!matches.length) return `MCP Server 未找到：${rest}`;
      if (matches.length > 1) return `MCP Server 匹配过多：${rest}`;
      const server = matches[0];
      return [
        '🔌 MCP 详情',
        `${server.name}`,
        `${server.enabled ? '🟢 启用' : '⚪ 停用'} · ${server.backends.join('/')}`,
        ...(server.command?.length ? [truncateText(server.command.join(' '), 180)] : []),
      ].join('\n');
    }

    if (!['enable', 'disable'].includes(sub)) {
      return '用法\n/mcp list\n/mcp show <name>\n/mcp enable <name>\n/mcp disable <name>';
    }
    if (!rest) return `用法\n/mcp ${sub} <name>`;

    try {
      const updated = setSystemMcpEnabled(rest, sub === 'enable');
      this.store.clearChatSession(chatId);
      return [
        `MCP 已${updated.enabled ? '启用' : '停用'}：${updated.name}`,
        `后端：${updated.backends.join('/')}`,
        '已清空当前 chat 会话，新任务会按新的 MCP 状态启动。',
      ].join('\n');
    } catch (error) {
      return `MCP 更新失败\n原因：${error?.message || String(error)}`;
    }
  }

  handleSettingCommand() {
    const codexAcp = this.codexAcp.getDiagnostics();
    const claudeAcp = this.claudeAcp.getDiagnostics();
    const opencodeAcp = this.opencodeAcp.getDiagnostics();
    const piAcp = this.piAcp.getDiagnostics();
    return [
      `default_backend: ${this.config.defaultBackend}`,
      `auth: ${this.isSecondFactorEnabled() ? `enabled (${formatSeconds(this.config.authTtlSeconds)})` : 'disabled'}`,
      `memory: ${this.config.enableMemory ? 'enabled' : 'disabled'}`,
      `scheduler: ${this.config.enableScheduler ? 'enabled' : 'disabled'}`,
      `session_resume: ${this.config.enableSessionResume ? 'enabled' : 'disabled'}`,
      `telegram_channels: ${Object.keys(this.config.tgChannelTargets || {}).length}`,
      `telegram_default_channel: ${this.config.tgDefaultChannel || '(none)'}`,
      `telegram_channel_allowlist: ${this.config.tgChannelAllowedOperatorIds?.size ? `${this.config.tgChannelAllowedOperatorIds.size} ids` : 'disabled'}`,
      `default_workdir: ${this.config.defaultWorkdir}`,
      `default_command_prefix: ${redactedCommandText(this.config.defaultCommandPrefix)}`,
      `codex_command_prefix: ${redactedCommandText(this.config.codexCommandPrefix)}`,
      `claude_command_prefix: ${redactedCommandText(this.config.claudeCommandPrefix || 'claude-agent-acp')}`,
      `opencode_acp_command_prefix: ${redactedCommandText(this.config.opencodeCommandPrefix)}`,
      `pi_command_prefix: ${redactedCommandText(this.config.piCommandPrefix || 'pi-acp')}`,
      `codex_acp: ${codexAcp.initialized ? 'initialized' : 'lazy'}`,
      `codex_acp_agent: ${[codexAcp.agentName, codexAcp.agentVersion].filter(Boolean).join(' ') || '(unknown)'}`,
      `codex_acp_auth_methods: ${codexAcp.authMethods?.length ? codexAcp.authMethods.join(', ') : '(none reported)'}`,
      ...(codexAcp.lastInitError ? [`codex_acp_last_init_error: ${codexAcp.lastInitError}`] : []),
      ...(codexAcp.lastResumeSkipReason ? [`codex_acp_last_resume_skip: ${codexAcp.lastResumeSkipReason}`] : []),
      ...(codexAcp.lastPermissionDecision ? [`codex_acp_last_permission: ${codexAcp.lastPermissionDecision}`] : []),
      ...(codexAcp.lastStopReason ? [`codex_acp_last_stop_reason: ${codexAcp.lastStopReason}`] : []),
      `claude_acp: ${claudeAcp.initialized ? 'initialized' : 'lazy'}`,
      `claude_acp_agent: ${[claudeAcp.agentName, claudeAcp.agentVersion].filter(Boolean).join(' ') || '(unknown)'}`,
      `claude_acp_auth_methods: ${claudeAcp.authMethods?.length ? claudeAcp.authMethods.join(', ') : '(none reported)'}`,
      `claude_acp_cli: ${claudeAcp.cliPath || '(not found)'}`,
      ...(claudeAcp.lastInitError ? [`claude_acp_last_init_error: ${claudeAcp.lastInitError}`] : []),
      ...(claudeAcp.lastResumeSkipReason ? [`claude_acp_last_resume_skip: ${claudeAcp.lastResumeSkipReason}`] : []),
      ...(claudeAcp.lastPermissionDecision ? [`claude_acp_last_permission: ${claudeAcp.lastPermissionDecision}`] : []),
      ...(claudeAcp.lastStopReason ? [`claude_acp_last_stop_reason: ${claudeAcp.lastStopReason}`] : []),
      `opencode_acp: ${opencodeAcp.initialized ? 'initialized' : 'lazy'}`,
      `opencode_agent: ${[opencodeAcp.agentName, opencodeAcp.agentVersion].filter(Boolean).join(' ') || '(unknown)'}`,
      `opencode_auth_methods: ${opencodeAcp.authMethods?.length ? opencodeAcp.authMethods.join(', ') : '(none reported)'}`,
      ...(opencodeAcp.lastInitError ? [`opencode_last_init_error: ${opencodeAcp.lastInitError}`] : []),
      ...(opencodeAcp.lastResumeSkipReason ? [`opencode_last_resume_skip: ${opencodeAcp.lastResumeSkipReason}`] : []),
      ...(opencodeAcp.lastPermissionDecision ? [`opencode_last_permission: ${opencodeAcp.lastPermissionDecision}`] : []),
      ...(opencodeAcp.lastStopReason ? [`opencode_last_stop_reason: ${opencodeAcp.lastStopReason}`] : []),
      `pi_acp: ${piAcp.initialized ? 'initialized' : 'lazy'}`,
      `pi_acp_agent: ${[piAcp.agentName, piAcp.agentVersion].filter(Boolean).join(' ') || '(unknown)'}`,
      `pi_acp_auth_methods: ${piAcp.authMethods?.length ? piAcp.authMethods.join(', ') : '(none reported)'}`,
      `pi_acp_cli: ${piAcp.cliPath || '(not found)'}`,
      ...(piAcp.lastInitError ? [`pi_acp_last_init_error: ${piAcp.lastInitError}`] : []),
      ...(piAcp.lastResumeSkipReason ? [`pi_acp_last_resume_skip: ${piAcp.lastResumeSkipReason}`] : []),
      ...(piAcp.lastPermissionDecision ? [`pi_acp_last_permission: ${piAcp.lastPermissionDecision}`] : []),
      ...(piAcp.lastStopReason ? [`pi_acp_last_stop_reason: ${piAcp.lastStopReason}`] : []),
    ].join('\n');
  }

  statusLines(chatId, { includeCli = true } = {}) {
    const backend = this.effectiveBackend(chatId);
    const controls = this.runtimeControlState(chatId);
    const lines = [
      `backend: ${backendLabel(backend)}`,
      `permission: ${controls.permissionLabel}`,
      `workdir: ${this.effectiveWorkdir(chatId)}`,
      `role: ${this.activeRoleName(chatId) || '(none)'}`,
      `memory: ${this.config.enableMemory ? 'enabled' : 'disabled'}`,
      `scheduler: ${this.config.enableScheduler ? 'enabled' : 'disabled'}`,
      `telegram_channels: ${Object.keys(this.config.tgChannelTargets || {}).length}`,
      `telegram_default_channel: ${this.config.tgDefaultChannel || '(none)'}`,
      `command: ${this.displayCommandPrefix(chatId)}`,
      `running: ${this.hasRunningTaskForChat(chatId) ? 'yes' : 'no'}`,
      `queued: ${this.queuedTaskCount(chatId)}`,
    ];
    if (includeCli) lines.push(...this.cliStatusLines());
    return lines;
  }

  buildRuntimePanelText(chatId, notice = '', { includeCli = true } = {}) {
    const lines = [];
    if (notice) lines.push(notice, '');
    lines.push('Remote Control', ...this.statusLines(chatId, { includeCli }));
    return lines.join('\n');
  }

  cliStatusLines({ checkLatest = false, force = false } = {}) {
    const snapshot = this.cliTools.getSnapshot({ checkLatest, force });
    return snapshot.statuses.map((status) => formatCliStatusLine(status));
  }

  buildCliPanelText(chatId, { notice = '', checkLatest = false, force = false } = {}) {
    const lines = [];
    if (notice) lines.push(notice, '');
    lines.push('CLI 状态', ...this.cliStatusLines({ checkLatest, force }), '', this.buildRuntimePanelText(chatId, '', { includeCli: false }));
    return lines.join('\n');
  }

  runCliUpgrade(chatId) {
    const result = this.cliTools.updateOutdated();
    return `${summarizeUpdateResult(result)}\n\n${this.buildCliPanelText(chatId, { checkLatest: true, force: true })}`;
  }

  async handleQuickCommand(action, request) {
    const chatId = String(request.chatId);
    const normalized = String(action || '').trim().toLowerCase();

    if (!normalized || normalized === 'status') {
      return this.buildRuntimePanelText(chatId);
    }
    if (normalized === 'setting') {
      return `${this.handleSettingCommand()}\n\n${this.buildRuntimePanelText(chatId, '', { includeCli: false })}`;
    }
    if (normalized === 'cli') {
      return this.buildCliPanelText(chatId, { checkLatest: true, force: true });
    }
    if (normalized === 'skill') {
      return this.handleSkillCommand(chatId, '');
    }
    if (normalized === 'mcp') {
      return this.handleMcpCommand(chatId, '');
    }
    if (normalized === 'role') {
      return this.handleRoleCommand(chatId, '');
    }
    if (normalized === 'memory') {
      return this.handleMemoryCommand(chatId, '', request);
    }
    if (normalized === 'schedule') {
      return this.handleScheduleCommand(chatId, '');
    }
    if (normalized === 'channel') {
      return this.handleChannelCommand(request, '');
    }
    if (normalized === 'cancel') {
      const task = this.getTaskForChat(chatId);
      if (!task) return this.buildRuntimePanelText(chatId, '当前没有正在运行的任务。');
      task.cancel();
      return this.buildRuntimePanelText(chatId, '已请求取消当前任务。');
    }

    return this.buildRuntimePanelText(chatId, '未识别的快捷操作。');
  }

  handleMemoryPanelAction(chatId, action, memoryId) {
    const memory = this.store.getMemory(chatId, memoryId);
    if (!memory) return 'Memory not found';

    if (action === 'show') {
      return [
        `Memory: ${memory.id}`,
        `Scope: ${memory.scope}`,
        `Pinned: ${memory.pinned ? 'yes' : 'no'}`,
        memory.title ? `Title: ${memory.title}` : '',
        '',
        String(memory.content || '').trim(),
      ].filter(Boolean).join('\n');
    }

    if (action === 'pin') {
      const nextPinned = !memory.pinned;
      this.store.setMemoryPinned(chatId, memoryId, nextPinned);
      return `Memory ${nextPinned ? 'pinned' : 'unpinned'}\nID: ${memoryId}`;
    }

    if (action === 'delete') {
      const deleted = this.store.deleteMemory(chatId, memoryId);
      return deleted ? `Memory removed\nID: ${memoryId}` : 'Memory not found';
    }

    return 'Unknown memory action';
  }

  applyBackendSelection(chatId, value) {
    const normalized = normalizeBackendAlias(value);
    if (normalized === 'default') {
      this.store.clearChatCommandPrefix(chatId);
      this.store.clearChatSession(chatId);
      const backend = this.effectiveBackend(chatId);
      return `已恢复默认后端: ${backendLabel(backend)}（已清空旧会话，后续将新建该后端会话）`;
    }
    if (normalized === BACKEND_CODEX) {
      this.store.setChatCommandPrefix(chatId, this.config.codexCommandPrefix);
      this.store.clearChatSession(chatId);
      return `已切到 ${backendLabel(BACKEND_CODEX)}（已清空旧会话）`;
    }
    if (normalized === BACKEND_OPENCODE_ACP) {
      this.store.setChatCommandPrefix(chatId, this.config.opencodeCommandPrefix);
      this.store.clearChatSession(chatId);
      return `已切到 ${backendLabel(BACKEND_OPENCODE_ACP)}（已清空旧会话）`;
    }
    if (normalized === BACKEND_CLAUDE) {
      this.store.setChatCommandPrefix(chatId, this.config.claudeCommandPrefix || 'claude-agent-acp');
      this.store.clearChatSession(chatId);
      return `已切到 ${backendLabel(BACKEND_CLAUDE)}（已清空旧会话）`;
    }
    if (normalized === BACKEND_PI) {
      this.store.setChatCommandPrefix(chatId, this.config.piCommandPrefix || 'pi-acp');
      this.store.clearChatSession(chatId);
      return `已切到 ${backendLabel(BACKEND_PI)}（已清空旧会话）`;
    }
    return '';
  }

  applyPermissionLevel(chatId, value) {
    const normalized = String(value || '').trim().toLowerCase() === 'acceptedits'
      ? 'accept'
      : String(value || '').trim().toLowerCase();
    const backend = this.effectiveBackend(chatId);
    const currentPrefix = this.effectiveCommandPrefix(chatId);
    const knownCodexLevel = isCodexPermissionLevel(normalized);
    const knownClaudeLevel = isClaudePermissionLevel(normalized);

    if (backend === BACKEND_CODEX && knownCodexLevel) {
      this.store.setChatCommandPrefix(chatId, buildCodexPermissionPrefix(normalized, this.config, currentPrefix));
      return `已切到 Codex 权限: ${this.runtimeControlState(chatId).permissionLabel}`;
    }

    if (backend === BACKEND_CLAUDE && knownClaudeLevel) {
      this.store.setChatCommandPrefix(chatId, buildClaudePermissionPrefix(normalized, this.config, currentPrefix));
      return `已切到 Claude 权限: ${this.runtimeControlState(chatId).permissionLabel}`;
    }

    if (backend === BACKEND_OPENCODE_ACP && (knownCodexLevel || knownClaudeLevel)) {
      return 'OpenCode ACP 的权限由后端自己控制，当前桥接不提供快捷权限档位。';
    }

    if ((knownCodexLevel || knownClaudeLevel) && backend !== BACKEND_CODEX && backend !== BACKEND_CLAUDE) {
      return '当前后端不支持这个快捷权限档位。';
    }

    if (backend === BACKEND_CODEX && knownClaudeLevel) {
      return 'Codex 后端只支持 readonly / low / high 快捷权限档位。';
    }

    if (backend === BACKEND_CLAUDE && knownCodexLevel) {
      return 'Claude 后端只支持 default / plan / accept 快捷权限档位。';
    }

    return '';
  }

  handleRoleCommand(chatId, raw) {
    const text = String(raw || '').trim();
    if (!text) {
      const roles = this.store.listRoles(chatId);
      return `Role\nCurrent: ${this.activeRoleName(chatId) || '(none)'}\nStored: ${roles.length}\n\nUsage\n/role list\n/role show <name>\n/role use <name>\n/role clear\n/role save <name> | <content>\n/role delete <name>`;
    }
    const [sub, rest] = parseParts(text);
    if (['list', 'ls'].includes(sub)) {
      const roles = this.store.listRoles(chatId);
      if (!roles.length) return 'No roles defined for this chat';
      const active = this.activeRoleName(chatId);
      return ['Roles', ...roles.map((name) => `- ${name}${name === active ? ' [active]' : ''}: ${truncateText(this.store.getRole(chatId, name), 120)}`)].join('\n');
    }
    if (['show', 'cat'].includes(sub)) {
      if (!rest) return 'Usage\n/role show <name>';
      const name = this.normalizeRoleName(rest);
      if (!this.store.roleExists(chatId, name)) return 'Role not found';
      return `Role: ${name}\n\n${this.store.getRole(chatId, name)}`;
    }
    if (sub === 'use') {
      if (!rest) return 'Usage\n/role use <name>';
      const name = this.normalizeRoleName(rest);
      if (!this.store.roleExists(chatId, name)) return 'Role not found';
      this.store.setActiveRole(chatId, name);
      return `Role activated\nName: ${name}`;
    }
    if (sub === 'clear') {
      const cleared = this.store.clearActiveRole(chatId);
      return cleared ? 'Cleared active role' : 'No active role to clear';
    }
    if (['save', 'upsert', 'add'].includes(sub)) {
      if (!rest.includes('|')) return 'Usage\n/role save <name> | <content>';
      const [nameRaw, contentRaw] = rest.split('|', 2);
      const name = this.normalizeRoleName(nameRaw.trim());
      this.store.upsertRole(chatId, name, contentRaw.trim());
      return `Role saved\nName: ${name}`;
    }
    if (['delete', 'rm'].includes(sub)) {
      if (!rest) return 'Usage\n/role delete <name>';
      const name = this.normalizeRoleName(rest);
      const deleted = this.store.deleteRole(chatId, name);
      return deleted ? `Role removed\nName: ${name}` : 'Role not found';
    }
    return 'Unknown role command\nUse /role for usage.';
  }

  handleMemoryCommand(chatId, raw, request) {
    const text = String(raw || '').trim();
    const defaultScope = this.defaultMemoryScope(chatId);
    if (!text) {
      return `Memory\nStored: ${this.store.countMemories(chatId)}\nDefault scope: ${defaultScope}\n\nUsage\n/memory list [query]\n/memory add <content>\n/memory pin <id>\n/memory forget <id>\n/memory clear [<scope>]`;
    }
    const [sub, rest] = parseParts(text);
    if (['list', 'ls'].includes(sub)) {
      const records = this.store.listMemories(chatId, { query: rest, limit: 10 });
      if (!records.length) return 'No memories found';
      return ['Memory Results', ...records.map((record, index) => `${index + 1}. ${record.id} ${record.scope}${record.pinned ? ' [pinned]' : ''}\n${clip(record.content, 120)}`)].join('\n\n');
    }
    if (sub === 'add') {
      if (!rest) return 'Usage\n/memory add <content>';
      const record = this.store.addMemory({
        chatId,
        scope: defaultScope,
        kind: 'note',
        title: rest.split(/\n/, 1)[0].slice(0, 72),
        content: rest,
        tags: ['manual'],
        sourceType: request.host,
        sourceRef: request.externalUserId || request.externalChatId || ''
      });
      return `Memory saved\nID: ${record.id}\nScope: ${record.scope}`;
    }
    if (['pin', 'unpin'].includes(sub)) {
      if (!rest) return 'Usage\n/memory pin <id>';
      const changed = this.store.setMemoryPinned(chatId, rest, sub === 'pin');
      return changed ? `Memory ${sub === 'pin' ? 'pinned' : 'unpinned'}\nID: ${rest}` : 'Memory not found';
    }
    if (['forget', 'delete', 'rm'].includes(sub)) {
      if (!rest) return 'Usage\n/memory forget <id>';
      const deleted = this.store.deleteMemory(chatId, rest);
      return deleted ? `Memory removed\nID: ${rest}` : 'Memory not found';
    }
    if (sub === 'clear') {
      const scope = rest || defaultScope;
      const deleted = this.store.clearMemoryScope(chatId, scope);
      return `Memory scope cleared\nScope: ${scope}\nDeleted: ${deleted}`;
    }
    return 'Unknown memory command\nUse /memory for usage.';
  }

  async handleScheduleCommand(chatId, raw) {
    const text = String(raw || '').trim();
    if (!text) {
      return `Schedule\nStored: ${this.store.countJobs(chatId)}\nEnabled: ${this.store.countJobs(chatId, { enabledOnly: true })}\n\nUsage\n/schedule list\n/schedule show <job_id>\n/schedule run <job_id>\n/schedule pause <job_id>\n/schedule resume <job_id>\n/schedule delete <job_id>`;
    }
    const [sub, rest] = parseParts(text);
    if (['list', 'ls'].includes(sub)) {
      const jobs = this.store.listJobs(chatId);
      if (!jobs.length) return 'No scheduled jobs for this chat';
      return ['Scheduled Jobs', ...jobs.map((job) => `${job.id} [${job.enabled ? 'enabled' : 'paused'}] ${job.schedule_type} ${job.schedule_expr} tz=${job.timezone}`)].join('\n');
    }
    if (['show', 'get'].includes(sub)) {
      if (!rest) return 'Usage\n/schedule show <job_id>';
      const job = this.store.getJob(chatId, rest);
      return job ? `${job.id} [${job.enabled ? 'enabled' : 'paused'}]\nprompt=${job.prompt_template}` : 'Scheduled job not found';
    }
    if (sub === 'run') {
      if (!rest) return 'Usage\n/schedule run <job_id>';
      const job = this.store.getJob(chatId, rest);
      if (!job) return 'Scheduled job not found';
      if (!this.scheduler) return 'Scheduler runtime unavailable';
      try {
        const runId = await this.scheduler.triggerJobNow(job);
        return `Triggered ${rest}\nRun: ${runId}`;
      } catch (error) {
        return `Failed to trigger ${rest}\nReason: ${error?.message || String(error)}`;
      }
    }

    if (sub === 'pause') {
      if (!rest) return 'Usage\n/schedule pause <job_id>';
      const job = this.store.getJob(chatId, rest);
      if (!job) return 'Scheduled job not found';
      return this.store.setJobEnabled(chatId, rest, false, job.next_run_at) ? `Paused ${rest}` : 'Scheduled job not found';
    }
    if (sub === 'resume') {
      if (!rest) return 'Usage\n/schedule resume <job_id>';
      const job = this.store.getJob(chatId, rest);
      if (!job) return 'Scheduled job not found';
      return this.store.setJobEnabled(chatId, rest, true, job.next_run_at) ? `Resumed ${rest}` : 'Scheduled job not found';
    }
    if (['delete', 'rm'].includes(sub)) {
      if (!rest) return 'Usage\n/schedule delete <job_id>';
      return this.store.deleteJob(chatId, rest) ? `Deleted ${rest}` : 'Scheduled job not found';
    }
    return 'Unknown schedule command\nUse /schedule for usage.';
  }

  async handleChannelCommand(request, raw) {
    const text = String(raw || '').trim();
    const publisher = this.telegramChannelPublisher;
    const operatorId = request.externalUserId || request.externalChatId || request.chatId;

    if (!publisher) {
      return 'Telegram channel publishing unavailable\nConfigure TG_BOT_TOKEN and TG_CHANNEL_TARGETS first.';
    }

    if (!text) {
      const targets = publisher.listTargets();
      return [
        'Telegram Channel Publishing',
        `configured: ${targets.length}`,
        `default: ${this.config.tgDefaultChannel || '(none)'}`,
        '',
        'Usage',
        '/channel list',
        '/channel preview <alias> | <content>',
        '/channel send <alias> | <content>',
        '/channel test <alias>',
      ].join('\n');
    }

    const [sub, rest] = parseParts(text);
    if (['list', 'ls'].includes(sub)) {
      const targets = publisher.listTargets();
      if (!targets.length) return 'No configured Telegram channel aliases';
      return [
        'Telegram Channel Targets',
        ...targets.map(({ alias, target }) => `- ${alias}: ${target}${alias === this.config.tgDefaultChannel ? ' [default]' : ''}`),
      ].join('\n');
    }
    if (sub === 'preview') {
      let parsed;
      try {
        parsed = parseChannelCommandInput(rest);
      } catch (error) {
        return `Usage\n/channel preview <alias> | <content>\nReason: ${error.message || error}`;
      }
      try {
        const preview = await publisher.preview({
          alias: parsed.alias,
          payload: parsed.content,
          operatorId,
        });
        return [
          '<b>Channel Preview</b>',
          `<b>Alias:</b> ${preview.alias}`,
          `<b>Target:</b> ${preview.target}`,
          `<b>Pages:</b> ${preview.pages.length}`,
          `<b>Images:</b> ${(preview.images || []).length}`,
          '',
          preview.html,
        ].join('\n');
      } catch (error) {
        return `Channel preview failed\nReason: ${error.message || error}`;
      }
    }
    if (sub === 'send') {
      let parsed;
      try {
        parsed = parseChannelCommandInput(rest);
      } catch (error) {
        return `Usage\n/channel send <alias> | <content>\nReason: ${error.message || error}`;
      }
      try {
        const result = await publisher.send({
          alias: parsed.alias,
          payload: parsed.content,
          operatorId,
        });
        return [
          'Channel publish sent',
          `Alias: ${result.alias}`,
          `Target: ${result.target}`,
          `Deliveries: ${result.published.length}`,
        ].join('\n');
      } catch (error) {
        return `Channel publish failed\nReason: ${error.message || error}`;
      }
    }
    if (sub === 'test') {
      if (!rest) return 'Usage\n/channel test <alias>';
      try {
        const result = await publisher.test({ alias: rest, operatorId });
        return [
          'Channel test sent',
          `Alias: ${result.alias}`,
          `Target: ${result.target}`,
          `Message: ${result.messageId}`,
        ].join('\n');
      } catch (error) {
        return `Channel test failed\nReason: ${error.message || error}`;
      }
    }

    return 'Unknown channel command\nUse /channel for usage.';
  }

  async runTask(request, sink, options = {}) {
    const chatId = String(request.chatId);
    const hostName = options.hostName || request.host;
    const taskHost = options.taskHost || request.host;
    const taskKey = this.makeTaskKey(taskHost, chatId);
    if (this.hasConflictingRunningTaskForChat(chatId, taskHost)) {
      if (this.shouldQueueConflictingTask(chatId, taskHost, options)) {
        return this.enqueueTask(request, sink, { ...options, hostName, taskHost });
      }
      await sink.final('当前会话已有任务在运行，请稍后重试。');
      return { success: false, skipped: true, summary: 'chat busy', errorText: 'chat already has a running task' };
    }

    const commandPrefix = options.commandPrefix || this.effectiveCommandPrefix(chatId);
    const workdir = this.normalizeWorkdir(options.workdir || this.effectiveWorkdir(chatId));
    const preflight = this.commandPreflight(commandPrefix, workdir);
    if (!preflight.ok) {
      const failedChecks = preflight.checks.filter((check) => !check.ok);
      const summary = failedChecks[0]?.detail || 'command preflight failed';
      console.warn(`[runtime] task blocked by preflight host=${taskHost} chat=${chatId} reason=${summary}`);
      await sink.final([
        '任务未执行：后端预检失败。',
        `command: ${preflight.redactedCommandPrefix}`,
        `workdir: ${preflight.workdir}`,
        ...failedChecks.slice(0, 4).map((check) => `- ${check.name}: ${check.detail}`),
      ].join('\n'));
      return { success: false, skipped: true, summary, errorText: summary };
    }

    return this.runTaskViaSdk({ request, sink, options, taskKey, chatId, taskHost, workdir, commandPrefix });
  }

  async runTaskViaSdk({ request, sink, options, taskKey, chatId, taskHost, workdir, commandPrefix }) {
    console.info(`[runtime] task start(sdk) host=${taskHost} chat=${chatId} cwd=${workdir} prompt=${truncateText(request.text, 120)}`);
    const started = Date.now();
    const abortController = new AbortController();
    const suppressProgress = Boolean(options.suppressProgress);
    let leadingThinkingActive = !suppressProgress;
    const thinkingTicker = suppressProgress
      ? null
      : setInterval(() => {
        if (!leadingThinkingActive || abortController.signal.aborted) return;
        sink.progress({
          status: 'Running',
          marker: 'thinking',
          text: 'thinking...',
          elapsedSeconds: (Date.now() - started) / 1000,
        }).catch(() => {});
      }, 1000);
    this.tasks.set(taskKey, {
      host: taskHost,
      chatId,
      startedAt: Date.now(),
      cancel: () => abortController.abort(),
    });

    try {
      this.store.appendConversationMessage?.(chatId, 'user', request.text, { maxItems: 24 });
      if (!suppressProgress) {
        await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
      }
      const preparedPrompt = this.buildPrompt(chatId, request.text, options.hostName || request.host, {
        roleName: options.roleName || '',
        memoryScope: options.memoryScope || '',
      });

      const backend = detectBackend(commandPrefix);
      if ((backend === BACKEND_CODEX || backend === BACKEND_CLAUDE || backend === BACKEND_PI) && !isAcpCommandPrefix(commandPrefix, backend)) {
        throw new Error(`Legacy ${backend} command prefixes are no longer supported. Please switch to ${defaultCommandPrefixForBackend(this.config, backend)}.`);
      }
      const provider = this.backendProvider(backend, commandPrefix);
      if (!provider) {
        throw new Error(`Unsupported backend for command prefix: ${commandPrefix}`);
      }

      const result = await provider.runTask({
        prompt: preparedPrompt,
        commandPrefix,
        workingDirectory: workdir,
        sessionId: Object.prototype.hasOwnProperty.call(options, 'sessionId') ? options.sessionId : this.store.getChatSession(chatId),
        abortSignal: abortController.signal,
        files: request.files || [],
        onPermissionRequest: typeof sink.requestPermission === 'function'
          ? (permissionRequest, meta = {}) => sink.requestPermission(permissionRequest, meta)
          : undefined,
        onEvent: async (event) => {
          if (suppressProgress) return;
          if (shouldSuppressProgressEvent(event, { backend })) return;
          const payload = this.buildRenderedProgressPayload(request.host, event, {
            elapsedSeconds: (Date.now() - started) / 1000,
            workingDirectory: workdir,
          });
          const previewBody = String(payload?.text || payload?.preview?.summary || payload?.preview?.content || '').trim() || 'thinking...';
          if (payload?.marker !== 'thinking' || previewBody.toLowerCase() !== 'thinking...') {
            leadingThinkingActive = false;
          }
          if (looksLikeContextPreview(previewBody, request.text)) return;
          await sink.progress({
            status: 'Running',
            marker: payload?.marker || 'thinking',
            text: previewBody,
            preview: payload?.preview,
            elapsedSeconds: Number(payload?.elapsedSeconds) || 0,
          });
        },
      });

      const sessionId = result.sessionId || '';
      if (sessionId) {
        if (typeof options.onSessionId === 'function') {
          options.onSessionId(sessionId);
        } else {
          this.store.setChatSession(chatId, sessionId);
        }
      }

      const opsResult = await applyAssistantOps({
        output: result.output,
        chatId,
        request,
        controller: this,
        store: this.store,
        scheduler: this.scheduler,
        config: this.config,
      });
      const finalOutput = [opsResult.output, ...opsResult.errors].filter(Boolean).join('\n\n').trim();

      // Pi 后端过滤思考和 Extension/Skills
      if (backend === BACKEND_PI) {
        finalOutput = stripThinkingAndExtensions(finalOutput, backend);
      }

      const previewInfo = extractStructuredPreview(finalOutput || opsResult.summaries.join('\n'), 'Done');
      const preview = previewInfo.content || finalOutput || opsResult.summaries.join('\n') || '(empty output)';
      if (opsResult.counts.role || opsResult.counts.memory || opsResult.counts.schedule) {
        console.info(`[runtime] applied ops host=${taskHost} chat=${chatId} role=${opsResult.counts.role} memory=${opsResult.counts.memory} schedule=${opsResult.counts.schedule}`);
      }
      console.info(`[runtime] task final backend=${backend} host=${taskHost} chat=${chatId} session=${sessionId || '-'} preview=${truncateText(preview, 160)}`);
      this.store.appendConversationMessage?.(chatId, 'assistant', preview, { maxItems: 24 });
      await sink.final({
        status: 'Done',
        marker: previewInfo.marker,
        text: preview,
        preview: previewInfo,
        elapsedSeconds: (Date.now() - started) / 1000,
      });

      // [disabled] Pi 后端发送语音总结
      // if (backend === BACKEND_PI && preview && typeof sink.sendAudio === 'function') {
      //   try {
      //     const audioPath = await generateSpeech(preview);
      //     if (audioPath) {
      //       // 截断 caption 到 Telegram 限制 (1024 字符)
      //       const caption = preview.length > 1024 ? preview.slice(0, 1021) + '...' : preview;
      //       const result = await sink.sendAudio(audioPath, { caption });
      //       if (!result.ok) {
      //         console.warn('[runtime] sendAudio failed:', result.reason);
      //       }
      //     }
      //   } catch (error) {
      //     console.warn('[runtime] sendAudio error:', error?.message || error);
      //   }
      // }

      return { success: true, summary: truncateText(preview, 240), cleanedOutput: preview, sessionId };
    } catch (error) {
      const message = error?.message || String(error);
      if (abortController.signal.aborted) {
        await sink.final('任务已取消。');
        return { success: false, skipped: true, summary: 'cancelled', errorText: 'cancelled' };
      }
      await sink.final(clip(`Task failed\nReason: ${message}`));
      return { success: false, summary: message, errorText: message };
    } finally {
      leadingThinkingActive = false;
      if (thinkingTicker) clearInterval(thinkingTicker);
      this.tasks.delete(taskKey);
      this.drainTaskQueue(chatId);
    }
  }

  async runPrompt(request, sink) {
    return this.runTask(request, sink, { hostName: request.host, taskHost: request.host });
  }

  async runScheduledJob(job, sink, options = {}) {
    const chatId = String(job.chat_id);
    this.ensureChatState(chatId);
    return this.runTask({
      host: options.host || 'scheduler',
      chatId,
      externalChatId: options.externalChatId || '',
      externalUserId: options.externalUserId || (job.owner_user_id == null ? '' : String(job.owner_user_id)),
      text: String(job.prompt_template || '').trim(),
    }, sink, {
      hostName: options.hostName || 'scheduled runtime',
      taskHost: options.taskHost || 'scheduler',
      suppressProgress: Object.prototype.hasOwnProperty.call(options, 'suppressProgress') ? options.suppressProgress : true,
      roleName: String(job.role || '').trim(),
      memoryScope: String(job.memory_scope || '').trim() || this.defaultMemoryScope(chatId),
      workdir: String(job.workdir || '').trim() || this.effectiveWorkdir(chatId),
      commandPrefix: String(job.command_prefix || '').trim() || this.effectiveCommandPrefix(chatId),
      sessionId: job.session_policy === 'resume-job' ? this.store.getJobSession(job.id) : '',
      onSessionId: (sessionId) => {
        if (job.session_policy === 'resume-job') {
          this.store.setJobSession(job.id, sessionId);
          return;
        }
        this.store.setChatSession(chatId, sessionId);
      },
    });
  }
}
