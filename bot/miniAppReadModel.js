'use strict';

const { isOwnerId } = require('./adminGuard');
const { getUser } = require('./storage');
const { getMemory } = require('./memoryStorage');
const { getUserMemories } = require('./relationshipMemoryStorage');
const { getRange: getHealthLogs } = require('./dailyLogStorage');
const { getHistory: getCheckins } = require('./checkinStorage');
const { getReminders } = require('./reminderStorage');
const { getMode } = require('./avatarModeStorage');
const { resolveReadOnlyAccessStatus } = require('./chatGate');
const { getOwnerDossierEntries } = require('./ownerDossier');

function createMiniAppSnapshotReader(stores = {}) {
  const readProfile = stores.getUser || getUser;
  const readLegacyMemory = stores.getMemory || getMemory;
  const readRelationshipMemory = stores.getUserMemories || getUserMemories;
  const readHealthLogs = stores.getHealthLogs || getHealthLogs;
  const readCheckins = stores.getCheckins || getCheckins;
  const readReminders = stores.getReminders || getReminders;
  const readMode = stores.getMode || getMode;
  const readRecentHistory = stores.getRecentHistory || ((id) => {
    const memory = readLegacyMemory(id);
    return Array.isArray(memory?.conversation) ? memory.conversation : [];
  });
  const readAccess = stores.resolveReadOnlyAccessStatus || stores.resolveAccessStatus || resolveReadOnlyAccessStatus;
  const isOwner = stores.isOwnerId || isOwnerId;
  const readDossier = stores.getOwnerDossierEntries || getOwnerDossierEntries;

  return async function readMiniAppSnapshot(userId) {
    const id = String(userId);
    if (!/^[1-9]\d{4,19}$/.test(id)) throw new Error('mini_app_user_invalid');

    const entitlement = await readAccess({ from: { id } }, { forceRefresh: true });
    const owner = isOwner(id);
    const entitlementVerified = owner || entitlement.backendVerified === true;
    const snapshot = {
      profile: readProfile(id),
      legacyMemory: readLegacyMemory(id),
      relationshipMemory: readRelationshipMemory(id),
      healthLogs: readHealthLogs(id, 30),
      checkins: readCheckins(id, 30),
      reminders: readReminders(id),
      entitlement: {
        // Owner is an app role, not a customer plan. For customers, never
        // present local fallback guesses as authoritative subscription data.
        plan: owner ? 'owner' : entitlementVerified ? entitlement.plan : 'unknown',
        state: owner ? 'owner' : entitlementVerified ? entitlement.state : 'unverified',
        allowedModes: entitlementVerified ? entitlement.allowedModes : [],
        canChat: entitlementVerified && entitlement.canChat,
        planExpiresAt: entitlementVerified ? entitlement.planExpiresAt : null,
        trialExpiresAt: entitlementVerified ? entitlement.trialExpiresAt : null,
        backendVerified: entitlementVerified,
      },
      mode: readMode(id),
      history: readRecentHistory(id).slice(-10).map((turn) => ({
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: String(turn.content || '').slice(0, 2000),
      })),
    };

    if (owner) snapshot.ownerDossier = readDossier(id);
    return snapshot;
  };
}

const readMiniAppSnapshot = createMiniAppSnapshotReader();

module.exports = { createMiniAppSnapshotReader, readMiniAppSnapshot };
