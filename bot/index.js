require('dotenv').config();

const express = require('express');
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { SYSTEM_PROMPT, conversationFlowNote, stripLeadingGreeting } = require('./prompts');
const openai = require('./openaiClient');
const { transcribeTelegramAudio, audioSuffix, looksLikeBulgarian } = require('./voiceTranscription');
const { isOwner } = require('./adminGuard');
const { OWNER_NAME, OWNER_MEMORY } = require('./ownerContext');
const { touchConversationState } = require('./conversationState');
const { buildMemoryContext, recentMessages, formatFullMemory } = require('./memoryService');
const { addConversation } = require('./memoryStorage');
const { isProfileQuery } = require('./profileIntent');
const {
  rememberFromMessage,
  buildRelationshipContext,
  formatRelationshipMemory,
  detectMemoryCommand,
  applyMemoryCommand,
} = require('./relationshipMemory');
const { replyWithMarkdownSafe } = require('./replyUtils');
const { parseCommandText } = require('./commandGuard');
const { ensureUser } = require('./entitlements');
const {
  gateChat,
  resolveAccessStatus,
  TRIAL_EXPIRED_MESSAGE,
} = require('./chatGate');
const {
  LOOK_PROMPT_NOTE,
  parseLookTag,
  resolveLookId,
  chooseLookCategory,
} = require('./avatarLooks');
const { planKeyboard } = require('./planLinks');
const { EliPlatformClient } = require('./boltPlatformClient');
const startCommands = require('./commands/start');
const planAdmin = require('./commands/planAdmin');
const plans = require('./commands/plans');
const link = require('./commands/link');
const { getMode, setMode } = require('./avatarModeStorage');
const { modePermissionsText } = require('./modePermissions');
const { sendAvatarReply } = require('./avatarService');
const { sendVoiceReply } = require('./voiceReplyService');
const { extractHealthEvents } = require('./dailyLogTracker');
const { resolveLogQuery, answerDailyLogQuery, recordEvents, formatConfirmation } = require('./dailyLogService');
const { feedbackForEvents } = require('./healthInsights');

const profileWizard = require('./scenes/profileWizard');
const editWizard = require('./scenes/editWizard');
const checkinWizard = require('./scenes/checkinWizard');
const memoryWizard = require('./scenes/memoryWizard');
const addReminderWizard = require('./scenes/addReminderWizard');
const editReminderWizard = require('./scenes/editReminderWizard');

const myprofile = require('./commands/myprofile');
const deleteprofile = require('./commands/deleteprofile');
const plan = require('./commands/plan');
const today = require('./commands/today');
const history = require('./commands/history');
const stats = require('./commands/stats');
const whoami = require('./commands/whoami');
const owner = require('./commands/owner');
const adminMenu = require('./commands/adminMenu');
const showmemory = require('./commands/showmemory');
const forget = require('./commands/forget');
const userMemory = require('./commands/userMemory');
const coach = require('./commands/coach');
const reminders = require('./commands/reminders');
const { startBotRuntime } = require('./startup');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3001;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

// Avatar turns legitimately run past Telegraf's default 90s handler timeout
// (HeyGen generation + polling). The raised limit only affects how long
// Telegraf waits before logging a TimeoutError — not costs or retries.
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 8 * 60 * 1000 });

// Session must be first
bot.use(session());

// ── Escape commands ──────────────────────────────────────────────────────────
// Registered BEFORE stage middleware so they fire even inside active wizards.
// Each handler clears ctx.session.__scenes to fully exit any active scene.
const purchaseClient = new EliPlatformClient();
startCommands.register(bot, {
  ensureUser,
  isOwner,
  ownerName: OWNER_NAME,
  purchasePlan: (ctx, planId) => plans.sendPurchaseLink(ctx, planId, purchaseClient),
  refreshPaymentComplete: plans.refreshPaymentComplete,
});
whoami.register(bot);
owner.register(bot);
adminMenu.register(bot);
showmemory.register(bot);
forget.register(bot);
userMemory.register(bot);
coach.register(bot);
reminders.register(bot);
planAdmin.register(bot); // owner-only /setplan + /planstatus (temporary testing)
plans.register(bot, { client: purchaseClient });
link.register(bot);

