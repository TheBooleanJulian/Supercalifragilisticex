import os
import json
from datetime import datetime, timedelta
import pytz
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES   = ["https://www.googleapis.com/auth/calendar.events"]
TIMEZONE = "Asia/Singapore"


def _get_creds() -> Credentials:
    creds = None

    # Zeabur/container: store token.json contents as GOOGLE_TOKEN_JSON env var
    token_env = os.getenv("GOOGLE_TOKEN_JSON")
    if token_env:
        creds = Credentials.from_authorized_user_info(json.loads(token_env), SCOPES)
    elif os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # Persist refresh back to file if running locally
            if os.path.exists("token.json"):
                with open("token.json", "w") as f:
                    f.write(creds.to_json())
        else:
            raise RuntimeError(
                "No valid Google credentials. Run auth_setup.py locally first."
            )

    return creds


def _hour_later(t: str) -> str:
    h, m = map(int, t.split(":"))
    return f"{(h + 1) % 24:02d}:{m:02d}"


def create_event(event: dict) -> str:
    """Insert event into primary calendar. Returns the HTML link."""
    svc = build("calendar", "v3", credentials=_get_creds())

    if event.get("is_all_day"):
        body = {
            "summary": event["title"],
            "start": {"date": event["date"]},
            "end":   {"date": event["date"]},
        }
    else:
        start_dt = f"{event['date']}T{event['start_time']}:00"
        end_time = event.get("end_time") or _hour_later(event["start_time"])
        end_dt   = f"{event['date']}T{end_time}:00"
        body = {
            "summary": event["title"],
            "start": {"dateTime": start_dt, "timeZone": TIMEZONE},
            "end":   {"dateTime": end_dt,   "timeZone": TIMEZONE},
        }

    if event.get("location"):
        body["location"] = event["location"]
    if event.get("description"):
        body["description"] = event["description"]

    result = svc.events().insert(calendarId="primary", body=body).execute()
    return result.get("htmlLink", "")


def list_events_today() -> list[dict]:
    """Return today's events on the primary calendar, sorted by start time."""
    tz = pytz.timezone(TIMEZONE)
    now = datetime.now(tz)
    start_of_day = tz.localize(datetime(now.year, now.month, now.day))
    end_of_day = start_of_day + timedelta(days=1)

    svc = build("calendar", "v3", credentials=_get_creds())
    result = svc.events().list(
        calendarId="primary",
        timeMin=start_of_day.isoformat(),
        timeMax=end_of_day.isoformat(),
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    events = []
    for item in result.get("items", []):
        start = item["start"].get("dateTime", item["start"].get("date"))
        end = item["end"].get("dateTime", item["end"].get("date"))
        events.append({
            "title":      item.get("summary", "(no title)"),
            "start":      start,
            "end":        end,
            "is_all_day": "date" in item["start"],
            "location":   item.get("location"),
            "htmlLink":   item.get("htmlLink"),
        })
    return events
