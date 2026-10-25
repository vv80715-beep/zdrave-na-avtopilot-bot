const test = require('node:test');
const assert = require('node:assert');
const { parseCommandText } = require('../commandGuard');

const BOT = 'EliZdraveBot';

test('plain /mode matches and is ours', () => {
  const p = parseCommandText('/mode', BOT);
  assert.deepStrictEqual({ cmd: p.cmd, ours: p.ours }, { cmd: 'mode', ours: true });
});

test('leading whitespace and case are tolerated', () => {
  const p = parseCommandText('  /Mode', BOT);
  assert.strictEqual(p.cmd, 'mode');
  assert.strictEqual(p.ours, true);
});

test('/mode@EliZdraveBot matches case-insensitively', () => {
  const p = parseCommandText('/mode@elizdravebot', BOT);
  assert.strictEqual(p.cmd, 'mode');
  assert.strictEqual(p.ours, true);
});

test('command addressed to a different bot is not ours', () => {
  const p = parseCommandText('/mode@OtherBot', BOT);
  assert.strictEqual(p.cmd, 'mode');
  assert.strictEqual(p.ours, false);
});

test('unknown command still parses (deterministic hint path)', () => {
  const p = parseCommandText('/whatever', BOT);
  assert.strictEqual(p.cmd, 'whatever');
  assert.strictEqual(p.ours, true);
});

test('normal conversation never matches', () => {
  assert.strictEqual(parseCommandText('Пих 1/2 литра вода', BOT), null);
  assert.strictEqual(parseCommandText('виж https://example.com/mode', BOT), null);
  assert.strictEqual(parseCommandText('какво е / това', BOT), null);
  assert.strictEqual(parseCommandText('', BOT), null);
  assert.strictEqual(parseCommandText(null, BOT), null);
  assert.strictEqual(parseCommandText('/', BOT), null);
});

test('missing bot username means the command is treated as ours', () => {
  const p = parseCommandText('/mode@Whoever', undefined);
  assert.strictEqual(p.ours, true);
});
