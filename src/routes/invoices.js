/* ============================================================
   routes/invoices.js — GET /api/invoices[/:id]   (read-only)
   ------------------------------------------------------------
   The billing record. Like job cards, an invoice carries two child
   line tables, so this route is written out rather than built from
   lib/collection.js — the factory issues one fixed query per call
   and maps one row at a time, while this needs an IN-list whose
   placeholder count varies and a mapper taking a row plus two line
   sets. lib/collection.js is untouched and still serves the seven
   collections that fit it.

   ---- financial values are reported, not computed ----

   Every money column is returned exactly as stored. That includes
   paid, due and status, and it is a deliberate decision rather than
   an oversight, because the app currently holds two readings of an
   invoice's balance:

     * utils.js liveJobBalance() trusts the stored inv.paid/inv.due
       whenever the invoice is not Void;
     * reports.js computeInvoiceReport() ignores them and re-derives
       livePaid by summing the invoice's still-linked non-Void
       payments, forcing liveDue to 0 for a Void invoice.

   In normal operation the two agree, because payments.js calls
   recomputeInvoiceBalance() after every payment change and writes
   the result back to the invoice. They diverge after a void: the
   stored figures freeze at their last value while the payments are
   released to advances (invoice_id -> NULL), so the derived sum
   drops to 0.

   Choosing either reading here would make this route a third
   implementation of the same question, and would bury a real
   difference in stored state behind an API opinion. So the route
   reports the row. A caller that wants the derived view must ask
   the payments collection for it. Nothing here queries or joins
   payments, and no livePaid, liveDue or balance field is invented.

   ---- lines are snapshots ----

   invoice_services and invoice_parts hold what was billed:
   name, part_no and unit_price as they stood when the invoice was
   raised. They are copies of the job card's own already-frozen
   lines (invoices.js: createInvoiceFromJobCard maps them across
   unchanged), so the services and parts catalogues are never
   queried and nothing is refreshed from them. A part line with
   part_id NULL is a manual line and stays one.

   ---- relationships stay as ids ----

   jobCardId, customerId and vehicleId are returned as ids. The UI
   resolves names at render time (custName(i.customerId),
   vehText(i.vehicleId)); embedding them here would duplicate data
   that goes stale the moment a customer is renamed.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
  conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * How many invoice ids go into one `WHERE invoice_id IN (...)` query.
 *
 * SQLite's SQLITE_MAX_VARIABLE_NUMBER defaults to 999 and a page can ask for up
 * to MAX_LIMIT rows, so one unbounded IN-list would overflow it at the top of
 * the range. Chunking is the guarantee, not a probe: 500 sits well inside the
 * ceiling and costs at most two chunks per child table even for limit=1000.
 *
 * The only thing assembled into the SQL text is the placeholder run
 * (`?1, ?2, ...`), whose length comes from the size of this chunk — a number
 * this module computed from rows the database returned, never from a request.
 * Every id itself goes through .bind().
 */
const ID_CHUNK = 500;

const PARENT_COLUMNS = `
  id, job_card_id, customer_id, vehicle_id, date,
  labour_cost, discount, tax_rate, subtotal, tax, total, paid, due,
  status, notes, created_at, updated_at
`;

// Child rows carry invoice_id so a batched result can be grouped by parent.
// The surrogate `id` and `line_no` are read for ordering but never returned:
// the app's invoice records have never had them (seed-data.js), so exposing
// them would invent a shape the UI does not use.
const SERVICE_COLUMNS = `invoice_id, service_id, name, qty, unit_price, total`;
const PART_COLUMNS = `invoice_id, part_id, name, part_no, qty, unit_price, total`;

// line_no carries no uniqueness constraint, so the surrogate id breaks ties and
// keeps two lines sharing a line_no in the same order across requests.
const LINE_ORDER = `ORDER BY invoice_id, line_no, id`;

/** One invoice_services row -> the line shape the UI already reads. */
function toServiceLine(row) {
  return {
    serviceId: row.service_id ?? null,
    name: row.name,               // snapshot — never the catalogue's current name
    qty: row.qty,
    unitPrice: row.unit_price,    // snapshot — never the catalogue's current price
    total: row.total,
  };
}

