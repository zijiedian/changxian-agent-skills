import crypto from 'node:crypto';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { COMMAND_SPECS } from './commands.mjs';
import { renderTelegramPayload } from './render.telegram.mjs';

const TELEGRAM_EDIT_RETRY_DELAY_MS = 800;
const TELEGRAM_PROGRESS_EDIT_INTERVAL_MS = 1000;

function telegramErrorText(error) {
  return error?.description || error?.error?.description || error?.message || error?.error?.message || String(error);
}

function retryAfterSeconds(reason) {
  const match = /retry after\s+(\d+)/i.exec(String(reason || ''));
  return match ? Number.parseInt(match[1], 10) : 0;
}

function isTransientEditError(reason) {
  return /network request .* failed|fetch failed|socket hang up|timeout|timed out|econnreset|etimedout/i.test(String(reason || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function editTelegramMessage({
  edit,
  sendFallback = null,
  logPrefix,
}) {
  let lastReason = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await edit();
      return { ok: true, mode: 'edited', reason: '' };
    } catch (error) {
      const reason = telegramErrorText(error);
      lastReason = reason;

      if (/message is not modified/i.test(reason)) {
        return { ok: true, mode: 'unchanged', reason };
      }

      if (/message to edit not found|message can't be edited/i.test(reason)) {
        if (sendFallback) {
          try {
            await sendFallback();
            return { ok: true, mode: 'resent', reason };
          } catch (fallbackError) {
            lastReason = `edit failed: ${reason}; send failed: ${telegramErrorText(fallbackError)}`;
          }
        }
        break;
      }

      const retryAfter = retryAfterSeconds(reason);
      if (retryAfter > 0) {
        if (retryAfter <= 3 && attempt === 0) {
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        if (sendFallback) {
          try {
            await sendFallback();
            return { ok: true, mode: 'resent', reason };
          } catch (fallbackError) {
            lastReason = `edit failed: ${reason}; send failed: ${telegramErrorText(fallbackError)}`;
          }
        }
        console.warn(logPrefix, lastReason);
        return { ok: false, mode: 'rate_limited', reason: lastReason, retryAfterSeconds: retryAfter };
      }

      if (isTransientEditError(reason) && attempt === 0) {
        await sleep(TELEGRAM_EDIT_RETRY_DELAY_MS);
        continue;
      }

      if (sendFallback && isTransientEditError(reason)) {
        try {
          await sendFallback();
          return { ok: true, mode: 'resent', reason };
        } catch (fallbackError) {
          lastReason = `edit failed: ${reason}; send failed: ${telegramErrorText(fallbackError)}`;
        }
      }
      break;
    }
  }

  if (lastReason) console.warn(logPrefix, lastReason);
  return { ok: false, mode: 'failed', reason: lastReason };
}

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
  const paginationSessions = new Map();
  const menuCommands = COMMAND_SPECS.map((spec) => ({ command: spec.name, description: spec.menuDescription }));
  let commandsSyncInFlight = false;

  function prunePaginationSessions() {
    const cutoff = Date.now() - (6 * 60 * 60 * 1000);
    for (const [token, session] of paginationSessions.entries()) {
      if ((session?.updatedAt || 0) < cutoff) paginationSessions.delete(token);
    }
  }

  function buildPaginationKeyboard(token, pageIndex, totalPages) {
    if (!token || totalPages <= 1) return undefined;
    const keyboard = new InlineKeyboard();
    if (pageIndex > 0) keyboard.text('◀ Prev', `rcpage:${token}:${pageIndex - 1}`);
    keyboard.text(`${pageIndex + 1}/${totalPages}`, `rcnoop:${token}:${pageIndex}`);
    if (pageIndex + 1 < totalPages) keyboard.text('Next ▶', `rcpage:${token}:${pageIndex + 1}`);
    return keyboard;
  }

  function rememberPagination(chatId, pages) {
    prunePaginationSessions();
    if (!Array.isArray(pages) || pages.length <= 1) return null;
    const token = crypto.randomBytes(6).toString('base64url');
    paginationSessions.set(token, {
      chatId: String(chatId),
      pages: pages.slice(),
      updatedAt: Date.now(),
    });
    return token;
  }

  bot.callbackQuery(/^rcpage:([^:]+):(\d+)$/, async (ctx) => {
    prunePaginationSessions();
    const token = String(ctx.match?.[1] || '');
    const requestedIndex = Number.parseInt(String(ctx.match?.[2] || '0'), 10);
    const session = paginationSessions.get(token);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '分页已失效，请重新执行任务。', show_alert: false }).catch(() => {});
      return;
    }
    if (session.chatId !== String(ctx.chat?.id || '')) {
      await ctx.answerCallbackQuery({ text: '当前消息不属于这个会话。', show_alert: false }).catch(() => {});
      return;
    }
    const index = Math.max(0, Math.min(requestedIndex, session.pages.length - 1));
    session.updatedAt = Date.now();
    const pageHtml = session.pages[index] || '<i>暂无输出</i>';
    const replyMarkup = buildPaginationKeyboard(token, index, session.pages.length);
    const result = await editTelegramMessage({
      edit: () => ctx.editMessageText(pageHtml, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: () => ctx.reply(pageHtml, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      logPrefix: '[telegram] pagination editMessageText failed',
    });
    if (!result.ok) {
      const retryAfter = result.retryAfterSeconds ? `，请 ${result.retryAfterSeconds}s 后重试` : '';
      await ctx.answerCallbackQuery({ text: `翻页失败${retryAfter}`, show_alert: false }).catch(() => {});
      return;
    }
    const callbackText = result.mode === 'resent' ? '已发送新分页消息' : '';
    await ctx.answerCallbackQuery(callbackText ? { text: callbackText, show_alert: false } : undefined).catch(() => {});
  });

  bot.callbackQuery(/^rcnoop:([^:]+):(\d+)$/, async (ctx) => {
    const token = String(ctx.match?.[1] || '');
    const index = Number.parseInt(String(ctx.match?.[2] || '0'), 10);
    const session = paginationSessions.get(token);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '分页已失效，请重新执行任务。', show_alert: false }).catch(() => {});
      return;
    }
    session.updatedAt = Date.now();
    await ctx.answerCallbackQuery({
      text: `第 ${Math.max(1, index + 1)}/${session.pages.length} 页`,
      show_alert: false,
    }).catch(() => {});
  });

  function recordError(error, prefix = '[telegram] error') {
    status.connected = false;
    status.authenticated = false;
    status.lastError = error?.error?.message || error?.message || String(error);
    console.error(prefix, error?.error || error);
  }

  bot.catch((err) => {
    recordError(err, '[telegram] middleware error');
  });

  bot.on('message:text', async (ctx) => {
    status.lastMessageAt = Math.floor(Date.now() / 1000);
    const text = String(ctx.message.text || '').trim();
    const sink = createTelegramSink(ctx, rememberPagination, buildPaginationKeyboard);
    await controller.handleInput({
      host: 'telegram',
      chatId: String(ctx.chat.id),
      externalChatId: String(ctx.chat.id),
      externalUserId: ctx.from ? String(ctx.from.id) : '',
      text,
    }, sink);
  });

  bot.start({
    onStart(me) {
      status.connected = true;
      status.authenticated = true;
      status.botUsername = me.username || null;
      status.lastError = null;
      if (!commandsSyncInFlight) {
        commandsSyncInFlight = true;
        void bot.api.setMyCommands(menuCommands)
          .catch((error) => {
            console.warn('[telegram] failed to sync menu commands', error?.description || error?.message || error);
          })
          .finally(() => {
            commandsSyncInFlight = false;
          });
      }
    },
  }).catch((error) => {
    recordError(error, '[telegram] polling stopped');
  });

  return {
    name: 'telegram',
    status,
    createPushSink(binding) {
      return createTelegramPushSink(bot, binding, rememberPagination, buildPaginationKeyboard);
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

function createTelegramSink(ctx, rememberPagination, buildPaginationKeyboard) {
  let message = null;
  const sentImages = new Set();
  let editBackoffUntilMs = 0;
  let lastProgressEditAtMs = 0;

  async function upsertMessage(html, replyMarkup = undefined, { mode = 'final' } = {}) {
    const now = Date.now();
    if (mode === 'progress') {
      if (now < editBackoffUntilMs) return;
      if (message && now - lastProgressEditAtMs < TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) return;
    }
    if (!message) {
      message = await ctx.reply(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      if (mode === 'progress') lastProgressEditAtMs = Date.now();
      return;
    }
    const result = await editTelegramMessage({
      edit: () => ctx.api.editMessageText(ctx.chat.id, message.message_id, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: mode === 'final'
        ? async () => {
          message = await ctx.reply(html, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: replyMarkup,
          });
        }
        : null,
      logPrefix: '[telegram] editMessageText failed',
    });
    if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
      editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
    }
    if (mode === 'progress' && result.ok) {
      lastProgressEditAtMs = Date.now();
    }
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
        console.warn('[telegram] failed to send image ' + image.path, telegramErrorText(error));
      }
    }
  }

  return {
    async progress(payload) {
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(String(ctx.chat.id), pages);
      await upsertMessage(
        pages[0] || rendered.html,
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        { mode: 'progress' },
      );
    },
    async final(payload) {
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(String(ctx.chat.id), pages);
      await upsertMessage(
        pages[0] || rendered.html,
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        { mode: 'final' },
      );
      await sendImages(rendered.images);
    },
  };
}

