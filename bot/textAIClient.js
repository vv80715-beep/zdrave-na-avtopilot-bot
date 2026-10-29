const openai = require('./openaiClient');
const { isOwnerId } = require('./adminGuard');
const { withRuntimeContext } = require('./sofiaClock');

// Gemini's API currently lists 2.5 Flash-Lite but rejects new-user generation
// with NOT_FOUND and directs callers to 3.5 Flash-Lite.
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MODEL_PRICES = {
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: null, output: null },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};
const USER_WINDOW_MS = 60_000;
const USER_REQUEST_LIMIT = 12;
const GLOBAL_REQUEST_LIMIT = 120;
const MAX_INPUT_CHARS = 48_000;
const MAX_OUTPUT_TOKENS = 4_096;

const userWindows = new Map();
const globalRequests = [];
const usage = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };

function getProvider(userId, env = process.env) {
  if (env.GEMINI_OWNER_CANARY_ENABLED === 'true' && isOwnerId(userId)) {
    return 'gemini';
  }
  const configured = env.TEXT_AI_PROVIDER || 'openai';
  return configured === 'openai' || configured === 'gemini' ? configured : 'invalid';
}

function hasTextAIProvider(userId, env = process.env) {
  const provider = getProvider(userId, env);
  if (provider === 'openai') return Boolean(openai);
  if (provider === 'gemini') return Boolean(env.GEMINI_API_KEY);
  return false;
}

function pruneTimes(times, now) {
  while (times.length && now - times[0] >= USER_WINDOW_MS) times.shift();
}

function enforceRateLimit(userId, now = Date.now()) {
  const id = String(userId ?? 'unknown');
  const userTimes = userWindows.get(id) || [];
  pruneTimes(userTimes, now);
  pruneTimes(globalRequests, now);
  if (userWindows.size > 10_000) {
    for (const [key, times] of userWindows) {
      pruneTimes(times, now);
      if (!times.length) userWindows.delete(key);
    }
  }
  if (userTimes.length >= USER_REQUEST_LIMIT || globalRequests.length >= GLOBAL_REQUEST_LIMIT) {
    throw new Error('text_ai_rate_limited');
  }
  userTimes.push(now);
  globalRequests.push(now);
  userWindows.set(id, userTimes);
}

function createOpenAIClientWrapper(client, userId, { now = Date.now } = {}) {
  return {
    chat: {
      completions: {
        async create(options = {}) {
          enforceRateLimit(userId, now());
          const { signal, noRetries, ...parameters } = options;
          parameters.messages = withRuntimeContext(parameters.messages, new Date(now()));
          const result = await client.chat.completions.create(
            parameters,
            signal || noRetries ? { ...(signal ? { signal } : {}), ...(noRetries ? { maxRetries: 0 } : {}) } : undefined,
          );
          const modelName = options.model || 'unknown';
          const prices = MODEL_PRICES[modelName];
          const promptTokens = Number(result?.usage?.prompt_tokens) || 0;
          const outputTokens = Number(result?.usage?.completion_tokens) || 0;
          const cachedTokens = Number(result?.usage?.prompt_tokens_details?.cached_tokens) || 0;
          const estimatedUsd = prices && Number.isFinite(prices.input) && Number.isFinite(prices.output)
            ? ((promptTokens - cachedTokens) * prices.input +
              cachedTokens * prices.input * 0.5 +
              outputTokens * prices.output) / 1_000_000
            : null;
          usage.requests += 1;
          usage.inputTokens += promptTokens;
          usage.outputTokens += outputTokens;
          if (estimatedUsd !== null) usage.estimatedUsd += estimatedUsd;
          console.info(
            `Text AI usage provider=openai model=${modelName} input_tokens=${promptTokens} output_tokens=${outputTokens} estimated_usd=${estimatedUsd === null ? 'unavailable' : estimatedUsd.toFixed(6)}`
          );
          return result;
        },
      },
    },
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('gemini_invalid_messages');
  let systemText = '';
  const contents = [];
  let chars = 0;

  for (const message of messages) {
    const text = typeof message?.content === 'string' ? message.content : '';
    chars += text.length;
    if (message?.role === 'system') {
      if (text) systemText += `${systemText ? '\n\n' : ''}${text}`;
      continue;
    }
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      throw new Error('gemini_invalid_role');
    }
    if (text) {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      });
    }
  }
  if (chars > MAX_INPUT_CHARS) throw new Error('gemini_input_too_large');
  return { systemText, contents };
}

