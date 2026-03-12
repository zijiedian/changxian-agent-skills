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
const PAGINATION_HEADER_RESERVE = 32;

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

function isDiffChangeLine(line) {
  const value = String(line || '');
  return value.startsWith(' ') || value.startsWith('+') || value.startsWith('-');
}

function looksLikeUnfencedDiff(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return false;
  let sawHeader = false;
  let sawHunk = false;
  let sawChange = false;
  let sawPlus = false;
  let sawMinus = false;

  for (const line of lines) {
    const stripped = line.trim();
    if (DIFF_HEADER_RE.test(stripped)) {
      sawHeader = true;
      if (stripped.startsWith('@@')) sawHunk = true;
      continue;
    }
    if (isDiffChangeLine(line)) {
      sawChange = true;
      if (line.startsWith('+')) sawPlus = true;
      if (line.startsWith('-')) sawMinus = true;
      continue;
    }
    if (sawHunk && (line.startsWith('    ') || line.startsWith('\t'))) {
      sawChange = true;
      continue;
    }
    return false;
  }

  return sawChange && (sawHeader || sawHunk || (sawPlus && sawMinus));
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
      if (isDiffChangeLine(current)) {
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

function fenceEmbeddedChangeOnlyDiffBlocks(text) {
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

    const trimmed = line.trim();
    const isDiffStart = line.startsWith('+') || line.startsWith('-') || trimmed.startsWith('@@');
    if (inFence || !isDiffStart) {
      output.push(line);
      index += 1;
      continue;
    }

    const start = index;
    let sawHunk = trimmed.startsWith('@@');
    index += 1;
    while (index < lines.length) {
      const current = lines[index];
      const stripped = current.trim();
      if (MARKDOWN_FENCE_RE.test(current)) break;
      if (stripped.startsWith('@@')) {
        sawHunk = true;
        index += 1;
        continue;
      }
      if (isDiffChangeLine(current)) {
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
  normalized = fenceEmbeddedChangeOnlyDiffBlocks(normalized);
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

function isDiffCodeSegment(segment) {
  if (!segment || segment.type !== 'code') return false;
  return segment.lang === 'diff' || looksLikeUnfencedDiff(segment.text);
}

function splitMarkdownSegments(text) {
  const segments = [];
  const lines = String(text || '').split('\n');
  let textLines = [];
  let codeLines = [];
  let inFence = false;
  let fenceLanguage = '';

  const pushText = () => {
    const value = textLines.join('\n').trim();
    if (value) segments.push({ type: 'text', text: value });
    textLines = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*```([A-Za-z0-9_+-]*)\s*$/);
    if (!inFence && fenceMatch) {
      pushText();
      inFence = true;
      fenceLanguage = String(fenceMatch[1] || '').toLowerCase();
      codeLines = [];
      continue;
    }
    if (inFence && MARKDOWN_FENCE_CLOSE_RE.test(line)) {
      segments.push({
        type: 'code',
        lang: fenceLanguage,
        text: codeLines.join('\n').trim(),
      });
      inFence = false;
      fenceLanguage = '';
      codeLines = [];
      continue;
    }
    if (inFence) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (inFence) {
    textLines.push(`\`\`\`${fenceLanguage}`);
    textLines.push(...codeLines);
  }

  pushText();
  return segments;
}

function isDiffSectionLabelLine(line) {
  return /^(?:file update|patch|diff|changes?|change set|update details|变更详情|修改详情|代码变更)\s*:?\s*$/i.test(String(line || '').trim());
}

function stripTrailingDiffSectionLabels(text) {
  const lines = String(text || '').split('\n');
  while (lines.length && isDiffSectionLabelLine(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

function stripOuterCodeFence(text) {
  const lines = String(text || '').split('\n');
  if (lines.length >= 2 && /^\s*```/.test(lines[0]) && /^\s*```/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join('\n').trim();
  }
  return String(text || '').trim();
}

function normalizeParagraphText(text) {
  return String(text || '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripProgressLabelPrefix(text) {
  return String(text || '')
    .replace(/^(?:正在执行命令|执行命令|running command)\s*[:：]\s*/i, '')
    .trim();
}

function isWebSearchActivityLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  if (/^[🌐🔎🕸️🛰️]/u.test(value)) return true;
  if (/(?:search(?:ing|ed)?\s+the\s+web|sourced? from|opened:|clicked:|found:)/i.test(value)) return true;
  if (/^searched\s*:/i.test(value)) return true;
  if (/https?:\/\/\S+/i.test(value) && /(site:|job|career|campus|招聘|校招|实习|岗位|职位)/i.test(value)) return true;
  return false;
}

function isCommandActivityLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  if (/^(?:正在执行命令|执行命令|running command)\s*[:：]/i.test(value)) return true;
  return false;
}

function classifyActivityLine(line) {
  if (isCommandActivityLine(line)) return 'command';
  if (isWebSearchActivityLine(line)) return 'research';
  return '';
}

function splitTextActivities(text) {
  const proseLines = [];
  const activityGroups = [];
  let activeGroup = null;

  const flushActivity = () => {
    if (activeGroup?.lines?.length) {
      activityGroups.push({
        kind: activeGroup.kind,
        lines: activeGroup.lines.slice(),
      });
    }
    activeGroup = null;
  };

  for (const line of String(text || '').split('\n')) {
    const kind = classifyActivityLine(line);
    if (!kind) {
      flushActivity();
      proseLines.push(line);
      continue;
    }
    if (!activeGroup || activeGroup.kind !== kind) {
      flushActivity();
      activeGroup = { kind, lines: [] };
    }
    activeGroup.lines.push(String(line || '').trim());
  }
  flushActivity();

  return {
    prose: proseLines.join('\n').trim(),
    activities: activityGroups,
  };
}

function parseTextBlocks(text) {
  const blocks = [];
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    const bulletItems = [];
    let bulletOnly = true;
    for (const line of buffer) {
      const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
      if (!match) {
        bulletOnly = false;
        break;
      }
      const value = normalizeParagraphText(match[1]);
      if (value) bulletItems.push(value);
    }

    if (bulletOnly && bulletItems.length) {
      blocks.push({ type: 'bullets', items: bulletItems });
    } else {
      const value = normalizeParagraphText(buffer.join('\n'));
      if (value && !isDiffSectionLabelLine(value)) {
        blocks.push({ type: 'paragraph', text: value });
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    if (!String(line || '').trim()) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function pushUnique(target, seen, value) {
  const normalized = normalizeParagraphText(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(normalized);
}

function isVerificationLine(text) {
  return /(?:已通过|通过|验证|测试|test|lint|build|compile|编译|生效|重启服务|已完成|成功|无报错|检查通过)/i.test(String(text || ''));
}

function isCommandLanguage(language) {
  return ['bash', 'sh', 'zsh', 'shell', 'console'].includes(String(language || '').toLowerCase());
}

function extractDomainsFromText(text) {
  const domains = [];
  const seen = new Set();
  const pushDomain = (candidate) => {
    const normalized = String(candidate || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/[:/?#].*$/, '')
      .toLowerCase();
    if (!normalized || !/\.[a-z]{2,}$/i.test(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    domains.push(normalized);
  };

  const value = String(text || '');
  for (const match of value.matchAll(/https?:\/\/([^\s<>()]+)/gi)) {
    pushDomain(match[1]);
  }
  for (const match of value.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    pushDomain(match[1]);
  }
  return domains;
}

function summarizeShellCommand(line) {
  const raw = stripProgressLabelPrefix(line)
    .replace(/^\/bin\/(?:ba)?sh\s+-lc\s+/i, '')
    .replace(/^\/bin\/zsh\s+-lc\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (!raw) return '执行命令';
  if (/python\d?(?:\s|$).*(?:<<['"]?(?:PY|EOF)|-c\b)/i.test(raw)) return '执行 Python 脚本';
  if (/node(?:\s|$).*(?:<<['"]?(?:JS|NODE|EOF)|--input-type=module|-e\b)/i.test(raw)) return '执行 Node 脚本';
  if (/\b(?:rg|grep|sed|awk|find|ls|cat)\b/i.test(raw)) return '读取并筛选文件内容';
  if (/\bcurl\b/i.test(raw)) return '请求网页或接口';
  if (/\b(?:pytest|go test|npm test|pnpm test|cargo test)\b/i.test(raw)) return '运行测试';
  if (/\b(?:npm run|pnpm|yarn|npm)\b/i.test(raw)) return '执行项目脚本';
  if (/\bpython\d?\b/i.test(raw)) return '执行 Python 命令';
  if (/\bnode\b/i.test(raw)) return '执行 Node 命令';
  return `执行命令：${truncateText(raw, 72)}`;
}

function runningCommandSummary(summary) {
  const value = String(summary || '').trim();
  if (!value) return '';
  return `正在${value}`;
}

function extractCommandPreviewLines(text, limit = 3) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commands = [];
  for (const line of lines) {
    if (!looksLikeShellCommandLine(line)) continue;
    commands.push(line);
    if (commands.length >= limit) break;
  }
  return commands;
}

function summarizeActivityGroups(groups, status) {
  const summaryLines = [];
  const details = [];
  const detailSeen = new Set();
  let phase = '';
  let commandSummary = '';
  const sourceDomains = [];
  const sourceSeen = new Set();
  let searchLineCount = 0;

  for (const group of groups) {
    if (group.kind === 'research') {
      if (!phase) phase = 'research';
      searchLineCount += group.lines.length;
      for (const line of group.lines) {
        for (const domain of extractDomainsFromText(line)) {
          if (sourceSeen.has(domain)) continue;
          sourceSeen.add(domain);
          sourceDomains.push(domain);
        }
      }
      continue;
    }

    if (group.kind === 'command') {
      if (!phase) phase = 'exec';
      const summary = summarizeShellCommand(group.lines[0] || '');
      if (!commandSummary) commandSummary = summary;
      pushUnique(details, detailSeen, summary);
    }
  }

  if (searchLineCount > 0) {
    const searchSummary = status === 'Running'
      ? `正在检索公开资料，已触达 ${Math.max(sourceDomains.length, 1)} 个来源。`
      : `已检索公开资料，覆盖 ${Math.max(sourceDomains.length, 1)} 个来源。`;
    pushUnique(summaryLines, new Set(), searchSummary);
    if (sourceDomains.length) {
      pushUnique(details, detailSeen, `来源：${sourceDomains.slice(0, 4).join('、')}${sourceDomains.length > 4 ? ` 等 ${sourceDomains.length} 个` : ''}`);
    }
  }

  return {
    phase,
    summaryLines,
    details,
    sourceDomains,
    commandSummary,
  };
}

function shortenDisplayPath(candidate) {
  let value = String(candidate || '').trim();
  if (!value || value === '/dev/null') return value;
  value = value.replace(/^['"]|['"]$/g, '');
  value = value.replace(/^[ab]\//, '');
  const parts = value.split('/').filter(Boolean);
  if (!parts.length) return value;
  if (parts.length <= 3) return parts.join('/');
  return `.../${parts.slice(-3).join('/')}`;
}

function normalizeDiffPath(candidate) {
  const value = shortenDisplayPath(candidate);
  return value === '/dev/null' ? '' : value;
}

function formatDiffRef(candidate) {
  const value = String(candidate || '').trim();
  if (!value || value === '/dev/null') return value;
  if (value.startsWith('a/')) return `a/${shortenDisplayPath(value.slice(2))}`;
  if (value.startsWith('b/')) return `b/${shortenDisplayPath(value.slice(2))}`;
  return shortenDisplayPath(value);
}

function collectChangedFilesFromDiff(text) {
  const files = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const diffMatch = line.match(/^diff --git\s+(\S+)\s+(\S+)$/);
    if (diffMatch) {
      pushUnique(files, seen, normalizeDiffPath(diffMatch[2]) || normalizeDiffPath(diffMatch[1]));
      continue;
    }
    const patchMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/);
    if (patchMatch) {
      pushUnique(files, seen, normalizeDiffPath(patchMatch[1]));
      continue;
    }
    const plusMatch = line.match(/^\+\+\+\s+(\S+)$/);
    if (plusMatch) {
      pushUnique(files, seen, normalizeDiffPath(plusMatch[1]));
    }
  }
  return files;
}

function splitDiffFileChunks(text) {
  const lines = String(text || '').split('\n');
  const chunks = [];
  let current = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length) {
      chunks.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.some((line) => String(line || '').trim())) {
    chunks.push(current);
  }
  return chunks.length ? chunks : [lines];
}

function sanitizeDiffDisplayLine(line) {
  const value = String(line || '');
  const diffMatch = value.match(/^diff --git\s+(\S+)\s+(\S+)$/);
  if (diffMatch) {
    return `diff --git ${formatDiffRef(diffMatch[1])} ${formatDiffRef(diffMatch[2])}`;
  }
  const refMatch = value.match(/^(\+\+\+|---)\s+(\S+)$/);
  if (refMatch) {
    return `${refMatch[1]} ${formatDiffRef(refMatch[2])}`;
  }
  const renameMatch = value.match(/^(rename (?:from|to))\s+(.+)$/);
  if (renameMatch) {
    return `${renameMatch[1]} ${shortenDisplayPath(renameMatch[2])}`;
  }
  return value;
}

function compactDiffChunk(lines, options, state) {
  const output = [];
  let index = 0;
  let hunksKept = 0;

  const canPush = () => output.length < options.maxLinesPerFile && state.totalLines < options.maxTotalLines;
  const push = (line) => {
    if (!canPush()) return false;
    output.push(line);
    state.totalLines += 1;
    return true;
  };

  while (index < lines.length) {
    const line = String(lines[index] || '');
    if (line.startsWith('@@') || isDiffChangeLine(line)) break;
    if (line.trim()) push(sanitizeDiffDisplayLine(line));
    index += 1;
  }

  while (index < lines.length && hunksKept < options.maxHunksPerFile && canPush()) {
    while (index < lines.length && !String(lines[index] || '').startsWith('@@')) {
      if (String(lines[index] || '').startsWith('diff --git ')) break;
      index += 1;
    }
    if (index >= lines.length || String(lines[index] || '').startsWith('diff --git ')) break;

    push(String(lines[index] || ''));
    index += 1;
    hunksKept += 1;

    let linesKept = 0;
    let linesOmitted = 0;
    while (index < lines.length) {
      const line = String(lines[index] || '');
      if (line.startsWith('@@') || line.startsWith('diff --git ')) break;
      if (linesKept < options.maxLinesPerHunk && canPush()) {
        push(line);
        linesKept += 1;
      } else {
        linesOmitted += 1;
      }
      index += 1;
    }

    if (linesOmitted > 0 && canPush()) {
      push(`... ${linesOmitted} lines omitted ...`);
    }
  }

  if (index < lines.length && canPush()) {
    push('... diff truncated ...');
  }

  return output.join('\n').trim();
}

export function buildStructuredPreview(content, { status = 'Done', marker = 'assistant' } = {}) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const diffBlocks = [];
  const codeBlocks = [];
  const proseParts = [];
  const commandPreviewLines = [];
  const changedFiles = [];
  const changedFilesSeen = new Set();
  const activityGroups = [];

  const segments = splitMarkdownSegments(normalized);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1] || null;
    if (segment.type === 'text') {
      let text = segment.text;
      if (isDiffCodeSegment(nextSegment)) {
        text = stripTrailingDiffSectionLabels(text);
      }
      if (text) {
        const split = splitTextActivities(text);
        if (split.prose) proseParts.push(split.prose);
        if (split.activities.length) activityGroups.push(...split.activities);
      }
      continue;
    }

    if (isDiffCodeSegment(segment)) {
      const diffText = stripOuterCodeFence(normalizePreviewContent(segment.text));
      if (diffText) diffBlocks.push(diffText);
      for (const file of collectChangedFilesFromDiff(diffText)) {
        pushUnique(changedFiles, changedFilesSeen, file);
      }
      continue;
    }

    const codeText = normalizePreviewContent(segment.text);
    if (!codeText) continue;
    codeBlocks.push({ lang: segment.lang || '', text: codeText });
    const previewLines = isCommandLanguage(segment.lang)
      ? extractCommandPreviewLines(codeText)
      : [];
    for (const line of previewLines) {
      if (commandPreviewLines.length >= 3) break;
      commandPreviewLines.push(line);
    }
  }

  const activitySummary = summarizeActivityGroups(activityGroups, status);

  const proseText = proseParts.join('\n\n').trim();
  const blocks = parseTextBlocks(proseText);
  const highlights = [];
  const checks = [];
  const notes = [];
  const highlightsSeen = new Set();
  const checksSeen = new Set();
  const notesSeen = new Set();
  let summary = '';
  let summaryTaken = false;

  for (const block of blocks) {
    if (!summaryTaken && block.type === 'paragraph') {
      summary = block.text;
      summaryTaken = true;
      continue;
    }

    if (block.type === 'bullets') {
      for (const item of block.items) {
        if (isVerificationLine(item)) {
          pushUnique(checks, checksSeen, item);
        } else {
          pushUnique(highlights, highlightsSeen, item);
        }
      }
      continue;
    }

    if (block.type === 'paragraph') {
      if (isVerificationLine(block.text)) {
        pushUnique(checks, checksSeen, block.text);
      } else {
        pushUnique(notes, notesSeen, block.text);
      }
    }
  }

  if (!summary) {
    if (highlights.length) {
      summary = highlights.shift();
      highlightsSeen.delete(summary.toLowerCase());
    } else if (checks.length) {
      summary = checks[0];
    } else if (activitySummary.summaryLines.length) {
      summary = activitySummary.summaryLines[0];
    } else if (changedFiles.length) {
      summary = status === 'Running'
        ? `正在整理 ${changedFiles.length} 个文件的变更。`
        : `已整理 ${changedFiles.length} 个文件的变更。`;
    } else if (activitySummary.commandSummary) {
      summary = status === 'Running'
        ? `${runningCommandSummary(activitySummary.commandSummary)}。`
        : `${activitySummary.commandSummary}完成。`;
    } else if (commandPreviewLines.length) {
      summary = status === 'Running'
        ? `${runningCommandSummary(summarizeShellCommand(commandPreviewLines[0]))}。`
        : `${summarizeShellCommand(commandPreviewLines[0])}完成。`;
    } else if (normalized) {
      summary = truncateText(normalizeParagraphText(normalized), 180);
    }
  }

  let phase = String(marker || 'assistant').toLowerCase();
  if (!normalized) phase = status === 'Running' ? 'thinking' : 'assistant';
  if (activitySummary.phase === 'research' && !changedFiles.length) phase = 'research';
  if (activitySummary.phase === 'exec' && !changedFiles.length && phase !== 'research') phase = 'exec';
  if (phase === 'thinking' && changedFiles.length) phase = 'diff';
  if ((phase === 'assistant' || phase === 'codex') && changedFiles.length) phase = 'diff';
  if (phase === 'exec' && !commandPreviewLines.length && changedFiles.length) phase = 'diff';
  if (phase !== 'thinking' && !changedFiles.length && commandPreviewLines.length) phase = 'exec';

  for (const item of activitySummary.summaryLines) {
    if (item !== summary) pushUnique(highlights, highlightsSeen, item);
  }
  for (const item of activitySummary.details) {
    pushUnique(highlights, highlightsSeen, item);
  }

  return {
    status,
    marker: phase,
    phase,
    content: normalized,
    proseMarkdown: proseText,
    summary,
    highlights,
    checks,
    notes,
    changedFiles,
    diffBlocks,
    codeBlocks,
    commandPreview: activitySummary.commandSummary || commandPreviewLines[0] || '',
    commandPreviewLines,
    activities: activityGroups,
    sourceDomains: activitySummary.sourceDomains,
  };
}

export function extractStructuredPreview(output, status = 'Done') {
  const preview = extractPreview(output, status);
  return buildStructuredPreview(preview.content, {
    status,
    marker: preview.marker,
  });
}

export function buildPreviewSummaryMarkdown(preview, options = {}) {
  const value = preview && typeof preview === 'object'
    ? preview
    : buildStructuredPreview(String(preview || ''), {});
  const heading = String(options.heading || '').trim();
  const maxHighlights = Math.max(0, Number(options.maxHighlights) || 0);
  const maxChecks = Math.max(0, Number(options.maxChecks) || 0);
  const maxFiles = Math.max(0, Number(options.maxFiles) || 0);
  const maxNotes = Math.max(0, Number(options.maxNotes) || 0);
  const lines = [];

  if (heading) lines.push(`**${heading}**`);
  if (value.summary) lines.push(value.summary);

  if (maxHighlights > 0 && value.highlights.length) {
    if (lines.length) lines.push('');
    for (const item of value.highlights.slice(0, maxHighlights)) {
      lines.push(`- ${item}`);
    }
    const extraHighlights = value.highlights.length - Math.min(value.highlights.length, maxHighlights);
    if (extraHighlights > 0) lines.push(`- 还有 ${extraHighlights} 条摘要`);
  }

  if (maxFiles > 0 && value.changedFiles.length) {
    if (lines.length) lines.push('');
    lines.push('**涉及文件**');
    for (const file of value.changedFiles.slice(0, maxFiles)) {
      lines.push(`- ${file}`);
    }
    const extraFiles = value.changedFiles.length - Math.min(value.changedFiles.length, maxFiles);
    if (extraFiles > 0) lines.push(`- 还有 ${extraFiles} 个文件`);
  }

  if (maxChecks > 0 && value.checks.length) {
    if (lines.length) lines.push('');
    lines.push('**验证**');
    for (const item of value.checks.slice(0, maxChecks)) {
      lines.push(`- ${item}`);
    }
    const extraChecks = value.checks.length - Math.min(value.checks.length, maxChecks);
    if (extraChecks > 0) lines.push(`- 还有 ${extraChecks} 条验证结果`);
  }

  if (maxNotes > 0 && value.notes.length) {
    if (lines.length) lines.push('');
    for (const item of value.notes.slice(0, maxNotes)) {
      lines.push(item);
    }
    const extraNotes = value.notes.length - Math.min(value.notes.length, maxNotes);
    if (extraNotes > 0) lines.push(`还有 ${extraNotes} 条补充说明。`);
  }

  if (value.diffBlocks.length && options.includeDiffHint !== false) {
    if (lines.length) lines.push('');
    lines.push(value.status === 'Running' ? '变更节选整理中。' : '变更节选见后续分页。');
  }

  return lines.join('\n').trim();
}

export function buildPreviewDiffMarkdown(preview, options = {}) {
  const value = preview && typeof preview === 'object'
    ? preview
    : buildStructuredPreview(String(preview || ''), {});
  if (!value.diffBlocks.length) return '';

  const maxFiles = Math.max(1, Number(options.maxFiles) || 3);
  const compactOptions = {
    maxFiles,
    maxHunksPerFile: Math.max(1, Number(options.maxHunksPerFile) || 2),
    maxLinesPerHunk: Math.max(2, Number(options.maxLinesPerHunk) || 8),
    maxLinesPerFile: Math.max(8, Number(options.maxLinesPerFile) || 28),
    maxTotalLines: Math.max(12, Number(options.maxTotalLines) || 80),
  };

  const fileChunks = value.diffBlocks.flatMap((block) => splitDiffFileChunks(block));
  if (!fileChunks.length) return '';

  const selectedChunks = [];
  const state = { totalLines: 0 };
  for (const chunk of fileChunks) {
    if (selectedChunks.length >= compactOptions.maxFiles || state.totalLines >= compactOptions.maxTotalLines) break;
    const compacted = compactDiffChunk(chunk, compactOptions, state);
    if (compacted) selectedChunks.push(compacted);
  }

  if (!selectedChunks.length) return '';

  const lines = [];
  const heading = String(options.heading || '').trim();
  if (heading) lines.push(heading);
  if (fileChunks.length > selectedChunks.length) {
    lines.push(`- 仅展示前 ${selectedChunks.length}/${fileChunks.length} 个文件的变更节选`);
  }
  lines.push('```diff');
  lines.push(selectedChunks.join('\n\n'));
  lines.push('```');
  return lines.join('\n').trim();
}

function splitLineForPagination(line, limit) {
  const value = String(line || '');
  if (!value || value.length <= limit) return [value];

  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    chunks.push(value.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}

function nextFenceState(currentFence, line) {
  const trimmed = String(line || '').trim();
  if (!MARKDOWN_FENCE_RE.test(trimmed)) return currentFence;
  return currentFence ? null : (trimmed || '```');
}

function materializePage(lines, openFence) {
  const output = lines.slice();
  if (openFence) output.push('```');
  return output.join('\n').trimEnd();
}

function hasPageContent(lines, openFence) {
  if (!lines.length) return false;
  return !(openFence && lines.length === 1 && lines[0] === openFence);
}

export function splitMarkdownPages(text, limit = 3200) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!normalized) return ['暂无输出'];

  const bodyLimit = Math.max(200, Number(limit) || 3200);
  const splitLimit = Math.max(120, Math.floor((bodyLimit - PAGINATION_HEADER_RESERVE) * 0.75));
  const lines = normalized
    .split('\n')
    .flatMap((line) => splitLineForPagination(line, splitLimit));

  const pages = [];
  let currentLines = [];
  let openFence = null;

  const pushCurrentPage = () => {
    if (!hasPageContent(currentLines, openFence)) return;
    pages.push(materializePage(currentLines, openFence));
    currentLines = openFence ? [openFence] : [];
  };

  for (const line of lines) {
    const nextFence = nextFenceState(openFence, line);
    const candidateLines = currentLines.concat(line);
    const candidateText = materializePage(candidateLines, nextFence);
    const reopenedFenceOnly = Boolean(openFence && currentLines.length === 1 && currentLines[0] === openFence);

    if (candidateText.length > bodyLimit && currentLines.length && !reopenedFenceOnly) {
      pushCurrentPage();
    }

    currentLines.push(line);
    openFence = nextFence;
  }

  if (hasPageContent(currentLines, openFence)) {
    pages.push(materializePage(currentLines, openFence));
  }

  return pages.length ? pages : ['暂无输出'];
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
