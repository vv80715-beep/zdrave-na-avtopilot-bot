const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const TEST_SECRET = 'link-secret-'.padEnd(40, 'x');

const {
  TelegramLinkClient,
  TelegramLinkError,
  APPROVED_LINK_BASE_URL,
} = require('../telegramLinkClient');
const linkCommand = require('../commands/link');

function jsonResponse(data, status = 201) {
  const text = JSON.stringify(data);
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length'
          ? String(Buffer.byteLength(text, 'utf8'))
          : null;
      },
    },
    text: async () => text,
  };
}

function streamedResponse(text, declaredLength = null) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  return {
    response: {
      status: 201,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-length'
            ? declaredLength
            : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (offset >= bytes.length) return { done: true };
              const value = bytes.slice(offset, offset + 4096);
              offset += value.length;
              return { value, done: false };
            },
            async cancel() {
              cancelled = true;
            },
          };
        },
      },
    },
    wasCancelled: () => cancelled,
  };
}

function validLinkResponse() {
  return {
    code: 'ABCDEFGH23',
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

function fakeBot() {
  return {
    commands: new Map(),
    command(name, handler) {
      this.commands.set(name, handler);
    },
  };
}

function fakeCtx(id, text = '/link') {
  const replies = [];
  return {
    from: { id },
    chat: { type: 'private' },
    message: { text },
    session: { __scenes: { current: 'profile-wizard' } },
    replies,
    reply: async (message) => replies.push(message),
  };
}

test('link client sends exact authenticated issue request and accepts a 10-minute code', async () => {
  let captured;
  const responseBody = validLinkResponse();
  const client = new TelegramLinkClient({
    secret: TEST_SECRET,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse(responseBody);
    },
  });

  const result = await client.issueCode('12345');
  assert.deepEqual(result, responseBody);
  assert.equal(captured.url, `${APPROVED_LINK_BASE_URL}/issue`);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, `Bearer ${TEST_SECRET}`);
  assert.deepEqual(JSON.parse(captured.options.body), {
    telegram_user_id: '12345',
  });
});

test('/link always uses ctx.from.id and returns only the code plus short instructions', async () => {
  const bot = fakeBot();
  const calls = [];
  linkCommand.register(bot, {
    client: {
      issueCode: async (id) => {
        calls.push(id);
        return validLinkResponse();
      },
    },
  });
  const ctx = fakeCtx(54321, '/link 99999 monthly admin');

  await bot.commands.get('link')(ctx);

  assert.deepEqual(calls, ['54321']);
  assert.equal(ctx.session.__scenes.current, undefined);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /^ABCDEFGH23\n\n/);
  assert.match(ctx.replies[0], /„Моят профил“/);
  assert.match(ctx.replies[0], /10 минути/);
  assert.doesNotMatch(ctx.replies[0], /99999|monthly|admin/);
});

test('/link handles backend errors safely without leaking secrets', async () => {
  const bot = fakeBot();
  linkCommand.register(bot, {
    client: {
      issueCode: async () => {
        throw new Error(`provider echoed ${TEST_SECRET}`);
      },
    },
  });
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logs.push(args);
  const ctx = fakeCtx(65432);
  try {
    await bot.commands.get('link')(ctx);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(ctx.replies, [linkCommand.LINK_ERROR_MESSAGE]);
  const rendered = JSON.stringify(logs);
  assert.equal(rendered.includes(TEST_SECRET), false);
  assert.equal(rendered.includes('provider echoed'), false);
});

test('/link never issues or exposes a code outside a private chat', async () => {
  for (const chatType of ['group', 'supergroup', 'channel']) {
    const bot = fakeBot();
    let calls = 0;
    linkCommand.register(bot, {
      client: {
        issueCode: async () => {
          calls += 1;
          return validLinkResponse();
        },
      },
    });
    const ctx = fakeCtx(76543);
    ctx.chat.type = chatType;

    await bot.commands.get('link')(ctx);

    assert.equal(calls, 0);
    assert.equal(ctx.replies.length, 1);
    assert.match(ctx.replies[0], /личен разговор/);
    assert.doesNotMatch(ctx.replies[0], /ABCDEFGH23/);
  }
});

test('link client fails closed on HTTP and malformed response errors', async () => {
  const cases = [
    {
      response: jsonResponse({ error: 'unauthorized' }, 401),
      code: 'http_error',
      status: 401,
    },
    {
      response: jsonResponse({
        code: 'SHORT',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
      code: 'invalid_link_response',
      status: null,
    },
    {
      response: jsonResponse({
        code: 'ABCDEFGH23',
        expires_at: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
      }),
      code: 'invalid_link_response',
      status: null,
    },
  ];

  for (const item of cases) {
    const client = new TelegramLinkClient({
      baseUrl: 'https://link.test/functions/v1/telegram-link',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      fetchImpl: async () => item.response,
    });
    await assert.rejects(
      client.issueCode('12345'),
      (error) =>
        error instanceof TelegramLinkError &&
        error.code === item.code &&
        error.status === item.status
    );
  }
});

test('link client stops oversized streamed responses with missing or understated length', async () => {
  for (const declaredLength of [null, '10']) {
    const stream = streamedResponse('x'.repeat(20 * 1024), declaredLength);
    const client = new TelegramLinkClient({
      baseUrl: 'https://link.test/functions/v1/telegram-link',
      allowUnapprovedEndpointForTests: true,
      secret: TEST_SECRET,
      fetchImpl: async () => stream.response,
    });

    await assert.rejects(
      client.issueCode('12345'),
      (error) =>
        error instanceof TelegramLinkError &&
        error.code === 'response_too_large' &&
        error.status === 201
    );
    assert.equal(stream.wasCancelled(), true);
  }
});

test('production link endpoint is pinned and test override is test-only', () => {
  assert.equal(
    new TelegramLinkClient({ secret: TEST_SECRET }).baseUrl,
    APPROVED_LINK_BASE_URL
  );
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(
      () =>
        new TelegramLinkClient({
          baseUrl: 'https://evil.example/functions/v1/telegram-link',
          allowUnapprovedEndpointForTests: true,
          secret: TEST_SECRET,
        }),
      (error) =>
        error instanceof TelegramLinkError &&
        error.code === 'unapproved_link_endpoint'
    );
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});