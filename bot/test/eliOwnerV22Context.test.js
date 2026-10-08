const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const OWNER_ID = 'v22-owner-fixture';
process.env.OWNER_TELEGRAM_ID = OWNER_ID;

const { isOwner } = require('../adminGuard');
const { buildOwnerV22Context } = require('../brain/ownerV22Context');
const { createAskEliAdapter } = require('../brain/askEliAdapter');
const { getOwnerScopedEliV22Flags } = require('../brain/featureFlags');
const { isProfileQuery } = require('../profileIntent');
const { detectOwnerFitnessMemoryCommand } = require('../ownerFitnessMemory');
const { OWNER_MEMORY } = require('../ownerContext');
const { resolveLogQuery } = require('../dailyLogService');
const { extractHealthEvents } = require('../dailyLogTracker');
const { clearShortContext } = require('../brain/shortContextSession');
const {
  getProfileField,
  createUnknownHealthProfile,
  getKnownProfileEntries,
} = require('../brain/unifiedHealthProfile');

const ALL_ENV_FLAGS_ON = {
  ELI_V2_2_AI_BRAIN_ENABLED: 'true',
  ELI_V2_2_CONTEXT_BUILDER_ENABLED: 'true',
  ELI_V2_2_MEMORY_CANDIDATES_ENABLED: 'true',
  ELI_V2_2_UNIFIED_PROFILE_ENABLED: 'true',
  ELI_V2_2_DURABLE_MEMORY_ENABLED: 'true',
  ELI_V2_2_DURABLE_READS_ENABLED: 'true',
};

const OWNER_FLAGS = {
  aiBrain: true,
  contextBuilder: true,
  memoryCandidates: true,
  unifiedProfile: true,
  durableMemory: false,
  durableReads: false,
};

const OFF_FLAGS = {
  aiBrain: false,
  contextBuilder: false,
  memoryCandidates: false,
  unifiedProfile: false,
  durableMemory: false,
  durableReads: false,
};

const LEGACY_PROFILE = {
  firstName: 'Мира',
  age: 38,
  gender: 'жена',
  height: 168,
  weight: 62,
  goal: 'подобряване на съня',
  activityLevel: 'умерена',
  trainingExperience: 'начинаеща',
  foodPreferences: 'предпочита растителни храни',
  medicalNotes: null,
};

const LEGACY_MEMORY = {
  injuries: 'стара травма на коляното',
  allergies: 'фъстъци',
  favoriteFoods: 'овесени ядки',
  dislikedFoods: 'гъби',
  dailyHabits: 'ежедневни разходки',
  motivationLevel: 7,
  lastWorkout: { date: '2026-09-30', note: 'силова тренировка' },
  conversation: [{ role: 'user', content: 'Това остава в отделния разговорен контекст.' }],
  updatedAt: '2026-09-30T12:00:00.000Z',
};

const RELATIONSHIP_MEMORIES = [
  { id: 'goal-1', category: 'goals', value: 'да пробягам 5 км' },
  { id: 'pref-1', category: 'communication_preferences', value: 'Кратки отговори' },
];

function fixtureReaders(profile = LEGACY_PROFILE, memory = LEGACY_MEMORY, relationship = RELATIONSHIP_MEMORIES, calls = []) {
  return {
    readProfile: (userId) => {
      calls.push(['profile', userId]);
      return profile;
    },
    readUserMemory: (userId) => {
      calls.push(['user_memory', userId]);
      return memory;
    },
    readRelationshipMemories: (userId) => {
      calls.push(['relationship_memory', userId]);
      return relationship;
    },
  };
}

function findFact(context, key) {
  return context.longTermFacts.find((fact) => fact.key === key);
}

