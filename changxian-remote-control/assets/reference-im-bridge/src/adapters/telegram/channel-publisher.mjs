import { InputFile } from 'grammy';
import { renderTelegramPayload } from '../../render/telegram.mjs';

export function parseTelegramChannelTargets(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid TG_CHANNEL_TARGETS JSON: ${error.message || error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TG_CHANNEL_TARGETS must be a JSON object mapping alias to target');
  }
  const entries = Object.entries(parsed).map(([alias, target]) => [String(alias).trim(), String(target || '').trim()]);
  const result = {};
  for (const [alias, target] of entries) {
    if (!alias || !/^[a-z0-9][a-z0-9-_]{0,62}$/i.test(alias)) {
      throw new Error(`invalid telegram channel alias: ${alias || '(empty)'}`);
    }
    if (!target || (!target.startsWith('@') && !/^-100\d+$/.test(target))) {
      throw new Error(`invalid telegram channel target for alias ${alias}`);
    }
    result[alias] = target;
  }
  return result;
}

export function normalizeTelegramChannelAllowlist(raw) {
  const text = String(raw || '').trim();
  if (!text) return new Set();
  return new Set(
    text
      .split(',')
      .map((part) => String(part || '').trim())
      .filter(Boolean)
  );
}

export function parseChannelCommandInput(raw) {
  const text = String(raw || '').trim();
  const divider = text.indexOf('|');
  if (divider < 0) {
    throw new Error('usage: <alias> | <content>');
  }
  const alias = text.slice(0, divider).trim();
  const content = text.slice(divider + 1).trim();
  if (!alias || !content) {
    throw new Error('usage: <alias> | <content>');
  }
  return { alias, content };
}

function ensureOperatorAllowed(allowlist, operatorId) {
  if (!allowlist?.size) return;
  const id = String(operatorId || '').trim();
  if (!id || !allowlist.has(id)) {
    throw new Error('operator not allowed to publish to telegram channels');
  }
}

function resolveAlias(config, alias) {
  const name = String(alias || '').trim() || String(config.tgDefaultChannel || '').trim();
  if (!name) throw new Error('channel alias is required');
  const target = config.tgChannelTargets?.[name];
  if (!target) throw new Error(`unknown telegram channel alias: ${name}`);
  return { alias: name, target };
}

async function publishRendered(bot, target, rendered) {
  const messages = [];
  const pages = rendered.pages?.length ? rendered.pages : [rendered.html];
  for (const page of pages) {
    const message = await bot.api.sendMessage(target, page, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    messages.push({ type: 'message', messageId: message?.message_id || 0 });
  }
  for (const image of rendered.images || []) {
    const photo = await bot.api.sendPhoto(target, new InputFile(image.path), {
      caption: image.caption || undefined,
    });
    messages.push({ type: 'photo', messageId: photo?.message_id || 0 });
  }
  return messages;
}

export function createTelegramChannelPublisher({ bot, config }) {
  return {
    listTargets() {
      return Object.entries(config.tgChannelTargets || {}).map(([alias, target]) => ({ alias, target }));
    },
    async preview({ alias, payload, operatorId }) {
      ensureOperatorAllowed(config.tgChannelAllowedOperatorIds, operatorId);
      const resolved = resolveAlias(config, alias);
      const rendered = renderTelegramPayload(payload);
      const pages = rendered.pages?.length ? rendered.pages : [rendered.html];
      return {
        alias: resolved.alias,
        target: resolved.target,
        pages,
        images: rendered.images || [],
        html: pages[0] || '<i>暂无输出</i>',
      };
    },
    async send({ alias, payload, operatorId }) {
      ensureOperatorAllowed(config.tgChannelAllowedOperatorIds, operatorId);
      const resolved = resolveAlias(config, alias);
      const rendered = renderTelegramPayload(payload);
      const published = await publishRendered(bot, resolved.target, rendered);
      return {
        alias: resolved.alias,
        target: resolved.target,
        published,
      };
    },
    async test({ alias, operatorId }) {
      ensureOperatorAllowed(config.tgChannelAllowedOperatorIds, operatorId);
      const resolved = resolveAlias(config, alias);
      const message = await bot.api.sendMessage(resolved.target, '<b>频道发布测试成功</b>', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return {
        alias: resolved.alias,
        target: resolved.target,
        messageId: message?.message_id || 0,
      };
    },
  };
}
