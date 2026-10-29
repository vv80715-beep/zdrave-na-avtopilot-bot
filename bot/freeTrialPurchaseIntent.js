const { planKeyboard } = require('./planLinks');
const { isActiveFreeTrial } = require('./freeTrialHandoff');

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('bg')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const NEGATIVE_PATTERNS = [
  /\bне искам (?:да )?(?:купя|взема|платя|се абонирам)\b/,
  /\bняма да (?:купувам|взимам|плащам)\b/,
  /\bне ми трябва (?:план|абонамент|премиум)\b/,
];

const DIRECT_PURCHASE_PATTERNS = [
  /\bискам (?:да )?(?:си )?(?:купя|взема|активирам) (?:план|абонамент|премиум)\b/,
  /\bискам (?:план|абонамент|премиум)\b/,
  /\bискам (?:да )?(?:се )?абонирам\b/,
  /\bкак (?:да|мога да) (?:си )?(?:купя|взема|активирам) (?:план|абонамент)\b/,
  /\bкак (?:да|мога да) (?:се )?абонирам\b/,
  /\bискам (?:да )?платя за (?:план|абонамент|премиум)\b/,
  /\bискам (?:7 дневния|7 дневен|седемдневния|месечния|месечен|годишния|годишен) план\b/,
  /\b(?:купи|купи ми|дай ми) (?:план|абонамент)\b/,
  /\bпокажи (?:ми )?(?:плановете|абонаментите)\b/,
  /\bискам (?:да )?видя (?:плановете|абонаментите)\b/,
];

function isPurchaseIntent(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return DIRECT_PURCHASE_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function handleFreeTrialPurchaseIntent(ctx, message, status) {
  if (!isActiveFreeTrial(status) || !isPurchaseIntent(message)) return false;
  await ctx.reply(
    'Разбира се. Избери кой план искаш да активираш:',
    planKeyboard()
  );
  return true;
}

module.exports = {
  isPurchaseIntent,
  handleFreeTrialPurchaseIntent,
};
