// ─────────────────────────────────────────────────────────────────────────────
// Canonical plan presentation. Payment-session creation lives separately in
// commands/plans.js; this module remains static and zero-cost.
// ─────────────────────────────────────────────────────────────────────────────

const { Markup } = require('telegraf');

const PLAN_OPTIONS = [
  {
    key: 'seven_day',
    callback: 'buy:seven_day',
    label: '7 дни — €15',
  },
  {
    key: 'monthly',
    callback: 'buy:monthly',
    label: 'Месечен — €50',
  },
  {
    key: 'yearly',
    callback: 'buy:yearly',
    label: 'Годишен — €360',
  },
];

const PLANS_TEXT =
  '7 days — €15\n' +
  'Text + Voice + Community\n' +
  'No Avatar\n\n' +
  'Monthly — €50\n' +
  'Text + Voice + Avatar + Community\n' +
  '30 Avatar minutes/month\n\n' +
  'Yearly — €360\n' +
  'Text + Voice + Avatar + Community\n' +
  '20 Avatar minutes/month';

function planKeyboard() {
  return Markup.inlineKeyboard(
    PLAN_OPTIONS.map((opt) => [
      Markup.button.callback(opt.label, opt.callback),
    ])
  );
}

function planDiscoveryKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Планове и абонамент', 'show_plans')],
  ]);
}

module.exports = {
  PLAN_OPTIONS,
  PLANS_TEXT,
  planKeyboard,
  planDiscoveryKeyboard,
};
