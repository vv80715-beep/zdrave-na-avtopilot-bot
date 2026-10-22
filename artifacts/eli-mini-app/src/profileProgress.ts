export type DailyEntry = {
  date: string;
  movementMinutes: number | null;
  sleepHours: number | null;
  energy: number | null;
  mood: number | null;
  waterMl: number | null;
};

export type DailyEntryDraft = {
  date: string;
  movementMinutes: string;
  sleepHours: string;
  energy: string;
  mood: string;
  waterMl: string;
};

export type EntryField =
  | "date"
  | "movementMinutes"
  | "sleepHours"
  | "energy"
  | "mood"
  | "waterMl"
  | "entry";

export type EntryValidation =
  | { ok: true; value: DailyEntry }
  | { ok: false; errors: Partial<Record<EntryField, string>> };

export type WeekSummary = {
  activeDays: number;
  denominator: 7;
  goalPercent: number;
  averageSleepHours: number | null;
  averageEnergy: number | null;
  entries: number;
  energyByDay: Array<{ date: string; energy: number | null }>;
};

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRealDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function getRecentDateKeys(today = localDateKey()): string[] {
  if (!isRealDateKey(today)) throw new TypeError("invalid_today");
  const base = new Date(`${today}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() - (6 - offset));
    return date.toISOString().slice(0, 10);
  });
}

function parseOptionalNumber(
  raw: string,
  field: Exclude<EntryField, "date" | "entry">,
  min: number,
  max: number,
  integer: boolean,
  errors: Partial<Record<EntryField, string>>,
): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    errors[field] = "invalid";
    return null;
  }
  return value;
}

export function validateDailyEntry(
  draft: DailyEntryDraft,
  recentDates: readonly string[],
): EntryValidation {
  const errors: Partial<Record<EntryField, string>> = {};
  if (!isRealDateKey(draft.date) || !recentDates.includes(draft.date)) {
    errors.date = "outside_window";
  }

  const value: DailyEntry = {
    date: draft.date,
    movementMinutes: parseOptionalNumber(draft.movementMinutes, "movementMinutes", 0, 1440, true, errors),
    sleepHours: parseOptionalNumber(draft.sleepHours, "sleepHours", 0.1, 24, false, errors),
    energy: parseOptionalNumber(draft.energy, "energy", 1, 10, true, errors),
    mood: parseOptionalNumber(draft.mood, "mood", 1, 10, true, errors),
    waterMl: parseOptionalNumber(draft.waterMl, "waterMl", 0, 20000, true, errors),
  };

  if (!Object.keys(errors).length && Object.values(value).slice(1).every((item) => item === null)) {
    errors.entry = "one_measurement_required";
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export function upsertDailyEntry(entries: readonly DailyEntry[], entry: DailyEntry): DailyEntry[] {
  return [...entries.filter((item) => item.date !== entry.date), entry]
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function removeDailyEntry(entries: readonly DailyEntry[], date: string): DailyEntry[] {
  return entries.filter((entry) => entry.date !== date);
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeWeek(entries: readonly DailyEntry[], dates: readonly string[]): WeekSummary {
  if (dates.length !== 7) throw new TypeError("week_must_have_seven_dates");
  const dateSet = new Set(dates);
  const byDate = new Map<string, DailyEntry>();
  for (const entry of entries) {
    if (dateSet.has(entry.date)) byDate.set(entry.date, entry);
  }
  const orderedEntries = dates
    .map((date) => byDate.get(date))
    .filter((entry): entry is DailyEntry => Boolean(entry));
  const sleepValues = orderedEntries
    .map((entry) => entry.sleepHours)
    .filter((value): value is number => value !== null);
  const energyValues = orderedEntries
    .map((entry) => entry.energy)
    .filter((value): value is number => value !== null);
  const activeDays = orderedEntries.length;

  return {
    activeDays,
    denominator: 7,
    goalPercent: Math.round((activeDays / 7) * 100),
    averageSleepHours: average(sleepValues),
    averageEnergy: average(energyValues),
    entries: activeDays,
    energyByDay: dates.map((date) => ({
      date,
      energy: byDate.get(date)?.energy ?? null,
    })),
  };
}

export function emptyDailyEntryDraft(date: string): DailyEntryDraft {
  return {
    date,
    movementMinutes: "",
    sleepHours: "",
    energy: "",
    mood: "",
    waterMl: "",
  };
}

export function dailyEntryToDraft(entry: DailyEntry): DailyEntryDraft {
  return {
    date: entry.date,
    movementMinutes: entry.movementMinutes === null ? "" : String(entry.movementMinutes),
    sleepHours: entry.sleepHours === null ? "" : String(entry.sleepHours),
    energy: entry.energy === null ? "" : String(entry.energy),
    mood: entry.mood === null ? "" : String(entry.mood),
    waterMl: entry.waterMl === null ? "" : String(entry.waterMl),
  };
}
