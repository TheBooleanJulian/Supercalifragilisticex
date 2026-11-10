// Google Calendar over REST (no SDK). Credentials come from the GOOGLE_TOKEN_JSON secret, the same
// authorized-user JSON (client_id, client_secret, refresh_token) the Python bot stored in its env var
// and token.json. A short-lived access token is fetched per call; refresh tokens do not rotate.
import { calendarBody, todayWindow } from './events.js';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function accessToken(env) {
  if (!env.GOOGLE_TOKEN_JSON) throw new Error('GOOGLE_TOKEN_JSON is not set');
  const t = JSON.parse(env.GOOGLE_TOKEN_JSON);
  const res = await fetch(t.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google token refresh failed: ${res.status} ${data.error || ''}`.trim());
  return data.access_token;
}

export async function createEvent(env, event) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(calendarBody(event))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Calendar insert failed: ${res.status} ${data.error?.message || ''}`.trim());
  return data.htmlLink || '';
}

export async function listEventsToday(env, now = new Date()) {
  const { timeMin, timeMax } = todayWindow(now);
  const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime' });
  const res = await fetch(`${API}?${qs}`, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status} ${data.error?.message || ''}`.trim());
  return (data.items || []).map((i) => ({
    title: i.summary || '(no title)',
    start: i.start.dateTime || i.start.date,
    end: i.end.dateTime || i.end.date,
    is_all_day: Boolean(i.start.date),
    location: i.location || null,
    htmlLink: i.htmlLink
  }));
}
