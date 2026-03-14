export function parseDurationSeconds(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) throw new Error('duration is required');
  const match = /^(\d+)\s*([smhd]?)$/.exec(text);
  if (!match) throw new Error('duration must use s, m, h, or d');
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 's';
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * multipliers[unit];
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('duration must be positive');
  return seconds;
}

function parseCronField(field, minimum, maximum) {
  const values = new Set();
  for (const part of String(field || '').split(',')) {
    const token = part.trim();
    if (!token) throw new Error('invalid cron field');
    if (token === '*') {
      for (let value = minimum; value <= maximum; value += 1) values.add(value);
      continue;
    }

    let step = 1;
    let base = token;
    if (token.includes('/')) {
      const parts = token.split('/', 2);
      base = parts[0];
      step = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error('cron step must be positive');
    }

    let start = minimum;
    let end = maximum;
    if (base === '*') {
      start = minimum;
      end = maximum;
    } else if (base.includes('-')) {
      const parts = base.split('-', 2);
      start = Number.parseInt(parts[0], 10);
      end = Number.parseInt(parts[1], 10);
    } else {
      start = Number.parseInt(base, 10);
      end = start;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < minimum || end > maximum || start > end) {
      throw new Error('cron field out of range');
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new Error('cron field resolves to empty set');
  return values;
}

export function normalizeCronExpression(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must contain 5 fields');
  parseCronField(fields[0], 0, 59);
  parseCronField(fields[1], 0, 23);
  parseCronField(fields[2], 1, 31);
  parseCronField(fields[3], 1, 12);
  parseCronField(fields[4], 0, 6);
  return fields.join(' ');
}

function zonedParts(timestampMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number.parseInt(parts.minute, 10),
    hour: Number.parseInt(parts.hour, 10),
    day: Number.parseInt(parts.day, 10),
    month: Number.parseInt(parts.month, 10),
    weekday: weekdayMap[parts.weekday],
  };
}

export function nextCronTimestamp(expr, timeZone, nowTs) {
  const normalized = normalizeCronExpression(expr);
  const [minuteField, hourField, dayField, monthField, weekdayField] = normalized.split(/\s+/);
  const minuteValues = parseCronField(minuteField, 0, 59);
  const hourValues = parseCronField(hourField, 0, 23);
  const dayValues = parseCronField(dayField, 1, 31);
  const monthValues = parseCronField(monthField, 1, 12);
  const weekdayValues = parseCronField(weekdayField, 0, 6);
  let candidate = (Math.floor(Number(nowTs) / 60) * 60) + 60;
  const maxChecks = 525600;
  for (let index = 0; index < maxChecks; index += 1) {
    const parts = zonedParts(candidate * 1000, timeZone);
    if (
      minuteValues.has(parts.minute)
      && hourValues.has(parts.hour)
      && dayValues.has(parts.day)
      && monthValues.has(parts.month)
      && weekdayValues.has(parts.weekday)
    ) {
      return candidate;
    }
    candidate += 60;
  }
  throw new Error('unable to compute next cron run within one year');
}

export function computeNextRun(job, nowTs) {
  const scheduleType = String(job.schedule_type || '').trim().toLowerCase();
  if (scheduleType === 'once') return { nextRunAt: null, enabled: false };
  if (scheduleType === 'every') return { nextRunAt: nowTs + parseDurationSeconds(job.schedule_expr), enabled: true };
  if (scheduleType === 'cron') return { nextRunAt: nextCronTimestamp(job.schedule_expr, job.timezone, nowTs), enabled: true };
  throw new Error('unsupported schedule type: ' + job.schedule_type);
}

export function normalizeScheduleSpec({ scheduleType, scheduleExpr, timezone }) {
  const normalizedType = String(scheduleType || '').trim().toLowerCase();
  if (!['once', 'every', 'cron'].includes(normalizedType)) {
    throw new Error('schedule_type must be once, every, or cron');
  }

  const rawExpr = String(scheduleExpr || '').trim();
  if (!rawExpr) throw new Error('schedule_expr is required');

  if (normalizedType === 'every') {
    parseDurationSeconds(rawExpr);
    return {
      scheduleType: normalizedType,
      scheduleExpr: rawExpr.toLowerCase(),
      timezone: String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    };
  }

  if (normalizedType === 'cron') {
    return {
      scheduleType: normalizedType,
      scheduleExpr: normalizeCronExpression(rawExpr),
      timezone: String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    };
  }

  return {
    scheduleType: normalizedType,
    scheduleExpr: rawExpr,
    timezone: String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  };
}

function createNullSink() {
  return {
    async progress() {},
    async final() {},
  };
}

export class SchedulerRuntime {
  constructor(config, store, controller, adapters = {}) {
    this.config = config;
    this.store = store;
    this.controller = controller;
    this.adapters = adapters;
    this.timer = null;
    this.tickRunning = false;
    this.runningJobs = new Map();
    this.state = {
      enabled: Boolean(config.enableScheduler),
      runningJobs: 0,
      lastTickAt: null,
      lastError: null,
    };
  }

  snapshot() {
    return {
      enabled: this.state.enabled,
      active: Boolean(this.timer),
      runningJobs: this.runningJobs.size,
      lastTickAt: this.state.lastTickAt,
      lastError: this.state.lastError,
    };
  }

  start() {
    if (!this.config.enableScheduler || this.timer) return;
    const intervalMs = Math.max(1, Number(this.config.schedulerPollSeconds) || 5) * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.state.lastError = error?.message || String(error);
        console.error('[scheduler] tick failed', error);
      });
    }, intervalMs);
    this.tick().catch((error) => {
      this.state.lastError = error?.message || String(error);
      console.error('[scheduler] initial tick failed', error);
    });
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const running = [...this.runningJobs.values()];
    this.runningJobs.clear();
    await Promise.allSettled(running);
  }

  async tick() {
    if (!this.config.enableScheduler || this.tickRunning) return;
    this.tickRunning = true;
    this.state.lastTickAt = Math.floor(Date.now() / 1000);
    this.state.lastError = null;
    this.state.runningJobs = this.runningJobs.size;
    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const dueJobs = this.store.listDueJobs(nowTs, 20);
      for (const job of dueJobs) {
        if (this.runningJobs.has(job.id)) {
          if (String(job.concurrency_policy || 'skip') === 'skip') {
            const next = computeNextRun(job, nowTs);
            this.store.updateScheduleState({ jobId: job.id, nextRunAt: next.nextRunAt, enabled: next.enabled, lastRunAt: nowTs });
          }
          continue;
        }

        let next;
        try {
          next = computeNextRun(job, nowTs);
        } catch (error) {
          this.store.updateScheduleState({ jobId: job.id, nextRunAt: null, enabled: false, lastRunAt: nowTs });
          this.state.lastError = error?.message || String(error);
          console.error('[scheduler] invalid schedule', job.id, error);
          continue;
        }

        this.store.updateScheduleState({ jobId: job.id, nextRunAt: next.nextRunAt, enabled: next.enabled, lastRunAt: nowTs });
        const runId = this.store.createJobRun(job.id);
        const task = this.runJob(job, runId)
          .catch((error) => {
            this.state.lastError = error?.message || String(error);
            console.error('[scheduler] job failed', job.id, error);
          })
          .finally(() => {
            this.runningJobs.delete(job.id);
            this.state.runningJobs = this.runningJobs.size;
          });
        this.runningJobs.set(job.id, task);
        this.state.runningJobs = this.runningJobs.size;
      }
    } finally {
      this.tickRunning = false;
    }
  }

  async triggerJobNow(jobOrId) {
    const job = typeof jobOrId === 'string' ? this.store.getJobById(jobOrId) : jobOrId;
    if (!job) throw new Error('scheduled job not found');
    if (this.runningJobs.has(job.id)) throw new Error('job is already running');
    const runId = this.store.createJobRun(job.id);
    const task = this.runJob(job, runId)
      .finally(() => {
        this.runningJobs.delete(job.id);
        this.state.runningJobs = this.runningJobs.size;
      });
    this.runningJobs.set(job.id, task);
    this.state.runningJobs = this.runningJobs.size;
    return runId;
  }

  async runJob(job, runId) {
    const channel = this.resolveChannel(job);
    try {
      const result = await this.controller.runScheduledJob(job, channel.sink, {
        host: channel.host,
        hostName: channel.hostName,
        taskHost: 'scheduler:' + job.id,
        externalChatId: channel.externalChatId,
        externalUserId: channel.externalUserId,
      });

      if (result?.skipped) {
        this.store.finishJobRun(runId, {
          status: 'skipped',
          summary: result.summary || '',
          errorText: result.errorText || '',
        });
        return;
      }

      this.store.finishJobRun(runId, {
        status: result?.success ? 'success' : 'failed',
        summary: result?.summary || '',
        errorText: result?.errorText || '',
      });
    } catch (error) {
      this.store.finishJobRun(runId, {
        status: 'failed',
        summary: '',
        errorText: error?.message || String(error),
      });
      throw error;
    }
  }

  resolveChannel(job) {
    const chatId = String(job.chat_id);
    const bindings = this.store.listHostBindings(chatId);
    const telegramBinding = bindings.find((binding) => binding.host === 'telegram');
    const wecomBinding = bindings.find((binding) => binding.host === 'wecom');

    if (telegramBinding && this.adapters.telegram?.createPushSink) {
      return {
        host: 'telegram',
        hostName: 'Telegram scheduled runtime',
        externalChatId: String(telegramBinding.externalChatId || telegramBinding.chatId || chatId),
        externalUserId: String(telegramBinding.externalUserId || ''),
        sink: this.adapters.telegram.createPushSink(telegramBinding),
      };
    }

    if (wecomBinding && this.adapters.wecom?.createPushSink) {
      return {
        host: 'wecom',
        hostName: 'WeCom scheduled runtime',
        externalChatId: String(wecomBinding.externalChatId || ''),
        externalUserId: String(wecomBinding.externalUserId || ''),
        sink: this.adapters.wecom.createPushSink(wecomBinding),
      };
    }

    if (this.adapters.telegram?.createPushSink) {
      return {
        host: 'telegram',
        hostName: 'Telegram scheduled runtime',
        externalChatId: chatId,
        externalUserId: '',
        sink: this.adapters.telegram.createPushSink({ chatId, externalChatId: chatId }),
      };
    }

    return {
      host: 'scheduler',
      hostName: 'scheduled runtime',
      externalChatId: '',
      externalUserId: '',
      sink: createNullSink(),
    };
  }
}
