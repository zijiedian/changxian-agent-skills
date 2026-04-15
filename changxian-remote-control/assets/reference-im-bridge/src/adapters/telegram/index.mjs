import crypto from 'node:crypto';
import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { COMMAND_SPECS } from '../../commands/specs.mjs';
import {
  buildPermissionPromptText,
  createTelegramPermissionRegistry,
  permissionOptionLabel,
} from './permission-prompt.mjs';
import { createTelegramChannelPublisher } from './channel-publisher.mjs';
import { buildRuntimeControlKeyboard } from './controls.mjs';
import { buildCommandPanelKeyboard } from './command-panels.mjs';
import {
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  previewHasProgressDetails,
  truncateText,
  coerceTelegramHtml,
  renderTelegramPayload,
} from '../../render/index.mjs';

const TELEGRAM_EDIT_RETRY_DELAY_MS = 800;
const TELEGRAM_PROGRESS_EDIT_INTERVAL_MS = 2000;
const TELEGRAM_STANDALONE_FINAL_MIN_ELAPSED_SECONDS = 8;
const TELEGRAM_STANDALONE_FINAL_MIN_PROGRESS_UPDATES = 3;
const TELEGRAM_COMMAND_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_COMMAND_SYNC_RETRY_MS = 60 * 1000;
const TELEGRAM_MAX_DRAFT_ID = 2147483646;
const TELEGRAM_DRAFT_ASSISTANT_FLUSH_CHARS = 48;
const TELEGRAM_DRAFT_CLEAR_TEXT = '\u2060';

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

function draftDebugEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.TG_DRAFT_DEBUG || '').trim().toLowerCase());
}

