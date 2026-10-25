const test = require('node:test');
const assert = require('node:assert/strict');

const { createUnknownHealthProfile, createProfileFieldUpdateProposal, applyApprovedProfileFieldUpdate } = require('../brain/unifiedHealthProfile');
const { createEliBrain, ELI_BRAIN_MODEL } = require('../brain/eliBrain');
const { routeSafety, URGENT_RESPONSE } = require('../brain/safetyRouter');

const FLAGS_ON = Object.freeze({
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
});

function profileWithGoal(userId, goal) {
  const initial = createUnknownHealthProfile(userId);
  const proposal = createProfileFieldUpdateProposal(initial, 'goals.primary', goal, {
    source: 'test',
  });
  return applyApprovedProfileFieldUpdate(initial, proposal).profile;
}

test('Text, Voice and Avatar prepare the same user profile context', () => {
  const profile = profileWithGoal('200001', 'да подобря съня си');
  const brain = createEliBrain({ featureFlags: FLAGS_ON });
  const prepared = ['text', 'voice', 'avatar'].map((channel) =>
    brain.prepare({
      userId: '200001',
      channel,
      message: 'Каква малка стъпка да направя тази вечер?',
      profile,
    })
  );

  for (const result of prepared) {
    assert.equal(result.enabled, true);
    assert.equal(result.model, ELI_BRAIN_MODEL);
    assert.equal(result.context.knownProfile.length, 1);
    assert.equal(result.context.knownProfile[0].value, 'да подобря съня си');
  }
  assert.deepEqual(
    prepared.map((result) => result.context.knownProfile),
    [prepared[0].context.knownProfile, prepared[0].context.knownProfile, prepared[0].context.knownProfile]
  );
  assert.deepEqual(
    prepared.map((result) => result.request.deliveryMode),
    ['text', 'voice', 'avatar']
  );
});

test('disabled AI Brain keeps the legacy path and never calls a provider', async () => {
  let providerCalls = 0;
  const brain = createEliBrain({
    generate: async () => {
      providerCalls += 1;
      return 'Не трябва да се извиква.';
    },
  });

  const result = await brain.respond({
    userId: '200002',
    channel: 'text',
    message: 'Как си?',
    profile: createUnknownHealthProfile('200002'),
  });

  assert.equal(result.route, 'legacy');
  assert.equal(result.delivery, 'legacy');
  assert.equal(providerCalls, 0);
});

test('enabled skeleton only uses an injected fake generator and remains on gpt-4o-mini', async () => {
  let providerCalls = 0;
  let received;
  const brain = createEliBrain({
    featureFlags: FLAGS_ON,
    generate: async (request) => {
      providerCalls += 1;
      received = request;
      return 'Mock отговор';
    },
  });

  const result = await brain.respond({
    userId: '200003',
    channel: 'voice',
    message: 'Дай ми една малка стъпка за днес.',
    profile: createUnknownHealthProfile('200003'),
  });

  assert.equal(providerCalls, 1);
  assert.equal(received.model, 'gpt-4o-mini');
  assert.equal(result.delivery, 'generated');
  assert.equal(result.responseText, 'Mock отговор');
});

test('urgent medical route is deterministic and bypasses the injected generator', async () => {
  let providerCalls = 0;
  const brain = createEliBrain({
    featureFlags: FLAGS_ON,
    generate: async () => {
      providerCalls += 1;
      return 'Не трябва да се извиква.';
    },
  });

  const result = await brain.respond({
    userId: '200004',
    channel: 'text',
    message: 'Имам силна болка в гърдите и не мога да дишам.',
    profile: createUnknownHealthProfile('200004'),
  });

  assert.equal(result.safety.level, 'urgent');
  assert.equal(result.delivery, 'deterministic_safety');
  assert.equal(result.responseText, URGENT_RESPONSE);
  assert.equal(result.memoryCandidate.decision, 'ignore');
  assert.equal(providerCalls, 0);
});

test('medical questions keep a caution boundary and block passive memory capture', () => {
  const result = routeSafety('Имам диабет. Каква доза инсулин да взема?');
  assert.equal(result.level, 'medical_caution');
  assert.equal(result.shouldCallModel, true);
  assert.equal(result.allowMemoryCandidate, false);
  assert.match(result.systemInstruction, /без диагноза, лекарства, дози/u);

  const brain = createEliBrain({ featureFlags: FLAGS_ON });
  const prepared = brain.prepare({
    userId: '200005',
    channel: 'text',
    message: 'Имам диабет. Каква доза инсулин да взема?',
    profile: createUnknownHealthProfile('200005'),
  });
  assert.equal(prepared.memoryCandidate.decision, 'ignore');
  assert.equal(prepared.memoryCandidate.reason, 'safety_route');
});

test('context is isolated by Telegram user id', () => {
  const brain = createEliBrain({ featureFlags: FLAGS_ON });
  const alice = brain.prepare({
    userId: '200006',
    channel: 'text',
    message: 'Как да продължа?',
    profile: profileWithGoal('200006', 'да подобря съня си'),
  });
  const boris = brain.prepare({
    userId: '200007',
    channel: 'text',
    message: 'Как да продължа?',
    profile: profileWithGoal('200007', 'да кача мускулна маса'),
  });

  assert.equal(alice.context.userId, '200006');
  assert.equal(boris.context.userId, '200007');
  assert.match(alice.systemAddenda.join('\n'), /подобря съня/u);
  assert.doesNotMatch(alice.systemAddenda.join('\n'), /мускулна маса/u);
  assert.match(boris.systemAddenda.join('\n'), /мускулна маса/u);
  assert.doesNotMatch(boris.systemAddenda.join('\n'), /подобря съня/u);
});
