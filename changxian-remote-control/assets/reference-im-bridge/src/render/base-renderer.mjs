// ============================================================================
// BaseRenderer - 基础渲染器，提供纯文本默认实现
// 参考 OpenACP/src/core/adapter-primitives/rendering/renderer.ts
// ============================================================================

import {
  formatToolSummary,
  formatToolTitle,
  resolveToolIcon,
  progressBar,
  formatTokens,
} from './format/index.mjs';

// ============================================================================
// 类型定义（保留用于文档）
// ============================================================================

/**
 * @typedef {Object} RenderedMessage
 * @property {string} body
 * @property {string} format
 * @property {Array} [attachments]
 * @property {Object} [components]
 */

/**
 * @typedef {Object} RenderedPermission
 * @extends RenderedMessage
 * @property {Array<{id, label, isAllow?}>} actions
 */

/**
 * @typedef {Object} OutgoingMessage
 * @property {string} type
 * @property {string} text
 * @property {Object} [metadata]
 * @property {Object} [attachment]
 */

/**
 * @typedef {Object} NotificationMessage
 * @property {string} sessionId
 * @property {string} [sessionName]
 * @property {string} type
 * @property {string} summary
 * @property {string} [deepLink]
 */

/**
 * @typedef {Object} PermissionRequest
 * @property {string} id
 * @property {string} description
 * @property {Array<{id, label, isAllow}>} options
 */

/**
 * @typedef {Object} PlanEntry
 * @property {string} content
 * @property {string} status
 * @property {string} [priority]
 */

// ============================================================================
// BaseRenderer - 基础渲染器，提供纯文本默认实现
// ============================================================================

/**
 * BaseRenderer - 基础渲染器，提供纯文本默认实现
 * 继承此类并重写方法以实现平台特定渲染
 */
export class BaseRenderer {
  /**
   * 渲染文本消息
   */
  renderText(content, verbosity) {
    return { body: content.text, format: 'plain' };
  }

  /**
   * 渲染思考过程
   */
  renderThought(content, verbosity) {
    return { body: content.text, format: 'plain' };
  }

  /**
   * 渲染工具调用
   */
  renderToolCall(content, verbosity) {
    const meta = /** @type {Record<string, unknown>} */ (content.metadata ?? {});
    const name = String(meta.name || content.text || 'Tool');
    const icon = resolveToolIcon(/** @type {any} */ (meta));
    const label = verbosity === 'low'
      ? formatToolTitle(name, meta.rawInput, /** @type {string} */ (meta.displayTitle))
      : formatToolSummary(name, meta.rawInput, /** @type {string} */ (meta.displaySummary));
    return { body: `${icon} ${label}`, format: 'plain' };
  }

  /**
   * 渲染工具更新
   */
  renderToolUpdate(content, verbosity) {
    const meta = /** @type {Record<string, unknown>} */ (content.metadata ?? {});
    const name = String(meta.name || content.text || 'Tool');
    const icon = resolveToolIcon(/** @type {any} */ (meta));
    const label = verbosity === 'low'
      ? formatToolTitle(name, meta.rawInput, /** @type {string} */ (meta.displayTitle))
      : formatToolSummary(name, meta.rawInput, /** @type {string} */ (meta.displaySummary));
    return { body: `${icon} ${label}`, format: 'plain' };
  }

