// ============================================================================
// WeComRenderer - 企业微信平台特定渲染器
// 参考 render.wecom.mjs
// ============================================================================

import { BaseRenderer } from './base-renderer.mjs';
import {
  buildDetailedProgressMarkdown,
  buildPreviewDiffMarkdown,
  previewHasProgressDetails,
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  sanitizePreview,
  splitMarkdownPages,
} from '../utils/utils.mjs';

const WECOM_MESSAGE_LIMIT = 3600;
const WECOM_FINAL_PAGE_LIMIT = 3200;
const THINKING_SPINNER_FRAMES = ['-', '\\', '|', '/'];

// ============================================================================
// 工具函数
// ============================================================================

function clipMessage(text, limit = WECOM_MESSAGE_LIMIT) {
  const value = String(text || '').trim() || '暂无输出';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 13)).trimEnd()}\n\n[truncated]`;
}

function formatElapsedSeconds(elapsedSeconds) {
  const total = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function progressHeading(preview) {
  if (preview.phase === 'thinking') return '正在推理';
  if (preview.phase === 'diff') return '正在整理变更';
  if (preview.phase === 'research') return '正在检索资料';
  return '';
}

function firstNonEmptyLine(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

// ============================================================================
// 工具图标映射
// ============================================================================

const TOOL_ICON_MAP = {
  read: '📖',
  write: '✏️',
  edit: '🔧',
  delete: '🗑️',
  search: '🔍',
  execute: '⚡',
  bash: '💻',
  run: '▶️',
  create: '🆕',
  list: '📋',
  get: '📤',
  set: '📥',
  upload: '⬆️',
  download: '⬇️',
  send: '📤',
  post: '📤',
  fetch: '📡',
  analyze: '🔬',
  transform: '🔄',
  convert: '🔃',
  generate: '🎨',
  build: '🏗️',
  deploy: '🚀',
  test: '🧪',
  debug: '🐛',
  log: '📝',
  monitor: '📊',
  schedule: '⏰',
  notify: '🔔',
};

function resolveToolIcon(meta) {
  const name = (meta?.name || '').toLowerCase();
  const kind = (meta?.kind || '').toLowerCase();
  for (const [key, icon] of Object.entries(TOOL_ICON_MAP)) {
    if (name.includes(key) || kind.includes(key)) {
      return icon;
    }
  }
  return '🔧';
}

function formatToolTitle(name, rawInput, displayTitle) {
  if (displayTitle) return displayTitle;
  const inputStr = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput || '').slice(0, 60);
  return inputStr ? `${name}(${inputStr})` : name;
}

function formatToolSummary(name, rawInput, displaySummary) {
  if (displaySummary) return displaySummary;
  return formatToolTitle(name, rawInput);
}

// ============================================================================
// WeComRenderer 类
// ============================================================================

export class WeComRenderer extends BaseRenderer {
  /**
   * 渲染文本消息 - 纯文本（企业微信不支持 HTML）
   */
  renderText(content, verbosity) {
    // 企业微信不支持 HTML，使用纯文本
    return { body: content.text, format: 'plain' };
  }

  /**
   * 渲染工具调用
   */
  renderToolCall(content, verbosity) {
    const meta = (content.metadata ?? {});
    const icon = resolveToolIcon(meta);
    const name = meta.name || content.text || 'Tool';
    const label = verbosity === 'low'
      ? formatToolTitle(name, meta.rawInput, meta.displayTitle)
      : formatToolSummary(name, meta.rawInput, meta.displaySummary);
    return {
      body: `${icon} ${label}`,
      format: 'plain',
    };
  }

  /**
   * 渲染工具更新
   */
  renderToolUpdate(content, verbosity) {
    const meta = (content.metadata ?? {});
    const icon = resolveToolIcon(meta);
    const name = meta.name || content.text || 'Tool';
    const label = verbosity === 'low'
      ? formatToolTitle(name, meta.rawInput, meta.displayTitle)
      : formatToolSummary(name, meta.rawInput, meta.displaySummary);
    return {
      body: `${icon} ${label}`,
      format: 'plain',
    };
  }

  /**
   * 渲染计划
   */
  renderPlan(content) {
    const meta = content.metadata || {};
    const entries = meta.entries ?? [];
    const lines = entries.map((e, i) => {
      const icon = e.status === 'completed' ? '✅' : e.status === 'in_progress' ? '🔄' : '⬜';
      const priority = e.priority ? ` [${e.priority}]` : '';
      return `${icon} ${i + 1}. ${e.content}${priority}`;
    });
    return {
      body: `📋 Plan\n${lines.join('\n')}`,
      format: 'plain',
    };
  }

  /**
   * 渲染使用统计
   */
  renderUsage(content, verbosity) {
    const meta = content.metadata || {};

    if (!meta.tokensUsed) {
      return { body: '📊 Usage data unavailable', format: 'plain' };
    }

    const costStr = meta.cost != null ? ` · $${meta.cost.toFixed(2)}` : '';

    if (verbosity === 'medium') {
      return {
        body: `📊 ${meta.tokensUsed} tokens${costStr}`,
        format: 'plain',
      };
    }

    if (!meta.contextSize) {
      return {
        body: `📊 ${meta.tokensUsed} tokens`,
        format: 'plain',
      };
    }

    const ratio = meta.tokensUsed / meta.contextSize;
    const pct = Math.round(ratio * 100);
    let text = `📊 ${meta.tokensUsed} / ${meta.contextSize} tokens\n${pct}%`;
    if (meta.cost != null) text += `\n💰 $${meta.cost.toFixed(2)}`;

    return { body: text, format: 'plain' };
  }

  /**
   * 渲染错误
   */
  renderError(content) {
    return { body: `❌ Error: ${content.text}`, format: 'plain' };
  }

  /**
   * 渲染通知
   */
  renderNotification(notification) {
    const emoji = {
      completed: '✅',
      error: '❌',
      permission: '🔐',
      input_required: '💬',
      budget_warning: '⚠️',
    };
    return {
      body: `${emoji[notification.type] || 'ℹ️'} ${notification.sessionName || 'Session'}\n${notification.summary}`,
      format: 'plain',
    };
  }

  /**
   * 渲染系统消息
   */
  renderSystemMessage(content) {
    return { body: content.text, format: 'plain' };
  }

  /**
   * 渲染模式变更
   */
  renderModeChange(content, verbosity) {
    const modeId = (content.metadata)?.modeId ?? '';
    return { body: `🔄 Mode: ${modeId}`, format: 'plain' };
  }

  /**
   * 渲染配置更新
   */
  renderConfigUpdate(content, verbosity) {
    return { body: '⚙️ Config updated', format: 'plain' };
  }

  /**
   * 渲染模型更新
   */
  renderModelUpdate(content, verbosity) {
    const modelId = (content.metadata)?.modelId ?? '';
    return { body: `🤖 Model: ${modelId}`, format: 'plain' };
  }

  // ============================================================================
  // 遗留兼容方法 - 用于 renderWeComPayload
  // ============================================================================

  /**
   * 渲染 Legacy Payload（保持向后兼容）
   */
  renderLegacyPayload(payload) {
    const status = String(payload.status || 'Done');
    const marker = String(payload.marker || '').toLowerCase();
    const previewModel = this.resolvePreviewModel(payload);
    const preview = sanitizePreview(previewModel.content || payload.text || '', status)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    const previewLower = preview.toLowerCase();
    const hasProgressDetails = previewHasProgressDetails(previewModel);

    // 处理 thinking 状态
    if (status === 'Running' && (!hasProgressDetails && (marker === 'thinking' || previewLower === 'thinking...' || previewLower.startsWith('thinking\n') || !preview))) {
      const tick = Math.floor(Number(payload.elapsedSeconds) || 0);
      const frame = THINKING_SPINNER_FRAMES[tick % THINKING_SPINNER_FRAMES.length];
      const content = clipMessage(`${frame} Thinking`);
      return { content, pages: [content] };
    }

    // 处理 Done 状态
    if (status === 'Done') {
      const pages = this.buildWeComStructuredPages(previewModel);
      return {
        content: pages[0] || '暂无输出',
        pages,
      };
    }

    // 处理 Running 状态（带进度）
    const content = this.buildWeComProgressContent(previewModel);
    return { content, pages: [content] };
  }

  resolvePreviewModel(payload) {
    if (payload?.preview && typeof payload.preview === 'object' && !Array.isArray(payload.preview)) {
      return payload.preview;
    }
    const status = String(payload?.status || 'Done');
    const marker = String(payload?.marker || 'assistant').toLowerCase();
    const payloadText = typeof payload === 'string' ? payload : (payload?.text || '');
    return buildStructuredPreview(payloadText, { status, marker });
  }

  buildWeComProgressContent(preview) {
    const lines = [];
    const summary = String(preview?.summary || '').trim() || firstNonEmptyLine(preview?.content || '');
    const firstHighlight = Array.isArray(preview?.highlights) ? String(preview.highlights[0] || '').trim() : '';
    const firstCheck = Array.isArray(preview?.checks) ? String(preview.checks[0] || '').trim() : '';

    if (summary) lines.push(summary);
    if (firstHighlight && !lines.some((line) => line.includes(firstHighlight))) lines.push(firstHighlight);
    if (firstCheck && !lines.some((line) => line.includes(firstCheck))) lines.push(firstCheck);
    if (!lines.length) {
      const heading = progressHeading(preview);
      if (heading) lines.push(heading);
    }
    return clipMessage(lines.filter(Boolean).join('\n'));
  }

  buildWeComStructuredPages(preview) {
    const pages = [];
    const narrative = String(preview.proseMarkdown || '').trim();
    if (narrative) {
      pages.push(...splitMarkdownPages(narrative, WECOM_FINAL_PAGE_LIMIT));
    } else {
      const summary = buildPreviewSummaryMarkdown(preview, {
        maxHighlights: 6,
        maxChecks: 5,
        maxFiles: 6,
        maxNotes: 4,
        includeDiffHint: true,
      });
      if (summary) pages.push(...splitMarkdownPages(summary, WECOM_FINAL_PAGE_LIMIT));
    }

    const diff = buildPreviewDiffMarkdown(preview, {
      heading: '变更节选',
      maxFiles: 2,
      maxHunksPerFile: 2,
      maxLinesPerHunk: 5,
      maxLinesPerFile: 16,
      maxTotalLines: 32,
    });
    if (diff) pages.push(...splitMarkdownPages(diff, WECOM_FINAL_PAGE_LIMIT));

    return pages.length ? pages : ['暂无输出'];
  }
}

// ============================================================================
// 遗留兼容导出
// ============================================================================

const renderer = new WeComRenderer();

export function renderWeComPayload(payload) {
  return renderer.renderLegacyPayload(payload);
}
