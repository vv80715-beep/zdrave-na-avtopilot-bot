const {
  CATEGORY_EMOJI,
  DAY_SHORT,
  DAY_DISPLAY_ORDER,
  DAY_PRESETS,
  DAY_ABBR,
} = require('./constants');

function sameDays(a, b) {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// Normalize "9:5" / "09:05" / "9.5" → "09:05", or null if invalid.
function parseTime(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^([01]?\d|2[0-3])[:.\s]([0-5]\d)$/);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, '0');
  const mm = m[2];
  return `${hh}:${mm}`;
}

// Parse a free-text list of Bulgarian day names/abbreviations into a unique,
// ordered array of getDay() indexes. Returns null if nothing valid was found.
function parseCustomDays(text) {
  if (!text) return null;
  const tokens = String(text)
    .toLowerCase()
    .split(/[\s,;/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const found = new Set();
  for (const t of tokens) {
    if (Object.prototype.hasOwnProperty.call(DAY_ABBR, t)) {
      found.add(DAY_ABBR[t]);
    }
  }
  if (found.size === 0) return null;
  return DAY_DISPLAY_ORDER.filter((d) => found.has(d));
}

function formatDays(days) {
  if (!Array.isArray(days) || days.length === 0) return '—';
  if (sameDays(days, DAY_PRESETS.everyday)) return 'всеки ден';
  if (sameDays(days, DAY_PRESETS.weekdays)) return 'делници (Пн–Пт)';
  if (sameDays(days, DAY_PRESETS.weekends)) return 'уикенди (Сб–Нд)';
  return DAY_DISPLAY_ORDER.filter((d) => days.includes(d))
    .map((d) => DAY_SHORT[d])
    .join(', ');
}

function reminderLine(r) {
  const emoji = CATEGORY_EMOJI[r.category] || '⏰';
  const status = r.paused ? ' ⏸️' : '';
  return `${emoji} ${r.title} — ${r.time} · ${formatDays(r.days)}${status}`;
}

module.exports = {
  parseTime,
  parseCustomDays,
  formatDays,
  reminderLine,
  sameDays,
};