function createTelegramPushSink(bot, binding, rememberPagination, buildPaginationKeyboard) {
  const chatId = typeof binding === 'object'
    ? String(binding.externalChatId || binding.chatId || '')
    : String(binding || '');
  let message = null;
  const sentImages = new Set();
  let editBackoffUntilMs = 0;
  let lastProgressEditAtMs = 0;

  async function upsertMessage(html, replyMarkup = undefined, { mode = 'final' } = {}) {
    if (!chatId) return;
    const now = Date.now();
    if (mode === 'progress') {
      if (now < editBackoffUntilMs) return;
      if (message && now - lastProgressEditAtMs < TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) return;
    }
    if (!message) {
      message = await bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      if (mode === 'progress') lastProgressEditAtMs = Date.now();
      return;
    }
    const result = await editTelegramMessage({
      edit: () => bot.api.editMessageText(chatId, message.message_id, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: mode === 'final'
        ? async () => {
          message = await bot.api.sendMessage(chatId, html, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: replyMarkup,
          });
        }
        : null,
      logPrefix: '[telegram] push editMessageText failed',
    });
    if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
      editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
    }
    if (mode === 'progress' && result.ok) {
      lastProgressEditAtMs = Date.now();
    }
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
        console.warn('[telegram] failed to push image ' + image.path, telegramErrorText(error));
      }
    }
  }

  return {
    async progress(payload) {
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(chatId, pages);
      await upsertMessage(
        pages[0] || rendered.html,
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        { mode: 'progress' },
      );
    },
    async final(payload) {
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(chatId, pages);
      await upsertMessage(
        pages[0] || rendered.html,
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        { mode: 'final' },
      );
      await sendImages(rendered.images);
    },
  };
}