test('owner context maps the structured profile and stored long-term facts by the exact owner ID', () => {
  const reads = [];
  const ownerContext = buildOwnerV22Context(OWNER_ID, fixtureReaders(undefined, undefined, undefined, reads));

  assert.equal(getProfileField(ownerContext.profile, 'identity.firstName').value, 'Мира');
  assert.equal(getProfileField(ownerContext.profile, 'goals.primary').value, 'подобряване на съня');
  assert.equal(getProfileField(ownerContext.profile, 'nutrition.allergies').value, 'фъстъци');
  assert.equal(getProfileField(ownerContext.profile, 'progress.highlights').value, '2026-09-30 — силова тренировка');
  assert.equal(findFact(ownerContext, 'injuries').value, 'стара травма на коляното');
  assert.equal(findFact(ownerContext, 'favoriteFoods').value, 'овесени ядки');
  assert.equal(findFact(ownerContext, 'motivationLevel').value, '7');
  assert.ok(ownerContext.longTermFacts.some((fact) => fact.value === 'да пробягам 5 км'));
  assert.ok(ownerContext.longTermFacts.some((fact) => fact.value === 'Кратки отговори'));
  assert.equal(ownerContext.longTermFacts.some((fact) => ['dislikedFoods', 'dailyHabits', 'lastWorkout'].includes(fact.key)), false);
  assert.deepEqual(reads, [
    ['profile', OWNER_ID],
    ['user_memory', OWNER_ID],
    ['relationship_memory', OWNER_ID],
  ]);
});

test('profile fact and relevant long-term facts reach Text, Voice and Avatar V2.2 context identically', () => {
  const ownerContext = buildOwnerV22Context(OWNER_ID, fixtureReaders());
  const adapter = createAskEliAdapter({ environment: ALL_ENV_FLAGS_ON });
  const featureFlags = getOwnerScopedEliV22Flags(true);
  const shortContext = [
    { role: 'user', content: 'Вчера обсъдихме кратките разходки.' },
    { role: 'assistant', content: 'Ще продължим оттам.' },
  ];
  const common = {
    userId: OWNER_ID,
    message: 'Как да подобря съня и да включа овесени ядки за подготовка за 5 км?',
    ...ownerContext,
    shortContext,
    featureFlags,
  };
  const prepared = ['text', 'voice', 'avatar'].map((channel) =>
    adapter.prepare({ ...common, channel })
  );

  for (const result of prepared) {
    assert.equal(result.legacy, false);
    assert.equal(result.providerModel, 'gpt-4o-mini');
    assert.deepEqual({ ...result.flags }, OWNER_FLAGS);
    assert.ok(result.context.knownProfile.some(
      (entry) => entry.path === 'goals.primary' && entry.value === 'подобряване на съня'
    ));
    assert.ok(result.context.longTermFacts.some(
      (fact) => fact.key === 'favoriteFoods' && fact.value === 'овесени ядки'
    ));
    assert.ok(result.context.longTermFacts.some((fact) => fact.value === 'да пробягам 5 км'));
    assert.deepEqual(result.context.shortContext, shortContext);
    assert.match(result.systemAddenda.join('\n'), /подобряване на съня/);
    assert.match(result.systemAddenda.join('\n'), /овесени ядки/);
    assert.match(result.systemAddenda.join('\n'), /да пробягам 5 км/);
  }

  for (const result of prepared.slice(1)) {
    assert.deepEqual(result.context.knownProfile, prepared[0].context.knownProfile);
    assert.deepEqual(result.context.longTermFacts, prepared[0].context.longTermFacts);
    assert.deepEqual(result.context.shortContext, prepared[0].context.shortContext);
    assert.deepEqual(result.systemAddenda, prepared[0].systemAddenda);
  }
});

test('blank or malformed stored values remain unknown and are not turned into facts', () => {
  const unknownContext = buildOwnerV22Context(OWNER_ID, fixtureReaders(
    { firstName: '  ', age: { guessed: 44 }, goal: null, height: Infinity },
    { injuries: '', favoriteFoods: { guessed: 'ябълки' }, motivationLevel: null, lastWorkout: { secretGuess: 'измислен факт' } },
    [{ id: 'bad', category: 'goals', value: { guessed: 'измислена цел' } }, { category: 'habits', value: '   ' }]
  ));
  const adapter = createAskEliAdapter({ environment: {} });
  const result = adapter.prepare({
    userId: OWNER_ID,
    channel: 'avatar',
    message: 'Какво знаеш за мен?',
    ...unknownContext,
    featureFlags: getOwnerScopedEliV22Flags(true),
  });
  const rendered = result.systemAddenda.join('\n');

  assert.deepEqual(getKnownProfileEntries(unknownContext.profile), []);
  assert.deepEqual(unknownContext.longTermFacts, []);
  assert.ok(result.context.unknownProfilePaths.includes('identity.firstName'));
  assert.ok(result.context.unknownProfilePaths.includes('identity.age'));
  assert.match(rendered, /Все още няма потвърдени профилни данни/);
  assert.doesNotMatch(rendered, /ябълки|измислена цел|измислен факт|44/);
});

