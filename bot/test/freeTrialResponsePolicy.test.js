const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FREE_TRIAL_MAX_OUTPUT_TOKENS,
  FREE_TRIAL_HISTORY_LIMIT,
  FREE_TRIAL_PROMPT_NOTE,
} = require('../freeTrialResponsePolicy');

test('Free Trial keeps output materially shorter than Premium', () => {
  assert.equal(FREE_TRIAL_MAX_OUTPUT_TOKENS, 140);
  assert.ok(FREE_TRIAL_MAX_OUTPUT_TOKENS < 600);
});

test('Free Trial uses a small recent-context window', () => {
  assert.equal(FREE_TRIAL_HISTORY_LIMIT, 4);
  assert.ok(FREE_TRIAL_HISTORY_LIMIT < 10);
});

test('Free Trial prompt keeps value, safety and non-pushy behavior', () => {
  assert.match(FREE_TRIAL_PROMPT_NOTE, /2–4 кратки изречения/);
  assert.match(FREE_TRIAL_PROMPT_NOTE, /една най-полезна конкретна стъпка/);
  assert.match(FREE_TRIAL_PROMPT_NOTE, /Не натрапвай платен план/);
  assert.match(FREE_TRIAL_PROMPT_NOTE, /Медицинската безопасност/);
});
