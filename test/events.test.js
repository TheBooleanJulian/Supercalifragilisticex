// node --test   Pure logic of events.js and the webhook flow of worker.js against fake Postgres + Telegram + gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, calendarBody, formatEvent, parseEvents, todayLabel, todayWindow } from '../events.js';

const ev = { title: 'Dinner <b>', date: '2026-11-12', start_time: '19:00', end_time: null, location: 'Marina & Bay', description: null, is_all_day: false };

test('parseEvents handles fenced and bare JSON, and empty results', () => {
  const body = '{"events":[{"title":"A"}]}';
  assert.equal(parseEvents(body).length, 1);
  assert.equal(parseEvents('```json\n' + body + '\n```').length, 1);
  assert.deepEqual(parseEvents('{"events":[]}'), []);
  assert.deepEqual(parseEvents('{}'), []);
  assert.throws(() => parseEvents('not json'));
});

test('formatEvent escapes HTML from model output', () => {
  const text = formatEvent(ev);
  assert.match(text, /Dinner &lt;b&gt;/);
  assert.match(text, /Marina &amp; Bay/);
  assert.match(text, /19:00/);
});

test('applyEdit validates dates and times, and clears optional fields', () => {
  assert.ok(applyEdit(ev, 'date', '2026-02-30').error);
  assert.equal(applyEdit(ev, 'date', '2026-12-01').event.date, '2026-12-01');
  assert.ok(applyEdit(ev, 'start_time', '25:00').error);
  assert.equal(applyEdit(ev, 'start_time', '07:05').event.start_time, '07:05');
  assert.equal(applyEdit(ev, 'location', '-').event.location, null);
  assert.equal(applyEdit(ev, 'title', 'Lunch').event.title, 'Lunch');
  assert.equal(applyEdit(ev, 'title', '-').event.title, '-'); // title is not clearable
  assert.equal(ev.title, 'Dinner <b>'); // input not mutated
});

test('calendarBody: default one-hour end, wrap past midnight, all-day', () => {
  assert.equal(calendarBody(ev).end.dateTime, '2026-11-12T20:00:00');
  assert.equal(calendarBody({ ...ev, start_time: '23:30' }).end.dateTime, '2026-11-12T00:30:00');
  assert.equal(calendarBody({ ...ev, end_time: '21:15' }).end.dateTime, '2026-11-12T21:15:00');
  assert.deepEqual(calendarBody({ title: 'Hol', date: '2026-12-25', is_all_day: true }).start, { date: '2026-12-25' });
  assert.equal(calendarBody(ev).location, 'Marina & Bay');
});

test('Singapore day labels and window use UTC+8', () => {
  const t = new Date('2026-11-09T17:00:00Z'); // 01:00 SGT on Tuesday 10 Nov
  assert.equal(todayLabel(t), '2026-11-10 (Tuesday)');
  assert.deepEqual(todayWindow(t), { timeMin: '2026-11-09T16:00:00.000Z', timeMax: '2026-11-10T16:00:00.000Z' });
});
