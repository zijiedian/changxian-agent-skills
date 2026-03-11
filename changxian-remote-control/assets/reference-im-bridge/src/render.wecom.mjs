const WECOM_MESSAGE_LIMIT = 3600;
const THINKING_SPINNER_FRAMES = ['-', '\\', '|', '/'];
const THINKING_DETAIL_MAX_LINES = 2;
const THINKING_DETAIL_MAX_CHARS = 140;

function clipInline(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

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

function formatThinkingDetail(detail) {
  const lines = String(detail || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  const tail = lines.slice(-THINKING_DETAIL_MAX_LINES);
  const rendered = [];
  if (lines.length > tail.length) rendered.push('…');
  rendered.push(...tail.map((line) => `• ${clipInline(line, THINKING_DETAIL_MAX_CHARS)}`));
  return rendered.join('\n');
}

export function renderWeComPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = String(payload.status || 'Done');
    const marker = String(payload.marker || '').toLowerCase();
    const elapsedText = formatElapsedSeconds(payload.elapsedSeconds || 0);
    const preview = String(payload.text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    const previewLower = preview.toLowerCase();

    if (status === 'Running' && (marker === 'thinking' || previewLower === 'thinking...' || previewLower.startsWith('thinking\n') || !preview)) {
      const detail = preview.replace(/^thinking(?:\.\.\.)?/i, '').trim();
      const frame = THINKING_SPINNER_FRAMES[Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % THINKING_SPINNER_FRAMES.length];
      const dots = '.'.repeat((Math.floor((Number(payload.elapsedSeconds) || 0) * 2) % 3) + 1);
      const lines = [`${frame} Thinking${dots}`];
      const detailText = formatThinkingDetail(detail);
      if (detailText) lines.push(detailText);
      lines.push(elapsedText);
      return clipMessage(lines.join('\n'));
    }

    const body = preview || (status === 'Running' ? 'Thinking...' : '暂无输出');
    return clipMessage(status === 'Running' ? `${body}\n${elapsedText}` : body);
  }

  return clipMessage(String(payload || '').trim() || '暂无输出');
}