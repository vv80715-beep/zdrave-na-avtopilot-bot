// Eli's full personality (identity, mission, tone, the 10 style rules, safety
// and boundaries) lives in ONE place — ./persona. This module only assembles
// the per-message conversation-flow note and the deterministic greeting guard.
const { SYSTEM_PROMPT } = require('./persona');
const { getSofiaTimeParts } = require('./sofiaTime');

// Trusted per-turn clock, using the existing Europe/Sofia + DST formatter.
// Example dates and dates in old messages are never the current server date.
function currentClockNote(now = new Date()) {
  const { dateKey, hhmm } = getSofiaTimeParts(now);
  return `ТЕКУЩА ДАТА И ЧАС ОТ СЪРВЪРА (Europe/Sofia): ${dateKey}, ${hhmm}. За „днес“, дата и час използвай тези стойности, не примери, стари реплики или предположение. Не е нужно да ги повтаряш, ако не са свързани с въпроса.`;
}

// A short, per-message note appended to the system prompt so Eli knows whether
// the conversation is fresh, resumed after a pause, or already flowing — which
// keeps her from re-greeting on every single reply.
function conversationFlowNote(state, now = new Date()) {
  const clock = `${currentClockNote(now)}\n\n`;
  if (state === 'continuing') {
    return clock + 'СЪСТОЯНИЕ НА РАЗГОВОРА: разговорът вече тече. НЕ поздравявай отново и не се представяй пак. Продължи директно по темата.';
  }
  if (state === 'returning') {
    return clock + 'СЪСТОЯНИЕ НА РАЗГОВОРА: потребителят се връща след пауза. Можеш да го поздравиш кратко само веднъж, после продължи по същество.';
  }
  return clock + 'СЪСТОЯНИЕ НА РАЗГОВОРА: начало на разговора. Кратък поздрав е подходящ, после мини към темата.';
}

// Deterministic guard so no reply can re-greet mid-conversation, regardless of
// what the model produces. We only strip a greeting when it sits at the very
// START of the reply and is unmistakably a greeting/opening line — never a
// content sentence that merely happens to contain a warm word. Applied only
// when the conversation is already flowing (see index.js).
const GREETING_OPENERS = [
  /^здравей(те)?[^.!?\n]*[.!?]?\s*/i,
  /^здрасти[^.!?\n]*[.!?]?\s*/i,
  /^привет[^.!?\n]*[.!?]?\s*/i,
  /^добре дошъл[^.!?\n]*[.!?]?\s*/i,
  /^добре дошла[^.!?\n]*[.!?]?\s*/i,
  /^добро утро[^.!?\n]*[.!?]?\s*/i,
  /^добър (ден|вечер)[^.!?\n]*[.!?]?\s*/i,
  /^радвам се,? (че си тук|да те (видя|чуя)|да се чуем|да си поговорим)[^.!?\n]*[.!?]?\s*/i,
  /^как мога да (ти )?помогна(\s+днес)?\s*[?!.]+\s*/i,
  /^с какво мога да (ти )?помогна(\s+днес)?\s*[?!.]+\s*/i,
  /^hello[^.!?\n]*[.!?]?\s*/i,
  /^hi\b[^.!?\n]*[.!?]?\s*/i,
];

// Leading whitespace / punctuation / symbols (including emoji like 👋) that a
// greeting may hide behind, e.g. "👋 Здравей, Данаил!".
const LEADING_SYMBOLS = /^[\s\p{P}\p{S}]+/u;

function stripLeadingGreeting(text) {
  let out = String(text || '').replace(/^\s+/, '');
  let changed = true;
  while (changed) {
    changed = false;
    // Peel any leading emoji/punctuation first, but only commit that removal
    // when a real greeting actually follows — so legitimate content that just
    // starts with an emoji (e.g. "🍽️ Хранения днес") is left untouched.
    const deSym = out.replace(LEADING_SYMBOLS, '');
    for (const re of GREETING_OPENERS) {
      if (re.test(deSym)) {
        out = deSym.replace(re, '').replace(/^\s+/, '');
        changed = true;
        break;
      }
    }
  }
  // If stripping consumed the whole message (reply was only a greeting), keep
  // the original so we never send an empty reply.
  return out.trim() ? out : String(text || '').trim();
}

module.exports = { SYSTEM_PROMPT, currentClockNote, conversationFlowNote, stripLeadingGreeting };
