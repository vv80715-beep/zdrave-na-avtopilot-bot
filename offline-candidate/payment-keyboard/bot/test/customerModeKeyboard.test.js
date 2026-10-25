const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Markup } = require('telegraf');
const { MODE_BUTTON_LABELS, createModeKeyboard } = require('../modeKeyboard');

const SOURCE = fs.readFileSync(require.resolve('../index'), 'utf8');
const between = (start, end) => {
  const a = SOURCE.indexOf(start);
  const b = SOURCE.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing source section: ${start}`);
  return SOURCE.slice(a, b);
};

function customerModeBot(initialStatus) {
  const commands = new Map();
  const hears = new Map();
  const modes = new Map();
  const accessChecks = [];
  let status = initialStatus;
  const ctx = {
    from: { id: 9000000101 },
    replies: [],
    reply: async (message, extra) => ctx.replies.push({ message, extra }),
  };
  const planKeyboard = () => ({ reply_markup: { inline_keyboard: [[{ text: 'Планове' }]] } });
  const sandbox = {
    MODE_BUTTON_LABELS,
    createModeKeyboard,
    Markup,
    bot: {
      command: (name, handler) => commands.set(name, handler),
      hears: (label, handler) => hears.set(label, handler),
    },
    resolveAccessStatus: async (_ctx, options) => {
      accessChecks.push(options);
      return status;
    },
    modePermissionsText: () => 'Разрешени режими от backend-а.',
    planKeyboard,
    TRIAL_EXPIRED_MESSAGE: 'Пробният достъп е изтекъл.',
    getMode: (userId) => modes.get(userId) || 'text',
    setMode: (userId, mode) => modes.set(userId, mode),
  };
  vm.runInNewContext(
    between('const MODE_TEXT_LABEL', '// ── Slash-command safety net') +
      between('bot.hears(MODE_TEXT_LABEL', 'myprofile.register'),
    sandbox
  );
  return {
    ctx, commands, hears, modes, accessChecks,
    setStatus: (next) => { status = next; },
  };
}

function visibleKeyboard(ctx) {
  return ctx.replies.flatMap(({ extra }) => {
    const rows = extra?.reply_markup?.keyboard;
    return rows ? rows.flat().map((button) => typeof button === 'string' ? button : button.text) : [];
  });
}

const customerStatuses = [
  {
    name: 'Trial',
    status: { canChat: true, plan: 'trial', allowedModes: ['text'] },
    expected: [],
  },
  {
    name: '€15 seven-day',
    status: { canChat: true, plan: 'seven_day', allowedModes: ['text', 'voice'] },
    expected: ['Пиши с Ели', 'Говори с Ели'],
  },
  {
    name: '€50 monthly',
    status: { canChat: true, plan: 'monthly', allowedModes: ['text', 'voice', 'avatar'] },
    expected: ['Пиши с Ели', 'Говори с Ели', 'Говори с аватара на Ели'],
  },
  {
    name: '€360 yearly',
    status: { canChat: true, plan: 'yearly', allowedModes: ['text', 'voice', 'avatar'] },
    expected: ['Пиши с Ели', 'Говори с Ели', 'Говори с аватара на Ели'],
  },
  {
    name: 'expired',
    status: { canChat: false, plan: 'paid_expired', allowedModes: [] },
    expected: [],
  },
];

for (const { name, status, expected } of customerStatuses) {
  test(`ordinary customer /mode renders only the server-authorized keyboard: ${name}`, async () => {
    const bot = customerModeBot(status);
    await bot.commands.get('mode')(bot.ctx);
    assert.deepEqual(visibleKeyboard(bot.ctx), expected);
    assert.equal(bot.accessChecks.length, 1);
    assert.equal(bot.accessChecks[0].forceRefresh, true);
    assert.notEqual(status.plan, 'owner');
  });
}

test('stale paid buttons are rechecked and denied after plan downgrade or expiry', async () => {
  const trial = customerModeBot({
    canChat: true, plan: 'trial', allowedModes: ['text'],
  });
  for (const label of [MODE_BUTTON_LABELS.voice, MODE_BUTTON_LABELS.avatar]) {
    await trial.hears.get(label)(trial.ctx);
    assert.equal(trial.modes.has(trial.ctx.from.id), false);
    assert.match(trial.ctx.replies.at(-1).message, /не е включена/);
  }
  assert.equal(trial.accessChecks.length, 2);
  assert.ok(trial.accessChecks.every((check) => check.forceRefresh === true));

  const sevenDay = customerModeBot({
    canChat: true, plan: 'seven_day', allowedModes: ['text', 'voice'],
  });
  await sevenDay.commands.get('mode')(sevenDay.ctx);
  assert.deepEqual(visibleKeyboard(sevenDay.ctx), ['Пиши с Ели', 'Говори с Ели']);
  sevenDay.setStatus({ canChat: true, plan: 'seven_day', allowedModes: ['text', 'voice'] });
  await sevenDay.hears.get(MODE_BUTTON_LABELS.avatar)(sevenDay.ctx);
  assert.equal(sevenDay.modes.has(sevenDay.ctx.from.id), false);
  assert.equal(sevenDay.accessChecks.at(-1).forceRefresh, true);
  assert.match(sevenDay.ctx.replies.at(-1).message, /не е включена/);

  const expired = customerModeBot({
    canChat: false, plan: 'paid_expired', allowedModes: [],
  });
  await expired.hears.get(MODE_BUTTON_LABELS.voice)(expired.ctx);
  assert.equal(expired.modes.has(expired.ctx.from.id), false);
  assert.equal(expired.accessChecks.length, 1);
  assert.equal(expired.accessChecks[0].forceRefresh, true);
  assert.match(expired.ctx.replies.at(-1).message, /изтекъл/);
});
