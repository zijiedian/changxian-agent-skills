// ============================================================================
// Message Formatter - 消息格式化模块
// 参考 OpenACP/src/core/adapter-primitives/message-formatter.ts
// ============================================================================

import { STATUS_ICONS, KIND_ICONS } from './types.mjs';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 从任意内容中提取文本
 * @param {unknown} content
 * @param {number} [depth=0]
 * @returns {string}
 */
export function extractContentText(content, depth = 0) {
  if (!content || depth > 5) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => extractContentText(c, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content !== 'object') return String(content);

  const obj = /** @type {Record<string, unknown>} */ (content);
  if (obj.text && typeof obj.text === 'string') return obj.text;
  if (obj.content) {
    if (typeof obj.content === 'string') return obj.content;
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((c) => extractContentText(c, depth + 1))
        .filter(Boolean)
        .join('\n');
    }
    return extractContentText(obj.content, depth + 1);
  }
  if (obj.input) return extractContentText(obj.input, depth + 1);
  if (obj.output) return extractContentText(obj.output, depth + 1);

  const keys = Object.keys(obj).filter((k) => k !== 'type');
  if (keys.length === 0) return '';

  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return '';
  }
}

/**
 * 解析 rawInput 为对象
 * @param {unknown} rawInput
 * @returns {Record<string, unknown>}
 */
function parseRawInput(rawInput) {
  try {
    if (typeof rawInput === 'string') {
      return JSON.parse(rawInput);
    }
    if (typeof rawInput === 'object' && rawInput !== null) {
      return /** @type {Record<string, unknown>} */ (rawInput);
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * 格式化工具摘要（高详细度）
 * @param {string} name
 * @param {unknown} rawInput
 * @param {string} [displaySummary]
 * @returns {string}
 */
export function formatToolSummary(name, rawInput, displaySummary) {
  if (displaySummary && typeof displaySummary === 'string') {
    return displaySummary;
  }

  const args = parseRawInput(rawInput);
  const lowerName = name.toLowerCase();

  if (lowerName === 'read') {
    const fp = args.file_path ?? args.filePath ?? '';
    const limit = args.limit ? ` (${args.limit} lines)` : '';
    return fp ? `📖 Read ${fp}${limit}` : `🔧 ${name}`;
  }
  if (lowerName === 'edit') {
    const fp = args.file_path ?? args.filePath ?? '';
    return fp ? `✏️ Edit ${fp}` : `🔧 ${name}`;
  }
  if (lowerName === 'write') {
    const fp = args.file_path ?? args.filePath ?? '';
    return fp ? `📝 Write ${fp}` : `🔧 ${name}`;
  }
  if (lowerName === 'bash' || lowerName === 'terminal') {
    const cmd = String(args.command ?? args.cmd ?? '').slice(0, 60);
    return cmd ? `▶️ Run: ${cmd}` : `▶️ Terminal`;
  }
  if (lowerName === 'grep') {
    const pattern = args.pattern ?? '';
    const path = args.path ?? '';
    return pattern ? `🔍 Grep "${pattern}"${path ? ` in ${path}` : ''}` : `🔧 ${name}`;
  }
  if (lowerName === 'glob') {
    const pattern = args.pattern ?? '';
    return pattern ? `🔍 Glob ${pattern}` : `🔧 ${name}`;
  }
  if (lowerName === 'agent') {
    const desc = String(args.description ?? '').slice(0, 60);
    return desc ? `🧠 Agent: ${desc}` : `🔧 ${name}`;
  }
  if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
    const url = String(args.url ?? '').slice(0, 60);
    return url ? `🌐 Fetch ${url}` : `🔧 ${name}`;
  }
  if (lowerName === 'websearch' || lowerName === 'web_search') {
    const query = String(args.query ?? '').slice(0, 60);
    return query ? `🌐 Search "${query}"` : `🔧 ${name}`;
  }

  return `🔧 ${name}`;
}

/**
 * 格式化工具标题（低详细度）
 * @param {string} name
 * @param {unknown} rawInput
 * @param {string} [displayTitle]
 * @returns {string}
 */
export function formatToolTitle(name, rawInput, displayTitle) {
  if (displayTitle && typeof displayTitle === 'string') {
    return displayTitle;
  }

  const args = parseRawInput(rawInput);
  const lowerName = name.toLowerCase();

  if (['read', 'edit', 'write'].includes(lowerName)) {
    return String(args.file_path ?? args.filePath ?? name);
  }
  if (lowerName === 'bash' || lowerName === 'terminal') {
    return String(args.command ?? args.cmd ?? name).slice(0, 60);
  }
  if (lowerName === 'grep') {
    const pattern = args.pattern ?? '';
    const path = args.path ?? '';
    return pattern ? `"${pattern}"${path ? ` in ${path}` : ''}` : name;
  }
  if (lowerName === 'glob') {
    return String(args.pattern ?? name);
  }
  if (lowerName === 'agent') {
    return String(args.description ?? name).slice(0, 60);
  }
  if (['webfetch', 'web_fetch'].includes(lowerName)) {
    return String(args.url ?? name).slice(0, 60);
  }
  if (['websearch', 'web_search'].includes(lowerName)) {
    return String(args.query ?? name).slice(0, 60);
  }

  return name;
}

/**
 * 解析工具图标
 * @param {{ status?: string, displayKind?: string, kind?: string }} tool
 * @returns {string}
 */
export function resolveToolIcon(tool) {
  const statusIcon = STATUS_ICONS[tool.status || ''];
  if (statusIcon) return statusIcon;
  const kind = tool.displayKind ?? tool.kind;
  if (kind && KIND_ICONS[kind]) return KIND_ICONS[kind];
  return '🔧';
}

// ============================================================================
// 噪音过滤规则
// ============================================================================

/**
 * @typedef {'hide' | 'collapse'} NoiseAction
 */

/**
 * @typedef {Object} NoiseRule
 * @property {(name: string, kind: string, rawInput: unknown) => boolean} match
 * @property {NoiseAction} action
 */

/** @type {NoiseRule[]} */
const NOISE_RULES = [
  {
    match: (name) => name.toLowerCase() === 'ls',
    action: 'hide',
  },
  {
    match: (_, kind, rawInput) => {
      if (kind !== 'read') return false;
      const args = parseRawInput(rawInput);
      const p = String(args.file_path ?? args.filePath ?? args.path ?? '');
      return p.endsWith('/');
    },
    action: 'hide',
  },
  {
    match: (name) => name.toLowerCase() === 'glob',
    action: 'hide',
  },
  {
    match: (name) => name.toLowerCase() === 'grep',
    action: 'hide',
  },
];

/**
 * 评估工具调用是否应该被噪音过滤
 * @param {string} name
 * @param {string} kind
 * @param {unknown} rawInput
 * @returns {NoiseAction | null}
 */
export function evaluateNoise(name, kind, rawInput) {
  for (const rule of NOISE_RULES) {
    if (rule.match(name, kind, rawInput)) return rule.action;
  }
  return null;
}
