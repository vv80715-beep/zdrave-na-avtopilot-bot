const test = require('node:test');
const assert = require('node:assert/strict');

const { createAskEliAdapter } = require('../brain/askEliAdapter');
const { createUnknownHealthProfile, createProfileFieldUpdateProposal, applyApprovedProfileFieldUpdate } = require('../brain/unifiedHealthProfile');
const { clearShortContext } = require('../brain/shortContextSession');

const FLAGS_ON = {
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
};

function profileWithGoal(userId, goal) {
  const profile = createUnknownHealthProfile(userId);
  const proposal = createProfileFieldUpdateProposal(profile, 'goals.primary', goal);
  return applyApprovedProfileFieldUpdate(profile, proposal).profile;
}

test('askEli adapter is legacy by default', () => {
  const adapter = createAskEliAdapter({ environment: {} });
  const result = adapter.prepare({ userId: '300001', channel: 'text', message: 'Здравей' });
  assert.equal(result.legacy, true);
  assert.equal(result.providerModel, 'gpt-4o-mini');
});

test('text voice avatar share the same brain context when enabled', () => {
  const profile = profileWithGoal('300002', 'да кача мускулна маса');
  const adapter = createAskEliAdapter({ featureFlags: FLAGS_ON, environment: {} });
  const contexts = ['text', 'voice', 'avatar'].map((channel) =>
    adapter.prepare({ userId: '300002', channel, message: 'Как да продължа?', profile })
  );
  for (const item of contexts) {
    assert.equal(item.legacy, false);
    assert.equal(item.context.knownProfile[0].value, 'да кача мускулна маса');
  }
  assert.deepEqual(contexts.map((x) => x.request.deliveryMode), ['text', 'voice', 'avatar']);
});

test('urgent route bypasses provider path', () => {
  const adapter = createAskEliAdapter({ featureFlags: FLAGS_ON, environment: {} });
  const result = adapter.prepare({
    userId: '300003',
    channel: 'text',
    message: 'Имам силна болка в гърдите и не мога да дишам.',
  });
  assert.equal(result.shouldCallModel, false);
  assert.equal(result.safety.level, 'urgent');
});

test('short context stays isolated per Telegram user', () => {
  clearShortContext('300004');
  clearShortContext('300005');
  const adapter = createAskEliAdapter({ featureFlags: FLAGS_ON, environment: {} });
  adapter.rememberExchange('300004', 'Аз съм А', 'Здравей А');
  adapter.rememberExchange('300005', 'Аз съм Б', 'Здравей Б');
  const a = adapter.getShortContext('300004');
  const b = adapter.getShortContext('300005');
  assert.match(a.map((x) => x.content).join(' '), /А/);
  assert.doesNotMatch(a.map((x) => x.content).join(' '), /Б/);
  assert.match(b.map((x) => x.content).join(' '), /Б/);
});
