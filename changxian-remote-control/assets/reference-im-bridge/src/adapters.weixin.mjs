import crypto from 'node:crypto';

function errorText(error) {
  return error?.message ? String(error.message) : String(error);
}

function stableChatId(conversationId = '') {
  const digest = crypto.createHash('blake2b512').update(`weixin:${String(conversationId || '').trim()}`).digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  return String(value & ((1n << 63n) - 1n));
}

function finalTextFromPayload(message) {
  if (typeof message === 'string') return message.trim();
  if (message && typeof message === 'object') {
    const text = String(message.text || message.preview?.content || message.preview?.summary || '').trim();
    if (text) return text;
  }
  return '';
}

export async function startWeixinAdapter(config, controller, sdkOverride = null) {
  if (!config.weixinEnabled) return null;

  const sdk = sdkOverride || await import('weixin-agent-sdk');
  if (typeof sdk?.start !== 'function') {
    throw new Error('weixin-agent-sdk missing start()');
  }

  const status = {
    enabled: true,
    connected: true,
    authenticated: true,
    lastError: null,
    lastMessageAt: null,
    trackedChats: 0,
  };
  const bindings = new Map();
  const abortController = new AbortController();

  const agent = {
    async chat(request) {
      status.lastMessageAt = Math.floor(Date.now() / 1000);
      const conversationId = String(request?.conversationId || '').trim();
      const chatId = stableChatId(conversationId);
      bindings.set(chatId, { chatId, conversationId });
      status.trackedChats = bindings.size;

      let finalResponse = '';
      await controller.handleInput({
        host: 'weixin',
        chatId,
        externalChatId: conversationId,
        externalUserId: conversationId,
        text: String(request?.text || '').trim(),
        files: request?.media?.filePath
          ? [{
              path: request.media.filePath,
              filePath: request.media.filePath,
              type: request.media.mimeType,
              name: request.media.fileName || '',
            }]
          : [],
      }, {
        async progress() {},
        async final(message) {
          finalResponse = finalTextFromPayload(message);
        },
      });

      return { text: finalResponse || '已处理完成。' };
    },
  };

  const runner = sdk.start(agent, {
    accountId: config.weixinAccountId || undefined,
    abortSignal: abortController.signal,
    log: (message) => {
      if (message) console.info(`[weixin] ${String(message)}`);
    },
  }).catch((error) => {
    status.connected = false;
    status.authenticated = false;
    status.lastError = errorText(error);
    console.error('[weixin] adapter stopped', error);
  });

  return {
    name: 'weixin',
    status,
    async stop() {
      abortController.abort();
      await runner.catch(() => {});
      status.connected = false;
      status.authenticated = false;
    },
  };
}
