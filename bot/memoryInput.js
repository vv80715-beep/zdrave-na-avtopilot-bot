'use strict';

const { MEMORY_FIELD_LABELS } = require('./constants');

function validateMemoryField(field, input) {
  if (!Object.prototype.hasOwnProperty.call(MEMORY_FIELD_LABELS, field)) {
    throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  }
  if (field === 'motivationLevel') {
    const value = parseInt(String(input), 10);
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    }
    return value;
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  }
  const text = input.trim();
  return text.toLowerCase() === 'изчисти' ? null : text;
}

module.exports = { validateMemoryField };
