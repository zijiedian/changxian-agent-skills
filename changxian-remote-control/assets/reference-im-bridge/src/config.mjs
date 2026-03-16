import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { BACKEND_CODEX, defaultCommandPrefixForBackend, normalizeBackendAlias } from './backend-detection.mjs';
import { normalizeTelegramChannelAllowlist, parseTelegramChannelTargets } from './telegram-channel-publisher.mjs';

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function parseDurationSeconds(raw, fallbackSeconds = 7 * 24 * 3600) {
  const value = String(raw || '').trim();
  if (!value) return fallbackSeconds;
  const match = /^(\d+)\s*([smhd]?)$/i.exec(value);
  if (!match) {
    throw new Error('Auth TTL must be a positive duration such as 3600, 60s, 30m, 2h, or 7d');
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * multipliers[unit];
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Auth TTL must be positive');
  }
  return seconds;
}

export function codexHome() {
  return process.env.CODEX_HOME?.trim() ? path.resolve(process.env.CODEX_HOME.trim()) : path.join(os.homedir(), '.codex');
}

export function defaultStateDir() {
  return process.env.RC_STATE_DIR?.trim()
    ? path.resolve(process.env.RC_STATE_DIR.trim())
    : path.join(codexHome(), 'changxian-agent', 'remote-control-js');
}

export function loadConfig() {
  const stateDir = defaultStateDir();
  dotenv.config({ path: path.join(stateDir, '.env') });
  const authPassphrase = firstEnv('RC_AUTH_PASSPHRASE', 'TG_AUTH_PASSPHRASE', 'WECOM_AUTH_PASSPHRASE');
  const authTtlRaw = firstEnv('RC_AUTH_TTL_SECONDS', 'TG_AUTH_TTL_SECONDS', 'WECOM_AUTH_TTL_SECONDS');
  const tgChannelTargets = parseTelegramChannelTargets(firstEnv('TG_CHANNEL_TARGETS'));
  const tgDefaultChannel = String(process.env.TG_DEFAULT_CHANNEL || '').trim();
  const tgChannelAllowedOperatorIds = normalizeTelegramChannelAllowlist(firstEnv('TG_CHANNEL_ALLOWED_OPERATOR_IDS'));
  const defaultBackend = normalizeBackendAlias(process.env.RC_DEFAULT_BACKEND, BACKEND_CODEX);
  const codexCommandPrefix = String(process.env.CODEX_COMMAND_PREFIX || 'codex -a never --search exec -s danger-full-access --skip-git-repo-check').trim();
  const opencodeCommandPrefix = String(process.env.OPENCODE_ACP_COMMAND_PREFIX || 'opencode acp').trim();
  return {
    stateDir,
    host: String(process.env.RC_HOST || '0.0.0.0').trim(),
    healthPort: Number.parseInt(process.env.RC_PORT || '18081', 10),
    logFile: path.resolve(String(process.env.RC_LOG_FILE || path.join(stateDir, 'reference-im-bridge.log')).trim()),
    logMaxBytes: Number.parseInt(process.env.RC_LOG_MAX_BYTES || String(10 * 1024 * 1024), 10),
    logMaxFiles: Number.parseInt(process.env.RC_LOG_MAX_FILES || '3', 10),
    tgBotToken: String(process.env.TG_BOT_TOKEN || '').trim(),
    tgChannelTargets,
    tgDefaultChannel,
    tgChannelAllowedOperatorIds,
    wecomBotId: String(process.env.WECOM_BOT_ID || '').trim(),
    wecomBotSecret: String(process.env.WECOM_BOT_SECRET || '').trim(),
    wecomWsUrl: String(process.env.WECOM_WEBSOCKET_URL || 'wss://openws.work.weixin.qq.com').trim(),
    defaultBackend,
    codexCommandPrefix,
    opencodeCommandPrefix,
    defaultCommandPrefix: defaultCommandPrefixForBackend({ codexCommandPrefix, opencodeCommandPrefix }, defaultBackend),
    codexTimeoutSeconds: Number.parseInt(process.env.CODEX_TIMEOUT_SECONDS || '21600', 10),
    opencodeTimeoutSeconds: Number.parseInt(process.env.OPENCODE_ACP_TIMEOUT_SECONDS || '21600', 10),
    defaultTimezone: String(process.env.RC_DEFAULT_TIMEZONE || 'Asia/Shanghai').trim(),
    defaultWorkdir: path.resolve(String(process.env.RC_DEFAULT_WORKDIR || process.cwd()).trim() || process.cwd()),
    maxBufferedOutputChars: Number.parseInt(process.env.RC_MAX_BUFFERED_OUTPUT_CHARS || '200000', 10),
    maxConcurrentTasks: Number.parseInt(process.env.RC_MAX_CONCURRENT_TASKS || '2', 10),
    enableSessionResume: !['0', 'false', 'no'].includes(String(process.env.RC_ENABLE_SESSION_RESUME || '1').toLowerCase()),
    enableMemory: !['0', 'false', 'no'].includes(String(process.env.RC_ENABLE_MEMORY || '1').toLowerCase()),
    memoryAutoSave: !['0', 'false', 'no'].includes(String(process.env.RC_MEMORY_AUTO_SAVE || '1').toLowerCase()),
    memoryMaxItems: Number.parseInt(process.env.RC_MEMORY_MAX_ITEMS || '6', 10),
    memoryMaxChars: Number.parseInt(process.env.RC_MEMORY_MAX_CHARS || '2400', 10),
    enableScheduler: !['0', 'false', 'no'].includes(String(process.env.RC_ENABLE_SCHEDULER || '1').toLowerCase()),
    schedulerPollSeconds: Number.parseInt(process.env.RC_SCHEDULER_POLL_SECONDS || '5', 10),
    replyMaxChars: Number.parseInt(process.env.RC_REPLY_MAX_CHARS || '3500', 10),
    authPassphrase,
    authTtlSeconds: parseDurationSeconds(authTtlRaw),
  };
}
