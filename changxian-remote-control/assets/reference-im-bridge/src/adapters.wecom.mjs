import crypto from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { renderWeComPayload } from './render.wecom.mjs';

function errorText(error) {
  return error?.message ? String(error.message) : String(error);
}

function targetFromBinding(binding) {
  if (!binding) return '';
  const chatType = String(binding.chattype || 'single').toLowerCase();
  if (chatType === 'group') {
    return String(binding.externalChatId || binding.chatid || '').trim();
  }
  return String(binding.externalUserId || binding.userid || binding.chatid || '').trim();
}

function createWeComPushSink(client, binding) {
  const target = targetFromBinding(binding);

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
    const finalTarget = targetFromBinding(binding);
    let finished = false;
    let sendChain = Promise.resolve();
    let lastProgressContent = '';
    let lastProgressPhase = '';
    let lastProgressAt = 0;
    let streamUnavailable = false;
    let streamUnavailableReason = '';
    let fallbackNoticeSent = false;
    let progressDelivered = false;

    const queueSend = (operation) => {
      const task = sendChain
        .catch(() => {})
        .then(operation);
      sendChain = task.then(() => undefined, () => undefined);
      return task;
    };

    const sendMarkdown = async (content) => {
      if (!finalTarget) return false;
      try {
        await client.sendMessage(finalTarget, {
          msgtype: 'markdown',
          markdown: { content },
        });
        return true;
      } catch (error) {
        const reason = errorText(error);
        status.lastError = reason;
        console.warn(`[wecom] proactive send failed chat=${binding.chatId} type=${binding.chattype} user=${binding.userid || '-'} reason=${reason}`);
        return false;
      }
    };

    const sendMarkdownPages = async (pages, startIndex = 0, endIndex = pages.length) => {
      let delivered = startIndex;
      for (let index = startIndex; index < endIndex; index += 1) {
        const ok = await sendMarkdown(pages[index]);
        if (!ok) break;
        delivered = index + 1;
      }
      return delivered;
    };

    const notifyFallbackMode = async () => {
      if (fallbackNoticeSent || finished || !finalTarget || !progressDelivered) return;
      fallbackNoticeSent = true;
      await sendMarkdown('流式进度已中断，任务仍在继续，完成后会补发最终结果。');
    };

    const sendStream = (content, finish) => {
      return queueSend(async () => {
        if (finished && !finish) return { ok: false, skipped: true };
        try {
          await client.replyStream(frame, streamId, content, finish);
          if (finish) finished = true;
          return { ok: true };
        } catch (error) {
          const reason = errorText(error);
          status.lastError = reason;
          streamUnavailable = true;
          streamUnavailableReason = reason;
          console.warn(`[wecom] stream ${finish ? 'final' : 'progress'} failed chat=${binding.chatId} type=${binding.chattype} user=${binding.userid || '-'} reason=${reason}`);
          return { ok: false, error };
        }
      });
    };

    const sink = {
      async progress(message) {
        if (finished) return;
        if (streamUnavailable) {
          await notifyFallbackMode();
          return;
        }
        const rendered = renderWeComPayload(message);
        const phase = String(message?.preview?.phase || message?.marker || '').toLowerCase();
        const now = Date.now();
        const phaseChanged = phase && phase !== lastProgressPhase;
        const timeElapsed = now - lastProgressAt;
        const minIntervalMs = 1000;
        if (!phaseChanged && rendered.content === lastProgressContent) return;
        if (!phaseChanged && lastProgressAt > 0 && timeElapsed < minIntervalMs) return;
        lastProgressContent = rendered.content;
        lastProgressPhase = phase;
        lastProgressAt = now;
        const result = await sendStream(rendered.content, false);
        if (result?.ok) {
          progressDelivered = true;
        } else {
          await notifyFallbackMode();
        }
      },
      async final(message) {
        const rendered = renderWeComPayload(message);
        const pages = rendered.pages?.length ? rendered.pages : [rendered.content];

        if (streamUnavailable && finalTarget) {
          const delivered = await sendMarkdownPages(pages);
          if (delivered === pages.length) {
            finished = true;
            console.info(`[wecom] final delivered via proactive fallback chat=${binding.chatId} pages=${pages.length} reason=${streamUnavailableReason || 'stream unavailable'}`);
          } else {
            console.warn(`[wecom] final fallback incomplete chat=${binding.chatId} delivered=${delivered}/${pages.length} reason=${streamUnavailableReason || 'stream unavailable'}`);
          }
          return;
        }

        if (pages.length <= 1 || !finalTarget) {
          const result = await sendStream(pages[0], true);
          if (result?.ok) return;
          if (!finalTarget) {
            console.warn(`[wecom] final stream failed without proactive target chat=${binding.chatId} reason=${streamUnavailableReason || 'no target'}`);
            return;
          }
          const delivered = await sendMarkdownPages(pages);
          if (delivered === pages.length) {
            finished = true;
            console.info(`[wecom] final delivered via proactive fallback chat=${binding.chatId} pages=${pages.length} reason=${streamUnavailableReason || 'stream failed'}`);
          } else {
            console.warn(`[wecom] final fallback incomplete chat=${binding.chatId} delivered=${delivered}/${pages.length} reason=${streamUnavailableReason || 'stream failed'}`);
          }
          return;
        }

        const deliveredPrefix = await sendMarkdownPages(pages, 0, pages.length - 1);
        if (deliveredPrefix < pages.length - 1) {
          const delivered = await sendMarkdownPages(pages, deliveredPrefix);
          if (delivered === pages.length) {
            finished = true;
            console.info(`[wecom] final delivered via proactive pagination chat=${binding.chatId} pages=${pages.length}`);
          } else {
            console.warn(`[wecom] final proactive pagination incomplete chat=${binding.chatId} delivered=${delivered}/${pages.length}`);
          }
          return;
        }

        const streamResult = await sendStream(pages[pages.length - 1], true);
        if (streamResult?.ok) {
          console.info(`[wecom] final delivered chat=${binding.chatId} pages=${pages.length} mode=mixed`);
          return;
        }

        const delivered = await sendMarkdownPages(pages, pages.length - 1);
        if (delivered === pages.length) {
          finished = true;
          console.info(`[wecom] final last-page fallback delivered chat=${binding.chatId} pages=${pages.length} reason=${streamUnavailableReason || 'stream final failed'}`);
        } else {
          console.warn(`[wecom] final last-page fallback incomplete chat=${binding.chatId} delivered=${delivered}/${pages.length} reason=${streamUnavailableReason || 'stream final failed'}`);
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
