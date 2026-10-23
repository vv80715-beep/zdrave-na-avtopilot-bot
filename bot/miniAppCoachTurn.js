'use strict';

const ACTIONS = new Set(['coach', 'motivate', 'nextstep', 'weeklyreview']);

function createMiniAppCoachTurnHandler({
  resolveReadOnlyAccessStatus,
  hasTextAIProvider,
  getTextAIClient,
  isOwnerId,
  generateCoach,
  generateMotivate,
  generateNextStep,
  generateWeeklyReview,
  hasWeeklyData,
  now = Date.now,
  minIntervalMs = 5000,
}) {
  const lastRequest = new Map();
  const active = new Set();
  const generators = { coach: generateCoach, motivate: generateMotivate, nextstep: generateNextStep, weeklyreview: generateWeeklyReview };
  if (![resolveReadOnlyAccessStatus, hasTextAIProvider, getTextAIClient, isOwnerId,
    generateCoach, generateMotivate, generateNextStep, generateWeeklyReview, hasWeeklyData]
    .every((fn) => typeof fn === 'function')) throw new TypeError('Mini App coach dependencies are required.');

  return async function processMiniAppCoachTurn({ userId, action }) {
    const id = String(userId);
    if (!/^[1-9]\d{4,19}$/.test(id) || !ACTIONS.has(action)) {
      throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    }
    if (action === 'weeklyreview' && !hasWeeklyData(id)) return { kind: 'no_data', text: '' };
    if (active.has(id) || now() - (lastRequest.get(id) || 0) < minIntervalMs) {
      throw Object.assign(new Error('coach_rate_limited'), { code: 'coach_rate_limited' });
    }
    active.add(id);
    lastRequest.set(id, now());
    try {
      const status = await resolveReadOnlyAccessStatus({ from: { id } });
      if (!status?.canChat) return { kind: 'access_denied', text: 'Достъпът до чата не е активен.' };
      if (!hasTextAIProvider(id)) throw Object.assign(new Error('text_ai_unavailable'), { code: 'text_ai_unavailable' });
      const client = getTextAIClient(id);
      if (!client) throw Object.assign(new Error('text_ai_unavailable'), { code: 'text_ai_unavailable' });
      const persist = !isOwnerId(id);
      const text = action === 'coach' ? await generateCoach(client, id, { persist })
        : action === 'motivate' ? await generateMotivate(client, id, { persist })
          : action === 'nextstep' ? await generateNextStep(client, id)
            : await generateWeeklyReview(client, id);
      if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('coach_empty_response'), { code: 'coach_empty_response' });
      return { kind: 'coaching', text: text.trim() };
    } finally {
      active.delete(id);
    }
  };
}

module.exports = { createMiniAppCoachTurnHandler, MINI_APP_COACH_ACTIONS: [...ACTIONS] };
