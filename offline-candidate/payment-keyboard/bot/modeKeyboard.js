const { Markup } = require('telegraf');

const MODE_BUTTON_LABELS = Object.freeze({
  text: 'Пиши с Ели',
  voice: 'Говори с Ели',
  avatar: 'Говори с аватара на Ели',
});

function createModeKeyboard(allowedModes) {
  if (!Array.isArray(allowedModes)) return null;
  const labels = [...new Set(allowedModes)]
    .filter((mode) => Object.hasOwn(MODE_BUTTON_LABELS, mode))
    .map((mode) => MODE_BUTTON_LABELS[mode]);
  if (labels.length <= 1) return null;
  return Markup.keyboard([labels]).resize().oneTime();
}

module.exports = { MODE_BUTTON_LABELS, createModeKeyboard };
