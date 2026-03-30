import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';

const SECRET_PATTERNS = [
  /(\b(?:token|secret|passphrase|password|authorization|api[-_]?key|cookie|session)\b["']?\s*[:=]\s*["']?)([^\s"',]+)/gi,
  /(Bearer\s+)([A-Za-z0-9._-]+)/g,
  /\b(bot\d+):([A-Za-z0-9_-]{20,})\b/g,
];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

let loggerState = null;

function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

export function maskSecrets(text) {
  let output = String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (_match, prefix, value) => `${prefix}${maskValue(value)}`);
  }
  return output;
}

function serializeArg(arg) {
  if (typeof arg === 'string') return arg;
  return util.inspect(arg, { depth: 4, breakLength: Infinity, colors: false, compact: true });
}

function openStream(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return fs.createWriteStream(logPath, { flags: 'a' });
}

function rotateIfNeeded(state) {
  try {
    const stat = fs.statSync(state.logPath);
    if (stat.size < state.maxBytes) return;
  } catch {
    return;
  }

  state.stream.end();
  for (let index = state.maxFiles; index >= 1; index -= 1) {
    const source = index === 1 ? state.logPath : `${state.logPath}.${index - 1}`;
    const target = `${state.logPath}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (index === state.maxFiles && fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
    fs.renameSync(source, target);
  }
  state.stream = openStream(state.logPath);
}

function createWriter(level) {
  return (...args) => {
    if (!loggerState) return;
    const message = args.map(serializeArg).join(' ');
    const timestamp = new Date().toISOString();
    const line = maskSecrets(`[${timestamp}] [${level}] ${message}`);
    rotateIfNeeded(loggerState);
    loggerState.stream.write(`${line}\n`);
    loggerState.original[level === 'DEBUG' ? 'debug' : level === 'INFO' ? 'log' : level.toLowerCase()](line);
  };
}

export function setupBridgeLogger(config = {}) {
  if (loggerState) return { logPath: loggerState.logPath };

  const logPath = String(config.logPath || '').trim()
    ? path.resolve(String(config.logPath))
    : path.resolve(String(config.stateDir || process.cwd()), 'reference-im-bridge.log');

  loggerState = {
    logPath,
    maxBytes: Math.max(1024 * 1024, Number(config.maxBytes) || DEFAULT_MAX_BYTES),
    maxFiles: Math.max(1, Number(config.maxFiles) || DEFAULT_MAX_FILES),
    stream: openStream(logPath),
    original: {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    },
  };

  console.log = createWriter('INFO');
  console.info = createWriter('INFO');
  console.warn = createWriter('WARN');
  console.error = createWriter('ERROR');
  console.debug = createWriter('DEBUG');

  return { logPath };
}

export function closeBridgeLogger() {
  if (!loggerState) return;
  try {
    loggerState.stream.end();
  } finally {
    loggerState = null;
  }
}
