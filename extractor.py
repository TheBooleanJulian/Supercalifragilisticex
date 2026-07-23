import anthropic
import base64
import httpx
import json
import logging
import os
from datetime import datetime

import pytz
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

log = logging.getLogger(__name__)

TIMEZONE     = "Asia/Singapore"
GEMINI_MODEL = "gemini-3.1-flash-lite"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

SYSTEM = """You are a calendar event extractor. Extract all events from the provided content.
Return ONLY valid JSON with no preamble or markdown fences. Structure:
{
  "events": [
    {
      "id": "evt_001",
      "title": "Event title",
      "date": "YYYY-MM-DD",
      "start_time": "HH:MM",
      "end_time": "HH:MM",
      "location": null,
      "description": null,
      "is_all_day": false
    }
  ]
}
If no events found, return {"events": []}. Infer relative dates from the provided today's date."""

# Transient Gemini errors worth retrying on Claude (network failures, timeouts,
# rate limits, 5xx). Auth/bad-request errors are config bugs — don't mask them
# with a fallback.
_TRANSIENT_CODES = {429, 500, 502, 503, 504}
_FALLBACK_ON = (genai_errors.APIError, httpx.TransportError)


def _gemini_is_transient(exc: Exception) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    return isinstance(exc, genai_errors.APIError) and exc.code in _TRANSIENT_CODES


def _today() -> str:
    return datetime.now(pytz.timezone(TIMEZONE)).strftime("%Y-%m-%d (%A)")


def _parse(raw: str) -> list[dict]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
    return json.loads(raw).get("events", [])


# ── Gemini 3.1 Flash-Lite ───────────────────────────────────────────────────────

def _gemini_cfg() -> types.GenerateContentConfig:
    return types.GenerateContentConfig(system_instruction=SYSTEM, max_output_tokens=1024)


def _gemini_client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _gemini_text(text: str) -> list[dict]:
    client = _gemini_client()
    r = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=f"Today is {_today()}.\n\n{text}",
        config=_gemini_cfg(),
    )
    return _parse(r.text)


def _gemini_image(image_bytes: bytes, mime: str) -> list[dict]:
    client = _gemini_client()
    r = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime),
            f"Today is {_today()}. Extract all calendar events from this image.",
        ],
        config=_gemini_cfg(),
    )
    return _parse(r.text)


# ── Claude Haiku fallback ───────────────────────────────────────────────────────

def _claude_text(text: str) -> list[dict]:
    client = anthropic.Anthropic(timeout=15)
    r = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"Today is {_today()}.\n\n{text}"}],
    )
    return _parse(r.content[0].text)


def _claude_image(image_bytes: bytes, mime: str) -> list[dict]:
    b64 = base64.standard_b64encode(image_bytes).decode()
    client = anthropic.Anthropic(timeout=15)
    r = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                {"type": "text", "text": f"Today is {_today()}. Extract all calendar events."},
            ],
        }],
    )
    return _parse(r.content[0].text)


# ── Public API ────────────────────────────────────────────────────────────────

def extract_from_text(text: str) -> list[dict]:
    try:
        events = _gemini_text(text)
        log.info("Extracted via Gemini 3.1 Flash-Lite")
        return events
    except _FALLBACK_ON as exc:
        if not _gemini_is_transient(exc):
            raise
        log.warning("Gemini unavailable (%s: %s), falling back to Claude Haiku 4.5",
                    type(exc).__name__, exc)
        events = _claude_text(text)
        log.info("Extracted via Claude Haiku 4.5 (fallback)")
        return events


def extract_from_image(image_bytes: bytes, mime: str = "image/jpeg") -> list[dict]:
    try:
        events = _gemini_image(image_bytes, mime)
        log.info("Extracted via Gemini 3.1 Flash-Lite")
        return events
    except _FALLBACK_ON as exc:
        if not _gemini_is_transient(exc):
            raise
        log.warning("Gemini unavailable (%s: %s), falling back to Claude Haiku 4.5",
                    type(exc).__name__, exc)
        events = _claude_image(image_bytes, mime)
        log.info("Extracted via Claude Haiku 4.5 (fallback)")
        return events
