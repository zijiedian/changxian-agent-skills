import fs from 'node:fs';
import path from 'node:path';

const TELEGRAM_MESSAGE_LIMIT = 3900;
const THINKING_SPINNER_FRAMES = ['-', '\\', '|', '/'];
const THINKING_DETAIL_MAX_LINES = 2;
const THINKING_DETAIL_MAX_CHARS = 140;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((\/[^)\n]+?\.(?:png|jpe?g|webp|gif)(?:[#?][^)\n]+)?)\)/gi;
const MARKDOWN_IMAGE_LINK_RE = /\[([^\]]+)\]\((\/[^)\n]+?\.(?:png|jpe?g|webp|gif)(?:[#?][^)\n]+)?)\)/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clipInline(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function looksLikeTelegramHtml(text) {
  return /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|a|code|pre)(?:\s|>|$)/i.test(String(text || '').trim());
}

function normalizeLocalImagePath(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw.startsWith('/')) return '';
  return raw.replace(/[?#].*$/, '');
}

function buildMediaPlaceholder(filePath, label = '') {
  const fileName = path.basename(filePath);
  const caption = clipInline(label || fileName, 80);
  return `图片已发送: ${caption}`;
}

function collectMediaItem(images, seen, filePath, label = '') {
  const normalized = normalizeLocalImagePath(filePath);
  if (!normalized || !IMAGE_EXT_RE.test(normalized)) return null;
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  if (!seen.has(normalized)) {
    seen.add(normalized);
    images.push({ path: normalized, caption: clipInline(label || path.basename(normalized), 200) });
  }
  return buildMediaPlaceholder(normalized, label);
}

function extractTelegramMedia(text) {
  const images = [];
  const seen = new Set();
  let rendered = String(text || '');

  rendered = rendered.replace(MARKDOWN_IMAGE_RE, (_match, label, filePath) => {
    return collectMediaItem(images, seen, filePath, label) || _match;
  });
  rendered = rendered.replace(MARKDOWN_IMAGE_LINK_RE, (_match, label, filePath) => {
    return collectMediaItem(images, seen, filePath, label) || _match;
  });

  const lines = rendered.split(/\r?\n/).map((line) => {
    const stripped = line.trim().replace(/^[-*+]\s+/, '').replace(/^`([^`]+)`$/, '$1');
    const placeholder = collectMediaItem(images, seen, stripped, '');
    return placeholder && stripped === normalizeLocalImagePath(stripped) ? placeholder : line;
  });

  return {
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    images,
  };
}

function formatInline(text) {
  let rendered = String(text || '');
  const codeParts = [];
  const linkParts = [];

  rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `@@CODE${codeParts.length}@@`;
    codeParts.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+(?:\)[^)\s]+)*)\)/g, (_match, label, url) => {
    const token = `@@LINK${linkParts.length}@@`;
    linkParts.push(`<a href="${escapeHtml(url)}">${escapeHtml(label.trim())}</a>`);
    return token;
  });

  rendered = rendered.replace(BARE_URL_RE, (url) => {
    const token = `@@LINK${linkParts.length}@@`;
    linkParts.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    return token;
  });

  rendered = escapeHtml(rendered)
    .replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^\n_]+)__/g, '<u>$1</u>')
    .replace(/\*([^\n*]+)\*/g, '<i>$1</i>')
    .replace(/~~([^\n~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^\n|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');

  linkParts.forEach((snippet, index) => {
    rendered = rendered.replace(`@@LINK${index}@@`, snippet);
  });
  codeParts.forEach((snippet, index) => {
    rendered = rendered.replace(`@@CODE${index}@@`, snippet);
  });
  return rendered;
}

export function markdownToTelegramHtml(text) {
  if (!text) return '<i>暂无输出</i>';
  const lines = String(text).split(/\r?\n/);
  const htmlLines = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines = [];

  for (const line of lines) {
    if (inCodeBlock) {
      if (/^\s*`{3,}\s*$/.test(line)) {
        const codeBody = escapeHtml(codeLines.join('\n'));
        htmlLines.push(codeLanguage ? `<pre><code class="language-${escapeHtml(codeLanguage)}">${codeBody}</code></pre>` : `<pre>${codeBody}</pre>`);
        inCodeBlock = false;
        codeLanguage = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*`{3,}\s*([A-Za-z0-9_+-]+)?\s*$/);
    if (fence) {
      inCodeBlock = true;
      codeLanguage = fence[1] || '';
      continue;
    }

    const stripped = line.trim();
    if (!stripped) {
      htmlLines.push('');
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      htmlLines.push('———');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      htmlLines.push(`<b>${formatInline(heading[2].trim())}</b>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      htmlLines.push(`• ${formatInline(bullet[1].trim())}`);
      continue;
    }
    const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ordered) {
      htmlLines.push(`${ordered[1]}. ${formatInline(ordered[2].trim())}`);
      continue;
    }
    if (stripped.startsWith('>')) {
      htmlLines.push(`<i>${formatInline(stripped.replace(/^>\s*/, ''))}</i>`);
      continue;
    }
    htmlLines.push(formatInline(line));
  }

  if (codeLines.length) {
    const codeBody = escapeHtml(codeLines.join('\n'));
    htmlLines.push(codeLanguage ? `<pre><code class="language-${escapeHtml(codeLanguage)}">${codeBody}</code></pre>` : `<pre>${codeBody}</pre>`);
  }

  return htmlLines.join('\n').trim() || '<i>暂无输出</i>';
}

export function coerceTelegramHtml(text) {
  const stripped = String(text || '').trim();
  if (!stripped) return '<i>暂无输出</i>';
  if (looksLikeTelegramHtml(stripped)) return stripped;
  return markdownToTelegramHtml(stripped);
}

function formatElapsedSeconds(elapsedSeconds) {
  const total = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function appendElapsedFooter(bodyHtml, elapsedText, compact = false) {
  const footer = compact ? `<i><code>${elapsedText}</code></i>` : `<i>${elapsedText}</i>`;
  return bodyHtml.trim() ? `${bodyHtml}\n${footer}` : footer;
}

function formatThinkingDetailHtml(detail, compact = false) {
  const lines = String(detail || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const maxLines = compact ? 1 : THINKING_DETAIL_MAX_LINES;
  const maxChars = compact ? 90 : THINKING_DETAIL_MAX_CHARS;
  const tail = lines.slice(-maxLines);
  const rendered = [];
  if (lines.length > tail.length) rendered.push('<i>…</i>');
  rendered.push(...tail.map((line) => `• ${formatInline(clipInline(line, maxChars))}`));
  return rendered.join('\n');
}

export function renderTelegramPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = String(payload.status || 'Done');
    const marker = String(payload.marker || '').toLowerCase();
    const elapsedText = formatElapsedSeconds(payload.elapsedSeconds || 0);
    const media = status === 'Done' ? extractTelegramMedia(payload.text || '') : { text: String(payload.text || ''), images: [] };
    const preview = String(media.text || '').trim();
    const previewLower = preview.toLowerCase();

    if (status === 'Running' && (marker === 'thinking' || previewLower === 'thinking...' || previewLower.startsWith('thinking\n') || !preview)) {
      const detail = preview.replace(/^thinking(?:\.\.\.)?/i, '').trim();
      const frame = THINKING_SPINNER_FRAMES[Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % THINKING_SPINNER_FRAMES.length];
      const dots = '.'.repeat((Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % 3) + 1);
      const detailHtml = formatThinkingDetailHtml(detail);
      const body = detailHtml ? `<i>${escapeHtml(frame)} Thinking${dots}</i>\n${detailHtml}` : `<i>${escapeHtml(frame)} Thinking${dots}</i>`;
      return {
        html: appendElapsedFooter(body, elapsedText, true),
        images: [],
      };
    }

    const html = coerceTelegramHtml(preview || (status === 'Running' ? 'Thinking...' : '暂无输出'));
    const streamed = status === 'Running' ? appendElapsedFooter(html, elapsedText) : html;
    return {
      html: streamed.length <= TELEGRAM_MESSAGE_LIMIT ? streamed : `${streamed.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`,
      images: media.images,
    };
  }

  const media = extractTelegramMedia(payload || '');
  return {
    html: coerceTelegramHtml(media.text),
    images: media.images,
  };
}
