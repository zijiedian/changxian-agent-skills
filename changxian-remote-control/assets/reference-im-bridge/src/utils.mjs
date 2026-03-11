const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONFIG_CONTEXT_NOISE_RE = /^(?:workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|mcp startup:)/i;
const SENSITIVE_OPTION_RE = /(token|secret|passphrase|password|authorization|auth|api[-_]?key|cookie|session|bearer)/i;
const LONG_SECRET_RE = /^[A-Za-z0-9_\-]{24,}$/;
const TRACE_MARKERS = new Set(['assistant', 'codex', 'thinking', 'exec', 'user']);
const TRACE_SKIP_SECTION_MARKERS = new Set(['user']);
const INTERNAL_RUNTIME_NOISE_PATTERNS = [
  /apply_patch was requested via exec_command/i,
  /use the apply_patch tool instead of exec_command/i,
  /codex_core::shell_snapshot|failed to delete shell snapshot/i,
];
const PREVIEW_NOISE_PATTERNS = [
  /^openai codex v/i,
  /^(?:model|provider|approval|sandbox|workdir|reasoning effort|reasoning summaries):/i,
  /^session id:/i,
  /^(?:user|assistant|codex|thinking|exec)$/i,
  /^mcp startup:/i,
  /^tokens used$/i,
  /^total cost/i,
  /^system info/i,
  /^-{3,}$/,
  ...INTERNAL_RUNTIME_NOISE_PATTERNS,
];
const MARKDOWN_FENCE_RE = /^\s*```/;
const MARKDOWN_FENCE_CLOSE_RE = /^\s*`{3,}\s*$/;
const DIFF_HEADER_RE = /^(?:diff --git |index |--- |\+\+\+ |@@|new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/;
const CODE_INDENT_RE = /^\s{4,}\S/;
const CODE_KEYWORD_RE = /^\s*(?:async\s+def|def|class|if|elif|else|for|while|try|except|finally|return|import|from|function|const|let|var|public|private|protected|package|func|type|interface|switch|case|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/;
const SHELL_PROMPT_RE = /^\s*(?:\$|#)\s+\S+/;
const PATCH_BEGIN_MARKER = '*** Begin Patch';
const PATCH_END_MARKER = '*** End Patch';
const PATCH_UPDATE_PREFIX = '*** Update File: ';
const PATCH_ADD_PREFIX = '*** Add File: ';
const PATCH_DELETE_PREFIX = '*** Delete File: ';
const PATCH_MOVE_PREFIX = '*** Move to: ';
const PATCH_END_OF_FILE_MARKER = '*** End of File';

export function truncateText(text, limit = 120) {
  const stripped = String(text || '').replace(/\s+/g, ' ').trim();
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, Math.max(0, limit - 3)).trimEnd() + '...';
}

function isInternalRuntimeNoiseLine(line) {
  const stripped = String(line || '').trim();
  if (!stripped) return false;
  return INTERNAL_RUNTIME_NOISE_PATTERNS.some((pattern) => pattern.test(stripped));
}

export function cleanOutput(output) {
  const text = String(output || '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x00/g, '');
  const compact = [];
  let previous = null;
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (CONFIG_CONTEXT_NOISE_RE.test(stripped)) continue;
    if (isInternalRuntimeNoiseLine(stripped)) continue;
    if (line === previous) continue;
    compact.push(line);
    previous = line;
  }
  return compact.join('\n').trim();
}

function normalizeTraceMarker(line) {
  const stripped = String(line || '').trim().toLowerCase();
  if (!stripped) return null;

  const candidate = stripped.replace(/:+$/, '');
  if (TRACE_MARKERS.has(candidate)) return candidate;

  for (const prefix of ['role:', 'section:', 'trace:', 'tool:']) {
    if (!stripped.startsWith(prefix)) continue;
    const nested = stripped.slice(prefix.length).trim().replace(/:+$/, '');
    if (TRACE_MARKERS.has(nested)) return nested;
  }

  if (stripped.startsWith('[') && stripped.includes(']')) {
    const nested = stripped.split(']', 2)[1].trim().replace(/:+$/, '');
    if (TRACE_MARKERS.has(nested)) return nested;
  }

  return null;
}

function isPreviewNoiseLine(line) {
  const stripped = String(line || '').trim();
  if (!stripped) return false;
  return PREVIEW_NOISE_PATTERNS.some((pattern) => pattern.test(stripped));
}

function parseTraceSections(lines) {
  const sections = [];
  let currentMarker = null;
  let currentLines = [];

  for (const line of lines) {
    const marker = normalizeTraceMarker(line);
    if (marker !== null) {
      if (currentMarker && currentLines.length) {
        sections.push({ marker: currentMarker, content: currentLines.join('\n').trim() });
      }
      currentMarker = marker;
      currentLines = [];
      continue;
    }

    if (currentMarker === null) continue;

    if (String(line || '').trim().toLowerCase().startsWith('tokens used')) {
      if (currentLines.length) {
        sections.push({ marker: currentMarker, content: currentLines.join('\n').trim() });
      }
      currentMarker = null;
      currentLines = [];
      continue;
    }

    if (isPreviewNoiseLine(line)) continue;
    currentLines.push(line);
  }

  if (currentMarker && currentLines.length) {
    sections.push({ marker: currentMarker, content: currentLines.join('\n').trim() });
  }
  return sections;
}

function latestSection(sections, markers) {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (markers.has(section.marker) && section.content) return section;
  }
  return null;
}

function stripThinkingEchoLines(content) {
  return String(content || '')
    .split('\n')
    .filter((line) => !['thinking', 'thinking...'].includes(line.trim().toLowerCase()))
    .join('\n')
    .trim();
}

function patchHeaderLines(oldPath, newPath) {
  const oldRef = oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`;
  const newRef = newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`;
  return [
    `diff --git ${oldRef} ${newRef}`,
    `--- ${oldRef}`,
    `+++ ${newRef}`,
  ];
}

function looksLikeUnfencedDiff(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return false;
  let sawHeader = false;
  let sawHunk = false;
  let sawChange = false;

  for (const line of lines) {
    const stripped = line.trim();
    if (DIFF_HEADER_RE.test(stripped)) {
      sawHeader = true;
      if (stripped.startsWith('@@')) sawHunk = true;
      continue;
    }
    if (line.startsWith((' ', '+', '-'))) {
      sawChange = true;
      continue;
    }
    if (sawHunk && (line.startsWith('    ') || line.startsWith('\t'))) {
      sawChange = true;
      continue;
    }
    return false;
  }

  return sawChange && (sawHeader || sawHunk);
}

function convertApplyPatchBlock(lines) {
  const output = ['```diff'];
  let index = 0;
  let hasDiffContent = false;

  while (index < lines.length) {
    const stripped = lines[index].trim();
    let oldPath = null;
    let newPath = null;

    if (stripped.startsWith(PATCH_UPDATE_PREFIX)) {
      oldPath = stripped.slice(PATCH_UPDATE_PREFIX.length).trim();
      newPath = oldPath;
      index += 1;
      if (index < lines.length && lines[index].trim().startsWith(PATCH_MOVE_PREFIX)) {
        newPath = lines[index].trim().slice(PATCH_MOVE_PREFIX.length).trim() || oldPath;
        index += 1;
      }
    } else if (stripped.startsWith(PATCH_ADD_PREFIX)) {
      newPath = stripped.slice(PATCH_ADD_PREFIX.length).trim();
      oldPath = '/dev/null';
      index += 1;
    } else if (stripped.startsWith(PATCH_DELETE_PREFIX)) {
      oldPath = stripped.slice(PATCH_DELETE_PREFIX.length).trim();
      newPath = '/dev/null';
      index += 1;
    } else {
      index += 1;
      continue;
    }

    if (!oldPath || !newPath) continue;

    hasDiffContent = true;
    if (output.length > 1) output.push('');
    output.push(...patchHeaderLines(oldPath, newPath));

    while (index < lines.length) {
      const bodyLine = lines[index];
      const bodyStripped = bodyLine.trim();
      if (bodyStripped.startsWith(PATCH_UPDATE_PREFIX) || bodyStripped.startsWith(PATCH_ADD_PREFIX) || bodyStripped.startsWith(PATCH_DELETE_PREFIX)) break;
      if (bodyStripped === PATCH_END_OF_FILE_MARKER) {
        index += 1;
        continue;
      }
      if (/^[@ +\-]/.test(bodyLine)) output.push(bodyLine);
      index += 1;
    }
  }

  output.push('```');
  return hasDiffContent ? output : [];
}

function convertApplyPatchSections(text) {
  if (!String(text || '').includes(PATCH_BEGIN_MARKER)) return String(text || '').trim();
  const lines = String(text || '').split('\n');
  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() !== PATCH_BEGIN_MARKER) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    index += 1;
    const patchLines = [];
    while (index < lines.length && lines[index].trim() !== PATCH_END_MARKER) {
      patchLines.push(lines[index]);
      index += 1;
    }
    if (index < lines.length && lines[index].trim() === PATCH_END_MARKER) index += 1;

    const converted = convertApplyPatchBlock(patchLines);
    if (converted.length) {
      output.push(...converted);
    } else {
      output.push(PATCH_BEGIN_MARKER, ...patchLines, PATCH_END_MARKER);
    }
  }
  return output.join('\n').trim();
}

