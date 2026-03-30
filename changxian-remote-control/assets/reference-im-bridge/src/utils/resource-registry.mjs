import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function codexHome() {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), '.codex');
}

function configPath() {
  return path.join(codexHome(), 'config.toml');
}

function mcpPath() {
  return path.join(codexHome(), 'mcp.json');
}

function ensureTrailingNewline(text) {
  return String(text || '').endsWith('\n') ? String(text || '') : `${String(text || '')}\n`;
}

function skillDisplayName(skillPath = '') {
  const normalized = path.resolve(String(skillPath || '').trim());
  const dir = path.basename(path.dirname(normalized));
  if (dir && dir !== '.') return dir;
  return path.basename(normalized).replace(/\.md$/i, '') || normalized;
}

function parseSkillsConfigBlocks(content = '') {
  const lines = String(content || '').split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '[[skills.config]]') continue;
    const start = index;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const trimmed = lines[cursor].trim();
      if (trimmed === '[[skills.config]]' || (/^\[/.test(trimmed) && trimmed !== '[[skills.config]]')) {
        end = cursor;
        break;
      }
    }

    let skillPath = '';
    let enabled = true;
    let pathLineIndex = -1;
    let enabledLineIndex = -1;
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      const trimmed = lines[cursor].trim();
      const pathMatch = trimmed.match(/^path\s*=\s*"([^"]+)"\s*$/);
      if (pathMatch) {
        skillPath = pathMatch[1];
        pathLineIndex = cursor;
        continue;
      }
      const enabledMatch = trimmed.match(/^enabled\s*=\s*(true|false)\s*$/i);
      if (enabledMatch) {
        enabled = enabledMatch[1].toLowerCase() === 'true';
        enabledLineIndex = cursor;
      }
    }

    if (skillPath) {
      blocks.push({
        start,
        end,
        pathLineIndex,
        enabledLineIndex,
        path: skillPath,
        enabled,
      });
    }

    index = end - 1;
  }

  return { lines, blocks };
}

