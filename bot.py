import os
import logging
from datetime import datetime, time
import pytz
from uuid import uuid4
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters,
)
from extractor import extract_from_text, extract_from_image
from gcal import create_event, list_events_today, TIMEZONE

load_dotenv()
logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

# Comma-separated Telegram user IDs allowed to use the bot. Leave empty = allow all.
ALLOWED = set(int(x) for x in os.getenv("ALLOWED_USER_IDS", "").split(",") if x.strip())

# Who receives the daily morning brief DM. Defaults to the first allowlisted user.
_brief_chat_env = os.getenv("MORNING_BRIEF_CHAT_ID", "").strip()
MORNING_BRIEF_CHAT_ID = int(_brief_chat_env) if _brief_chat_env else (next(iter(ALLOWED), None))
MORNING_BRIEF_HOUR = int(os.getenv("MORNING_BRIEF_HOUR", "7"))
MORNING_BRIEF_MINUTE = int(os.getenv("MORNING_BRIEF_MINUTE", "0"))

def is_allowed(uid: int) -> bool:
    return not ALLOWED or uid in ALLOWED

FIELDS = {
    "title":       "Title",
    "date":        "Date (YYYY-MM-DD)",
    "start_time":  "Start time (HH:MM)",
    "end_time":    "End time (HH:MM, or - to clear)",
    "location":    "Location (or - to clear)",
    "description": "Description (or - to clear)",
}

def event_keyboard(eid: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("✅ Add to Calendar", callback_data=f"ok:{eid}"),
            InlineKeyboardButton("✏️ Edit",            callback_data=f"edit:{eid}"),
        ],
        [InlineKeyboardButton("❌ Skip", callback_data=f"skip:{eid}")],
    ])

def field_keyboard(eid: str, ev: dict) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton("Title", callback_data=f"ef:{eid}:title")]]
    if ev.get("is_all_day"):
        rows.append([InlineKeyboardButton("Date", callback_data=f"ef:{eid}:date")])
    else:
        rows.append([
            InlineKeyboardButton("Date",       callback_data=f"ef:{eid}:date"),
            InlineKeyboardButton("Start time", callback_data=f"ef:{eid}:start_time"),
        ])
        rows.append([InlineKeyboardButton("End time", callback_data=f"ef:{eid}:end_time")])
    rows.append([
        InlineKeyboardButton("Location",    callback_data=f"ef:{eid}:location"),
        InlineKeyboardButton("Description", callback_data=f"ef:{eid}:description"),
    ])
    rows.append([InlineKeyboardButton("« Back", callback_data=f"back:{eid}")])
    return InlineKeyboardMarkup(rows)

def format_event(e: dict) -> str:
    lines = [f"📅 *{e['title']}*"]
    if e.get("is_all_day"):
        lines.append(f"🗓 {e['date']} (all day)")
    else:
        t = e.get("start_time", "?")
        if e.get("end_time"):
            t += f"–{e['end_time']}"
        lines.append(f"🕐 {e['date']}  {t}")
    if e.get("location"):
        lines.append(f"📍 {e['location']}")
    if e.get("description"):
        lines.append(f"📝 {e['description'][:100]}")
    return "\n".join(lines)

def format_brief(events: list) -> str:
    now = datetime.now(pytz.timezone(TIMEZONE))
    today = f"{now:%A}, {now.day} {now:%B %Y}"
    if not events:
        return f"☀️ *Good morning!*\n{today}\n\nNothing on your calendar today. 🎉"

    lines = [f"☀️ *Good morning!*\n{today}\n", f"You have *{len(events)}* event(s) today:\n"]
    for e in events:
        if e["is_all_day"]:
            lines.append(f"🗓 *{e['title']}* (all day)")
        else:
            t = datetime.fromisoformat(e["start"]).strftime("%H:%M")
            lines.append(f"🕐 *{t}* — {e['title']}")
        if e.get("location"):
            lines.append(f"    📍 {e['location']}")
    return "\n".join(lines)

async def send_morning_brief(ctx: ContextTypes.DEFAULT_TYPE):
    if not MORNING_BRIEF_CHAT_ID:
        log.warning("No MORNING_BRIEF_CHAT_ID / ALLOWED_USER_IDS configured, skipping brief")
        return
    try:
        events = list_events_today()
        await ctx.bot.send_message(
            chat_id=MORNING_BRIEF_CHAT_ID,
            text=format_brief(events),
            parse_mode="Markdown",
        )
    except Exception:
        log.exception("Failed to send morning brief")

# ── Handlers ──────────────────────────────────────────────────────────────────

async def cmd_today(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    try:
        events = list_events_today()
        await update.message.reply_text(format_brief(events), parse_mode="Markdown")
    except Exception as exc:
        log.exception("Failed to fetch today's events")
        await update.message.reply_text(f"❌ {exc}")

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📅 *Calendar Bot*\n\n"
        "Send me:\n"
        "• A photo of an invite, flyer, or schedule\n"
        "• Text describing events\n\n"
        "I'll extract the entries and confirm before adding them to Google Calendar.\n\n"
        "Use /today for your schedule right now — I'll also DM you a morning brief automatically.",
        parse_mode="Markdown",
    )

async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    if ctx.user_data.get("editing"):
        await _apply_edit(update, ctx)
        return
    msg = await update.message.reply_text("⏳ Extracting events…")
    try:
        events = extract_from_text(update.message.text)
        await msg.delete()
        await _present(update, ctx, events)
    except Exception as exc:
        log.exception("Text extraction failed")
        await msg.edit_text(f"❌ {exc}")

