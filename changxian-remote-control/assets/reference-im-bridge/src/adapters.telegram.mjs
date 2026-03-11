import { Bot, InputFile } from 'grammy';
import { COMMAND_SPECS } from './commands.mjs';
import { renderTelegramPayload } from './render.telegram.mjs';

export async function startTelegramAdapter(config, controller) {
  if (!config.tgBotToken) return null;

  const status = {
    enabled: true,
    connected: false,
    authenticated: false,
    lastError: null,
    lastMessageAt: null,
    botUsername: null,
  };

  const bot = new Bot(config.tgBotToken);
  const menuCommands = COMMAND_SPECS.map((spec) => ({ command: spec.name, description: spec.menuDescription }));

  bot.catch((err) => {
    status.lastError = err?.error?.message || err?.message || String(err);
    console.error('[telegram] error', err.error || err);
  });

  bot.on('message:text', async (ctx) => {
    status.lastMessageAt = Math.floor(Date.now() / 1000);
    const text = String(ctx.message.text || '').trim();
    const sink = createTelegramSink(ctx);
    await controller.handleInput({
      host: 'telegram',
      chatId: String(ctx.chat.id),
      externalChatId: String(ctx.chat.id),
      externalUserId: ctx.from ? String(ctx.from.id) : '',
      text,
    }, sink);
  });

  const me = await bot.api.getMe();
  status.connected = true;
  status.authenticated = true;
  status.botUsername = me.username || null;
  status.lastError = null;
  await bot.api.setMyCommands(menuCommands);
  bot.start();

  return {
    name: 'telegram',
    status,
    createPushSink(binding) {
      return createTelegramPushSink(bot, binding);
    },
    async stop() {
      try {
        await bot.stop();
      } catch {
        // ignore
      }
      status.connected = false;
    },
  };
}

function createTelegramSink(ctx) {
  let message = null;
  let draftAvailable = true;
  let lastDraftHtml = '';
  const sentImages = new Set();

  async function sendDraft(html) {
    if (!draftAvailable || !html || html === lastDraftHtml) return;
    try {
      await ctx.replyWithDraft(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      lastDraftHtml = html;
    } catch (error) {
      draftAvailable = false;
      console.warn('[telegram] sendMessageDraft unavailable', error?.description || error?.message || error);
    }
  }

  async function upsertMessage(html) {
    if (!message) {
      message = await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return;
    }
    await ctx.api.editMessageText(ctx.chat.id, message.message_id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(async () => {
      message = await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });
  }

  async function sendImages(images) {
    for (const image of images) {
      if (!image?.path || sentImages.has(image.path)) continue;
      sentImages.add(image.path);
      try {
        await ctx.replyWithPhoto(new InputFile(image.path), {
          caption: image.caption || undefined,
        });
      } catch (error) {
        console.warn('[telegram] failed to send image ' + image.path, error?.description || error?.message || error);
      }
    }
  }

  return {
    async progress(payload) {
      const rendered = renderTelegramPayload(payload);
      await sendDraft(rendered.html);
      if (!draftAvailable) {
        await upsertMessage(rendered.html);
      }
    },
    async final(payload) {
      const rendered = renderTelegramPayload(payload);
      await upsertMessage(rendered.html);
      await sendImages(rendered.images);
    },
  };
}

function createTelegramPushSink(bot, binding) {
  const chatId = typeof binding === 'object'
    ? String(binding.externalChatId || binding.chatId || '')
    : String(binding || '');
  let message = null;
  const sentImages = new Set();

  async function upsertMessage(html) {
    if (!chatId) return;
    if (!message) {
      message = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return;
    }
    await bot.api.editMessageText(chatId, message.message_id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(async () => {
      message = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });
  }

  async function sendImages(images) {
    if (!chatId) return;
    for (const image of images) {
      if (!image?.path || sentImages.has(image.path)) continue;
      sentImages.add(image.path);
      try {
        await bot.api.sendPhoto(chatId, new InputFile(image.path), {
          caption: image.caption || undefined,
        });
      } catch (error) {
        console.warn('[telegram] failed to push image ' + image.path, error?.description || error?.message || error);
      }
    }
  }

  return {
    async progress(payload) {
      const rendered = renderTelegramPayload(payload);
      await upsertMessage(rendered.html);
    },
    async final(payload) {
      const rendered = renderTelegramPayload(payload);
      await upsertMessage(rendered.html);
      await sendImages(rendered.images);
    },
  };
}
