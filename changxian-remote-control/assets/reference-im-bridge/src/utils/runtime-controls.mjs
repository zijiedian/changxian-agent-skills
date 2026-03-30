import { BACKEND_CLAUDE, BACKEND_CODEX, BACKEND_OPENCODE_ACP, BACKEND_PI, isAcpCommandPrefix } from './backend-detection.mjs';
import { splitShellArgs } from './utils.mjs';

export const CODEX_PERMISSION_LEVELS = ['readonly', 'low', 'high'];
export const CLAUDE_PERMISSION_LEVELS = ['default', 'plan', 'accept'];

function firstExecutable(prefix, fallback) {
  const args = splitShellArgs(String(prefix || '').trim());
  return args[0] || fallback;
}

function codexOptions(prefix) {
  const args = splitShellArgs(String(prefix || '').trim());
  let approvalPolicy = 'on-request';
  let sandboxMode = 'danger-full-access';

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    const next = String(args[index + 1] || '').trim();
    if ((token === '-a' || token === '--ask-for-approval') && next) {
      approvalPolicy = next;
      index += 1;
      continue;
    }
    if ((token === '-s' || token === '--sandbox' || token === '--sandbox-mode') && next) {
      sandboxMode = next;
      index += 1;
    }
  }

  return { approvalPolicy, sandboxMode };
}

function claudeOptions(prefix) {
  const args = splitShellArgs(String(prefix || '').trim());
  let permissionMode = 'default';

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    const next = String(args[index + 1] || '').trim();
    if ((token === '--permission-mode' || token === '-p') && next) {
      permissionMode = next;
      index += 1;
    }
  }

  return { permissionMode };
}

export function isCodexPermissionLevel(value) {
  return CODEX_PERMISSION_LEVELS.includes(String(value || '').trim().toLowerCase());
}

export function isClaudePermissionLevel(value) {
  return CLAUDE_PERMISSION_LEVELS.includes(String(value || '').trim().toLowerCase());
}

export function detectCodexPermissionLevel(prefix = '') {
  const { approvalPolicy, sandboxMode } = codexOptions(prefix);
  if (sandboxMode === 'read-only') return 'readonly';
  if (sandboxMode === 'workspace-write' && approvalPolicy === 'on-request') return 'low';
  if (sandboxMode === 'danger-full-access' && approvalPolicy === 'never') return 'high';
  return 'custom';
}

export function buildCodexPermissionPrefix(level, config = {}, currentPrefix = '') {
  const executable = firstExecutable(currentPrefix || config.codexCommandPrefix, 'codex');
  if (level === 'readonly') return `${executable} -a on-request --search exec -s read-only --skip-git-repo-check`;
  if (level === 'low') return `${executable} -a on-request --search exec -s workspace-write --skip-git-repo-check`;
  if (level === 'high') return `${executable} -a never --search exec -s danger-full-access --skip-git-repo-check`;
  return '';
}

export function codexPermissionLabel(level = 'custom') {
  if (level === 'readonly') return '只读';
  if (level === 'low') return '标准';
  if (level === 'high') return '高权限';
  return '自定义';
}

export function detectClaudePermissionLevel(prefix = '') {
  const { permissionMode } = claudeOptions(prefix);
  if (permissionMode === 'default') return 'default';
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'acceptEdits') return 'accept';
  return 'custom';
}

export function buildClaudePermissionPrefix(level, config = {}, currentPrefix = '') {
  const executable = firstExecutable(currentPrefix || config.claudeCommandPrefix, 'claude');
  if (level === 'default') return `${executable} --permission-mode default`;
  if (level === 'plan') return `${executable} --permission-mode plan`;
  if (level === 'accept') return `${executable} --permission-mode acceptEdits`;
  return '';
}

export function claudePermissionLabel(level = 'custom') {
  if (level === 'default') return '默认';
  if (level === 'plan') return 'Plan';
  if (level === 'accept') return 'Accept';
  return '自定义';
}

export function buildRuntimeControlState(backend, commandPrefix, config = {}) {
  if (isAcpCommandPrefix(commandPrefix, backend)) {
    return {
      backend,
      permissionKind: `${backend}-acp`,
      permissionLevel: 'managed',
      permissionLabel: '后端控制',
      permissionOptions: [],
    };
  }

  if (backend === BACKEND_CODEX) {
    const permissionLevel = detectCodexPermissionLevel(commandPrefix);
    return {
      backend,
      permissionKind: 'codex',
      permissionLevel,
      permissionLabel: codexPermissionLabel(permissionLevel),
      permissionOptions: CODEX_PERMISSION_LEVELS.map((value) => ({ value, label: codexPermissionLabel(value) })),
    };
  }

  if (backend === BACKEND_CLAUDE) {
    const permissionLevel = detectClaudePermissionLevel(commandPrefix);
    return {
      backend,
      permissionKind: 'claude',
      permissionLevel,
      permissionLabel: claudePermissionLabel(permissionLevel),
      permissionOptions: CLAUDE_PERMISSION_LEVELS.map((value) => ({ value, label: claudePermissionLabel(value) })),
    };
  }

  if (backend === BACKEND_OPENCODE_ACP) {
    return {
      backend,
      permissionKind: 'opencode-acp',
      permissionLevel: 'managed',
      permissionLabel: '后端控制',
      permissionOptions: [],
    };
  }

  if (backend === BACKEND_PI) {
    return {
      backend,
      permissionKind: 'pi',
      permissionLevel: 'managed',
      permissionLabel: '后端控制',
      permissionOptions: [],
    };
  }

  return {
    backend,
    permissionKind: 'unsupported',
    permissionLevel: 'unknown',
    permissionLabel: '未知',
    permissionOptions: [],
  };
}
