import test from 'node:test';
import assert from 'node:assert/strict';

import { updateEnvText, usage } from '../scripts/remote-control.ts';

test('usage includes weixin commands', () => {
  const text = usage();
  assert.match(text, /weixin-login/);
  assert.match(text, /weixin-start/);
});

test('updateEnvText replaces and appends values', () => {
  const next = updateEnvText(
    'CODEX_COMMAND_PREFIX=codex-acp\nWEIXIN_ENABLED=0\n',
    {
      WEIXIN_ENABLED: '1',
      WEIXIN_ACCOUNT_ID: 'wx-account-1',
    },
  );

  assert.match(next, /^CODEX_COMMAND_PREFIX=codex-acp/m);
  assert.match(next, /^WEIXIN_ENABLED=1$/m);
  assert.match(next, /^WEIXIN_ACCOUNT_ID=wx-account-1$/m);
});
