// Detects when a user is explicitly asking what Eli has stored about them, e.g.
// "Какво знаеш за мен?", "Покажи ми профила", "What do you know about me?",
// "Summarize my information". Such questions must be answered deterministically
// from the stored profile (never invented by the LLM), so the caller can route
// them to formatFullMemory instead of the chat model.
const PROFILE_QUERY_PATTERNS = [
  // ── Bulgarian ──
  /какво\s+(си\s+)?(знаеш|помниш|запомни(л|ла)?|си\s+запомнил(а)?)\s+за\s+мен(е)?/,
  /какви\s+(данни|неща)\s+(имаш|знаеш|помниш)\s+за\s+мен(е)?/,
  /какво\s+имаш\s+за\s+мен(е)?/,
  /(кажи|покажи|дай)( ми)?\s+(моя|моят|мойте)?\s*профил/,
  /профил(а|ът|ите)?\s+ми/,
  /мо(я|ят|ето)\s+профил/,
  /обобщи( ми)?\s+(моята\s+)?(информаци(я|ята)|данни(те)?|профил(а)?)/,
  /обобщение\s+на\s+(моята\s+)?(информаци(я|ята)|профил(а)?|данни(те)?)/,
  /мо(ята|ите)\s+(информаци(я|ята)|данни)/,
  /запаметен(ата|ите)( ми)?\s+(информаци(я|ята)|данни)/,
  // ── English ──
  /what\s+do\s+you\s+know\s+about\s+me/,
  /what\s+(info|information|data|details)\s+do\s+you\s+(have|know|store|keep)\s+about\s+me/,
  /what\s+have\s+you\s+(stored|saved|kept)\s+about\s+me/,
  /(tell|show|give)\s+me\s+(about\s+)?my\s+profile/,
  /(what('|’)?s|what\s+is)\s+(in\s+)?my\s+profile/,
  /(view|see|check|read|display)\s+my\s+profile/,
  /summar(ize|y)\s+(of\s+)?my\s+(info|information|profile|data|details)/,
];

function isProfileQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text
    .toLowerCase()
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return PROFILE_QUERY_PATTERNS.some((re) => re.test(normalized));
}

module.exports = { isProfileQuery };
