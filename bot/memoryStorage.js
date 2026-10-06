const fs = require('fs');
const path = require('path');

// Long-term, per-user memory. Stored separately from profiles (users.json)
// and check-ins (daily_progress.json). The OWNER identity lives in
// ownerContext.js and is intentionally NOT stored here.
// Resolved per-call from USER_MEMORY_PATH (falling back to the file next to this
// module) so automated tests can isolate writes to a temp file.
function storagePath() {
  return process.env.USER_MEMORY_PATH || path.join(__dirname, 'user_memory.json');
}

const MAX_CONVERSATION = 20; // last 20 messages (~10 exchanges)
const MAX_PLANS = 5;

function load() {
  if (!fs.existsSync(storagePath())) return {};
  try {
    return JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(storagePath(), JSON.stringify(data, null, 2), 'utf8');
}

const MAX_SENT_MOTIVATIONS = 40;
const MAX_WEIGHT_LOG = 60;

function emptyMemory() {
  const now = new Date().toISOString();
  return {
    injuries: null,
    allergies: null,
    favoriteFoods: null,
    dislikedFoods: null,
    dailyHabits: null,
    motivationLevel: null,
    lastWorkout: null,
    plans: [],
    conversation: [],
    sentMotivations: [],
    weightLog: [],
    lastCoachDate: null,
    createdAt: now,
    updatedAt: now,
  };
}

function getMemory(userId) {
  const data = load();
  return data[String(userId)] || null;
}

function setField(userId, field, value) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyMemory();
  data[uid][field] = value;
  data[uid].updatedAt = new Date().toISOString();
  save(data);
  return data[uid];
}

function addPlan(userId, summary) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyMemory();
  data[uid].plans.push({ date: new Date().toISOString(), summary });
  if (data[uid].plans.length > MAX_PLANS) {
    data[uid].plans = data[uid].plans.slice(-MAX_PLANS);
  }
  data[uid].updatedAt = new Date().toISOString();
  save(data);
}

function addConversation(userId, role, content) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyMemory();
  data[uid].conversation.push({ role, content, at: new Date().toISOString() });
  if (data[uid].conversation.length > MAX_CONVERSATION) {
    data[uid].conversation = data[uid].conversation.slice(-MAX_CONVERSATION);
  }
  data[uid].updatedAt = new Date().toISOString();
  save(data);
}

function setLastWorkout(userId, workout) {
  return setField(userId, 'lastWorkout', workout);
}

function setMotivation(userId, level) {
  return setField(userId, 'motivationLevel', level);
}

function addSentMotivation(userId, text) {
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyMemory();
  if (!Array.isArray(data[uid].sentMotivations)) data[uid].sentMotivations = [];
  data[uid].sentMotivations.push(text);
  if (data[uid].sentMotivations.length > MAX_SENT_MOTIVATIONS) {
    data[uid].sentMotivations = data[uid].sentMotivations.slice(-MAX_SENT_MOTIVATIONS);
  }
  data[uid].updatedAt = new Date().toISOString();
  save(data);
}

function getSentMotivations(userId) {
  const memory = getMemory(userId);
  return memory && Array.isArray(memory.sentMotivations) ? memory.sentMotivations : [];
}

function addWeightEntry(userId, weight) {
  if (typeof weight !== 'number' || isNaN(weight)) return;
  const data = load();
  const uid = String(userId);
  if (!data[uid]) data[uid] = emptyMemory();
  if (!Array.isArray(data[uid].weightLog)) data[uid].weightLog = [];
  const last = data[uid].weightLog[data[uid].weightLog.length - 1];
  // Skip duplicate consecutive weights to keep the log meaningful.
  if (!last || last.weight !== weight) {
    data[uid].weightLog.push({ date: new Date().toISOString(), weight });
    if (data[uid].weightLog.length > MAX_WEIGHT_LOG) {
      data[uid].weightLog = data[uid].weightLog.slice(-MAX_WEIGHT_LOG);
    }
    data[uid].updatedAt = new Date().toISOString();
    save(data);
  }
}

function getWeightLog(userId) {
  const memory = getMemory(userId);
  return memory && Array.isArray(memory.weightLog) ? memory.weightLog : [];
}

function setLastCoachDate(userId, dateStr) {
  return setField(userId, 'lastCoachDate', dateStr);
}

function deleteMemory(userId) {
  const data = load();
  const uid = String(userId);
  const existed = Boolean(data[uid]);
  delete data[uid];
  save(data);
  return existed;
}

module.exports = {
  getMemory,
  setField,
  addPlan,
  addConversation,
  setLastWorkout,
  setMotivation,
  addSentMotivation,
  getSentMotivations,
  addWeightEntry,
  getWeightLog,
  setLastCoachDate,
  deleteMemory,
  emptyMemory,
  MAX_CONVERSATION,
  MAX_PLANS,
};