function createGeminiClient({ apiKey, model, userId, fetchFn = global.fetch, logger = console }) {
  if (!apiKey) throw new Error('gemini_not_configured');
  const modelName = model || GEMINI_DEFAULT_MODEL;

  return {
    chat: {
      completions: {
        async create(options = {}) {
          const { systemText, contents } = normalizeMessages(options.messages);
          enforceRateLimit(userId);
          const requestedMax = Number(options.max_tokens);
          const maxOutputTokens = Number.isFinite(requestedMax) && requestedMax > 0
            ? Math.min(Math.floor(requestedMax), MAX_OUTPUT_TOKENS)
            : 600;
          const generationConfig = { maxOutputTokens };
          if (Number.isFinite(options.temperature)) {
            generationConfig.temperature = Math.max(0, Math.min(2, options.temperature));
          }
          const body = { contents, generationConfig };
          if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
          let response;
          try {
            response = await fetchFn(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-goog-api-key': apiKey,
              },
              body: JSON.stringify(body),
              signal: options.signal || AbortSignal.timeout(30_000),
            });
          } catch {
            throw new Error('gemini_network_error');
          }

          if (!response.ok) {
            if (response.status === 429) throw new Error('gemini_rate_limited');
            if (response.status >= 500) throw new Error('gemini_service_unavailable');
            throw new Error(`gemini_request_rejected_${response.status}`);
          }

          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error('gemini_invalid_response');
          }
          const candidate = data?.candidates?.[0];
          const text = candidate?.content?.parts
            ?.map((part) => typeof part.text === 'string' ? part.text : '')
            .join('') || '';
          if (!text) throw new Error('gemini_empty_response');

          const promptTokens = Number(data?.usageMetadata?.promptTokenCount) || 0;
          const outputTokens = Number(data?.usageMetadata?.candidatesTokenCount) || 0;
          const prices = MODEL_PRICES[modelName];
          const estimatedUsd = prices && Number.isFinite(prices.input) && Number.isFinite(prices.output)
            ? (promptTokens * prices.input + outputTokens * prices.output) / 1_000_000
            : null;
          usage.requests += 1;
          usage.inputTokens += promptTokens;
          usage.outputTokens += outputTokens;
          if (estimatedUsd !== null) usage.estimatedUsd += estimatedUsd;
          // Deliberately excludes user IDs, prompts, and generated text.
          logger.info?.(
            `Text AI usage provider=gemini model=${modelName} input_tokens=${promptTokens} output_tokens=${outputTokens} estimated_usd=${estimatedUsd === null ? 'unavailable' : estimatedUsd.toFixed(6)}`
          );

          return {
            choices: [{
              message: { role: 'assistant', content: text },
              finish_reason: candidate?.finishReason || null,
            }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: outputTokens,
              total_tokens: promptTokens + outputTokens,
            },
          };
        },
      },
    },
  };
}

function getTextAIClient(userId, env = process.env) {
  const provider = getProvider(userId, env);
  if (provider === 'invalid') return null;
  if (provider === 'openai') {
    if (!openai) return null;
    return createOpenAIClientWrapper(openai, userId);
  }
  if (!env.GEMINI_API_KEY) return null;
  return createGeminiClient({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
    userId,
  });
}

function getUsageSnapshot() {
  return { ...usage };
}

module.exports = {
  GEMINI_DEFAULT_MODEL,
  createGeminiClient,
  createOpenAIClientWrapper,
  getProvider,
  getTextAIClient,
  hasTextAIProvider,
  getUsageSnapshot,
};