function createAskEliHarness(readers, options = {}) {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  const start = source.indexOf('async function askEli(');
  const end = source.indexOf("bot.command('ask'", start);
  assert.ok(start >= 0 && end > start, 'actual askEli implementation exists');

  const adapterCore = createAskEliAdapter({ environment: ALL_ENV_FLAGS_ON });
  const adapterCalls = [];
  const llmCalls = [];
  const avatarCalls = [];
  const voiceCalls = [];
  const memoryReads = [];
  let storedMode = 'text';
  let helperCalls = 0;
  const adapter = {
    prepare(input) {
      const result = adapterCore.prepare(input);
      adapterCalls.push({ input, result });
      return result;
    },
    rememberExchange: (...args) => adapterCore.rememberExchange(...args),
  };
  const sandbox = {
    openai: {
      chat: {
        completions: {
          create: async (request) => {
            llmCalls.push(request);
            return { choices: [{ message: { content: 'Mock Eli отговор.' } }] };
          },
        },
      },
    },
    gateChat: async () => ({ canChat: true, plan: 'owner', allowedModes: ['text', 'voice', 'avatar'], notice: null }),
    isOwner,
    getOwnerScopedEliV22Flags,
    getOwnerRelationshipMemoryCaptureEnabled: (owner) => owner,
    buildOwnerV22Context: (userId) => {
      helperCalls += 1;
      return buildOwnerV22Context(userId, readers);
    },
    touchConversationState: () => 'continuing',
    getMode: () => storedMode,
    eliV22Adapter: adapter,
    ownerRecentTurns: () => [{ role: 'user', content: 'Известен кратък разговорен факт.' }],
    ownerRememberTurn: () => {},
    conversationFlowNote: () => 'FLOW_NOTE',
    SYSTEM_PROMPT: 'MOCK_PERSONA',
    OWNER_NAME: 'Данаил',
    OWNER_MEMORY,
    formatOwnerPersonalMemory: require('../brain/ownerMemorySummary').formatOwnerPersonalMemory,
    formatFullMemory: (userId) => {
      memoryReads.push(['formatFullMemory', userId]);
      return `CUSTOMER_STORED_FACTS:${userId}`;
    },
    formatRelationshipMemory: () => '',
    isProfileQuery: options.isProfileQuery || (() => false),
    detectOwnerFitnessMemoryCommand:
      options.detectOwnerFitnessMemoryCommand || detectOwnerFitnessMemoryCommand,
    saveOwnerFitnessGoal:
      options.saveOwnerFitnessGoal || (() => ({ ok: false, reason: 'invalid' })),
    detectMemoryCommand: () => null,
    rememberFromMessage: (userId) => memoryReads.push(['rememberFromMessage', userId]),
    buildMemoryContext: (userId) => {
      memoryReads.push(['buildMemoryContext', userId]);
      return 'LEGACY_CUSTOMER_MEMORY';
    },
    buildRelationshipContext: () => '',
    recentMessages: () => [],
    addConversation: () => {},
    resolveLogQuery: options.resolveLogQuery || (() => null),
    answerDailyLogQuery: options.answerDailyLogQuery || (() => 'MOCK DAILY HEALTH REPORT'),
    extractHealthEvents: options.extractHealthEvents || (() => []),
    sendAvatarReply: async (_ctx, text) => { avatarCalls.push(text); return true; },
    sendVoiceReply: async (_ctx, text) => { voiceCalls.push(text); return true; },
    replyWithMarkdownSafe: async (ctx, text) => ctx.reply(text),
    stripLeadingGreeting: (text) => text,
    parseLookTag: (text) => ({ text, category: 'neutral' }),
    chooseLookCategory: () => 'neutral',
    resolveLookId: () => undefined,
    LOOK_PROMPT_NOTE: 'MOCK_AVATAR_NOTE',
    console: {
      error: (...args) => {
        if (options.onConsoleError) options.onConsoleError(...args);
        else assert.fail(args.join(' '));
      },
      warn: () => {},
    },
  };
  vm.runInNewContext(source.slice(start, end), sandbox);

  function seedShortContext(userId) {
    clearShortContext(userId);
    adapterCore.rememberExchange(
      userId,
      'Кратък контекстен въпрос.',
      'Кратък контекстен отговор.'
    );
  }

  async function run(userId, mode, status, message) {
    storedMode = mode;
    if (userId === OWNER_ID) seedShortContext(userId);
    const ctx = {
      from: { id: userId },
      message: {
        text: message || 'Как да подобря съня и да включа овесени ядки за подготовка за 5 км?',
      },
      replyCalls: [],
      reply: async function(text) { this.replyCalls.push(text); },
      sendChatAction: async () => {},
    };
    const beforeAdapter = adapterCalls.length;
    const beforeLlm = llmCalls.length;
    const beforeAvatar = avatarCalls.length;
    const beforeVoice = voiceCalls.length;
    await sandbox.askEli(ctx, ctx.message.text, { status });
    return {
      ctx,
      adapterCall: adapterCalls[beforeAdapter],
      llmCall: llmCalls[beforeLlm],
      avatarCalls: avatarCalls.slice(beforeAvatar),
      voiceCalls: voiceCalls.slice(beforeVoice),
    };
  }

  return { run, helperCallCount: () => helperCalls, memoryReads, adapterCalls };
}