  /**
   * 渲染计划
   */
  renderPlan(content) {
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});
    const entries = /** @type {Array<{content: string, status: string, priority?: string}>} */ (meta.entries ?? []);
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
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});

    if (!meta.tokensUsed) {
      return { body: '📊 Usage data unavailable', format: 'plain' };
    }

    const cost = /** @type {number | undefined} */ (meta.cost);
    const costStr = cost != null ? ` · $${cost.toFixed(2)}` : '';

    if (verbosity === 'medium') {
      return {
        body: `📊 ${formatTokens(/** @type {number} */ (meta.tokensUsed))} tokens${costStr}`,
        format: 'plain',
      };
    }

    const tokensUsed = /** @type {number} */ (meta.tokensUsed);
    const contextSize = /** @type {number | undefined} */ (meta.contextSize);

    if (!contextSize) {
      return {
        body: `📊 ${formatTokens(tokensUsed)} tokens`,
        format: 'plain',
      };
    }

    const ratio = tokensUsed / contextSize;
    const pct = Math.round(ratio * 100);
    const bar = progressBar(ratio);
    let text = `📊 ${formatTokens(tokensUsed)} / ${formatTokens(contextSize)} tokens\n${bar} ${pct}%`;
    if (cost != null) text += `\n💰 $${cost.toFixed(2)}`;

    return { body: text, format: 'plain' };
  }

  /**
   * 渲染权限请求
   */
  renderPermission(request) {
    return {
      body: request.description,
      format: 'plain',
      actions: request.options.map((o) => ({
        id: o.id,
        label: o.label,
        isAllow: o.isAllow,
      })),
    };
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
   * 渲染附件
   */
  renderAttachment(content) {
    const attachment = /** @type {any} */ (content.attachment);
    if (!attachment) {
      return { body: content.text || '📎 Attachment', format: 'plain' };
    }
    const icon = attachment.type === 'image' ? '🖼️' : attachment.type === 'audio' ? '🎵' : '📎';
    return {
      body: `${icon} ${attachment.fileName}`,
      format: 'plain',
    };
  }

  /**
   * 渲染会话结束
   */
  renderSessionEnd(content) {
    return { body: `🔚 Session ended: ${content.text}`, format: 'plain' };
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
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});
    const modeId = String(meta.modeId ?? '');
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
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});
    const modelId = String(meta.modelId ?? '');
    return { body: `🤖 Model: ${modelId}`, format: 'plain' };
  }

  /**
   * 渲染资源内容
   */
  renderResource(content) {
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});
    const uri = String(meta.uri ?? '');
    return { body: `📄 Resource: ${content.text} (${uri})`, format: 'plain' };
  }

  /**
   * 渲染资源链接
   */
  renderResourceLink(content) {
    const meta = /** @type {Record<string, unknown>} */ (content.metadata || {});
    const uri = String(meta.uri ?? '');
    return { body: `🔗 ${content.text}: ${uri}`, format: 'plain' };
  }

  /**
   * 根据消息类型自动选择渲染方法
   */
  render(content, verbosity = 'medium') {
    switch (content.type) {
      case 'text':
        return this.renderText(content, verbosity);
      case 'thought':
        return this.renderThought ? this.renderThought(content, verbosity) : this.renderText(content, verbosity);
      case 'tool_call':
        return this.renderToolCall(content, verbosity);
      case 'tool_update':
        return this.renderToolUpdate(content, verbosity);
      case 'plan':
        return this.renderPlan(content);
      case 'usage':
        return this.renderUsage(content, verbosity);
      case 'session_end':
        return this.renderSessionEnd ? this.renderSessionEnd(content) : this.renderText(content, verbosity);
      case 'error':
        return this.renderError(content);
      case 'attachment':
        return this.renderAttachment ? this.renderAttachment(content) : this.renderText(content, verbosity);
      case 'system_message':
        return this.renderSystemMessage ? this.renderSystemMessage(content) : this.renderText(content, verbosity);
      case 'mode_change':
        return this.renderModeChange ? this.renderModeChange(content, verbosity) : this.renderText(content, verbosity);
      case 'config_update':
        return this.renderConfigUpdate ? this.renderConfigUpdate(content, verbosity) : this.renderText(content, verbosity);
      case 'model_update':
        return this.renderModelUpdate ? this.renderModelUpdate(content, verbosity) : this.renderText(content, verbosity);
      case 'resource':
        return this.renderResource ? this.renderResource(content) : this.renderText(content, verbosity);
      case 'resource_link':
        return this.renderResourceLink ? this.renderResourceLink(content) : this.renderText(content, verbosity);
      case 'user_replay':
        return this.renderText(content, verbosity);
      default:
        return this.renderText({ type: 'text', text: content.text }, verbosity);
    }
  }
}