/**
 * One invoice_parts row -> the line shape the UI already reads.
 *
 * part_id NULL is a manual line: a part written in by hand with no inventory
 * record behind it. It keeps its own name, part number and price, and nothing
 * here promotes it into a catalogue part.
 */
function toPartLine(row) {
  return {
    partId: row.part_id ?? null,
    name: row.name,               // snapshot
    partNo: row.part_no ?? '',    // snapshot
    qty: row.qty,
    unitPrice: row.unit_price,    // snapshot
    total: row.total,
  };
}

/**
 * One invoices row plus its lines -> the record shape the UI already expects.
 *
 * The field is `partsUsed`, not `parts`: that is what invoices.js reads
 * (:547, :550, :625, :629) and what seed-data.js stores, and renaming it would
 * break the UI the moment storage.js starts calling this route.
 *
 * Every money column is NOT NULL, so a 0 is a real figure rather than an
 * unrecorded one. `notes` is the only nullable text and falls back to '';
 * `job_card_id` is the only nullable reference and stays null, which is also
 * the state a voided invoice's job card link is left in.
 */
function toRecord(row, services, partsUsed) {
  return {
    id: row.id,
    jobCardId: row.job_card_id ?? null,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,

    date: row.date,                 // local calendar day, verbatim — no Date, no UTC

    labourCost: row.labour_cost,
    discount: row.discount,
    taxRate: row.tax_rate,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paid: row.paid,                 // stored, never derived from payments
    due: row.due,                   // stored, never derived from payments
    status: row.status,             // stored, never re-derived from paid/total

    notes: row.notes ?? '',

    services,
    partsUsed,

    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * Fetch the service and part lines for a set of invoice ids.
 *
 * Two queries per chunk of ID_CHUNK ids, so the count is bounded by the page
 * size ceiling rather than growing with it: a page of 500 costs two queries, a
 * page of 1000 costs four. Never one query per invoice.
 *
 * Returns two Maps keyed by invoice id, each holding that invoice's lines in
 * stored order.
 */
async function fetchLines(env, ids) {
  const services = new Map();
  const parts = new Map();
  if (ids.length === 0) return { services, parts };

  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    // Placeholder run only; its length is this chunk's size, and every id is bound.
    const holes = chunk.map((_, i) => `?${i + 1}`).join(', ');

    const [svcRows, partRows] = await Promise.all([
      env.DB.prepare(
        `SELECT ${SERVICE_COLUMNS}
           FROM invoice_services
          WHERE invoice_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
      env.DB.prepare(
        `SELECT ${PART_COLUMNS}
           FROM invoice_parts
          WHERE invoice_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
    ]);

    for (const r of svcRows.results ?? []) {
      if (!services.has(r.invoice_id)) services.set(r.invoice_id, []);
      services.get(r.invoice_id).push(toServiceLine(r));
    }
    for (const r of partRows.results ?? []) {
      if (!parts.has(r.invoice_id)) parts.set(r.invoice_id, []);
      parts.get(r.invoice_id).push(toPartLine(r));
    }
  }

  return { services, parts };
}

/** GET /api/invoices?limit=&offset= */
export async function listInvoices(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);

  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM invoices
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    )
      .bind(limit.value, offset.value)
      .all();

    const rows = results ?? [];
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM invoices`
    ).first();

    // An empty page asks for no lines at all.
    const { services, parts } = await fetchLines(env, rows.map((r) => r.id));

    return ok(
      rows.map((r) => toRecord(r, services.get(r.id) ?? [], parts.get(r.id) ?? [])),
      {
        count: rows.length,
        total: total ? total.n : rows.length,
        limit: limit.value,
        offset: offset.value,
      }
    );
  } catch (err) {
    // A failed line query fails the whole request: an invoice showing its
    // totals but not the lines behind them would read as complete.
    console.error('GET /api/invoices failed:', err);
    return fail('database_error', 'Could not read invoices.', 500);
  }
}

/** GET /api/invoices/:id */
export async function getInvoice(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  try {
    const row = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM invoices
        WHERE id = ?1
        LIMIT 1`
    )
      .bind(id.value)
      .first();

    // readRecordId is shape-only, not prefix-specific, so a well-formed id
    // belonging to another collection lands here as a 404, not a 400. Returning
    // before the line queries is deliberate: an id that is not an invoice must
    // cost one query, not three.
    if (!row) return fail('not_found', 'No invoice with that id.', 404);

    const { services, parts } = await fetchLines(env, [row.id]);

    return ok(toRecord(row, services.get(row.id) ?? [], parts.get(row.id) ?? []));
  } catch (err) {
    console.error('GET /api/invoices/:id failed:', err);
    return fail('database_error', 'Could not read invoice.', 500);
  }
}

