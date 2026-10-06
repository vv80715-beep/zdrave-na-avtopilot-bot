// Single source of truth for the long-term user profile fields that Eli (the
// AI) reads and reasons about. Add a field here and it automatically flows into
// the AI memory context AND the "missing info" nudges — no other file needs to
// change to teach Eli about a new field.
//
// Each field:
//   key      - stable identifier
//   label    - Bulgarian label shown to the AI
//   required - if true, Eli is nudged to politely ask for it when it's missing
//   get(profile, memory) - returns a display string, or null when unknown
const PROFILE_SCHEMA = [
  { key: 'firstName', label: 'Име', required: true, get: (p) => p?.firstName ?? null },
  { key: 'age', label: 'Възраст', required: true, get: (p) => (p?.age != null ? String(p.age) : null) },
  { key: 'gender', label: 'Пол', required: true, get: (p) => p?.gender ?? null },
  { key: 'height', label: 'Височина', required: true, get: (p) => (p?.height != null ? `${p.height} см` : null) },
  { key: 'weight', label: 'Тегло', required: true, get: (p) => (p?.weight != null ? `${p.weight} кг` : null) },
  { key: 'goal', label: 'Цел', required: true, get: (p) => p?.goal ?? null },
  { key: 'activityLevel', label: 'Ниво на активност', required: true, get: (p) => p?.activityLevel ?? null },
  { key: 'trainingExperience', label: 'Опит с тренировки', required: false, get: (p) => p?.trainingExperience ?? null },
  {
    key: 'allergies',
    label: 'Алергии / хранителни предпочитания',
    required: true,
    get: (p, m) => m?.allergies ?? p?.foodPreferences ?? null,
  },
  { key: 'medicalNotes', label: 'Медицински бележки', required: false, get: (p) => p?.medicalNotes ?? null },
];

module.exports = { PROFILE_SCHEMA };