function retagFencedDiffBlocks(text) {
  const normalized = String(text || '').trim();
  if (!normalized || !normalized.includes('```')) return normalized;

  const lines = normalized.split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!MARKDOWN_FENCE_RE.test(line)) {
      output.push(line);
      index += 1;
      continue;
    }

    let opening = line.trim();
    const body = [];
    index += 1;
    while (index < lines.length && !MARKDOWN_FENCE_RE.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    const closing = index < lines.length ? lines[index] : '```';
    if (index < lines.length) index += 1;

    if (looksLikeUnfencedDiff(body.join('\n').trim())) opening = '```diff';
    output.push(opening, ...body, closing);
  }

  return output.join('\n').trim();
}

function fenceEmbeddedDiffBlocks(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return normalized;

  const lines = normalized.split('\n');
  const output = [];
  let index = 0;
  let inFence = false;

  while (index < lines.length) {
    const line = lines[index];
    if (MARKDOWN_FENCE_RE.test(line)) {
      inFence = !inFence;
      output.push(line);
      index += 1;
      continue;
    }

    if (inFence || !DIFF_HEADER_RE.test(line.trim())) {
      output.push(line);
      index += 1;
      continue;
    }

    const start = index;
    let sawHunk = line.trim().startsWith('@@');
    index += 1;
    while (index < lines.length) {
      const current = lines[index];
      const stripped = current.trim();
      if (MARKDOWN_FENCE_RE.test(current)) break;
      if (DIFF_HEADER_RE.test(stripped)) {
        if (stripped.startsWith('@@')) sawHunk = true;
        index += 1;
        continue;
      }
      if (current.startsWith((' ', '+', '-'))) {
        index += 1;
        continue;
      }
      if (sawHunk && (current.startsWith('    ') || current.startsWith('\t'))) {
        index += 1;
        continue;
      }
      if (!stripped && sawHunk) {
        index += 1;
        continue;
      }
      break;
    }

    const block = lines.slice(start, index).join('\n').trim();
    if (!block || !looksLikeUnfencedDiff(block)) {
      output.push(...lines.slice(start, index));
      continue;
    }
    if (output.length && output[output.length - 1]) output.push('');
    output.push('```diff', ...lines.slice(start, index), '```');
  }

  return output.join('\n').trim();
}

