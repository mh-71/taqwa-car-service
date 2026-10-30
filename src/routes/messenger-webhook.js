/* ============================================================
   routes/messenger-webhook.js — /api/webhooks/messenger
   ------------------------------------------------------------
   The one door Meta uses to tell this Worker about Messenger
   activity on the workshop's Facebook Page. Public by necessity --
   Meta has no session cookie -- so it carries its own security:

     GET   the subscription handshake. The challenge is echoed back
           only when hub.mode is "subscribe" and hub.verify_token
           matches META_WEBHOOK_VERIFY_TOKEN (constant time).
     POST  an event delivery. Refused unless X-Hub-Signature-256 is
           the HMAC-SHA256 of the RAW body under META_APP_SECRET.
           Nothing in an unsigned body is read, let alone stored.

   Handled (entry[].messaging[]):
     message          a customer wrote -> stored, conversation updated
     message.is_echo  the Page sent something -> a reply sent from here
                      is matched to its row; one sent from another tool
                      (Meta Business Suite) is stored as from the Page
     delivery / read  outbound messages up to the watermark move on
     postback         a button tap -> stored as the button's title
   Anything else is acknowledged and ignored.

   Meta retries a delivery that is not answered 200, so the same event
   can arrive twice: the unique index on the message id makes the second
   one a no-op. A storage failure answers 500 so that Meta retries it.

   Fail closed: with no App Secret configured every POST is refused.
   ============================================================ */

import { fail, methodNotAllowed, noDatabase, SECURITY_HEADERS } from '../lib/http.js';
import { allocateId, nowIso } from '../lib/write.js';
import { metaConfig, verifyTokenMatches, signatureValid, fetchProfile } from '../lib/meta.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT = 20000;
const PREVIEW = 300;
/** Our own replies carry this metadata prefix, so their echoes can be matched. */
export const REPLY_METADATA_PREFIX = 'taqwa-reply:';

const text = (body, status = 200) => new Response(body, {
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
});

/* ---------- GET: the handshake ---------- */

function verify(request, env, url) {
  if (!metaConfig(env).webhook) {
    console.error('Messenger webhook: META_WEBHOOK_VERIFY_TOKEN / META_APP_SECRET are not configured.');
    return fail('webhook_not_configured', 'This webhook is not configured.', 503);
  }
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') || '';
  // The challenge is echoed as plain text; only the shape Meta sends is accepted,
  // so this can never reflect markup back to a browser.
  if (mode !== 'subscribe' || !verifyTokenMatches(env, token) || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
    return fail('forbidden', 'Webhook verification failed.', 403);
  }
  return text(challenge);
}

/* ---------- POST: events ---------- */

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);
const isoFrom = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : nowIso());

/** Keep only the attachment fields worth showing: type, an https URL, a title. */
function attachmentsOf(message) {
  const list = Array.isArray(message && message.attachments) ? message.attachments.slice(0, 10) : [];
  const out = list.map((a) => {
    const url = a && a.payload && typeof a.payload.url === 'string' && /^https:\/\//.test(a.payload.url) ? a.payload.url.slice(0, 2000) : null;
    const type = ['image', 'video', 'audio', 'file', 'location', 'fallback', 'template', 'sticker'].includes(a && a.type) ? a.type : 'file';
    return { type: a && a.payload && a.payload.sticker_id ? 'sticker' : type, url, title: clip(a && a.title, 200) };
  });
  return out.length ? JSON.stringify(out) : null;
}

function previewOf(textValue, attachmentsJson, kind) {
  if (textValue && textValue.trim()) return textValue.replace(/\s+/g, ' ').trim().slice(0, PREVIEW);
  if (kind === 'postback') return '[Button]';
  if (attachmentsJson) {
    const first = JSON.parse(attachmentsJson)[0];
    return `[${first.type === 'image' ? 'Photo' : first.type === 'sticker' ? 'Sticker' : first.type[0].toUpperCase() + first.type.slice(1)}]`;
  }
  return '[Message]';
}

