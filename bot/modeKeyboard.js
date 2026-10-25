const { Markup } = require('telegraf');

const MODE_LABELS = Object.freeze({
  text: 'Пиши с Ели',
  voice: 'Говори с Ели',
  avatar: 'Говори с аватара на Ели',
});

function createModeKeyboard(allowedModes) {
  const modes = [...new Set(Array.isArray(allowedModes) ? allowedModes : [])]
    .filter((mode) => Object.hasOwn(MODE_LABELS, mode));
  if (!modes.length) return undefined;
  return Markup.keyboard([modes.map((mode) => MODE_LABELS[mode])]).resize();
}

module.exports = { MODE_LABELS, createModeKeyboard };
