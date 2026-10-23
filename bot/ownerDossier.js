'use strict';

// Private, local owner-only dossier. The file is intentionally separate from
// source code, customer profiles, health logs, and the public brand/site.
const fs = require('fs');
const path = require('path');
const { isOwnerId } = require('./adminGuard');

const DOSSIER_PATH = () =>
  process.env.OWNER_DOSSIER_PATH || path.join(__dirname, 'owner_dossier.json');

function read(userId) {
  if (!isOwnerId(userId)) return null;
  const file = DOSSIER_PATH();
  if (!fs.existsSync(file)) return { schemaVersion: 1, facts: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.facts)) {
    throw new Error('owner_dossier_invalid');
  }
  return value;
}

function write(userId, value) {
  if (!isOwnerId(userId)) return false;
  const target = DOSSIER_PATH();
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  return true;
}

function getOwnerDossierEntries(userId) {
  const data = read(userId);
  return data ? data.facts.filter((x) =>
    x && typeof x.id === 'string' &&
    ['personal_facts', 'goals', 'motivation', 'plans', 'relationship_context', 'recurring_challenges', 'meaningful_progress'].includes(x.category) &&
    typeof x.value === 'string' && x.value.trim()
  ).map((x) => ({ ...x })) : [];
}

function updateOwnerDossierEntry(userId, id, value) {
  const data = read(userId);
  if (!data || typeof value !== 'string' || !value.trim()) return false;
  const entry = data.facts.find((x) => x.id === id);
  if (!entry) return false;
  entry.value = value.trim();
  data.updatedAt = new Date().toISOString();
  write(userId, data);
  return getOwnerDossierEntries(userId).some((x) => x.id === id && x.value === entry.value);
}

function deleteOwnerDossierEntry(userId, id) {
  const data = read(userId);
  if (!data) return false;
  const before = data.facts.length;
  data.facts = data.facts.filter((x) => x.id !== id);
  if (data.facts.length === before) return false;
  data.updatedAt = new Date().toISOString();
  write(userId, data);
  return !getOwnerDossierEntries(userId).some((x) => x.id === id);
}

function clearOwnerDossier(userId) {
  if (!isOwnerId(userId)) return false;
  const target = DOSSIER_PATH();
  if (!fs.existsSync(target)) return true;
  fs.rmSync(target);
  return !fs.existsSync(target);
}

function mapTarget(target) {
  const t = String(target || '').toLocaleLowerCase('bg');
  if (/мисия|бизнес.*коуч|коуч.*бизнес/.test(t)) return ['business-mission'];
  if (/фитнес|лост|тегло|трениров/.test(t)) return ['fitness-goals'];
  if (/финансов.*(мечт|независ)|мечт|независ/.test(t)) return ['financial-dream'];
  if (/самостоятел|за себе си/.test(t)) return ['self-employment'];
  if (/значим|успех/.test(t)) return ['meaningful-work'];
  if (/устойчив.*доход|стабил.*приход|приход/.test(t)) return ['sustainable-income'];
  if (/работа.*измор|текущ.*работ|напуска/.test(t)) return ['work-context'];
  if (/работ|финансов|доход|цел/.test(t)) {
    return ['financial-dream', 'self-employment', 'meaningful-work', 'sustainable-income', 'work-context'];
  }
  if (/мотив|създадох.*ели|защо.*ели/.test(t)) return ['motivation', 'creator-effort', 'first-customers'];
  if (/ели|асистент|отношен/.test(t)) return ['eli-relationship'];
  if (/име|варна|график|сън|нощн/.test(t)) return ['preferred-name', 'location', 'schedule-context'];
  return [];
}

function applyOwnerDossierMemoryCommand(userId, command) {
  if (!isOwnerId(userId) || !command || command.all) return null;
  const ids = mapTarget(command.target);
  if (command.type === 'recall') {
    const selected = getOwnerDossierEntries(userId).filter((x) =>
      !command.category || x.category === command.category
    );
    return selected.length
      ? `Записано в owner досието:\n${selected.map((x) => `• ${x.value}`).join('\n')}`
      : 'Няма записан owner факт по тази тема.';
  }
  if (!ids.length) return null;
  if (command.type === 'forget') {
    const matches = getOwnerDossierEntries(userId).filter((x) => ids.includes(x.id));
    if (matches.length !== 1) {
      return matches.length
        ? 'Намерих няколко owner записа. Уточни дали искаш да изтрия личната цел, мотивацията или бизнес мисията.'
        : 'Не открих такъв owner запис и не изтрих нищо.';
    }
    return deleteOwnerDossierEntry(userId, matches[0].id)
      ? 'Изтрих и проверих owner записа.'
      : 'Не успях да потвърдя изтриването.';
  }
  if (command.type === 'update') {
    const matches = getOwnerDossierEntries(userId).filter((x) => ids.includes(x.id));
    if (matches.length !== 1) {
      return matches.length
        ? 'Уточни кой owner запис да променя; засега нищо не е променено.'
        : 'Не открих еднозначен owner запис; нищо не е променено.';
    }
    return updateOwnerDossierEntry(userId, matches[0].id, command.value)
      ? 'Обнових и проверих owner записа.'
      : 'Не успях да потвърдя промяната.';
  }
  return null;
}