/** The conversation for this Page and customer, created if this is the first message. */
async function conversationFor(env, pageId, psid, ctx) {
  const find = () => env.DB.prepare(
    'SELECT id, customer_name FROM messenger_conversations WHERE page_id = ?1 AND customer_psid = ?2'
  ).bind(pageId, psid).first();
  let row = await find();
  if (row) return row;
  const allocated = await allocateId(env, 'messengerConversations');
  if (allocated.error) throw new Error(allocated.error);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO messenger_conversations (id, page_id, customer_psid, status, unread_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Open', 0, ?4, ?4)
     ON CONFLICT(page_id, customer_psid) DO NOTHING`
  ).bind(allocated.id, pageId, psid, now).run();
  row = await find();
  // The customer's name, fetched after the answer to Meta where the runtime allows it.
  const lookup = fetchProfile(env, psid).then((p) => (p && (p.name || p.pic)
    ? env.DB.prepare(
      `UPDATE messenger_conversations SET customer_name = coalesce(?2, customer_name),
              customer_profile_pic = coalesce(?3, customer_profile_pic) WHERE id = ?1`
    ).bind(row.id, p.name, p.pic).run()
    : null)).catch(() => null);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(lookup); else await lookup;
  return row;
}

async function storeInbound(env, pageId, ev, ctx, kind) {
  const psid = ev.sender && ev.sender.id;
  const m = kind === 'postback' ? ev.postback : ev.message;
  const mid = clip(m && m.mid, 200);
  if (!psid || !mid) return 'ignored';
  const conv = await conversationFor(env, pageId, psid, ctx);
  const bodyText = clip(kind === 'postback' ? (m.title || m.payload || '') : m.text, MAX_TEXT);
  const attachments = kind === 'postback'
    ? JSON.stringify([{ type: 'postback', url: null, title: clip(m.payload, 200) }])
    : attachmentsOf(m);
  const at = isoFrom(ev.timestamp);
  const res = await env.DB.prepare(
    `INSERT INTO messenger_messages (conversation_id, platform_message_id, direction, sender_type, sender_id, kind,
       message_text, attachments_json, status, platform_timestamp, created_at)
     VALUES (?1, ?2, 'in', 'customer', ?3, ?4, ?5, ?6, 'received', ?7, ?8)
     ON CONFLICT(platform_message_id) WHERE platform_message_id IS NOT NULL DO NOTHING`
  ).bind(conv.id, mid, psid, kind, bodyText, attachments, Number.isFinite(ev.timestamp) ? ev.timestamp : null, at).run();
  if (!res.meta || res.meta.changes !== 1) return 'duplicate';
  await env.DB.prepare(
    `UPDATE messenger_conversations
        SET unread_count = unread_count + 1,
            last_message = ?2, last_message_at = ?3, last_direction = 'in', last_inbound_at = ?3,
            status = CASE WHEN status = 'Resolved' THEN 'Open' ELSE status END,
            updated_at = ?4
      WHERE id = ?1`
  ).bind(conv.id, previewOf(bodyText, kind === 'postback' ? null : attachments, kind), at, nowIso()).run();
  return 'stored';
}

async function storeEcho(env, pageId, ev, ctx) {
  const psid = ev.recipient && ev.recipient.id;
  const m = ev.message;
  const mid = clip(m && m.mid, 200);
  if (!psid || !mid) return 'ignored';
  const conv = await conversationFor(env, pageId, psid, ctx);
  const meta = typeof m.metadata === 'string' ? m.metadata : '';
  if (meta.startsWith(REPLY_METADATA_PREFIX)) {
    // A reply sent from Taqwa Autos: its row exists already. Give it the mid if
    // the Send API's answer has not yet done so; never store it a second time.
    const requestId = meta.slice(REPLY_METADATA_PREFIX.length);
    await env.DB.prepare(
      `UPDATE messenger_messages
          SET platform_message_id = coalesce(platform_message_id, ?3),
              status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END, updated_at = ?4
        WHERE conversation_id = ?1 AND client_request_id = ?2
          AND NOT EXISTS (SELECT 1 FROM messenger_messages WHERE platform_message_id = ?3)`
    ).bind(conv.id, requestId, mid, nowIso()).run();
    return 'matched';
  }
  const bodyText = clip(m.text, MAX_TEXT);
  const attachments = attachmentsOf(m);
  const at = isoFrom(ev.timestamp);
  const res = await env.DB.prepare(
    `INSERT INTO messenger_messages (conversation_id, platform_message_id, direction, sender_type, sender_id, kind,
       message_text, attachments_json, status, sent_by, platform_timestamp, created_at)
     VALUES (?1, ?2, 'out', 'page', ?3, 'message', ?4, ?5, 'sent', 'Facebook Page', ?6, ?7)
     ON CONFLICT(platform_message_id) WHERE platform_message_id IS NOT NULL DO NOTHING`
  ).bind(conv.id, mid, pageId, bodyText, attachments, Number.isFinite(ev.timestamp) ? ev.timestamp : null, at).run();
  if (!res.meta || res.meta.changes !== 1) return 'duplicate';
  await env.DB.prepare(
    `UPDATE messenger_conversations SET last_message = ?2, last_message_at = ?3, last_direction = 'out', updated_at = ?4
      WHERE id = ?1 AND (last_message_at IS NULL OR last_message_at <= ?3)`
  ).bind(conv.id, previewOf(bodyText, attachments, 'message'), at, nowIso()).run();
  return 'stored';
}

/** delivery / read: every outbound message up to the watermark has reached that state. */
async function storeReceipt(env, pageId, ev, state) {
  const psid = ev.sender && ev.sender.id;
  const watermark = ev[state] && Number(ev[state].watermark);
  if (!psid || !Number.isFinite(watermark)) return 'ignored';
  const from = state === 'read' ? "('sent', 'delivered')" : "('sent')";
  await env.DB.prepare(
    `UPDATE messenger_messages SET status = ?3, updated_at = ?4
      WHERE direction = 'out' AND status IN ${from} AND platform_timestamp <= ?2
        AND conversation_id = (SELECT id FROM messenger_conversations WHERE page_id = ?5 AND customer_psid = ?1)`
  ).bind(psid, watermark, state === 'read' ? 'read' : 'delivered', nowIso(), pageId).run();
  return 'updated';
}

async function handleEvent(env, pageId, ev, ctx) {
  if (!ev || typeof ev !== 'object') return 'ignored';
  if (ev.message && ev.message.is_echo) return storeEcho(env, pageId, ev, ctx);
  if (ev.message) return storeInbound(env, pageId, ev, ctx, 'message');
  if (ev.postback) return storeInbound(env, pageId, ev, ctx, 'postback');
  if (ev.delivery) return storeReceipt(env, pageId, ev, 'delivery');
  if (ev.read) return storeReceipt(env, pageId, ev, 'read');
  return 'ignored';
}

async function receive(request, env, ctx) {
  if (!metaConfig(env).webhook) {
    console.error('Messenger webhook: refusing a delivery, META_APP_SECRET is not configured.');
    return fail('webhook_not_configured', 'This webhook is not configured.', 503);
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return fail('payload_too_large', 'Delivery too large.', 413);
  if (!(await signatureValid(env, request.headers.get('x-hub-signature-256'), raw))) {
    return fail('invalid_signature', 'Signature verification failed.', 401);
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return fail('invalid_body', 'Body is not JSON.', 400); }
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) return text('IGNORED');
  if (!env.DB) return noDatabase();

  const ourPage = metaConfig(env).pageId;
  const outcome = { stored: 0, duplicate: 0, matched: 0, updated: 0, ignored: 0 };
  try {
    for (const entry of payload.entry.slice(0, 100)) {
      const pageId = entry && typeof entry.id === 'string' ? entry.id : null;
      // Only the configured Page is this inbox's; another Page on the same app is not.
      if (!pageId || (ourPage && pageId !== ourPage)) { outcome.ignored += 1; continue; }
      for (const ev of (Array.isArray(entry.messaging) ? entry.messaging.slice(0, 100) : [])) {
        outcome[await handleEvent(env, pageId, ev, ctx)] += 1;
      }
    }
  } catch (err) {
    // 500 makes Meta deliver it again; what was already stored is deduplicated then.
    console.error('Messenger webhook: storing an event failed:', err && err.message);
    return fail('database_error', 'The event could not be stored.', 500);
  }
  return text('EVENT_RECEIVED');
}

/** The router hands every /api/webhooks/messenger request here. Public: see the header. */
export async function messengerWebhook(request, env, url, ctx) {
  if (request.method === 'GET') return verify(request, env, url);
  if (request.method === 'POST') return receive(request, env, ctx);
  return methodNotAllowed(['GET', 'POST']);
}
