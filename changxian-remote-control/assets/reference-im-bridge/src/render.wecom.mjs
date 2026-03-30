import { WeComRenderer } from './render/wecom-renderer.mjs';

const renderer = new WeComRenderer();

export function renderWeComPayload(payload) {
  return renderer.renderLegacyPayload(payload);
}
