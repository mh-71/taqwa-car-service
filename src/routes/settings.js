/* ============================================================
   routes/settings.js — GET /api/settings   (read-only singleton)
   ------------------------------------------------------------
   The workshop's own profile: who the business is, what it prints
   on an invoice, and the two values that seed a new job card.

   ---- why this is not a collection ----

   `settings` is a singleton the SCHEMA enforces, not the app:

     id INTEGER PRIMARY KEY CHECK (id = 1)

   PRIMARY KEY plus that CHECK makes a second row physically
   impossible, so there is nothing to list, page or address. That
   rules out lib/collection.js on three counts, each of which would
   be a real failure rather than a stylistic mismatch:

     1. The factory orders by `created_at`, which this table does
        not have (its only timestamp is `updated_at`). SQLite
        answers `no such column: created_at`, so every list call
        would 500.
     2. The factory's detail route validates the id with
        readRecordId(), which requires the CUS-0001 shape. The only
        id this table can hold is the integer 1, which that
        validator rejects with a 400 -- the row would be
        unreachable through its own route.
     3. The factory returns an array plus count/total/limit/offset.
        For a table capped at one row those are noise, and every
        caller would have to write data[0].

   So the route is written out here, and index.js dispatches
   /api/settings directly, next to /api/health -- the API's other
   singleton. COLLECTIONS stays exactly what its name says: things
   that have both a list and a detail.

   ---- the API reports the row, not the app's defaults ----

   storage.js:106-125 holds a DEFAULT_SETTINGS object and
   getSettings() returns { ...DEFAULT_SETTINGS, ...stored }, so the
   browser never sees a missing field. That merge is deliberately
   NOT repeated here. Restating those fifteen defaults in the Worker
   would create a second definition of every one of them, free to
   drift from the copy the UI actually uses. This route returns what
   D1 holds; a caller that wants the app's defaults applies them the
   way the app already does.

   For the same reason a missing row is a 404, not a synthesised
   default object. `tax_rate` and `currency` do carry database
   defaults (5 and '৳'), but those are INSERT-time defaults -- by the
   time a row is read they are ordinary stored values and are
   returned as such.

   ---- theme is not here ----

   Theme lives in the browser under `taqwa_theme` and stays there.
   It is a per-device preference, and all thirteen pages read it
   from localStorage in an inline <head> script before first paint;
   an endpoint could not answer in time without reintroducing a
   flash of the wrong theme. The schema says the same at :89-90.
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase } from '../lib/http.js';

/* Explicit, never SELECT *, so a column added later cannot leak out
   of here unnoticed. `id` is excluded on purpose: it is permanently
   1, and the frontend's settings object has never carried one. */
const COLUMNS = `
  business_name, phone, email, website, tax_id, address,
  business_description, invoice_footer, payment_terms,
  tax_rate, currency, default_appointment_duration,
  opening_time, closing_time, working_days, updated_at
`;

/**
 * working_days is a JSON array in a TEXT column, e.g. ["Sat","Sun"].
 *
 * Same contract as job-cards.js parseChecklist(): a malformed value is a
 * data problem in one column, not a reason to fail the whole request, so it
 * degrades to the empty case and says so in the log. NULL and '' are the
 * ordinary "never set" state and pass quietly -- only genuinely unparseable
 * or wrongly-shaped JSON warrants a warning.
 */
function parseWorkingDays(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    console.warn('settings.working_days is JSON but not an array; returning [].');
    return [];
  } catch {
    console.warn('settings.working_days is not valid JSON; returning [].');
    return [];
  }
}

/**
 * One D1 row -> the settings object the app's UI modules already expect.
 *
 * The eight nullable text columns fall back to '' because that is what the
 * app itself stores: settings.js saves `(v.email || '').trim()` and friends,
 * so '' -- not null -- is what a row written by the app contains.
 *
 * Two coercion traps, both deliberate:
 *
 *   - `?? ''` on default_appointment_duration, never `|| ''`. The column's
 *     CHECK forbids 0 today, but `||` would silently rewrite a 0 to '' if it
 *     ever arrived, and a falsy-collapsing mapper is the kind of thing that
 *     is only ever found by the bug it causes.
 *   - tax_rate and currency are returned bare. Both are NOT NULL, so there is
 *     no null to absorb, and `taxRate || 5` would turn a deliberate 0% rate
 *     into 5% -- the API inventing a tax the shop did not set.
 */
function toRecord(row) {
  return {
    businessName: row.business_name,
    phone: row.phone,
    email: row.email ?? '',
    website: row.website ?? '',
    taxId: row.tax_id ?? '',
    address: row.address,
    businessDescription: row.business_description ?? '',
    invoiceFooter: row.invoice_footer ?? '',
    paymentTerms: row.payment_terms ?? '',
    taxRate: row.tax_rate,                    // NOT NULL; 0 stays 0
    currency: row.currency,                   // NOT NULL; '' stays ''
    defaultAppointmentDuration: row.default_appointment_duration ?? '',
    openingTime: row.opening_time ?? '',
    closingTime: row.closing_time ?? '',
    workingDays: parseWorkingDays(row.working_days),
    // Omitted rather than null until first updated, matching every other route.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * GET /api/settings
 *
 * One query, whether the row is there or not. `id = 1` is a literal rather
 * than a bound parameter because nothing from the request reaches this SQL --
 * there is no path segment, no filter and no query string to bind.
 */
export async function getSettings(request, env) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  try {
    const row = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM settings
        WHERE id = 1
        LIMIT 1`
    ).first();

    // No row yet is the ordinary state of a fresh database: nothing seeds
    // settings, so it exists only once the shop has saved it. A 404 says
    // exactly that. Defaulting a row into place here would make a GET write.
    if (!row) return fail('not_found', 'No settings have been saved.', 404);

    return ok(toRecord(row));
  } catch (err) {
    console.error('GET /api/settings failed:', err);
    return fail('database_error', 'Could not read settings.', 500);
  }
}