/* ============================================================
   C-7 — the write half
   ------------------------------------------------------------
   POST /api/invoices, PUT /api/invoices/:id,
   POST /api/invoices/:id/void, DELETE /api/invoices/:id.

   A port of js/invoices.js. Its own header states the model this
   preserves: "an Invoice simply copies those already-correct,
   already-frozen numbers. No calculation logic is duplicated here."

   ---- the five things this route must get right ----

   1. AN INVOICE IS COPIED, NOT COMPOSED. The request names a job
      card, a date and a note -- nothing else. Every figure and both
      line sets come from the job card server-side, which is why
      there is no arithmetic here beyond the defensive floors
      createInvoiceFromJobCard() already applies (:181-186).

   2. ONE LIVE INVOICE PER JOB CARD, and the database says so:
      ux_invoices_live_job_card is a partial unique index over
      job_card_id WHERE status <> 'Void'. The eligibility check
      below explains a duplicate; the index is what prevents one.

   3. VOIDING CANCELS THE DOCUMENT, NEVER THE MONEY. This is audit
      Finding 7. Each linked ACTIVE payment keeps its amount, date,
      method and customer and is RELEASED to an advance
      (invoice_id NULL), inheriting the invoice's job card so
      Reports can still trace the collection. A payment already Void
      is left exactly as it is.

   4. A VOID INVOICE'S paid/due STAY FROZEN. They are the historical
      record of what this invoice had collected before it was
      cancelled, and the delete guard depends on them (:483).
      Reports recompute a live figure from payments and never read
      these as live (reports.js:160-170) -- that is Finding 1's
      answer, and it must keep having exactly one home.

   5. INVENTORY IS NEVER TOUCHED. Parts were issued when the job
      card issued them (C-6); an invoice bills for what already
      moved. No route here reads or writes parts or the ledger.
   ============================================================ */

/* :43-44 — the two status sets, copied. */
const ELIGIBLE_JOB_STATUSES = ['Completed', 'Delivered'];
const VOID = 'Void';

/**
 * Fields the server owns. Refused by name rather than ignored, so a caller
 * cannot believe it set a figure or a line that was actually copied from the
 * job card.
 *
 * Everything financial is here, because createInvoiceFromJobCard() takes all
 * of it from the job card (:188-199) and the module's own header calls the
 * result "already-correct, already-frozen numbers". `paid` and `due` included:
 * they are the job card's figures at the moment of invoicing, and afterwards
 * payments are what move them (C-8).
 */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  customerId: '`customerId` is copied from the job card.',
  vehicleId: '`vehicleId` is copied from the job card.',
  services: '`services` are copied from the job card.',
  partsUsed: '`partsUsed` are copied from the job card.',
  labourCost: '`labourCost` is copied from the job card.',
  discount: '`discount` is copied from the job card.',
  taxRate: '`taxRate` is copied from the job card.',
  subtotal: '`subtotal` is copied from the job card.',
  tax: '`tax` is copied from the job card.',
  total: '`total` is copied from the job card.',
  paid: '`paid` is copied from the job card, and afterwards follows its payments.',
  due: '`due` is copied from the job card, and afterwards follows its payments.',
  status: '`status` is derived from the amount paid. Use the void operation to cancel an invoice.',
};

/** :62-68 — Unpaid/Partial/Paid. Void is never derived, only set explicitly. */
function deriveStatus(total, paid) {
  const t = Number(total) || 0;
  const p = Math.max(0, Number(paid) || 0);
  if (t > 0 && p >= t) return 'Paid';
  if (p > 0) return 'Partial';
  return 'Unpaid';
}

/**
 * A request body that may legitimately be absent.
 *
 * Voiding takes no fields at all, so requiring `{}` would only be a trap for
 * a caller with nothing to send. An empty body is read as an empty object; a
 * body that IS sent still has to be a JSON object, so a typo cannot be
 * mistaken for "no fields". Everything else goes through readJsonBody().
 */
