'use strict';

const { BRAIN_CONTRACT_VERSION, createBrainRequest } = require('./contracts');
const { resolveEliV22Flags } = require('./featureFlags');
const { buildContext, renderContextForModel } = require('./contextBuilder');
const { routeSafety } = require('./safetyRouter');
const { extractMemoryCandidate, ignoredCandidate } = require('./memoryCandidate');

const ELI_BRAIN_MODEL = 'gpt-4o-mini';

function mergeFlagOverrides(base, request) {
  return {
    ...(base || {}),
    ...((request && request.featureFlags) || {}),
  };
}

// AI Brain skeleton. It has no OpenAI, Telegram, HeyGen, entitlement or
// storage dependency. A later adapter can pass the current SYSTEM_PROMPT and
// OpenAI function into this contract while preserving askEli's delivery logic.
function createEliBrain(options = {}) {
  if (options.model && options.model !== ELI_BRAIN_MODEL) {
    throw new RangeError('The Eli V2.2 foundation is pinned to gpt-4o-mini.');
  }

  const contextBuilder = options.contextBuilder || { buildContext, renderContextForModel };
  const safetyRouter = options.safetyRouter || { routeSafety };
  const memoryCandidate = options.memoryCandidate || { extractMemoryCandidate, ignoredCandidate };
  const generate = typeof options.generate === 'function' ? options.generate : null;
  const defaultFlagOverrides = options.featureFlags || {};
  const environment = options.environment || process.env;

  function prepare(input = {}) {
    const request = createBrainRequest(input);
    const flags = resolveEliV22Flags(mergeFlagOverrides(defaultFlagOverrides, input), environment);

    // Legacy is the default. Until integration is explicitly approved, no
    // production route imports or calls this skeleton.
    if (!flags.aiBrain) {
      return {
        contractVersion: BRAIN_CONTRACT_VERSION,
        enabled: false,
        route: 'legacy',
        reason: 'feature_flag_disabled',
        model: ELI_BRAIN_MODEL,
        request,
        flags,
        shouldCallModel: false,
        safety: null,
        context: null,
        memoryCandidate: null,
        systemAddenda: [],
      };
    }

    const safety = safetyRouter.routeSafety(request);
    const context = flags.contextBuilder ? contextBuilder.buildContext(request) : null;
    const candidate = flags.memoryCandidates
      ? memoryCandidate.extractMemoryCandidate({
          message: request.message,
          profile: flags.unifiedProfile ? request.profile : null,
          safety,
          now: request.now,
        })
      : memoryCandidate.ignoredCandidate('feature_flag_disabled');

    const systemAddenda = [safety.systemInstruction];
    if (context) systemAddenda.push(contextBuilder.renderContextForModel(context));

    return {
      contractVersion: BRAIN_CONTRACT_VERSION,
      enabled: true,
      route: 'eli_v2_2',
      model: ELI_BRAIN_MODEL,
      request,
      flags,
      shouldCallModel: safety.shouldCallModel,
      safety,
      context,
      memoryCandidate: candidate,
      systemAddenda,
    };
  }

  async function respond(input = {}) {
    const prepared = prepare(input);

    if (!prepared.enabled) {
      return {
        ...prepared,
        delivery: 'legacy',
        responseText: null,
      };
    }

    if (!prepared.shouldCallModel) {
      return {
        ...prepared,
        delivery: 'deterministic_safety',
        responseText: prepared.safety.responseText,
      };
    }

    // The skeleton never falls back to a real provider. Tests may inject a
    // fake generator; production integration will be a separate approved step.
    if (!generate) {
      return {
        ...prepared,
        delivery: 'not_called',
        responseText: null,
      };
    }

    const responseText = await generate({
      model: ELI_BRAIN_MODEL,
      messages: [
        ...prepared.systemAddenda.map((content) => ({ role: 'system', content })),
        { role: 'user', content: prepared.request.message },
      ],
      request: prepared.request,
      safety: prepared.safety,
      context: prepared.context,
    });

    return {
      ...prepared,
      delivery: 'generated',
      responseText: responseText === undefined || responseText === null ? '' : String(responseText),
    };
  }

  return Object.freeze({
    model: ELI_BRAIN_MODEL,
    prepare,
    respond,
  });
}

module.exports = {
  ELI_BRAIN_MODEL,
  createEliBrain,
};
