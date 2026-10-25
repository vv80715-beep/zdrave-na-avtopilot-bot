'use strict';

const { BRAIN_CONTRACT_VERSION, normalizeUserId } = require('./contracts');

const HEALTH_PROFILE_VERSION = BRAIN_CONTRACT_VERSION + '/health-profile';

const FIELD_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  KNOWN: 'known',
});

// A null value is not used to mean "none". Every profile value is wrapped in a
// field object so unknown information remains explicitly unknown until the
// person supplies or confirms it.
const PROFILE_FIELD_PATHS = Object.freeze({
  'identity.firstName': 'Име',
  'identity.age': 'Възраст',
  'identity.gender': 'Пол',
  'identity.heightCm': 'Височина',
  'identity.weightKg': 'Тегло',
  'goals.primary': 'Основна цел',
  'goals.supporting': 'Допълнителни цели',
  'nutrition.preferences': 'Хранителни предпочитания',
  'nutrition.dislikedFoods': 'Нелюбими храни',
  'nutrition.allergies': 'Алергии',
  'sleep.bedtime': 'Час за лягане',
  'sleep.wakeTime': 'Час за ставане',
  'sleep.notes': 'Бележки за съня',
  'activity.level': 'Ниво на активност',
  'activity.trainingExperience': 'Опит с тренировки',
  'activity.preferredActivities': 'Предпочитани активности',
  'activity.routine': 'Текущ тренировъчен режим',
  'habits.focus': 'Навици на фокус',
  'habits.blockers': 'Пречки за навиците',
  'communication.responseLength': 'Предпочитана дължина на отговорите',
  'communication.tone': 'Предпочитан тон',
  'progress.highlights': 'Важен прогрес',
  'medical.userProvidedNotes': 'Изрично споделени медицински бележки',
});

function unknownField() {
  return {
    status: FIELD_STATUS.UNKNOWN,
    value: null,
    source: null,
    updatedAt: null,
  };
}

function knownField(value, metadata = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new TypeError('A known health-profile value must be non-empty.');
  }

  return {
    status: FIELD_STATUS.KNOWN,
    value,
    source: metadata.source || 'explicit_user_statement',
    updatedAt: metadata.updatedAt || null,
  };
}

function createUnknownHealthProfile(userId, metadata = {}) {
  return {
    contractVersion: HEALTH_PROFILE_VERSION,
    userId: normalizeUserId(userId),
    createdAt: metadata.createdAt || null,
    updatedAt: metadata.updatedAt || null,
    identity: {
      firstName: unknownField(),
      age: unknownField(),
      gender: unknownField(),
      heightCm: unknownField(),
      weightKg: unknownField(),
    },
    goals: {
      primary: unknownField(),
      supporting: unknownField(),
    },
    nutrition: {
      preferences: unknownField(),
      dislikedFoods: unknownField(),
      allergies: unknownField(),
    },
    sleep: {
      bedtime: unknownField(),
      wakeTime: unknownField(),
      notes: unknownField(),
    },
    activity: {
      level: unknownField(),
      trainingExperience: unknownField(),
      preferredActivities: unknownField(),
      routine: unknownField(),
    },
    habits: {
      focus: unknownField(),
      blockers: unknownField(),
    },
    communication: {
      responseLength: unknownField(),
      tone: unknownField(),
    },
    progress: {
      highlights: unknownField(),
    },
    medical: {
      userProvidedNotes: unknownField(),
    },
  };
}

function assertProfilePath(path) {
  if (!Object.prototype.hasOwnProperty.call(PROFILE_FIELD_PATHS, path)) {
    throw new RangeError('Unknown unified health-profile field: ' + path);
  }
}

function getProfileField(profile, path) {
  assertProfilePath(path);
  const parts = path.split('.');
  let current = profile;
  for (const part of parts) {
    current = current && current[part];
  }
  return current && typeof current === 'object' ? current : unknownField();
}

function isKnownField(field) {
  return Boolean(field && field.status === FIELD_STATUS.KNOWN);
}

function comparableValue(value) {
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  return JSON.stringify(value);
}

function sameValue(left, right) {
  return comparableValue(left) === comparableValue(right);
}

// This produces a proposal only. It never mutates a profile or writes storage.
// A conflicting ordinary statement requires confirmation; a direct "change X
// to Y" command is explicit enough to replace the old value safely.
function createProfileFieldUpdateProposal(profile, path, value, options = {}) {
  const current = getProfileField(profile, path);
  const proposed = knownField(value, {
    source: options.source || 'explicit_user_statement',
    updatedAt: options.updatedAt || null,
  });

  if (!isKnownField(current)) {
    return {
      contractVersion: HEALTH_PROFILE_VERSION,
      path,
      action: 'set',
      requiresConfirmation: false,
      current,
      proposed,
    };
  }

  if (sameValue(current.value, proposed.value)) {
    return {
      contractVersion: HEALTH_PROFILE_VERSION,
      path,
      action: 'unchanged',
      requiresConfirmation: false,
      current,
      proposed,
    };
  }

  if (options.explicitCommand === true) {
    return {
      contractVersion: HEALTH_PROFILE_VERSION,
      path,
      action: 'replace',
      requiresConfirmation: false,
      current,
      proposed,
    };
  }

  return {
    contractVersion: HEALTH_PROFILE_VERSION,
    path,
    action: 'requires_confirmation',
    requiresConfirmation: true,
    current,
    proposed,
  };
}

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function setProfileField(profile, path, field) {
  const parts = path.split('.');
  let target = profile;
  for (let i = 0; i < parts.length - 1; i += 1) {
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = field;
}

// The future repository layer may call this only after its confirmation flow.
// It is pure so the first V2.2 step cannot alter existing JSON user data.
function applyApprovedProfileFieldUpdate(profile, proposal, options = {}) {
  if (!proposal || !proposal.path || !proposal.proposed) {
    throw new TypeError('A valid profile update proposal is required.');
  }
  assertProfilePath(proposal.path);

  if (proposal.requiresConfirmation && options.confirmed !== true) {
    return {
      applied: false,
      reason: 'confirmation_required',
      profile,
    };
  }

  if (proposal.action === 'unchanged') {
    return {
      applied: false,
      reason: 'unchanged',
      profile,
    };
  }

  const next = cloneProfile(profile);
  setProfileField(next, proposal.path, proposal.proposed);
  next.updatedAt = options.updatedAt || next.updatedAt || null;
  return {
    applied: true,
    reason: proposal.action,
    profile: next,
  };
}

function getKnownProfileEntries(profile) {
  const entries = [];
  for (const [path, label] of Object.entries(PROFILE_FIELD_PATHS)) {
    const field = getProfileField(profile, path);
    if (isKnownField(field)) {
      entries.push({
        path,
        label,
        value: field.value,
        source: field.source,
        updatedAt: field.updatedAt,
      });
    }
  }
  return entries;
}

function getUnknownProfilePaths(profile) {
  return Object.keys(PROFILE_FIELD_PATHS).filter((path) => !isKnownField(getProfileField(profile, path)));
}

module.exports = {
  HEALTH_PROFILE_VERSION,
  FIELD_STATUS,
  PROFILE_FIELD_PATHS,
  unknownField,
  knownField,
  createUnknownHealthProfile,
  getProfileField,
  isKnownField,
  createProfileFieldUpdateProposal,
  applyApprovedProfileFieldUpdate,
  getKnownProfileEntries,
  getUnknownProfilePaths,
};
