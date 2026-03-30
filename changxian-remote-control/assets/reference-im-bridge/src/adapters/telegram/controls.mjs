import { InlineKeyboard } from 'grammy';
import { BACKEND_CLAUDE, BACKEND_CODEX, BACKEND_OPENCODE_ACP, BACKEND_PI } from '../../utils/backend-detection.mjs';

function selectedButtonLabel(label, selected) {
  return selected ? `● ${label}` : label;
}

export function buildRuntimeControlKeyboard(controller, chatId) {
  const controls = controller.runtimeControlState(chatId);
  const keyboard = new InlineKeyboard();

  keyboard
    .text(selectedButtonLabel('Codex', controls.backend === BACKEND_CODEX), 'rcctl:backend:codex')
    .text(selectedButtonLabel('Claude', controls.backend === BACKEND_CLAUDE), 'rcctl:backend:claude')
    .text(selectedButtonLabel('OpenCode', controls.backend === BACKEND_OPENCODE_ACP), 'rcctl:backend:opencode-acp')
    .text(selectedButtonLabel('Pi', controls.backend === BACKEND_PI), 'rcctl:backend:pi')
    .row();

  if (controls.permissionKind === 'codex' || controls.permissionKind === 'claude') {
    controls.permissionOptions.forEach((option, index) => {
      keyboard.text(selectedButtonLabel(option.label, option.value === controls.permissionLevel), `rcctl:perm:${option.value}`);
      if (index + 1 < controls.permissionOptions.length) return;
      keyboard.row();
    });
  } else {
    keyboard.text(`权限: ${controls.permissionLabel}`, 'rcctl:refresh:status').row();
  }

  keyboard
    .text('状态', 'rcctl:refresh:status')
    .text('新会话', 'rcctl:session:new')
    .text('停止', 'rcctl:cmd:cancel')
    .row()
    .text('设置', 'rcctl:cmd:setting')
    .text('CLI', 'rcctl:cmd:cli')
    .text('技能', 'rcctl:cmd:skill')
    .row()
    .text('MCP', 'rcctl:cmd:mcp')
    .text('日程', 'rcctl:cmd:schedule')
    .text('频道', 'rcctl:cmd:channel')
    .row()
    .text('更新 CLI', 'rcctl:cli:update')
    .text('角色', 'rcctl:cmd:role')
    .text('记忆', 'rcctl:cmd:memory');

  return keyboard;
}
