// Pure helpers for supercalifragilisticex: no I/O, so they are unit-tested directly (test/events.test.js).
// Behaviour matches the Python bot (bot.py / extractor.py / gcal.py) it replaces.

export const TIMEZONE = 'Asia/Singapore';

export const FIELDS = {
  title: 'Title',
  date: 'Date (YYYY-MM-DD)',
  start_time: 'Start time (HH:MM)',
  end_time: 'End time (HH:MM, or - to clear)',
  location: 'Location (or - to clear)',
  description: 'Description (or - to clear)'
};
export const CLEARABLE = new Set(['end_time', 'location', 'description']);

export const SYSTEM_PROMPT = `You are a calendar event extractor. Extract all events from the provided content.
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
If no events found, return {"events": []}. Infer relative dates from the provided today's date.`;

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "2026-11-10 (Tuesday)" in Singapore time.
export function todayLabel(now = new Date()) {
  const f = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, ...opts });
  const date = f({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); // en-CA gives YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(now);
  return `${date} (${weekday})`;
}

// Accepts the model's reply with or without ``` fences. Throws on invalid JSON.
export function parseEvents(raw) {
  let text = String(raw ?? '').trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n').replace(/`+\s*$/, '').trim();
  const events = JSON.parse(text).events;
  return Array.isArray(events) ? events : [];
}

export function formatEvent(e) {
  const lines = [`📅 <b>${escapeHtml(e.title)}</b>`];
  if (e.is_all_day) {
    lines.push(`🗓 ${escapeHtml(e.date)} (all day)`);
  } else {
    let t = e.start_time || '?';
    if (e.end_time) t += `–${e.end_time}`;
    lines.push(`🕐 ${escapeHtml(e.date)}  ${escapeHtml(t)}`);
  }
  if (e.location) lines.push(`📍 ${escapeHtml(e.location)}`);
  if (e.description) lines.push(`📝 ${escapeHtml(String(e.description).slice(0, 100))}`);
  return lines.join('\n');
}

// Time-of-day from a Google Calendar start value ("2026-11-10T09:30:00+08:00") without a Date round trip.
const hhmm = (iso) => iso.slice(11, 16);

export function formatBrief(events, now = new Date()) {
  const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(now).replace(/^(\w+),? /, '$1, ');
  if (!events.length) return `☀️ <b>Good morning!</b>\n${dayLabel}\n\nNothing on your calendar today. 🎉`;
  const lines = [`☀️ <b>Good morning!</b>\n${dayLabel}\n`, `You have <b>${events.length}</b> event(s) today:\n`];
  for (const e of events) {
    lines.push(e.is_all_day ? `🗓 <b>${escapeHtml(e.title)}</b> (all day)` : `🕐 <b>${hhmm(e.start)}</b> — ${escapeHtml(e.title)}`);
    if (e.location) lines.push(`    📍 ${escapeHtml(e.location)}`);
  }
  return lines.join('\n');
}

const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const validTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Applies one edit to an event. Returns { event } or { error } (the user is asked to try again).
export function applyEdit(event, field, rawValue) {
  const value = String(rawValue ?? '').trim();
  const clear = CLEARABLE.has(field) && ['-', 'none', 'clear'].includes(value);
  const next = { ...event };
  if (field === 'date') {
    if (!validDate(value)) return { error: '❌ Invalid date, expected YYYY-MM-DD. Try again:' };
    next.date = value;
  } else if (field === 'start_time' || field === 'end_time') {
    if (clear) next[field] = null;
    else if (!validTime(value)) return { error: '❌ Invalid time, expected HH:MM. Try again:' };
    else next[field] = value;
  } else if (clear) {
    next[field] = null;
  } else {
    next[field] = value;
  }
  return { event: next };
}

const hourLater = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// Google Calendar events.insert body.
export function calendarBody(e) {
  const body = e.is_all_day
    ? { summary: e.title, start: { date: e.date }, end: { date: e.date } }
    : {
        summary: e.title,
        start: { dateTime: `${e.date}T${e.start_time}:00`, timeZone: TIMEZONE },
        end: { dateTime: `${e.date}T${e.end_time || hourLater(e.start_time)}:00`, timeZone: TIMEZONE }
      };
  if (e.location) body.location = e.location;
  if (e.description) body.description = e.description;
  return body;
}

// Midnight-to-midnight window for "today" in Singapore (UTC+8, no DST), as RFC 3339 strings.
export function todayWindow(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(`${day}T00:00:00+08:00`);
  return { timeMin: start.toISOString(), timeMax: new Date(start.getTime() + 864e5).toISOString() };
}
