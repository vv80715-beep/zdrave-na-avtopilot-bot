const { PLAN_RULES } = require('./entitlements');

function modePermissionsText(status) {
  const planModes = status.plan === 'owner'
    ? ['text', 'voice', 'avatar']
    : (PLAN_RULES[status.plan]?.modes || ['text']);
  return [['text', 'Текст'], ['voice', 'Глас'], ['avatar', 'Аватар']]
    .map(([mode, label]) => {
      const allowed = status.canChat
        && planModes.includes(mode) && status.allowedModes.includes(mode);
      return `${label}: ${allowed ? '✅' : '🔒'}`;
    }).join('\n');
}

module.exports = { modePermissionsText };