// Scene-entry commands should interrupt any active wizard. Commands that
// enter a scene need ctx.scene (only available AFTER stage middleware), so we
// can't register them as pre-stage escape commands like /whoami. Instead, we
// clear the active scene here so the message falls through to a fresh entry.
const SCENE_ENTRY_COMMANDS = [
  '/profile',
  '/editprofile',
  '/checkin',
  '/memory',
  '/addreminder',
  '/editreminder',
];
bot.use((ctx, next) => {
  const text = ctx.message?.text;
  if (text && ctx.session?.__scenes?.current) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (SCENE_ENTRY_COMMANDS.includes(cmd)) {
      ctx.session.__scenes = {};
    }
  }
  return next();
});

// ── Scene stage ──────────────────────────────────────────────────────────────
const stage = new Scenes.Stage([
  profileWizard,
  editWizard,
  checkinWizard,
  memoryWizard,
  addReminderWizard,
  editReminderWizard,
]);
bot.use(stage.middleware());

// ── Standard commands ────────────────────────────────────────────────────────

bot.command('ping', (ctx) => {
  ctx.reply('Пong! 🏓 Ботът работи.');
});

bot.command('profile', (ctx) => ctx.scene.enter('profile-wizard'));
bot.command('editprofile', (ctx) => ctx.scene.enter('edit-wizard'));
bot.command('checkin', (ctx) => ctx.scene.enter('checkin-wizard'));

// /memory — edit long-term memory (owner identity is separate & permanent)
bot.command('memory', (ctx) => {
  if (isOwner(ctx)) {
    return ctx.reply(
      'Твоята идентичност като собственик е постоянна и се управлява отделно. 👑\n\n' +
      'Виж я с /showmemory.'
    );
  }
  return ctx.scene.enter('memory-wizard');
});

bot.command('addreminder', (ctx) => {
  if (isOwner(ctx)) {
    return ctx.reply(
      'Режимът на собственик е отделен — напомнянията са функция за потребителите. 👑'
    );
  }
  return ctx.scene.enter('add-reminder-wizard');
});

bot.command('editreminder', (ctx) => {
  if (isOwner(ctx)) {
    return ctx.reply(
      'Режимът на собственик е отделен — напомнянията са функция за потребителите. 👑'
    );
  }
  return ctx.scene.enter('edit-reminder-wizard');
});

// ── Chat modes: text / voice / avatar ────────────────────────────────────────
// The selector shows ONLY the modes allowed by the user's server-side
// entitlement. Selecting a mode is re-verified server-side (stale keyboards,
// crafted messages and replayed updates can never enable a premium mode).
const MODE_TEXT_LABEL = 'Пиши с Ели';
const MODE_VOICE_LABEL = 'Говори с Ели';
const MODE_AVATAR_LABEL = 'Говори с аватара на Ели';
const MODE_LABELS = {
  text: MODE_TEXT_LABEL,
  voice: MODE_VOICE_LABEL,
  avatar: MODE_AVATAR_LABEL,
};

const MODE_NAMES_BG = { text: 'текст 💬', voice: 'глас 🎙', avatar: 'аватар 🎬' };

async function showModeSelector(ctx) {
  const status = await resolveAccessStatus(ctx, { forceRefresh: true });
  const permissions = modePermissionsText(status);
  if (!status.canChat) {
    return ctx.reply(`${permissions}\n\n${TRIAL_EXPIRED_MESSAGE}`, planKeyboard());
  }
  const current = getMode(ctx.from.id);
  const effective = status.allowedModes.includes(current) ? current : 'text';
  if (status.allowedModes.length <= 1) {
    // Free trial: text only — no premium buttons, friendly plan pointer.
    return ctx.reply(
      `${permissions}\n\nГласът и видео аватарът на Ели изискват потвърден активен план:`,
      planKeyboard()
    );
  }
  const keyboard = Markup.keyboard([
    status.allowedModes.map((m) => MODE_LABELS[m]),
  ])
    .resize()
    .oneTime();
  return ctx.reply(
    `${permissions}\n\nВ момента си в режим „${MODE_NAMES_BG[effective]}".\n\nИзбери режим:`,
    keyboard
  );
}

