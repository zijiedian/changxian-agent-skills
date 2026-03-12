import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCommand, helpLines } from './commands.mjs';
import { extractStructuredPreview } from './codex.mjs';
import { redactedCommandText, truncateText } from './utils.mjs';

const CONTEXT_PREVIEW_MARKERS = ['[REMOTE HOST]', '[ACTIVE ROLE]', '[MEMORY CONTEXT]', '[CURRENT TASK]'];

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

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stableHash(value) {
  const digest = crypto.createHash('blake2b512').update(String(value)).digest();
  let result = 0n;
  for (const byte of digest.subarray(0, 8)) result = (result << 8n) | BigInt(byte);
  return String(result & ((1n << 63n) - 1n));
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

export class RuntimeController {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.tasks = new Map();
    this.authSessions = new Map();
    this.scheduler = null;
  }

  attachScheduler(scheduler) {
    this.scheduler = scheduler || null;
  }

  makeTaskKey(host, chatId) {
    return `${String(host)}:${String(chatId)}`;
  }

  hasRunningTaskForChat(chatId) {
    const target = String(chatId);
    return [...this.tasks.values()].some((entry) => entry?.chatId === target);
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
    return this.store.getChatWorkdir(chatId) || this.config.defaultWorkdir;
  }

  effectiveCommandPrefix(chatId) {
    return this.store.getChatCommandPrefix(chatId) || this.config.codexCommandPrefix;
  }

  displayCommandPrefix(chatId) {
    return redactedCommandText(this.effectiveCommandPrefix(chatId));
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
    sections.push(`[REMOTE HOST]\nRunning through ${hostName}. Keep progress concise and action-oriented. Only emit rc-role-ops, rc-memory-ops, or rc-schedule-ops blocks when the user explicitly asks to change roles, memory, or schedules.`);
    const activeRole = roleName || this.activeRoleName(chatId);
    if (activeRole) {
      const roleContent = this.store.getRole(chatId, activeRole);
      if (roleContent) sections.push(`[ACTIVE ROLE]\n${roleContent}`);
    }
    if (this.config.enableMemory) {
      const scope = memoryScope || this.defaultMemoryScope(chatId);
      const memories = this.store.listMemories(chatId, { scope, limit: Math.min(4, this.config.memoryMaxItems) });
      if (memories.length) {
        sections.push('[MEMORY CONTEXT]\n' + memories.map((record) => `- ${record.kind}: ${String(record.content).replace(/\s+/g, ' ').trim()}`).join('\n'));
      }
    }
    sections.push(`[CURRENT TASK]\n${prompt}`);
    return sections.join('\n\n');
  }

  extractSessionId(output) {
    const matches = [...String(output || '').matchAll(/session id:\s*([0-9a-f-]+)/ig)];
    return matches.length ? matches[matches.length - 1][1] : '';
  }

  buildCommand(chatId, prompt, { commandPrefix = '', workdir = '', sessionId = null } = {}) {
    const prefix = commandPrefix || this.effectiveCommandPrefix(chatId);
    const resolvedSessionId = sessionId !== null
      ? String(sessionId || '')
      : (this.config.enableSessionResume ? this.store.getChatSession(chatId) : '');
    const resolvedWorkdir = workdir || this.effectiveWorkdir(chatId);
    let command = prefix;
    if (resolvedSessionId && !/\bresume\b/.test(prefix)) {
      command = `${prefix} resume ${shellEscape(resolvedSessionId)} ${shellEscape(prompt)}`;
    } else {
      command = `${prefix} ${shellEscape(prompt)}`;
    }
    return { workdir: resolvedWorkdir, command };
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
      const lines = ['remote-control', ...helpLines()];
      if (this.isSecondFactorEnabled() && !this.isAuthenticated(request)) {
        lines.push('', this.authRequiredText());
      }
      await sink.final(lines.join('\n'));
      return true;
    }
    if (spec.name === 'run') {
      if (!rest) {
        await sink.final('Usage\n/run <prompt>');
        return true;
      }
      await this.runPrompt({ ...request, text: rest }, sink);
      return true;
    }
    if (spec.name === 'status') {
      await sink.final([
        `workdir: ${this.effectiveWorkdir(chatId)}`,
        `role: ${this.activeRoleName(chatId) || '(none)'}`,
        `memory: ${this.config.enableMemory ? 'enabled' : 'disabled'}`,
        `scheduler: ${this.config.enableScheduler ? 'enabled' : 'disabled'}`,
        `command: ${this.displayCommandPrefix(chatId)}`,
        `running: ${this.hasRunningTaskForChat(chatId) ? 'yes' : 'no'}`,
      ].join('\n'));
      return true;
    }
    if (spec.name === 'new') {
      this.store.clearChatSession(chatId);
      await sink.final('已重置当前会话。');
      return true;
    }
    if (spec.name === 'cancel') {
      const task = this.getTaskForChat(chatId)?.child;
      if (!task) {
        await sink.final('当前没有正在运行的任务。');
      } else {
        task.kill('SIGTERM');
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
        await sink.final(this.displayCommandPrefix(chatId));
        return true;
      }
      if (['clear', 'reset', 'default'].includes(rest.toLowerCase())) {
        this.store.clearChatCommandPrefix(chatId);
        await sink.final(this.displayCommandPrefix(chatId));
        return true;
      }
      this.store.setChatCommandPrefix(chatId, rest);
      await sink.final(this.effectiveCommandPrefix(chatId));
      return true;
    }
    if (spec.name === 'backend') {
      if (!rest) {
        await sink.final(this.displayCommandPrefix(chatId));
        return true;
      }
      const value = rest.toLowerCase();
      if (value === 'codex') {
        this.store.clearChatCommandPrefix(chatId);
        await sink.final(this.displayCommandPrefix(chatId));
        return true;
      }
      if (value === 'opencode') {
        const prefix = 'opencode run --dir <PROJECT_PATH> -m opencode/minimax-m2.5-free';
        this.store.setChatCommandPrefix(chatId, prefix);
        await sink.final(this.displayCommandPrefix(chatId));
        return true;
      }
      await sink.final('Usage\n/backend codex|opencode');
      return true;
    }
    if (spec.name === 'memory') {
      await sink.final(this.handleMemoryCommand(chatId, rest, request));
      return true;
    }
    if (spec.name === 'role') {
      await sink.final(this.handleRoleCommand(chatId, rest));
      return true;
    }
    if (spec.name === 'schedule') {
      await sink.final(await this.handleScheduleCommand(chatId, rest));
      return true;
    }
    if (spec.name === 'skill') {
      await sink.final(this.handleSkillCommand());
      return true;
    }
    if (spec.name === 'setting') {
      await sink.final(this.handleSettingCommand());
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

  handleSkillCommand() {
    const codexHome = process.env.CODEX_HOME?.trim() ? path.resolve(process.env.CODEX_HOME.trim()) : path.join(process.env.HOME || '', '.codex');
    const skillsDir = path.join(codexHome, 'skills');
    if (!fs.existsSync(skillsDir)) return 'No installed skills found';
    const names = fs.readdirSync(skillsDir).filter((name) => !name.startsWith('.')).sort();
    return names.length ? ['Installed Skills', ...names.map((name) => `- ${name}`)].join('\n') : 'No installed skills found';
  }

  handleSettingCommand() {
    return [
      `auth: ${this.isSecondFactorEnabled() ? `enabled (${formatSeconds(this.config.authTtlSeconds)})` : 'disabled'}`,
      `memory: ${this.config.enableMemory ? 'enabled' : 'disabled'}`,
      `scheduler: ${this.config.enableScheduler ? 'enabled' : 'disabled'}`,
      `session_resume: ${this.config.enableSessionResume ? 'enabled' : 'disabled'}`,
      `default_workdir: ${this.config.defaultWorkdir}`,
      `command_prefix: ${redactedCommandText(this.config.codexCommandPrefix)}`,
    ].join('\n');
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
      return ['Scheduled Jobs', ...jobs.slice(0, 10).map((job) => `${job.id} [${job.enabled ? 'enabled' : 'paused'}] ${job.schedule_type} ${job.schedule_expr} tz=${job.timezone}`)].join('\n');
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

  async runTask(request, sink, options = {}) {
    const chatId = String(request.chatId);
    const hostName = options.hostName || request.host;
    const taskHost = options.taskHost || request.host;
    const taskKey = this.makeTaskKey(taskHost, chatId);
    if (this.hasRunningTaskForChat(chatId)) {
      await sink.final('当前会话已有任务在运行，请稍后重试。');
      return { success: false, skipped: true, summary: 'chat busy', errorText: 'chat already has a running task' };
    }

    const preparedPrompt = this.buildPrompt(chatId, request.text, hostName, {
      roleName: options.roleName || '',
      memoryScope: options.memoryScope || '',
    });
    const { workdir, command } = this.buildCommand(chatId, preparedPrompt, {
      commandPrefix: options.commandPrefix || '',
      workdir: options.workdir || '',
      sessionId: Object.prototype.hasOwnProperty.call(options, 'sessionId') ? options.sessionId : null,
    });

    console.info(`[runtime] task start host=${taskHost} chat=${chatId} cwd=${workdir} prompt=${truncateText(request.text, 120)}`);
    const child = spawn('/bin/zsh', ['-lc', command], { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
    this.tasks.set(taskKey, { host: taskHost, chatId, child, startedAt: Date.now() });
    await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });

    let output = '';
    let previewOutput = '';
    let lastProgressKey = '';
    let progressTickRunning = false;
    const timeoutMs = this.config.codexTimeoutSeconds * 1000;
    const started = Date.now();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onChunk = (chunk) => {
      const text = String(chunk || '');
      output += text;
      previewOutput += text;
      if (previewOutput.length > this.config.maxBufferedOutputChars) {
        previewOutput = previewOutput.slice(-this.config.maxBufferedOutputChars);
      }
    };

    const emitProgress = async () => {
      if (progressTickRunning) return;
      progressTickRunning = true;
      try {
        const elapsedSeconds = (Date.now() - started) / 1000;
        const elapsedBucket = Math.floor(elapsedSeconds / 15);
        const preview = extractStructuredPreview(previewOutput, 'Running');
        const suppressed = preview.marker === 'thinking' || looksLikeContextPreview(preview.content, request.text);
        const progressMarker = suppressed ? 'thinking' : preview.marker;
        const previewContent = suppressed
          ? 'thinking...'
          : (preview.summary || preview.highlights[0] || preview.commandPreview || preview.content || 'thinking...');
        const previewBody = progressMarker === 'thinking'
          ? 'thinking...'
          : clip(previewContent, 3000);
        const progressKey = [
          progressMarker,
          preview.phase || '',
          preview.summary || '',
          preview.highlights[0] || '',
          preview.commandPreview || '',
          preview.changedFiles.slice(0, 3).join(','),
          elapsedBucket,
        ].join('\n');
        if (progressKey === lastProgressKey) return;
        lastProgressKey = progressKey;
        await sink.progress({
          status: 'Running',
          marker: progressMarker,
          text: previewBody,
          preview,
          elapsedSeconds,
        });
      } finally {
        progressTickRunning = false;
      }
    };

    const progressTimer = setInterval(() => {
      emitProgress().catch(() => {});
    }, 1000);

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(timeout);
    clearInterval(progressTimer);
    this.tasks.delete(taskKey);
    console.info(`[runtime] task exit host=${taskHost} chat=${chatId} code=${code} duration_s=${Math.floor((Date.now() - started) / 1000)} output_chars=${output.length}`);

    if (code !== 0) {
      const errorText = `codex exited with code ${code}`;
      await sink.final(clip(`Task failed\nReason: ${errorText}`));
      return { success: false, summary: errorText, errorText };
    }

    const previewInfo = extractStructuredPreview(output, 'Done');
    const preview = previewInfo.content || output.trim() || '(empty output)';
    const sessionId = this.extractSessionId(output);
    if (sessionId) {
      if (typeof options.onSessionId === 'function') {
        options.onSessionId(sessionId);
      } else {
        this.store.setChatSession(chatId, sessionId);
      }
    }
    console.info(`[runtime] task final host=${taskHost} chat=${chatId} session=${sessionId || '-'} preview=${truncateText(preview, 160)}`);
    await sink.final({
      status: 'Done',
      marker: previewInfo.marker,
      text: preview,
      preview: previewInfo,
      elapsedSeconds: (Date.now() - started) / 1000,
    });
    return { success: true, summary: truncateText(preview, 240), cleanedOutput: preview, sessionId };
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
