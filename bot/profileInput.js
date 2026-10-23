'use strict';

const { FIELD_CHOICES, FIELD_LABELS } = require('./constants');

function validateProfileField(field, input) {
  if (!Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)) {
    throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  }
  if (FIELD_CHOICES[field]) {
    if (field === 'gender' && (input === null || input === 'Пропусни')) return null;
    if (typeof input !== 'string' || !FIELD_CHOICES[field].includes(input.trim())) {
      throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    }
    return input.trim();
  }
  if (field === 'age') {
    const value = parseInt(String(input), 10);
    if (!Number.isInteger(value) || value < 10 || value > 120) {
      throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    }
    return value;
  }
  if (field === 'height' || field === 'weight') {
    const value = parseFloat(String(input));
    const min = field === 'height' ? 100 : 20;
    const max = field === 'height' ? 250 : 500;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    }
    return value;
  }
  const text = typeof input === 'string' ? input.trim() : '';
  if (field === 'foodPreferences' || field === 'medicalNotes') {
    return !text || text.toLowerCase() === 'нямам' ? null : text;
  }
  if (!text) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  return text;
}

module.exports = { validateProfileField };