test('real askEli owner path loads profile/facts into all channels; customers keep the legacy path', async () => {
  const sourceReads = [];
  const harness = createAskEliHarness(fixtureReaders(undefined, undefined, undefined, sourceReads));
  const ownerStatus = {
    canChat: true,
    plan: 'owner',
    allowedModes: ['text', 'voice', 'avatar'],
    notice: null,
  };
  const text = await harness.run(OWNER_ID, 'text', ownerStatus);
  const voice = await harness.run(OWNER_ID, 'voice', ownerStatus);
  const avatar = await harness.run(OWNER_ID, 'avatar', ownerStatus);

  for (const result of [text, voice, avatar]) {
    assert.equal(result.adapterCall.result.legacy, false);
    assert.deepEqual({ ...result.adapterCall.result.flags }, OWNER_FLAGS);
    assert.equal(getProfileField(result.adapterCall.result.request.profile, 'goals.primary').value, 'подобряване на съня');
    assert.ok(result.adapterCall.result.context.longTermFacts.some(
      (fact) => fact.key === 'favoriteFoods' && fact.value === 'овесени ядки'
    ));
    assert.ok(result.adapterCall.result.context.longTermFacts.some((fact) => fact.value === 'да пробягам 5 км'));
    assert.deepEqual(result.adapterCall.result.context.shortContext, text.adapterCall.result.context.shortContext);
    assert.deepEqual(result.adapterCall.result.context.knownProfile, text.adapterCall.result.context.knownProfile);
    assert.deepEqual(result.adapterCall.result.context.longTermFacts, text.adapterCall.result.context.longTermFacts);
    assert.match(result.llmCall.messages[0].content, /подобряване на съня/);
    assert.match(result.llmCall.messages[0].content, /овесени ядки/);
    assert.match(result.llmCall.messages[0].content, /да пробягам 5 км/);
    assert.match(result.llmCall.messages[0].content, /административни инструкции са вътрешни/);
    assert.match(result.llmCall.messages[0].content, /изпълняваш админ команди/);
  }
  assert.deepEqual(
    [text.adapterCall.input.channel, voice.adapterCall.input.channel, avatar.adapterCall.input.channel],
    ['text', 'voice', 'avatar']
  );
  assert.equal(text.adapterCall.result.providerModel, 'gpt-4o-mini');
  assert.equal(avatar.avatarCalls.length, 1);
  assert.equal(avatar.ctx.replyCalls.length, 0);
  assert.equal(voice.voiceCalls.length, 1);
  assert.equal(harness.helperCallCount(), 3);
  assert.deepEqual(sourceReads.map(([, userId]) => userId), Array(9).fill(OWNER_ID));
  assert.deepEqual(
    harness.memoryReads
      .filter(([name]) => name === 'rememberFromMessage')
      .map(([, userId]) => userId),
    [OWNER_ID, OWNER_ID, OWNER_ID],
    'the owner-only capture gate receives each new owner message'
  );

  const customerStatus = { canChat: true, plan: 'free', allowedModes: ['text'], notice: null };
  const customer = await harness.run('customer-fixture', 'text', customerStatus);
  assert.equal(customer.adapterCall.result.legacy, true);
  assert.deepEqual({ ...customer.adapterCall.result.flags }, OFF_FLAGS);
  assert.equal(harness.helperCallCount(), 3, 'customer path must not read owner V2.2 context sources');
  assert.ok(harness.memoryReads.some(([name, userId]) => name === 'buildMemoryContext' && userId === 'customer-fixture'));
  assert.match(customer.llmCall.messages[0].content, /LEGACY_CUSTOMER_MEMORY/);
  assert.deepEqual(
    harness.memoryReads
      .filter(([name]) => name === 'rememberFromMessage')
      .map(([, userId]) => userId),
    [OWNER_ID, OWNER_ID, OWNER_ID, 'customer-fixture'],
    'customer relationship capture remains on its existing per-user path'
  );
});

