// HeyGen configuration (preparation only — no API calls are made from here).
//
// The three values are read from environment variables managed as Replit
// Secrets. They must NEVER be hardcoded, logged, or committed to Git.
//
// - HEYGEN_API_KEY   — HeyGen API key (sensitive)
// - HEYGEN_AVATAR_ID — the stock HeyGen avatar chosen for Eli
// - HEYGEN_VOICE_ID  — the voice chosen for Eli
//
// The future HeyGen integration should import from this module only:
//   const { getHeyGenConfig, isHeyGenConfigured } = require('./heygenConfig');

function readConfig() {
  return {
    apiKey: process.env.HEYGEN_API_KEY || '',
    avatarId: process.env.HEYGEN_AVATAR_ID || '',
    voiceId: process.env.HEYGEN_VOICE_ID || '',
  };
}

// True only when all three values are present and non-empty.
function isHeyGenConfigured() {
  const c = readConfig();
  return Boolean(c.apiKey && c.avatarId && c.voiceId);
}

// Returns the config, or throws a clear error if something is missing.
// Never include the actual values in error messages or logs.
function getHeyGenConfig() {
  const c = readConfig();
  const missing = [];
  if (!c.apiKey) missing.push('HEYGEN_API_KEY');
  if (!c.avatarId) missing.push('HEYGEN_AVATAR_ID');
  if (!c.voiceId) missing.push('HEYGEN_VOICE_ID');
  if (missing.length) {
    throw new Error(
      `HeyGen is not configured. Missing secrets: ${missing.join(', ')}. ` +
        'Set them via Replit Secrets (never hardcode them).'
    );
  }
  return c;
}

module.exports = { getHeyGenConfig, isHeyGenConfigured };
