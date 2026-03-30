import {
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  previewHasProgressDetails,
  truncateText,
} from '../utils/utils.mjs';
import {
  TelegramRenderer,
  markdownToTelegramHtml,
  coerceTelegramHtml,
} from './telegram-renderer.mjs';

const renderer = new TelegramRenderer();

export function renderTelegramPayload(payload) {
  return renderer.renderLegacyPayload(payload);
}

export {
  buildPreviewSummaryMarkdown,
  buildStructuredPreview,
  previewHasProgressDetails,
  truncateText,
  markdownToTelegramHtml,
  coerceTelegramHtml,
};
