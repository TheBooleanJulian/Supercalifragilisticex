# Supercalifragilisticex

Telegram bot that extracts calendar events from photos and text, then creates them in Google Calendar after confirmation.

**Extraction:** Gemini 3.1 Flash-Lite (primary) → Claude Haiku 4.5 (fallback on rate limit / 5xx / timeout)

---

## Setup

### 1. Telegram
Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy token into `.env`.

### 2. Google Cloud — Calendar API
1. [console.cloud.google.com](https://console.cloud.google.com) → create project → enable **Google Calendar API**
2. APIs & Services → Credentials → **Create OAuth 2.0 Client ID** (Desktop app)
3. Download JSON → save as `credentials.json` in project root

### 3. Google AI Studio — Gemini key
Get a free API key at [aistudio.google.com](https://aistudio.google.com). Free tier: 15 RPM / 1,500 RPD.

### 4. OAuth token (run once, locally)
```bash
pip install -r requirements.txt
cp .env.example .env   # fill in your keys
python auth_setup.py   # browser opens → approve → token.json written
```

### 5. Run locally
```bash
python bot.py
```

Send your bot a message: `"Team standup tomorrow 9am, boardroom"` or a photo of an event invite.

---

## Zeabur deployment

```bash
git add . && git commit -m "feat: supercalifragilistic" && git push
```

In the Zeabur dashboard → **Environment Variables**, add all keys from `.env.example`:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ALLOWED_USER_IDS` | your Telegram ID |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `GEMINI_API_KEY` | from aistudio.google.com |
| `GOOGLE_TOKEN_JSON` | one-liner JSON printed by `auth_setup.py` |

`token.json` and `credentials.json` stay local — never commit them.

---

## Files

| File | Purpose |
|---|---|
| `bot.py` | Telegram handlers + entry point |
| `extractor.py` | Claude Haiku extraction, Gemini fallback |
| `gcal.py` | Google Calendar client |
| `auth_setup.py` | One-time local OAuth flow |
| `requirements.txt` | Python dependencies |
| `zbpack.json` | Zeabur build config |
| `.env.example` | Environment variable template |