async def on_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    msg = await update.message.reply_text("⏳ Analysing image…")
    try:
        photo = update.message.photo[-1]  # highest resolution
        file = await ctx.bot.get_file(photo.file_id)
        data = bytes(await file.download_as_bytearray())
        events = extract_from_image(data)
        await msg.delete()
        await _present(update, ctx, events)
    except Exception as exc:
        log.exception("Photo extraction failed")
        await msg.edit_text(f"❌ {exc}")

async def on_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Handles photos sent as files (uncompressed / 'send without compression')."""
    if not is_allowed(update.effective_user.id):
        return
    doc = update.message.document
    if not doc.mime_type or not doc.mime_type.startswith("image/"):
        await update.message.reply_text("Send an image file.")
        return
    msg = await update.message.reply_text("⏳ Analysing image…")
    try:
        file = await ctx.bot.get_file(doc.file_id)
        data = bytes(await file.download_as_bytearray())
        events = extract_from_image(data, mime=doc.mime_type)
        await msg.delete()
        await _present(update, ctx, events)
    except Exception as exc:
        log.exception("Document extraction failed")
        await msg.edit_text(f"❌ {exc}")

async def _present(update: Update, ctx: ContextTypes.DEFAULT_TYPE, events: list):
    if not events:
        await update.message.reply_text("😕 No calendar events found.")
        return
    pending = ctx.user_data.setdefault("pending", {})
    await update.message.reply_text(
        f"✅ Found *{len(events)}* event(s). Confirm each:",
        parse_mode="Markdown",
    )
    for ev in events:
        eid = uuid4().hex[:8]
        pending[eid] = ev
        await update.message.reply_text(
            format_event(ev), parse_mode="Markdown", reply_markup=event_keyboard(eid)
        )

async def _apply_edit(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    editing = ctx.user_data.pop("editing")
    eid, field = editing["eid"], editing["field"]
    ev = ctx.user_data.get("pending", {}).get(eid)
    if ev is None:
        await update.message.reply_text("This event is no longer pending.")
        return

    value = update.message.text.strip()
    clear = field in ("end_time", "location", "description") and value in ("-", "none", "clear")

    if field == "date":
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            ctx.user_data["editing"] = editing
            await update.message.reply_text("❌ Invalid date, expected YYYY-MM-DD. Try again:")
            return
        ev["date"] = value
    elif field in ("start_time", "end_time"):
        if clear:
            ev[field] = None
        else:
            try:
                datetime.strptime(value, "%H:%M")
            except ValueError:
                ctx.user_data["editing"] = editing
                await update.message.reply_text("❌ Invalid time, expected HH:MM. Try again:")
                return
            ev[field] = value
    elif clear:
        ev[field] = None
    else:
        ev[field] = value

    await ctx.bot.edit_message_text(
        chat_id=editing["chat_id"],
        message_id=editing["message_id"],
        text=format_event(ev),
        parse_mode="Markdown",
        reply_markup=event_keyboard(eid),
    )
    await update.message.delete()

async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    parts = q.data.split(":")
    action, eid = parts[0], parts[1]
    pending = ctx.user_data.setdefault("pending", {})

    if action == "edit":
        ev = pending.get(eid)
        if ev is None:
            await q.edit_message_reply_markup(reply_markup=None)
            return
        await q.edit_message_reply_markup(reply_markup=field_keyboard(eid, ev))
        return

    if action == "back":
        ev = pending.get(eid)
        if ev is None:
            await q.edit_message_reply_markup(reply_markup=None)
            return
        await q.edit_message_text(
            format_event(ev), parse_mode="Markdown", reply_markup=event_keyboard(eid)
        )
        return

    if action == "ef":
        field = parts[2]
        ev = pending.get(eid)
        if ev is None:
            await q.edit_message_reply_markup(reply_markup=None)
            return
        ctx.user_data["editing"] = {
            "eid": eid, "field": field,
            "chat_id": q.message.chat_id, "message_id": q.message.message_id,
        }
        await q.edit_message_text(f"✏️ Send the new *{FIELDS[field]}*:", parse_mode="Markdown")
        return

    ev = pending.pop(eid, None)
    if ev is None:
        await q.edit_message_reply_markup(reply_markup=None)
        return
    if action == "ok":
        try:
            link = create_event(ev)
            text = f"✅ *Added!*\n{format_event(ev)}"
            if link:
                text += f"\n\n[Open in Calendar]({link})"
            await q.edit_message_text(text, parse_mode="Markdown")
        except Exception as exc:
            log.exception("Calendar creation failed")
            await q.edit_message_text(f"❌ Failed to create event:\n{exc}")
    else:
        await q.edit_message_text(f"⏭️ *Skipped*\n{format_event(ev)}", parse_mode="Markdown")

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.add_handler(MessageHandler(filters.PHOTO, on_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, on_document))
    app.add_handler(CallbackQueryHandler(on_callback))

    if MORNING_BRIEF_CHAT_ID:
        app.job_queue.run_daily(
            send_morning_brief,
            time=time(MORNING_BRIEF_HOUR, MORNING_BRIEF_MINUTE, tzinfo=pytz.timezone(TIMEZONE)),
            name="morning_brief",
        )
        log.info(
            "Morning brief scheduled for %02d:%02d %s -> chat %s",
            MORNING_BRIEF_HOUR, MORNING_BRIEF_MINUTE, TIMEZONE, MORNING_BRIEF_CHAT_ID,
        )
    else:
        log.warning("No chat configured for morning brief (set ALLOWED_USER_IDS or MORNING_BRIEF_CHAT_ID)")

    log.info("Polling…")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
