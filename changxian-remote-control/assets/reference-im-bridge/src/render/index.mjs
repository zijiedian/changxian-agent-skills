// ============================================================================
// Render Module - 统一导出
// ============================================================================

// 渲染器
export { BaseRenderer } from './base-renderer.mjs';
export { TelegramRenderer } from './telegram-renderer.mjs';
export { WeComRenderer } from './wecom-renderer.mjs';

// 消息转换器
export { MessageTransformer } from './message-transformer.mjs';

// ============================================================================
// 便捷工厂函数
// ============================================================================

import { BaseRenderer } from './base-renderer.mjs';
import { TelegramRenderer } from './telegram-renderer.mjs';
import { WeComRenderer } from './wecom-renderer.mjs';
import { MessageTransformer } from './message-transformer.mjs';

/**
 * 创建渲染器实例
 * @param {'telegram' | 'wecom' | 'base'} platform - 目标平台
 * @returns {BaseRenderer} 渲染器实例
 */
export function createRenderer(platform = 'base') {
  switch (platform) {
    case 'telegram':
      return new TelegramRenderer();
    case 'wecom':
      return new WeComRenderer();
    default:
      return new BaseRenderer();
  }
}

/**
 * 创建消息转换器
 * @param {object} [tunnelService] - Tunnel 服务接口
 * @returns {MessageTransformer} 消息转换器实例
 */
export function createMessageTransformer(tunnelService) {
  return new MessageTransformer(tunnelService);
}

// ============================================================================
// 遗留兼容导出（保持与旧代码的兼容性）
// ============================================================================

// 从 telegram-renderer 重新导出
import { TelegramRenderer, markdownToTelegramHtml, coerceTelegramHtml, renderTelegramPayload } from './telegram-renderer.mjs';
export { renderTelegramPayload, coerceTelegramHtml };

// 从 wecom-renderer 重新导出
import { WeComRenderer as WCRenderer, renderWeComPayload } from './wecom-renderer.mjs';
export { renderWeComPayload };

// ============================================================================
// 常量导出
// ============================================================================

export const DISPLAY_VERBOSITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

export const OUTGOING_MESSAGE_TYPES = {
  TEXT: 'text',
  THOUGHT: 'thought',
  TOOL_CALL: 'tool_call',
  TOOL_UPDATE: 'tool_update',
  PLAN: 'plan',
  USAGE: 'usage',
  SESSION_END: 'session_end',
  ERROR: 'error',
  ATTACHMENT: 'attachment',
  SYSTEM_MESSAGE: 'system_message',
  MODE_CHANGE: 'mode_change',
  CONFIG_UPDATE: 'config_update',
  MODEL_UPDATE: 'model_update',
  USER_REPLAY: 'user_replay',
  RESOURCE: 'resource',
  RESOURCE_LINK: 'resource_link',
};

export const AGENT_EVENT_TYPES = {
  TEXT: 'text',
  THOUGHT: 'thought',
  TOOL_CALL: 'tool_call',
  TOOL_UPDATE: 'tool_update',
  PLAN: 'plan',
  USAGE: 'usage',
  COMMANDS_UPDATE: 'commands_update',
  IMAGE_CONTENT: 'image_content',
  AUDIO_CONTENT: 'audio_content',
  SESSION_END: 'session_end',
  ERROR: 'error',
  SYSTEM_MESSAGE: 'system_message',
  SESSION_INFO_UPDATE: 'session_info_update',
  CURRENT_MODE_UPDATE: 'current_mode_update',
  CONFIG_OPTION_UPDATE: 'config_option_update',
  MODEL_UPDATE: 'model_update',
  USER_MESSAGE_CHUNK: 'user_message_chunk',
  RESOURCE_CONTENT: 'resource_content',
  RESOURCE_LINK: 'resource_link',
};
