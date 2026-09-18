/* ============================================================
   write.js — the shared foundation every write route builds on
   ------------------------------------------------------------
   Five small concerns, deliberately in ONE file: a write route
   imports from here and from http.js, and nowhere else.

     1. readJsonBody()   — parse and reject a request body
     2. readString/Number/Enum/Date — field primitives
     3. nowIso() / todayInDhaka()  — the two different timestamps
     4. allocateId()     — the next human-readable id
     5. constraintFailure() — a D1 constraint error -> 409 / 422

   What is NOT here, on purpose:

   * No transaction wrapper. Business operations call
     env.DB.batch([...]) directly, so a reviewer can see exactly
     which statements are atomic. Verified against local D1: a
     batch whose last statement violates a PRIMARY KEY, a CHECK or
     a FOREIGN KEY rolls back every earlier statement, including an
     id_counters bump.
   * No foreign-key checking. The schema already has 26 foreign
     keys, 20 of them ON DELETE RESTRICT. Re-checking them in JS
     would be a second definition free to drift from the first.
     constraintFailure() maps the database's own answer instead.
   * No schema/DSL/ORM layer, and no business rules. Every
     validator here is a pure function of its arguments and touches
     no database, so a rule like "a job card must be Completed
     before invoicing" cannot hide inside one.

   Every validator returns { value } or { error }, the same shape
   http.js's readRecordId() and readIntParam() already use.
   ============================================================ */

import { conflict, unprocessable } from './http.js';

/* ---------------------------------------------------------------
   1. Request body
   --------------------------------------------------------------- */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB; the largest real record is a
                                    // job card with its line items.

/**
 * Parse a JSON request body into a plain object.
 *
 * Rejects everything that is not a JSON object: an empty body, malformed
 * JSON, and the valid-JSON-but-wrong-shape cases (null, array, string,
 * number, boolean). A route can then trust that it received an object
 * without re-checking.
 *
 * Returns { value } or { error } — the caller turns an error into a 400,
 * because a body that will not parse is a malformed request, not a field
 * with a bad value.
 */
export async function readJsonBody(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: 'Could not read the request body.' };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { error: 'A JSON object body is required.' };
  }
  if (raw.length > MAX_BODY_BYTES) {
    return { error: 'Request body is too large.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Request body is not valid JSON.' };
  }

  // typeof null === 'object', and an array is an object too.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Request body must be a JSON object.' };
  }
  return { value: parsed };
}

/* ---------------------------------------------------------------
   2. Field primitives
   --------------------------------------------------------------- */

/**
 * A trimmed string.
 *
 * `required: true`  — absent, null, or blank-after-trim is an error.
 * `required: false` — absent or null yields `fallback` (default ''), which
 *                     is what the app itself stores: settings.js and
 *                     expenses.js both save `(v.x || '').trim()`.
 *
 * Trimming matches every frontend validate(): they all call .trim() before
 * storing, so `'  '` is blank here exactly as it is there.
 */
export function readString(body, field, { required = false, max = 500, fallback = '' } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    return required ? { error: `\`${field}\` is required.` } : { value: fallback };
  }
  if (typeof raw !== 'string') {
    return { error: `\`${field}\` must be a string.` };
  }
  const trimmed = raw.trim();
  if (required && trimmed === '') {
    return { error: `\`${field}\` cannot be blank.` };
  }
  if (trimmed.length > max) {
    return { error: `\`${field}\` must be ${max} characters or fewer.` };
  }
  return { value: trimmed };
}

/**
 * A finite number.
 *
 * Zero is a value, never "missing": tax_rate 0, price 0 and a 0 stock level
 * are all legitimate and must survive. That is why the absence check is
 * `undefined || null` and never a falsy test, and why `fallback` defaults to
 * null rather than 0 — nullable numeric columns (mechanics.salary,
 * parts.reorder_qty, inventory_transactions.unit_cost) distinguish the two.
 *
 * A numeric string is accepted and coerced, because HTML number inputs
 * produce strings and the frontend already does `Number(v.taxRate)`. A blank
 * string is treated as absent, matching `v.x === '' ? '' : Number(v.x)` in
 * settings.js.
 */
export function readNumber(body, field, { required = false, min = null, max = null, integer = false, fallback = null } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return required ? { error: `\`${field}\` is required.` } : { value: fallback };
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { error: `\`${field}\` must be a number.` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { error: `\`${field}\` must be a number.` };
  }
  if (integer && !Number.isInteger(n)) {
    return { error: `\`${field}\` must be a whole number.` };
  }
  if (min !== null && n < min) {
    return { error: `\`${field}\` must be at least ${min}.` };
  }
  if (max !== null && n > max) {
    return { error: `\`${field}\` must be at most ${max}.` };
  }
  return { value: n };
}

/**
 * One of a fixed set of strings.
 *
 * The allowed list always comes from the caller, never from a table here:
 * the sets live in the schema's CHECK constraints and in the frontend's own
 * arrays, and this helper must not become a third copy of them.
 *
 * Matching is exact and case-sensitive. 'active' is not 'Active' — the
 * schema's CHECKs are case-sensitive too, so accepting a loose match here
 * would only produce a 500 from the database one statement later.
 */
export function readEnum(body, field, allowed, { required = false, fallback = null } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return required ? { error: `\`${field}\` is required.` } : { value: fallback };
  }
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    return { error: `\`${field}\` must be one of: ${allowed.join(', ')}.` };
  }
  return { value: raw };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, as 'YYYY-MM-DD'.
 *
 * Passed through as text, never parsed into a Date and re-formatted. These
 * columns hold the WORKSHOP'S local calendar day (Asia/Dhaka); routing one
 * through `new Date(...)` in a UTC Worker and back out is precisely the
 * round trip audit Finding 2 recorded, and it would shift the day for any
 * date written between midnight and 06:00 local.
 *
 * The range check rejects an impossible day (2026-02-31) without ever
 * constructing a local Date: the components are compared against a UTC Date
 * built from the same numbers, which has no timezone of its own.
 */
