const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createUnknownHealthProfile,
  knownField,
} = require('../brain/unifiedHealthProfile');
const {
  formatOwnerPersonalMemory,
  targetWeightFromGoal,
} = require('../brain/ownerMemorySummary');

function profileWith(goal, currentWeight) {
  const profile = createUnknownHealthProfile('owner-summary-fixture');
  if (goal) profile.goals.primary = knownField(goal);
  if (currentWeight !== undefined) profile.identity.weightKg = knownField(currentWeight);
  return profile;
}

test('reports target weight only when it is explicit in a stored goal', () => {
  const summary = formatOwnerPersonalMemory({
    profile: profileWith('Искам да кача мускулна маса до 65 кг.', 62),
    longTermFacts: [],
  });

  assert.match(summary, /Целево тегло: 65 кг \(изрично записано към цел\)/);
  assert.match(summary, /Тегло: 62/);
  assert.doesNotMatch(summary, /Целево тегло: 62/);
});

test('does not treat a current weight or an amount to lose as a target weight', () => {
  const summary = formatOwnerPersonalMemory({
    profile: profileWith('Искам да отслабна с 5 кг.', 62),
    longTermFacts: [],
  });

  assert.match(summary, /Целево тегло: не е записано в постоянната памет/);
  assert.match(summary, /Тегло: 62/);
  assert.equal(targetWeightFromGoal('Искам да отслабна с 5 кг.'), null);
});
