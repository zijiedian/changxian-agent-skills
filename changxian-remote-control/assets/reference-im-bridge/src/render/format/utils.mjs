// ============================================================================
// Format Utils - 格式化工具函数
// 参考 OpenACP/src/core/adapter-primitives/format-utils.ts
// ============================================================================

/**
 * 格式化 token 数量
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

/**
 * 生成进度条
 * @param {number} ratio 0-1
 * @param {number} [width=20]
 * @returns {string}
 */
export function progressBar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * 截断内容
 * @param {string} content
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateContent(content, maxLen) {
  const stripped = String(content || '').replace(/\s+/g, ' ').trim();
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...';
}

/**
 * 去除代码块围栏
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * 分割消息
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
export function splitMessage(text, maxLength = 3800) {
  if (!text || text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';

  const lines = text.split('\n');
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