export function readDate(body, field, { required = false, fallback = '' } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return required ? { error: `\`${field}\` is required.` } : { value: fallback };
  }
  if (typeof raw !== 'string' || !DATE_ONLY.test(raw)) {
    return { error: `\`${field}\` must be a date in YYYY-MM-DD form.` };
  }
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return { error: `\`${field}\` is not a real calendar date.` };
  }
  return { value: raw };
}

/* ---------------------------------------------------------------
   3. The two timestamps
   --------------------------------------------------------------- */

/**
 * An instant, for `created_at` / `updated_at`.
 *
 * Full ISO-8601 in UTC, exactly what storage.js writes
 * (`new Date().toISOString()`), so a row written by the API is
 * indistinguishable from one written by the browser.
 */
export function nowIso() {
  return new Date().toISOString();
}

const DHAKA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's calendar day in the workshop's timezone, as 'YYYY-MM-DD'.
 *
 * This is the Worker's equivalent of Utils.todayStr(), which reads the
 * BROWSER's local calendar (utils.js:39-48) -- in the shop, Asia/Dhaka. A
 * Worker has no browser locale and runs in UTC, so the zone must be named
 * explicitly.
 *
 * NEVER use `new Date().toISOString().slice(0, 10)` for one of these
 * columns. Verified in workerd: at 2026-03-15T20:30:00Z the Dhaka calendar
 * already reads 2026-03-16, while toISOString() still says 2026-03-15. That
 * off-by-one-day for every write between midnight and 06:00 local IS audit
 * Finding 2, and `date` columns in this schema are documented as local
 * (0001_initial_schema.sql:41-46).
 *
 * 'en-CA' is used only because it formats as YYYY-MM-DD; Intl is given the
 * zone, so this follows any future change to Bangladesh's offset rather than
 * hard-coding +06:00.
 */
export function todayInDhaka(at = new Date()) {
  return DHAKA_DATE.format(at);
}

/* ---------------------------------------------------------------
   4. Id allocation
   --------------------------------------------------------------- */

/**
 * Allocate the next human-readable id for a collection, e.g. 'CUS-0001'.
 *
 * `id_counters` is the schema's replacement for storage.js's `counters` map,
 * and the prefixes stored in it are the same eleven the app already uses. The
 * collection key is storage.js's name ('jobCards', not 'job_cards'), because
 * that is what the table holds.
 *
 * The bump and the read are ONE statement -- `UPDATE ... RETURNING` -- so two
 * concurrent requests can never be handed the same number. Verified against
 * local D1: ten parallel allocations returned ten distinct, contiguous
 * values. A read-then-write pair would not have held.
 *
 * Format matches storage.js:97-100 exactly: the counter padded to four
 * digits, and longer once it passes 9999.
 *
 * GAPS: this allocates in its own statement, so if the caller's insert then
 * fails, the number is spent and the sequence skips it. That matches the
 * behaviour the app already has (generateId() writes the counter before the
 * record is stored) and costs nothing but a missing number. A caller that
 * needs no gaps can instead put the bump in the same env.DB.batch() as its
 * insert and derive the id in SQL -- verified: a failed batch rolls the
 * counter back too.
 *
 * Returns { id, prefix, value } or { error } (an unknown collection).
 */
export async function allocateId(env, collection) {
  const row = await env.DB.prepare(
    `UPDATE id_counters
        SET last_value = last_value + 1
      WHERE collection = ?1
      RETURNING last_value, prefix`
  )
    .bind(collection)
    .first();

  // No row means the collection has no counter. That is a programming error
  // in the route, not something a request can cause, so it is reported
  // rather than silently invented.
  if (!row) return { error: `No id counter for collection \`${collection}\`.` };

  return {
    id: `${row.prefix}-${String(row.last_value).padStart(4, '0')}`,
    prefix: row.prefix,
    value: row.last_value,
  };
}

/* ---------------------------------------------------------------
   5. Constraint errors
   --------------------------------------------------------------- */

/**
 * Turn a D1 constraint error into the right HTTP response, or null if the
 * error is not a constraint failure and the caller should 500 instead.
 *
 * The four messages below were captured from local D1 (wrangler 3.114.17),
 * not guessed:
 *
 *   D1_ERROR: UNIQUE constraint failed: services.id: SQLITE_CONSTRAINT
 *   D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
 *   D1_ERROR: CHECK constraint failed: price >= 0: SQLITE_CONSTRAINT
 *   D1_ERROR: NOT NULL constraint failed: services.name: SQLITE_CONSTRAINT
 *
 * UNIQUE and FOREIGN KEY are 409: the request is well formed and its values
 * are usable, but the data's current state forbids it -- a duplicate
 * registration number, or a reference to a row that is gone. CHECK and NOT
 * NULL are 422: a field's value is wrong, which a corrected request could fix.
 *
 * The raw SQLite text is never returned; it names tables and columns.
 */
export function constraintFailure(err) {
  const message = String((err && err.message) || err || '');

  if (/UNIQUE constraint failed/i.test(message)) {
    return conflict('That value is already used by another record.');
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return conflict('A record this refers to does not exist, or is still in use.');
  }
  if (/CHECK constraint failed/i.test(message)) {
    return unprocessable('A field value is outside what this record allows.');
  }
  if (/NOT NULL constraint failed/i.test(message)) {
    return unprocessable('A required field was missing.');
  }
  return null;
}
