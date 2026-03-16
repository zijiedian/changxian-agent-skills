import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { detectBackend, BACKEND_CODEX } from './backend-detection.mjs';
import { redactedCommandText, splitShellArgs } from './utils.mjs';

const REMOTE_CONTROL_ENV_RE = /^(?:TG_|WECOM_|RC_AUTH_|RC_CODEX_|RC_OPENCODE_|RC_DEFAULT_BACKEND$|RC_HOST$|RC_PORT$|RC_ENABLE_|RC_MEMORY_|RC_SCHEDULER_|RC_REPLY_|RC_MAX_|RC_DEFAULT_TIMEZONE$|OPENCODE_ACP_)/;
const VERSION_PROBE_ARGS = [['--version'], ['version'], ['-v']];
const CODEX_AUTH_PROBE_ARGS = [['login', 'status'], ['auth', 'status']];

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function which(binary, shell, env) {
  if (!binary) return '';
  if (binary.includes(path.sep) || binary.startsWith('.')) {
    return fs.existsSync(binary) ? path.resolve(binary) : '';
  }
  const probe = spawnSync(shell, ['-lc', `command -v ${shellEscape(binary)}`], {
    env,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (probe.status !== 0) return '';
  return firstLine(probe.stdout);
}

function runProbe(executable, args, env) {
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

export function buildExecutionEnv(baseEnv = process.env, overrides = {}) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (REMOTE_CONTROL_ENV_RE.test(key)) {
      delete env[key];
    }
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return { ...env, ...overrides };
}

export function runCommandPreflight(options = {}) {
  const shell = String(options.shell || '/bin/zsh').trim() || '/bin/zsh';
  const commandPrefix = String(options.commandPrefix || '').trim();
  const workdir = String(options.workdir || process.cwd()).trim() || process.cwd();
  const includeAuthProbe = options.includeAuthProbe === true;
  const env = options.env || buildExecutionEnv();
  const args = splitShellArgs(commandPrefix);
  const executable = args[0] || '';
  const backend = detectBackend(commandPrefix);
  const checks = [];

  const pushCheck = (name, ok, detail, severity = ok ? 'info' : 'error') => {
    checks.push({ name, ok, severity, detail: String(detail || '') });
  };

  pushCheck('shell', fs.existsSync(shell), fs.existsSync(shell) ? shell : `${shell} not found`);
  pushCheck('command-prefix', Boolean(commandPrefix), commandPrefix ? redactedCommandText(commandPrefix) : 'empty command prefix');
  pushCheck('workdir', fs.existsSync(workdir) && fs.statSync(workdir).isDirectory(), workdir);
  pushCheck(
    'backend',
    backend === BACKEND_CODEX || backend === 'opencode-acp',
    backend === BACKEND_CODEX ? 'codex sdk' : backend === 'opencode-acp' ? 'opencode acp' : 'unsupported command prefix',
  );

  if (args.some((arg) => /<[^>]+>/.test(arg))) {
    pushCheck('command-template', false, 'command prefix still contains angle-bracket placeholders');
  }

  const resolvedPath = executable ? which(executable, shell, env) : '';
  pushCheck('executable', Boolean(resolvedPath), resolvedPath || `${executable || '(empty)'} not found in PATH`);

  let version = '';
  let versionOk = false;
  if (resolvedPath) {
    for (const probeArgs of VERSION_PROBE_ARGS) {
      const probe = runProbe(resolvedPath, probeArgs, env);
      if (!probe.ok) continue;
      version = firstLine(probe.stdout || probe.stderr);
      versionOk = true;
      break;
    }
    pushCheck('version', versionOk, version || `failed to query version for ${resolvedPath}`);
  }

  let auth = '';
  if (includeAuthProbe && resolvedPath && backend === BACKEND_CODEX) {
    let authOk = false;
    for (const probeArgs of CODEX_AUTH_PROBE_ARGS) {
      const probe = runProbe(resolvedPath, probeArgs, env);
      auth = firstLine(probe.stdout || probe.stderr || probe.error);
      if (!probe.ok && /unrecognized subcommand/i.test(auth)) continue;
      authOk = probe.ok;
      break;
    }
    if (auth) {
      pushCheck('auth', authOk, auth || 'codex login status failed', authOk ? 'info' : 'warn');
    }
  }

  const ok = checks.every((check) => check.ok || check.severity !== 'error');
  return {
    checkedAt: new Date().toISOString(),
    ok,
    backend,
    shell,
    workdir: path.resolve(workdir),
    executable,
    resolvedPath,
    version,
    auth,
    redactedCommandPrefix: redactedCommandText(commandPrefix),
    checks,
  };
}
