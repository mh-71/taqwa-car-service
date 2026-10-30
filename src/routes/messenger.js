/* ============================================================
   routes/messenger.js — /api/messenger/...   (migration 0014)
   ------------------------------------------------------------
   The staff side of the Facebook Messenger inbox. Every route is
   behind the API's auth gate (the router dispatches through run()),
   so only a signed-in member of staff can read or reply.

     GET  /api/messenger/conversations                list: q, status,
                                                      unread=1, limit, offset
     GET  /api/messenger/conversations/:id            one conversation
     GET  /api/messenger/conversations/:id/messages   history: limit,
                                                      before (a message id)
     POST /api/messenger/conversations/:id/reply      { text, clientRequestId }
     POST /api/messenger/conversations/:id/read       unread count -> 0
     PUT  /api/messenger/conversations/:id/status     { status?, assignedTo?, notes? }

   ---- replies ----

   A reply is saved as 'sending' BEFORE Meta is asked, then becomes
   'sent' (with Meta's message id) or 'failed' (with the reason). The
   screen therefore never shows a message as sent that Meta refused.
   `clientRequestId` makes a retried request safe: the same id for the
   same conversation returns the first attempt instead of sending again.

   Replies are only offered inside Meta's standard messaging window --
   24 hours from the customer's last message -- and always as a
   RESPONSE, never with a message tag. This inbox cannot broadcast and
   cannot message anyone who has not written first.
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, notFound, unprocessable, conflict } from '../lib/http.js';
import { readJsonBody, nowIso } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { metaConfig, sendText } from '../lib/meta.js';
import { REPLY_METADATA_PREFIX } from './messenger-webhook.js';

export const CONVERSATION_STATUSES = ['Open', 'Pending', 'Resolved'];
const MAX_REPLY = 2000;            // Messenger's limit for one text message
const WINDOW_MS = 24 * 3600 * 1000;
const CONV_ID = /^FBC-\d{1,10}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const LIMITS = { q: 100, assignedTo: 100, notes: 2000 };

const CONV_COLUMNS = `id, page_id, customer_psid, customer_name, customer_profile_pic, status, unread_count,
  last_message, last_message_at, last_direction, last_inbound_at, assigned_to, notes, created_at, updated_at`;
const MSG_COLUMNS = `id, conversation_id, platform_message_id, direction, sender_type, sent_by, kind, message_text,
  attachments_json, status, error_code, error_message, client_request_id, created_at, updated_at`;

/** Is the standard messaging window still open for this conversation? */
export function windowOpen(row, now = Date.now()) {
  if (!row || !row.last_inbound_at) return false;
  return now - Date.parse(row.last_inbound_at) < WINDOW_MS;
}

