import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_ROLES = {
  reviewer: 'You are a repository reviewer. Prioritize concrete findings, risks, regressions, and missing tests. Keep summaries brief and put findings first.',
  writer: 'You are a technical writer. Explain decisions clearly, remove fluff, and keep the structure easy to scan. Prefer practical examples over abstract language.',
  researcher: 'You are a research assistant. Gather evidence carefully, separate facts from inference, and cite concrete sources when available.'
};

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function parseTags(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function normalizeSearchNeedle(value) {
  return String(value || '').trim().toLowerCase();
}

function memorySearchText(record) {
  const tags = Array.isArray(record?.tags) ? record.tags : parseTags(record?.tags_json);
  return [
    record?.title || '',
    record?.content || '',
    tags.join(' '),
  ].join('\n').toLowerCase();
}

function stableId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function clipConversationContent(value, limit = 4000) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeWorkdirValue(workdir, { defaultWorkdir, legacyPrefixes = [] }) {
  const raw = String(workdir || '').trim();
  if (!raw) return String(defaultWorkdir);

  const resolved = path.resolve(raw);
  for (const prefix of legacyPrefixes) {
    const normalizedPrefix = String(prefix || '').trim();
    if (!normalizedPrefix) continue;
    if (resolved === normalizedPrefix || resolved.startsWith(`${normalizedPrefix}${path.sep}`)) {
      return String(defaultWorkdir);
    }
  }

  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return String(defaultWorkdir);
    }
  } catch {
    return String(defaultWorkdir);
  }

  return resolved;
}

