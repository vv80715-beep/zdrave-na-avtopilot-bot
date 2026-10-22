import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "../../../docs/schemas/eli-mini-app-profile-progress.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function within(value, min, max, nullable = false) {
  return (nullable && value === null) ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function exactKeys(value, required) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...required].sort().join(",");
}

function matchesContract(value) {
  if (!exactKeys(value, ["mode", "window", "profile", "progress"]) || value.mode !== "read_only") return false;
  if (!exactKeys(value.window, ["from", "to", "days"]) ||
      !validDate(value.window.from) || !validDate(value.window.to) || value.window.days !== 7) return false;
  if (value.window.to !== addDays(value.window.from, 6)) return false;
  if (!exactKeys(value.profile, ["weeklyMovementGoalDays"]) ||
      !within(value.profile.weeklyMovementGoalDays, 1, 7, true) ||
      (value.profile.weeklyMovementGoalDays !== null && !Number.isInteger(value.profile.weeklyMovementGoalDays))) return false;
  const progress = value.progress;
  if (!exactKeys(progress, [
    "activeDays", "denominator", "goalPercent", "averageSleepHours",
    "averageEnergy", "energyByDay", "recordsIncluded",
  ])) return false;
  if (!Number.isInteger(progress.activeDays) || !within(progress.activeDays, 0, 7) ||
      progress.denominator !== 7 ||
      !within(progress.goalPercent, 0, 100, true) ||
      !within(progress.averageSleepHours, 0.1, 24, true) ||
      !within(progress.averageEnergy, 1, 10, true) ||
      !Number.isInteger(progress.recordsIncluded) || !within(progress.recordsIncluded, 0, 7) ||
      progress.recordsIncluded !== progress.activeDays ||
      progress.goalPercent !== (progress.activeDays === 0 ? null : Math.round((progress.activeDays / 7) * 100)) ||
      !Array.isArray(progress.energyByDay) || progress.energyByDay.length !== 7) return false;
  return progress.energyByDay.every((day, index) =>
    exactKeys(day, ["date", "energy"]) &&
    validDate(day.date) &&
    day.date === addDays(value.window.from, index) &&
    within(day.energy, 1, 10, true) &&
    (day.energy === null || Number.isInteger(day.energy))
  );
}

function syntheticResponse() {
  const days = [
    ["2026-10-16", 4],
    ["2026-10-17", null],
    ["2026-10-18", null],
    ["2026-10-19", 7],
    ["2026-10-20", null],
    ["2026-10-21", null],
    ["2026-10-22", null],
  ];
  return {
    mode: "read_only",
    window: { from: "2026-10-16", to: "2026-10-22", days: 7 },
    profile: { weeklyMovementGoalDays: null },
    progress: {
      activeDays: 2,
      denominator: 7,
      goalPercent: 29,
      averageSleepHours: 7.5,
      averageEnergy: 5.5,
      energyByDay: days.map(([date, energy]) => ({ date, energy })),
      recordsIncluded: 2,
    },
  };
}

test("publishes a strict read-only schema with only aggregate fields", () => {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["mode", "window", "profile", "progress"]);
  assert.equal(schema.properties.mode.const, "read_only");
  assert.equal(schema.properties.progress.properties.denominator.const, 7);
});

test("accepts a synthetic aggregate response and preserves missing energy as null", () => {
  const response = syntheticResponse();
  assert.equal(matchesContract(response), true);
  assert.equal(response.progress.energyByDay[1].energy, null);
  assert.equal(response.progress.averageEnergy, 5.5);
});

test("rejects raw identifiers, health entries, malformed ranges, and short windows", () => {
  const withTelegramId = { ...syntheticResponse(), telegramUserId: "synthetic" };
  const withRawEntries = syntheticResponse();
  withRawEntries.progress = { ...withRawEntries.progress, entries: [{ raw: "synthetic" }] };
  const invalidAverage = syntheticResponse();
  invalidAverage.progress = { ...invalidAverage.progress, averageEnergy: 11 };
  const malformedDateRange = syntheticResponse();
  malformedDateRange.window.to = "2026-10-21";
  const shortWindow = syntheticResponse();
  shortWindow.progress = { ...shortWindow.progress, energyByDay: shortWindow.progress.energyByDay.slice(1) };

  for (const candidate of [withTelegramId, withRawEntries, invalidAverage, malformedDateRange, shortWindow]) {
    assert.equal(matchesContract(candidate), false);
  }
});

test("empty synthetic response uses null averages and no invented energy values", () => {
  const response = syntheticResponse();
  response.progress = {
    ...response.progress,
    activeDays: 0,
    goalPercent: null,
    averageSleepHours: null,
    averageEnergy: null,
    energyByDay: response.progress.energyByDay.map(({ date }) => ({ date, energy: null })),
    recordsIncluded: 0,
  };
  assert.equal(matchesContract(response), true);
});
