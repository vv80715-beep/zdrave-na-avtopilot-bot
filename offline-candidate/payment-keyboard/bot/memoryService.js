const { getUser } = require('./storage');
const { getMemory } = require('./memoryStorage');
const { getHistory } = require('./checkinStorage');
const { PROFILE_SCHEMA } = require('./profileSchema');

function formatWorkout(w) {
  if (!w) return '—';
  const d = w.date ? new Date(w.date).toLocaleDateString('bg-BG') : '';
  return `${d}${w.note ? ' — ' + w.note : ''}`.trim() || '—';
}

// Compact memory block injected into the AI system prompt so Eli
// automatically personalizes every conversation. Never used for the owner.
function buildMemoryContext(userId) {
  const profile = getUser(userId);
  const memory = getMemory(userId);
  const checkins = getHistory(userId, 7);

  const lines = [
    'ПАМЕТ ЗА ТОЗИ ПОТРЕБИТЕЛ (използвай я, за да персонализираш разговора естествено; не я изброявай освен ако те питат директно):',
  ];

  // Core profile fields come from the shared schema so adding a new field in
  // profileSchema.js automatically teaches Eli about it (and nudges when missing).
  const missing = [];
  for (const field of PROFILE_SCHEMA) {
    const value = field.get(profile, memory);
    if (value != null && value !== '') {
      lines.push(`- ${field.label}: ${value}`);
    } else if (field.required) {
      missing.push(field.label);
    }
  }

  if (memory) {
    if (memory.injuries) lines.push(`- Травми: ${memory.injuries}`);
    if (memory.favoriteFoods) lines.push(`- Любими храни: ${memory.favoriteFoods}`);
    if (memory.dislikedFoods) lines.push(`- Нелюбими храни: ${memory.dislikedFoods}`);
    if (memory.dailyHabits) lines.push(`- Дневни навици: ${memory.dailyHabits}`);
    if (memory.motivationLevel != null) lines.push(`- Ниво на мотивация: ${memory.motivationLevel}/10`);
    if (memory.lastWorkout) lines.push(`- Последна тренировка: ${formatWorkout(memory.lastWorkout)}`);
    if (memory.plans && memory.plans.length) {
      const last = memory.plans[memory.plans.length - 1];
      lines.push(`- Последен създаден план: ${new Date(last.date).toLocaleDateString('bg-BG')}`);
    }
  }

  if (checkins.length) {
    const c = checkins[0];
    lines.push(
      `- Последен check-in (${c.date}): вода ${c.water ? 'да' : 'не'}, тренировка ${c.trained ? 'да' : 'не'}, хранене ${c.nutrition ? 'да' : 'не'}, сън ${c.sleep}ч, настроение ${c.mood}/10, енергия ${c.energy}/10`
    );
    lines.push(`- Брой check-ини (последни 7 дни): ${checkins.length}`);
  }

  if (missing.length) {
    lines.push(
      '',
      `ЛИПСВАЩА ИНФОРМАЦИЯ: все още не знаеш ${missing.join(', ')}. Когато е уместно и звучи естествено в разговора, помоли учтиво потребителя да сподели тези данни — по едно-две неща наведнъж, никога като разпит. Не измисляй стойности; ако потребителят не иска да сподели, уважи избора му.`
    );
  }

  return lines.join('\n');
}

// Recent conversation turns as chat messages for continuity.
function recentMessages(userId, limit = 10) {
  const memory = getMemory(userId);
  if (!memory || !memory.conversation) return [];
  return memory.conversation
    .slice(-limit)
    .map(({ role, content }) => ({ role, content }));
}

// Human-readable memory dump for /showmemory and admin inspection.
function formatFullMemory(userId, opts = {}) {
  const profile = getUser(userId);
  const memory = getMemory(userId);
  const checkins = getHistory(userId, 7);

  if (!profile && !memory && checkins.length === 0) {
    return opts.admin
      ? `❕ Няма запазена памет за потребител \`${userId}\`.`
      : 'Все още нямам запазена памет за теб. 😊\n\nСъздай профил с /profile или просто започни да пишеш с мен — започвам да помня.';
  }

  const lines = [
    opts.admin
      ? `🧠 *Памет за потребител* \`${userId}\``
      : `🧠 *Какво помня за теб*`,
    '',
    '*👤 Основни данни*',
    `• Име: ${profile?.firstName ?? '—'}`,
    `• Възраст: ${profile?.age ?? '—'}`,
    `• Пол: ${profile?.gender ?? '—'}`,
    `• Височина: ${profile?.height != null ? profile.height + ' см' : '—'}`,
    `• Тегло: ${profile?.weight != null ? profile.weight + ' кг' : '—'}`,
    `• Цел: ${profile?.goal ?? '—'}`,
    `• Активност: ${profile?.activityLevel ?? '—'}`,
    '',
    '*🩺 Здраве и хранене*',
    `• Травми: ${memory?.injuries ?? '—'}`,
    `• Алергии: ${memory?.allergies ?? profile?.foodPreferences ?? '—'}`,
    `• Медицински бележки: ${profile?.medicalNotes ?? '—'}`,
    `• Любими храни: ${memory?.favoriteFoods ?? '—'}`,
    `• Нелюбими храни: ${memory?.dislikedFoods ?? '—'}`,
    `• Дневни навици: ${memory?.dailyHabits ?? '—'}`,
    '',
    '*🔥 Прогрес*',
    `• Ниво на мотивация: ${memory?.motivationLevel != null ? memory.motivationLevel + '/10' : '—'}`,
    `• Последна тренировка: ${memory?.lastWorkout ? formatWorkout(memory.lastWorkout) : '—'}`,
    `• Създадени планове: ${memory?.plans?.length ?? 0}`,
    `• Check-ини (последни 7 дни): ${checkins.length}`,
    `• Запомнени съобщения: ${memory?.conversation?.length ?? 0}`,
  ];

  if (checkins.length) {
    const c = checkins[0];
    lines.push('', `*📅 Последен check-in* (${c.date})`);
    lines.push(
      `💧 ${c.water ? 'да' : 'не'} · 🏋️ ${c.trained ? 'да' : 'не'} · 🥗 ${c.nutrition ? 'да' : 'не'} · 😴 ${c.sleep}ч · 😊 ${c.mood}/10 · ⚡ ${c.energy}/10`
    );
  }

  return lines.join('\n');
}

module.exports = { buildMemoryContext, recentMessages, formatFullMemory, formatWorkout };