async function readOptionalBody(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: 'Could not read the request body.' };
  }
  if (raw === null || raw === undefined || raw.trim() === '') return { value: {} };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Request body is not valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Request body must be a JSON object.' };
  }
  return { value: parsed };
}

/* ---------------------------------------------------------------
   POST /api/invoices
   --------------------------------------------------------------- */

/**
 * The whole of checkEligibility() (:89-115) in one query, plus the job card's
 * own figures, so nothing is looked up twice.
 *
 * `existing_invoice_id` reproduces existingInvoiceFor() (:73-85) exactly,
 * including its asymmetry: the forward link is trusted whatever its status,
 * while the reverse lookup ignores a Void invoice so a cancelled one cannot
 * block the corrected invoice that replaces it.
 *
 * Existence of the customer and the vehicle is checked rather than left to a
 * foreign key, because the client reports them as distinct reasons and both
 * are NOT NULL columns whose FK would otherwise answer with a bare 409.
 */
async function readEligibility(env, jobCardId) {
  return env.DB.prepare(
    `SELECT j.id, j.status, j.customer_id, j.vehicle_id,
            j.actual_delivery, j.completed_at,
            j.labour_cost, j.discount, j.tax_rate,
            j.subtotal, j.tax, j.total, j.paid,
            (SELECT 1 FROM customers WHERE id = j.customer_id) AS customer_found,
            (SELECT 1 FROM vehicles  WHERE id = j.vehicle_id)  AS vehicle_found,
            CASE WHEN j.invoice_id IS NOT NULL
                 THEN (SELECT i.id FROM invoices i WHERE i.id = j.invoice_id)
                 ELSE (SELECT i.id FROM invoices i
                        WHERE i.job_card_id = j.id AND i.status <> '${VOID}'
                        LIMIT 1)
            END AS existing_invoice_id
       FROM job_cards j
      WHERE j.id = ?1`
  ).bind(jobCardId).first();
}

/**
 * The job card's two line sets, as the invoice will store them.
 *
 * `(job.services || []).map(l => ({ ...l }))` (:177-178) is a deep copy, and
 * this is the same thing across the wire: the invoice gets its own rows,
 * carrying the job card's snapshots, and never shares or re-reads them.
 */
async function readJobCardLines(env, jobCardId) {
  const [services, parts] = await Promise.all([
    env.DB.prepare(
      `SELECT service_id, name, qty, unit_price, total
         FROM job_card_services WHERE job_card_id = ?1 ORDER BY line_no, id`
    ).bind(jobCardId).all(),
    env.DB.prepare(
      `SELECT part_id, name, part_no, qty, unit_price, total
         FROM job_card_parts WHERE job_card_id = ?1 ORDER BY line_no, id`
    ).bind(jobCardId).all(),
  ]);
  return { services: services.results ?? [], parts: parts.results ?? [] };
}

/**
 * POST /api/invoices
 *
 * Create an invoice from a job card. The body names the job card, and
 * optionally the invoice date and a note; everything else is copied.
 *
 * ---- what this deliberately does not do ----
 *
 * It does not touch inventory. The job card issued its parts when it entered
 * In Progress (C-6); an invoice bills for stock that has already moved, and
 * deducting again here would take the same units out twice. Nothing in this
 * module reads or writes `parts` or `inventory_transactions`.
 *
 * It does not change the job card's status either. createInvoiceFromJobCard()
 * sets only `invoiceId` (:201), and a status move is C-6's operation with its
 * own transitions and its own inventory effects.
 */
