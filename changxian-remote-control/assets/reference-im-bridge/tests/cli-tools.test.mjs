import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  extractVersion,
  formatCliStatusLine,
  summarizeUpdateResult,
} from '../src/cli-tools.mjs';

test('extractVersion parses common CLI version formats', () => {
  assert.equal(extractVersion('codex-cli 0.115.0'), '0.115.0');
  assert.equal(extractVersion('2.1.78 (Claude Code)'), '2.1.78');
  assert.equal(extractVersion('opencode 1.2.27'), '1.2.27');
  assert.equal(extractVersion('unknown output'), '');
});

test('compareVersions handles basic semver ordering', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4') < 0, true);
  assert.equal(compareVersions('1.10.0', '1.2.9') > 0, true);
});

test('formatCliStatusLine renders current and latest versions', () => {
  assert.equal(
    formatCliStatusLine({
      label: 'Codex CLI',
      installedVersion: '0.115.0',
      latestVersion: '0.116.0',
      updateAvailable: true,
      source: 'npm',
    }),
    'Codex CLI: 0.115.0 -> 0.116.0 [可更新] (npm)',
  );
  assert.equal(
    formatCliStatusLine({
      label: 'Claude Code',
      installedVersion: '2.1.78',
      latestVersion: '2.1.78',
      updateAvailable: false,
      source: 'brew-cask',
    }),
    'Claude Code: 2.1.78 [最新] (brew-cask)',
  );
});

test('summarizeUpdateResult lists updated and skipped tools', () => {
  const text = summarizeUpdateResult({
    updated: [
      { label: 'Codex CLI', fromVersion: '0.115.0', toVersion: '0.116.0' },
    ],
    skipped: [
      { label: 'Claude Code', reason: 'already up to date' },
      { label: 'OpenCode', reason: 'update source unavailable' },
    ],
  });

  assert.match(text, /Codex CLI: 0\.115\.0 -> 0\.116\.0/);
  assert.match(text, /Claude Code: already up to date/);
  assert.match(text, /OpenCode: update source unavailable/);
});
