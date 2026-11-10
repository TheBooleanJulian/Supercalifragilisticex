// Supercalifragilisticex on Cloudflare Workers (replaces bot.py on Zeabur).
//
//   POST /webhook   Telegram updates, checked against WEBHOOK_SECRET
//   cron 0 23 * * * 07:00 SGT: morning brief DM (today's Google Calendar events)
//   GET  /healthz   bot-core health JSON (the bot-core fan-out gates on it); /status branded page
//
// Send text or a picture of an invite/flyer: the model extracts events through thebooleanjulian-llm
// (use cases event-extract / event-extract-vision), you confirm or edit each, and it is added to Google Calendar.
// Pending events and the "which field am I editing" state live in Supabase (schema supercal, via Hyperdrive),
// because a Worker keeps nothing in memory between updates.

import { log, api, verifyWebhook, parseCommand, healthz, statusPage, serveBrand } from 'thebooleanjulian-bot-core';
import { withDb, dbCheck } from 'thebooleanjulian-bot-core/db';
import { createEvent, listEventsToday } from './gcal.js';
import { FIELDS, SYSTEM_PROMPT, applyEdit, formatBrief, formatEvent, parseEvents, todayLabel } from './events.js';

const PENDING_TTL_DAYS = 7;

// ── model ──────────────────────────────────────────────────────────────────
async function extract(env, useCase, content) {
  const res = await env.LLM.fetch('https://llm/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TBJ-Service': 'supercalifragilisticex', 'X-TBJ-Use-Case': useCase },
    body: JSON.stringify({ messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gateway ${res.status} ${data?.error?.code || ''} trace ${res.headers.get('x-tbj-trace-id') || '-'}`);
  return parseEvents(data.choices?.[0]?.message?.content || '');
}

const extractText = (env, text) => extract(env, 'event-extract', `Today is ${todayLabel()}.\n\n${text}`);
const extractImage = (env, dataUrl) =>
  extract(env, 'event-extract-vision', [
    { type: 'image_url', image_url: { url: dataUrl } },
    { type: 'text', text: `Today is ${todayLabel()}. Extract all calendar events from this image.` }
  ]);

async function fileDataUrl(env, fileId, mime = 'image/jpeg') {
  const file = await api(env, 'getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download ${res.status}`);
  return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

// ── storage ────────────────────────────────────────────────────────────────
const q = (env, fn) => withDb(env, null, fn);
const store = {
  put: (env, eid, chatId, event) => q(env, (sql) => sql`insert into supercal.pending (eid, chat_id, event) values (${eid}, ${String(chatId)}, ${JSON.stringify(event)}::jsonb)`),
  get: async (env, eid, chatId) => (await q(env, (sql) => sql`select event from supercal.pending where eid = ${eid} and chat_id = ${String(chatId)}`))[0]?.event ?? null,
  set: (env, eid, event) => q(env, (sql) => sql`update supercal.pending set event = ${JSON.stringify(event)}::jsonb where eid = ${eid}`),
  take: async (env, eid, chatId) => (await q(env, (sql) => sql`delete from supercal.pending where eid = ${eid} and chat_id = ${String(chatId)} returning event`))[0]?.event ?? null,
  startEdit: (env, chatId, eid, field, messageId) => q(env, (sql) => sql`
    insert into supercal.editing (chat_id, eid, field, message_id) values (${String(chatId)}, ${eid}, ${field}, ${String(messageId)})
    on conflict (chat_id) do update set eid = excluded.eid, field = excluded.field, message_id = excluded.message_id, updated_at = now()`),
  editing: async (env, chatId) => (await q(env, (sql) => sql`select eid, field, message_id from supercal.editing where chat_id = ${String(chatId)}`))[0] ?? null,
  endEdit: (env, chatId) => q(env, (sql) => sql`delete from supercal.editing where chat_id = ${String(chatId)}`),
  prune: (env) => q(env, async (sql) => {
    await sql`delete from supercal.pending where created_at < now() - ${PENDING_TTL_DAYS} * interval '1 day'`;
    await sql`delete from supercal.editing where updated_at < now() - interval '1 day'`;
  })
};

// ── telegram helpers ───────────────────────────────────────────────────────
const HTML = { parse_mode: 'HTML' };
const send = (env, chatId, text, extra = {}) => api(env, 'sendMessage', { chat_id: chatId, text, ...extra });
const edit = (env, q_, text, extra = {}) =>
  api(env, 'editMessageText', { chat_id: q_.message.chat.id, message_id: q_.message.message_id, text, ...extra });

const allowed = (env, uid) => {
  const ids = String(env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length === 0 || ids.includes(String(uid));
};

const eventKeyboard = (eid) => ({
  inline_keyboard: [
    [{ text: '✅ Add to Calendar', callback_data: `ok:${eid}` }, { text: '✏️ Edit', callback_data: `edit:${eid}` }],
    [{ text: '❌ Skip', callback_data: `skip:${eid}` }]
  ]
});

const fieldKeyboard = (eid, ev) => {
  const rows = [[{ text: 'Title', callback_data: `ef:${eid}:title` }]];
  if (ev.is_all_day) rows.push([{ text: 'Date', callback_data: `ef:${eid}:date` }]);
  else {
    rows.push([{ text: 'Date', callback_data: `ef:${eid}:date` }, { text: 'Start time', callback_data: `ef:${eid}:start_time` }]);
    rows.push([{ text: 'End time', callback_data: `ef:${eid}:end_time` }]);
  }
  rows.push([{ text: 'Location', callback_data: `ef:${eid}:location` }, { text: 'Description', callback_data: `ef:${eid}:description` }]);
  rows.push([{ text: '« Back', callback_data: `back:${eid}` }]);
  return { inline_keyboard: rows };
};

const newEid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

// ── flows ──────────────────────────────────────────────────────────────────
async function present(env, chatId, events) {
  if (!events.length) return send(env, chatId, '😕 No calendar events found.');
  await send(env, chatId, `✅ Found <b>${events.length}</b> event(s). Confirm each:`, HTML);
  for (const ev of events) {
    const eid = newEid();
    await store.put(env, eid, chatId, ev);
    await send(env, chatId, formatEvent(ev), { ...HTML, reply_markup: eventKeyboard(eid) });
  }
}

// Runs a long job with a status message that is replaced by the result, or by the error.
async function withStatus(env, chatId, label, job) {
  const status = await send(env, chatId, label);
  try {
    const events = await job();
    await api(env, 'deleteMessage', { chat_id: chatId, message_id: status.message_id }).catch(() => {});
    await present(env, chatId, events);
  } catch (err) {
    log.error('extraction failed', { error: err.message });
    await api(env, 'editMessageText', { chat_id: chatId, message_id: status.message_id, text: `❌ ${err.message}` }).catch(() => {});
  }
}

async function applyPendingEdit(env, msg, editing) {
  const chatId = msg.chat.id;
  const ev = await store.get(env, editing.eid, chatId);
  if (!ev) {
    await store.endEdit(env, chatId);
    return send(env, chatId, 'This event is no longer pending.');
  }
  const result = applyEdit(ev, editing.field, msg.text);
  if (result.error) return send(env, chatId, result.error); // keep the editing state so they can retry
  await store.set(env, editing.eid, result.event);
  await store.endEdit(env, chatId);
  await api(env, 'editMessageText', {
    chat_id: chatId, message_id: Number(editing.message_id), text: formatEvent(result.event), ...HTML, reply_markup: eventKeyboard(editing.eid)
  });
  await api(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
}

async function onMessage(env, msg) {
  const chatId = msg.chat.id;
  if (!allowed(env, msg.from?.id)) return;

  const cmd = msg.entities?.some((e) => e.type === 'bot_command') ? parseCommand(msg.text, env.BOT_USERNAME) : null;
  if (cmd?.name === 'start') {
    return send(env, chatId,
      '📅 <b>Calendar Bot</b>\n\nSend me:\n• A photo of an invite, flyer, or schedule\n• Text describing events\n\n' +
      "I'll extract the entries and confirm before adding them to Google Calendar.\n\n" +
      "Use /today for your schedule right now — I'll also DM you a morning brief automatically.", HTML);
  }
  if (cmd?.name === 'today') {
    try {
      return await send(env, chatId, formatBrief(await listEventsToday(env)), HTML);
    } catch (err) {
      log.error('today failed', { error: err.message });
      return send(env, chatId, `❌ ${err.message}`);
    }
  }
  if (cmd) return;

  if (msg.photo?.length) {
    return withStatus(env, chatId, '⏳ Analysing image…', async () => extractImage(env, await fileDataUrl(env, msg.photo[msg.photo.length - 1].file_id)));
  }
  if (msg.document) {
    if (!msg.document.mime_type?.startsWith('image/')) return send(env, chatId, 'Send an image file.');
    return withStatus(env, chatId, '⏳ Analysing image…', async () => extractImage(env, await fileDataUrl(env, msg.document.file_id, msg.document.mime_type)));
  }
  if (msg.text) {
    const editing = await store.editing(env, chatId);
    if (editing) return applyPendingEdit(env, msg, editing);
    return withStatus(env, chatId, '⏳ Extracting events…', () => extractText(env, msg.text));
  }
}

async function onCallback(env, cb) {
  await api(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!allowed(env, cb.from?.id) || !cb.message) return;
  const chatId = cb.message.chat.id;
  const [action, eid, field] = String(cb.data || '').split(':');
  const noMarkup = () => api(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

  if (action === 'edit' || action === 'back' || action === 'ef') {
    const ev = await store.get(env, eid, chatId);
    if (!ev) return noMarkup();
    if (action === 'edit') return api(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: fieldKeyboard(eid, ev) });
    if (action === 'back') return edit(env, cb, formatEvent(ev), { ...HTML, reply_markup: eventKeyboard(eid) });
    if (!FIELDS[field]) return;
    await store.startEdit(env, chatId, eid, field, cb.message.message_id);
    return edit(env, cb, `✏️ Send the new <b>${FIELDS[field]}</b>:`, HTML);
  }

  const ev = await store.take(env, eid, chatId);
  if (!ev) return noMarkup();
  if (action === 'ok') {
    try {
      const link = await createEvent(env, ev);
      return edit(env, cb, `✅ <b>Added!</b>\n${formatEvent(ev)}${link ? `\n\n<a href="${link}">Open in Calendar</a>` : ''}`, HTML);
    } catch (err) {
      log.error('calendar create failed', { error: err.message });
      return edit(env, cb, `❌ Failed to create event:\n${err.message}`);
    }
  }
  return edit(env, cb, `⏭️ <b>Skipped</b>\n${formatEvent(ev)}`, HTML);
}

async function handleUpdate(env, update) {
  try {
    if (update.message) await onMessage(env, update.message);
    else if (update.callback_query) await onCallback(env, update.callback_query);
  } catch (err) {
    log.error('update failed', { update_id: update.update_id, error: err.message });
  }
}

// ── morning brief ──────────────────────────────────────────────────────────
function briefChat(env) {
  if (env.MORNING_BRIEF_CHAT_ID) return String(env.MORNING_BRIEF_CHAT_ID).trim();
  return String(env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
}

async function morningBrief(env) {
  const chat = briefChat(env);
  if (!chat) return log.warn('no MORNING_BRIEF_CHAT_ID / ALLOWED_USER_IDS, skipping brief');
  try {
    await send(env, chat, formatBrief(await listEventsToday(env)), HTML);
  } catch (err) {
    log.error('morning brief failed', { error: err.message });
  }
}

// ── http ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    const brand = serveBrand(request);
    if (brand) return brand;
    if (pathname === '/healthz') return healthz(env, { checks: { postgres: await dbCheck(env, ctx), gateway: env.LLM ? 'ok' : 'FAIL: LLM binding missing' } });
    if (pathname === '/status') {
      const pg = await dbCheck(env, ctx);
      return statusPage(env, {
        name: 'Supercalifragilisticex',
        username: env.BOT_USERNAME ? `@${env.BOT_USERNAME}` : '',
        icon: '📅',
        description: 'Send a photo or text of an invite; confirm the events and they land in Google Calendar. Morning brief at 07:00 SGT.',
        ok: pg === 'ok',
        commands: [['/start', 'What I do'], ['/today', "Today's calendar"]]
      });
    }
    if (pathname === '/webhook' && request.method === 'POST') {
      if (!verifyWebhook(request, env)) return new Response('forbidden', { status: 403 });
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update));
      return new Response('ok');
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    await morningBrief(env);
    await store.prune(env).catch((err) => log.error('prune failed', { error: err.message }));
  }
};
