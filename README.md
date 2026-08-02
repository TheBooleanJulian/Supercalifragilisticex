<div align="center">

# Supercalifragilisticex

**Telegram bot that extracts calendar events from photos and text, creates them in Google Calendar after confirmation, and DMs a daily morning brief.**

![Version](https://img.shields.io/badge/version-0.4.0-00D4C8)
![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)
![Zeabur](https://img.shields.io/badge/-Zeabur-6C5CE7)
![License](https://img.shields.io/badge/license-AGPLv3%20%7C%20Commercial-00D4C8.svg)

</div>

---

## What it does

Supercalifragilisticex is a personal Telegram bot that turns event descriptions — typed messages or photos of invites, flyers, and screenshots — into Google Calendar entries. It extracts event details using Gemini Flash-Lite as the primary model, falling back to Claude Haiku on rate limits or errors. Before anything is created, it shows you the extracted details and lets you edit them, so you stay in control.

## Features

- Extract calendar events from free-text messages or photos sent to the bot
- Edit extracted event details before confirming creation
- Creates events directly in Google Calendar via OAuth
- Gemini 3.1 Flash-Lite as primary extractor, Claude Haiku 4.5 as automatic fallback
- Restricted to allowlisted Telegram user IDs
- `/today` command and an automatic daily morning brief DM of today's calendar events
- Static landing page served over HTTP for the custom domain

## Tech Stack

| Layer | Choice |
|---|---|
| Bot | python-telegram-bot (polling) |
| AI | Gemini 3.1 Flash-Lite (primary) + Claude Haiku 4.5 (fallback) |
| Calendar | Google Calendar API (OAuth 2.0) |
| Hosting | Zeabur |

## Quick Start

```bash
git clone <repo>
cd Supercalifragilisticex
pip install -r requirements.txt
cp .env.example .env   # fill in your keys
python auth_setup.py   # one-time local OAuth flow — browser opens, token.json written
python bot.py
```

Send your bot a message like `"Team standup tomorrow 9am, boardroom"` or a photo of an event invite.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs to allowlist |
| `GEMINI_API_KEY` | ✅ | From [aistudio.google.com](https://aistudio.google.com) |
| `ANTHROPIC_API_KEY` | ✅ | From console.anthropic.com (fallback model) |
| `GOOGLE_TOKEN_JSON` | ✅ | One-liner JSON printed by `auth_setup.py` — used in Zeabur instead of `token.json` |
| `MORNING_BRIEF_CHAT_ID` | | Chat to DM the morning brief to. Defaults to the first ID in `ALLOWED_USER_IDS` |
| `MORNING_BRIEF_HOUR` | | Hour (24h, `Asia/Singapore`) to send the brief. Defaults to `7` |
| `MORNING_BRIEF_MINUTE` | | Minute to send the brief. Defaults to `0` |

`token.json` and `credentials.json` are local-only — never commit them.

## Project Structure

```
Supercalifragilisticex/
|-- bot.py           # Telegram handlers + entry point
|-- extractor.py     # Gemini extraction, Claude fallback
|-- gcal.py          # Google Calendar client
|-- landing.py       # Static landing page HTTP server (for the custom domain)
|-- static/
|   `-- index.html
|-- auth_setup.py    # One-time local OAuth flow
|-- requirements.txt
|-- zbpack.json      # Zeabur build config
`-- .env.example
```

## Deployment

Deployed on Zeabur. Push to master triggers a deploy via `zbpack.json`.

In the Zeabur dashboard → **Environment Variables**, add all keys from `.env.example`. The `GOOGLE_TOKEN_JSON` variable replaces the local `token.json` file — copy the one-liner JSON printed by `auth_setup.py`.

## Status / Roadmap

**Done**

- [x] Event extraction from text and images
- [x] Pre-creation edit flow so users can correct extracted details
- [x] Gemini primary + Claude fallback extraction pipeline
- [x] Google Calendar creation via OAuth
- [x] User allowlist via `ALLOWED_USER_IDS`
- [x] Zeabur deployment with correct start command
- [x] `/today` command and scheduled daily morning brief DM
- [x] Landing page served at the custom domain

**Planned / Suggestions**

- No test files found — basic unit tests for `extractor.py` and `gcal.py` would help catch regressions

## Changelog

Versioned with `MAJOR.MINOR.PATCH`: `feat` commits bump **minor**, `fix`/`docs`/`chore` bump **patch**, breaking changes bump **major**.

- **v0.4.0** — 2026-08-02 — Added a static landing page served over HTTP so the custom domain resolves to something
- **v0.3.0** — 2026-08-02 — Added `/today` command and a scheduled daily morning brief DM of today's calendar events
- **v0.2.1** — 2026-08-01 — Dual licensed under AGPLv3 + commercial license; added `LICENSE` and `COMMERCIAL-LICENSE.md`; restructured README
- **v0.2.0** — 2026-07-24 — Added pre-confirmation edit flow so extracted event details can be corrected before calendar creation
- **v0.1.4** — 2026-07-24 — Fixed premature httpx client close by holding a client reference
- **v0.1.3** — 2026-07-23 — Corrected Zeabur start command in `zbpack.json`
- **v0.1.2** — 2026-07-23 — Renamed project to Supercalifragilisticex
- **v0.1.1** — 2026-07-23 — Renamed project from cal-bot to supercalifragilistic
- **v0.1.0** — 2026-07-01 — Initial release: Telegram bot extracting events from text and images, creating them in Google Calendar with Gemini/Claude extraction

## License

This project is dual licensed.

- Community Edition — [GNU Affero General Public License v3 (AGPLv3)](LICENSE). Free to use, modify, and self-host. If you distribute a modified version or run it as a network service, you must make the corresponding source available.
- Commercial License — for organisations that want to embed, modify, or distribute this software without AGPLv3's obligations. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

---

<div align="center">
<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>
</div>