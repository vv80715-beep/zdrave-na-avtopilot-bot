const { Markup } = require('telegraf');

const BUY_PAYLOADS = Object.freeze({
  buy_seven_day: 'seven_day',
  buy_monthly: 'monthly',
  buy_yearly: 'yearly',
});

function createMiniAppStartMarkup(env = process.env) {
  if (
    env.ELI_MINI_APP_START_BUTTON_ENABLED !== 'true' ||
    env.ELI_MINI_APP_STAGE !== 'staging' ||
    env.NODE_ENV === 'production'
  ) {
    return undefined;
  }

  const rawUrl = String(env.ELI_MINI_APP_URL || '').trim();
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const reservedHost =
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.test') ||
      hostname.endsWith('.invalid') ||
      hostname.endsWith('.example') ||
      hostname.startsWith('[') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      reservedHost
    ) {
      return undefined;
    }

    return Markup.inlineKeyboard([
      [Markup.button.webApp('Отвори Ели', url.toString())],
    ]);
  } catch {
    return undefined;
  }
}

const HELP_TEXT =
  `Ето всички команди:\n\n` +
  `👤 /profile — Създай личен профил\n` +
  `📋 /myprofile — Виж профила си\n` +
  `✏️ /editprofile — Редактирай профила си\n` +
  `🗑 /deleteprofile — Изтрий профила си\n` +
  `📅 /plan — Персонализиран 7-дневен план\n` +
  `💳 /plans — Планове и абонамент\n\n` +
  `✅ /checkin — Дневен check-in\n` +
  `📋 /today — Днешните ти отговори\n` +
  `📊 /history — Последните 7 дни\n` +
  `📈 /stats — Твоята статистика\n\n` +
  `🧠 /showmemory — Виж какво помня за теб\n` +
  `🧠 /memory — Запомни или обнови нещо\n` +
  `🧹 /forget — Изтрий паметта си\n\n` +
  `🤖 /coach — Дневно коучинг послание\n` +
  `📆 /weeklyreview — Преглед на последните 7 дни\n` +
  `👉 /nextstep — Една малка стъпка за днес\n` +
  `✨ /motivate — Уникална мотивация за теб\n\n` +
  `⏰ /reminders — Виж всички напомняния\n` +
  `➕ /addreminder — Създай ново напомняне\n` +
  `✏️ /editreminder — Редактирай напомняне\n` +
  `🗑 /deletereminder — Изтрий напомняне\n` +
  `⏸️ /pause — Паузирай напомняне\n` +
  `▶️ /resume — Поднови напомняне\n\n` +
  `💬 /ask <въпрос> — Задай въпрос към Ели\n` +
  `🔗 /link — Свържи Telegram с „Моят профил“\n` +
  `🪪 /whoami — Виж твоите данни\n` +
  `🏓 /ping — Провери дали ботът работи`;

function register(bot, {
  ensureUser,
  isOwner,
  ownerName,
  purchasePlan,
  refreshPaymentComplete,
  miniAppStartMarkup = () => createMiniAppStartMarkup(),
}) {
  // Register after session and before stage: active wizards cannot swallow these
  // commands. Do not erase other session state or conversation memory.
  const leaveScene = (ctx) => {
    if (ctx.session) ctx.session.__scenes = {};
  };

  bot.start(async (ctx) => {
    leaveScene(ctx);
    const text = ctx.message?.text || '';
    const payload = text.replace(/^\/start(?:@\w+)?/i, '').trim();
    if (Object.hasOwn(BUY_PAYLOADS, payload)) {
      return purchasePlan(ctx, BUY_PAYLOADS[payload]);
    }
    if (/^buy/i.test(payload)) {
      return ctx.reply('Невалиден план. Виж /plans.');
    }
    if (payload === 'payment_complete') {
      return refreshPaymentComplete(ctx);
    }
    ensureUser(ctx.from.id);
    const replyMarkup =
      ctx.chat?.type === 'private' ? miniAppStartMarkup() : undefined;
    return ctx.reply(isOwner(ctx)
      ? `Здравей, ${ownerName}! 👑 Радвам се да те видя.`
      : `Здравей, ${ctx.from.first_name || 'приятелю'}! 👋 Аз съм Ели. Пиши ми или виж /help.`,
    replyMarkup);
  });

  bot.help((ctx) => {
    leaveScene(ctx);
    return ctx.reply(HELP_TEXT);
  });
}

module.exports = {
  register,
  BUY_PAYLOADS,
  HELP_TEXT,
  createMiniAppStartMarkup,
};