bot.command('mode', showModeSelector);

// Selecting a mode — each selection is re-checked against the entitlement.
async function handleModeSelection(ctx, mode) {
  const status = await resolveAccessStatus(ctx, { forceRefresh: true });
  if (!status.canChat) {
    return ctx.reply(TRIAL_EXPIRED_MESSAGE, planKeyboard());
  }
  if (!status.allowedModes.includes(mode)) {
    return ctx.reply(
      'Тази опция не е включена в текущия ти план. 💙 Виж плановете с /mode или по-долу:',
      planKeyboard()
    );
  }
  setMode(ctx.from.id, mode);
  const confirmations = {
    text: 'Добре! 💬 Продължаваме с текст. Пиши ми!',
    voice:
      'Супер! 🎙 Отсега ще ти отговарям с глас. Можеш да ми пишеш или да ми пращаш гласови — с /mode сменяш режима по всяко време.',
    avatar:
      'Супер! 🎬 Отсега ще ти отговарям с кратко видео на моя аватар. С /mode се връщаш към текст или глас.',
  };
  return ctx.reply(confirmations[mode], Markup.removeKeyboard());
}

// ── Slash-command safety net ─────────────────────────────────────────────────
// Telegraf's bot.command() only fires when Telegram attaches a `bot_command`
// entity at offset 0. Messages that LOOK like commands but arrive without that
// entity (leading space, forwarded/copied text, some clients) fall through to
// the generic text handler. Commands must NEVER reach the AI: handle them
// deterministically here instead. Returns true when the message was handled.
async function maybeHandleCommandText(ctx, text) {
  const parsed = parseCommandText(text, ctx.botInfo?.username);
  if (!parsed) return false;
  // A command addressed to a different bot is not ours — ignore silently.
  if (!parsed.ours) return true;
  if (parsed.cmd === 'mode') {
    await showModeSelector(ctx);
    return true;
  }
  // Any other command-looking text: deterministic hint, never an AI completion.
  await ctx.reply('Това прилича на команда. Виж /help за всички команди. 💙');
  return true;
}

bot.hears(MODE_TEXT_LABEL, (ctx) => handleModeSelection(ctx, 'text'));
bot.hears(MODE_VOICE_LABEL, (ctx) => handleModeSelection(ctx, 'voice'));
bot.hears(MODE_AVATAR_LABEL, (ctx) => handleModeSelection(ctx, 'avatar'));

myprofile.register(bot);
deleteprofile.register(bot);
plan.register(bot);
today.register(bot);
history.register(bot);
stats.register(bot);

// Ask Eli (AI). Injects the owner-identity memory ONLY for the owner.
// opts.spokenInput: the question arrived as a voice message — Eli answers
// with her voice too (voice in → voice out), same conversation logic/memory.
// Owner conversational context (Bug: follow-ups like "нека бъде нещо леко
// вкъщи" lost the just-discussed topic). RAM-only recent turns — see
// ownerSession.js. Regular users keep their persisted history.
const { ownerRecentTurns, ownerRememberTurn } = require('./ownerSession');

