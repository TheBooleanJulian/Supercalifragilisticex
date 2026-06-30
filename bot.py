import os
import logging
from uuid import uuid4
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters,
)
from extractor import extract_from_text, extract_from_image
from gcal import create_event

load_dotenv()
logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

# Comma-separated Telegram user IDs allowed to use the bot. Leave empty = allow all.
ALLOWED = set(int(x) for x in os.getenv("ALLOWED_USER_IDS", "").split(",") if x.strip())

def is_allowed(uid: int) -> bool:
    return not ALLOWED or uid in ALLOWED

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

# ── Handlers ──────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📅 *Calendar Bot*\n\n"
        "Send me:\n"
        "• A photo of an invite, flyer, or schedule\n"
        "• Text describing events\n\n"
        "I'll extract the entries and confirm before adding them to Google Calendar.",
        parse_mode="Markdown",
    )

async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
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
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Add to Calendar", callback_data=f"ok:{eid}"),
            InlineKeyboardButton("❌ Skip",             callback_data=f"skip:{eid}"),
        ]])
        await update.message.reply_text(format_event(ev), parse_mode="Markdown", reply_markup=kb)

async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    action, eid = q.data.split(":", 1)
    ev = ctx.user_data.get("pending", {}).pop(eid, None)
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
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.add_handler(MessageHandler(filters.PHOTO, on_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, on_document))
    app.add_handler(CallbackQueryHandler(on_callback))
    log.info("Polling…")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