export async function createInvoice(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }
  const jobCardId = readString(b, 'jobCardId', { required: true, max: 32 });
  if (jobCardId.error) errors.jobCardId = jobCardId.error;
  // :375 — the form offers a date and a note, and nothing else.
  const date = readDate(b, 'date', { fallback: '' });
  if (date.error) errors.date = date.error;
  const notes = readString(b, 'notes', { max: 1000 });
  if (notes.error) errors.notes = notes.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some invoice fields are not valid.', errors);
  }

  const job = await readEligibility(env, jobCardId.value);
  // :91 — the client's own wording for each refusal, in its own order.
  if (!job) {
    return fail('not_found', 'Job Card not found.', 404);
  }
  if (job.existing_invoice_id) {
    return conflict('This Job Card already has an invoice.', {
      reason: 'invoice_exists', conflictsWith: job.existing_invoice_id,
    });
  }
  if (!job.customer_found) {
    return conflict('This Job Card’s customer record no longer exists.',
      { reason: 'customer_missing' });
  }
  if (!job.vehicle_found) {
    return conflict('This Job Card’s vehicle record no longer exists.',
      { reason: 'vehicle_missing' });
  }
  if (!ELIGIBLE_JOB_STATUSES.includes(job.status)) {
    return conflict(
      `Job Card must be Completed or Delivered before invoicing (currently ${job.status}).`,
      { reason: 'job_card_not_invoiceable', status: job.status }
    );
  }
  if (!(Number(job.total) > 0)) {
    return conflict('This Job Card has no billable amount.',
      { reason: 'nothing_to_invoice', total: job.total });
  }

  const lines = await readJobCardLines(env, job.id);

  // :181-186 — defensive floors and one ceiling. job-cards.js validates all of
  // this at the source, so these never change a legitimately created invoice's
  // numbers; they only stop the financial record itself from ever storing an
  // impossible combination, which the columns' own CHECKs would refuse anyway.
  const total = Math.max(0, Number(job.total) || 0);
  const paid = Math.min(total, Math.max(0, Number(job.paid) || 0));
  const due = Math.max(total - paid, 0);

  // :192 — the supplied date, else the day it was handed over, else the day it
  // was completed, else today. completed_at is an instant, and slicing its
  // stored text is what the client does; it is a snapshot of a past moment,
  // not a reading of "now", so it is not todayInDhaka()'s business. The final
  // fallback IS "today", and that one is the workshop's calendar day.
  const invoiceDate = date.value
    || job.actual_delivery
    || (job.completed_at ? String(job.completed_at).slice(0, 10) : '')
    || todayInDhaka();

  const allocated = await allocateId(env, 'invoices');
  if (allocated.error) {
    console.error('POST /api/invoices could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not create the invoice.', 500);
  }
  const at = nowIso();

  const columns = {
    id: allocated.id,
    job_card_id: job.id,
    customer_id: job.customer_id,
    vehicle_id: job.vehicle_id,
    date: invoiceDate,
    labour_cost: Number(job.labour_cost) || 0,
    discount: Number(job.discount) || 0,
    tax_rate: Number(job.tax_rate) || 0,
    subtotal: Number(job.subtotal) || 0,
    tax: Number(job.tax) || 0,
    total,
    paid,
    due,
    status: deriveStatus(total, paid),
    notes: notes.value,
    created_at: at,
  };
  const names = Object.keys(columns);

  const statements = [
    env.DB.prepare(
      `INSERT INTO invoices (${names.join(', ')})
            VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`
    ).bind(...names.map((n) => columns[n])),
  ];
  lines.services.forEach((l, i) => {
    statements.push(env.DB.prepare(
      `INSERT INTO invoice_services
         (invoice_id, service_id, name, qty, unit_price, total, line_no)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(allocated.id, l.service_id, l.name, l.qty, l.unit_price, l.total, i + 1));
  });
  lines.parts.forEach((l, i) => {
    statements.push(env.DB.prepare(
      `INSERT INTO invoice_parts
         (invoice_id, part_id, name, part_no, qty, unit_price, total, line_no)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(allocated.id, l.part_id, l.name, l.part_no, l.qty, l.unit_price, l.total, i + 1));
  });
  // :201 — the link, unconditional exactly as the client writes it. It is in
  // the same batch because an invoice whose job card does not point back at it
  // would be invisible to every guard that reads the job card first.
  statements.push(env.DB.prepare(
    `UPDATE job_cards SET invoice_id = ?2, updated_at = ?3 WHERE id = ?1`
  ).bind(job.id, allocated.id, at));

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // ux_invoices_live_job_card is the authority on "one live invoice per job
    // card". The check above explains a duplicate; this catches the one that
    // was created between that check and this write.
    if (/UNIQUE constraint failed/i.test(String((err && err.message) || err))) {
      return conflict('This Job Card already has an invoice.', { reason: 'invoice_exists' });
    }
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoices failed:', err);
    return fail('database_error', 'Could not create the invoice.', 500);
  }

  return respondWithInvoice(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   PUT /api/invoices/:id
   --------------------------------------------------------------- */

/**
 * PUT /api/invoices/:id
 *
 * Notes, and nothing else.
 *
 * The module's header is explicit: "once created, an Invoice's financial
 * fields (services, parts, labour, discount, tax, totals) are never editable.
 * Only `notes` can be edited, and `Void` (soft-cancel) is available in place
 * of destructive edits." openNotesModal() (:392-409) is the whole edit surface
 * and writes exactly one column.
 *
 * So there is no payment-conditional edit rule to preserve: nothing financial
 * is editable whether or not payments exist, which is a stronger protection
 * than any such rule would be. A Void invoice's notes stay editable too --
 * the client applies no status check here, and a correction note on a
 * cancelled invoice is the one edit that still makes sense.
 */
export async function updateInvoice(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }
  if (b.jobCardId !== undefined) {
    errors.jobCardId = '`jobCardId` is set when the invoice is created.';
  }
  if (b.date !== undefined) {
    errors.date = '`date` is a historical figure and cannot be edited.';
  }
  const notes = readString(b, 'notes', { max: 1000 });
  if (b.notes !== undefined && notes.error) errors.notes = notes.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some invoice fields are not valid.', errors);
  }
  if (b.notes === undefined) {
    return unprocessable('No invoice fields were supplied to update. Only `notes` can be edited.');
  }

  try {
    const row = await env.DB.prepare(
      `UPDATE invoices SET notes = ?2, updated_at = ?3 WHERE id = ?1 RETURNING id`
    ).bind(id.value, notes.value, nowIso()).first();
    if (!row) return fail('not_found', 'No invoice with that id.', 404);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/invoices/:id failed:', err);
    return fail('database_error', 'Could not update the invoice.', 500);
  }

  return respondWithInvoice(env, id.value, 200);
}

