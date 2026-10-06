// ─────────────────────────────────────────────────────────────────────────────
// Context-aware HeyGen Avatar Look selection for Eli's avatar mode.
//
// The LLM that already generates Eli's reply also emits ONE constrained
// category tag ([LOOK:xxx]) at the very end of its answer — no second AI call.
// This module:
//   • parses & strips that tag from the reply text (it must never reach users),
//   • validates the category against a fixed allowlist (anything else → default),
//   • maps it SERVER-SIDE to one of 5 hardcoded, approved Look IDs — neither
//     the model nor the user can ever supply an arbitrary Avatar/Look ID,
//   • applies a stability rule so the Look doesn't flicker between messages.
//
// Look selection NEVER affects entitlements — the avatar credit gate runs
// independently in avatarService/credits before any HeyGen call.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// The ONLY Look IDs that may ever be sent to HeyGen (fixed allowlist).
const LOOKS = {
  default: '31c06953333e4c8895ef9799e6f3c252', // night-city / neutral / fallback
  coach: 'f196cf2416784157b62d6e2cb78ef6af', // plans, steps, structured advice
  calm: 'cb3dee54cbc44fb0ac17bb253a7a48df', // stress/frustration → calm support
  deep_support: 'dd4e9b9b5438450685a8484eb1f0b015', // personal, warmer support
  motivation: '2b488449b95b4c42b42e1b58ea3934ee', // progress, success, energy
};
const CATEGORIES = Object.keys(LOOKS);
// The previous everyday/home default stays allowlisted (it is a legitimate
// Madelyn Look and may still be configured as HEYGEN_AVATAR_ID), but no
// category maps to it anymore — night-city is the neutral default.
const LEGACY_APPROVED_IDS = ['6906845049d1412a8382bd4fa12f3a11'];
const APPROVED_LOOK_IDS = new Set([
  ...Object.values(LOOKS),
  ...LEGACY_APPROVED_IDS,
]);

// Prompt fragment appended to the system prompt ONLY in avatar mode.
const LOOK_PROMPT_NOTE =
  '\n\nСЛУЖЕБНО (никога не го споменавай на потребителя): най-накрая, на ' +
  'отделен последен ред, добави точно един таг [LOOK:категория], където ' +
  'категорията е една от: default, coach, calm, deep_support, motivation. ' +
  'Избери според смисъла на разговора: coach = иска план/стъпки/конкретни ' +
  'съвети; calm = гняв/стрес/раздразнение/обезсърчение (отговори спокойно и ' +
  'подкрепящо); deep_support = по-личен, емоционално труден разговор; ' +
  'motivation = успех/напредък/нужда от насърчение. При съмнение или ' +
  'неутрален разговор винаги избирай default. Тагът е служебен — никакъв ' +
  'друг текст след него.';

// ── Tag parsing ──────────────────────────────────────────────────────────────
// Only a TRAILING tag counts as classification (a user can't inject one mid-
// message and have it honored), but ALL [LOOK:...] fragments are stripped so
// the service tag can never leak into a text/voice/video reply.
const TRAILING_TAG_RE = /\s*\[\s*LOOK\s*:\s*([a-z_]+)\s*\]\s*$/i;
const ANY_TAG_RE = /\s*\[\s*LOOK\s*:[^\]]*\]\s*/gi;