function ensureDiffFence(text) {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.includes('```')) return normalized;
  return looksLikeUnfencedDiff(normalized) ? `\`\`\`diff\n${normalized}\n\`\`\`` : normalized;
}

function normalizePreviewContent(text) {
  let normalized = convertApplyPatchSections(String(text || '').trim());
  normalized = retagFencedDiffBlocks(normalized);
  normalized = fenceEmbeddedDiffBlocks(normalized);
  normalized = ensureDiffFence(normalized);
  return normalized.replace(/\n{3,}/g, '\n\n').trim();
}

function looksLikeShellCommandLine(line) {
  const stripped = String(line || '').trim();
  if (!stripped) return false;
  if (stripped.startsWith('$ ') || stripped.startsWith('# ') || stripped.startsWith('> ')) return true;
  const command = stripped.split(/\s+/, 1)[0];
  if (command.endsWith(':')) return false;
  const common = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'pip', 'uv', 'git', 'npm', 'pnpm', 'yarn', 'go', 'cargo', 'docker', 'kubectl', 'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'sed', 'awk', 'grep', 'rg', 'curl', 'wget', 'chmod', 'chown']);
  if (common.has(command)) return true;
  if (/^(?:\.\/|\.\.\/|\/)?[A-Za-z0-9._/-]+$/.test(command) && command.length >= 2) {
    if (/[|;&<>]/.test(stripped)) return true;
    if (stripped.split(/\s+/).length >= 2) return true;
  }
  return false;
}

