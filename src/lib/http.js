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

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

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