test('owner memory query returns only stored personal facts and explicitly marks missing target weight', async () => {
  const ownerProfile = { ...LEGACY_PROFILE, goal: 'Покачване на мускулна маса' };
  const ownerRelationshipFacts = [
    { id: 'muscle-goal', category: 'goals', value: 'Искам да кача мускулна маса.' },
    { id: 'pref-1', category: 'communication_preferences', value: 'Кратки отговори' },
  ];
  const reads = [];
  const healthQueryCalls = [];
  const healthAnswerCalls = [];
  const harness = createAskEliHarness(
    fixtureReaders(ownerProfile, LEGACY_MEMORY, ownerRelationshipFacts, reads),
    {
      isProfileQuery,
      resolveLogQuery: (text) => {
        healthQueryCalls.push(text);
        return resolveLogQuery(text);
      },
      answerDailyLogQuery: (userId, descriptor) => {
        healthAnswerCalls.push([userId, descriptor]);
        return 'MOCK DAILY HEALTH REPORT';
      },
      extractHealthEvents,
    }
  );
  const ownerStatus = {
    canChat: true,
    plan: 'owner',
    allowedModes: ['text', 'voice', 'avatar'],
    notice: null,
  };
  const question = 'Ели, каква е основната ми фитнес цел и колко килограма искам да достигна?';
  const ownerResult = await harness.run(OWNER_ID, 'text', ownerStatus, question);
  const ownerAnswer = ownerResult.ctx.replyCalls.join('\n');

  assert.equal(isProfileQuery(question), true);
  assert.ok(isOwner({ from: { id: OWNER_ID } }));
  assert.match(ownerAnswer, /Покачване на мускулна маса/);
  assert.match(ownerAnswer, /мускулна маса/);
  assert.match(ownerAnswer, /Целево тегло: не е записано в постоянната памет/);
  assert.doesNotMatch(ownerAnswer, /65\s?кг/i);
  assert.doesNotMatch(
    ownerAnswer,
    /ВАЖНО — САМОЛИЧНОСТ|Създател|Собственик на теб|Администратор|Разработчик|пълен достъп|админ команди/i
  );
  assert.equal(ownerResult.llmCall, undefined, 'memory queries must not reach the LLM');
  assert.equal(ownerResult.ctx.replyCalls.length, 1, 'one incoming memory query gets one reply');
  assert.deepEqual(healthQueryCalls, [], 'memory intent returns before health-log routing');
  assert.deepEqual(healthAnswerCalls, []);
  assert.deepEqual(reads.map(([, userId]) => userId), Array(3).fill(OWNER_ID));

  const customerStatus = { canChat: true, plan: 'free', allowedModes: ['text'], notice: null };
  const customerResult = await harness.run('customer-fixture', 'text', customerStatus, question);
  const customerAnswer = customerResult.ctx.replyCalls.join('\n');
  assert.ok(isOwner({ from: { id: 'customer-fixture' } }) === false);
  assert.equal(customerResult.adapterCall.result.legacy, true);
  assert.match(customerAnswer, /CUSTOMER_STORED_FACTS:customer-fixture/);
  assert.doesNotMatch(customerAnswer, /Покачване на мускулна маса|Администратор|пълен достъп/);
  assert.deepEqual(reads.map(([, userId]) => userId), Array(3).fill(OWNER_ID));
  assert.deepEqual(healthQueryCalls, [], 'customer memory intent also bypasses health-log routing');
  assert.ok(
    harness.memoryReads.some(
      ([name, userId]) => name === 'formatFullMemory' && userId === 'customer-fixture'
    )
  );

  const greetingResult = await harness.run(OWNER_ID, 'text', ownerStatus, 'оп');
  assert.equal(greetingResult.ctx.replyCalls.length, 1, 'one short greeting gets one reply');
  assert.equal(greetingResult.ctx.replyCalls[0], 'Mock Eli отговор.');
  assert.doesNotMatch(greetingResult.ctx.replyCalls[0], /Няма записани данни|Тренировка|Тегло/);
  assert.deepEqual(healthQueryCalls, ['оп']);
  assert.deepEqual(healthAnswerCalls, []);
});