// opts.status: entitlement status from gateChat (computed if missing).
async function askEli(ctx, question, opts = {}) {
  if (!openai) {
    await ctx.reply('OpenAI не е конфигуриран. Моля, провери настройките на бота.');
    return;
  }

  const status = opts.status || (await gateChat(ctx));
  if (!status) return; // expired trial — static message already sent

  const owner = isOwner(ctx);

  // Record activity once per inbound turn — even for deterministic early
  // returns below — so "how long since we last talked" reflects real chatting,
  // not just LLM replies. Used further down to decide whether to greet.
  const conversationState = touchConversationState(ctx.from.id);

  // Reply modes are decided ONCE, up front, from the SERVER-SIDE entitlement —
  // never from the stored mode alone (stale keyboards / expired plans can't
  // enable premium delivery). Exactly ONE delivery per turn:
  //   avatar mode → video only; voice mode → voice only; else text only.
  // Spoken input also gets a spoken reply, but only when the plan allows voice.
  const storedMode = getMode(ctx.from.id);
  const allowed = status.allowedModes;
  const avatarMode = storedMode === 'avatar' && allowed.includes('avatar');
  const voiceMode =
    !avatarMode &&
    allowed.includes('voice') &&
    (storedMode === 'voice' || Boolean(opts.spokenInput));
  const freePlan = status.plan === 'free';

  // Deterministic answers (log queries, profile dumps, memory commands) follow
  // the same one-delivery rule: voice mode speaks them (text only as fallback);
  // avatar mode falls back to text for these — never a video (cost control).
  // A one-time premium-expiry notice (from gateChat) rides along in the same
  // single delivery instead of being its own message.
  const withNotice = (text) => (status.notice ? `${status.notice}\n\n${text}` : text);
  const deliverDeterministic = async (text) => {
    const full = withNotice(text);
    if (voiceMode) {
      const ok = await sendVoiceReply(ctx, full);
      if (ok) return;
    }
    await replyWithMarkdownSafe(ctx, full);
  };

  // Explicit relationship-memory management ("забрави, че …", "промени целта ми
  // на …", "какви цели съм ти казвал"). Handled deterministically so Eli acts on
  // real stored data, never a hallucinated edit. Owner memory is a separate
  // identity, so this only runs for regular users.
  if (!owner) {
    const memCmd = detectMemoryCommand(question);
    if (memCmd) {
      const reply = applyMemoryCommand(ctx.from.id, memCmd);
      if (reply) {
        await deliverDeterministic(reply);
        addConversation(ctx.from.id, 'user', question);
        addConversation(ctx.from.id, 'assistant', 'Обработих заявка към отношенската памет.');
        return;
      }
    }
  }

  // If the user explicitly asks what Eli knows about them ("Какво знаеш за
  // мен?", "Покажи ми профила", "What do you know about me?"), answer straight
  // from stored data — never let the model invent or paraphrase it.
  if (isProfileQuery(question)) {
    if (owner) {
      const ownerProfileAnswer =
        `🧠 *Памет за собственика (${OWNER_NAME})*\n\n` +
        `Това е отделна и постоянна идентичност, която винаги помня:\n\n` +
        OWNER_MEMORY;
      await deliverDeterministic(ownerProfileAnswer);
      return;
    }
    const summary = formatFullMemory(ctx.from.id);
    // Append the relationship-memory summary so "what do you remember about me"
    // is one honest answer covering both the profile and the durable personal
    // context Eli has picked up over time.
    const relSummary = formatRelationshipMemory(ctx.from.id, { section: true });
    const profileAnswer = relSummary ? `${summary}\n\n${relSummary}` : summary;
    await deliverDeterministic(profileAnswer);
    // Keep conversation history lean: store a short marker, not the full dump.
    addConversation(ctx.from.id, 'user', question);
    addConversation(ctx.from.id, 'assistant', 'Показах на потребителя запазения му профил.');
    return;
  }

  // Daily health tracking runs for EVERYONE (owner included) so meals, water,
  // sleep, etc. are always recorded and retrievable. The owner keeps a separate
  // identity for the LLM below; only their conversation memory stays untouched,
  // so we skip writing these tracking turns into the owner's history.
  //
  // A question about the log ("How much water today?", "Какво ядох днес?") is
  // answered deterministically from stored entries.
  const logQuery = resolveLogQuery(question);
  if (logQuery) {
    const answer = answerDailyLogQuery(ctx.from.id, logQuery);
    await deliverDeterministic(answer);
    if (owner) {
      ownerRememberTurn(ctx.from.id, 'user', question);
      ownerRememberTurn(ctx.from.id, 'assistant', 'Отговорих от дневника за здраве.');
    } else {
      addConversation(ctx.from.id, 'user', question);
      addConversation(ctx.from.id, 'assistant', 'Отговорих от дневника за здраве.');
    }
    return;
  }
  // A report ("Изпих 2 чаши вода", "Закусих овесени ядки") is auto-recorded.
  // We verify the write actually persisted before confirming, then fall through
  // so Eli still replies warmly and conversationally.
  // The confirmation is NOT sent here — it is merged into the single final
  // delivery below (one turn → one delivery, in every mode).
  const events = extractHealthEvents(question);
  let healthNote = '';
  if (events.length) {
    let recorded = [];
    try {
      recorded = recordEvents(ctx.from.id, events);
    } catch (err) {
      console.error('Daily log save failed:', err.message);
    }
    if (recorded.length === events.length) {
      const confirmation = formatConfirmation(events);
      const feedback = feedbackForEvents(ctx.from.id, events);
      healthNote = feedback ? `${confirmation}\n\n${feedback}` : confirmation;
    } else {
      healthNote =
        '⚠️ Опитах да запиша това в дневника ти, но нещо се обърка. Опитай пак след малко. 🙏';
    }
  }

  // Owner gets the separate owner identity. Everyone else gets their own
  // long-term memory injected so Eli personalizes automatically.
  let systemContent = SYSTEM_PROMPT;
  let priorMessages = [];
  if (owner) {
    systemContent = `${OWNER_MEMORY}\n\n${SYSTEM_PROMPT}`;
    // Recent turns from RAM only — the owner's on-disk memory stays untouched.
    priorMessages = ownerRecentTurns(ctx.from.id);
  } else {
    // Passively capture durable personal context (goals, prefs, recurring
    // struggles …) from this message. The conservative classifier ignores
    // ordinary chatter and health reports, so nothing casual is stored.
    try {
      rememberFromMessage(ctx.from.id, question);
    } catch (err) {
      console.error('Relationship memory save failed:', err.message);
    }
    const memoryBlock = buildMemoryContext(ctx.from.id);
    if (memoryBlock) systemContent = `${memoryBlock}\n\n${SYSTEM_PROMPT}`;
    // Inject only the relationship memory relevant to THIS message (plus the
    // user's communication preferences), so Eli weaves it in naturally.
    const relBlock = buildRelationshipContext(ctx.from.id, question);
    if (relBlock) systemContent = `${relBlock}\n\n${systemContent}`;
    priorMessages = recentMessages(ctx.from.id, 10);
  }

  // Tell Eli whether to greet: only for a new or resumed-after-a-pause
  // conversation, never mid-flow. Applies to owner and users alike.
  systemContent = `${systemContent}\n\n${conversationFlowNote(conversationState)}`;

  // Avatar mode ("Говори с аватара на Ели"): optimize the spoken script at
  // generation time, before the last-resort provider text-length cap.
  if (avatarMode) {
    systemContent +=
      '\n\nВАЖНО ЗА ВИДЕО АВАТАРА: Напиши кратък естествен говорим текст на български, ' +
      'обикновено за около 8–15 секунди (ориентир 20–40 думи). Само когато е ' +
      'наистина необходимо, до около 20 секунди. Не повтаряй въпроса, не добавяй ' +
      'представяне, пълнеж или излишни обяснения. Дай една основна смислена идея ' +
      'и една полезна следваща стъпка. Бъди топла, лична и интересна, без роботизиран ' +
      'тон или изкуствено отсичане. Максимална стойност в минимално нужното време.' +
      // Same AI call also classifies the conversation context for the avatar
      // Look (one constrained tag, stripped server-side — never user-visible).
      LOOK_PROMPT_NOTE;
  } else if (voiceMode) {
    systemContent +=
      '\n\nВАЖНО: Този отговор ще бъде изговорен на глас. Отговори кратко — ' +
      'до 3-4 изречения, топло и естествено, на български.';
  }

  try {
    await ctx.sendChatAction('typing');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemContent },
        ...priorMessages,
        { role: 'user', content: question },
      ],
      // Technical response-length control (cost): free-trial answers are
      // hard-capped shorter than premium ones, independent of prompt wording.
      max_tokens: avatarMode ? 125 : voiceMode ? 300 : freePlan ? 250 : 600,
    });

    const rawWithTag = completion.choices[0]?.message?.content ?? 'Не получих отговор. Опитай отново.';
    // Strip the internal [LOOK:...] service tag on EVERY path (defense in
    // depth — it must never reach a text, voice, or video reply). The trailing
    // tag doubles as the Look classification for avatar mode.
    const { text: raw, category: lookCategory } = parseLookTag(rawWithTag);
    // Deterministic guard: if the conversation is already flowing, strip any
    // greeting the model may have added despite the prompt, so Eli never
    // re-greets mid-conversation on any path (recipes, health, nutrition,
    // workouts, motivation, companion chat, owner chat).
    const answer =
      conversationState === 'continuing' ? stripLeadingGreeting(raw) : raw;
    // Health-report turns fold the deterministic confirmation into the SAME
    // single delivery — never a separate second message.
    const finalAnswer = withNotice(healthNote ? `${healthNote}\n\n${answer}` : answer);

    // Persist the exchange to the user's long-term memory (never the owner's)
    // BEFORE delivery — memory survives even if delivery fails. The owner's
    // turns go to the in-RAM session buffer instead (context without disk).
    if (owner) {
      ownerRememberTurn(ctx.from.id, 'user', question);
      ownerRememberTurn(ctx.from.id, 'assistant', answer);
    } else {
      addConversation(ctx.from.id, 'user', question);
      addConversation(ctx.from.id, 'assistant', answer);
    }

    // ONE delivery per turn (strict cost rule):
    //   avatar mode → video only; voice mode → voice only; else text only.
    // The already-generated text is sent ONLY as a fallback when the selected
    // premium delivery fails — never a second AI response, never text+premium.
    if (avatarMode) {
      // Context-aware Look: stability-filtered category → allowlisted Look ID
      // (server-side map only; entitlement/credit gates run unchanged inside
      // sendAvatarReply before any HeyGen call).
      // Deterministic user-signal classifier overrides the model tag when the
      // user's own wording is clearly emotional/contextual (the small model's
      // tag is unreliable there); the tag only decides neutral turns.
      const finalCategory = chooseLookCategory(question, lookCategory);
      const lookId = resolveLookId(ctx.from.id, finalCategory);
      let avatarTimeExhausted = false;
      let pendingAvatar = false;
      let insufficientAvatarTime = false;
      const ok = await sendAvatarReply(ctx, finalAnswer, {
        lookId, onQuotaExceeded: () => { avatarTimeExhausted = true; },
        onPending: () => { pendingAvatar = true; },
        onInsufficientTime: () => { insufficientAvatarTime = true; },
      });
      if (!ok) {
        await ctx.reply(avatarTimeExhausted
          ? `${finalAnswer}\n\n🎬 Общото налично време за видео аватара (включено и допълнително закупено) е изчерпано. Давам ти отговора с текст.`
          : insufficientAvatarTime
            ? `${finalAnswer}\n\n🎬 Общото оставащо време за видео аватара не стига за този видеоотговор. Давам ти отговора с текст, без да отнемам минути.`
          : pendingAvatar
            ? `${finalAnswer}\n\n🎬 Предишно видео все още се проверява. Няма да започвам ново, докато състоянието му не е потвърдено.`
          : finalAnswer);
      }
    } else if (voiceMode) {
      const ok = await sendVoiceReply(ctx, finalAnswer);
      if (!ok) await ctx.reply(finalAnswer);
    } else {
      await ctx.reply(finalAnswer);
    }
  } catch (err) {
    console.error('OpenAI error:', err.message);
    await ctx.reply('Нещо се обърка. Опитай отново малко по-късно.');
  }
}

