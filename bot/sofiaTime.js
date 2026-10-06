const SOFIA_TIME_ZONE = 'Europe/Sofia';

// Never depend on the host machine's timezone for user-facing schedules.
// `hourCycle: h23` keeps midnight as 00 instead of 24 on runtimes that support
// both representations.
const sofiaFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SOFIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getSofiaTimeParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');

  const parts = {};
  for (const part of sofiaFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // `% 24` is a defensive fallback for ICU builds that render midnight as 24.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    hhmm: `${pad2(hour)}:${pad2(minute)}`,
  };
}

function getSofiaDateKey(value = new Date()) {
  return getSofiaTimeParts(value).dateKey;
}

module.exports = { SOFIA_TIME_ZONE, getSofiaTimeParts, getSofiaDateKey };
