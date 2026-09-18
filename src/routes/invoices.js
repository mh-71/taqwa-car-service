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
} from '../lib/http.js';

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
