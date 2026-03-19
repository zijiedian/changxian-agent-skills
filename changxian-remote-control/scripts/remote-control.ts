import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { BACKEND_CODEX, defaultCommandPrefixForBackend, normalizeBackendAlias } from '../assets/reference-im-bridge/src/backend-detection.mjs';
import { runCommandPreflight } from '../assets/reference-im-bridge/src/preflight.mjs';

type ArgMap = Record<string, string | boolean>;
type HealthSnapshot = Record<string, any> | null;

const DEFAULT_CODEX_COMMAND_PREFIX = 'codex -a never --search exec -s danger-full-access --skip-git-repo-check';
const DEFAULT_CLAUDE_COMMAND_PREFIX = 'claude';
const DEFAULT_OPENCODE_COMMAND_PREFIX = 'opencode acp';

function codexHome() {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), '.codex');
}

function defaultStateDir() {
  return process.env.RC_STATE_DIR?.trim()
    ? path.resolve(process.env.RC_STATE_DIR.trim())
    : path.join(codexHome(), 'changxian-agent', 'remote-control-js');
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags: ArgMap = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { positionals, flags };
}

function stringFlag(flags: ArgMap, key: string, fallback = '') {
  const value = flags[key];
  return typeof value === 'string' ? value : fallback;
}

function readEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const entries = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const line = entry.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

function usage() {
  return [
    'changxian-remote-control',
    '',
    'Run with: node --no-warnings --experimental-strip-types scripts/remote-control.ts <command> [flags]',
    '',
    'Commands',
    '  help',
    '  start [--foreground] [--state-dir <dir>] [--log-file <file>]',
    '  stop [--state-dir <dir>]',
    '  restart [--foreground] [--state-dir <dir>] [--log-file <file>]',
    '  status [--state-dir <dir>] [--url <healthz_url>]',
    '  logs [N] [--state-dir <dir>] [--file <log_file>]',
    '  doctor [--state-dir <dir>] [--url <healthz_url>]',
    '  health [--state-dir <dir>] [--url <healthz_url>]',
  ].join('\n');
}

function runtimeDir() {
  return path.resolve(path.dirname(process.argv[1]), '..', 'assets', 'reference-im-bridge');
}

function pidFile(stateDir: string) {
  return path.join(stateDir, 'remote-control.pid.json');
}

function defaultLogFile(stateDir: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  return path.join(stateDir, `remote-control-${timestamp}.log`);
}

function bridgeLogFile(stateDir: string) {
  return path.join(stateDir, 'reference-im-bridge.log');
}

function resolvePort(stateDir: string) {
  const fileEnv = readEnvFile(path.join(stateDir, '.env'));
  const raw = String(process.env.RC_PORT || fileEnv.RC_PORT || '18081').trim();
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) ? port : 18081;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findPidByPort(port: number) {
  if (process.platform === 'win32') return 0;
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim();
    const first = output.split(/\r?\n/, 1)[0];
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function readPidMeta(stateDir: string) {
  const file = pidFile(stateDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; logFile: string; startedAt: string };
  } catch {
    return null;
  }
}

function resolveRunningPid(stateDir: string) {
  const meta = readPidMeta(stateDir);
  if (meta?.pid && isProcessAlive(meta.pid)) {
    return meta.pid;
  }
  if (meta?.pid && !isProcessAlive(meta.pid)) {
    removePidMeta(stateDir);
  }
  return findPidByPort(resolvePort(stateDir));
}

function writePidMeta(stateDir: string, meta: { pid: number; logFile: string; startedAt: string }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pidFile(stateDir), `${JSON.stringify(meta, null, 2)}\n`);
}

function removePidMeta(stateDir: string) {
  fs.rmSync(pidFile(stateDir), { force: true });
}

function requestJson(url: string) {
  return new Promise<string>((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
  });
}

async function healthCheck(stateDir: string, explicitUrl = '') {
  const url = explicitUrl || `http://127.0.0.1:${resolvePort(stateDir)}/healthz`;
  const body = await requestJson(url);
  return { url, body };
}

