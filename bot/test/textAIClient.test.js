const test = require('node:test');
const assert = require('node:assert/strict');

const previousOwnerId = process.env.OWNER_TELEGRAM_ID;
process.env.OWNER_TELEGRAM_ID = '900000001';
const {
  GEMINI_DEFAULT_MODEL,
  createGeminiClient,
  getProvider,
  getUsageSnapshot,
} = require('../textAIClient');
if (previousOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
else process.env.OWNER_TELEGRAM_ID = previousOwnerId;

function response(text = 'Здравей!', usageMetadata = {}) {
  return {
    ok: true,
    async json() {
      return {
        candidates: [{
          content: { parts: [{ text }] },
          finishReason: 'STOP',
        }],
        usageMetadata,
      };
    },
  };
}

test('provider defaults to OpenAI and the Gemini canary is owner-only', () => {
  assert.equal(GEMINI_DEFAULT_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(getProvider('900000001', {}), 'openai');
  assert.equal(
    getProvider('900000001', { GEMINI_OWNER_CANARY_ENABLED: 'true' }),
    'gemini'
  );
  assert.equal(
    getProvider('900000002', { GEMINI_OWNER_CANARY_ENABLED: 'true' }),
    'openai'
  );
  assert.equal(getProvider('900000002', { TEXT_AI_PROVIDER: 'gemini' }), 'gemini');
  assert.equal(getProvider('900000002', { TEXT_AI_PROVIDER: 'unsupported' }), 'invalid');
});

test('Gemini maps system/history and output caps, and returns OpenAI-shaped results', async () => {
  let request;
  const client = createGeminiClient({
    apiKey: 'test-only-key',
    model: 'gemini-2.5-flash-lite',
    userId: 'text-client-test-mapping',
    fetchFn: async (_url, options) => {
      request = options;
      return response('Отговор на български.', {
        promptTokenCount: 100,
        candidatesTokenCount: 25,
      });
    },
    logger: { info() {} },
  });

  const result = await client.chat.completions.create({
    messages: [
      { role: 'system', content: 'Говори на български.' },
      { role: 'user', content: 'Здравей.' },
      { role: 'assistant', content: 'Здравей, радвам се.' },
      { role: 'user', content: 'Как си?' },
    ],
    max_tokens: 9000,
    temperature: 0.7,
  });
  const body = JSON.parse(request.body);

  assert.equal(request.headers['x-goog-api-key'], 'test-only-key');
  assert.equal(body.systemInstruction.parts[0].text, 'Говори на български.');
  assert.deepEqual(body.contents.map(({ role }) => role), ['user', 'model', 'user']);
  assert.equal(body.generationConfig.maxOutputTokens, 4096);
  assert.equal(result.choices[0].message.content, 'Отговор на български.');
  assert.equal(result.usage.total_tokens, 125);
});

test('Gemini usage logs contain aggregate token/cost data but no prompt or user ID', async () => {
  const logs = [];
  const secretPrompt = 'PRIVATE_TEST_PROMPT_900000003';
  const client = createGeminiClient({
    apiKey: 'test-only-key',
    model: 'gemini-2.5-flash-lite',
    userId: '900000003',
    fetchFn: async () => response('synthetic result', {
      promptTokenCount: 100,
      candidatesTokenCount: 25,
    }),
    logger: { info: (line) => logs.push(line) },
  });

  await client.chat.completions.create({
    messages: [{ role: 'user', content: secretPrompt }],
    max_tokens: 20,
  });

  assert.equal(logs.length, 1);
  assert.match(logs[0], /provider=gemini model=gemini-2\.5-flash-lite/);
  assert.match(logs[0], /input_tokens=100 output_tokens=25 estimated_usd=0\.000020/);
  assert.equal(logs[0].includes(secretPrompt), false);
  assert.equal(logs[0].includes('900000003'), false);
});

test('Gemini enforces a per-user request limit without retrying or leaking upstream bodies', async () => {
  let calls = 0;
  const client = createGeminiClient({
    apiKey: 'test-only-key',
    userId: 'text-client-test-rate-limit',
    fetchFn: async () => {
      calls += 1;
      return response();
    },
    logger: { info() {} },
  });

  for (let i = 0; i < 12; i += 1) {
    await client.chat.completions.create({
      messages: [{ role: 'user', content: 'test' }],
    });
  }
  await assert.rejects(
    client.chat.completions.create({
      messages: [{ role: 'user', content: 'test' }],
    }),
    /gemini_rate_limited/
  );
  assert.equal(calls, 12);
});

test('Gemini provider errors are sanitized and not retried', async () => {
  let calls = 0;
  const client = createGeminiClient({
    apiKey: 'test-only-key',
    userId: 'text-client-test-provider-error',
    fetchFn: async () => {
      calls += 1;
      return {
        ok: false,
        status: 503,
        async text() {
          return 'provider body must not be surfaced';
        },
      };
    },
    logger: { info() {} },
  });

  await assert.rejects(
    client.chat.completions.create({
      messages: [{ role: 'user', content: 'test' }],
    }),
    (error) => {
      assert.equal(error.message, 'gemini_service_unavailable');
      assert.equal(error.message.includes('provider body'), false);
      return true;
    }
  );
  assert.equal(calls, 1);
  assert.deepEqual(getUsageSnapshot().requests >= 0, true);
});
