import fs from 'node:fs';
import path from 'node:path';
import {
  buildPreviewDiffMarkdown,
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  sanitizePreview,
  splitMarkdownPages,
} from './utils.mjs';

const TELEGRAM_MESSAGE_LIMIT = 3900;
const TELEGRAM_FINAL_PAGE_LIMIT = 1400;
const THINKING_SPINNER_FRAMES = ['-', '\\', '|', '/'];
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((\/[^)\n]+?\.(?:png|jpe?g|webp|gif)(?:[#?][^)\n]+)?)\)/gi;
const MARKDOWN_IMAGE_LINK_RE = /\[([^\]]+)\]\((\/[^)\n]+?\.(?:png|jpe?g|webp|gif)(?:[#?][^)\n]+)?)\)/gi;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\n]+(?:\)[^)\n]+)*)\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;
const TELEGRAM_HTML_TAG_RE = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|a|code|pre)(?:\s+[^<>]*?)?>/gi;
const MARKDOWN_SIGNAL_RE = /(^|\n)\s*`{3,}|!\[[^\]]*\]\([^)\n]+\)|\[[^\]]*\]\([^)\n]+\)|(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\|\|[^|\n]+\|\|/m;

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
  const value = String(text || '').trim();
  if (!value || MARKDOWN_SIGNAL_RE.test(value)) return false;
  const matchedTags = value.match(TELEGRAM_HTML_TAG_RE);
  if (!matchedTags?.length) return false;
  const withoutKnownTags = value.replace(TELEGRAM_HTML_TAG_RE, '');
  return !/[<>]/.test(withoutKnownTags);
}

function normalizeTelegramHref(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  if (/^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(raw)) return raw;
  return '';
}

function resolveMarkdownLinkLabel(label, target) {
  const normalizedLabel = String(label || '').trim();
  const normalizedTarget = String(target || '').trim();
  if (normalizedLabel && normalizedLabel !== normalizedTarget) return normalizedLabel;
  return '打开链接';
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

  rendered = rendered.replace(MARKDOWN_LINK_RE, (match, label, target, offset, source) => {
    if (offset > 0 && source[offset - 1] === '!') {
      return match;
    }

    const visibleLabel = resolveMarkdownLinkLabel(label, target);
    const href = normalizeTelegramHref(target);
    const token = `@@LINK${linkParts.length}@@`;
    linkParts.push(href ? `<a href="${escapeHtml(href)}">${escapeHtml(visibleLabel)}</a>` : escapeHtml(visibleLabel));
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

function labelPages(pages) {
  if (pages.length <= 1) return pages;
  return pages.map((page, index) => `第 ${index + 1}/${pages.length} 页\n\n${page}`);
}

function buildTelegramPages(text) {
  let pages = splitMarkdownPages(text, TELEGRAM_FINAL_PAGE_LIMIT);

  let changed = true;
  while (changed) {
    changed = false;
    const nextPages = [];
    for (const page of pages) {
      const html = coerceTelegramHtml(page);
      if (html.length <= TELEGRAM_MESSAGE_LIMIT || page.length <= 240) {
        nextPages.push(page);
        continue;
      }
      const nextLimit = Math.max(240, Math.floor(page.length * 0.75));
      nextPages.push(...splitMarkdownPages(page, nextLimit));
      changed = true;
    }
    pages = nextPages;
  }

  return labelPages(pages).map((page) => coerceTelegramHtml(page));
}

function resolvePreviewModel(payload) {
  if (payload?.preview && typeof payload.preview === 'object' && !Array.isArray(payload.preview)) {
    return payload.preview;
  }
  const status = String(payload?.status || 'Done');
  const marker = String(payload?.marker || 'assistant').toLowerCase();
  return buildStructuredPreview(payload?.text || '', { status, marker });
}

function progressHeading(preview) {
  if (preview.phase === 'diff') return '正在整理变更';
  if (preview.phase === 'research') return '正在检索资料';
  if (preview.phase === 'exec') return '正在执行';
  return '正在处理';
}

function buildTelegramStructuredPages(preview) {
  const pages = [];
  const narrative = String(preview.proseMarkdown || '').trim();
  if (narrative) {
    pages.push(...splitMarkdownPages(narrative, TELEGRAM_FINAL_PAGE_LIMIT));
  } else {
    const summary = buildPreviewSummaryMarkdown(preview, {
      maxHighlights: 8,
      maxChecks: 6,
      maxFiles: 8,
      maxNotes: 4,
      includeDiffHint: true,
    });
    if (summary) pages.push(...splitMarkdownPages(summary, TELEGRAM_FINAL_PAGE_LIMIT));
  }

  const diff = buildPreviewDiffMarkdown(preview, {
    heading: '**变更节选**',
    maxFiles: 2,
    maxHunksPerFile: 2,
    maxLinesPerHunk: 6,
    maxLinesPerFile: 20,
    maxTotalLines: 48,
  });
  if (diff) pages.push(...splitMarkdownPages(diff, TELEGRAM_FINAL_PAGE_LIMIT));

  const normalizedPages = labelPages(pages.length ? pages : ['暂无输出']);
  return normalizedPages.map((page) => coerceTelegramHtml(page));
}

export function renderTelegramPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = String(payload.status || 'Done');
    const marker = String(payload.marker || '').toLowerCase();
    const elapsedText = formatElapsedSeconds(payload.elapsedSeconds || 0);
    const previewModel = resolvePreviewModel(payload);
    const sourceText = previewModel.content || payload.text || '';
    const normalizedText = sanitizePreview(sourceText, status);
    const media = status === 'Done' ? extractTelegramMedia(normalizedText) : { text: normalizedText, images: [] };
    const preview = String(previewModel.content || media.text || '').trim();
    const previewLower = preview.toLowerCase();

    if (status === 'Running' && (marker === 'thinking' || previewLower === 'thinking...' || previewLower.startsWith('thinking\n') || !preview)) {
      const frame = THINKING_SPINNER_FRAMES[Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % THINKING_SPINNER_FRAMES.length];
      const dots = '.'.repeat((Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % 3) + 1);
      const body = `<i>${escapeHtml(frame)} Thinking${dots}</i>`;
      const html = appendElapsedFooter(body, elapsedText, true);
      return {
        html,
        pages: [html],
        images: [],
      };
    }

    if (status === 'Done') {
      const pages = buildTelegramStructuredPages(previewModel);
      return {
        html: pages[0] || '<i>暂无输出</i>',
        pages,
        images: media.images,
      };
    }

    const progressMarkdown = buildPreviewSummaryMarkdown(previewModel, {
      heading: progressHeading(previewModel),
      maxHighlights: 2,
      maxChecks: 1,
      maxFiles: 3,
      maxNotes: 0,
      includeDiffHint: previewModel.phase === 'diff',
    }) || preview || 'Thinking...';
    const html = coerceTelegramHtml(progressMarkdown);
    const streamed = appendElapsedFooter(html, elapsedText);
    return {
      html: streamed.length <= TELEGRAM_MESSAGE_LIMIT ? streamed : `${streamed.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`,
      pages: [streamed.length <= TELEGRAM_MESSAGE_LIMIT ? streamed : `${streamed.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`],
      images: media.images,
    };
  }

  const previewModel = buildStructuredPreview(String(payload || ''), { status: 'Done', marker: 'assistant' });
  const media = extractTelegramMedia(sanitizePreview(previewModel.content || payload || '', 'Done'));
  const pages = buildTelegramStructuredPages(previewModel);
  return {
    html: pages[0] || '<i>暂无输出</i>',
    pages,
    images: media.images,
  };
}
