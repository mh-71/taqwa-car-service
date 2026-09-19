/* ============================================================
   http.js — shared response helpers for the Worker API
   ------------------------------------------------------------
   One response shape for the whole API, so clients never have to
   guess:

     success  { "data": ..., "count": n }
     failure  { "error": { "code": "...", "message": "..." } }

   Errors carry a stable machine-readable `code` alongside the
   human message, so callers can branch on the code rather than
   parsing prose.
   ============================================================ */

/**
 * Headers every API response carries, and why each one.
 *
 * cache-control: no-store
 *   THE IMPORTANT ONE. An authenticated GET here returns customer names,
 *   phone numbers, addresses and the financial ledger. Without this, that
 *   JSON is a cacheable 200: the browser's own HTTP cache may keep it after
 *   sign-out, and any intermediary is free to store it too. js/api.js asks
 *   for `cache: 'no-store'` on its own requests, but that governs one client;
 *   the server has to be the one that says it.
 *
 * x-content-type-options: nosniff
 *   Stops a browser deciding for itself that a JSON body is really HTML or a
 *   script, which is how a reflected value in an API response becomes
 *   executable.
 *
 * referrer-policy: no-referrer
 *   A record id in a path is business data. Nothing downstream needs to know
 *   which one was being read.
 *
 * x-frame-options / frame-ancestors
 *   Nothing here is meant to be embedded. Both are set because the header
 *   and the CSP directive are honoured by different browsers.
 */
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  ...SECURITY_HEADERS,
};

export { SECURITY_HEADERS };

/** Success response. `meta` merges extra top-level fields (count, limit, ...). */
export function ok(data, meta = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...meta }, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

/** Error response. Never leaks a raw SQL string or stack trace to the client. */
export function fail(code, message, status = 500, extra = {}) {
  return new Response(
    JSON.stringify({ error: { code, message, ...extra } }, null, 2),
    { status, headers: JSON_HEADERS }
  );
}

export const notFound = (available) =>
  fail('not_found', 'No such endpoint.', 404, available ? { available } : {});

export const methodNotAllowed = (allowed) =>
  new Response(
    JSON.stringify(
      { error: { code: 'method_not_allowed', message: `Allowed: ${allowed.join(', ')}` } },
      null,
      2
    ),
    { status: 405, headers: { ...JSON_HEADERS, allow: allowed.join(', ') } }
  );

export const noDatabase = () =>
  fail('no_database', 'No D1 binding named DB. Check wrangler.jsonc.', 503);

/**
 * 409 — the request was understood and its fields are fine, but the current
 * state of the data forbids it: deleting a customer who still has vehicles,
 * invoicing a job card that already has a live invoice, a duplicate
 * registration number. These are the rules the frontend's delete guards and
 * the schema's constraints already enforce; this is how the API reports them.
 *
 * `extra` carries machine-readable context (e.g. { conflictsWith: 'VEH-0003' })
 * so a caller can branch without parsing the message.
 */
export const conflict = (message, extra = {}) =>
  fail('conflict', message, 409, extra);

/**
 * 422 — the request parsed and its shape is right, but a field's VALUE is not
 * usable: a negative price, a status outside the allowed set, a malformed
 * date. Kept distinct from 400, which stays what it has always meant here --
 * the request itself was malformed (bad JSON, an unparseable id, a limit that
 * is not a number).
 *
 * `fields` maps field name -> reason, mirroring the shape the frontend's own
 * validate() functions already return, so a form can highlight the offending
 * inputs directly.
 */
export const unprocessable = (message, fields = null) =>
  fail('unprocessable', message, 422, fields ? { fields } : {});

/**
 * Validate a record id taken from the URL path.
 *
 * The app's ids are human-readable and prefixed (CUS-0001, JOB-0007), so the
 * shape is checkable: letters, a hyphen, digits. Anything else — an empty
 * segment, a quote, a semicolon, a path traversal — is rejected before it
 * reaches the database.
 *
 * Deliberately NOT prefix-specific: `VEH-0001` on a customers route is a
 * well-formed id that simply does not exist there, which is a 404, not a 400.
 * Only genuinely malformed input is a 400.
 *
 * Returns { value } or { error }.
 */
const RECORD_ID = /^[A-Za-z]{2,5}-\d{1,10}$/;
const MAX_ID_LENGTH = 32;

export function readRecordId(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { error: 'A record id is required.' };
  }
  if (raw.length > MAX_ID_LENGTH) {
    return { error: 'Record id is too long.' };
  }
  if (!RECORD_ID.test(raw)) {
    return { error: 'Record id must look like CUS-0001.' };
  }
  return { value: raw };
}

/**
 * Read a bounded non-negative integer from the query string.
 * Returns { value } or { error } — never throws, never trusts the input.
 */
export function readIntParam(url, name, { def, min, max }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return { value: def };
  if (!/^\d+$/.test(raw)) {
    return { error: `\`${name}\` must be a whole number.` };
  }
  const n = Number(raw);
  if (n < min || n > max) {
    return { error: `\`${name}\` must be between ${min} and ${max}.` };
  }
  return { value: n };
}