function stripLeadingCommandEcho(content) {
  const lines = String(content || '').split('\n');
  const firstNonEmpty = lines.findIndex((line) => line.trim());
  if (firstNonEmpty < 0) return '';
  const tail = lines.slice(firstNonEmpty);
  const nonEmptyCount = tail.filter((line) => line.trim()).length;
  if (nonEmptyCount < 2) return tail.join('\n').trim();
  if (looksLikeShellCommandLine(tail[0])) {
    const strippedTail = tail.slice(1).join('\n').trim();
    if (strippedTail) return strippedTail;
  }
  return tail.join('\n').trim();
}

function formatExecSection(content) {
  let normalized = normalizePreviewContent(content);
  if (!normalized) return '';
  if (normalized.includes('```')) return normalized;
  const lines = normalized.split('\n').filter((line) => line.trim());
  if (lines.length && looksLikeShellCommandLine(lines[0])) {
    return `\`\`\`bash\n${normalized}\n\`\`\``;
  }
  return `\`\`\`\n${normalized}\n\`\`\``;
}

function trimSectionTailNoise(content) {
  const filtered = [];
  for (const line of String(content || '').split('\n')) {
    if (String(line || '').trim().toLowerCase().startsWith('tokens used')) break;
    if (isPreviewNoiseLine(line)) continue;
    filtered.push(line);
  }
  return filtered.join('\n').trim();
}

function fallbackPreview(cleaned, status) {
  const filtered = [];
  for (const line of cleaned.split('\n')) {
    const stripped = String(line || '').trim();
    if (stripped.toLowerCase().startsWith('tokens used')) break;
    if (isPreviewNoiseLine(line)) continue;
    if (TRACE_SKIP_SECTION_MARKERS.has(stripped.toLowerCase())) continue;
    filtered.push(line);
  }
  return {
    marker: status === 'Running' ? 'thinking' : 'assistant',
    content: normalizePreviewContent(filtered.join('\n').trim()),
  };
}

export function extractPreview(output, status = 'Done') {
  const cleaned = cleanOutput(output);
  if (!cleaned) {
    return {
      marker: status === 'Running' ? 'thinking' : 'assistant',
      content: '',
    };
  }

  const sections = parseTraceSections(cleaned.split('\n'));
  if (status === 'Running') {
    const section = latestSection(sections, new Set(['assistant', 'codex', 'thinking', 'exec']));
    if (section) {
      if (section.marker === 'thinking') {
        const thinkingContent = stripThinkingEchoLines(trimSectionTailNoise(section.content));
        return { marker: 'thinking', content: thinkingContent ? `thinking\n${thinkingContent}` : 'thinking...' };
      }
      if (section.marker === 'exec') {
        return { marker: 'exec', content: formatExecSection(trimSectionTailNoise(section.content)) };
      }
      return { marker: section.marker, content: normalizePreviewContent(trimSectionTailNoise(section.content)) };
    }
  } else {
    const assistant = latestSection(sections, new Set(['assistant', 'codex']));
    if (assistant) {
      return { marker: assistant.marker, content: normalizePreviewContent(trimSectionTailNoise(assistant.content)) };
    }
    const exec = latestSection(sections, new Set(['exec']));
    if (exec) {
      return { marker: 'exec', content: formatExecSection(trimSectionTailNoise(exec.content)) };
    }
  }

  return fallbackPreview(cleaned, status);
}

export function sanitizePreview(output, status = 'Done') {
  return extractPreview(output, status).content;
}

export function maskSensitiveArgs(args) {
  const redacted = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      redacted.push('***');
      maskNext = false;
      continue;
    }
    const lowered = String(arg).toLowerCase();
    if (String(arg).includes('=')) {
      const [key, value] = String(arg).split('=', 2);
      if (SENSITIVE_OPTION_RE.test(key) || SENSITIVE_OPTION_RE.test(lowered) || LONG_SECRET_RE.test(value || '')) {
        redacted.push(`${key}=***`);
        continue;
      }
      redacted.push(String(arg));
      continue;
    }
    if (SENSITIVE_OPTION_RE.test(lowered)) {
      redacted.push(String(arg));
      maskNext = true;
      continue;
    }
    if (LONG_SECRET_RE.test(String(arg))) {
      redacted.push('***');
      continue;
    }
    redacted.push(String(arg));
  }
  return redacted;
}

export function splitShellArgs(command) {
  const text = String(command || '').trim();
  if (!text) return [];
  const matches = text.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g) || [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

export function shellJoin(args) {
  return args.map((arg) => (/^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function redactedCommandText(command) {
  const args = splitShellArgs(command);
  if (!args.length) return String(command || '');
  return shellJoin(maskSensitiveArgs(args));
}