function toConversation(row, now = Date.now()) {
  return {
    id: row.id,
    platform: 'Facebook',
    customerPsid: row.customer_psid,
    customerName: row.customer_name || 'Facebook user',
    nameKnown: Boolean(row.customer_name),
    status: row.status,
    unreadCount: row.unread_count,
    lastMessage: row.last_message || '',
    lastMessageAt: row.last_message_at || null,
    lastDirection: row.last_direction || null,
    lastInboundAt: row.last_inbound_at || null,
    canReply: windowOpen(row, now),
    replyWindowEndsAt: row.last_inbound_at ? new Date(Date.parse(row.last_inbound_at) + WINDOW_MS).toISOString() : null,
    assignedTo: row.assigned_to || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function toMessage(row) {
  let attachments = [];
  try { attachments = row.attachments_json ? JSON.parse(row.attachments_json) : []; } catch { attachments = []; }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    sentBy: row.sent_by || '',
    kind: row.kind,
    text: row.message_text || '',
    attachments,
    status: row.status,
    error: row.status === 'failed' ? (row.error_message || 'Not sent.') : '',
    hasPlatformId: Boolean(row.platform_message_id),
    // The id the sending page chose for this attempt, so it can match its placeholder.
    clientRequestId: row.client_request_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return String(p.username || p.id).slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  return 'API token';
}

const findConversation = (env, id) =>
  env.DB.prepare(`SELECT ${CONV_COLUMNS} FROM messenger_conversations WHERE id = ?1`).bind(id).first();
const findMessage = (env, id) =>
  env.DB.prepare(`SELECT ${MSG_COLUMNS} FROM messenger_messages WHERE id = ?1`).bind(id).first();

/* ---------- list ---------- */

async function listConversations(request, env, url) {
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !CONVERSATION_STATUSES.includes(status)) {
    return fail('invalid_parameter', `\`status\` must be one of: ${CONVERSATION_STATUSES.join(', ')}.`, 400);
  }
  const unread = url.searchParams.get('unread');
  if (unread !== null && unread !== '' && unread !== '0' && unread !== '1') return fail('invalid_parameter', '`unread` must be 0 or 1.', 400);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > LIMITS.q) return fail('invalid_parameter', `\`q\` must be ${LIMITS.q} characters or fewer.`, 400);
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const where = `
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 = 0 OR unread_count > 0)
      AND (?3 IS NULL OR lower(coalesce(customer_name, '')) LIKE ?3 ESCAPE '\\'
           OR lower(id) LIKE ?3 ESCAPE '\\' OR lower(coalesce(last_message, '')) LIKE ?3 ESCAPE '\\'
           OR customer_psid LIKE ?3 ESCAPE '\\')`;
  const binds = [status, unread === '1' ? 1 : 0, needle];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${CONV_COLUMNS} FROM messenger_conversations ${where}
        ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT ?4 OFFSET ?5`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM messenger_conversations ${where}`).bind(...binds).first();
    const sums = await env.DB.prepare(
      `SELECT count(*) AS total,
              coalesce(sum(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread_conversations,
              coalesce(sum(unread_count), 0) AS unread_messages,
              coalesce(sum(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) AS open,
              coalesce(sum(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
              coalesce(sum(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END), 0) AS resolved
         FROM messenger_conversations`
    ).first();
    const now = Date.now();
    const rows = (results || []).map((r) => toConversation(r, now));
    const cfg = metaConfig(env);
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: {
        total: sums.total, unreadConversations: sums.unread_conversations, unreadMessages: sums.unread_messages,
        open: sums.open, pending: sums.pending, resolved: sums.resolved,
      },
      // Booleans only: whether replies can be sent and events received. Never a value.
      connection: { send: cfg.send, webhook: cfg.webhook },
    });
  } catch (err) {
    console.error('GET /api/messenger/conversations failed:', err && err.message);
    return fail('database_error', 'Could not read conversations.', 500);
  }
}

/* ---------- one conversation, its messages ---------- */

async function getConversation(env, id) {
  try {
    const row = await findConversation(env, id);
    if (!row) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(row));
  } catch (err) {
    console.error('GET /api/messenger/conversations/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the conversation.', 500);
  }
}

