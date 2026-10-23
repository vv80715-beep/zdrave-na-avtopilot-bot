'use strict';

const CHECKIN_FIELDS = new Set(['water', 'trained', 'nutrition', 'sleep', 'mood', 'energy']);

function validateCheckinAnswers(input) {
  const fail = () => { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !CHECKIN_FIELDS.has(key)) ||
      ['water', 'trained', 'nutrition'].some((key) => typeof input[key] !== 'boolean') ||
      !Number.isFinite(input.sleep) || input.sleep < 0 || input.sleep > 24 ||
      !Number.isInteger(input.mood) || input.mood < 1 || input.mood > 10 ||
      !Number.isInteger(input.energy) || input.energy < 1 || input.energy > 10) fail();
  return {
    water: input.water,
    trained: input.trained,
    nutrition: input.nutrition,
    sleep: input.sleep,
    mood: input.mood,
    energy: input.energy,
  };
}

module.exports = { validateCheckinAnswers };
