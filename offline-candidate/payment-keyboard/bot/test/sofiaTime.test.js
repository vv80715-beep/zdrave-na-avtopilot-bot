const test = require('node:test');
const assert = require('node:assert/strict');
const { getSofiaTimeParts } = require('../sofiaTime');
const { todayKey } = require('../checkinStorage');

test('uses Europe/Sofia across the UTC day boundary', () => {
  const parts = getSofiaTimeParts(new Date('2026-10-06T21:30:00.000Z'));
  assert.equal(parts.dateKey, '2026-10-07');
  assert.equal(parts.hhmm, '00:30');
  assert.equal(todayKey(new Date('2026-10-06T21:30:00.000Z')), '2026-10-07');
});

test('keeps the same local reminder stamp through the repeated DST hour', () => {
  const beforeFallback = getSofiaTimeParts(new Date('2026-10-25T00:30:00.000Z'));
  const afterFallback = getSofiaTimeParts(new Date('2026-10-25T01:30:00.000Z'));

  assert.equal(beforeFallback.dateKey, '2026-10-25');
  assert.equal(afterFallback.dateKey, '2026-10-25');
  assert.equal(beforeFallback.hhmm, '03:30');
  assert.equal(afterFallback.hhmm, '03:30');
  assert.equal(beforeFallback.weekday, 0); // Sunday
  assert.equal(afterFallback.weekday, 0);
});
