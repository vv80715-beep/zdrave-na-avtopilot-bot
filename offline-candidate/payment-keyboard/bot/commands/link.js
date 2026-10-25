const {
  TelegramLinkClient,
  TelegramLinkError,
} = require('../telegramLinkClient');

const LINK_ERROR_MESSAGE =
  'Не успях да издам код за свързване. Моля, опитай отново след малко. 💙';

function safeDiagnostic(error) {
  const known = error instanceof TelegramLinkError;
  return {
    status: known && Number.isInteger(error.status) ? error.status : null,
    code: known ? error.code : null,
    errorClass: known
      ? 'TelegramLinkError'
      : ['Error', 'TypeError', 'AbortError'].includes(error?.name)
        ? error.name
        : 'UnknownError',
  };
}

function register(bot, { client = new TelegramLinkClient() } = {}) {
  bot.command('link', async (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};
    if (ctx.chat?.type !== 'private') {
      return ctx.reply(
        'За да защитя кода ти, отвори личен разговор с мен и използвай /link там.'
      );
    }
    try {
      // Telegram identity comes only from the authenticated update context.
      // Command arguments are intentionally ignored.
      const result = await client.issueCode(String(ctx.from.id));
      return ctx.reply(
        `${result.code}\n\n` +
        'Отвори „Моят профил“ в сайта и въведи този код там. ' +
        'Кодът е валиден 10 минути.'
      );
    } catch (error) {
      // Never log the code, secret, request/response bodies, or error message.
      console.warn('Telegram profile link request failed', safeDiagnostic(error));
      return ctx.reply(LINK_ERROR_MESSAGE);
    }
  });
}

module.exports = {
  register,
  LINK_ERROR_MESSAGE,
  safeDiagnostic,
};