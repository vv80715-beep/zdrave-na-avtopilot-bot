const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BRAIN_CHANNELS,
  createBrainRequest,
} = require('../brain/contracts');
const {
  FIELD_STATUS,
  createUnknownHealthProfile,
  getProfileField,
  applyApprovedProfileFieldUpdate,
} = require('../brain/unifiedHealthProfile');
const {
  buildContext,
  renderContextForModel,
} = require('../brain/contextBuilder');
const { extractMemoryCandidate } = require('../brain/memoryCandidate');
const {
  ELI_V2_2_FLAG_DEFAULTS,
  getEliV22Flags,
  resolveEliV22Flags,
} = require('../brain/featureFlags');

const USER_A = '100001';

test('brain request has one valid contract for every supported channel', () => {
  for (const channel of BRAIN_CHANNELS) {
    const request = createBrainRequest({ userId: USER_A, channel, message: 'Здравей' });
    assert.equal(request.userId, USER_A);
    assert.equal(request.channel, channel);
    assert.ok(request.purpose);
    assert.ok(request.deliveryMode);
  }

  assert.throws(
    () => createBrainRequest({ userId: USER_A, channel: 'email' }),
    /channel must be one of/
  );
});

test('unknown health profile fields stay unknown and never become invented facts', () => {
  const profile = createUnknownHealthProfile(USER_A);
  const context = buildContext({
    userId: USER_A,
    channel: 'text',
    message: 'Как да подобря съня си?',
    profile,
  });
  const rendered = renderContextForModel(context);

  assert.equal(getProfileField(profile, 'sleep.bedtime').status, FIELD_STATUS.UNKNOWN);
  assert.equal(getProfileField(profile, 'sleep.wakeTime').status, FIELD_STATUS.UNKNOWN);
  assert.deepEqual(context.knownProfile, []);
  assert.ok(context.unknownProfilePaths.includes('sleep.bedtime'));
  assert.doesNotMatch(rendered, /Час за лягане:\s*(?:няма|23:00|22:00)/iu);
  assert.match(rendered, /Не превръщай липсата на данни в предположение/iu);
});

test('a clear goal becomes a proposal and is available in a later context', () => {
  const initial = createUnknownHealthProfile(USER_A);
  const candidate = extractMemoryCandidate({
    message: 'Целта ми е да сваля 5 кг.',
    profile: initial,
  });

  assert.equal(candidate.decision, 'candidate');
  assert.equal(candidate.persistence, 'not_persisted');
  assert.equal(candidate.candidate.path, 'goals.primary');
  assert.equal(candidate.candidate.value, 'да сваля 5 кг');
  assert.equal(candidate.candidate.proposal.action, 'set');

  // This is an in-memory contract application only; no JSON or database write.
  const applied = applyApprovedProfileFieldUpdate(initial, candidate.candidate.proposal);
  assert.equal(applied.applied, true);

  const newConversationContext = buildContext({
    userId: USER_A,
    channel: 'text',
    message: 'Как да започна разумно?',
    profile: applied.profile,
  });
  const goal = newConversationContext.knownProfile.find((entry) => entry.path === 'goals.primary');
  assert.equal(goal.value, 'да сваля 5 кг');
});

test('a changed fact requires confirmation unless the user gives an explicit change command', () => {
  const initial = createUnknownHealthProfile(USER_A);
  const first = extractMemoryCandidate({
    message: 'Целта ми е да сваля 5 кг.',
    profile: initial,
  });
  const profileWithGoal = applyApprovedProfileFieldUpdate(initial, first.candidate.proposal).profile;

  const ordinaryChange = extractMemoryCandidate({
    message: 'Целта ми е да кача мускулна маса.',
    profile: profileWithGoal,
  });
  assert.equal(ordinaryChange.candidate.proposal.action, 'requires_confirmation');
  assert.equal(ordinaryChange.candidate.requiresConfirmation, true);
  assert.equal(
    applyApprovedProfileFieldUpdate(profileWithGoal, ordinaryChange.candidate.proposal).applied,
    false
  );

  const explicitChange = extractMemoryCandidate({
    message: 'Промени целта ми на да кача мускулна маса.',
    profile: profileWithGoal,
  });
  assert.equal(explicitChange.candidate.proposal.action, 'replace');
  assert.equal(explicitChange.candidate.requiresConfirmation, false);

  const updated = applyApprovedProfileFieldUpdate(profileWithGoal, explicitChange.candidate.proposal);
  assert.equal(updated.applied, true);
  assert.equal(getProfileField(updated.profile, 'goals.primary').value, 'да кача мускулна маса');
});

test('daily reports and medical data are never passive memory candidates', () => {
  const profile = createUnknownHealthProfile(USER_A);

  const dailyReport = extractMemoryCandidate({
    message: 'Изпих 2 чаши вода днес.',
    profile,
  });
  assert.equal(dailyReport.decision, 'ignore');
  assert.equal(dailyReport.reason, 'daily_health_event');

  const medicalStatement = extractMemoryCandidate({
    message: 'Имам диабет и приемам инсулин.',
    profile,
  });
  assert.equal(medicalStatement.decision, 'ignore');
  assert.equal(medicalStatement.reason, 'medical_data_requires_explicit_profile_flow');
});

test('short-term context stays bounded and separate from the profile contract', () => {
  const profile = createUnknownHealthProfile(USER_A);
  const shortContext = Array.from({ length: 13 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'реплика ' + index,
  }));
  const context = buildContext({
    userId: USER_A,
    channel: 'text',
    message: 'Продължаваме.',
    profile,
    shortContext,
  });

  assert.equal(context.shortContext.length, 10);
  assert.equal(context.shortContext[0].content, 'реплика 3');
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'conversation'), false);
});

test('V2.2 feature flags are opt-in and safe by default', () => {
  assert.deepEqual(getEliV22Flags({}), ELI_V2_2_FLAG_DEFAULTS);
  assert.equal(
    getEliV22Flags({ ELI_V2_2_AI_BRAIN_ENABLED: 'true' }).aiBrain,
    true
  );
  assert.equal(
    getEliV22Flags({ ELI_V2_2_MEMORY_CANDIDATES_ENABLED: 'off' }).memoryCandidates,
    false
  );

  const flags = resolveEliV22Flags(
    { aiBrain: true, contextBuilder: true, unifiedProfile: true },
    {}
  );
  assert.equal(flags.aiBrain, true);
  assert.equal(flags.contextBuilder, true);
  assert.equal(flags.unifiedProfile, true);
  assert.equal(flags.memoryCandidates, false);
});
