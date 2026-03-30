import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setupTempCodexHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-resource-registry-'));
  fs.mkdirSync(path.join(dir, 'skills', 'alpha-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha\n---\n');
  fs.writeFileSync(path.join(dir, 'config.toml'), [
    '[[skills.config]]',
    `path = "${path.join(dir, 'skills', 'alpha-skill', 'SKILL.md')}"`,
    'enabled = true',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
    mcp: {
      playwright: {
        enabled: true,
        type: 'local',
        command: ['npx', '@playwright/mcp@latest'],
      },
    },
  }, null, 2));
  return dir;
}

test('resource registry lists and toggles system skills and mcp servers', async () => {
  const tempHome = setupTempCodexHome();
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const registry = await import(`../src/utils/resource-registry.mjs?test=${Date.now()}`);
    const skills = registry.listSystemSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'alpha-skill');
    assert.equal(skills[0].enabled, true);

    const disabledSkill = registry.setSystemSkillEnabled('alpha-skill', false);
    assert.equal(disabledSkill.enabled, false);
    assert.equal(registry.listSystemSkills()[0].enabled, false);

    const mcp = registry.listSystemMcpServers();
    assert.equal(mcp.length, 1);
    assert.equal(mcp[0].name, 'playwright');
    assert.equal(mcp[0].enabled, true);

    const disabledMcp = registry.setSystemMcpEnabled('playwright', false);
    assert.equal(disabledMcp.enabled, false);
    assert.equal(registry.listSystemMcpServers()[0].enabled, false);
  } finally {
    if (original == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});