function draftDebug(event, details = {}) {
  if (!draftDebugEnabled()) return;
  try {
    console.info(`[telegram:draft] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.info(`[telegram:draft] ${event}`);
  }
}

function canUseDraftStreaming(chatId) {
  const value = String(chatId || '').trim();
  if (!value || value.startsWith('@')) return false;
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric !== 0;
}

function randomDraftId() {
  return crypto.randomInt(1, TELEGRAM_MAX_DRAFT_ID);
}

function threadIdFromContext(ctx) {
  const candidate = ctx?.message?.message_thread_id ?? ctx?.msg?.message_thread_id ?? ctx?.callbackQuery?.message?.message_thread_id;
  const value = Number(candidate);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveTelegramChatId(ctx) {
  const candidate = ctx?.chat?.id
    ?? ctx?.callbackQuery?.message?.chat?.id
    ?? ctx?.msg?.chat?.id
    ?? ctx?.update?.callback_query?.message?.chat?.id;
  if (candidate == null) return '';
  return String(candidate);
}

function mergeDraftHtml(previous, next) {
  const left = String(previous || '').trim();
  const right = String(next || '').trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (right.includes(left)) return right;
  if (left.includes(right)) return left;

  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  if (leftLines[0] && leftLines[0] === rightLines[0]) {
    const suffix = rightLines.slice(1).join('\n').trim();
    if (!suffix) return left;
    if (left.includes(suffix)) return left;
    return `${left}\n${suffix}`.trim();
  }

  return `${left}\n\n${right}`.trim();
}

function appendAssistantDraftText(previous, chunk) {
  const left = String(previous || '');
  const right = String(chunk || '');
  if (!left) return right;
  if (!right) return left;
  return `${left}${right}`;
}

function buildDraftDisplayText({ intent = '', progress = '', assistant = '', placeholder = '' } = {}) {
  const plan = String(intent || '').trim();
  const progressBody = String(progress || '').trim();
  const assistantBody = String(assistant || '').trim();
  const placeholderBody = String(placeholder || '').trim();

  if (assistantBody) {
    if (plan) return `计划：${plan}\n\n${assistantBody}`.trim();
    return assistantBody;
  }
  if (progressBody) {
    if (plan && !progressBody.includes(plan)) return `计划：${plan}\n\n${progressBody}`.trim();
    return progressBody;
  }
  if (plan) return `计划：${plan}`;
  return placeholderBody;
}

function draftTextFromMarkdown(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{3,}[\w-]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\|\|([^|]+)\|\|/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    .join('\n');
}

function buildPermissionDecisionHtml(request, decision) {
  const base = buildPermissionPromptHtml(request);
  const summary = decision?.outcome?.outcome === 'selected'
    ? `已选择：${permissionOptionLabel(decision.option)}`
    : '已取消权限请求';
  return `${base}\n\n<b>${escapeHtml(summary)}</b>`;
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
  const mergedRows = [];
  for (const keyboard of keyboards) {
    const rows = Array.isArray(keyboard?.inline_keyboard) ? keyboard.inline_keyboard : [];
    for (const row of rows) {
      if (Array.isArray(row) && row.length) mergedRows.push(row);
    }
  }
  if (!mergedRows.length) return undefined;
  const merged = new InlineKeyboard();
  merged.inline_keyboard = mergedRows;
  return merged;
}

export function shouldSendStandaloneFinalTelegramMessage({
  hasProgressMessage = false,
  pageCount = 1,
  hasImages = false,
  hasReplyMarkup = false,
  elapsedSeconds = 0,
  progressUpdateCount = 0,
} = {}) {
  if (!hasProgressMessage) return false;
  if (Number(pageCount) > 1) return true;
  if (hasImages) return true;
  if (hasReplyMarkup) return true;
  if (Number(elapsedSeconds) >= TELEGRAM_STANDALONE_FINAL_MIN_ELAPSED_SECONDS) return true;
  if (Number(progressUpdateCount) >= TELEGRAM_STANDALONE_FINAL_MIN_PROGRESS_UPDATES) return true;
  return false;
}

function progressHeading(preview) {
  if (preview?.phase === 'thinking') return '正在推理';
  if (preview?.phase === 'diff') return '正在整理变更';
  if (preview?.phase === 'research') return '正在检索资料';
  return '';
}

function normalizeToolLifecycleSummary(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = /^(.*?)\s+·\s+(pending|in_progress|completed|failed)(?:\s+(.*))?$/i.exec(value);
  if (!match) return value;

  const title = String(match[1] || '').trim();
  const status = String(match[2] || '').trim().toLowerCase();
  let detail = String(match[3] || '').trim();
  if (detail.toLowerCase() === title.toLowerCase()) detail = '';
  if (detail.toLowerCase().startsWith(`${title.toLowerCase()} `)) {
    detail = detail.slice(title.length).trim();
  }

  const genericTool = /^(?:tool|工具)$/i.test(title);
  if (genericTool) {
    if (status === 'pending') return detail ? `工具准备中 · ${detail}` : '工具准备中';
    if (status === 'in_progress') return detail ? `工具执行中 · ${detail}` : '工具执行中';
    if (status === 'completed') return detail ? `工具执行完成 · ${detail}` : '工具执行完成';
    if (status === 'failed') return detail ? `工具执行失败 · ${detail}` : '工具执行失败';
    return value;
  }

  if (status === 'pending') return detail ? `准备执行: ${title} · ${detail}` : `准备执行: ${title}`;
  if (status === 'in_progress') return detail ? `执行中: ${title} · ${detail}` : `执行中: ${title}`;
  if (status === 'completed') return detail ? `执行完成: ${title} · ${detail}` : `执行完成: ${title}`;
  if (status === 'failed') return detail ? `执行失败: ${title} · ${detail}` : `执行失败: ${title}`;
  return value;
}

function localizeTelegramProgressText(text) {
  return normalizeToolLifecycleSummary(text);
}

function localizeExecDraftText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed === 'Running' || trimmed === 'in_progress') return '执行中';
      if (trimmed === 'Done' || trimmed === 'completed') return '已完成';
      if (trimmed === 'Failed' || trimmed === 'failed') return '失败';
      if (trimmed === 'pending') return '准备中';
      return localizeTelegramProgressText(trimmed);
    })
    .filter(Boolean);
  return lines.join('\n').trim();
}

function shouldUseExecPreviewContent(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (value.includes('\n')) return true;
  if (/^\s*```/.test(value)) return true;
  if (/^\s*[\[{]/.test(value)) return true;
  if (/ · (?:pending|in_progress|completed|failed)\b/i.test(value)) return true;
  return false;
}

function truncateExecDraftText(text, limit = 1600) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function buildExecDraftText(entry, payload) {
  const previewContent = String(payload?.preview?.content || '').trim();
  const fallbackContent = draftLineFromEntry(entry, payload) || String(payload?.text || entry?.summary || '').trim();
  const content = shouldUseExecPreviewContent(previewContent) ? previewContent : fallbackContent;
  const localized = localizeExecDraftText(content || '执行中');
  return truncateExecDraftText(localized || '执行中', 1600);
}

function fallbackProgressSummary(preview, previewText, marker = '') {
  const summary = localizeTelegramProgressText(String(preview?.summary || '').trim());
  if (summary) return summary;

  const commandPreviewLines = Array.isArray(preview?.commandPreviewLines) ? preview.commandPreviewLines : [];
  const commandPreview = String(preview?.commandPreview || commandPreviewLines[commandPreviewLines.length - 1] || '').trim();
  if (commandPreview) return truncateText(commandPreview, 120);

  const inlineText = truncateText(localizeTelegramProgressText(String(previewText || '').trim()), 120);
  if (inlineText) return inlineText;

  if (preview?.phase === 'thinking') return '思考中';
  if (preview?.phase === 'diff') return '整理变更中';
  if (preview?.phase === 'research') return '检索资料中';
  if (String(marker || '').trim().toLowerCase() === 'exec') return '执行中';
  return '请稍候';
}

function buildLatestProgressMarkdown(preview, previewText, marker = '') {
  const heading = progressHeading(preview);
  const summary = fallbackProgressSummary(preview, previewText, marker);
  const markdown = buildPreviewSummaryMarkdown({
    ...preview,
    summary: localizeTelegramProgressText(preview?.summary || ''),
  }, {
    heading,
    maxHighlights: 1,
    maxChecks: 0,
    maxFiles: 0,
    maxNotes: 0,
    includeDiffHint: false,
    showOverflowCounts: false,
  }).trim();
  if (markdown) return markdown;

  if (heading && summary && summary !== heading) {
    return `**${heading}**\n\n${summary}`.trim();
  }
  return heading ? `**${heading}**` : summary;
}


function draftLineFromEntry(entry, payload) {
  const summary = localizeTelegramProgressText(String(entry?.summary || payload?.text || '').trim());
  const checks = Array.isArray(payload?.preview?.checks) ? payload.preview.checks : Array.isArray(entry?.preview?.checks) ? entry.preview.checks : [];
  const firstCheck = String(checks[0] || '').trim();
  if (summary && firstCheck && !summary.includes(firstCheck)) return `${summary} · ${firstCheck}`;
  if (summary) return summary;
  if (firstCheck) return firstCheck;
  return '';
}

function renderedHtmlFromProgressPayload(payload) {
  const body = String(payload?.rendered?.body || '').trim();
  if (!body) return '';
  return String(payload?.rendered?.format || '').trim().toLowerCase() === 'html'
    ? body
    : coerceTelegramHtml(body);
}

function buildTelegramProgressEntry(payload) {
  const marker = String(payload?.marker || 'thinking').trim().toLowerCase();
  const preview = payload?.preview && typeof payload.preview === 'object' && !Array.isArray(payload.preview)
    ? payload.preview
    : buildStructuredPreview(String(payload?.text || ''), { status: 'Running', marker });
  const previewText = String(payload?.text || preview.summary || preview.content || '').trim();
  const previewLower = previewText.toLowerCase();
  const renderedHtml = renderedHtmlFromProgressPayload(payload);
  const renderedSummary = renderedHtml ? draftTextFromMarkdown(renderedHtml) : '';
  const isPlaceholder = marker === 'thinking'
    && (!previewHasProgressDetails(preview))
    && (!previewText || previewLower === 'thinking...' || previewLower === 'thinking');

  if (isPlaceholder) {
    return {
      kind: 'placeholder',
      html: renderedHtml || renderTelegramPayload({
        status: 'Running',
        marker,
        text: previewText || 'thinking...',
        preview,
        elapsedSeconds: Number(payload?.elapsedSeconds) || 0,
      }).html,
      marker,
      phase: String(preview?.phase || marker).trim().toLowerCase(),
      summary: renderedSummary || 'thinking...',
      markdown: renderedSummary,
    };
  }

  if (renderedHtml) {
    return {
      kind: 'entry',
      html: renderedHtml,
      marker,
      phase: String(preview?.phase || marker).trim().toLowerCase(),
      summary: renderedSummary || fallbackProgressSummary(preview, previewText, marker),
      markdown: renderedSummary,
    };
  }

  const markdown = buildLatestProgressMarkdown(preview, previewText, marker);

  return {
    kind: 'entry',
    html: coerceTelegramHtml(markdown || '请稍候'),
    marker,
    phase: String(preview?.phase || marker).trim().toLowerCase(),
    summary: fallbackProgressSummary(preview, previewText, marker),
    markdown,
  };
}

async function deleteTelegramMessage({ remove, logPrefix }) {
  try {
    await remove();
    return { ok: true };
  } catch (error) {
    const reason = telegramErrorText(error);
    if (/message to delete not found|message can't be deleted/i.test(reason)) {
      return { ok: true, skipped: true };
    }
    console.warn(logPrefix, reason);
    return { ok: false, reason };
  }
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

async function sendTelegramDraft({
  send,
  meta = {},
  fallback = null,
  logPrefix,
}) {
  let lastReason = '';
  draftDebug('attempt', meta);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await send();
      draftDebug('success', { ...meta, attempt: attempt + 1 });
      return { ok: true, mode: 'draft', reason: '' };
    } catch (error) {
      const reason = telegramErrorText(error);
      lastReason = reason;
      draftDebug('error', { ...meta, attempt: attempt + 1, reason });

      const retryAfter = retryAfterSeconds(reason);
      if (retryAfter > 0 && attempt === 0 && retryAfter <= 3) {
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (retryAfter > 0) {
        if (lastReason) console.warn(logPrefix, lastReason);
        draftDebug('rate-limited', { ...meta, reason: lastReason, retryAfterSeconds: retryAfter });
        return { ok: false, mode: 'rate_limited', reason: lastReason, retryAfterSeconds: retryAfter };
      }

      if (isTransientEditError(reason) && attempt === 0) {
        await sleep(TELEGRAM_EDIT_RETRY_DELAY_MS);
        continue;
      }

      if (fallback) {
        try {
          await fallback();
          draftDebug('fallback-success', { ...meta, attempt: attempt + 1 });
          return { ok: true, mode: 'fallback', reason };
        } catch (fallbackError) {
          lastReason = `draft failed: ${reason}; fallback failed: ${telegramErrorText(fallbackError)}`;
          draftDebug('fallback-error', { ...meta, attempt: attempt + 1, reason: lastReason });
        }
      }
      break;
    }
  }

  if (lastReason) console.warn(logPrefix, lastReason);
  draftDebug('failed', { ...meta, reason: lastReason });
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

  function rememberPagination(chatId, pages, options = {}) {
    prunePaginationSessions();
    if (!Array.isArray(pages) || pages.length <= 1) return null;
    const token = crypto.randomBytes(6).toString('base64url');
    paginationSessions.set(token, {
      chatId: String(chatId),
      pages: pages.slice(),
      commandPanelAction: String(options.commandPanelAction || '').trim().toLowerCase(),
      commandPanelPage: Math.max(0, Number(options.commandPanelPage) || 0),
      includeRuntimeControls: options.includeRuntimeControls === true,
      controlsChatId: String(options.controlsChatId || chatId),
      updatedAt: Date.now(),
    });
    return token;
  }

  function buildStoredReplyMarkup(token, pageIndex, session, controller) {
    const commandPanel = session?.commandPanelAction
      ? buildCommandPanelKeyboard(
        controller,
        String(session.controlsChatId || session.chatId || ''),
        session.commandPanelAction,
        { page: Math.max(0, Number(session.commandPanelPage) || 0) },
      )
      : undefined;
    const controls = session?.includeRuntimeControls
      ? buildRuntimeControlKeyboard(controller, String(session.controlsChatId || session.chatId || ''))
      : undefined;
    return mergeInlineKeyboards(
      buildPaginationKeyboard(token, pageIndex, session.pages.length),
      commandPanel,
      controls,
    );
  }

  bot.on('callback_query:data', async (ctx, next) => {
    const data = String(ctx.callbackQuery?.data || '');
    if (data.startsWith('rcperm:')) {
      console.info(`[telegram] permission callback chat=${resolveTelegramChatId(ctx) || 'unknown'} data=${data}`);
    }
    await next();
  });

  bot.callbackQuery(/^rcpage:([^:]+):(\d+)$/, async (ctx) => {
    prunePaginationSessions();
    const token = String(ctx.match?.[1] || '');
    const requestedIndex = Number.parseInt(String(ctx.match?.[2] || '0'), 10);
    const session = paginationSessions.get(token);
    const chatId = resolveTelegramChatId(ctx);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '分页已失效，请重新执行任务。', show_alert: false }).catch(() => {});
      return;
    }
    if (session.chatId !== chatId) {
      await ctx.answerCallbackQuery({ text: '当前消息不属于这个会话。', show_alert: false }).catch(() => {});
      return;
    }
    const index = Math.max(0, Math.min(requestedIndex, session.pages.length - 1));
    session.updatedAt = Date.now();
    const pageHtml = session.pages[index] || '<i>暂无输出</i>';
    const replyMarkup = buildStoredReplyMarkup(token, index, session, controller);
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

  bot.callbackQuery(/^rcnoop:(skill|mcp):(\d+)$/, async (ctx) => {
    const kind = String(ctx.match?.[1] || '');
    const index = Number.parseInt(String(ctx.match?.[2] || '0'), 10);
    await ctx.answerCallbackQuery({
      text: `${kind.toUpperCase()} 第 ${Math.max(1, index + 1)} 页`,
      show_alert: false,
    }).catch(() => {});
  });

  bot.callbackQuery(/^rcperm:([^:]+):([^:]+)$/, async (ctx) => {
    permissionRegistry.prune();
    const token = String(ctx.match?.[1] || '');
    const action = String(ctx.match?.[2] || '');
    const chatId = resolveTelegramChatId(ctx);
    const entry = permissionRegistry.get(token);
    const result = action === 'cancel'
      ? permissionRegistry.cancel(token, chatId, 'manual-cancel')
      : permissionRegistry.resolveWithOption(token, chatId, Number.parseInt(action, 10));

    if (!result.ok) {
      const text = result.reason === 'wrong-chat'
        ? '当前消息不属于这个会话。'
        : result.reason === 'invalid-option'
          ? '按钮已失效，请重新触发权限请求。'
          : '权限请求已失效，请重新执行任务。';
      console.warn(`[telegram] permission decision rejected chat=${chatId || 'unknown'} token=${token} action=${action} reason=${result.reason}`);
      await ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});
      return;
    }

    const text = action === 'cancel' ? '已取消' : `已选择：${permissionOptionLabel(result.option)}`;
    console.info(`[telegram] permission decision chat=${chatId} action=${action} text=${text}`);
    await ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});
    if (entry?.request) {
      const html = buildPermissionDecisionHtml(entry.request, action === 'cancel'
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected' }, option: result.option });
      await ctx.editMessageText(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: undefined,
      }).catch(async () => {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      });
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
  });

  bot.callbackQuery(/^rcctl:([^:]+):([^:]+)$/, async (ctx) => {
    const kind = String(ctx.match?.[1] || '');
    const value = String(ctx.match?.[2] || '');
    const chatId = resolveTelegramChatId(ctx);
    let notice = '';
    let text = '';
    const request = {
      host: 'telegram',
      chatId,
      externalChatId: chatId,
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
      commandPanel = buildCommandPanelKeyboard(controller, chatId, value, { page: 0 });
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
    const token = rememberPagination(chatId, pages, {
      commandPanelAction: kind === 'cmd' ? value : '',
      commandPanelPage: 0,
      includeRuntimeControls: true,
      controlsChatId: chatId,
    });
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

  bot.callbackQuery(/^rcctl:(schedule|role|channel|memory|skill|mcp):([^:]+):(.+)$/, async (ctx) => {
    const kind = String(ctx.match?.[1] || '');
    const action = String(ctx.match?.[2] || '');
    const target = String(ctx.match?.[3] || '');
    const chatId = resolveTelegramChatId(ctx);
    const request = {
      host: 'telegram',
      chatId,
      externalChatId: chatId,
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
    } else if (kind === 'skill') {
      const [pageRaw, targetNameRaw] = String(target || '').split('|', 2);
      const panelPage = Math.max(0, Number.parseInt(pageRaw || '0', 10) || 0);
      const targetName = targetNameRaw || pageRaw;
      if (action === 'show') text = controller.handleSkillCommand(chatId, `show ${targetName}`);
      else if (action === 'toggle') {
        const detail = controller.handleSkillCommand(chatId, `show ${targetName}`);
        const enabled = /状态：启用/.test(detail);
        text = `${controller.handleSkillCommand(chatId, `${enabled ? 'disable' : 'enable'} ${targetName}`)}\n\n${controller.handleSkillCommand(chatId, '', { page: panelPage })}`;
      } else if (action === 'page') {
        text = controller.handleSkillCommand(chatId, '', { page: panelPage });
      }
    } else if (kind === 'mcp') {
      const [pageRaw, targetNameRaw] = String(target || '').split('|', 2);
      const panelPage = Math.max(0, Number.parseInt(pageRaw || '0', 10) || 0);
      const targetName = targetNameRaw || pageRaw;
      if (action === 'show') text = controller.handleMcpCommand(chatId, `show ${targetName}`);
      else if (action === 'toggle') {
        const detail = controller.handleMcpCommand(chatId, `show ${targetName}`);
        const enabled = /状态：启用/.test(detail);
        text = `${controller.handleMcpCommand(chatId, `${enabled ? 'disable' : 'enable'} ${targetName}`)}\n\n${controller.handleMcpCommand(chatId, '', { page: panelPage })}`;
      } else if (action === 'page') {
        text = controller.handleMcpCommand(chatId, '', { page: panelPage });
      }
    }

    if (!text) {
      await ctx.answerCallbackQuery({ text: '按钮已失效，请重新打开命令面板。', show_alert: false }).catch(() => {});
      return;
    }

    const rendered = renderTelegramPayload({ status: 'Done', text });
    const pages = rendered.pages || [rendered.html];
    const token = rememberPagination(chatId, pages, {
      commandPanelAction: kind,
      commandPanelPage: kind === 'skill' || kind === 'mcp'
        ? Math.max(0, Number.parseInt(String(target || '').split('|', 1)[0] || '0', 10) || 0)
        : 0,
      includeRuntimeControls: true,
      controlsChatId: chatId,
    });
    const commandPanel = buildCommandPanelKeyboard(controller, chatId, kind, {
      page: kind === 'skill' || kind === 'mcp'
        ? Math.max(0, Number.parseInt(String(target || '').split('|', 1)[0] || '0', 10) || 0)
        : 0,
    });
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
    void (async () => {
      try {
        await controller.handleInput({
          host: 'telegram',
          chatId: String(ctx.chat.id),
          externalChatId: String(ctx.chat.id),
          externalUserId: ctx.from ? String(ctx.from.id) : '',
          text,
        }, sink);
      } catch (error) {
        recordError(error, '[telegram] handleInput failed');
      }
    })();
  });

  bot.start({
    allowed_updates: ['message', 'callback_query'],
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

export function createTelegramSink(ctx, rememberPagination, buildPaginationKeyboard, permissionRegistry, controller) {
  let message = null;
  const sentImages = new Set();
  let editBackoffUntilMs = 0;
  let lastProgressEditAtMs = 0;
  let progressUpdateCount = 0;
  let latestProgressEntry = null;
  let latestIntentSummary = '';
  let draftStreamingEnabled = canUseDraftStreaming(ctx?.chat?.id);
  const progressDraftId = randomDraftId();
  const messageThreadId = threadIdFromContext(ctx);
  let progressDraftText = '';
  let assistantDraftText = '';
  let placeholderDraftText = '';
  let pendingDraftText = '';
  let pendingDraftForce = false;
  let draftRetryTimer = null;
  let draftFlushPromise = null;

  async function sendMessage(html, replyMarkup = undefined) {
    message = await ctx.reply(html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    });
    return message;
  }

  async function editCurrentMessage(
    html,
    replyMarkup = undefined,
    { allowFallback = true, logPrefix = '[telegram] editMessageText failed' } = {},
  ) {
    if (!message) {
      await sendMessage(html, replyMarkup);
      return { ok: true, mode: 'sent', reason: '' };
    }
    return editTelegramMessage({
      edit: () => ctx.api.editMessageText(ctx.chat.id, message.message_id, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: allowFallback
        ? async () => {
          await sendMessage(html, replyMarkup);
        }
        : null,
      logPrefix,
    });
  }

  async function deleteMessageById(messageId) {
    if (!messageId) return;
    await deleteTelegramMessage({
      remove: () => ctx.api.deleteMessage(ctx.chat.id, messageId),
      logPrefix: '[telegram] delete progress message failed',
    });
  }

  async function upsertMessage(html, replyMarkup = undefined, { mode = 'final', force = false } = {}) {
    const now = Date.now();
    if (mode === 'progress') {
      if (now < editBackoffUntilMs) return;
      if (!force && message && now - lastProgressEditAtMs < TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) return;
    }
    const result = await editCurrentMessage(html, replyMarkup, {
      allowFallback: mode === 'final',
      logPrefix: '[telegram] editMessageText failed',
    });
    if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
      editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
    }
    if (mode === 'progress' && result.ok) {
      lastProgressEditAtMs = Date.now();
    }
  }

  async function flushPendingDrafts() {
    if (draftFlushPromise) return draftFlushPromise;
    draftFlushPromise = (async () => {
      while (draftStreamingEnabled && pendingDraftText) {
        const now = Date.now();
        const waitMs = Math.max(
          0,
          editBackoffUntilMs - now,
          pendingDraftForce ? 0 : (lastProgressEditAtMs + TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) - now,
        );
        if (waitMs > 0) {
          if (draftRetryTimer) clearTimeout(draftRetryTimer);
          draftRetryTimer = setTimeout(() => {
            draftRetryTimer = null;
            void flushPendingDrafts();
          }, waitMs);
          draftRetryTimer.unref?.();
          break;
        }

        const text = pendingDraftText;
        pendingDraftText = '';
        pendingDraftForce = false;

        const result = await sendTelegramDraft({
          send: () => ctx.api.sendMessageDraft(
            ctx.chat.id,
            progressDraftId,
            text,
            messageThreadId ? { message_thread_id: messageThreadId } : undefined,
          ),
          meta: {
            chatId: String(ctx.chat.id),
            messageThreadId: messageThreadId || null,
            draftId: progressDraftId,
            textLength: String(text || '').length,
            textPreview: truncateText(String(text || '').replace(/\s+/g, ' '), 120),
          },
          logPrefix: '[telegram] sendMessageDraft failed',
        });

        if (result.ok) {
          lastProgressEditAtMs = Date.now();
          continue;
        }
        if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
          pendingDraftText = text;
          editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
          continue;
        }

        draftStreamingEnabled = false;
        pendingDraftText = '';
        pendingDraftForce = false;
      }
    })().finally(() => {
      draftFlushPromise = null;
    });
    return draftFlushPromise;
  }

  async function upsertProgress(text, { force = false } = {}) {
    pendingDraftText = text;
    pendingDraftForce = pendingDraftForce || force;
    if (!draftStreamingEnabled) return;
    void flushPendingDrafts();
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

  async function finalizeDraftIndicator(text = TELEGRAM_DRAFT_CLEAR_TEXT) {
    if (!draftStreamingEnabled) return;
    try {
      await ctx.api.sendMessageDraft(
        ctx.chat.id,
        progressDraftId,
        String(text || TELEGRAM_DRAFT_CLEAR_TEXT) || TELEGRAM_DRAFT_CLEAR_TEXT,
        messageThreadId ? { message_thread_id: messageThreadId } : undefined,
      );
    } catch {
      // ignore final draft cleanup failures
    }
    draftStreamingEnabled = false;
    pendingDraftText = '';
    pendingDraftForce = false;
    if (draftRetryTimer) {
      clearTimeout(draftRetryTimer);
      draftRetryTimer = null;
    }
  }

  return {
    async progress(payload) {
      const entry = buildTelegramProgressEntry(payload);
      if (entry.kind === 'placeholder') {
        if (!latestProgressEntry) {
          placeholderDraftText = draftTextFromMarkdown(entry.html);
          await upsertProgress(placeholderDraftText);
          if (draftStreamingEnabled) progressUpdateCount += 1;
        }
        return;
      }
      if (entry.phase === 'thinking') {
        latestIntentSummary = String(entry.summary || '').trim();
        assistantDraftText = '';
        progressDraftText = draftLineFromEntry(entry, payload);
      } else if (entry.marker === 'assistant' || entry.phase === 'assistant') {
        assistantDraftText = appendAssistantDraftText(assistantDraftText, String(payload?.text || entry.summary || ''));
        progressDraftText = '';
      } else {
        assistantDraftText = '';
        progressDraftText = entry.marker === 'exec' || entry.phase === 'exec'
          ? buildExecDraftText(entry, payload)
          : draftLineFromEntry(entry, payload);
      }
      latestProgressEntry = entry;
      placeholderDraftText = '';

      const shouldForceFlush = entry.marker !== 'assistant'
        || entry.phase !== 'assistant'
        || assistantDraftText.length >= TELEGRAM_DRAFT_ASSISTANT_FLUSH_CHARS;

      const currentDraftText = String(
        assistantDraftText
        || progressDraftText
        || latestIntentSummary
        || placeholderDraftText
        || entry.summary
        || payload?.text
        || '请稍候'
      ).trim();

      await upsertProgress(
        currentDraftText,
        { force: shouldForceFlush },
      );
      if (draftStreamingEnabled) progressUpdateCount += 1;
    },
    async final(payload, options = {}) {
      await finalizeDraftIndicator();
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(String(ctx.chat.id), pages, {
        commandPanelAction: String(options?.telegramControls?.commandPanelAction || '').trim().toLowerCase(),
        commandPanelPage: Math.max(0, Number(options?.telegramControls?.commandPanelPage) || 0),
        includeRuntimeControls: Boolean(options?.telegramControls),
        controlsChatId: String(options?.telegramControls?.chatId || ctx.chat.id),
      });
      const commandPanel = options?.telegramControls?.commandPanelAction
        ? buildCommandPanelKeyboard(
          controller,
          String(options.telegramControls.chatId || ctx.chat.id),
          String(options.telegramControls.commandPanelAction),
          { page: Math.max(0, Number(options?.telegramControls?.commandPanelPage) || 0) },
        )
        : undefined;
      const controls = options?.telegramControls ? buildRuntimeControlKeyboard(controller, String(options.telegramControls.chatId || ctx.chat.id)) : undefined;
      const replyMarkup = mergeInlineKeyboards(
        token ? buildPaginationKeyboard(token, 0, pages.length) : undefined,
        commandPanel,
        controls,
      );
      const shouldSendStandalone = shouldSendStandaloneFinalTelegramMessage({
        hasProgressMessage: Boolean(message) && progressUpdateCount > 0,
        pageCount: pages.length,
        hasImages: Array.isArray(rendered.images) && rendered.images.length > 0,
        hasReplyMarkup: Boolean(replyMarkup?.inline_keyboard?.length),
        elapsedSeconds: Number(payload?.elapsedSeconds) || 0,
        progressUpdateCount,
      });
      console.info(`[telegram] final mode=${shouldSendStandalone ? 'standalone' : 'inline'} pages=${pages.length} images=${rendered.images?.length || 0} reply_markup=${replyMarkup?.inline_keyboard?.length || 0}`);
      if (shouldSendStandalone) {
        const progressMessageId = message?.message_id;
        await sendMessage(pages[0] || rendered.html, replyMarkup);
        await deleteMessageById(progressMessageId);
      } else {
        await upsertMessage(
          pages[0] || rendered.html,
          replyMarkup,
          { mode: 'final' },
        );
      }
      await sendImages(rendered.images);
    },
    async requestPermission(request, { signal } = {}) {
      const pending = permissionRegistry.create(String(ctx.chat.id), request);
      const keyboard = buildPermissionKeyboard(pending.token, request);
      const html = buildPermissionPromptHtml(request);
      console.info(`[telegram] permission prompt chat=${ctx.chat.id} token=${pending.token}`);
      const abortHandler = () => {
        permissionRegistry.cancel(pending.token, String(ctx.chat.id), 'aborted');
      };

      signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        await upsertMessage(html, keyboard, { mode: 'final' });
        const decision = await pending.promise;
        console.info(`[telegram] permission resolved chat=${ctx.chat.id} token=${pending.token} outcome=${decision?.outcome?.outcome || 'unknown'} option=${decision?.outcome?.optionId || ''}`);
        await upsertMessage(buildPermissionDecisionHtml(request, decision), undefined, { mode: 'final' });
        return { outcome: decision.outcome };
      } catch (error) {
        permissionRegistry.cancel(pending.token, String(ctx.chat.id), 'prompt-error');
        throw error;
      } finally {
        signal?.removeEventListener('abort', abortHandler);
      }
    },
    async sendAudio(audioPath, options = {}) {
      const targetChatId = ctx?.chat?.id;
      if (!targetChatId || !audioPath) return { ok: false, reason: 'missing chatId or audioPath' };
      if (!fs.existsSync(audioPath)) {
        console.warn('[telegram] sendAudio: file not found', audioPath);
        return { ok: false, reason: 'file not found' };
      }
      try {
        // 发送为 Voice Message (OGG/Opus)
        // caption 可选，语音消息会显示为 "🎤 <caption>"
        const sendOptions = {};
        if (options.caption) {
          sendOptions.caption = options.caption;
          sendOptions.parse_mode = 'HTML';
        }
        await ctx.replyWithVoice(new InputFile(audioPath), sendOptions);
        console.info('[telegram] sendVoice success:', audioPath);
        return { ok: true };
      } catch (error) {
        const errorText = error?.description || error?.message || String(error);
        console.warn('[telegram] sendVoice failed:', errorText);
        // 降级：尝试作为音频文件发送
        try {
          const fallbackOptions = {};
          if (options.caption) {
            fallbackOptions.caption = options.caption;
            fallbackOptions.parse_mode = 'HTML';
          }
          await ctx.replyWithAudio(new InputFile(audioPath), fallbackOptions);
          console.info('[telegram] sendVoice fallback to audio success:', audioPath);
          return { ok: true, mode: 'audio_fallback' };
        } catch (fallbackError) {
          console.warn('[telegram] sendVoice fallback also failed:', fallbackError?.message || fallbackError);
          return { ok: false, reason: errorText };
        }
      } finally {
        // 清理临时音频文件
        try {
          if (audioPath.includes('/tmp/tts_')) {
            fs.unlinkSync(audioPath);
          }
        } catch {}
      }
    },
  };
}

export function createTelegramPushSink(bot, binding, rememberPagination, buildPaginationKeyboard) {
  const chatId = typeof binding === 'object'
    ? String(binding.externalChatId || binding.chatId || '')
    : String(binding || '');
  let message = null;
  const sentImages = new Set();
  let editBackoffUntilMs = 0;
  let lastProgressEditAtMs = 0;
  let progressUpdateCount = 0;
  let draftStreamingEnabled = canUseDraftStreaming(chatId);
  const progressDraftId = randomDraftId();
  let progressDraftText = '';
  let pendingDraftText = '';
  let draftRetryTimer = null;
  let draftFlushPromise = null;

  async function sendMessage(html, replyMarkup = undefined) {
    if (!chatId) return null;
    message = await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    });
    return message;
  }

  async function editCurrentMessage(
    html,
    replyMarkup = undefined,
    { allowFallback = true, logPrefix = '[telegram] push editMessageText failed' } = {},
  ) {
    if (!chatId) return { ok: false, mode: 'skipped', reason: 'missing chat id' };
    if (!message) {
      await sendMessage(html, replyMarkup);
      return { ok: true, mode: 'sent', reason: '' };
    }
    return editTelegramMessage({
      edit: () => bot.api.editMessageText(chatId, message.message_id, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      sendFallback: allowFallback
        ? async () => {
          await sendMessage(html, replyMarkup);
        }
        : null,
      logPrefix,
    });
  }

  async function deleteMessageById(messageId) {
    if (!chatId || !messageId) return;
    await deleteTelegramMessage({
      remove: () => bot.api.deleteMessage(chatId, messageId),
      logPrefix: '[telegram] push delete progress message failed',
    });
  }

  async function upsertMessage(html, replyMarkup = undefined, { mode = 'final' } = {}) {
    if (!chatId) return;
    const now = Date.now();
    if (mode === 'progress') {
      if (now < editBackoffUntilMs) return;
      if (message && now - lastProgressEditAtMs < TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) return;
    }
    const result = await editCurrentMessage(html, replyMarkup, {
      allowFallback: mode === 'final',
      logPrefix: '[telegram] push editMessageText failed',
    });
    if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
      editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
    }
    if (mode === 'progress' && result.ok) {
      lastProgressEditAtMs = Date.now();
    }
  }

  async function flushPendingPushDrafts() {
    if (draftFlushPromise) return draftFlushPromise;
    draftFlushPromise = (async () => {
      while (draftStreamingEnabled && pendingDraftText) {
        const now = Date.now();
        const waitMs = Math.max(0, editBackoffUntilMs - now, (lastProgressEditAtMs + TELEGRAM_PROGRESS_EDIT_INTERVAL_MS) - now);
        if (waitMs > 0) {
          if (draftRetryTimer) clearTimeout(draftRetryTimer);
          draftRetryTimer = setTimeout(() => {
            draftRetryTimer = null;
            void flushPendingPushDrafts();
          }, waitMs);
          draftRetryTimer.unref?.();
          break;
        }

        const text = pendingDraftText;
        pendingDraftText = '';
        const result = await sendTelegramDraft({
          send: () => bot.api.sendMessageDraft(chatId, progressDraftId, text),
          meta: {
            chatId,
            draftId: progressDraftId,
            textLength: String(text || '').length,
            textPreview: truncateText(String(text || '').replace(/\s+/g, ' '), 120),
          },
          logPrefix: '[telegram] push sendMessageDraft failed',
        });

        if (result.ok) {
          lastProgressEditAtMs = Date.now();
          continue;
        }
        if (result.mode === 'rate_limited' && result.retryAfterSeconds) {
          pendingDraftText = text;
          editBackoffUntilMs = Date.now() + (result.retryAfterSeconds * 1000);
          continue;
        }

        draftStreamingEnabled = false;
        pendingDraftText = '';
      }
    })().finally(() => {
      draftFlushPromise = null;
    });
    return draftFlushPromise;
  }

  async function upsertProgress(text) {
    if (!chatId) return;
    pendingDraftText = text;
    if (!draftStreamingEnabled) return;
    void flushPendingPushDrafts();
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

  async function finalizeDraftIndicator(text = TELEGRAM_DRAFT_CLEAR_TEXT) {
    if (!draftStreamingEnabled || !chatId) return;
    try {
      await bot.api.sendMessageDraft(chatId, progressDraftId, String(text || TELEGRAM_DRAFT_CLEAR_TEXT) || TELEGRAM_DRAFT_CLEAR_TEXT);
    } catch {
      // ignore final draft cleanup failures
    }
    draftStreamingEnabled = false;
    pendingDraftText = '';
    if (draftRetryTimer) {
      clearTimeout(draftRetryTimer);
      draftRetryTimer = null;
    }
  }

  return {
    async progress(payload) {
      const entry = buildTelegramProgressEntry(payload);
      progressDraftText = mergeDraftHtml(progressDraftText, draftTextFromMarkdown(entry.html));
      await upsertProgress(progressDraftText);
      if (draftStreamingEnabled) progressUpdateCount += 1;
    },
    async final(payload) {
      await finalizeDraftIndicator();
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages || [rendered.html];
      const token = rememberPagination(chatId, pages);
      const replyMarkup = token ? buildPaginationKeyboard(token, 0, pages.length) : undefined;
      const shouldSendStandalone = shouldSendStandaloneFinalTelegramMessage({
        hasProgressMessage: Boolean(message) && progressUpdateCount > 0,
        pageCount: pages.length,
        hasImages: Array.isArray(rendered.images) && rendered.images.length > 0,
        hasReplyMarkup: Boolean(replyMarkup?.inline_keyboard?.length),
        elapsedSeconds: Number(payload?.elapsedSeconds) || 0,
        progressUpdateCount,
      });
      console.info(`[telegram] push final mode=${shouldSendStandalone ? 'standalone' : 'inline'} pages=${pages.length} images=${rendered.images?.length || 0}`);
      if (shouldSendStandalone) {
        const progressMessageId = message?.message_id;
        await sendMessage(pages[0] || rendered.html, replyMarkup);
        await deleteMessageById(progressMessageId);
      } else {
        await upsertMessage(
          pages[0] || rendered.html,
          replyMarkup,
          { mode: 'final' },
        );
      }
      await sendImages(rendered.images);
    },
    async sendAudio(audioPath, options = {}) {
      if (!chatId || !audioPath) return { ok: false, reason: 'missing chatId or audioPath' };
      if (!fs.existsSync(audioPath)) {
        console.warn('[telegram] sendAudio: file not found', audioPath);
        return { ok: false, reason: 'file not found' };
      }
      try {
        // 发送为 Voice Message (OGG/Opus)
        // caption 可选，语音消息会显示为 "🎤 <caption>"
        const sendOptions = {};
        if (options.caption) {
          sendOptions.caption = options.caption;
          sendOptions.parse_mode = 'HTML';
        }
        await bot.api.sendVoice(chatId, new InputFile(audioPath), sendOptions);
        console.info('[telegram] sendVoice success:', audioPath);
        return { ok: true };
      } catch (error) {
        const errorText = error?.description || error?.message || String(error);
        console.warn('[telegram] sendVoice failed:', errorText);
        // 降级：尝试作为音频文件发送
        try {
          const fallbackOptions = {};
          if (options.caption) {
            fallbackOptions.caption = options.caption;
            fallbackOptions.parse_mode = 'HTML';
          }
          await bot.api.sendAudio(chatId, new InputFile(audioPath), fallbackOptions);
          console.info('[telegram] sendVoice fallback to audio success:', audioPath);
          return { ok: true, mode: 'audio_fallback' };
        } catch (fallbackError) {
          console.warn('[telegram] sendVoice fallback also failed:', fallbackError?.message || fallbackError);
          return { ok: false, reason: errorText };
        }
      } finally {
        // 清理临时音频文件
        try {
          if (audioPath.includes('/tmp/tts_')) {
            fs.unlinkSync(audioPath);
          }
        } catch {}
      }
    },
  };
}
