import { OPS_RES, extractOps } from './ops.mjs';
import { computeNextRun, normalizeScheduleSpec } from '../core/scheduler.mjs';

function clipInline(text, limit = 72) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function boolOrDefault(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeMemoryScope(defaultScope, rawScope, { allowEmpty = false } = {}) {
  const value = String(rawScope || '').trim();
  if (!value) return allowEmpty ? '' : defaultScope;
  if (['default', 'chat', 'chat:current'].includes(value)) return defaultScope;
  return value;
}

function normalizeMemoryKind(rawKind, fallback = 'note') {
  const value = String(rawKind || '').trim().toLowerCase();
  return value || fallback;
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (!record?.id || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function resolveMemoryTargets(store, chatId, defaultScope, op) {
  const records = [];
  const scope = op.scope == null ? null : normalizeMemoryScope(defaultScope, op.scope);
  if (op.memory_id) {
    const record = store.getMemory(chatId, op.memory_id);
    if (record) records.push(record);
  }
  if (op.query || op.contains) {
    records.push(...store.findMemories(chatId, {
      scope,
      query: op.query || '',
      contains: op.contains || '',
      limit: 500,
    }));
  }
  if (!records.length && scope && !op.memory_id && !op.query && !op.contains) {
    records.push(...store.findMemories(chatId, { scope, limit: 500 }));
  }
  return uniqueRecords(records);
}

function jobSearchText(job) {
  return [
    job?.id || '',
    job?.name || '',
    job?.prompt_template || '',
  ].join('\n').toLowerCase();
}

function resolveJobTargets(store, chatId, op) {
  const records = [];
  if (op.job_id) {
    const record = store.getJob(chatId, op.job_id);
    if (record) records.push(record);
  }

  const jobs = store.listJobs(chatId);
  const exactName = String(op.name || '').trim();
  if (exactName) {
    records.push(...jobs.filter((job) => String(job.name || '').trim() === exactName));
  }

  const query = String(op.query || '').trim().toLowerCase();
  const contains = String(op.contains || '').trim().toLowerCase();
  if (query || contains) {
    records.push(...jobs.filter((job) => {
      const haystack = jobSearchText(job);
      if (query && !haystack.includes(query)) return false;
      if (contains && !haystack.includes(contains)) return false;
      return true;
    }));
  }

  return uniqueRecords(records);
}

function schedulePrompt(op, fallback = '') {
  return String(op.prompt_template || op.prompt || fallback || '').trim();
}

function normalizeRoleOverride(rawRole) {
  const value = String(rawRole || '').trim();
  if (!value || value.toLowerCase() === 'none') return '';
  return value;
}

function normalizeMemoryScopeOverride(defaultScope, rawScope) {
  const value = String(rawScope || '').trim();
  if (!value) return '';
  if (value.toLowerCase() === 'none') return '';
  return normalizeMemoryScope(defaultScope, value);
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

async function applyRoleOps({ ops, chatId, controller, store }) {
  const summaries = [];
  const errors = [];

  for (const rawOp of ops) {
    const op = rawOp && typeof rawOp === 'object' ? rawOp : null;
    if (!op?.op) continue;
    try {
      if (op.op === 'upsert_role') {
        const name = controller.normalizeRoleName(op.name || '');
        const content = String(op.content || '').trim();
        if (!content) throw new Error('role content is required');
        store.upsertRole(chatId, name, content);
        if (boolOrDefault(op.activate, false)) store.setActiveRole(chatId, name);
        summaries.push(`角色已保存: ${name}`);
        continue;
      }

      if (op.op === 'use_role') {
        const name = controller.normalizeRoleName(op.name || '');
        if (!store.roleExists(chatId, name)) throw new Error(`role not found: ${name}`);
        store.setActiveRole(chatId, name);
        summaries.push(`角色已启用: ${name}`);
        continue;
      }

      if (op.op === 'clear_role') {
        const cleared = store.clearActiveRole(chatId);
        summaries.push(cleared ? '已清除默认角色' : '当前没有默认角色');
        continue;
      }

      if (op.op === 'delete_role') {
        const name = controller.normalizeRoleName(op.name || '');
        const deleted = store.deleteRole(chatId, name);
        if (!deleted) throw new Error(`role not found: ${name}`);
        summaries.push(`角色已删除: ${name}`);
        continue;
      }

      errors.push(`未识别的角色操作: ${op.op}`);
    } catch (error) {
      errors.push(`角色操作失败(${op.op}): ${error?.message || String(error)}`);
    }
  }

  return { summaries, errors };
}

async function applyMemoryOps({ ops, chatId, request, controller, store }) {
  const summaries = [];
  const errors = [];
  const defaultScope = controller.defaultMemoryScope(chatId);

  for (const rawOp of ops) {
    const op = rawOp && typeof rawOp === 'object' ? rawOp : null;
    if (!op?.op) continue;
    try {
      if (op.op === 'upsert') {
        const matchedTargets = op.memory_id
          ? []
          : resolveMemoryTargets(store, chatId, defaultScope, {
            memory_id: '',
            scope: op.scope,
            query: op.query,
            contains: op.contains,
          });
        const existing = op.memory_id
          ? store.getMemory(chatId, op.memory_id)
          : (matchedTargets[0] || null);
        const content = String(op.content ?? existing?.content ?? '').trim();
        if (!content) throw new Error('memory content is required');
        const record = store.upsertMemory({
          chatId,
          memoryId: existing?.id || op.memory_id || '',
          scope: normalizeMemoryScope(defaultScope, op.scope ?? existing?.scope),
          kind: normalizeMemoryKind(op.kind, existing?.kind || 'note'),
          title: String(op.title ?? existing?.title ?? clipInline(content)),
          content,
          tags: Array.isArray(op.tags) ? op.tags.map((item) => String(item)).filter(Boolean) : (existing?.tags || []),
          importance: op.importance == null ? Number(existing?.importance || 0) : Number(op.importance),
          pinned: boolOrDefault(op.pinned, Boolean(existing?.pinned)),
          sourceType: existing?.source_type || request.host || '',
          sourceRef: existing?.source_ref || request.externalUserId || request.externalChatId || '',
          expiresAt: op.expires_at ?? existing?.expires_at ?? null,
        });
        if (existing?.id && matchedTargets.length > 1) {
          summaries.push(`记忆已更新: ${record?.id || existing.id}（匹配 ${matchedTargets.length} 条，已使用最新一条）`);
        } else {
          summaries.push(`${existing?.id ? '记忆已更新' : '记忆已保存'}: ${record?.id || existing?.id || op.memory_id}`);
        }
        continue;
      }

      if (op.op === 'delete') {
        const targets = resolveMemoryTargets(store, chatId, defaultScope, op);
        if (!targets.length) {
          summaries.push('未找到匹配记忆');
          continue;
        }
        for (const record of targets) store.deleteMemory(chatId, record.id);
        summaries.push(`已删除记忆 ${targets.length} 条`);
        continue;
      }

      if (op.op === 'pin' || op.op === 'unpin') {
        const targets = resolveMemoryTargets(store, chatId, defaultScope, op);
        if (!targets.length) {
          summaries.push('未找到匹配记忆');
          continue;
        }
        const pinned = op.op === 'pin';
        for (const record of targets) store.setMemoryPinned(chatId, record.id, pinned);
        summaries.push(`${pinned ? '已置顶' : '已取消置顶'}记忆 ${targets.length} 条`);
        continue;
      }

      errors.push(`未识别的记忆操作: ${op.op}`);
    } catch (error) {
      errors.push(`记忆操作失败(${op.op}): ${error?.message || String(error)}`);
    }
  }

  return { summaries, errors };
}

function buildSchedulePatch(defaultScope, job, op, config) {
  const hasScheduleType = Object.prototype.hasOwnProperty.call(op, 'schedule_type');
  const hasScheduleExpr = Object.prototype.hasOwnProperty.call(op, 'schedule_expr');
  const hasTimezone = Object.prototype.hasOwnProperty.call(op, 'timezone');
  const hasEnabled = Object.prototype.hasOwnProperty.call(op, 'enabled');

  const nextScheduleType = hasScheduleType ? op.schedule_type : job.schedule_type;
  const nextScheduleExpr = hasScheduleExpr ? op.schedule_expr : job.schedule_expr;
  const nextTimezone = hasTimezone ? op.timezone : job.timezone || config.defaultTimezone;
  const normalized = normalizeScheduleSpec({
    scheduleType: nextScheduleType,
    scheduleExpr: nextScheduleExpr,
    timezone: nextTimezone,
  });

  const enabled = hasEnabled ? boolOrDefault(op.enabled, Boolean(job.enabled)) : Boolean(job.enabled);
  const scheduleState = enabled
    ? computeNextRun({
      schedule_type: normalized.scheduleType,
      schedule_expr: normalized.scheduleExpr,
      timezone: normalized.timezone,
    }, nowTs())
    : { nextRunAt: null, enabled: false };

  return {
    schedule_type: normalized.scheduleType,
    schedule_expr: normalized.scheduleExpr,
    timezone: normalized.timezone,
    prompt_template: schedulePrompt(op, job.prompt_template),
    name: String(op.name ?? op.title ?? job.name),
    role: normalizeRoleOverride(op.role ?? job.role),
    memory_scope: normalizeMemoryScopeOverride(defaultScope, op.memory_scope ?? job.memory_scope),
    workdir: String((op.workdir ?? op.cwd ?? job.workdir ?? config.defaultWorkdir) || '').trim() || config.defaultWorkdir,
    command_prefix: String((op.command_prefix ?? op.commandPrefix ?? job.command_prefix ?? config.codexCommandPrefix) || '').trim() || config.codexCommandPrefix,
    session_policy: String(op.session_policy ?? job.session_policy ?? 'resume-job'),
    enabled: enabled && scheduleState.enabled,
    next_run_at: enabled && scheduleState.enabled ? scheduleState.nextRunAt : null,
  };
}

async function applyScheduleOps({ ops, chatId, request, controller, store, scheduler, config }) {
  const summaries = [];
  const errors = [];
  const defaultScope = controller.defaultMemoryScope(chatId);

  for (const rawOp of ops) {
    const op = rawOp && typeof rawOp === 'object' ? rawOp : null;
    if (!op?.op) continue;
    try {
      if (op.op === 'create_job') {
        const promptTemplate = schedulePrompt(op);
        if (!promptTemplate) throw new Error('prompt is required');
        const normalized = normalizeScheduleSpec({
          scheduleType: op.schedule_type,
          scheduleExpr: op.schedule_expr,
          timezone: op.timezone || config.defaultTimezone,
        });
        const requestedEnabled = boolOrDefault(op.enabled, true);
        const scheduleState = requestedEnabled
          ? computeNextRun({
            schedule_type: normalized.scheduleType,
            schedule_expr: normalized.scheduleExpr,
            timezone: normalized.timezone,
          }, nowTs())
          : { nextRunAt: null, enabled: false };
        const job = store.createJob({
          chatId,
          ownerUserId: request.externalUserId || '',
          name: String(op.name || op.title || clipInline(promptTemplate, 48)),
          scheduleType: normalized.scheduleType,
          scheduleExpr: normalized.scheduleExpr,
          timezone: normalized.timezone,
          promptTemplate,
          role: normalizeRoleOverride(op.role),
          memoryScope: normalizeMemoryScopeOverride(defaultScope, op.memory_scope),
          workdir: String(op.workdir || op.cwd || controller.effectiveWorkdir(chatId)).trim(),
          commandPrefix: String(op.command_prefix || op.commandPrefix || controller.effectiveCommandPrefix(chatId)).trim(),
          sessionPolicy: String(op.session_policy || 'resume-job'),
          nextRunAt: requestedEnabled && scheduleState.enabled ? scheduleState.nextRunAt : null,
          enabled: requestedEnabled && scheduleState.enabled,
        });
        summaries.push(`已创建任务: ${job.id}`);
        continue;
      }

      if (op.op === 'set_job') {
        const targets = resolveJobTargets(store, chatId, op);
        if (!targets.length) {
          summaries.push('未找到匹配任务');
          continue;
        }
        for (const job of targets) {
          const patch = buildSchedulePatch(defaultScope, job, op, config);
          store.updateJob(chatId, job.id, patch);
        }
        summaries.push(`已更新任务 ${targets.length} 个`);
        continue;
      }

      if (op.op === 'pause_job') {
        const targets = resolveJobTargets(store, chatId, op);
        if (!targets.length) {
          summaries.push('未找到匹配任务');
          continue;
        }
        for (const job of targets) store.updateJob(chatId, job.id, { enabled: false, next_run_at: null });
        summaries.push(`已暂停任务 ${targets.length} 个`);
        continue;
      }

      if (op.op === 'resume_job') {
        const targets = resolveJobTargets(store, chatId, op);
        if (!targets.length) {
          summaries.push('未找到匹配任务');
          continue;
        }
        for (const job of targets) {
          const normalized = normalizeScheduleSpec({
            scheduleType: job.schedule_type,
            scheduleExpr: job.schedule_expr,
            timezone: job.timezone || config.defaultTimezone,
          });
          const scheduleState = computeNextRun({
            schedule_type: normalized.scheduleType,
            schedule_expr: normalized.scheduleExpr,
            timezone: normalized.timezone,
          }, nowTs());
          store.updateJob(chatId, job.id, {
            enabled: scheduleState.enabled,
            next_run_at: scheduleState.nextRunAt,
            schedule_type: normalized.scheduleType,
            schedule_expr: normalized.scheduleExpr,
            timezone: normalized.timezone,
          });
        }
        summaries.push(`已恢复任务 ${targets.length} 个`);
        continue;
      }

      if (op.op === 'run_job') {
        const targets = resolveJobTargets(store, chatId, op);
        if (!targets.length) {
          summaries.push('未找到匹配任务');
          continue;
        }
        if (!scheduler) throw new Error('scheduler runtime unavailable');
        for (const job of targets) await scheduler.triggerJobNow(job.id);
        summaries.push(`已触发任务 ${targets.length} 个`);
        continue;
      }

      if (op.op === 'delete_job') {
        const targets = resolveJobTargets(store, chatId, op);
        if (!targets.length) {
          summaries.push('未找到匹配任务');
          continue;
        }
        for (const job of targets) store.deleteJob(chatId, job.id);
        summaries.push(`已删除任务 ${targets.length} 个`);
        continue;
      }

      errors.push(`未识别的调度操作: ${op.op}`);
    } catch (error) {
      errors.push(`调度操作失败(${op.op}): ${error?.message || String(error)}`);
    }
  }

  return { summaries, errors };
}

export async function applyAssistantOps({ output, chatId, request, controller, store, scheduler, config }) {
  let stripped = String(output || '');

  const roleExtracted = extractOps(OPS_RES.role, stripped);
  stripped = roleExtracted.stripped;
  const memoryExtracted = extractOps(OPS_RES.memory, stripped);
  stripped = memoryExtracted.stripped;
  const scheduleExtracted = extractOps(OPS_RES.schedule, stripped);
  stripped = scheduleExtracted.stripped;

  const summaries = [];
  const errors = [];

  const roleResult = await applyRoleOps({
    ops: roleExtracted.ops,
    chatId,
    controller,
    store,
  });
  summaries.push(...roleResult.summaries);
  errors.push(...roleResult.errors);

  const memoryResult = await applyMemoryOps({
    ops: memoryExtracted.ops,
    chatId,
    request,
    controller,
    store,
  });
  summaries.push(...memoryResult.summaries);
  errors.push(...memoryResult.errors);

  const scheduleResult = await applyScheduleOps({
    ops: scheduleExtracted.ops,
    chatId,
    request,
    controller,
    store,
    scheduler,
    config,
  });
  summaries.push(...scheduleResult.summaries);
  errors.push(...scheduleResult.errors);

  return {
    output: stripped.trim(),
    summaries,
    errors,
    counts: {
      role: roleExtracted.ops.length,
      memory: memoryExtracted.ops.length,
      schedule: scheduleExtracted.ops.length,
    },
  };
}
