const { Markup } = require('telegraf');

const HANDOFF_MESSAGE =
  'Разбира се. Можеш да се свържеш директно с Дани — създателя на „Здраве на автопилот“. Натисни бутона по-долу.';

const PRODUCT_CONTACT_NOTE =
  'Ако искаш да говориш с човек за продукта, плановете или плащането, можеш да се свържеш директно с Дани от бутона по-долу.';

function normalize(text) {
  return String(text || '').trim().toLowerCase();
}

function isExplicitHumanHandoffRequest(text) {
  const value = normalize(text);
  if (!value) return false;

  const patterns = [
    /(?:искам|може ли|как|къде|дай|дайте|моля).{0,40}(?:свържа|говоря|пиша|контактувам).{0,30}(?:човек|оператор|собственик|екип|поддръжк|дани|данаил)/i,
    /(?:свържи|свържете).{0,25}(?:ме|ни)?.{0,25}(?:човек|оператор|собственик|екип|поддръжк|дани|данаил)/i,
    /(?:контакт|връзка).{0,30}(?:човек|оператор|собственик|екип|поддръжк|дани|данаил)/i,
    /(?:говоря|пиша|свържа).{0,25}(?:с|със).{0,20}(?:дани|данаил|собственика|човек|оператор|екипа)/i,
    /(?:human|real person|agent|operator|owner|support).{0,30}(?:contact|talk|speak|chat|message)|(?:contact|talk|speak|chat|message).{0,30}(?:human|real person|agent|operator|owner|support)/i,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function isProductSupportQuestion(text) {
  const value = normalize(text);
  if (!value) return false;

  const patterns = [
    /здраве\s+на\s+автопилот/i,
    /\bпродукт(?:а|ът|и|ът ви|а ви)?\b/i,
    /\bуслуг(?:а|ата|и|ите)\b/i,
    /\btrial\b|пробн\w*\s+период/i,
    /\bабонамент\w*|\bплан(?:ът|а|ове|овете)?\b/i,
    /\bплащан\w*|\bпокуп\w*|\bвъзстанов\w*|\brefund\b|\bcheckout\b|\bstripe\b/i,
    /\bаватар\w*|\bavatar\b|\bобщност\w*|\bcommunity\b/i,
    /\bакаунт\w*|\baccount\b|\bпрофил\w*.*(?:план|абонамент|плащан|достъп)/i,
    /(?:какво|как)\s+(?:представлява|работи|предлагате|предлага).{0,40}(?:продукт|услуг|план|абонамент)/i,
    /(?:колко|каква)\s+(?:струва|е цената).{0,40}(?:план|абонамент|услуг|продукт)/i,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function getOwnerTelegramUrl() {
  const configured = String(process.env.OWNER_TELEGRAM_URL || '').trim();
  if (
    /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$/.test(configured) ||
    /^tg:\/\/user\?id=\d+$/.test(configured)
  ) {
    return configured;
  }

  const ownerId = String(process.env.OWNER_TELEGRAM_ID || '').trim();
  return /^\d+$/.test(ownerId) ? `tg://user?id=${ownerId}` : null;
}

function buildOwnerContactKeyboard() {
  const url = getOwnerTelegramUrl();
  if (!url) return null;
  return Markup.inlineKeyboard([
    [Markup.button.url('👤 Свържи се с Дани', url)],
  ]);
}

function resolveTrialHandoff(status, question) {
  if (!status || status.plan !== 'free' || !status.canChat) return null;

  const keyboard = buildOwnerContactKeyboard();
  if (!keyboard) return null;

  if (isExplicitHumanHandoffRequest(question)) {
    return { kind: 'immediate', keyboard };
  }

  if (isProductSupportQuestion(question)) {
    return { kind: 'append', keyboard };
  }

  return null;
}

module.exports = {
  HANDOFF_MESSAGE,
  PRODUCT_CONTACT_NOTE,
  isExplicitHumanHandoffRequest,
  isProductSupportQuestion,
  getOwnerTelegramUrl,
  buildOwnerContactKeyboard,
  resolveTrialHandoff,
};