bot.command('ask', async (ctx) => {
  const question = ctx.message.text.replace(/^\/ask\s*/i, '').trim();
  if (!question) {
    return ctx.reply('Моля, напиши въпрос след командата. Пример: /ask Как да пия повече вода?');
  }
  const status = await gateChat(ctx);
  if (!status) return;
  await askEli(ctx, question, { status });
});

// Voice notes (.ogg) and audio files are transcribed, then handled exactly
// like a typed message — askEli keeps owner mode and per-user memory intact.
async function handleSpokenMessage(ctx, fileId, suffix) {
  if (!openai) {
    return ctx.reply(
      'Гласовите съобщения изискват AI, който в момента не е наличен. Моля, пиши ми текст. 😊'
    );
  }

  // Entitlement gate BEFORE the (paid) transcription call: an expired trial
  // gets the static message and never reaches OpenAI at all.
  const status = await gateChat(ctx);
  if (!status) return;

  let transcript;
  try {
    await ctx.sendChatAction('typing');
    transcript = await transcribeTelegramAudio(ctx, fileId, suffix);
  } catch (err) {
    // A real failure (download / API / network). Log the message only —
    // never the audio contents or full error object.
    console.error('Voice transcription error:', err.message);
    return ctx.reply(
      'Извинявай, нещо се обърка при обработката на гласовото. 🙏 Опитай отново след малко.'
    );
  }

  const text = (transcript || '').trim();
  // Safe console log of the recognized text (the user's own words, no secrets).
  console.log(`Voice transcript [user ${ctx.from?.id ?? 'unknown'}] (bg): ${text || '(empty)'}`);

  // A transcript that looks like a command (e.g. "/mode") is handled
  // deterministically — BEFORE the Bulgarian-language check, which would
  // otherwise reject Latin-only command text as "not understood".
  if (await maybeHandleCommandText(ctx, text)) return;

  // Empty or non-Bulgarian/garbled output = we couldn't understand it well.
  // Ask for a clearer retry instead of acting on nonsense.
  if (!looksLikeBulgarian(text)) {
    return ctx.reply(
      'Не успях да разбера добре гласовото. Можеш ли да го кажеш пак по-ясно?'
    );
  }

  // Handled exactly like a typed message so owner mode and per-user memory
  // keep working through askEli. No transcript echo — strict one-delivery-
  // per-turn rule (the transcript stays in the console diagnostics above).
  return askEli(ctx, text, { spokenInput: true, status });
}

