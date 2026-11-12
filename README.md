<div align="center">

# Supercalifragilisticex

**A Telegram bot + FastAPI backend that turns a photo or message into a Google Calendar event — the foundation for Accurova Calendar, a photography business operations system.**

![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white)
![License](https://img.shields.io/badge/license-AGPLv3%20%2B%20Commercial-00D4C8.svg)

</div>

---

## What it does

Supercalifragilisticex started as a Telegram bot that extracts booking details (client, date, time, location) from a text message or a photo of a booking form, using Gemini with a Claude fallback, and creates the corresponding Google Calendar event. It's now being extended into **Accurova Calendar**: a FastAPI backend with its own PostgreSQL database sits behind the same extraction pipeline, with Google Calendar kept as the source of truth for the events themselves (the database stores metadata — clients, workflow, payment status — not duplicate event data).

The Telegram bot is being incrementally refactored to call the new backend's HTTP API instead of extracting/writing to Calendar directly, so future interfaces (a web calendar UI, public booking pages) can share the exact same extraction and calendar logic.

## Features

- Text and photo-based event extraction via Gemini (primary) with a Claude fallback
- Google Calendar integration: sync, read, and write events
- `/today` command and an automated daily morning brief of the day's calendar events, DMed at a configurable time
- Per-user access control via `ALLOWED_USER_IDS`
- FastAPI backend (`backend/`) with PostgreSQL storage, SQLAlchemy models, and Alembic migrations
- Full CRUD API for events and clients, plus an availability engine for computing open booking slots
- Landing page served over HTTP for the bot's custom domain (`landing.py`)

## Tech Stack

| Layer | Choice |
|---|---|
| Language | Python |
| Bot framework | python-telegram-bot |
| Backend API | FastAPI + Uvicorn |
| Database | PostgreSQL (SQLAlchemy ORM, Alembic migrations) |
| Extraction | TBJ LLM gateway (`thebooleanjulian-llm`): Gemini with Claude fallback, keys held by the gateway |
| Calendar | Google Calendar API (OAuth via `google-auth-oauthlib`) |
| Deployment | Zeabur (`zbpack.json`) |

## Screenshots

_Screenshots coming soon._

## Setup / Quick Start

### Telegram bot (root)

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, LLM_GATEWAY_KEY, etc.
python auth_setup.py   # one-time Google Calendar OAuth, writes token.json
python bot.py
```

### Backend (FastAPI + PostgreSQL)

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # database URL, API keys
# initialize the database (see backend/README.md for full steps)
python main.py         # serves on http://localhost:8000, docs at /docs
```

See `backend/README.md` for the full API reference and setup walkthrough, and `DO-THIS-NEXT.md` for the step-by-step plan to wire the bot to the new backend.

## Status / Roadmap

- [x] Text/image event extraction (Gemini + Claude fallback)
- [x] Event creation and sync with Google Calendar
- [x] `/today` command and automated morning brief
- [x] FastAPI backend with PostgreSQL, full CRUD APIs, and an availability engine
- [x] Landing page served over HTTP for the custom domain
- [ ] Refactor the Telegram bot to call the backend API instead of extracting/writing directly
- [ ] Web calendar UI (month/week/day views)
- [ ] Public, Calendly-style booking pages
- [ ] Workflow tracking (lead → quote → booked → shoot → editing → delivered) and payment status

## Changelog

- **2026-09-14** — Add FastAPI backend (PostgreSQL, Alembic migrations, availability engine, full CRUD APIs) and a Telegram-bot-refactor guide as the foundation for Accurova Calendar.
- **v0.3.0** — Document self-hosting setup and a multi-tenant SaaS mode on the roadmap.
- **v0.3.0** — Add a daily morning brief of the day's calendar events.
- **v0.3.0** — Dual license under AGPLv3/commercial and restructure the README.
- Earlier — Allow editing extracted event details before confirming; serve a landing page over HTTP for the custom domain; initial extraction + Google Calendar bot.

## License

This project is dual licensed.

- Community Edition — [GNU Affero General Public License v3 (AGPLv3)](LICENSE). Free to use, modify, and self-host. If you distribute a modified version or run it as a network service, you must make the corresponding source available.
- Commercial License — for organisations that want to embed, modify, or distribute this software without AGPLv3's obligations. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

---

<div align="center">
<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>
</div>