function parseTomlMcpSections(content = '') {
  const lines = String(content || '').split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^\[mcp_servers\.([^\]]+)\]\s*$/);
    if (!match) continue;
    const name = match[1];
    let command = '';
    const args = [];
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const trimmed = lines[cursor].trim();
      if (/^\[/.test(trimmed)) {
        end = cursor;
        break;
      }
      const commandMatch = trimmed.match(/^command\s*=\s*"([^"]+)"/);
      if (commandMatch) command = commandMatch[1];
      const argsMatch = trimmed.match(/^args\s*=\s*\[(.*)\]\s*$/);
      if (argsMatch) {
        const parts = argsMatch[1]
          .split(',')
          .map((item) => item.trim().replace(/^"|"$/g, ''))
          .filter(Boolean);
        args.push(...parts);
      }
    }
    records.push({
      name,
      enabled: true,
      type: 'local',
      command: [command, ...args].filter(Boolean),
    });
    index = end - 1;
  }
  return records;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function listSystemSkills() {
  const filePath = configPath();
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const parsed = parseSkillsConfigBlocks(content);
  const configured = parsed.blocks.map((block) => ({
    name: skillDisplayName(block.path),
    path: block.path,
    enabled: block.enabled,
    source: 'config',
    backends: ['codex', 'pi'],
  }));

  const knownPaths = new Set(configured.map((item) => path.resolve(item.path)));
  const fallbackDir = path.join(codexHome(), 'skills');
  const extras = [];
  if (fs.existsSync(fallbackDir)) {
    for (const entry of fs.readdirSync(fallbackDir).filter((name) => !name.startsWith('.')).sort()) {
      const skillPath = path.join(fallbackDir, entry, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const resolved = path.resolve(skillPath);
      if (knownPaths.has(resolved)) continue;
      extras.push({
        name: entry,
        path: resolved,
        enabled: true,
        source: 'filesystem',
        backends: ['codex', 'pi'],
      });
    }
  }

  return [...configured, ...extras].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function resolveSkillIdentifier(identifier, skills) {
  const raw = String(identifier || '').trim();
  if (!raw) return { error: 'skill name is required' };
  const lowered = raw.toLowerCase();
  const matches = skills.filter((skill) => {
    const name = String(skill.name || '').toLowerCase();
    const fullPath = path.resolve(String(skill.path || '')).toLowerCase();
    return name === lowered || fullPath === path.resolve(raw).toLowerCase();
  });
  if (matches.length === 1) return { record: matches[0] };
  if (matches.length > 1) return { error: `multiple skills match: ${raw}` };

  const fuzzy = skills.filter((skill) => String(skill.name || '').toLowerCase().includes(lowered));
  if (fuzzy.length === 1) return { record: fuzzy[0] };
  if (fuzzy.length > 1) return { error: `multiple skills match: ${raw}` };
  return { error: `skill not found: ${raw}` };
}

export function setSystemSkillEnabled(identifier, enabled) {
  const filePath = configPath();
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const parsed = parseSkillsConfigBlocks(content);
  const skills = listSystemSkills();
  const resolved = resolveSkillIdentifier(identifier, skills);
  if (resolved.error) throw new Error(resolved.error);
  const target = resolved.record;
  const nextLines = parsed.lines.slice();
  const targetPath = path.resolve(target.path);
  const block = parsed.blocks.find((item) => path.resolve(item.path) === targetPath);

  if (block) {
    if (block.enabledLineIndex >= 0) {
      nextLines[block.enabledLineIndex] = `enabled = ${enabled ? 'true' : 'false'}`;
    } else if (block.pathLineIndex >= 0) {
      nextLines.splice(block.pathLineIndex + 1, 0, `enabled = ${enabled ? 'true' : 'false'}`);
    }
  } else {
    if (nextLines.length && nextLines[nextLines.length - 1].trim()) nextLines.push('');
    nextLines.push('[[skills.config]]');
    nextLines.push(`path = "${target.path}"`);
    nextLines.push(`enabled = ${enabled ? 'true' : 'false'}`);
  }

  fs.writeFileSync(filePath, ensureTrailingNewline(nextLines.join('\n')), 'utf8');
  return {
    ...target,
    enabled,
  };
}

export function listSystemMcpServers() {
  const jsonPath = mcpPath();
  if (fs.existsSync(jsonPath)) {
    const payload = readJson(jsonPath, { mcp: {} });
    const entries = Object.entries(payload?.mcp || {}).map(([name, record]) => ({
      name,
      enabled: record?.enabled !== false,
      type: String(record?.type || 'local'),
      command: Array.isArray(record?.command) ? record.command.map((item) => String(item)) : [],
      source: 'mcp.json',
      backends: ['codex'],
    }));
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  const filePath = configPath();
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  return parseTomlMcpSections(content)
    .map((item) => ({ ...item, source: 'config.toml', backends: ['codex'] }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export function setSystemMcpEnabled(identifier, enabled) {
  const jsonPath = mcpPath();
  const payload = readJson(jsonPath, { mcp: {} });
  const current = payload?.mcp && typeof payload.mcp === 'object' ? payload.mcp : {};
  const entries = listSystemMcpServers();
  const raw = String(identifier || '').trim();
  if (!raw) throw new Error('mcp name is required');
  const lowered = raw.toLowerCase();
  const matches = entries.filter((entry) => String(entry.name || '').toLowerCase() === lowered || String(entry.name || '').toLowerCase().includes(lowered));
  if (!matches.length) throw new Error(`mcp server not found: ${raw}`);
  if (matches.length > 1) throw new Error(`multiple mcp servers match: ${raw}`);
  const target = matches[0];

  if (!current[target.name]) {
    current[target.name] = {
      enabled,
      type: target.type || 'local',
      command: target.command || [],
    };
  } else {
    current[target.name] = {
      ...current[target.name],
      enabled,
    };
  }

  payload.mcp = current;
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    ...target,
    enabled,
  };
}