bot.on('voice', (ctx) =>
  handleSpokenMessage(ctx, ctx.message.voice.file_id, '.ogg')
);

bot.on('audio', (ctx) =>
  handleSpokenMessage(ctx, ctx.message.audio.file_id, audioSuffix(ctx.message.audio))
);

bot.on('text', async (ctx) => {
  // Command-looking messages never reach the AI (see maybeHandleCommandText).
  if (await maybeHandleCommandText(ctx, ctx.message.text)) return;

  // Graceful fallbacks when AI is unavailable.
  if (!openai) {
    if (isOwner(ctx)) {
      return ctx.reply(
        `В момента не мога да ползвам AI мозъка си. Опитай пак малко по-късно. 🙏`
      );
    }
    return ctx.reply(
      `Разбирам те! 😊 Ако имаш въпрос, използвай /ask <въпрос>.\n\nЗа всички команди — /help.`
    );
  }

  // Entitlement gate: expired trial → static message, no AI call.
  const status = await gateChat(ctx);
  if (!status) return;

  // Any free-text message is answered by Eli. askEli injects the owner
  // identity for the owner, or the user's own long-term memory for everyone
  // else — so Eli personalizes automatically whenever a user talks again.
  return askEli(ctx, ctx.message.text, { status });
});

bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.update?.update_id}:`, err);
});

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: 'running' });
});

async function start() {
  let runtime;
  let server;
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime?.stop();
    server?.close();
    try {
      bot.stop(signal);
    } catch (err) {
      // A signal can arrive while Telegraf is still validating the token and
      // before its polling instance exists. Schedulers/server are already
      // stopped above, so this is a safe no-op during early shutdown.
      console.error('Failed to stop bot:', err.message);
    }
  };

  try {
    // `bot.launch()` stays pending for the lifetime of long polling. The
    // runtime uses Telegraf's validated-launch callback instead of waiting for
    // that promise, which would otherwise make local schedulers unreachable.
    runtime = startBotRuntime(bot);
    console.log('Telegram bot started (long polling).');

    server = app.listen(PORT, () => {
      console.log(`Express health server listening on port ${PORT}`);
    });

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    await runtime.launchPromise;
    runtime.stop();
    server?.close();
  } catch (err) {
    runtime?.stop();
    server?.close();
    console.error('Failed to start bot:', err.message);
    process.exit(1);
  }
}

start();
