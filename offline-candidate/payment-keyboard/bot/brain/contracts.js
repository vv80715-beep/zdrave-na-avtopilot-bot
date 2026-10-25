'use strict';

// Public contracts for the Eli V2.2 foundation. These are intentionally
// provider- and storage-agnostic: this phase must not read or write production
// data, call OpenAI, or decide how Telegram delivers the final answer.

const BRAIN_CONTRACT_VERSION = 'eli-v2.2-foundation/v1';

const BRAIN_CHANNELS = Object.freeze([
  'text',
  'voice',
  'avatar',
  'daily_coaching',
  'reminder',
  'plan',
]);

const DELIVERY_MODES = Object.freeze(['text', 'voice', 'avatar']);

const BRAIN_PURPOSES = Object.freeze([
  'conversation',
  'daily_coaching',
  'reminder',
  'plan',
]);

const SAFETY_LEVELS = Object.freeze(['wellness', 'medical_caution', 'urgent']);

const MEMORY_CANDIDATE_DECISIONS = Object.freeze(['candidate', 'ignore']);

function normalizeUserId(userId) {
  if (userId === undefined || userId === null || String(userId).trim() === '') {
    throw new TypeError('Eli Brain requires a Telegram user id.');
  }
  return String(userId);
}

function assertAllowed(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new RangeError(label + ' must be one of: ' + allowed.join(', '));
  }
  return value;
}

function asText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function cloneArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function defaultPurposeForChannel(channel) {
  if (channel === 'daily_coaching') return 'daily_coaching';
  if (channel === 'reminder') return 'reminder';
  if (channel === 'plan') return 'plan';
  return 'conversation';
}

function defaultDeliveryModeForChannel(channel) {
  return DELIVERY_MODES.includes(channel) ? channel : 'text';
}

// A normalized input packet shared by Text, Voice, Avatar, daily coaching,
// reminders and plans. It only carries data already obtained by the caller.
function createBrainRequest(input = {}) {
  const channel = input.channel || 'text';
  const purpose = input.purpose || defaultPurposeForChannel(channel);
  const deliveryMode = input.deliveryMode || defaultDeliveryModeForChannel(channel);

  assertAllowed(channel, BRAIN_CHANNELS, 'channel');
  assertAllowed(purpose, BRAIN_PURPOSES, 'purpose');
  assertAllowed(deliveryMode, DELIVERY_MODES, 'deliveryMode');

  return {
    contractVersion: BRAIN_CONTRACT_VERSION,
    userId: normalizeUserId(input.userId),
    channel,
    deliveryMode,
    purpose,
    message: asText(input.message),
    conversationState: input.conversationState || 'unknown',
    profile: input.profile || null,
    longTermFacts: cloneArray(input.longTermFacts),
    healthEvents: cloneArray(input.healthEvents),
    shortContext: cloneArray(input.shortContext),
    now: input.now || null,
  };
}

module.exports = {
  BRAIN_CONTRACT_VERSION,
  BRAIN_CHANNELS,
  DELIVERY_MODES,
  BRAIN_PURPOSES,
  SAFETY_LEVELS,
  MEMORY_CANDIDATE_DECISIONS,
  createBrainRequest,
  normalizeUserId,
};
