'use strict';

const PLAN_IDS = Object.freeze(['seven_day', 'monthly', 'yearly']);

const PLANS = Object.freeze({
  seven_day: Object.freeze({
    id: 'seven_day',
    name: '7 дни с Ели',
    price: Object.freeze({ amount: 15, currency: 'EUR', display: '€15' }),
    durationDays: 7,
    modes: Object.freeze(['text', 'voice', 'community']),
    avatarMinutesPerMonth: 0,
  }),
  monthly: Object.freeze({
    id: 'monthly',
    name: '1 месец с Ели',
    price: Object.freeze({ amount: 50, currency: 'EUR', display: '€50' }),
    durationDays: 30,
    modes: Object.freeze(['text', 'voice', 'avatar', 'community']),
    avatarMinutesPerMonth: 30,
  }),
  yearly: Object.freeze({
    id: 'yearly',
    name: '1 година с Ели',
    price: Object.freeze({ amount: 360, currency: 'EUR', display: '€360' }),
    durationDays: 365,
    modes: Object.freeze(['text', 'voice', 'avatar', 'community']),
    avatarMinutesPerMonth: 20,
  }),
});

const API_VERSION = 1;

function getPlan(planId) {
  return PLANS[planId] || null;
}

function isValidPlanId(planId) {
  return PLAN_IDS.includes(planId);
}

module.exports = { PLAN_IDS, PLANS, API_VERSION, getPlan, isValidPlanId };
