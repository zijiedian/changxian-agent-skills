import path from 'node:path';

import { splitShellArgs } from './utils.mjs';

export const BACKEND_CODEX = 'codex';
export const BACKEND_OPENCODE_ACP = 'opencode-acp';
export const BACKEND_UNSUPPORTED = 'unsupported';

function normalizeToken(token) {
  return path.basename(String(token || '').trim()).toLowerCase();
}

function isOpencodePackageToken(token) {
  const normalized = normalizeToken(token);
  return normalized === 'opencode' || normalized === '.opencode' || normalized === 'opencode-ai';
}

export function detectBackendFromArgs(args = []) {
  const tokens = args.map((token) => String(token || '').trim()).filter(Boolean);
  if (!tokens.length) return BACKEND_UNSUPPORTED;

  const base = normalizeToken(tokens[0]);
  if (base === 'codex') return BACKEND_CODEX;

  if (isOpencodePackageToken(tokens[0]) && tokens.slice(1).some((token) => normalizeToken(token) === 'acp')) {
    return BACKEND_OPENCODE_ACP;
  }

  if (['npx', 'pnpx', 'bunx', 'yarn', 'npm'].includes(base)) {
    const normalized = tokens.map(normalizeToken);
    const hasOpencodeToken = normalized.some(isOpencodePackageToken);
    const hasAcpToken = normalized.includes('acp');
    if (hasOpencodeToken && hasAcpToken) {
      return BACKEND_OPENCODE_ACP;
    }
  }

  return BACKEND_UNSUPPORTED;
}

export function detectBackend(commandPrefix = '') {
  return detectBackendFromArgs(splitShellArgs(commandPrefix));
}

export function normalizeBackendAlias(value, fallback = BACKEND_UNSUPPORTED) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === BACKEND_CODEX) return BACKEND_CODEX;
  if (['opencode', 'acp', BACKEND_OPENCODE_ACP].includes(normalized)) return BACKEND_OPENCODE_ACP;
  if (['default', 'reset', 'clear'].includes(normalized)) return 'default';
  return fallback;
}

export function defaultCommandPrefixForBackend(config = {}, backend = BACKEND_CODEX) {
  if (backend === BACKEND_OPENCODE_ACP) return String(config.opencodeCommandPrefix || 'opencode acp').trim();
  return String(config.codexCommandPrefix || '').trim();
}

export function backendLabel(backend = BACKEND_UNSUPPORTED) {
  if (backend === BACKEND_CODEX) return 'Codex SDK';
  if (backend === BACKEND_OPENCODE_ACP) return 'OpenCode ACP';
  return 'Unsupported';
}
