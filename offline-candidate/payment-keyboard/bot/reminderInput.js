const { Markup } = require('telegraf');
const { REMINDER_CATEGORIES, DAY_PRESETS } = require('./constants');

const PRESET_LABELS = {
  everyday: 'Всеки ден',
  weekdays: 'Делници (Пн–Пт)',
  weekends: 'Уикенди (Сб–Нд)',
  custom: 'По избор',
};

const DAYS_KEYBOARD = Markup.keyboard([
  [PRESET_LABELS.everyday],
  [PRESET_LABELS.weekdays],
  [PRESET_LABELS.weekends],
  [PRESET_LABELS.custom],
  ['❌ Отказ'],
])
  .oneTime()
  .resize();

function categoryOptionLabel(c) {
  return `${c.emoji} ${c.label}`;
}

const CATEGORY_KEYBOARD = Markup.keyboard(
  REMINDER_CATEGORIES.map((c) => [categoryOptionLabel(c)]).concat([['❌ Отказ']])
)
  .oneTime()
  .resize();

// Returns a preset day array, the string 'custom', or null for invalid input.
function matchDaysPreset(text) {
  if (text === PRESET_LABELS.everyday) return DAY_PRESETS.everyday;
  if (text === PRESET_LABELS.weekdays) return DAY_PRESETS.weekdays;
  if (text === PRESET_LABELS.weekends) return DAY_PRESETS.weekends;
  if (text === PRESET_LABELS.custom) return 'custom';
  return null;
}

function matchCategory(text) {
  const found = REMINDER_CATEGORIES.find((c) => categoryOptionLabel(c) === text);
  return found ? found.key : null;
}

const CUSTOM_DAYS_PROMPT =
  'Напиши дните, разделени със запетая.\n' +
  'Например: пн, ср, пт\n\n' +
  '(пн, вт, ср, чт, пт, сб, нд)';

module.exports = {
  PRESET_LABELS,
  DAYS_KEYBOARD,
  CATEGORY_KEYBOARD,
  CUSTOM_DAYS_PROMPT,
  categoryOptionLabel,
  matchDaysPreset,
  matchCategory,
};
