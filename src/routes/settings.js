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

import { ok, fail, methodNotAllowed, noDatabase, unprocessable } from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, nowIso, constraintFailure,
} from '../lib/write.js';

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

/* ============================================================
   C-9 — the write half
   ------------------------------------------------------------
   PUT /api/settings, the one write this singleton takes.

   A port of settings.js's validateSettings() (:50-75) and
   saveSettingsForm() (:84-105), stored through the same contract
   Storage.saveSettings() has: a MERGE.

     saveSettings(s) => write('settings', { ...getSettings(), ...s })

   so a field the caller does not send keeps the value it had. The
   settings form happens to send all fifteen every time, which is
   why a full object works too -- but merge is the contract, and a
   partial one is what it promises.

   ---- three things this must not do ----

   1. IT MUST NOT APPLY THE BROWSER'S DEFAULTS. getSettings() layers
      DEFAULT_SETTINGS (storage.js:106-127) under whatever is stored,
      so the browser never sees a missing field. Those are the
      BROWSER's defaults, not the database's: writing them here would
      invent a shop's phone number and address. The columns' own
      defaults -- tax_rate 5 and currency '৳' -- are the database's
      and are the only ones that apply.

   2. IT MUST NOT TOUCH THE THEME. It is a per-device preference in
      localStorage, read before first paint by every page, and the
      read route explains at length why it stays there. `theme` is
      refused by name rather than ignored.

   3. IT MUST NOT REACH ANY OTHER TABLE. Settings is presentation
      and defaults; saveSettingsForm()'s own comment says it "never
      touches any historical business record". Neither does this.
   ============================================================ */

/* :37 — the seven days, in the order the form lists them. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* :41-43 — the three format checks, each of which passes a blank value. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_ABSOLUTE = /^https?:\/\/.+/i;
const URL_BARE = /^[\w.-]+\.[a-z]{2,}.*$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Fields the server owns, or that do not live here at all. Refused by name
 * rather than ignored, so a caller is told which rule it met.
 */
const SERVER_OWNED = {
  id: '`id` is permanently 1 and is not a field of the settings object.',
  updatedAt: '`updatedAt` is set by the server.',
  theme: '`theme` is a per-device preference and is not stored on the server.',
};

/**
 * The columns a PUT may write, and the camelCase key each answers to.
 *
 * Exactly the fifteen saveSettingsForm() writes (:87-104) -- no more, so a
 * column added to the table later cannot be set by accident, and no fewer,
 * so nothing the form collects is quietly dropped.
 */
