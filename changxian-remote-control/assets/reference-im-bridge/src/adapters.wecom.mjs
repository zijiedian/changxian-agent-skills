import crypto from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { renderWeComPayload } from './render.wecom.mjs';

function errorText(error) {
  return error?.message ? String(error.message) : String(error);
}

function createWeComPushSink(client, binding) {
  const target = String(
    binding?.externalChatId
      || binding?.chatid
      || binding?.externalUserId
      || binding?.userid
      || ''
  ).trim();

  return {
    async progress() {
      // WeCom proactive pushes do not support in-place stream updates like replyStream.
    },
    async final(message) {
      if (!target) return;
      const rendered = renderWeComPayload(message);
      for (const content of rendered.pages || [rendered.content]) {
        await client.sendMessage(target, {
          msgtype: 'markdown',
          markdown: { content },
        }).catch((error) => {
          console.warn('[wecom] failed to push proactive message', errorText(error));
        });
      }
    },
  };
}

export async function startWeComAdapter(config, controller) {
  if (!config.wecomBotId || !config.wecomBotSecret) return null;

  const status = {
    enabled: true,
    connected: false,
    authenticated: false,
    lastError: null,
    lastMessageAt: null,
    trackedChats: 0,
  };

  const bindings = new Map();
  const client = new WSClient({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    wsUrl: config.wecomWsUrl,
    maxReconnectAttempts: -1,
    reconnectInterval: 1000,
    heartbeatInterval: 30000,
  });

  function stableChatId(frame) {
    const body = frame?.body || {};
    const from = body.from || {};
    const key = `wecom:${body.aibotid || config.wecomBotId}:${body.chattype || 'single'}:${body.chattype === 'group' && body.chatid ? body.chatid : from.userid || ''}`;
    const digest = crypto.createHash('blake2b512').update(key).digest();
    let value = 0n;
    for (const byte of digest.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
    return String(value & ((1n << 63n) - 1n));
  }

  function bindingFromFrame(frame) {
    const body = frame?.body || {};
    const from = body.from || {};
    const binding = {
      chatId: stableChatId(frame),
      aibotid: String(body.aibotid || config.wecomBotId),
      chattype: String(body.chattype || 'single'),
      chatid: String(body.chatid || ''),
      userid: String(from.userid || ''),
    };
    bindings.set(binding.chatId, binding);
    status.trackedChats = bindings.size;
    return binding;
  }

  client.on('connected', () => {
    status.connected = true;
  });
  client.on('authenticated', () => {
    status.connected = true;
    status.authenticated = true;
    status.lastError = null;
  });
  client.on('disconnected', (reason) => {
    status.connected = false;
    status.authenticated = false;
    if (reason) status.lastError = String(reason);
  });
  client.on('error', (error) => {
    status.connected = false;
    status.authenticated = false;
    status.lastError = errorText(error);
  });

  async function sendUnsupported(frame, message) {
    try {
      await client.replyStream(frame, generateReqId('stream'), message, true);
    } catch {
      // ignore
    }
  }

  client.on('event.enter_chat', async (frame) => {
    bindingFromFrame(frame);
    const welcome = process.env.WECOM_WELCOME_TEXT?.trim();
    if (!welcome) return;
    try {
      await client.replyWelcome(frame, { msgtype: 'text', text: { content: welcome } });
    } catch (error) {
      status.lastError = errorText(error);
    }
  });

  for (const eventName of ['message.image', 'message.mixed', 'message.voice', 'message.file']) {
    client.on(eventName, async (frame) => {
      status.lastMessageAt = Math.floor(Date.now() / 1000);
      await sendUnsupported(frame, '当前仅支持文本消息，请发送文本任务。');
    });
  }

  client.on('message.text', async (frame) => {
    status.lastMessageAt = Math.floor(Date.now() / 1000);
    const binding = bindingFromFrame(frame);
    let text = String(frame?.body?.text?.content || '').trim();
    if (String(frame?.body?.chattype || '').toLowerCase() === 'group') {
      text = text.replace(/^\s*@\S+\s*/, '').trim();
    }
    console.info(`[wecom] message chat=${binding.chatId} type=${binding.chattype} user=${binding.userid || '-'} text=${text.slice(0, 120)}`);

    const streamId = generateReqId('stream');
    let finished = false;
    let sendChain = Promise.resolve();

    const sendStream = (content, finish) => {
      sendChain = sendChain
        .catch(() => {})
        .then(async () => {
          if (finished && !finish) return;
          await client.replyStream(frame, streamId, content, finish).catch((error) => {
            status.lastError = errorText(error);
            throw error;
          });
          if (finish) finished = true;
        });
      return sendChain.catch(() => {});
    };

    const sink = {
      async progress(message) {
        if (finished) return;
        const rendered = renderWeComPayload(message);
        await sendStream(rendered.content, false);
      },
      async final(message) {
        const rendered = renderWeComPayload(message);
        const pages = rendered.pages || [rendered.content];
        for (let index = 0; index < pages.length; index += 1) {
          await sendStream(pages[index], index === pages.length - 1);
        }
      },
    };

    await controller.handleInput({
      host: 'wecom',
      chatId: binding.chatId,
      externalChatId: binding.chatid,
      externalUserId: binding.userid,
      text,
    }, sink);
  });

  client.connect();

  return {
    name: 'wecom',
    status,
    createPushSink(binding) {
      return createWeComPushSink(client, binding);
    },
    async stop() {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      status.connected = false;
      status.authenticated = false;
    },
  };
}
