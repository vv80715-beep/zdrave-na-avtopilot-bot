'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validUserId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function validateProfile(value) {
  if (!isPlainObject(value)) return ['profile_not_object'];
  const issues = [];
  const stringFields = ['firstName', 'gender', 'goal', 'activityLevel', 'trainingExperience', 'foodPreferences', 'medicalNotes'];
  const numberFields = ['age', 'height', 'weight'];
  for (const field of stringFields) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      issues.push(field + '_not_string');
    }
  }
  for (const field of numberFields) {
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      (typeof value[field] !== 'number' || !Number.isFinite(value[field]))
    ) {
      issues.push(field + '_not_number');
    }
  }
  return issues;
}

function validateUserMemory(value) {
  if (!isPlainObject(value)) return ['user_memory_not_object'];
  const issues = [];
  if (value.conversation !== undefined && !Array.isArray(value.conversation)) {
    issues.push('conversation_not_array');
  }
  if (Array.isArray(value.conversation)) {
    value.conversation.forEach((message, index) => {
      if (
        !isPlainObject(message) ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        !message.content.trim()
      ) {
        issues.push('conversation_' + index + '_invalid');
      }
    });
  }
  return issues;
}

function validateRelationshipMemory(value) {
  if (!isPlainObject(value)) return ['relationship_memory_not_object'];
  if (value.memories !== undefined && !Array.isArray(value.memories)) {
    return ['relationship_memories_not_array'];
  }
  const issues = [];
  for (const [index, item] of (value.memories || []).entries()) {
    if (
      !isPlainObject(item) ||
      typeof item.value !== 'string' ||
      !item.value.trim() ||
      (item.category !== undefined && typeof item.category !== 'string')
    ) {
      issues.push('relationship_memory_' + index + '_invalid');
    }
  }
  return issues;
}

function validateDailyLogs(value) {
  if (!isPlainObject(value)) return ['daily_logs_not_object'];
  const issues = [];
  for (const [date, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      issues.push('daily_log_' + date + '_not_array');
      continue;
    }
    entries.forEach((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.category !== 'string' || !entry.category.trim()) {
        issues.push('daily_log_' + date + '_' + index + '_invalid');
      }
    });
  }
  return issues;
}

function validateCheckins(value) {
  if (!isPlainObject(value)) return ['checkins_not_object'];
  const issues = [];
  for (const [date, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) issues.push('checkin_' + date + '_invalid');
  }
  return issues;
}

function validateReminders(value) {
  if (!Array.isArray(value)) return ['reminders_not_array'];
  const issues = [];
  value.forEach((item, index) => {
    if (
      !isPlainObject(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      typeof item.time !== 'string' ||
      !/^\d{2}:\d{2}$/.test(item.time)
    ) {
      issues.push('reminder_' + index + '_invalid');
    }
  });
  return issues;
}

function validateConversationState(value) {
  if (value === undefined || value === null) return [];
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? [] : ['conversation_state_invalid'];
}

function collectUserIssues(userId, sources = {}) {
  const issues = [];
  if (!validUserId(userId)) issues.push({ source: 'telegram_user_id', code: 'invalid_user_id' });

  const checks = [
    ['users', validateProfile],
    ['userMemory', validateUserMemory],
    ['relationshipMemory', validateRelationshipMemory],
    ['dailyLogs', validateDailyLogs],
    ['checkins', validateCheckins],
    ['reminders', validateReminders],
  ];

  for (const [name, validator] of checks) {
    if (!Object.prototype.hasOwnProperty.call(sources[name] || {}, userId)) continue;
    for (const code of validator(sources[name][userId])) {
      issues.push({ source: name, code });
    }
  }

  const state = sources.conversationState || {};
  if (Object.prototype.hasOwnProperty.call(state, userId)) {
    for (const code of validateConversationState(state[userId])) {
      issues.push({ source: 'conversationState', code });
    }
  }

  return issues;
}

module.exports = {
  isPlainObject,
  validUserId,
  validateProfile,
  validateUserMemory,
  validateRelationshipMemory,
  validateDailyLogs,
  validateCheckins,
  validateReminders,
  validateConversationState,
  collectUserIssues,
};
