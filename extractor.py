import base64
import httpx
import json
import logging
import os
from datetime import datetime

import pytz

log = logging.getLogger(__name__)

TIMEZONE = "Asia/Singapore"

# All model calls go through the central TBJ LLM gateway (thebooleanjulian-llm), which holds the provider keys
# and owns model choice and Gemini -> Claude fallback. Use cases are defined in its src/routes.js.
USE_CASE_TEXT  = "event-extract"
USE_CASE_IMAGE = "event-extract-vision"
GATEWAY_TIMEOUT = 60

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



def _today() -> str:
    return datetime.now(pytz.timezone(TIMEZONE)).strftime("%Y-%m-%d (%A)")


def _parse(raw: str) -> list[dict]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
    return json.loads(raw).get("events", [])


def _gateway(use_case: str, user_content) -> list[dict]:
    url = os.environ.get("LLM_GATEWAY_URL", "https://llm.thebooleanjulian.dev").rstrip("/")
    key = os.environ.get("LLM_GATEWAY_KEY")
    if not key:
        raise ValueError("LLM_GATEWAY_KEY not set in environment")
    r = httpx.post(
        f"{url}/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "X-TBJ-Use-Case": use_case},
        json={
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": 1024,
        },
        timeout=GATEWAY_TIMEOUT,
    )
    if r.status_code != 200:
        err = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
        raise RuntimeError(f"LLM gateway {r.status_code}: {err.get('code', 'error')} {err.get('message', '')}".strip())
    body = r.json()
    log.info("Extracted via gateway (%s, provider=%s)", use_case, body.get("tbj", {}).get("provider"))
    return _parse(body["choices"][0]["message"]["content"])


# ── Public API ────────────────────────────────────────────────────────────────

def extract_from_text(text: str) -> list[dict]:
    return _gateway(USE_CASE_TEXT, f"Today is {_today()}.\n\n{text}")


def extract_from_image(image_bytes: bytes, mime: str = "image/jpeg") -> list[dict]:
    b64 = base64.standard_b64encode(image_bytes).decode()
    return _gateway(USE_CASE_IMAGE, [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        {"type": "text", "text": f"Today is {_today()}. Extract all calendar events from this image."},
    ])