async function listMessages(env, id, url) {
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const before = readIntParam(url, 'before', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (before.error) return fail('invalid_parameter', before.error, 400);
  try {
    const conv = await findConversation(env, id);
    if (!conv) return fail('not_found', 'No conversation with that id.', 404);
    // The newest `limit` messages (older than `before` when paging back), shown oldest first.
    const { results } = await env.DB.prepare(
      `SELECT ${MSG_COLUMNS} FROM messenger_messages
        WHERE conversation_id = ?1 AND (?2 = 0 OR id < ?2)
        ORDER BY id DESC LIMIT ?3`
    ).bind(id, before.value, limit.value + 1).all();
    const rows = results || [];
    const hasMore = rows.length > limit.value;
    const page = rows.slice(0, limit.value).reverse().map(toMessage);
    return ok(page, { count: page.length, hasMore, nextBefore: hasMore && page.length ? page[0].id : null });
  } catch (err) {
    console.error('GET /api/messenger/conversations/:id/messages failed:', err && err.message);
    return fail('database_error', 'Could not read the messages.', 500);
  }
}

/* ---------- reply ---------- */

async function reply(request, env, id) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['text', 'clientRequestId'].includes(k)) errors[k] = 'This is not a reply field.';
  const textValue = typeof body.text === 'string' ? body.text.trim() : '';
  if (!textValue) errors.text = 'Write a message first.';
  else if (textValue.length > MAX_REPLY) errors.text = `A Messenger message can be at most ${MAX_REPLY} characters.`;
  if (typeof body.clientRequestId !== 'string' || !REQUEST_ID.test(body.clientRequestId)) {
    errors.clientRequestId = '`clientRequestId` is required: 8-64 letters, digits, - or _.';
  }
  if (Object.keys(errors).length) return unprocessable('The reply could not be sent.', errors);

  try {
    const conv = await findConversation(env, id);
    if (!conv) return fail('not_found', 'No conversation with that id.', 404);

    // The same request again (a retry after a dropped connection): answer with the first attempt.
    const prior = await env.DB.prepare(
      `SELECT ${MSG_COLUMNS} FROM messenger_messages WHERE conversation_id = ?1 AND client_request_id = ?2`
    ).bind(id, body.clientRequestId).first();
    if (prior) return ok(toMessage(prior), { replayed: true });

    if (!metaConfig(env).send) {
      return fail('not_configured', 'The Facebook Page is not connected yet, so replies cannot be sent.', 503);
    }
    if (!windowOpen(conv)) {
      return conflict('This customer last wrote more than 24 hours ago. Facebook only allows a reply within 24 hours of their last message.',
        { reason: 'outside_messaging_window' });
    }

    const who = actorName(request);
    const now = nowIso();
    const sentAt = Date.now();
    const ins = await env.DB.prepare(
      `INSERT INTO messenger_messages (conversation_id, direction, sender_type, sender_id, sent_by, kind, message_text,
         status, client_request_id, platform_timestamp, created_at, updated_at)
       VALUES (?1, 'out', 'staff', ?2, ?3, 'message', ?4, 'sending', ?5, ?6, ?7, ?7)
       ON CONFLICT(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING id`
    ).bind(id, conv.page_id, who, textValue, body.clientRequestId, sentAt, now).first();
    if (!ins) {
      // A concurrent copy of this request got there first; report its row, send nothing.
      const twin = await env.DB.prepare(
        `SELECT ${MSG_COLUMNS} FROM messenger_messages WHERE conversation_id = ?1 AND client_request_id = ?2`
      ).bind(id, body.clientRequestId).first();
      return ok(toMessage(twin), { replayed: true });
    }

    const sent = await sendText(env, conv.customer_psid, textValue, `${REPLY_METADATA_PREFIX}${body.clientRequestId}`);
    if (!sent.ok) {
      await env.DB.prepare(
        `UPDATE messenger_messages SET status = 'failed', error_code = ?2, error_message = ?3, updated_at = ?4 WHERE id = ?1`
      ).bind(ins.id, sent.code.slice(0, 40), sent.message.slice(0, 300), nowIso()).run();
      // 502: the reply is saved, as failed, so the screen can show it with the reason.
      return fail('send_failed', sent.message, 502, { reason: sent.code, retryable: sent.retryable, messageId: ins.id });
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messenger_messages SET status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END,
                platform_message_id = coalesce(platform_message_id, ?2), updated_at = ?3
          WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM messenger_messages WHERE platform_message_id = ?2 AND id <> ?1)`
      ).bind(ins.id, sent.messageId.slice(0, 200), nowIso()),
      env.DB.prepare(
        `UPDATE messenger_conversations SET last_message = ?2, last_message_at = ?3, last_direction = 'out',
                unread_count = 0, updated_at = ?3 WHERE id = ?1`
      ).bind(id, textValue.replace(/\s+/g, ' ').slice(0, 300), nowIso()),
    ]);
    return ok(toMessage(await findMessage(env, ins.id)), {}, 201);
  } catch (err) {
    console.error('POST /api/messenger/conversations/:id/reply failed:', err && err.message);
    return fail('database_error', 'The reply could not be saved.', 500);
  }
}

/* ---------- read / status ---------- */

async function markRead(env, id) {
  try {
    const res = await env.DB.prepare(
      'UPDATE messenger_conversations SET unread_count = 0, updated_at = ?2 WHERE id = ?1'
    ).bind(id, nowIso()).run();
    if (!res.meta || res.meta.changes !== 1) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(await findConversation(env, id)));
  } catch (err) {
    console.error('POST /api/messenger/conversations/:id/read failed:', err && err.message);
    return fail('database_error', 'Could not update the conversation.', 500);
  }
}

async function updateStatus(request, env, id) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['status', 'assignedTo', 'notes'].includes(k)) errors[k] = 'This is not a conversation field.';
  const sets = {};
  if (body.status !== undefined) {
    if (!CONVERSATION_STATUSES.includes(body.status)) errors.status = `Choose one of: ${CONVERSATION_STATUSES.join(', ')}.`;
    else sets.status = body.status;
  }
  for (const [key, col] of [['assignedTo', 'assigned_to'], ['notes', 'notes']]) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') { errors[key] = 'Must be text.'; continue; }
    const v = (body[key] || '').trim();
    if (v.length > LIMITS[key]) errors[key] = `Keep this to ${LIMITS[key]} characters or fewer.`;
    else sets[col] = v || null;
  }
  if (!Object.keys(errors).length && !Object.keys(sets).length) errors.status = 'Nothing to change.';
  if (Object.keys(errors).length) return unprocessable('The conversation could not be updated.', errors);
  try {
    const names = Object.keys(sets);
    const res = await env.DB.prepare(
      `UPDATE messenger_conversations SET ${names.map((n, i) => `${n} = ?${i + 2}`).join(', ')}, updated_at = ?${names.length + 2}
        WHERE id = ?1`
    ).bind(id, ...names.map((n) => sets[n]), nowIso()).run();
    if (!res.meta || res.meta.changes !== 1) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(await findConversation(env, id)));
  } catch (err) {
    console.error('PUT /api/messenger/conversations/:id/status failed:', err && err.message);
    return fail('database_error', 'Could not update the conversation.', 500);
  }
}

/* ---------- the router for /api/messenger/... ---------- */

export const MESSENGER_ROUTES = [
  'GET /api/messenger/conversations',
  'GET /api/messenger/conversations/:id',
  'GET /api/messenger/conversations/:id/messages',
  'POST /api/messenger/conversations/:id/reply',
  'POST /api/messenger/conversations/:id/read',
  'PUT /api/messenger/conversations/:id/status',
];

/** `rest` is the path after /api/messenger/. Called only once the auth gate has passed. */
export async function messenger(request, env, url, rest) {
  if (!env.DB) return noDatabase();
  const parts = rest.split('/');
  if (parts[0] !== 'conversations' || parts.length > 3) return notFound(MESSENGER_ROUTES);
  const m = request.method;
  if (parts.length === 1) return m === 'GET' ? listConversations(request, env, url) : methodNotAllowed(['GET']);
  let id;
  try { id = decodeURIComponent(parts[1]); } catch { id = ''; }
  if (!CONV_ID.test(id)) return fail('invalid_id', 'Conversation id must look like FBC-0001.', 400);
  if (parts.length === 2) return m === 'GET' ? getConversation(env, id) : methodNotAllowed(['GET']);
  const action = parts[2];
  if (action === 'messages') return m === 'GET' ? listMessages(env, id, url) : methodNotAllowed(['GET']);
  if (action === 'reply') return m === 'POST' ? reply(request, env, id) : methodNotAllowed(['POST']);
  if (action === 'read') return m === 'POST' ? markRead(env, id) : methodNotAllowed(['POST']);
  if (action === 'status') return m === 'PUT' ? updateStatus(request, env, id) : methodNotAllowed(['PUT']);
  return notFound(MESSENGER_ROUTES);
}
