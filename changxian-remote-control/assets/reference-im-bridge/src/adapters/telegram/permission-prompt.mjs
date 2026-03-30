import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function permissionOptionLabel(option = {}) {
  const kind = String(option.kind || '').trim();
  if (kind === 'allow_once') return '允许一次';
  if (kind === 'allow_always') return '总是允许';
  if (kind === 'reject_once') return '拒绝';
  if (kind === 'reject_always') return '总是拒绝';
  return String(option.name || '确认').trim() || '确认';
}

export function buildPermissionPromptText(request = {}) {
  const toolCall = request.toolCall || {};
  const title = String(toolCall.title || '工具调用').trim();
  const description = String(toolCall.rawInput?.description || toolCall.rawInput?.command || '').trim();
  const lines = ['需要权限确认', `工具: ${title}`];
  if (description) lines.push(`说明: ${description}`);
  lines.push('请选择如何处理这个操作。');
  return lines.join('\n');
}

export function createTelegramPermissionRegistry({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const sessions = new Map();
  const effectiveTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;

  function finalize(token, payload) {
    const entry = sessions.get(String(token || ''));
    if (!entry) return false;
    sessions.delete(String(token));
    clearTimeout(entry.timer);
    entry.resolve(payload);
    return true;
  }

  function prune() {
    const cutoff = Date.now() - effectiveTtlMs;
    for (const [token, entry] of sessions.entries()) {
      if ((entry?.updatedAt || 0) < cutoff) {
        finalize(token, { outcome: { outcome: 'cancelled' }, reason: 'expired' });
      }
    }
  }

  function create(chatId, request) {
    prune();
    const token = crypto.randomBytes(6).toString('base64url');
    const wait = deferred();
    const timer = setTimeout(() => {
      finalize(token, { outcome: { outcome: 'cancelled' }, reason: 'expired' });
    }, effectiveTtlMs);
    sessions.set(token, {
      chatId: String(chatId),
      request,
      updatedAt: Date.now(),
      resolve: wait.resolve,
      timer,
    });
    return {
      token,
      promise: wait.promise,
    };
  }

  function get(token) {
    prune();
    return sessions.get(String(token || '')) || null;
  }

  function resolveWithOption(token, chatId, optionIndex) {
    const entry = get(token);
    if (!entry) return { ok: false, reason: 'expired' };
    if (entry.chatId !== String(chatId)) return { ok: false, reason: 'wrong-chat' };
    const options = Array.isArray(entry.request?.options) ? entry.request.options : [];
    const option = options[Number(optionIndex)];
    if (!option) return { ok: false, reason: 'invalid-option' };
    finalize(token, {
      outcome: {
        outcome: 'selected',
        optionId: option.optionId,
      },
      option,
      reason: 'selected',
    });
    return { ok: true, option };
  }

  function cancel(token, chatId, reason = 'cancelled') {
    const entry = get(token);
    if (!entry) return { ok: false, reason: 'expired' };
    if (entry.chatId !== String(chatId)) return { ok: false, reason: 'wrong-chat' };
    finalize(token, {
      outcome: { outcome: 'cancelled' },
      reason,
    });
    return { ok: true };
  }

  function cancelAllForChat(chatId, reason = 'cancelled') {
    const target = String(chatId);
    for (const [token, entry] of sessions.entries()) {
      if (entry.chatId !== target) continue;
      finalize(token, {
        outcome: { outcome: 'cancelled' },
        reason,
      });
    }
  }

  return {
    create,
    get,
    prune,
    resolveWithOption,
    cancel,
    cancelAllForChat,
  };
}
