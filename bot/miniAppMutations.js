'use strict';

const { REMINDER_CATEGORIES } = require('./constants');
const { validateProfileField } = require('./profileInput');
const { validateMemoryField } = require('./memoryInput');
const { validateCheckinAnswers } = require('./checkinInput');
const { getUser, saveUser } = require('./storage');
const { addWeightEntry, setField } = require('./memoryStorage');
const { extractHealthEvents } = require('./dailyLogTracker');
const { recordEvents } = require('./dailyLogService');
const { saveCheckin, deleteCheckin, getTodayCheckin } = require('./checkinStorage');
const { getReminder, addReminder, updateReminder, deleteReminder } = require('./reminderStorage');
const { parseTime, parseCustomDays } = require('./reminderUtils');
const { isOwnerId } = require('./adminGuard');

const REMINDER_FIELDS = new Set(['title', 'time', 'days', 'category']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ownKeysOnly(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validateProfileValue(field, input) {
  try { return validateProfileField(field, input); } catch { fail('invalid_request'); }
}

function validateMemoryValue(field, input) {
  try { return validateMemoryField(field, input); } catch { fail('invalid_request'); }
}

function validateCheckin(input) {
  try { return validateCheckinAnswers(input); } catch { fail('invalid_request'); }
}

function validateReminder(input, { partial = false } = {}) {
  if (!ownKeysOnly(input, REMINDER_FIELDS)) fail('invalid_request');
  const patch = {};
  if (!partial || Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim()) fail('invalid_request');
    patch.title = input.title.trim();
  }
  if (!partial || Object.hasOwn(input, 'time')) {
    const time = parseTime(input.time);
    if (!time) fail('invalid_request');
    patch.time = time;
  }
  if (!partial || Object.hasOwn(input, 'days')) {
    if (typeof input.days !== 'string') fail('invalid_request');
    const days = parseCustomDays(input.days);
    if (!days) fail('invalid_request');
    patch.days = days;
  }
  if (!partial || Object.hasOwn(input, 'category')) {
    if (typeof input.category !== 'string' ||
        !REMINDER_CATEGORIES.some((category) => category.key === input.category)) fail('invalid_request');
    patch.category = input.category;
  }
  if (partial && !Object.keys(patch).length) fail('invalid_request');
  return patch;
}

function createMiniAppMutationHandler(stores = {}) {
  const readProfile = stores.getUser || getUser;
  const writeProfile = stores.saveUser || saveUser;
  const writeLegacyMemory = stores.setField || setField;
  const appendWeight = stores.addWeightEntry || addWeightEntry;
  const appendHealthEvents = stores.recordEvents || recordEvents;
  const parseHealthEvents = stores.extractHealthEvents || extractHealthEvents;
  const writeCheckin = stores.saveCheckin || saveCheckin;
  const removeCheckin = stores.deleteCheckin || deleteCheckin;
  const readTodayCheckin = stores.getTodayCheckin || getTodayCheckin;
  const ownerCheck = stores.isOwnerId || isOwnerId;
  const reminderStores = {
    getReminder: stores.getReminder || getReminder,
    addReminder: stores.addReminder || addReminder,
    updateReminder: stores.updateReminder || updateReminder,
    deleteReminder: stores.deleteReminder || deleteReminder,
  };

  return async function mutateMiniAppRecord({ userId, action, payload }) {
    const id = String(userId);
    if (!/^[1-9]\d{4,19}$/.test(id) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('invalid_request');
    }
    switch (action) {
      case 'profile.update': {
        if (!ownKeysOnly(payload, new Set(['field', 'value'])) ||
            typeof payload.field !== 'string' || !Object.hasOwn(payload, 'value')) fail('invalid_request');
        const profile = readProfile(id);
        if (!profile) fail('profile_not_found');
        const value = validateProfileValue(payload.field, payload.value);
        const updated = { ...profile, [payload.field]: value, updatedAt: new Date().toISOString() };
        writeProfile(id, updated);
        if (payload.field === 'weight' && !ownerCheck(id)) appendWeight(id, value);
        return { action, record: updated };
      }
      case 'memory.update': {
        if (!ownKeysOnly(payload, new Set(['field', 'value'])) ||
            typeof payload.field !== 'string' || !Object.hasOwn(payload, 'value')) fail('invalid_request');
        const value = validateMemoryValue(payload.field, payload.value);
        return { action, record: writeLegacyMemory(id, payload.field, value) };
      }
      case 'health.append': {
        if (!ownKeysOnly(payload, new Set(['text'])) ||
            typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 1200) fail('invalid_request');
        const events = parseHealthEvents(payload.text.trim());
        if (!events.length) fail('health_event_not_recognized');
        return { action, records: appendHealthEvents(id, events) };
      }
      case 'checkin.save': {
        if (!ownKeysOnly(payload, new Set(['answers']))) fail('invalid_request');
        const answers = validateCheckin(payload.answers);
        writeCheckin(id, answers);
        return { action, record: readTodayCheckin(id) };
      }
      case 'checkin.delete': {
        if (!ownKeysOnly(payload, new Set(['date'])) ||
            typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) fail('invalid_request');
        if (new Date(`${payload.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== payload.date) {
          fail('invalid_request');
        }
        if (!removeCheckin(id, payload.date)) fail('record_not_found');
        return { action, date: payload.date };
      }
      case 'reminder.create': {
        if (ownerCheck(id)) fail('owner_only');
        return { action, record: reminderStores.addReminder(id, validateReminder(payload)) };
      }
      case 'reminder.update': {
        if (ownerCheck(id)) fail('owner_only');
        if (!ownKeysOnly(payload, new Set(['id', 'patch'])) ||
            typeof payload.id !== 'string' || !payload.id || !payload.patch ||
            typeof payload.patch !== 'object' || Array.isArray(payload.patch)) fail('invalid_request');
        if (!reminderStores.getReminder(id, payload.id)) fail('record_not_found');
        const record = reminderStores.updateReminder(id, payload.id, validateReminder(payload.patch, { partial: true }));
        if (!record) fail('record_not_found');
        return { action, record };
      }
      case 'reminder.delete': {
        if (ownerCheck(id)) fail('owner_only');
        if (!ownKeysOnly(payload, new Set(['id'])) || typeof payload.id !== 'string' || !payload.id) fail('invalid_request');
        if (!reminderStores.deleteReminder(id, payload.id)) fail('record_not_found');
        return { action, id: payload.id };
      }
      default:
        fail('invalid_request');
    }
  };
}

const processMiniAppMutation = createMiniAppMutationHandler();

module.exports = { createMiniAppMutationHandler, processMiniAppMutation };
