import assert from "node:assert/strict";
import test from "node:test";
import {
  getRecentDateKeys,
  removeDailyEntry,
  summarizeWeek,
  upsertDailyEntry,
  validateDailyEntry,
} from "../src/profileProgress.ts";

const dates = getRecentDateKeys("2026-10-22");

function entry(date, values = {}) {
  return {
    date,
    movementMinutes: null,
    sleepHours: null,
    energy: null,
    mood: null,
    waterMl: null,
    ...values,
  };
}

function draft(date, values = {}) {
  return {
    date,
    movementMinutes: "",
    sleepHours: "",
    energy: "",
    mood: "",
    waterMl: "",
    ...values,
  };
}

test("creates the rolling seven-date window, including the chosen current date", () => {
  assert.deepEqual(dates, [
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ]);
  assert.throws(() => getRecentDateKeys("2026-02-30"), /invalid_today/);
});

test("averages only measured sleep and energy; missing chart values stay null", () => {
  const summary = summarizeWeek([
    entry(dates[0], { sleepHours: 6, energy: 4 }),
    entry(dates[2], { sleepHours: 8, energy: null }),
    entry(dates[5], { sleepHours: null, energy: 8 }),
  ], dates);

  assert.equal(summary.activeDays, 3);
  assert.equal(summary.denominator, 7);
  assert.equal(summary.goalPercent, 43);
  assert.equal(summary.averageSleepHours, 7);
  assert.equal(summary.averageEnergy, 6);
  assert.deepEqual(summary.energyByDay.map((day) => day.energy), [4, null, null, null, null, 8, null]);
});

test("empty history keeps averages missing instead of inventing zero values", () => {
  const summary = summarizeWeek([], dates);
  assert.equal(summary.activeDays, 0);
  assert.equal(summary.averageSleepHours, null);
  assert.equal(summary.averageEnergy, null);
  assert.ok(summary.energyByDay.every((day) => day.energy === null));
});

test("validates date window, units, ranges, and requires one measurement", () => {
  assert.deepEqual(validateDailyEntry(draft(dates[6], {
    movementMinutes: "0",
    energy: "7",
  }), dates), {
    ok: true,
    value: entry(dates[6], { movementMinutes: 0, energy: 7 }),
  });

  assert.equal(validateDailyEntry(draft("2026-10-15", { energy: "5" }), dates).ok, false);
  assert.equal(validateDailyEntry(draft(dates[6], { energy: "11" }), dates).ok, false);
  assert.equal(validateDailyEntry(draft(dates[6], { sleepHours: "25" }), dates).ok, false);
  assert.equal(validateDailyEntry(draft(dates[6]), dates).ok, false);
  assert.equal(validateDailyEntry(draft("2026-02-30", { waterMl: "500" }), dates).ok, false);
});

test("upsert replaces a duplicate day and delete removes only the selected day", () => {
  const first = entry(dates[3], { energy: 4 });
  const edited = entry(dates[3], { energy: 9, sleepHours: 7 });
  const other = entry(dates[4], { mood: 6 });
  const saved = upsertDailyEntry([first, other], edited);
  assert.equal(saved.length, 2);
  assert.equal(saved.find((item) => item.date === dates[3]).energy, 9);
  assert.deepEqual(removeDailyEntry(saved, dates[3]), [other]);
});

test("session data helpers use pure values and expose no browser persistence API", () => {
  const source = String(summarizeWeek);
  assert.equal(source.includes("localStorage"), false);
  assert.equal(source.includes("fetch("), false);
});