const WRITABLE = [
  ['business_name', 'businessName'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['website', 'website'],
  ['tax_id', 'taxId'],
  ['address', 'address'],
  ['business_description', 'businessDescription'],
  ['invoice_footer', 'invoiceFooter'],
  ['payment_terms', 'paymentTerms'],
  ['tax_rate', 'taxRate'],
  ['currency', 'currency'],
  ['default_appointment_duration', 'defaultAppointmentDuration'],
  ['opening_time', 'openingTime'],
  ['closing_time', 'closingTime'],
  ['working_days', 'workingDays'],
];

/** The three columns a row cannot exist without — the schema's NOT NULL set. */
const REQUIRED_TO_CREATE = [
  ['business_name', 'businessName'],
  ['phone', 'phone'],
  ['address', 'address'],
];

/**
 * Read the fields a request supplied, as columns.
 *
 * Only keys that are PRESENT are collected: that is the merge. Each one is
 * read with the same primitive the rest of the API uses, and the arbitrary
 * prose fields are left arbitrary -- settings.js stores
 * `(v.businessDescription || '').trim()` and imposes no shape on it, so
 * neither does this.
 *
 * Returns { values, errors } keyed by column and by camelCase key.
 */
function readSettingsFields(body) {
  const values = {};
  const errors = {};
  const take = (column, key, result) => {
    if (body[key] === undefined) return;          // merge: untouched
    if (result.error) { errors[key] = result.error; return; }
    values[column] = result.value;
  };

  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (body[key] !== undefined) errors[key] = message;
  }

  // The eleven text fields. settings.js trims every one of them on save.
  take('business_name', 'businessName', readString(body, 'businessName', { max: 160 }));
  take('phone', 'phone', readString(body, 'phone', { max: 40 }));
  take('email', 'email', readString(body, 'email', { max: 160 }));
  take('website', 'website', readString(body, 'website', { max: 200 }));
  take('tax_id', 'taxId', readString(body, 'taxId', { max: 60 }));
  take('address', 'address', readString(body, 'address', { max: 500 }));
  take('business_description', 'businessDescription', readString(body, 'businessDescription', { max: 2000 }));
  take('invoice_footer', 'invoiceFooter', readString(body, 'invoiceFooter', { max: 2000 }));
  take('payment_terms', 'paymentTerms', readString(body, 'paymentTerms', { max: 2000 }));
  // A loose bound only: the five-character rule is validateSettings()'s
  // (:58) and is applied below, in the client's own words.
  take('currency', 'currency', readString(body, 'currency', { max: 50 }));
  take('opening_time', 'openingTime', readString(body, 'openingTime', { max: 5 }));
  take('closing_time', 'closingTime', readString(body, 'closingTime', { max: 5 }));

  // :59-61 — a number, and between 0 and 100. The column's CHECK says the
  // same. A blank or absent value is an error rather than a fallback,
  // because tax_rate is NOT NULL and the form always sends it.
  take('tax_rate', 'taxRate', readNumber(body, 'taxRate', { min: 0, max: 100 }));
  if (body.taxRate !== undefined && values.tax_rate === null) {
    errors.taxRate = 'Tax rate must be a number.';
    delete values.tax_rate;
  }

  // :63-66 — '' means "not recorded" and is the column's NULL; anything else
  // must be a positive number of minutes.
  // No `min` here either: :64-65 words it as "a positive number of minutes",
  // and a machine-generated "must be at least 0" would say something else.
  take('default_appointment_duration', 'defaultAppointmentDuration',
    readNumber(body, 'defaultAppointmentDuration', {}));
  if (values.default_appointment_duration !== undefined
      && values.default_appointment_duration !== null
      && !(values.default_appointment_duration > 0)) {
    errors.defaultAppointmentDuration = 'Duration must be a positive number of minutes.';
    delete values.default_appointment_duration;
  }

  // The working days, stored as a JSON array. readForm() (:118) can only
  // produce members of WEEKDAYS, so anything else is refused rather than
  // quietly kept -- the read route already has to cope with malformed data
  // that predates this endpoint, and this is what stops more of it arriving.
  // The ORDER a caller sends is kept: it round-trips exactly as given.
  if (body.workingDays !== undefined) {
    const raw = body.workingDays;
    if (!Array.isArray(raw)) {
      errors.workingDays = '`workingDays` must be an array.';
    } else if (raw.length > WEEKDAYS.length) {
      errors.workingDays = '`workingDays` cannot list more than seven days.';
    } else if (raw.some((d) => typeof d !== 'string' || !WEEKDAYS.includes(d))) {
      errors.workingDays = `\`workingDays\` may only contain: ${WEEKDAYS.join(', ')}.`;
    } else if (new Set(raw).size !== raw.length) {
      errors.workingDays = '`workingDays` cannot list the same day twice.';
    } else {
      values.working_days = JSON.stringify(raw);
    }
  }

  return { values, errors };
}

/**
 * The rules that need the whole record rather than one field, applied to the
 * settings as they will be AFTER the write — the supplied fields merged over
 * what is stored. Judging the patch alone would let a request that changes
 * only the closing time slip past the opening-time comparison.
 */
function checkSettings(merged) {
  const errors = {};
  // A field the merged record does not carry at all is ABSENT, not blank.
  // That happens only on a first save, where the three NOT NULL columns are
  // required separately (with a message that says so) and every other column
  // takes the DATABASE's default -- tax_rate 5 and currency '৳'. Treating
  // absent as blank here would demand a currency the schema already supplies.
  const absent = (v) => v === undefined;
  const blank = (v) => v === null || String(v).trim() === '';
  const blankIfPresent = (v) => !absent(v) && blank(v);

  // :52-54 — the three the shop cannot be without.
  if (blankIfPresent(merged.business_name)) errors.businessName = 'Business name is required.';
  if (blankIfPresent(merged.address)) errors.address = 'Address is required.';
  if (blankIfPresent(merged.phone)) errors.phone = 'Phone is required.';

  // :55-56 — each passes when blank, and only then.
  const set = (v) => !absent(v) && !blank(v);

  if (set(merged.email) && !EMAIL.test(merged.email)) {
    errors.email = 'Enter a valid email address, or leave it blank.';
  }
  if (set(merged.website)
      && !URL_ABSOLUTE.test(merged.website) && !URL_BARE.test(merged.website)) {
    errors.website = 'Enter a valid website (e.g. https://example.com), or leave it blank.';
  }

  // :57-58 — required, and short.
  if (blankIfPresent(merged.currency)) errors.currency = 'Currency symbol is required.';
  else if (set(merged.currency) && String(merged.currency).trim().length > 5) {
    errors.currency = 'Currency symbol should be short (max 5 characters).';
  }

  // :67-68
  if (set(merged.opening_time) && !TIME.test(merged.opening_time)) {
    errors.openingTime = 'Enter a valid time (HH:MM).';
  }
  if (set(merged.closing_time) && !TIME.test(merged.closing_time)) {
    errors.closingTime = 'Enter a valid time (HH:MM).';
  }
  // :69-71 — compared as text, which is exactly what the client does: HH:MM
  // sorts correctly as a string, so no Date is involved.
  if (set(merged.opening_time) && set(merged.closing_time)
      && TIME.test(merged.opening_time) && TIME.test(merged.closing_time)
      && merged.closing_time <= merged.opening_time) {
    errors.closingTime = 'Closing time should be after opening time.';
  }

  return errors;
}