function parseHealth(body: string): HealthSnapshot {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function runtimeSettings(stateDir: string) {
  const env = readEnvFile(path.join(stateDir, '.env'));
  const defaultBackend = normalizeBackendAlias(env.RC_DEFAULT_BACKEND || process.env.RC_DEFAULT_BACKEND, BACKEND_CODEX);
  const codexCommandPrefix = String(env.CODEX_COMMAND_PREFIX || process.env.CODEX_COMMAND_PREFIX || DEFAULT_CODEX_COMMAND_PREFIX).trim();
  const claudeCommandPrefix = String(env.RC_CLAUDE_COMMAND_PREFIX || process.env.RC_CLAUDE_COMMAND_PREFIX || DEFAULT_CLAUDE_COMMAND_PREFIX).trim();
  const opencodeCommandPrefix = String(env.OPENCODE_ACP_COMMAND_PREFIX || process.env.OPENCODE_ACP_COMMAND_PREFIX || DEFAULT_OPENCODE_COMMAND_PREFIX).trim();
  return {
    defaultBackend,
    commandPrefix: defaultCommandPrefixForBackend({ codexCommandPrefix, claudeCommandPrefix, opencodeCommandPrefix }, defaultBackend),
    workdir: path.resolve(String(env.RC_DEFAULT_WORKDIR || process.env.RC_DEFAULT_WORKDIR || process.cwd()).trim() || process.cwd()),
    logFile: path.resolve(String(env.RC_LOG_FILE || process.env.RC_LOG_FILE || bridgeLogFile(stateDir)).trim()),
  };
}

function tailLines(filePath: string, count: number) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n').trimEnd();
}

function formatCheck(check: { ok: boolean; severity?: string; name: string; detail: string }) {
  const marker = check.ok ? 'ok' : check.severity === 'warn' ? 'warn' : 'fail';
  return `[${marker}] ${check.name}: ${check.detail}`;
}

async function collectStatus(stateDir: string, explicitUrl = '') {
  const meta = readPidMeta(stateDir);
  const pid = resolveRunningPid(stateDir);
  let healthUrl = explicitUrl || `http://127.0.0.1:${resolvePort(stateDir)}/healthz`;
  let health: HealthSnapshot = null;
  let healthError = '';
  try {
    const result = await healthCheck(stateDir, explicitUrl);
    healthUrl = result.url;
    health = parseHealth(result.body);
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  }
  return { meta, pid, healthUrl, health, healthError };
}

async function printStatus(stateDir: string, explicitUrl = '') {
  const { meta, pid, healthUrl, health, healthError } = await collectStatus(stateDir, explicitUrl);
  const lines = [
    `state_dir: ${stateDir}`,
    `runtime: ${pid ? 'running' : 'stopped'}`,
    `pid: ${pid || '(none)'}`,
    `started_at: ${meta?.startedAt || '(unknown)'}`,
    `launcher_log: ${meta?.logFile || '(none)'}`,
    `bridge_log: ${runtimeSettings(stateDir).logFile}`,
    `health_url: ${healthUrl}`,
  ];
  if (health) {
    lines.push(`health: ok=${String(Boolean(health.ok))} ready=${String(Boolean(health.ready))}`);
    if (health.adapters?.telegram) {
      lines.push(`telegram: connected=${String(Boolean(health.adapters.telegram.connected))} authenticated=${String(Boolean(health.adapters.telegram.authenticated))}`);
    }
    if (health.adapters?.wecom) {
      lines.push(`wecom: connected=${String(Boolean(health.adapters.wecom.connected))} authenticated=${String(Boolean(health.adapters.wecom.authenticated))}`);
    }
    const preflight = health.diagnostics?.defaultCommandPreflight;
    if (preflight) {
      lines.push(`default_preflight: ${preflight.ok ? 'ok' : 'fail'} ${preflight.redactedCommandPrefix || ''}`.trim());
    }
  } else {
    lines.push(`health: unavailable (${healthError || 'unknown error'})`);
  }
  console.log(lines.join('\n'));
}

async function printLogs(stateDir: string, countRaw: string, fileOverride = '') {
  const count = Math.max(1, Number.parseInt(countRaw || '50', 10) || 50);
  const meta = readPidMeta(stateDir);
  const bridgeLog = runtimeSettings(stateDir).logFile;
  const fallback = meta?.logFile ? path.resolve(meta.logFile) : bridgeLogFile(stateDir);
  const preferred = fileOverride || (fs.existsSync(bridgeLog) ? bridgeLog : fallback);
  const filePath = path.resolve(String(preferred || fallback).trim());
  if (!fs.existsSync(filePath)) {
    throw new Error(`log file not found: ${filePath}`);
  }
  console.log(`# ${filePath}`);
  console.log(tailLines(filePath, count));
}