// Shared sanitizer for user-visible delivery chokepoints (text/voice/avatar):
// removes any [LOOK:...] fragment, wherever it came from (model, stored user
// data echoed back, injected text). Cheap and idempotent.
function stripLookTags(text) {
  return String(text || '').replace(ANY_TAG_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

// ── Deterministic context classifier (USER message) ─────────────────────────
// Root-cause fix for wrong-Look selections: the small chat model's [LOOK:...]
// tag is unreliable on emotionally loaded Bulgarian wording (it often falls
// back to "default"). Prompt rules alone are not enough (known gpt-4o-mini
// pattern), so a deterministic keyword classifier over the USER'S OWN message
// overrides the model tag whenever a clear signal is present; the model tag is
// only used when the user's wording is neutral/ambiguous. Cyrillic-safe: no
// \b or \w (ASCII-only in JS) — explicit [а-я] boundaries instead.
// Every alternative starts at a word boundary ((?<![а-я]) — JS \b is ASCII-
// only) so stems can't fire inside unrelated words ("планината" ≠ "план").
// Coach additionally requires REQUEST phrasing — a mere topic mention
// ("днес бях на тренировка") must not hijack the Look.
const COACH_REQUEST_RE =
  /(?<![а-я])(дай ми|искам|направи ми|изготви|предложи ми|може ли|имам нужда от|помогни ми с)(?![а-я])/;
const CONTEXT_RULES = [
  // Most specific / most sensitive first.
  {
    category: 'deep_support',
    re: /(?<![а-я])(тъж|тъга|плач|плака|разплака|самот|загуб|почина|скръб|скърб|депрес|отчая|безнадежд|мъка|мъчно ми|тежко ми е|боли ме душ|сърцето ми е свито|не издържам|предавам се)/,
  },
  {
    category: 'calm',
    re: /(?<![а-я])(ядос|гняв|гневн|яд ме е|бесен|бясна|вбес|напрегнат|напрежение|стрес|ме дразн|дразни ме|изнерв|нервира|тревож|безпокой|паник|притесн|успоко|да се отпусна)/,
  },
  {
    category: 'motivation',
    re: /(?<![а-я])(успях|постигнах|справих се|гордея|горд[аи]? съм|напредък|напреднах|мотивац|мотивир|насърч|вдъхнов|нямам сили да продължа|давай ми сили|похвали ме)/,
  },
  {
    category: 'coach',
    re: /(?<![а-я])(план(?![а-я])|план за|програма|режим(?![а-я])|график|разписание|стъпка по стъпка)/,
    require: COACH_REQUEST_RE,
  },
];

function normalizeForContext(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[„“"”'’«»]/g, ' ')
    .replace(/\s+/g, ' ');
}

// Returns a category when the user's wording carries a clear signal, else null.
function classifyUserContext(userText) {
  const t = normalizeForContext(userText);
  if (!t) return null;
  for (const rule of CONTEXT_RULES) {
    if (rule.re.test(t) && (!rule.require || rule.require.test(t))) {
      return rule.category;
    }
  }
  return null;
}

// Final category for a turn: deterministic user-signal wins; the LLM tag is
// the fallback for neutral/ambiguous wording. Output is always allowlisted.
function chooseLookCategory(userText, llmCategory) {
  const detected = classifyUserContext(userText);
  if (detected) return detected;
  return CATEGORIES.includes(llmCategory) ? llmCategory : 'default';
}

function parseLookTag(raw) {
  const text = String(raw || '');
  const m = text.match(TRAILING_TAG_RE);
  const candidate = m ? m[1].toLowerCase() : null;
  const category = CATEGORIES.includes(candidate) ? candidate : 'default';
  const cleaned = text.replace(ANY_TAG_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: cleaned, category };
}

// ── Per-user Look state (stability) ──────────────────────────────────────────
// Minimal state: current category + how many consecutive turns classified as
// plain "default" while a special Look is active. Rules:
//   • same category → keep (stable within one context),
//   • a DIFFERENT non-default category → switch immediately (clear signal),
//   • "default" while a special Look is active → switch back only after 2
//     consecutive default turns (small wording changes can't cause
//     DEFAULT→CALM→DEFAULT oscillation).
const DEFAULT_REVERT_AFTER = 2;

const STATE_PATH =
  process.env.AVATAR_LOOK_PATH || path.join(__dirname, 'avatar_looks.json');

// Coerce a loaded entry to a guaranteed-safe shape — a poisoned or malformed
// file can never break the stability rules or crash the selector.
function sanitizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const current = CATEGORIES.includes(e.current) ? e.current : 'default';
  const streak =
    Number.isFinite(e.defaultStreak) && e.defaultStreak >= 0
      ? Math.floor(e.defaultStreak)
      : 0;
  return { current, defaultStreak: streak };
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  try {
    // Atomic write: temp file in the same directory, then rename — a crash
    // mid-write can never leave a truncated state file behind.
    const tmpPath = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, STATE_PATH);
  } catch (err) {
    // Non-fatal: worst case the Look resets to default after a restart.
    console.error('Avatar look state save failed:', err.name || 'error');
  }
}

// Applies the stability rules and returns the category to actually use.
function stabilizeLook(userId, category) {
  const key = String(userId);
  const cat = CATEGORIES.includes(category) ? category : 'default';
  const state = loadState();
  const entry = sanitizeEntry(state[key]);

  let next = entry.current;
  if (cat === entry.current) {
    entry.defaultStreak = 0; // same context → stable
  } else if (cat !== 'default') {
    next = cat; // clear, meaningful context change → switch now
    entry.defaultStreak = 0;
  } else {
    entry.defaultStreak += 1; // drifting back to neutral — debounce the revert
    if (entry.defaultStreak >= DEFAULT_REVERT_AFTER) {
      next = 'default';
      entry.defaultStreak = 0;
    }
  }

  entry.current = next;
  state[key] = entry;
  saveState(state);
  return next;
}

// Category → approved Look ID. Anything unexpected resolves to the default
// Look, so the value passed toward HeyGen is ALWAYS from the allowlist.
function resolveLookId(userId, category) {
  const stable = stabilizeLook(userId, category);
  return LOOKS[stable] || LOOKS.default;
}

function isApprovedLookId(id) {
  return APPROVED_LOOK_IDS.has(String(id || ''));
}

module.exports = {
  LOOKS,
  CATEGORIES,
  classifyUserContext,
  chooseLookCategory,
  LOOK_PROMPT_NOTE,
  parseLookTag,
  stripLookTags,
  stabilizeLook,
  resolveLookId,
  isApprovedLookId,
  DEFAULT_REVERT_AFTER,
};
