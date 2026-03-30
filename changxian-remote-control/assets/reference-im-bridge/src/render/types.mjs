// ============================================================================
// Runtime-safe render type constants
// ============================================================================

export const AGENT_EVENT_TYPES = Object.freeze({
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
});

export const TOOL_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ERROR: 'error',
});

export const PLAN_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
});

export const PLAN_PRIORITY = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

export const SESSION_END_REASONS = Object.freeze({
  USER_REQUEST: 'user_request',
  MAX_TURNS: 'max_turns',
  MAX_TOKENS: 'max_tokens',
  ERROR: 'error',
  TIMEOUT: 'timeout',
});

export const OUTGOING_MESSAGE_TYPES = Object.freeze({
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
});

export const NOTIFICATION_TYPES = Object.freeze({
  COMPLETED: 'completed',
  ERROR: 'error',
  PERMISSION: 'permission',
  INPUT_REQUIRED: 'input_required',
  BUDGET_WARNING: 'budget_warning',
});

export const DISPLAY_VERBOSITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

/**
 * This file intentionally exports only runtime-safe constants.
 * Structural type documentation now lives in JSDoc across the renderer modules.
 */