/* ---------------------------------------------------------------
   POST /api/invoices/:id/void
   --------------------------------------------------------------- */

/**
 * POST /api/invoices/:id/void
 *
 * Soft-cancel an invoice. This is audit Finding 7, and voidInvoice()
 * (:187-214) is the behaviour being preserved:
 *
 *   the invoice      status becomes Void; paid and due are NOT erased, and
 *                    stay frozen as what this invoice had collected before it
 *                    was cancelled
 *   its payments     every linked ACTIVE one is RELEASED to an advance
 *                    (invoice_id NULL) and inherits the invoice's job card if
 *                    it has none of its own, so Reports can still trace the
 *                    collection to a mechanic. Amount, date, method, customer
 *                    and notes are untouched: the cash arrived, only the
 *                    document was cancelled
 *   a Void payment   left exactly as it is, invoice link included
 *   its job card     unlinked, if it still points here, so a corrected
 *                    invoice can be issued
 *
 * ---- why all three can be one statement each ----
 *
 * The status UPDATE carries `AND status <> 'Void'` and is the gate: two
 * concurrent voids cannot both match it. The payment release and the job card
 * unlink then re-read the invoice's status, so a gate that matched nothing is
 * never followed by either. And because the release is ONE statement over all
 * the linked payments rather than one per payment, a partial release is not a
 * state this can reach.
 */