/**
 * PUT /api/settings
 *
 * Merge the supplied fields into the singleton, or create it if the shop has
 * never saved its settings. Storage.saveSettings() does both: it writes
 * `{ ...stored, ...supplied }` to a key that may not exist yet.
 *
 * Creating it needs the three columns the schema marks NOT NULL, which is
 * also the three validateSettings() calls required. Everything else a create
 * leaves unset stays NULL, or takes the COLUMN's default -- tax_rate 5 and
 * currency '৳' -- and never the browser's.
 *
 * One statement. `ON CONFLICT(id) DO UPDATE` makes create-or-merge a single
 * write, so two requests arriving at an empty database cannot both insert,
 * and a merge can never leave the row half-written.
 */
export async function updateSettings(request, env) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);

  const { values, errors } = readSettingsFields(body.value);
  if (Object.keys(errors).length) {
    return unprocessable('Some settings fields are not valid.', errors);
  }
  if (Object.keys(values).length === 0) {
    return unprocessable('No settings fields were supplied to update.');
  }

  let stored;
  try {
    stored = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM settings WHERE id = 1 LIMIT 1`
    ).first();
  } catch (err) {
    console.error('PUT /api/settings could not read the current settings:', err);
    return fail('database_error', 'Could not update settings.', 500);
  }

  // The merged record, as columns, for the cross-field rules.
  const current = stored ? {
    business_name: stored.business_name, phone: stored.phone, email: stored.email,
    website: stored.website, currency: stored.currency,
    opening_time: stored.opening_time, closing_time: stored.closing_time,
    address: stored.address,
  } : {};
  const merged = { ...current, ...values };

  const crossField = checkSettings(merged);
  if (Object.keys(crossField).length) {
    return unprocessable('Some settings fields are not valid.', crossField);
  }

  // A row that does not exist yet has to be created whole enough to satisfy
  // the schema. Saying which fields are missing is more use than letting
  // NOT NULL answer for them.
  if (!stored) {
    const missing = {};
    for (const [column, key] of REQUIRED_TO_CREATE) {
      if (values[column] === undefined) {
        missing[key] = `\`${key}\` is required the first time settings are saved.`;
      }
    }
    if (Object.keys(missing).length) {
      return unprocessable(
        'No settings have been saved yet, so these are required.', missing
      );
    }
  }

  const at = nowIso();
  const columns = [...Object.keys(values), 'updated_at'];
  const binds = [...columns.slice(0, -1).map((c) => values[c]), at];

  // Two statements, one of which runs. They are not interchangeable, and
  // real D1 is what proved it: an UPSERT evaluates its INSERT first, and
  // ON CONFLICT handles only a UNIQUENESS conflict -- so `INSERT INTO
  // settings (id, tax_rate, updated_at)` aborts on business_name's NOT NULL
  // before the DO UPDATE is ever reached. A merge therefore has to BE an
  // UPDATE.
  const sql = stored
    ? `UPDATE settings
          SET ${columns.map((c, i) => `${c} = ?${i + 1}`).join(', ')}
        WHERE id = 1
    RETURNING ${COLUMNS}`
    // The create path carries the NOT NULL columns by definition -- they were
    // required above -- so its INSERT is valid, and ON CONFLICT is there only
    // for the race where two first saves arrive at once: the loser merges
    // rather than failing.
    : `INSERT INTO settings (id, ${columns.join(', ')})
            VALUES (1, ${columns.map((_, i) => `?${i + 1}`).join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}
         RETURNING ${COLUMNS}`;

  try {
    const row = await env.DB.prepare(sql).bind(...binds).first();

    if (!row) {
      console.error('PUT /api/settings wrote no row.');
      return fail('database_error', 'Could not update settings.', 500);
    }
    return ok(toRecord(row));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/settings failed:', err);
    return fail('database_error', 'Could not update settings.', 500);
  }
}
