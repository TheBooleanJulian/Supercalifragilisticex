// node --test   Webhook flow of worker.js: text -> gateway -> confirm buttons -> edit -> Google Calendar,
// against an in-memory Postgres stand-in, a fake gateway binding, and a stubbed global fetch (Telegram + Google).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function fakeSql() {
  const pending = new Map(), editing = new Map();
  const sql = async (strings, ...v) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.startsWith('insert into supercal.pending')) { pending.set(v[0], { chat_id: v[1], event: JSON.parse(v[2]) }); return []; }
    if (q.startsWith('select event from supercal.pending')) { const p = pending.get(v[0]); return p && p.chat_id === v[1] ? [{ event: p.event }] : []; }
    if (q.startsWith('update supercal.pending')) { pending.get(v[1]).event = JSON.parse(v[0]); return []; }
    if (q.startsWith('delete from supercal.pending where eid')) { const p = pending.get(v[0]); if (p && p.chat_id === v[1]) { pending.delete(v[0]); return [{ event: p.event }]; } return []; }
    if (q.startsWith('insert into supercal.editing')) { editing.set(v[0], { eid: v[1], field: v[2], message_id: v[3] }); return []; }
    if (q.startsWith('select eid, field')) return editing.has(v[0]) ? [editing.get(v[0])] : [];
    if (q.startsWith('delete from supercal.editing where chat_id')) { editing.delete(v[0]); return []; }
    if (q.startsWith('select 1')) return [{}];
    throw new Error(`unexpected query: ${q}`);
  };
  sql.end = async () => {};
  return { sql, pending, editing };
}

const EVENTS = { events: [{ id: 'e1', title: 'Team dinner', date: '2026-11-12', start_time: '19:00', end_time: null, location: 'Marina Bay', description: null, is_all_day: false }] };

function setup() {
  const db = fakeSql();
  const calls = [];
  let cal = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      const method = u.split('/').pop();
      calls.push({ method, body: JSON.parse(init.body || '{}') });
      return Response.json({ ok: true, result: { message_id: calls.length } });
    }
    if (u.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'tok' });
    if (u.includes('googleapis.com/calendar')) { cal.push({ url: u, init }); return Response.json({ htmlLink: 'https://cal/x', items: [] }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  const env = {
    SQL: db.sql, BOT_TOKEN: '123:abc', WEBHOOK_SECRET: 's3', ALLOWED_USER_IDS: '42', BOT_USERNAME: 'supercalbot',
    GOOGLE_TOKEN_JSON: JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }),
    ASSETS: { fetch: () => new Response('asset') },
    LLM: { fetch: async (_u, init) => { env.llmRequest = JSON.parse(init.body); env.llmHeaders = init.headers; return Response.json({ choices: [{ message: { content: JSON.stringify(EVENTS) } }] }); } }
  };
  return { env, db, calls, cal };
}

const post = async (env, update, secret = 's3') => {
  const tasks = [];
  const res = await worker.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
  return res;
};
const msg = (text, from = 42) => ({ update_id: 1, message: { message_id: 10, from: { id: from }, chat: { id: 42 }, text } });

test('rejects webhook calls without the secret', async () => {
  const { env } = setup();
  assert.equal((await post(env, msg('hi'), 'wrong')).status, 403);
});

test('ignores users outside ALLOWED_USER_IDS', async () => {
  const { env, calls } = setup();
  await post(env, msg('dinner tomorrow', 99));
  assert.equal(calls.length, 0);
});

test('text -> events with confirm buttons, using the event-extract use case', async () => {
  const { env, db, calls } = setup();
  await post(env, msg('team dinner thu 7pm marina bay'));
  assert.equal(env.llmHeaders['X-TBJ-Use-Case'], 'event-extract');
  assert.equal(env.llmHeaders['X-TBJ-Service'], 'supercalifragilisticex');
  assert.equal(db.pending.size, 1);
  const card = calls.find((c) => c.method === 'sendMessage' && c.body.reply_markup);
  assert.match(card.body.text, /Team dinner/);
  assert.equal(card.body.reply_markup.inline_keyboard[0][0].text, '✅ Add to Calendar');
});

test('edit a field, then add to calendar', async () => {
  const { env, db, calls } = setup();
  await post(env, msg('team dinner'));
  const eid = [...db.pending.keys()][0];
  const cb = (data) => ({ update_id: 2, callback_query: { id: 'q', from: { id: 42 }, data, message: { message_id: 7, chat: { id: 42 } } } });

  await post(env, cb(`ef:${eid}:start_time`));
  assert.equal(db.editing.get('42').field, 'start_time');
  await post(env, msg('25:99')); // invalid: stays in edit mode
  assert.equal(db.editing.size, 1);
  assert.match(calls.at(-1).body.text, /Invalid time/);
  await post(env, msg('20:30'));
  assert.equal(db.editing.size, 0);
  assert.equal(db.pending.get(eid).event.start_time, '20:30');

  await post(env, cb(`ok:${eid}`));
  assert.equal(db.pending.size, 0);
  assert.match(calls.at(-1).body.text, /Added!/);
});

test('callbacks for another chat or an expired event do nothing harmful', async () => {
  const { env, calls } = setup();
  await post(env, { update_id: 3, callback_query: { id: 'q', from: { id: 42 }, data: 'ok:deadbeef', message: { message_id: 7, chat: { id: 42 } } } });
  assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup'));
  assert.ok(!calls.some((c) => c.method === 'editMessageText'));
});

test('/healthz reports pass with Postgres and the gateway binding', async () => {
  const { env } = setup();
  const res = await worker.fetch(new Request('https://x/healthz'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
});