export async function voidInvoice(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readOptionalBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  // Voiding takes no fields; naming one is a misunderstanding worth reporting.
  const sent = Object.keys(body.value);
  if (sent.length) {
    return unprocessable('Voiding an invoice takes no fields.',
      Object.fromEntries(sent.map((k) => [k, `\`${k}\` is not a field of the void operation.`])));
  }

  const inv = await env.DB.prepare(
    'SELECT id, status, job_card_id FROM invoices WHERE id = ?1'
  ).bind(id.value).first();
  // :189-190 — the client's own two refusals.
  if (!inv) return fail('not_found', 'Invoice not found.', 404);
  if (inv.status === VOID) {
    return conflict('Invoice is already void.', { reason: 'invoice_void', status: inv.status });
  }

  const at = nowIso();
  const statements = [
    // THE GATE.
    env.DB.prepare(
      `UPDATE invoices SET status = '${VOID}', updated_at = ?2
        WHERE id = ?1 AND status <> '${VOID}'`
    ).bind(id.value, at),
    // :202-209 — Finding 7. One statement for every linked Active payment:
    // the link is released, the job card inherited only where the payment has
    // none, and nothing else about the row is written.
    env.DB.prepare(
      `UPDATE payments
          SET invoice_id  = NULL,
              job_card_id = COALESCE(job_card_id, ?2),
              updated_at  = ?3
        WHERE invoice_id = ?1
          AND status <> '${VOID}'
          AND (SELECT status FROM invoices WHERE id = ?1) = '${VOID}'`
    ).bind(id.value, inv.job_card_id, at),
  ];
  // :210-215 — and the job card goes back to being un-invoiced, but only if it
  // still points at THIS invoice.
  if (inv.job_card_id) {
    statements.push(env.DB.prepare(
      `UPDATE job_cards SET invoice_id = NULL, updated_at = ?3
        WHERE id = ?2 AND invoice_id = ?1
          AND (SELECT status FROM invoices WHERE id = ?1) = '${VOID}'`
    ).bind(id.value, inv.job_card_id, at));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoices/:id/void failed:', err);
    return fail('database_error', 'Could not void the invoice.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict('This invoice was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' });
  }

  return respondWithInvoice(env, id.value, 200, {
    released: results[1]?.meta?.changes ?? 0,
  });
}

/* ---------------------------------------------------------------
   DELETE /api/invoices/:id
   --------------------------------------------------------------- */

/**
 * DELETE /api/invoices/:id
 *
 * openDeleteModal() (:472-505) allows this in exactly one case: a Void invoice
 * that never collected anything. An active invoice is a live financial record
 * and must be voided first; a Void one that did collect is kept for the audit
 * trail, which is the frozen `paid` those figures exist for.
 *
 * The child lines are ON DELETE CASCADE and need no statement. A payment still
 * pointing here is a RESTRICT foreign key, so it raises rather than orphaning
 * a row -- which is the one guard the browser cannot have, and it only ever
 * fires for a VOID payment, since voiding released every Active one.
 */
export async function deleteInvoice(request, env, rawId) {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const inv = await env.DB.prepare(
    'SELECT id, status, paid, job_card_id FROM invoices WHERE id = ?1'
  ).bind(id.value).first();
  if (!inv) return fail('not_found', 'No invoice with that id.', 404);

  if (inv.status !== VOID) {
    return conflict(
      'This is an active financial record. Void it first if it needs to be removed from the books.',
      { reason: 'invoice_not_void', status: inv.status }
    );
  }
  if (Number(inv.paid) > 0) {
    return conflict(
      'This invoice has recorded payments against it and must be kept for the audit trail.',
      { reason: 'invoice_has_payments', paid: inv.paid }
    );
  }

  try {
    // :495-497 — unlink the job card first, if it still points here, then
    // remove the invoice. One batch, so a failure leaves both as they were.
    const results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE job_cards SET invoice_id = NULL, updated_at = ?2 WHERE invoice_id = ?1'
      ).bind(id.value, nowIso()),
      env.DB.prepare('DELETE FROM invoices WHERE id = ?1').bind(id.value),
    ]);
    const removed = results[results.length - 1];
    if (!removed.meta || removed.meta.changes === 0) {
      return fail('not_found', 'No invoice with that id.', 404);
    }
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('DELETE /api/invoices/:id failed:', err);
    return fail('database_error', 'Could not delete the invoice.', 500);
  }

  return ok({ id: id.value, deleted: true });
}

/* ---------------------------------------------------------------
   The response
   --------------------------------------------------------------- */

/** The record a successful write reports — identical to what a GET returns. */
async function respondWithInvoice(env, id, status, meta = {}) {
  const row = await env.DB.prepare(
    `SELECT ${PARENT_COLUMNS} FROM invoices WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) {
    console.error(`Invoice ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the invoice back.', 500);
  }
  const { services, parts } = await fetchLines(env, [row.id]);
  return ok(
    toRecord(row, services.get(row.id) ?? [], parts.get(row.id) ?? []),
    meta,
    status
  );
}
