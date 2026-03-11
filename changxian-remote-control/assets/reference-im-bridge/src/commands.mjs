export const COMMAND_SPECS = [
  { name: 'start', menuDescription: 'Show help and available commands', help: '/start show help and available commands', aliases: ['help'] },
  { name: 'run', menuDescription: 'Execute a prompt', help: '/run <prompt> execute a prompt' },
  { name: 'new', menuDescription: 'Start a fresh Codex session', help: '/new start a fresh Codex session' },
  { name: 'cwd', menuDescription: 'Show or change working directory', help: '/cwd show or change working directory' },
  { name: 'skill', menuDescription: 'List installed Codex skills', help: '/skill list installed Codex skills' },
  { name: 'status', menuDescription: 'Show current task status', help: '/status show current task status' },
  { name: 'cancel', menuDescription: 'Stop current task', help: '/cancel stop current task' },
  { name: 'id', menuDescription: 'Show current chat/user id', help: '/id show current chat/user id' },
  { name: 'auth', menuDescription: 'Unlock execution', help: '/auth <passphrase> unlock execution' },
  { name: 'cmd', menuDescription: 'Show or update command prefix', help: '/cmd show or update command prefix' },
  { name: 'setting', menuDescription: 'Show or update bridge settings', help: '/setting show or update runtime settings' },
  { name: 'backend', menuDescription: 'Switch between Codex and OpenCode', help: '/backend codex|opencode switch execution backend' },
  { name: 'memory', menuDescription: 'Show or manage saved memory', help: '/memory inspect or manage saved memory' },
  { name: 'role', menuDescription: 'Show or manage chat roles', help: '/role inspect or manage chat roles' },
  { name: 'schedule', menuDescription: 'Show or manage scheduled jobs', help: '/schedule inspect or manage scheduled jobs' }
];

export const COMMAND_INDEX = new Map();
for (const spec of COMMAND_SPECS) {
  COMMAND_INDEX.set(spec.name, spec);
  for (const alias of spec.aliases || []) {
    COMMAND_INDEX.set(alias, spec);
  }
}

export function resolveCommand(name) {
  return COMMAND_INDEX.get(String(name || '').trim().toLowerCase()) || null;
}

export function helpLines() {
  return COMMAND_SPECS.map((spec) => `- ${spec.help}`);
}
