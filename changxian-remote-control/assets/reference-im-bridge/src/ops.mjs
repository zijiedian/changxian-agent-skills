export const OPS_TAGS = {
  role: ['rc-role-ops', 'tg-role-ops'],
  memory: ['rc-memory-ops', 'tg-memory-ops'],
  schedule: ['rc-schedule-ops', 'tg-schedule-ops']
};

function compile(tags) {
  return new RegExp('```(?:' + tags.join('|') + ')\\s*([\\s\\S]*?)```', 'ig');
}

export const OPS_RES = {
  role: compile(OPS_TAGS.role),
  memory: compile(OPS_TAGS.memory),
  schedule: compile(OPS_TAGS.schedule)
};

export function extractOps(regex, text) {
  const payloads = [];
  const stripped = String(text || '').replace(regex, (_, payload) => {
    if (payload && String(payload).trim()) payloads.push(String(payload).trim());
    return '';
  }).trim();
  const ops = [];
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      const rawOps = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ops) ? parsed.ops : [];
      for (const op of rawOps) if (op && typeof op === 'object') ops.push(op);
    } catch {}
  }
  return { ops, stripped };
}
