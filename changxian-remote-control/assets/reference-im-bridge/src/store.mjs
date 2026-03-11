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

function stableId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
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
    return records.filter((record) => `${record.title}\n${record.content}\n${record.tags.join(' ')}`.toLowerCase().includes(String(query).toLowerCase()));
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
