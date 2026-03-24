import {
  buildDetailedProgressMarkdown,
  buildPreviewDiffMarkdown,
  previewHasProgressDetails,
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  sanitizePreview,
  splitMarkdownPages,
} from './utils.mjs';

const WECOM_MESSAGE_LIMIT = 3600;
const WECOM_FINAL_PAGE_LIMIT = 3200;
const THINKING_SPINNER_FRAMES = ['-', '\\', '|', '/'];

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

function labelPages(pages) {
  return pages;
}

function buildWeComPages(text) {
  return labelPages(splitMarkdownPages(text, WECOM_FINAL_PAGE_LIMIT));
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

function buildWeComProgressContent(preview, elapsedText) {
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
  lines.push(elapsedText);
  return clipMessage(lines.filter(Boolean).join('\n'));
}

function buildWeComStructuredPages(preview) {
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

  return labelPages(pages.length ? pages : ['暂无输出']);
}

export function renderWeComPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = String(payload.status || 'Done');
    const marker = String(payload.marker || '').toLowerCase();
    const elapsedText = formatElapsedSeconds(payload.elapsedSeconds || 0);
    const previewModel = resolvePreviewModel(payload);
    const preview = sanitizePreview(previewModel.content || payload.text || '', status)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    const previewLower = preview.toLowerCase();
    const hasProgressDetails = previewHasProgressDetails(previewModel);

    if (status === 'Running' && (!hasProgressDetails && (marker === 'thinking' || previewLower === 'thinking...' || previewLower.startsWith('thinking\n') || !preview))) {
      const tick = Math.floor(Number(payload.elapsedSeconds) || 0);
      const frame = THINKING_SPINNER_FRAMES[tick % THINKING_SPINNER_FRAMES.length];
      const dots = '.'.repeat((tick % 3) + 1);
      const lines = [`${frame} Thinking${dots}`];
      lines.push(`用时 ${elapsedText}`);
      const content = clipMessage(lines.join('\n'));
      return { content, pages: [content] };
    }

    if (status === 'Done') {
      const pages = buildWeComStructuredPages(previewModel);
      return {
        content: pages[0] || '暂无输出',
        pages,
      };
    }

    const content = buildWeComProgressContent(previewModel, elapsedText);
    return { content, pages: [content] };
  }

  const previewModel = buildStructuredPreview(String(payload || ''), { status: 'Done', marker: 'assistant' });
  const pages = buildWeComStructuredPages(previewModel);
  return {
    content: pages[0] || '暂无输出',
    pages,
  };
}
