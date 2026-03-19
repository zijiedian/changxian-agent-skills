import crypto from 'node:crypto';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { COMMAND_SPECS } from './commands.mjs';
import { renderTelegramPayload } from './render.telegram.mjs';
import {
  buildPermissionPromptText,
  createTelegramPermissionRegistry,
  permissionOptionLabel,
} from './telegram-permission-prompt.mjs';
import { createTelegramChannelPublisher } from './telegram-channel-publisher.mjs';
import { buildRuntimeControlKeyboard } from './telegram-controls.mjs';
import { buildCommandPanelKeyboard } from './telegram-command-panels.mjs';

const TELEGRAM_EDIT_RETRY_DELAY_MS = 800;
const TELEGRAM_PROGRESS_EDIT_INTERVAL_MS = 1000;
const TELEGRAM_COMMAND_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_COMMAND_SYNC_RETRY_MS = 60 * 1000;

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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPermissionPromptHtml(request) {
  return buildPermissionPromptText(request)
    .split('\n')
    .map((line) => escapeHtml(line))
    .join('<br/>');
}

function buildPermissionDecisionHtml(request, decision) {
  const base = buildPermissionPromptHtml(request);
  const summary = decision?.outcome?.outcome === 'selected'
    ? `已选择：${permissionOptionLabel(decision.option)}`
    : '已取消权限请求';
  return `${base}<br/><br/><b>${escapeHtml(summary)}</b>`;
}

function buildPermissionKeyboard(token, request) {
  const keyboard = new InlineKeyboard();
  const options = Array.isArray(request?.options) ? request.options : [];
  options.forEach((option, index) => {
    keyboard.text(permissionOptionLabel(option), `rcperm:${token}:${index}`).row();
  });
  keyboard.text('取消', `rcperm:${token}:cancel`);
  return keyboard;
}