test('fitness-goal recall paraphrases route to stored memory before daily logs', async () => {
  const reads = [];
  const healthQueryCalls = [];
  const harness = createAskEliHarness(
    fixtureReaders(
      { ...LEGACY_PROFILE, goal: 'Покачване на мускулна маса' },
      LEGACY_MEMORY,
      [{ id: 'goal', category: 'goals', value: 'Основна фитнес цел: качване на мускулна маса' }],
      reads
    ),
    {
      isProfileQuery,
      resolveLogQuery: (text) => {
        healthQueryCalls.push(text);
        return resolveLogQuery(text);
      },
      extractHealthEvents,
    }
  );
  const status = {
    canChat: true,
    plan: 'owner',
    allowedModes: ['text', 'voice', 'avatar'],
    notice: null,
  };
  const questions = [
    'Ели, каква беше фитнес целта ми и до колко кг исках да стигна?',
    'Припомни ми основната фитнес цел и колко килограма исках да достигна.',
    'Колко кг искам да достигна?',
  ];

  for (const question of questions) {
    assert.equal(isProfileQuery(question), true, question);
    const result = await harness.run(OWNER_ID, 'text', status, question);
    assert.equal(result.ctx.replyCalls.length, 1, 'exactly one deterministic reply');
    assert.equal(result.llmCall, undefined, 'recall must not reach the model');
    assert.match(result.ctx.replyCalls[0], /Покачване на мускулна маса/);
  }
  assert.deepEqual(healthQueryCalls, [], 'memory recall must not resolve against today’s log');
});