function detectOwnerDossierQuestion(message) {
  const t = String(message || '').toLocaleLowerCase('bg');
  if (/(каква е|каква ти е|твоята) мисия/.test(t)) return 'business_mission';
  if (/(защо|с каква цел).{0,35}(създадох|направих|изградих).{0,20}ели|защо създадох ели/.test(t)) return 'creation_reason';
  if (/(какви са|каква е).{0,25}(моите |ми )?(цели|мечта)|голямата ми мечта/.test(t)) return 'goals';
  return null;
}

function answerOwnerDossierQuestion(userId, intent) {
  const facts = getOwnerDossierEntries(userId);
  const find = (...ids) => facts.filter((x) => ids.includes(x.id)).map((x) => x.value);
  const lines = [];
  if (intent === 'business_mission') {
    lines.push(...find('business-mission'));
    return lines.length ? lines.join('\n') : 'Не знам потвърдена мисия на бизнеса; можеш да я добавиш или актуализираш.';
  }
  if (intent === 'creation_reason') {
    const personal = find('motivation', 'creator-effort');
    const business = find('business-mission');
    if (personal.length) lines.push(`Личната ти причина:\n${personal.join('\n')}`);
    if (business.length) lines.push(`Мисията на бизнеса:\n${business.join('\n')}`);
    return lines.length ? lines.join('\n\n') : 'Не знам потвърдената причина; можеш да я добавиш или актуализираш.';
  }
  if (intent === 'goals') {
    lines.push(...find('financial-dream', 'self-employment', 'meaningful-work', 'sustainable-income', 'fitness-goals'));
    return lines.length
      ? `Записани цели и мечти (не означава, че са постигнати):\n${lines.map((x) => `• ${x}`).join('\n')}`
      : 'Не знам потвърдени цели; можеш да ги добавиш или актуализираш.';
  }
  return 'Не знам потвърдена информация по този въпрос.';
}

function formatOwnerDossierSummary(userId) {
  const facts = getOwnerDossierEntries(userId);
  if (!facts.length) return '';
  const privateFacts = facts.filter((x) => x.id !== 'business-mission');
  const business = facts.find((x) => x.id === 'business-mission');
  const lines = ['🧭 Owner досие'];
  if (privateFacts.length) {
    lines.push('Лични факти и цели (целите не са потвърдени като постигнати):');
    for (const fact of privateFacts) lines.push(`• ${fact.value}`);
  }
  if (business) lines.push(`Мисия на бизнеса (отделно от личната мотивация):\n• ${business.value}`);
  return lines.join('\n');
}

function buildOwnerDossierPrompt(userId, question) {
  const facts = getOwnerDossierEntries(userId);
  const t = String(question || '').toLocaleLowerCase('bg');
  if (!facts.length || !/(име|наричай|name|цел|мечт|мотив|бизнес|мисия|ели|работ|финанс|лост|тренир|сън|график|зает)/.test(t)) return '';
  const include = facts.filter((x) => {
    if (x.id === 'business-mission') return /(бизнес|мисия|ели|създадох|продукт)/.test(t);
    if (x.id === 'fitness-goals') return /(цел|лост|тренир|тегло|фитнес)/.test(t);
    if (x.id === 'schedule-context') return /(сън|график|работ|смян)/.test(t);
    if (x.id === 'work-context') return /(работ|бизнес|финанс|приход|напуска)/.test(t);
    if (['financial-dream', 'self-employment', 'meaningful-work', 'sustainable-income'].includes(x.id)) {
      return /(цел|мечт|бизнес|мисия|работ|финанс|доход|независ|успех)/.test(t);
    }
    if (['motivation', 'creator-effort', 'first-customers'].includes(x.id)) {
      return /(мотив|бизнес|мисия|ели|създадох|продукт|клиент)/.test(t);
    }
    if (x.id === 'eli-relationship') return /(ели|асистент|общуван|тон)/.test(t);
    if (x.id === 'preferred-name') return /(име|обръщай|наричай)/.test(t);
    if (x.id === 'location') return /(варна|къде жив)/.test(t);
    return false;
  });
  if (!include.length) return '';
  return [
    'ПОВЕРИТЕЛЕН OWNER КОНТЕКСТ: използвай само когато е пряко уместно; не разкривай на клиенти и не представяй цели като постигнати.',
    'Не съветвай напускане на работа преди стабилни приходи. Бизнес мисията е отделна от личната мотивация.',
    ...include.map((x) => `- ${x.value}`),
  ].join('\n');
}

module.exports = {
  getOwnerDossierEntries,
  updateOwnerDossierEntry,
  deleteOwnerDossierEntry,
  clearOwnerDossier,
  applyOwnerDossierMemoryCommand,
  detectOwnerDossierQuestion,
  answerOwnerDossierQuestion,
  formatOwnerDossierSummary,
  buildOwnerDossierPrompt,
};
