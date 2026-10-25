# Telegram Bot

A Node.js Telegram bot built with [Telegraf](https://telegraf.js.org/) and Express, with built-in OpenAI integration support.

## Features

- `/start` — Welcome message
- `/help` — List available commands
- `/ping` — Health check command
- `/ask <question>` — Ask the AI a question (requires `OPENAI_API_KEY`)
- Echoes any plain text message back to the user
- Express health endpoint at `GET /health`

## Requirements

- Node.js 18+
- A Telegram bot token (get one from [@BotFather](https://t.me/BotFather))
- (Optional) An OpenAI API key for the `/ask` command

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the `bot/` directory:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here
```

> **Note:** Never commit `.env` to version control — it is already listed in `.gitignore`.

### 3. Run the bot

**Development (with auto-restart on file changes):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## Environment Variables

| Variable            | Required | Description                                      |
|---------------------|----------|--------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`| ✅ Yes   | Your bot token from @BotFather                   |
| `OPENAI_API_KEY`    | ⚡ Optional | Enables the `/ask` AI command via OpenAI      |
| `PORT`              | No       | Port for the Express health server (default 3001)|

## Project Structure

```
bot/
├── index.js        # Main bot entry point
├── package.json    # Dependencies and scripts
├── .env            # Environment variables (not committed)
├── .gitignore      # Git ignore rules
└── README.md       # This file
```

## Extending the Bot

To add a new command, add a handler in `index.js` before the `bot.on("text", ...)` catch-all:

```js
bot.command("mycommand", (ctx) => {
  ctx.reply("Hello from my new command!");
});
```

To add more OpenAI-powered features, use the `openai` client instance already initialised at the top of `index.js`.

## License

MIT
