// ============================================================================
// Format Types - 渲染格式类型定义
// 参考 OpenACP/src/core/adapter-primitives/format-types.ts
// ============================================================================

/**
 * @typedef {'low' | 'medium' | 'high'} DisplayVerbosity
 */

/**
 * @typedef {'hide' | 'collapse'} NoiseAction
 */

/**
 * @typedef {Object} NoiseRule
 * @property {(name: string, kind: string, rawInput: unknown) => boolean} match
 * @property {NoiseAction} action
 */

/**
 * @typedef {'text' | 'thought' | 'tool' | 'plan' | 'usage' | 'system' | 'error' | 'attachment'} MessageStyle
 */

/**
 * @typedef {Object} ViewerLinks
 * @property {string} [file]
 * @property {string} [diff]
 */

/**
 * @typedef {Object} MessageMetadata
 * @property {string} [toolName]
 * @property {string} [toolStatus]
 * @property {string} [toolKind]
 * @property {string} [filePath]
 * @property {string} [command]
 * @property {Array<{content: string, status: string}>} [planEntries]
 * @property {number} [tokens]
 * @property {number} [contextSize]
 * @property {number} [cost]
 * @property {ViewerLinks} [viewerLinks]
 * @property {string} [viewerFilePath]
 */

/**
 * @typedef {Object} ToolCallMeta
 * @property {string} id
 * @property {string} name
 * @property {string} [kind]
 * @property {string} [status]
 * @property {unknown} [content]
 * @property {unknown} [rawInput]
 * @property {ViewerLinks} [viewerLinks]
 * @property {string} [viewerFilePath]
 * @property {string} [displaySummary]
 * @property {string} [displayTitle]
 * @property {string} [displayKind]
 */

/**
 * @typedef {Object} ToolUpdateMeta
 * @extends ToolCallMeta
 * @property {string} status
 */

// ============================================================================
// 常量导出
// ============================================================================

/** @type {Record<string, string>} */
export const STATUS_ICONS = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  cancelled: '🚫',
  running: '🔄',
  done: '✅',
  error: '❌',
};

/** @type {Record<string, string>} */
export const KIND_ICONS = {
  read: '📖',
  edit: '✏️',
  write: '✏️',
  delete: '🗑️',
  execute: '▶️',
  command: '▶️',
  bash: '▶️',
  terminal: '▶️',
  search: '🔍',
  web: '🌐',
  fetch: '🌐',
  agent: '🧠',
  think: '🧠',
  install: '📦',
  move: '📦',
  other: '🛠️',
};

export const DISPLAY_VERBOSITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};
