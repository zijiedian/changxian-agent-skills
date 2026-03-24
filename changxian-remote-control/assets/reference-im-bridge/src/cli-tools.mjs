import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const VERSION_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;
const CLI_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function shellCapture(command, env, timeout = DEFAULT_TIMEOUT_MS) {
  const result = spawnSync('/bin/zsh', ['-lc', command], {
    env,
    encoding: 'utf8',
    timeout,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function execCapture(command, args, env, timeout = DEFAULT_TIMEOUT_MS) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function commandPath(binary, env) {
  const result = shellCapture(`command -v ${binary}`, env);
  return result.ok ? firstLine(result.stdout) : '';
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return '';
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeSemver(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '');
}

function numericParts(version) {
  return normalizeSemver(version)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function detectCodexSource(path, resolvedPath) {
  const joined = `${path}\n${resolvedPath}`;
  if (joined.includes('@zed-industries/codex-acp')) return 'npm';
  return '';
}

function detectClaudeSource(path, resolvedPath) {
  const joined = `${path}\n${resolvedPath}`;
  if (joined.includes('@zed-industries/claude-agent-acp')) return 'npm';
  return '';
}

function detectOpencodeSource(path, resolvedPath) {
  const joined = `${path}\n${resolvedPath}`;
  if (joined.includes('/.opencode/')) return 'self-managed';
  if (joined.includes('node_modules/opencode-ai')) return 'npm';
  return 'cli';
}

function detectPiSource(path, resolvedPath) {
  const joined = `${path}\n${resolvedPath}`;
  if (joined.includes('node_modules/pi-acp')) return 'npm';
  return '';
}

function codexStatus(env, checkLatest = false) {
  const path = commandPath('codex-acp', env);
  const resolvedPath = path ? safeRealpath(path) : '';
  const versionOutput = path ? execCapture(path, ['--help'], env) : { ok: false, stdout: '', stderr: '' };
  const installedVersion = extractVersion(versionOutput.stdout || versionOutput.stderr);
  let latestVersion = '';
  let updateAvailable = null;

  if (checkLatest) {
    const latest = execCapture('npm', ['view', '@zed-industries/codex-acp', 'version'], env);
    latestVersion = extractVersion(latest.stdout || latest.stderr);
    if (installedVersion && latestVersion) {
      updateAvailable = compareVersions(installedVersion, latestVersion) < 0;
    }
  }

  return {
    id: 'codex',
    label: 'Codex ACP',
    installed: Boolean(path),
    path,
    resolvedPath,
    installedVersion,
    latestVersion,
    updateAvailable,
    source: detectCodexSource(path, resolvedPath),
    updateCommand: 'npm install -g @zed-industries/codex-acp@latest',
    canUpdate: Boolean(path),
  };
}

function claudeStatus(env, checkLatest = false) {
  const path = commandPath('claude-agent-acp', env);
  const resolvedPath = path ? safeRealpath(path) : '';
  const versionOutput = path ? execCapture(path, ['--help'], env) : { ok: false, stdout: '', stderr: '' };
  const installedVersion = extractVersion(versionOutput.stdout || versionOutput.stderr);
  let latestVersion = '';
  let updateAvailable = null;

  if (checkLatest) {
    const latest = execCapture('npm', ['view', '@zed-industries/claude-agent-acp', 'version'], env);
    latestVersion = extractVersion(latest.stdout || latest.stderr);
    if (installedVersion && latestVersion) {
      updateAvailable = compareVersions(installedVersion, latestVersion) < 0;
    }
  }

  const source = detectClaudeSource(path, resolvedPath);
  return {
    id: 'claude',
    label: 'Claude ACP',
    installed: Boolean(path),
    path,
    resolvedPath,
    installedVersion,
    latestVersion,
    updateAvailable,
    source,
    updateCommand: 'npm install -g @zed-industries/claude-agent-acp@latest',
    canUpdate: Boolean(path),
  };
}

function opencodeStatus(env, checkLatest = false) {
  const path = commandPath('opencode', env);
  const resolvedPath = path ? safeRealpath(path) : '';
  const versionOutput = path ? execCapture(path, ['--version'], env) : { ok: false, stdout: '', stderr: '' };
  const installedVersion = extractVersion(versionOutput.stdout || versionOutput.stderr);
  let latestVersion = '';
  let updateAvailable = null;

  if (checkLatest) {
    const latest = execCapture('npm', ['view', 'opencode-ai', 'version'], env);
    latestVersion = extractVersion(latest.stdout || latest.stderr);
    if (installedVersion && latestVersion) {
      updateAvailable = compareVersions(installedVersion, latestVersion) < 0;
    }
  }

  return {
    id: 'opencode',
    label: 'OpenCode',
    installed: Boolean(path),
    path,
    resolvedPath,
    installedVersion,
    latestVersion,
    updateAvailable,
    source: detectOpencodeSource(path, resolvedPath),
    updateCommand: 'opencode upgrade latest',
    canUpdate: Boolean(path),
  };
}

function piStatus(env, checkLatest = false) {
  const path = commandPath('pi-acp', env);
  const resolvedPath = path ? safeRealpath(path) : '';
  const versionOutput = path ? execCapture(path, ['--help'], env) : { ok: false, stdout: '', stderr: '' };
  const installedVersion = extractVersion(versionOutput.stdout || versionOutput.stderr);
  let latestVersion = '';
  let updateAvailable = null;

  if (checkLatest) {
    const latest = execCapture('npm', ['view', 'pi-acp', 'version'], env);
    latestVersion = extractVersion(latest.stdout || latest.stderr);
    if (installedVersion && latestVersion) {
      updateAvailable = compareVersions(installedVersion, latestVersion) < 0;
    }
  }

  return {
    id: 'pi',
    label: 'Pi ACP',
    installed: Boolean(path),
    path,
    resolvedPath,
    installedVersion,
    latestVersion,
    updateAvailable,
    source: detectPiSource(path, resolvedPath),
    updateCommand: 'npm install -g pi-acp@latest',
    canUpdate: Boolean(path),
  };
}

function updateCodex(env) {
  return execCapture('npm', ['install', '-g', '@zed-industries/codex-acp@latest'], env, UPDATE_TIMEOUT_MS);
}

function updateClaude(env, source) {
  return execCapture('npm', ['install', '-g', '@zed-industries/claude-agent-acp@latest'], env, UPDATE_TIMEOUT_MS);
}

function updateOpencode(env) {
  return execCapture('opencode', ['upgrade', 'latest'], env, UPDATE_TIMEOUT_MS);
}

function updatePi(env) {
  return execCapture('npm', ['install', '-g', 'pi-acp@latest'], env, UPDATE_TIMEOUT_MS);
}

export function extractVersion(text = '') {
  const match = VERSION_RE.exec(String(text || ''));
  return match?.[1] || '';
}

export function compareVersions(left, right) {
  const a = numericParts(left);
  const b = numericParts(right);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function formatCliStatusLine(status = {}) {
  const label = String(status.label || status.id || 'CLI').trim();
  const version = String(status.installedVersion || '').trim() || 'not installed';
  const latest = String(status.latestVersion || '').trim();
  const source = String(status.source || '').trim();
  let suffix = '';

  if (status.updateAvailable === true && latest) {
    suffix = ` -> ${latest} [可更新]`;
  } else if (status.updateAvailable === false && latest) {
    suffix = ' [最新]';
  } else if (!status.installed) {
    suffix = ' [未安装]';
  }

  return `${label}: ${version}${suffix}${source ? ` (${source})` : ''}`;
}

export function summarizeUpdateResult(result = {}) {
  const lines = ['CLI 更新结果'];
  for (const item of result.updated || []) {
    lines.push(`- ${item.label}: ${item.fromVersion} -> ${item.toVersion}`);
  }
  for (const item of result.skipped || []) {
    lines.push(`- ${item.label}: ${item.reason}`);
  }
  for (const item of result.failed || []) {
    lines.push(`- ${item.label}: ${item.reason}`);
  }
  return lines.join('\n');
}

function inspectStatuses(env, checkLatest = false) {
  return [
    codexStatus(env, checkLatest),
    claudeStatus(env, checkLatest),
    opencodeStatus(env, checkLatest),
    piStatus(env, checkLatest),
  ];
}

export class CliToolsManager {
  constructor(getEnv = () => process.env) {
    this.getEnv = getEnv;
    this.cache = null;
  }

  getSnapshot({ force = false, checkLatest = false } = {}) {
    const now = Date.now();
    if (
      !force
      && this.cache
      && now - this.cache.checkedAtMs < CLI_CACHE_TTL_MS
      && (!checkLatest || this.cache.checkLatest)
    ) {
      return this.cache.snapshot;
    }

    const snapshot = {
      checkedAt: new Date().toISOString(),
      checkLatest,
      statuses: inspectStatuses(this.getEnv(), checkLatest),
    };
    this.cache = {
      checkedAtMs: now,
      checkLatest,
      snapshot,
    };
    return snapshot;
  }

  updateOutdated() {
    const before = this.getSnapshot({ force: true, checkLatest: true });
    const env = this.getEnv();
    const updated = [];
    const skipped = [];
    const failed = [];

    for (const status of before.statuses) {
      if (!status.installed) {
        skipped.push({ label: status.label, reason: 'not installed' });
        continue;
      }
      if (status.updateAvailable === false) {
        skipped.push({ label: status.label, reason: 'already up to date' });
        continue;
      }
      if (status.updateAvailable == null) {
        skipped.push({ label: status.label, reason: 'latest version unavailable' });
        continue;
      }

      let result;
      if (status.id === 'codex') result = updateCodex(env);
      if (status.id === 'claude') result = updateClaude(env, status.source);
      if (status.id === 'opencode') result = updateOpencode(env);
      if (status.id === 'pi') result = updatePi(env);

      if (!result?.ok) {
        failed.push({
          label: status.label,
          reason: firstLine(result?.stderr || result?.stdout || 'update failed'),
        });
        continue;
      }

      updated.push({
        label: status.label,
        fromVersion: status.installedVersion || 'unknown',
        toVersion: status.installedVersion || 'unknown',
      });
    }

    const after = this.getSnapshot({ force: true, checkLatest: true });
    for (const item of updated) {
      const latest = after.statuses.find((status) => status.label === item.label);
      if (latest?.installedVersion) item.toVersion = latest.installedVersion;
    }

    return { before, after, updated, skipped, failed };
  }
}
