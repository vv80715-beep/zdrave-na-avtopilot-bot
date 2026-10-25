const { isOwner } = require('../adminGuard');

function register(bot) {
  bot.command('owner', (ctx) => {
    if (ctx.session?.__scenes) ctx.session.__scenes = {};

    if (!isOwner(ctx)) {
      return ctx.reply('Нямаш достъп до тази команда.');
    }

    ctx.reply(
      'Здравей, Данаил. 👋\n\n' +
      'Разпознах те като мой създател и собственик. ' +
      'Имаш пълен достъп до админ функциите.\n\n' +
      'Използвай /admin за да видиш менюто.'
    );
  });
}

module.exports = { register };
