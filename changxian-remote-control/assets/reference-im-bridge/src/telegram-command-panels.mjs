import { InlineKeyboard } from 'grammy';
import { listSystemMcpServers, listSystemSkills } from './resource-registry.mjs';

function clipLabel(text, limit = 18) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function addScheduleButtons(keyboard, controller, chatId) {
  const jobs = controller.store.listJobs(chatId);
  if (!jobs.length) return null;
  for (const job of jobs) {
    keyboard
      .text(`▶ ${clipLabel(job.name || job.id, 10)}`, `rcctl:schedule:run:${job.id}`)
      .text(job.enabled ? '暂停' : '恢复', `rcctl:schedule:toggle:${job.id}`)
      .text('详情', `rcctl:schedule:show:${job.id}`)
      .row();
  }
  return keyboard;
}

function addRoleButtons(keyboard, controller, chatId) {
  const roles = controller.store.listRoles(chatId).slice(0, 6);
  if (!roles.length) return null;
  for (let index = 0; index < roles.length; index += 2) {
    const left = roles[index];
    const right = roles[index + 1];
    keyboard.text(clipLabel(left, 12), `rcctl:role:use:${left}`);
    if (right) keyboard.text(clipLabel(right, 12), `rcctl:role:use:${right}`);
    keyboard.row();
    keyboard.text(`看 ${clipLabel(left, 9)}`, `rcctl:role:show:${left}`);
    if (right) keyboard.text(`看 ${clipLabel(right, 9)}`, `rcctl:role:show:${right}`);
    keyboard.row();
  }
  keyboard.text('查看当前', `rcctl:role:show:${controller.activeRoleName(chatId) || 'reviewer'}`);
  keyboard.text('清除角色', 'rcctl:role:clear:active');
  return keyboard;
}

function addChannelButtons(keyboard, controller) {
  const publisher = controller.telegramChannelPublisher;
  const targets = publisher?.listTargets?.().slice(0, 6) || [];
  if (!targets.length) return null;
  for (let index = 0; index < targets.length; index += 2) {
    const left = targets[index];
    const right = targets[index + 1];
    keyboard
      .switchInlineCurrent(`预览 ${clipLabel(left.alias, 8)}`, `/channel preview ${left.alias} | `)
      .text(`测试 ${clipLabel(left.alias, 8)}`, `rcctl:channel:test:${left.alias}`);
    if (right) {
      keyboard
        .switchInlineCurrent(`发送 ${clipLabel(right.alias, 8)}`, `/channel send ${right.alias} | `)
        .text(`测试 ${clipLabel(right.alias, 8)}`, `rcctl:channel:test:${right.alias}`);
    }
    keyboard.row();
  }
  return keyboard;
}

function addMemoryButtons(keyboard, controller, chatId) {
  const memories = controller.store.listMemories(chatId, { limit: 4 }) || [];
  if (!memories.length) return null;
  for (const memory of memories) {
    const label = clipLabel(memory.title || memory.id, 10);
    keyboard
      .text(`看 ${label}`, `rcctl:memory:show:${memory.id}`)
      .text(memory.pinned ? '取消钉住' : '钉住', `rcctl:memory:pin:${memory.id}`)
      .text('删除', `rcctl:memory:delete:${memory.id}`)
      .row();
  }
  return keyboard;
}

function addSkillButtons(keyboard, options = {}) {
  const page = Math.max(0, Number(options.page) || 0);
  const pageSize = 4;
  const skills = listSystemSkills();
  const totalPages = Math.max(1, Math.ceil(skills.length / pageSize));
  const slice = skills.slice(page * pageSize, page * pageSize + pageSize);
  if (!slice.length) return null;
  for (const skill of slice) {
    const label = clipLabel(skill.name, 11);
    keyboard
      .text(`详情 ${label}`, `rcctl:skill:show:${page}|${skill.name}`)
      .text(skill.enabled ? '⚪ 停用' : '🟢 启用', `rcctl:skill:toggle:${page}|${skill.name}`)
      .row();
  }
  if (totalPages > 1) {
    if (page > 0) keyboard.text('◀ 上页', `rcctl:skill:page:${page - 1}`);
    keyboard.text(`${page + 1}/${totalPages}`, `rcnoop:skill:${page}`);
    if (page + 1 < totalPages) keyboard.text('下页 ▶', `rcctl:skill:page:${page + 1}`);
    keyboard.row();
  }
  return keyboard;
}

function addMcpButtons(keyboard, options = {}) {
  const page = Math.max(0, Number(options.page) || 0);
  const pageSize = 4;
  const servers = listSystemMcpServers();
  const totalPages = Math.max(1, Math.ceil(servers.length / pageSize));
  const slice = servers.slice(page * pageSize, page * pageSize + pageSize);
  if (!slice.length) return null;
  for (const server of slice) {
    const label = clipLabel(server.name, 11);
    keyboard
      .text(`详情 ${label}`, `rcctl:mcp:show:${page}|${server.name}`)
      .text(server.enabled ? '⚪ 停用' : '🟢 启用', `rcctl:mcp:toggle:${page}|${server.name}`)
      .row();
  }
  if (totalPages > 1) {
    if (page > 0) keyboard.text('◀ 上页', `rcctl:mcp:page:${page - 1}`);
    keyboard.text(`${page + 1}/${totalPages}`, `rcnoop:mcp:${page}`);
    if (page + 1 < totalPages) keyboard.text('下页 ▶', `rcctl:mcp:page:${page + 1}`);
    keyboard.row();
  }
  return keyboard;
}

export function buildCommandPanelKeyboard(controller, chatId, action, options = {}) {
  const normalized = String(action || '').trim().toLowerCase();
  const keyboard = new InlineKeyboard();

  if (normalized === 'schedule') return addScheduleButtons(keyboard, controller, chatId);
  if (normalized === 'role') return addRoleButtons(keyboard, controller, chatId);
  if (normalized === 'channel') return addChannelButtons(keyboard, controller);
  if (normalized === 'memory') return addMemoryButtons(keyboard, controller, chatId);
  if (normalized === 'skill') return addSkillButtons(keyboard, options);
  if (normalized === 'mcp') return addMcpButtons(keyboard, options);

  return undefined;
}
