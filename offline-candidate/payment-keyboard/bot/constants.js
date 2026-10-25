const GOALS = [
  'Отслабване',
  'Качване на мускулна маса',
  'Здравословен начин на живот',
  'По-добър сън',
  'Повече енергия',
];

const ACTIVITY = ['Ниска', 'Средна', 'Висока'];

const EXPERIENCE = ['Начинаещ', 'Средно ниво', 'Напреднал'];

const GENDERS = ['Мъж', 'Жена', 'Предпочитам да не споделям'];

const FIELD_LABELS = {
  firstName: 'Собствено име',
  age: 'Възраст',
  gender: 'Пол',
  height: 'Височина (см)',
  weight: 'Тегло (кг)',
  goal: 'Основна цел',
  activityLevel: 'Ниво на активност',
  trainingExperience: 'Опит с тренировки',
  foodPreferences: 'Хранителни предпочитания',
  medicalNotes: 'Медицински бележки',
};

const FIELD_CHOICES = {
  gender: GENDERS,
  goal: GOALS,
  activityLevel: ACTIVITY,
  trainingExperience: EXPERIENCE,
};

const MEMORY_FIELD_LABELS = {
  injuries: 'Травми',
  allergies: 'Алергии',
  favoriteFoods: 'Любими храни',
  dislikedFoods: 'Нелюбими храни',
  dailyHabits: 'Дневни навици',
  motivationLevel: 'Ниво на мотивация (1-10)',
};

// ── Reminders ────────────────────────────────────────────────────────────────
// Categories shown in the /addreminder wizard.
const REMINDER_CATEGORIES = [
  { key: 'water', label: 'Вода', emoji: '💧' },
  { key: 'workout', label: 'Тренировка', emoji: '🏋️' },
  { key: 'meal', label: 'Хранене', emoji: '🍽️' },
  { key: 'sleep', label: 'Сън', emoji: '😴' },
  { key: 'medication', label: 'Лекарство', emoji: '💊' },
  { key: 'custom', label: 'Друго', emoji: '✨' },
];

const CATEGORY_EMOJI = Object.fromEntries(
  REMINDER_CATEGORIES.map((c) => [c.key, c.emoji])
);
const CATEGORY_LABEL = Object.fromEntries(
  REMINDER_CATEGORIES.map((c) => [c.key, c.label])
);

// Days use JS getDay() indexing: 0 = Sunday ... 6 = Saturday.
const DAY_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
// Display order: Monday-first, Sunday last.
const DAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DAY_PRESETS = {
  everyday: [1, 2, 3, 4, 5, 6, 0],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [6, 0],
};

// Accepted spellings when a user types custom days.
const DAY_ABBR = {
  пн: 1, пнд: 1, понеделник: 1, пон: 1,
  вт: 2, вторник: 2, вто: 2,
  ср: 3, сряда: 3, сря: 3,
  чт: 4, четвъртък: 4, чет: 4,
  пт: 5, петък: 5, пет: 5,
  сб: 6, събота: 6, съб: 6, сабота: 6,
  нд: 0, нед: 0, неделя: 0,
};

module.exports = {
  GOALS,
  ACTIVITY,
  EXPERIENCE,
  GENDERS,
  FIELD_LABELS,
  FIELD_CHOICES,
  MEMORY_FIELD_LABELS,
  REMINDER_CATEGORIES,
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  DAY_SHORT,
  DAY_DISPLAY_ORDER,
  DAY_PRESETS,
  DAY_ABBR,
};
