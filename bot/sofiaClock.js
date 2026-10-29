const TIME_ZONE = 'Europe/Sofia';

function sofiaParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function runtimeContext(now = new Date()) {
  const { date, time } = sofiaParts(now);
  const weekday = new Intl.DateTimeFormat('bg-BG', {
    timeZone: TIME_ZONE, weekday: 'long',
  }).format(now);
  return `АВТОРИТЕТЕН СЪРВЪРЕН ЧАС (${TIME_ZONE}): ${date}, ${weekday}, ${time}.
Днес=${date}; утре=${shiftDate(date, 1)}; вчера=${shiftDate(date, -1)}.
Използвай този часовник, не дати от стари реплики или предположения. При поправка за датата сверявай с него.
Кратки последващи реплики като „нека е нещо леко вкъщи“ уточняват текущата тема от последните съобщения, не са въпроси за дневника.`;
}

function withRuntimeContext(messages, now = new Date()) {
  return [{ role: 'system', content: runtimeContext(now) }, ...(messages || [])];
}

module.exports = { TIME_ZONE, sofiaParts, shiftDate, runtimeContext, withRuntimeContext };
