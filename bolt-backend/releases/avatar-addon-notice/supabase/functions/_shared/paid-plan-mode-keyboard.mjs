const MODE_LABELS = Object.freeze({
  text: 'Пиши с Ели',
  voice: 'Говори с Ели',
  avatar: 'Говори с аватара на Ели',
});

const PRICE_CENTS = Object.freeze({
  seven_day: 1500,
  monthly: 5000,
  yearly: 36000,
});

export function paidPlanModeKeyboard(planId) {
  if (!Object.hasOwn(PRICE_CENTS, planId)) return null;
  const labels = [MODE_LABELS.text, MODE_LABELS.voice];
  if (planId !== 'seven_day') labels.push(MODE_LABELS.avatar);
  return { keyboard: [labels], resize_keyboard: true, one_time_keyboard: false };
}

export function isSupportedPlanPaymentAmount(planId, amountCents, ownerTestVerified = false) {
  if (!Number.isSafeInteger(amountCents) || !Object.hasOwn(PRICE_CENTS, planId)) return false;
  return amountCents === PRICE_CENTS[planId] || (amountCents === 50 && ownerTestVerified === true);
}

export function expectedPlanAmountCents(planId) {
  return Object.hasOwn(PRICE_CENTS, planId) ? PRICE_CENTS[planId] : null;
}