test('owner explicit fitness save verifies once and bypasses capture, daily logs, and LLM', async () => {
  const calls = [];
  const logQueries = [];
  const saveResult = { ok: true, goal: 'кача мускулна маса', targetWeightKg: '75' };
  const harness = createAskEliHarness(fixtureReaders(), {
    isProfileQuery,
    saveOwnerFitnessGoal: (userId, command) => {
      calls.push([userId, command]);
      return saveResult;
    },
    resolveLogQuery: (text) => {
      logQueries.push(text);
      return resolveLogQuery(text);
    },
    extractHealthEvents,
  });
  const status = {
    canChat: true,
    plan: 'owner',
    allowedModes: ['text', 'voice', 'avatar'],
    notice: null,
  };
  const phrase =
    'Запомни, че фитнес целта ми е да кача мускулна маса и целевото ми тегло е 75 кг.';
  const result = await harness.run(OWNER_ID, 'text', status, phrase);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], OWNER_ID);
  assert.deepEqual({ ...calls[0][1] }, {
    kind: 'save_fitness_goal',
    goal: 'кача мускулна маса',
    targetWeightKg: '75',
  });
  assert.equal(result.ctx.replyCalls.length, 1, 'one save request produces one reply');
  assert.match(result.ctx.replyCalls[0], /Запазих фитнес целта/);
  assert.equal(result.llmCall, undefined);
  assert.deepEqual(logQueries, []);
  assert.equal(
    harness.memoryReads.some(([name]) => name === 'rememberFromMessage'),
    false,
    'the explicit command is excluded from passive memory capture'
  );
});

test('owner save failure and incomplete save never claim persistence or send duplicate replies', async () => {
  const errors = [];
  const status = {
    canChat: true,
    plan: 'owner',
    allowedModes: ['text', 'voice', 'avatar'],
    notice: null,
  };
  const failedHarness = createAskEliHarness(fixtureReaders(), {
    isProfileQuery,
    saveOwnerFitnessGoal: (_userId, command) =>
      command.targetWeightKg
        ? { ok: false, reason: 'verification_failed' }
        : { ok: false, reason: 'invalid' },
    onConsoleError: (...args) => errors.push(args),
  });
  const failed = await failedHarness.run(
    OWNER_ID,
    'text',
    status,
    'Запомни, че фитнес целта ми е да кача мускулна маса и целевото ми тегло е 75 кг.'
  );
  assert.equal(failed.ctx.replyCalls.length, 1);
  assert.match(failed.ctx.replyCalls[0], /Не мога да потвърдя/);
  assert.doesNotMatch(failed.ctx.replyCalls[0], /Запазих|запазено е|успешно записах/i);
  assert.equal(failed.llmCall, undefined);

  const incomplete = await failedHarness.run(
    OWNER_ID,
    'text',
    status,
    'Запомни, че фитнес целта ми е да кача мускулна маса.'
  );
  assert.equal(incomplete.ctx.replyCalls.length, 1);
  assert.match(incomplete.ctx.replyCalls[0], /изпрати изрично фитнес целта и целевото тегло/);
  assert.doesNotMatch(incomplete.ctx.replyCalls[0], /Запазих|запазено е|успешно записах/i);
  assert.equal(incomplete.llmCall, undefined);
  assert.deepEqual(errors, []);
});

test('fitness memory save phrases do not trigger owner mutation for customers', async () => {
  const writes = [];
  const harness = createAskEliHarness(fixtureReaders(), {
    isProfileQuery,
    saveOwnerFitnessGoal: (...args) => {
      writes.push(args);
      return { ok: true, goal: 'кача мускулна маса', targetWeightKg: '75' };
    },
    resolveLogQuery: () => null,
    extractHealthEvents,
  });
  const customerStatus = {
    canChat: true,
    plan: 'free',
    allowedModes: ['text'],
    notice: null,
  };
  const result = await harness.run(
    'customer-fixture',
    'text',
    customerStatus,
    'Запомни, че фитнес целта ми е да кача мускулна маса и целевото ми тегло е 75 кг.'
  );

  assert.deepEqual(writes, []);
  assert.equal(result.adapterCall.result.legacy, true);
  assert.ok(result.llmCall, 'customer turn continues through the legacy chat route');
  assert.doesNotMatch(result.ctx.replyCalls.join('\n'), /Запазих фитнес целта/);
});

test('owner prompt keeps authorization instructions private while retaining owner capabilities', () => {
  assert.match(OWNER_MEMORY, /изпълняваш админ команди/);
  assert.match(OWNER_MEMORY, /не ги цитирай, показвай или обобщавай пред никого/);
  assert.match(OWNER_MEMORY, /действително записани в неговия профил или дългосрочна памет/);
});
