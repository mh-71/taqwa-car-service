/* ============================================================
   meta.js — the Meta (Facebook) Messenger Platform, in one place
   ------------------------------------------------------------
   Everything that touches Meta's secrets or Meta's servers:

     * webhook verification (the GET handshake's verify token),
     * webhook signatures (X-Hub-Signature-256, HMAC-SHA256 of the
       RAW body with the App Secret, compared in constant time),
     * the Send API (POST /{page-id}/messages),
     * the customer's public profile (name and picture), best effort.

   Configuration comes ONLY from Worker secrets / variables:

     META_APP_SECRET            signs every webhook delivery
     META_WEBHOOK_VERIFY_TOKEN  the token typed into the Meta dashboard
     META_PAGE_ACCESS_TOKEN     sends replies as the Page
     META_PAGE_ID               the Page this inbox belongs to
     META_GRAPH_VERSION         optional, e.g. "v23.0"

   None of them is logged, returned, stored in D1 or sent anywhere but
   graph.facebook.com. The token travels in an Authorization header,
   never in a URL, so it cannot end up in a log line that prints URLs.

   `env.META_FETCH` lets the unit suites stand in for Meta. It is never
   set in production, where the global fetch is used.
   ============================================================ */

const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH_TIMEOUT_MS = 10000;
const PROFILE_TIMEOUT_MS = 3000;

const configured = (v) => typeof v === 'string' && v.trim() !== '';

/** What this Worker can do with Meta, as booleans only -- never a value. */
export function metaConfig(env) {
  return {
    webhook: configured(env && env.META_APP_SECRET) && configured(env && env.META_WEBHOOK_VERIFY_TOKEN),
    send: configured(env && env.META_PAGE_ACCESS_TOKEN) && configured(env && env.META_PAGE_ID),
    pageId: configured(env && env.META_PAGE_ID) ? env.META_PAGE_ID.trim() : '',
  };
}

const graphVersion = (env) => {
  const v = env && env.META_GRAPH_VERSION;
  return typeof v === 'string' && /^v\d{1,2}\.\d$/.test(v.trim()) ? v.trim() : DEFAULT_GRAPH_VERSION;
};

const metaFetch = (env) => (env && typeof env.META_FETCH === 'function' ? env.META_FETCH : fetch);

/* ---------- constant time ---------- */

/** Equal byte strings, compared without an early exit. Different lengths are simply unequal. */
export function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length || x.length === 0) return false;
  if (typeof crypto?.subtle?.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------- webhook verification ---------- */

/**
 * The GET handshake: does this verify token match ours?
 *
 * Both sides are trimmed: a token pasted into the Meta dashboard with a
 * stray space or line break would otherwise never match the secret, which
 * is trimmed too. The comparison itself stays constant-time.
 */
export function verifyTokenMatches(env, supplied) {
  if (!configured(env && env.META_WEBHOOK_VERIFY_TOKEN)) return false;
  if (typeof supplied !== 'string' || supplied.trim() === '') return false;
  return timingSafeEqualStr(supplied.trim(), env.META_WEBHOOK_VERIFY_TOKEN.trim());
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 of `rawBody` (bytes) with the App Secret, as lower-case hex. */
export async function signBody(secret, rawBody) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, rawBody));
}

/**
 * Is `header` (X-Hub-Signature-256: "sha256=<hex>") Meta's signature of
 * exactly these bytes? The body must be the raw bytes as received: parsing
 * and re-serialising JSON would change them.
 */
export async function signatureValid(env, header, rawBody) {
  if (!configured(env && env.META_APP_SECRET)) return false;
  if (typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  // Trimmed like every other use of a Meta secret here: a secret saved with a
  // stray space or line break would otherwise sign with a different key and
  // refuse every genuine delivery. The App Secret itself never contains spaces.
  const expected = await signBody(env.META_APP_SECRET.trim(), rawBody);
  return timingSafeEqualStr(m[1].toLowerCase(), expected);
}

/* ---------- Send API ---------- */

/**
 * Plain-language reasons for the Send API errors staff can act on. Anything
 * else is "Facebook refused the message" with its numeric code; Meta's own
 * text is not passed through, because it can name internal details.
 */
function describeMetaError(code, subcode) {
  if (code === 10 && subcode === 2018278) return 'This customer last wrote more than 24 hours ago, so Facebook no longer allows a reply.';
  if (code === 10 || code === 200) return 'Facebook does not allow this Page to send that message (permission or messaging window).';
  if (code === 190) return 'The Facebook Page connection has expired or was revoked. An administrator needs to renew the Page access token.';
  if (code === 551) return 'This person is not available on Messenger right now.';
  if (code === 100 && subcode === 2018001) return 'Facebook could not find this customer for the Page.';
  if (code === 613 || code === 4 || code === 32) return 'Facebook is limiting how fast this Page can send. Try again in a minute.';
  return 'Facebook refused the message.';
}

/**
 * Send one text message to `psid` as the Page.
 * Resolves to { ok: true, messageId } or { ok: false, code, message, retryable }.
 * Never throws.
 */
export async function sendText(env, psid, text, metadata) {
  const cfg = metaConfig(env);
  if (!cfg.send) return { ok: false, code: 'not_configured', message: 'The Facebook Page is not connected yet.', retryable: false };
  const url = `https://graph.facebook.com/${graphVersion(env)}/${encodeURIComponent(cfg.pageId)}/messages`;
  const body = {
    recipient: { id: psid },
    // RESPONSE: a reply to a customer who wrote within the standard window.
    // No message tag is used, so nothing is sent outside Meta's rules.
    messaging_type: 'RESPONSE',
    message: { text, ...(metadata ? { metadata } : {}) },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await metaFetch(env)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN.trim()}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.ok && json && typeof json.message_id === 'string') return { ok: true, messageId: json.message_id };
    const err = (json && json.error) || {};
    const code = Number.isFinite(err.code) ? err.code : null;
    const subcode = Number.isFinite(err.error_subcode) ? err.error_subcode : null;
    console.error('Messenger Send API refused a message:', res.status, code, subcode);
    return {
      ok: false,
      code: code === null ? `http_${res.status}` : `meta_${code}${subcode ? `_${subcode}` : ''}`,
      message: describeMetaError(code, subcode),
      retryable: res.status >= 500 || code === 613 || code === 4 || code === 32 || code === 2,
    };
  } catch (err) {
    console.error('Messenger Send API unreachable:', err && err.name);
    return { ok: false, code: 'network_error', message: 'Facebook could not be reached. The message was not sent.', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The customer's name and picture, as the Page may see them. Best effort:
 * this needs the Page token and the right permission, and any failure is
 * simply "unknown" -- it never blocks saving a message.
 */
export async function fetchProfile(env, psid) {
  const cfg = metaConfig(env);
  if (!cfg.send) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const res = await metaFetch(env)(
      `https://graph.facebook.com/${graphVersion(env)}/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic`,
      { headers: { authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN.trim()}` }, signal: controller.signal }
    );
    if (!res.ok) return null;
    const p = await res.json();
    const name = [p.first_name, p.last_name].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim().slice(0, 120);
    const pic = typeof p.profile_pic === 'string' && /^https:\/\//.test(p.profile_pic) ? p.profile_pic.slice(0, 1000) : null;
    return { name: name || null, pic };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