async function printDoctor(stateDir: string, explicitUrl = '') {
  const status = await collectStatus(stateDir, explicitUrl);
  const settings = runtimeSettings(stateDir);
  const preflight = runCommandPreflight({
    commandPrefix: settings.commandPrefix,
    workdir: settings.workdir,
    includeAuthProbe: true,
  });
  const lines = [
    'Remote Control Doctor',
    '',
    `state_dir: ${stateDir}`,
    `runtime_dir: ${runtimeDir()}`,
    `pid: ${status.pid || '(none)'}`,
    `launcher_log: ${status.meta?.logFile || '(none)'}`,
    `bridge_log: ${settings.logFile}`,
    `health_url: ${status.healthUrl}`,
    '',
    'Checks',
    `[${fs.existsSync(stateDir) ? 'ok' : 'fail'}] state-dir: ${stateDir}`,
    `[${fs.existsSync(runtimeDir()) ? 'ok' : 'fail'}] runtime-dir: ${runtimeDir()}`,
    status.health
      ? `[ok] health: ok=${String(Boolean(status.health.ok))} ready=${String(Boolean(status.health.ready))}`
      : `[fail] health: ${status.healthError || 'unavailable'}`,
    ...preflight.checks.map(formatCheck),
  ];

  if (status.health?.adapters) {
    lines.push('');
    lines.push('Adapters');
    for (const [name, adapter] of Object.entries(status.health.adapters)) {
      const value = adapter as Record<string, any>;
      lines.push(
        `[${value.lastError ? 'warn' : 'ok'}] ${name}: connected=${String(Boolean(value.connected))} authenticated=${String(Boolean(value.authenticated))}` +
        `${value.lastError ? ` error=${String(value.lastError)}` : ''}`,
      );
    }
  }

  if (preflight.auth) {
    lines.push('');
    lines.push(`auth_status: ${preflight.auth}`);
  }

  const doctorLogFile = fs.existsSync(settings.logFile)
    ? settings.logFile
    : (status.meta?.logFile ? path.resolve(status.meta.logFile) : '');
  if (!status.health && doctorLogFile && fs.existsSync(doctorLogFile)) {
    lines.push('');
    lines.push('Recent bridge logs');
    lines.push(tailLines(doctorLogFile, 20) || '(empty)');
  }

  console.log(lines.join('\n'));
}

async function startRuntime(stateDir: string, logFile: string, foreground: boolean) {
  const runningPid = resolveRunningPid(stateDir);
  if (runningPid) {
    console.log(`already running: pid=${runningPid}`);
    return;
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const env = { ...process.env, RC_STATE_DIR: stateDir };
  const args = ['./src/index.mjs'];

  if (foreground) {
    const child = spawn(process.execPath, args, {
      cwd: runtimeDir(),
      env,
      stdio: 'inherit',
    });
    writePidMeta(stateDir, {
      pid: child.pid ?? 0,
      logFile,
      startedAt: new Date().toISOString(),
    });
    child.on('exit', (code) => {
      if (readPidMeta(stateDir)?.pid === child.pid) removePidMeta(stateDir);
      process.exit(code ?? 0);
    });
    return;
  }

  const output = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, args, {
    cwd: runtimeDir(),
    env,
    detached: true,
    stdio: ['ignore', output, output],
  });
  child.unref();
  writePidMeta(stateDir, {
    pid: child.pid ?? 0,
    logFile,
    startedAt: new Date().toISOString(),
  });
  console.log(`started: pid=${child.pid} log=${logFile}`);
}

async function stopRuntime(stateDir: string) {
  const meta = readPidMeta(stateDir);
  const pid = meta?.pid && isProcessAlive(meta.pid) ? meta.pid : resolveRunningPid(stateDir);
  if (!pid) {
    console.log('not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidMeta(stateDir);
      console.log(`stopped: pid=${pid}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  process.kill(pid, 'SIGKILL');
  removePidMeta(stateDir);
  console.log(`killed: pid=${pid}`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = String(positionals[0] || 'help').toLowerCase();
  const stateDir = path.resolve(stringFlag(flags, 'state-dir', defaultStateDir()));
  const logFile = path.resolve(stringFlag(flags, 'log-file', defaultLogFile(stateDir)));
  const foreground = flags.foreground === true;

  if (command === 'help') {
    console.log(usage());
    return;
  }

  if (command === 'start') {
    await startRuntime(stateDir, logFile, foreground);
    return;
  }
  if (command === 'stop') {
    await stopRuntime(stateDir);
    return;
  }
  if (command === 'restart') {
    await stopRuntime(stateDir);
    await startRuntime(stateDir, logFile, foreground);
    return;
  }
  if (command === 'status') {
    await printStatus(stateDir, stringFlag(flags, 'url'));
    return;
  }
  if (command === 'logs') {
    await printLogs(stateDir, String(positionals[1] || '50'), stringFlag(flags, 'file'));
    return;
  }
  if (command === 'doctor') {
    await printDoctor(stateDir, stringFlag(flags, 'url'));
    return;
  }
  if (command === 'health') {
    const { url, body } = await healthCheck(stateDir, stringFlag(flags, 'url'));
    console.log(url);
    console.log(body);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
