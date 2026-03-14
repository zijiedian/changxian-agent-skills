import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommand, helpLines } from './commands.mjs';
import { applyAssistantOps } from './assistant_ops.mjs';
import { CodexSdkProvider } from './codex-sdk-provider.mjs';
import { extractStructuredPreview } from './codex.mjs';
import { buildExecutionEnv, runCommandPreflight } from './preflight.mjs';
import { redactedCommandText, truncateText } from './utils.mjs';

const CONTEXT_PREVIEW_MARKERS = ['[REMOTE HOST]', '[ACTIVE ROLE]', '[MEMORY CONTEXT]', '[CURRENT TASK]'];
const PREFLIGHT_CACHE_TTL_MS = 5 * 60 * 1000;

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

export class RuntimeController {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.tasks = new Map();
    this.authSessions = new Map();
    this.scheduler = null;
    this.preflightCache = new Map();
    this.codexSdk = new CodexSdkProvider(config, buildExecutionEnv);
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
    const current = this.store.getChatWorkdir(chatId);
    const normalized = this.normalizeWorkdir(current);
    if (current && normalized !== current) {
      this.store.setChatWorkdir(chatId, normalized);
    }
    return normalized;
  }

  effectiveCommandPrefix(chatId) {
    return this.store.getChatCommandPrefix(chatId) || this.config.codexCommandPrefix;
  }

  displayCommandPrefix(chatId) {
    return redactedCommandText(this.effectiveCommandPrefix(chatId));
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
        await sink.final('codex');
        return true;
      }
      const value = rest.toLowerCase();
      if (value === 'codex') {
        this.store.clearChatCommandPrefix(chatId);
        await sink.final('已切回 Codex SDK 默认后端。');
        return true;
      }
      await sink.final('当前 runtime 仅支持 Codex SDK。\nUsage\n/backend codex');
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
    const codexSdk = this.codexSdk.getDiagnostics();
    return [
      `auth: ${this.isSecondFactorEnabled() ? `enabled (${formatSeconds(this.config.authTtlSeconds)})` : 'disabled'}`,
      `memory: ${this.config.enableMemory ? 'enabled' : 'disabled'}`,
      `scheduler: ${this.config.enableScheduler ? 'enabled' : 'disabled'}`,
      `session_resume: ${this.config.enableSessionResume ? 'enabled' : 'disabled'}`,
      `default_workdir: ${this.config.defaultWorkdir}`,
      `command_prefix: ${redactedCommandText(this.config.codexCommandPrefix)}`,
      `codex_sdk: ${codexSdk.initialized ? 'initialized' : 'lazy'}`,
      `codex_model_passthrough: ${codexSdk.modelPassthrough ? 'enabled' : 'disabled'}`,
      `codex_auth: ${codexSdk.authSource}`,
      `codex_base_url: ${codexSdk.baseUrlSource}`,
      ...(codexSdk.lastInitError ? [`codex_last_init_error: ${codexSdk.lastInitError}`] : []),
      ...(codexSdk.lastResumeSkipReason ? [`codex_last_resume_skip: ${codexSdk.lastResumeSkipReason}`] : []),
      ...(codexSdk.lastTransientRetryReason ? [`codex_last_transient_retry: ${codexSdk.lastTransientRetryReason}`] : []),
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
    let leadingThinkingActive = true;
    const thinkingTicker = setInterval(() => {
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
      await sink.progress({ status: 'Running', marker: 'thinking', text: 'thinking...', elapsedSeconds: 0 });
      const preparedPrompt = this.buildPrompt(chatId, request.text, options.hostName || request.host, {
        roleName: options.roleName || '',
        memoryScope: options.memoryScope || '',
      });

      const result = await this.codexSdk.runTask({
        prompt: preparedPrompt,
        commandPrefix,
        workingDirectory: workdir,
        sessionId: Object.prototype.hasOwnProperty.call(options, 'sessionId') ? options.sessionId : this.store.getChatSession(chatId),
        abortSignal: abortController.signal,
        files: request.files || [],
        onProgress: async (payload) => {
          const elapsedSeconds = (Date.now() - started) / 1000;
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
            elapsedSeconds,
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
      const previewInfo = extractStructuredPreview(finalOutput || opsResult.summaries.join('\n'), 'Done');
      const preview = previewInfo.content || finalOutput || opsResult.summaries.join('\n') || '(empty output)';
      if (opsResult.counts.role || opsResult.counts.memory || opsResult.counts.schedule) {
        console.info(`[runtime] applied ops host=${taskHost} chat=${chatId} role=${opsResult.counts.role} memory=${opsResult.counts.memory} schedule=${opsResult.counts.schedule}`);
      }
      console.info(`[runtime] task final(sdk) host=${taskHost} chat=${chatId} session=${sessionId || '-'} preview=${truncateText(preview, 160)}`);
      await sink.final({
        status: 'Done',
        marker: previewInfo.marker,
        text: preview,
        preview: previewInfo,
        elapsedSeconds: (Date.now() - started) / 1000,
      });
      return { success: true, summary: truncateText(preview, 240), cleanedOutput: preview, sessionId };
    } catch (error) {
      const message = error?.message || String(error);
      if (abortController.signal.aborted) {
        await sink.final('任务已取消。');
        throw error;
      }
      await sink.final(clip(`Task failed\nReason: ${message}`));
      return { success: false, summary: message, errorText: message };
    } finally {
      leadingThinkingActive = false;
      clearInterval(thinkingTicker);
      this.tasks.delete(taskKey);
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