export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    this.db = new Database(path.join(stateDir, 'agent_state.sqlite3'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_workdirs (chat_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_command_prefixes (chat_id TEXT PRIMARY KEY, prefix TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_active_roles (chat_id TEXT PRIMARY KEY, role_name TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (chat_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, name));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT '',
        source_ref TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_hit_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memories_chat_scope_updated ON memories(chat_id, scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_chat_pinned ON memories(chat_id, pinned DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_chat_created ON conversation_messages(chat_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        owner_user_id TEXT,
        name TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        timezone TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        memory_scope TEXT NOT NULL DEFAULT '',
        workdir TEXT NOT NULL DEFAULT '',
        command_prefix TEXT NOT NULL DEFAULT '',
        session_policy TEXT NOT NULL DEFAULT 'resume-job',
        concurrency_policy TEXT NOT NULL DEFAULT 'skip',
        next_run_at INTEGER,
        last_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        output_file TEXT NOT NULL DEFAULT '',
        error_text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS job_sessions (job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_bindings (host TEXT NOT NULL, chat_id TEXT NOT NULL, external_chat_id TEXT, external_user_id TEXT, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(host, chat_id));
    `);
  }

  normalizeLegacyWorkdirs({ defaultWorkdir, legacyPrefixes = [] }) {
    const normalize = (value) => normalizeWorkdirValue(value, { defaultWorkdir, legacyPrefixes });

    const chatRows = this.db.prepare('SELECT chat_id, workdir FROM chat_workdirs').all();
    for (const row of chatRows) {
      const nextWorkdir = normalize(row.workdir);
      if (nextWorkdir === row.workdir) continue;
      this.setChatWorkdir(row.chat_id, nextWorkdir);
    }

    const jobRows = this.db.prepare('SELECT id, chat_id, workdir FROM scheduled_jobs').all();
    for (const row of jobRows) {
      const nextWorkdir = normalize(row.workdir);
      if (nextWorkdir === row.workdir) continue;
      this.updateJob(row.chat_id, row.id, { workdir: nextWorkdir });
    }
  }

  close() {
    this.db.close();
  }

  ensureDefaultRoles(chatId) {
    const now = nowTs();
    const upsert = this.db.prepare('INSERT OR IGNORE INTO roles (chat_id, name, content, updated_at) VALUES (?, ?, ?, ?)');
    for (const [name, content] of Object.entries(DEFAULT_ROLES)) {
      upsert.run(String(chatId), name, content, now);
    }
  }

  getChatSession(chatId) {
    const row = this.db.prepare('SELECT session_id FROM chat_sessions WHERE chat_id = ?').get(String(chatId));
    return row?.session_id || '';
  }

  setChatSession(chatId, sessionId) {
    this.db.prepare(`
      INSERT INTO chat_sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(String(chatId), String(sessionId), nowTs());
  }

  clearChatSession(chatId) {
    const info = this.db.prepare('DELETE FROM chat_sessions WHERE chat_id = ?').run(String(chatId));
    return info.changes > 0;
  }

  getChatWorkdir(chatId) {
    const row = this.db.prepare('SELECT workdir FROM chat_workdirs WHERE chat_id = ?').get(String(chatId));
    return row?.workdir || '';
  }

  setChatWorkdir(chatId, workdir) {
    this.db.prepare(`
      INSERT INTO chat_workdirs (chat_id, workdir, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET workdir = excluded.workdir, updated_at = excluded.updated_at
    `).run(String(chatId), String(workdir), nowTs());
  }

  clearChatWorkdir(chatId) {
    const info = this.db.prepare('DELETE FROM chat_workdirs WHERE chat_id = ?').run(String(chatId));
    return info.changes > 0;
  }

  getChatCommandPrefix(chatId) {
    const row = this.db.prepare('SELECT prefix FROM chat_command_prefixes WHERE chat_id = ?').get(String(chatId));
    return row?.prefix || '';
  }

  setChatCommandPrefix(chatId, prefix) {
    this.db.prepare(`
      INSERT INTO chat_command_prefixes (chat_id, prefix, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET prefix = excluded.prefix, updated_at = excluded.updated_at
    `).run(String(chatId), String(prefix), nowTs());
  }

  clearChatCommandPrefix(chatId) {
    const info = this.db.prepare('DELETE FROM chat_command_prefixes WHERE chat_id = ?').run(String(chatId));
    return info.changes > 0;
  }

  getActiveRole(chatId) {
    const row = this.db.prepare('SELECT role_name FROM chat_active_roles WHERE chat_id = ?').get(String(chatId));
    return row?.role_name || '';
  }

  setActiveRole(chatId, roleName) {
    if (!roleName) {
      this.clearActiveRole(chatId);
      return;
    }
    this.db.prepare(`
      INSERT INTO chat_active_roles (chat_id, role_name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET role_name = excluded.role_name, updated_at = excluded.updated_at
    `).run(String(chatId), String(roleName), nowTs());
  }

  clearActiveRole(chatId) {
    const info = this.db.prepare('DELETE FROM chat_active_roles WHERE chat_id = ?').run(String(chatId));
    return info.changes > 0;
  }

  listRoles(chatId) {
    this.ensureDefaultRoles(chatId);
    return this.db.prepare('SELECT name FROM roles WHERE chat_id = ? ORDER BY name ASC').all(String(chatId)).map((row) => row.name);
  }

  roleExists(chatId, roleName) {
    const row = this.db.prepare('SELECT 1 FROM roles WHERE chat_id = ? AND name = ?').get(String(chatId), String(roleName));
    return Boolean(row);
  }

  getRole(chatId, roleName) {
    this.ensureDefaultRoles(chatId);
    const row = this.db.prepare('SELECT content FROM roles WHERE chat_id = ? AND name = ?').get(String(chatId), String(roleName));
    return row?.content || '';
  }

  upsertRole(chatId, roleName, content) {
    this.db.prepare(`
      INSERT INTO roles (chat_id, name, content, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(String(chatId), String(roleName), String(content).trim(), nowTs());
  }

  deleteRole(chatId, roleName) {
    const info = this.db.prepare('DELETE FROM roles WHERE chat_id = ? AND name = ?').run(String(chatId), String(roleName));
    const active = this.getActiveRole(chatId);
    if (active === String(roleName)) this.clearActiveRole(chatId);
    return info.changes > 0;
  }

  countMemories(chatId, scope = null) {
    if (scope) {
      return this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE chat_id = ? AND scope = ?').get(String(chatId), scope).count;
    }
    return this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE chat_id = ?').get(String(chatId)).count;
  }

  listMemories(chatId, { scope = null, query = '', limit = 12 } = {}) {
    const rows = scope
      ? this.db.prepare('SELECT * FROM memories WHERE chat_id = ? AND scope = ? ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?').all(String(chatId), scope, limit)
      : this.db.prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?').all(String(chatId), limit);
    const records = rows.map((row) => ({ ...row, tags: parseTags(row.tags_json), pinned: Boolean(row.pinned) }));
    if (!query) return records;
    const needle = normalizeSearchNeedle(query);
    return records.filter((record) => memorySearchText(record).includes(needle));
  }

  getMemory(chatId, memoryId) {
    const row = this.db.prepare('SELECT * FROM memories WHERE chat_id = ? AND id = ?').get(String(chatId), String(memoryId));
    return row ? { ...row, tags: parseTags(row.tags_json), pinned: Boolean(row.pinned) } : null;
  }

  findMemories(chatId, { scope = null, query = '', contains = '', limit = 200 } = {}) {
    const normalizedQuery = normalizeSearchNeedle(query);
    const normalizedContains = normalizeSearchNeedle(contains);
    const rows = scope
      ? this.db.prepare('SELECT * FROM memories WHERE chat_id = ? AND scope = ? ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?').all(String(chatId), String(scope), Number(limit))
      : this.db.prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?').all(String(chatId), Number(limit));
    const records = rows.map((row) => ({ ...row, tags: parseTags(row.tags_json), pinned: Boolean(row.pinned) }));
    return records.filter((record) => {
      const haystack = memorySearchText(record);
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (normalizedContains && !haystack.includes(normalizedContains)) return false;
      return true;
    });
  }

  addMemory({ chatId, scope, kind, content, title = '', tags = [], importance = 0, pinned = false, sourceType = '', sourceRef = '', expiresAt = null }) {
    const now = nowTs();
    const record = {
      id: stableId('mem'),
      chat_id: String(chatId),
      scope: String(scope),
      kind: String(kind),
      title: String(title),
      content: String(content),
      tags_json: JSON.stringify(tags),
      importance: Number(importance),
      pinned: pinned ? 1 : 0,
      source_type: String(sourceType),
      source_ref: String(sourceRef),
      created_at: now,
      updated_at: now,
      last_hit_at: null,
      expires_at: expiresAt
    };
    this.db.prepare(`
      INSERT INTO memories (id, chat_id, scope, kind, title, content, tags_json, importance, pinned, source_type, source_ref, created_at, updated_at, last_hit_at, expires_at)
      VALUES (@id, @chat_id, @scope, @kind, @title, @content, @tags_json, @importance, @pinned, @source_type, @source_ref, @created_at, @updated_at, @last_hit_at, @expires_at)
    `).run(record);
    return { ...record, tags, pinned: Boolean(record.pinned) };
  }

  upsertMemory({ chatId, memoryId = '', scope, kind, content, title = '', tags = [], importance = 0, pinned = false, sourceType = '', sourceRef = '', expiresAt = null }) {
    const existing = memoryId ? this.getMemory(chatId, memoryId) : null;
    if (!existing) {
      const created = this.addMemory({
        chatId,
        scope,
        kind,
        content,
        title,
        tags,
        importance,
        pinned,
        sourceType,
        sourceRef,
        expiresAt,
      });
      if (memoryId && created.id !== String(memoryId)) {
        this.db.prepare('UPDATE memories SET id = ? WHERE id = ? AND chat_id = ?').run(String(memoryId), created.id, String(chatId));
        return this.getMemory(chatId, memoryId);
      }
      return created;
    }

    const now = nowTs();
    const record = {
      id: String(existing.id),
      chat_id: String(chatId),
      scope: String(scope ?? existing.scope),
      kind: String(kind ?? existing.kind),
      title: String(title ?? existing.title),
      content: String(content ?? existing.content),
      tags_json: JSON.stringify(Array.isArray(tags) ? tags : existing.tags),
      importance: Number.isFinite(Number(importance)) ? Number(importance) : Number(existing.importance),
      pinned: pinned ? 1 : 0,
      source_type: String(sourceType ?? existing.source_type ?? ''),
      source_ref: String(sourceRef ?? existing.source_ref ?? ''),
      expires_at: expiresAt ?? existing.expires_at ?? null,
      updated_at: now,
    };
    this.db.prepare(`
      UPDATE memories
      SET scope = @scope,
          kind = @kind,
          title = @title,
          content = @content,
          tags_json = @tags_json,
          importance = @importance,
          pinned = @pinned,
          source_type = @source_type,
          source_ref = @source_ref,
          expires_at = @expires_at,
          updated_at = @updated_at
      WHERE chat_id = @chat_id AND id = @id
    `).run(record);
    return this.getMemory(chatId, record.id);
  }

  setMemoryPinned(chatId, memoryId, pinned) {
    const info = this.db.prepare('UPDATE memories SET pinned = ?, updated_at = ? WHERE chat_id = ? AND id = ?').run(pinned ? 1 : 0, nowTs(), String(chatId), String(memoryId));
    return info.changes > 0;
  }

  deleteMemory(chatId, memoryId) {
    const info = this.db.prepare('DELETE FROM memories WHERE chat_id = ? AND id = ?').run(String(chatId), String(memoryId));
    return info.changes > 0;
  }

  clearMemoryScope(chatId, scope) {
    const info = this.db.prepare('DELETE FROM memories WHERE chat_id = ? AND scope = ?').run(String(chatId), String(scope));
    return info.changes;
  }

  appendConversationMessage(chatId, role, content, { maxItems = 24 } = {}) {
    const trimmed = clipConversationContent(content);
    if (!trimmed) return null;
    const now = nowTs();
    this.db.prepare(`
      INSERT INTO conversation_messages (chat_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(String(chatId), String(role || 'user'), trimmed, now);

    const rows = this.db.prepare('SELECT id FROM conversation_messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC').all(String(chatId));
    if (rows.length > maxItems) {
      const overflow = rows.slice(maxItems).map((row) => row.id);
      const remove = this.db.prepare('DELETE FROM conversation_messages WHERE id = ?');
      const tx = this.db.transaction((ids) => {
        for (const id of ids) remove.run(id);
      });
      tx(overflow);
    }

    return {
      chat_id: String(chatId),
      role: String(role || 'user'),
      content: trimmed,
      created_at: now,
    };
  }

  listConversationMessages(chatId, { limit = 6 } = {}) {
    const rows = this.db.prepare(`
      SELECT role, content, created_at
      FROM conversation_messages
      WHERE chat_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(String(chatId), Number(limit));
    return rows.reverse();
  }

  countJobs(chatId, { enabledOnly = false } = {}) {
    return enabledOnly
      ? this.db.prepare('SELECT COUNT(*) as count FROM scheduled_jobs WHERE chat_id = ? AND enabled = 1').get(String(chatId)).count
      : this.db.prepare('SELECT COUNT(*) as count FROM scheduled_jobs WHERE chat_id = ?').get(String(chatId)).count;
  }

  listJobs(chatId) {
    return this.db.prepare('SELECT * FROM scheduled_jobs WHERE chat_id = ? ORDER BY enabled DESC, next_run_at ASC, created_at DESC').all(String(chatId));
  }

  getJob(chatId, jobId) {
    return this.db.prepare('SELECT * FROM scheduled_jobs WHERE chat_id = ? AND id = ?').get(String(chatId), String(jobId)) || null;
  }

  getJobById(jobId) {
    return this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(String(jobId)) || null;
  }

  listDueJobs(now, limit = 20) {
    return this.db.prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?').all(Number(now), Number(limit));
  }

  updateScheduleState({ jobId, nextRunAt, enabled, lastRunAt = null }) {
    this.db.prepare('UPDATE scheduled_jobs SET next_run_at = ?, enabled = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ? WHERE id = ?').run(nextRunAt, enabled ? 1 : 0, lastRunAt, nowTs(), String(jobId));
  }

  createJobRun(jobId) {
    const runId = stableId('run');
    this.db.prepare('INSERT INTO job_runs (id, job_id, started_at, status, summary, output_file, error_text) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, String(jobId), nowTs(), 'running', '', '', '');
    return runId;
  }

  finishJobRun(runId, { status, summary = '', outputFile = '', errorText = '' } = {}) {
    this.db.prepare('UPDATE job_runs SET finished_at = ?, status = ?, summary = ?, output_file = ?, error_text = ? WHERE id = ?').run(nowTs(), String(status || 'unknown'), String(summary), String(outputFile), String(errorText), String(runId));
  }

  getJobSession(jobId) {
    const row = this.db.prepare('SELECT session_id FROM job_sessions WHERE job_id = ?').get(String(jobId));
    return row?.session_id || '';
  }

  setJobSession(jobId, sessionId) {
    this.db.prepare(`
      INSERT INTO job_sessions (job_id, session_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(String(jobId), String(sessionId), nowTs());
  }

  clearJobSession(jobId) {
    const info = this.db.prepare('DELETE FROM job_sessions WHERE job_id = ?').run(String(jobId));
    return info.changes > 0;
  }

  setJobEnabled(chatId, jobId, enabled, nextRunAt) {
    const info = this.db.prepare('UPDATE scheduled_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE chat_id = ? AND id = ?').run(enabled ? 1 : 0, nextRunAt, nowTs(), String(chatId), String(jobId));
    return info.changes > 0;
  }

  deleteJob(chatId, jobId) {
    const info = this.db.prepare('DELETE FROM scheduled_jobs WHERE chat_id = ? AND id = ?').run(String(chatId), String(jobId));
    this.db.prepare('DELETE FROM job_sessions WHERE job_id = ?').run(String(jobId));
    return info.changes > 0;
  }

  createJob({
    chatId,
    ownerUserId = '',
    name,
    scheduleType,
    scheduleExpr,
    timezone,
    promptTemplate,
    role = '',
    memoryScope = '',
    workdir = '',
    commandPrefix = '',
    sessionPolicy = 'resume-job',
    concurrencyPolicy = 'skip',
    nextRunAt = null,
    lastRunAt = null,
    enabled = true,
  }) {
    const now = nowTs();
    const id = stableId('job');
    this.db.prepare(`
      INSERT INTO scheduled_jobs (
        id, chat_id, owner_user_id, name, schedule_type, schedule_expr, timezone, prompt_template,
        role, memory_scope, workdir, command_prefix, session_policy, concurrency_policy,
        next_run_at, last_run_at, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(chatId),
      ownerUserId == null ? null : String(ownerUserId),
      String(name),
      String(scheduleType),
      String(scheduleExpr),
      String(timezone),
      String(promptTemplate),
      String(role),
      String(memoryScope),
      String(workdir),
      String(commandPrefix),
      String(sessionPolicy),
      String(concurrencyPolicy),
      nextRunAt == null ? null : Number(nextRunAt),
      lastRunAt == null ? null : Number(lastRunAt),
      enabled ? 1 : 0,
      now,
      now,
    );
    return this.getJob(chatId, id);
  }

  updateJob(chatId, jobId, patch) {
    const fields = [];
    const values = [];
    const allowed = {
      owner_user_id: (value) => value == null ? null : String(value),
      name: (value) => String(value),
      schedule_type: (value) => String(value),
      schedule_expr: (value) => String(value),
      timezone: (value) => String(value),
      prompt_template: (value) => String(value),
      role: (value) => String(value),
      memory_scope: (value) => String(value),
      workdir: (value) => String(value),
      command_prefix: (value) => String(value),
      session_policy: (value) => String(value),
      concurrency_policy: (value) => String(value),
      next_run_at: (value) => value == null ? null : Number(value),
      last_run_at: (value) => value == null ? null : Number(value),
      enabled: (value) => value ? 1 : 0,
    };

    for (const [column, normalize] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
      fields.push(`${column} = ?`);
      values.push(normalize(patch[column]));
    }
    if (!fields.length) return this.getJob(chatId, jobId);

    fields.push('updated_at = ?');
    values.push(nowTs(), String(chatId), String(jobId));
    const info = this.db.prepare(`UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE chat_id = ? AND id = ?`).run(...values);
    return info.changes > 0 ? this.getJob(chatId, jobId) : null;
  }

  saveHostBinding(host, chatId, binding) {
    this.db.prepare(`
      INSERT INTO host_bindings (host, chat_id, external_chat_id, external_user_id, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host, chat_id) DO UPDATE SET
        external_chat_id = excluded.external_chat_id,
        external_user_id = excluded.external_user_id,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(String(host), String(chatId), binding.externalChatId || null, binding.externalUserId || null, JSON.stringify(binding), nowTs());
  }

  getHostBinding(host, chatId) {
    const row = this.db.prepare('SELECT payload_json FROM host_bindings WHERE host = ? AND chat_id = ?').get(String(host), String(chatId));
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  listHostBindings(chatId) {
    const rows = this.db.prepare('SELECT host, payload_json FROM host_bindings WHERE chat_id = ? ORDER BY updated_at DESC').all(String(chatId));
    return rows.map((row) => {
      try {
        return { host: row.host, ...JSON.parse(row.payload_json) };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
}
