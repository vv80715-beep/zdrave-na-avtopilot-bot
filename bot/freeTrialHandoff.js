const CONSENT_TTL_MS = 10 * 60 * 1000;

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('bg')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsAny(text, phrases) {
  const normalized = ` ${normalize(text)} `;
  return phrases.some((phrase) => normalized.includes(` ${phrase} `));
}

const HUMAN_TARGETS = [
  'човек',
  'реален човек',
  'истински човек',
  'човек от екипа',
  'собственик',
  'собственика',
  'дани',
  'даниил',
  'dani',
  'owner',
  'support',
  'поддръжка',
  'real person',
  'human',
  'person',
];

const CONTACT_REQUESTS = [
  'искам да говоря с',
  'може ли да говоря с',
  'мога ли да говоря с',
  'искам да се свържа с',
  'може ли да се свържа с',
  'мога ли да се свържа с',
  'свържи ме с',
  'свържете ме с',
  'дай ми контакт с',
  'дай ми линк към профила на',
  'дай ми профила на',
  'искам контакт с',
  'искам да говоря с човек',
  'искам реален човек',
  'искам да говоря с реален човек',
  'can i speak to',
  'can i talk to',
  'i want to speak to',
  'i want to talk to',
  'connect me with',
  'connect me to',
  'talk to a real person',
  'speak to a real person',
];

const EXPLICIT_CONTACT_SHORTCUTS = [
  'свържи ме',
  'свържете ме',
  'искам поддръжка',
  'дай ми поддръжка',
  'talk to support',
  'contact support',
  'connect me with support',
];

const PRODUCT_TOPICS = [
  'продукт',
  'план',
  'планове',
  'абонамент',
  'абонамента',
  'абонаментът',
  'плащане',
  'плащания',
  'плащането',
  'платеж',
  'карта',
  'stripe',
  'цена',
  'цени',
  'такса',
  'услуга',
  'услугата',
  'сервис',
  'платформа',
  'сигурност',
  'доверие',
];

const CONCERN_CUES = [
  'притеснявам се',
  'притеснен съм',
  'притеснена съм',
  'страх ме е',
  'не съм сигурен',
  'не съм сигурна',
  'съмнявам се',
  'не ми е ясно',
  'не разбирам',
  'не знам дали',
  'дали е безопасно',
  'безопасно ли е',
  'сигурно ли е',
  'мога ли да вярвам',
  'може ли да се вярва',
  'измама ли е',
  'скептичен съм',
  'скептична съм',
  'concerned',
  'worried',
  'not sure',
  'unsure',
  'is it safe',
  'can i trust',
  'scam',
];

function isExplicitHumanRequest(text, { requireHumanTarget = false } = {}) {
  const normalized = ` ${normalize(text).replace(/(^| )със(?= |$)/g, '$1с')} `;
  const hasTarget = HUMAN_TARGETS.some((target) => normalized.includes(` ${target} `));
  if (requireHumanTarget && !hasTarget) return false;
  if (EXPLICIT_CONTACT_SHORTCUTS.some((phrase) => normalized.includes(` ${phrase} `))) {
    return true;
  }
  const asksForContact = / (?:искам|може ли|мога ли) да (?:говоря|поговоря|пиша) (?:с|на) /.test(normalized) ||
    CONTACT_REQUESTS.some((phrase) =>
    normalized.includes(` ${phrase} `)
  );
  if (!asksForContact) return false;
  return hasTarget;
}

function isProductConcern(text) {
  return (
    containsAny(text, PRODUCT_TOPICS) &&
    containsAny(text, CONCERN_CUES)
  );
}

function consentAnswer(text) {
  const normalized = normalize(text);
  if ([
    'да',
    'да моля',
    'да искам',
    'искам',
    'свържи ме',
    'добре',
    'ок',
    'okay',
    'yes',
    'yes please',
    'i do',
  ].includes(normalized)) return 'yes';
  if (/^(да|yes) (моля|искам|свържи ме|свържете ме|това искам|please|connect me)$/.test(normalized)) {
    return 'yes';
  }
  if ([
    'не',
    'не благодаря',
    'не искам',
    'не засега',
    'не благодаря засега',
    'продължи нормално',
    'no',
    'no thanks',
    'not now',
  ].includes(normalized)) return 'no';
  if (/^(не|no) (благодаря|искам|засега|thanks|not now)$/.test(normalized)) {
    return 'no';
  }
  return null;
}

function ownerProfileUrl(ownerTelegramId) {
  const id = String(ownerTelegramId || '').trim();
  if (!/^[1-9]\d{4,19}$/.test(id)) return null;
  return `tg://user?id=${id}`;
}

function isActiveFreeTrial(status, now = Date.now()) {
  return Boolean(
    status?.state === 'trial' &&
    status?.plan === 'free' &&
    status?.canChat === true &&
    Number.isFinite(Number(status?.trialExpiresAt)) &&
    Number(status.trialExpiresAt) > now
  );
}

function createFreeTrialHandoffHandler({
  ownerTelegramId = process.env.OWNER_TELEGRAM_ID,
  now = () => Date.now(),
  pendingConsent = new Map(),
} = {}) {
  return async function handleFreeTrialHandoff(ctx, message, status) {
    const userId = String(ctx.from?.id || '');
    // Owner-only live test shortcut: never enter or consume trial consent.
    // Identity comes from Telegram, not the supplied entitlement status.
    if (userId && ownerProfileUrl(ownerTelegramId) &&
        userId === String(ownerTelegramId).trim()) {
      pendingConsent.delete(userId);
      return isExplicitHumanRequest(message, { requireHumanTarget: true })
        ? sendOwnerLink(ctx, ownerTelegramId)
        : false;
    }
    if (!userId || !isActiveFreeTrial(status, now())) {
      pendingConsent.delete(userId);
      return false;
    }

    const pending = pendingConsent.get(userId);
    if (pending && now() - pending.createdAt > CONSENT_TTL_MS) {
      pendingConsent.delete(userId);
    } else if (pending) {
      const answer = consentAnswer(message);
      if (answer === 'yes') {
        pendingConsent.delete(userId);
        return sendOwnerLink(ctx, ownerTelegramId);
      }
      if (answer === 'no') pendingConsent.delete(userId);
      else pendingConsent.delete(userId);
    }

    if (isExplicitHumanRequest(message)) {
      return sendOwnerLink(ctx, ownerTelegramId);
    }
    if (isProductConcern(message)) {
      pendingConsent.set(userId, { createdAt: now() });
      await ctx.reply('Ако искаш, можем да те свържем с реален човек. Искаш ли?');
      return true;
    }
    return false;
  };
}

async function sendOwnerLink(ctx, ownerTelegramId) {
  const url = ownerProfileUrl(ownerTelegramId);
  if (!url) {
    await ctx.reply('В момента не мога да отворя профила на Дани. Опитай отново по-късно.');
    return true;
  }
  await ctx.reply('Разбира се — можеш да се свържеш с Дани директно:', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Свържи се с Дани', url }]],
    },
  });
  return true;
}

module.exports = {
  createFreeTrialHandoffHandler,
  isActiveFreeTrial,
  isExplicitHumanRequest,
  isProductConcern,
  ownerProfileUrl,
};