function mergeInlineKeyboards(...keyboards) {
  const merged = new InlineKeyboard();
  for (const keyboard of keyboards) {
    const rows = Array.isArray(keyboard?.inline_keyboard) ? keyboard.inline_keyboard : [];
    for (const row of rows) {
      merged.inline_keyboard.push(row);
    }
  }
  return merged.inline_keyboard.length ? merged : undefined;
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
  const permissionRegistry = createTelegramPermissionRegistry();
  const menuCommands = COMMAND_SPECS.map((spec) => ({ command: spec.name, description: spec.menuDescription }));
  let commandsSyncInFlight = false;
  let lastCommandsSyncAtMs = 0;
  let lastCommandsSyncErrorAtMs = 0;

  async function ensureTelegramMenuCommands(force = false) {
    const now = Date.now();
    if (commandsSyncInFlight) return;
    if (!force && lastCommandsSyncAtMs && now - lastCommandsSyncAtMs < TELEGRAM_COMMAND_SYNC_TTL_MS) return;
    if (!force && lastCommandsSyncErrorAtMs && now - lastCommandsSyncErrorAtMs < TELEGRAM_COMMAND_SYNC_RETRY_MS) return;

    commandsSyncInFlight = true;
    try {
      const scopes = [
        undefined,
        { type: 'all_private_chats' },
      ];
      for (const scope of scopes) {
        const options = scope ? { scope } : undefined;
        await bot.api.deleteMyCommands(options).catch(() => {});
        await bot.api.setMyCommands(menuCommands, options);
      }
      await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {});
      lastCommandsSyncAtMs = Date.now();
      lastCommandsSyncErrorAtMs = 0;
    } catch (error) {
      lastCommandsSyncErrorAtMs = Date.now();
      console.warn('[telegram] failed to sync menu commands', error?.description || error?.message || error);
    } finally {
      commandsSyncInFlight = false;
    }
  }

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

  bot.callbackQuery(/^rcperm:([^:]+):([^:]+)$/, async (ctx) => {
    permissionRegistry.prune();
    const token = String(ctx.match?.[1] || '');
    const action = String(ctx.match?.[2] || '');
    const chatId = String(ctx.chat?.id || '');
    const result = action === 'cancel'
      ? permissionRegistry.cancel(token, chatId, 'manual-cancel')
      : permissionRegistry.resolveWithOption(token, chatId, Number.parseInt(action, 10));

    if (!result.ok) {
      const text = result.reason === 'wrong-chat'
        ? '当前消息不属于这个会话。'
        : result.reason === 'invalid-option'
          ? '按钮已失效，请重新触发权限请求。'
          : '权限请求已失效，请重新执行任务。';
      await ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});
      return;
    }

    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const text = action === 'cancel' ? '已取消' : `已选择：${permissionOptionLabel(result.option)}`;
    await ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});
  });

  bot.callbackQuery(/^rcctl:([^:]+):([^:]+)$/, async (ctx) => {
    const kind = String(ctx.match?.[1] || '');
    const value = String(ctx.match?.[2] || '');
    const chatId = String(ctx.chat?.id || '');
    let notice = '';
    let text = '';
    const request = {
      host: 'telegram',
      chatId,
      externalChatId: String(ctx.chat?.id || ''),
      externalUserId: ctx.from ? String(ctx.from.id) : '',
      text: '',
    };

    let commandPanel;
    if (kind === 'cli' && value === 'refresh') {
      await ctx.answerCallbackQuery({ text: '正在检查 CLI 版本…', show_alert: false }).catch(() => {});
      text = controller.buildCliPanelText(chatId, { checkLatest: true, force: true });
    } else if (kind === 'cli' && value === 'update') {
      await ctx.answerCallbackQuery({ text: '正在更新过期 CLI…', show_alert: false }).catch(() => {});
      text = controller.runCliUpgrade(chatId);
    } else if (kind === 'cmd') {
      text = await controller.handleQuickCommand(value, request);
      commandPanel = buildCommandPanelKeyboard(controller, chatId, value);
    } else {
      if (kind === 'backend') {
        notice = controller.applyBackendSelection(chatId, value) || '无法切换后端。';
      } else if (kind === 'perm') {
        notice = controller.applyPermissionLevel(chatId, value) || '当前后端不支持这个权限档位。';
      } else if (kind === 'session' && value === 'new') {
        controller.store.clearChatSession(chatId);
        notice = '已重置当前会话。';
      } else if (kind !== 'refresh') {
        await ctx.answerCallbackQuery({ text: '按钮已失效，请重新打开控制面板。', show_alert: false }).catch(() => {});
        return;
      }

      text = controller.buildRuntimePanelText(chatId, notice);
    }

    const rendered = renderTelegramPayload({
      status: 'Done',
      text,
    });
    const keyboard = buildRuntimeControlKeyboard(controller, chatId);
    const pages = rendered.pages || [rendered.html];
    const token = rememberPagination(chatId, pages);
    const replyMarkup = mergeInlineKeyboards(
      token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
      commandPanel,
      keyboard,
    );
    const html = pages[0] || rendered.html;
    const result = await editTelegramMessage({
      edit: () => ctx.editMessageText(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: () => ctx.reply(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      logPrefix: '[telegram] runtime control edit failed',
    });
    if (!(kind === 'cli' && (value === 'refresh' || value === 'update'))) {
      const answerText = result.ok ? (notice || '已刷新') : '刷新失败，请稍后重试';
      await ctx.answerCallbackQuery({ text: answerText, show_alert: false }).catch(() => {});
    }
  });

  bot.callbackQuery(/^rcctl:(schedule|role|channel|memory):([^:]+):(.+)$/, async (ctx) => {
    const kind = String(ctx.match?.[1] || '');
    const action = String(ctx.match?.[2] || '');
    const target = String(ctx.match?.[3] || '');
    const chatId = String(ctx.chat?.id || '');
    const request = {
      host: 'telegram',
      chatId,
      externalChatId: String(ctx.chat?.id || ''),
      externalUserId: ctx.from ? String(ctx.from.id) : '',
      text: '',
    };

    let text = '';
    if (kind === 'schedule') {
      if (action === 'run') text = await controller.handleScheduleCommand(chatId, `run ${target}`);
      else if (action === 'show') text = await controller.handleScheduleCommand(chatId, `show ${target}`);
      else if (action === 'toggle') {
        const job = controller.store.getJob(chatId, target);
        text = job
          ? await controller.handleScheduleCommand(chatId, `${job.enabled ? 'pause' : 'resume'} ${target}`)
          : 'Scheduled job not found';
      }
    } else if (kind === 'role') {
      if (action === 'use') text = await controller.handleRoleCommand(chatId, `use ${target}`);
      else if (action === 'show') text = await controller.handleRoleCommand(chatId, `show ${target}`);
      else if (action === 'clear') text = await controller.handleRoleCommand(chatId, 'clear');
    } else if (kind === 'channel') {
      if (action === 'test') text = await controller.handleChannelCommand(request, `test ${target}`);
    } else if (kind === 'memory') {
      if (action === 'show' || action === 'pin' || action === 'delete') {
        text = controller.handleMemoryPanelAction(chatId, action, target);
      }
    }

    if (!text) {
      await ctx.answerCallbackQuery({ text: '按钮已失效，请重新打开命令面板。', show_alert: false }).catch(() => {});
      return;
    }

    const rendered = renderTelegramPayload({ status: 'Done', text });
    const pages = rendered.pages || [rendered.html];
    const token = rememberPagination(chatId, pages);
    const commandPanel = buildCommandPanelKeyboard(controller, chatId, kind);
    const keyboard = buildRuntimeControlKeyboard(controller, chatId);
    const replyMarkup = mergeInlineKeyboards(
      token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
      commandPanel,
      keyboard,
    );
    const html = pages[0] || rendered.html;

    const result = await editTelegramMessage({
      edit: () => ctx.editMessageText(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: () => ctx.reply(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      logPrefix: '[telegram] command panel edit failed',
    });

    const answerText = result.ok ? '已执行' : '执行失败，请稍后重试';
    await ctx.answerCallbackQuery({ text: answerText, show_alert: false }).catch(() => {});
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
    permissionRegistry.prune();
    status.lastMessageAt = Math.floor(Date.now() / 1000);
    void ensureTelegramMenuCommands();
    const text = String(ctx.message.text || '').trim();
    const sink = createTelegramSink(ctx, rememberPagination, buildPaginationKeyboard, permissionRegistry, controller);
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
      void ensureTelegramMenuCommands(true);
    },
  }).catch((error) => {
    recordError(error, '[telegram] polling stopped');
  });

  controller.attachTelegramChannelPublisher(createTelegramChannelPublisher({
    bot,
    config,
  }));

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

function createTelegramSink(ctx, rememberPagination, buildPaginationKeyboard, permissionRegistry, controller) {
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
    async final(payload, options = {}) {
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(String(ctx.chat.id), pages);
      const controls = options?.telegramControls ? buildRuntimeControlKeyboard(controller, String(options.telegramControls.chatId || ctx.chat.id)) : undefined;
      const replyMarkup = mergeInlineKeyboards(
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        controls,
      );
      await upsertMessage(
        pages[0] || rendered.html,
        replyMarkup,
        { mode: 'final' },
      );
      await sendImages(rendered.images);
    },
    async requestPermission(request, { signal } = {}) {
      const pending = permissionRegistry.create(String(ctx.chat.id), request);
      const keyboard = buildPermissionKeyboard(pending.token, request);
      const html = buildPermissionPromptHtml(request);
      const abortHandler = () => {
        permissionRegistry.cancel(pending.token, String(ctx.chat.id), 'aborted');
      };

      signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        await upsertMessage(html, keyboard, { mode: 'final' });
        const decision = await pending.promise;
        await upsertMessage(buildPermissionDecisionHtml(request, decision), undefined, { mode: 'final' });
        return { outcome: decision.outcome };
      } catch (error) {
        permissionRegistry.cancel(pending.token, String(ctx.chat.id), 'prompt-error');
        throw error;
      } finally {
        signal?.removeEventListener('abort', abortHandler);
      }
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
