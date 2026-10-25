'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreDefaultMenuButton } = require('../telegramMenuRollback');

test('web app menu is restored to default and verified', async () => {
  const calls = [];
  let current = { type: 'web_app', text: 'Open Eli', web_app: { url: 'https://example.test' } };
  const telegram = {
    async getChatMenuButton() {
      calls.push('get');
      return current;
    },
    async setChatMenuButton(input) {
      calls.push(input);
      current = input.menuButton;
      return true;
    },
  };
  const logs = [];
  const result = await restoreDefaultMenuButton(telegram, {
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });

  assert.deepEqual(result, { ok: true, changed: true, type: 'default' });
  assert.deepEqual(calls, [
    'get',
    { menuButton: { type: 'default' } },
    'get',
  ]);
  assert.match(logs[0], /removed/);
});

test('default or commands menu is preserved', async () => {
  for (const type of ['default', 'commands']) {
    let writes = 0;
    const result = await restoreDefaultMenuButton({
      async getChatMenuButton() { return { type }; },
      async setChatMenuButton() { writes += 1; },
    }, { log() {}, warn() {} });
    assert.deepEqual(result, { ok: true, changed: false, type });
    assert.equal(writes, 0);
  }
});

test('Telegram API failure is sanitized and does not prevent bot startup', async () => {
  const warnings = [];
  const result = await restoreDefaultMenuButton({
    async getChatMenuButton() { throw new Error('sensitive token-bearing detail'); },
    async setChatMenuButton() {},
  }, { log() {}, warn: (message) => warnings.push(message) });
  assert.deepEqual(result, { ok: false, reason: 'menu_reset_failed' });
  assert.deepEqual(warnings, ['Telegram menu reset failed; check BotFather settings manually.']);
});
