/* ============================================================
   routes/job-cards.js — GET /api/job-cards[/:id]   (read-only)
   ------------------------------------------------------------
   The central workshop transaction record, and the first
   collection with child line tables, so it does not go through
   lib/collection.js.

   Why bespoke rather than the shared factory: collectionRoutes()
   builds one fixed SQL string, maps one row at a time, and issues
   exactly two queries. A job card needs its service and part lines
   too, which means an IN-list whose placeholder count varies, a
   mapper that takes a row plus two line sets, and three to six
   queries. Teaching the factory all of that would turn it into the
   generic CRUD layer lib/collection.js:11-14 deliberately refuses
   to be, and would complicate six collections to serve one. So the
   plumbing is written out here instead, reusing lib/http.js for
   the response envelope, the id and parameter validators, and
   every status code, so the contract is identical to the other
   collections.

   ---- what this route must never do ----

   1. paid and due are HISTORICAL SNAPSHOTS, frozen when the job
      card was invoiced. They are NOT the live payment balance.
      The live balance lives in Utils.liveJobBalance() on the
      client, which reads the invoice when one exists and is not
      Void (utils.js:163-175), and that is the fix for audit
      Finding 1. This route reports the stored numbers and joins
      neither invoices nor payments. Computing a live balance here
      would put Finding 1's answer in two places, which is exactly
      how the original bug got in.

   2. Service and part lines are SNAPSHOTS. js/job-cards.js:16-18
      states it: "name + unitPrice are SNAPSHOTS; catalog changes
      never rewrite history." A job card that sold "Premium Oil
      Change" at 1200 still says so after the catalogue renames the
      service and reprices it. So the catalogue is never joined,
      and nothing is refreshed from services or parts.

   3. Nothing is derived. Totals are recomputed by the client
      before every save (computeTotals(), job-cards.js:95) and
      stored; this route returns what is stored. Inventory is not
      touched at all: no stock recalculation, no issued quantity,
      no SUM over inventory_transactions. parts.stock stays the one
      answer to "how much is in stock", as established in B-6.

   4. Relationships stay as ids. Five of them -- customer, vehicle
      and mechanic are NOT NULL, appointment and invoice nullable
      -- and none is embedded. The UI resolves names at render time
      from the ids it already holds.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
} from '../lib/http.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * How many job card ids go into one `WHERE job_card_id IN (...)` query.
 *
 * SQLite's SQLITE_MAX_VARIABLE_NUMBER defaults to 999, and a list page can ask
 * for up to MAX_LIMIT rows, so a single IN-list would overflow it at the top of
 * the range. Chunking at 500 keeps every query comfortably inside the ceiling
 * and caps the work at two chunks per child table even for limit=1000.
 *
 * The only thing assembled into the SQL text is the placeholder run (`?1, ?2,
 * ...`), whose length comes from how many ids this chunk holds -- a number this
 * module computed, never a request value. Every id itself goes through .bind().
 */
const ID_CHUNK = 500;

const PARENT_COLUMNS = `
  id, customer_id, vehicle_id, mechanic_id, appointment_id, invoice_id,
  date, est_delivery, actual_delivery, completed_at,
  status, priority, mileage, mileage_out, fuel_level,
  complaint, inspection, diagnosis, technician_notes, recommendations,
  condition_notes, notes, inspection_checklist,
  labour_hours, labour_rate, labour_cost, discount, tax_rate,
  subtotal, tax, total, paid, due, created_at, updated_at
`;

// Child rows carry job_card_id so a batched result can be grouped by parent.
// The surrogate `id` and `line_no` are read for ordering but are not returned:
// the app's records have never had them (seed-data.js), so exposing them would
// invent a shape the UI does not use.
const SERVICE_COLUMNS = `job_card_id, service_id, name, qty, unit_price, total`;
const PART_COLUMNS = `job_card_id, part_id, name, part_no, qty, unit_price, total`;

// line_no carries no uniqueness constraint, so the surrogate id breaks ties and
// keeps the order of two lines sharing a line_no stable across requests.
const LINE_ORDER = `ORDER BY job_card_id, line_no, id`;

/**
 * inspection_checklist is stored as JSON in a TEXT column. The UI reads it with
 * Object.entries(j.inspectionChecklist || {}) (job-cards.js:1219), so it wants
 * an object, not a string.
 *
 * A row whose JSON is unparseable must not take down the request that happens
 * to include it -- one bad checklist would otherwise 500 an entire page of job
 * cards. It degrades to {} and says so in the Worker log, naming the job card
 * so it can be found. Valid data is never replaced: only null, '' and genuinely
 * unusable JSON become {}.
 */
function parseChecklist(raw, jobCardId) {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`job_cards.inspection_checklist for ${jobCardId} is JSON but not an object; returning {}`);
    return {};
  } catch {
    console.warn(`job_cards.inspection_checklist for ${jobCardId} is not valid JSON; returning {}`);
    return {};
  }
}

/** One job_card_services row -> the line shape the UI already reads. */
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
 * One job_card_parts row -> the line shape the UI already reads.
 *
 * part_id NULL is a manual line: a part written in by hand with no inventory
 * record behind it. It keeps its own name, part number and price and never
 * moves stock (utils.js: deductForJob and reconcileJobInventory both skip a
 * line with no partId), so nothing here promotes it into a catalogue part.
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
 * One job_cards row plus its lines -> the record shape the UI already expects.
 *
 * Nullable numbers stay null rather than falling back to 0: a job card with no
 * recorded mileage has not been driven zero kilometres, and no labour rate is
 * not a rate of zero. The NOT NULL money columns all default to 0 in the
 * schema, so a 0 there is a real figure.
 *
 * Prose columns fall back to '' because the UI concatenates and renders them.
 */
function toRecord(row, services, partsUsed) {
  return {
    id: row.id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    mechanicId: row.mechanic_id,
    appointmentId: row.appointment_id ?? null,
    invoiceId: row.invoice_id ?? null,

    date: row.date,                                   // local calendar day, verbatim
    estDelivery: row.est_delivery ?? '',
    actualDelivery: row.actual_delivery ?? '',
    completedAt: row.completed_at ?? '',

    status: row.status,
    priority: row.priority,
    mileage: row.mileage ?? null,
    mileageOut: row.mileage_out ?? null,
    fuelLevel: row.fuel_level ?? '',

    complaint: row.complaint,
    inspection: row.inspection ?? '',
    diagnosis: row.diagnosis ?? '',
    technicianNotes: row.technician_notes ?? '',
    recommendations: row.recommendations ?? '',
    conditionNotes: row.condition_notes ?? '',
    notes: row.notes ?? '',
    inspectionChecklist: parseChecklist(row.inspection_checklist, row.id),

    labourHours: row.labour_hours ?? null,
    labourRate: row.labour_rate ?? null,
    labourCost: row.labour_cost,
    discount: row.discount,
    taxRate: row.tax_rate,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paid: row.paid,                                   // SNAPSHOT, not the live balance
    due: row.due,                                     // SNAPSHOT, not the live balance

    services,
    partsUsed,

    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * Fetch the service and part lines for a set of job card ids.
 *
 * Two queries per chunk of ID_CHUNK ids, so the query count is bounded by the
 * page size ceiling rather than growing with it: a page of 500 costs two
 * queries, a page of 1000 costs four. Never one query per job card.
 *
 * Returns two Maps keyed by job card id, each holding that card's lines in
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
           FROM job_card_services
          WHERE job_card_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
      env.DB.prepare(
        `SELECT ${PART_COLUMNS}
           FROM job_card_parts
          WHERE job_card_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
    ]);

    for (const r of svcRows.results ?? []) {
      if (!services.has(r.job_card_id)) services.set(r.job_card_id, []);
      services.get(r.job_card_id).push(toServiceLine(r));
    }
    for (const r of partRows.results ?? []) {
      if (!parts.has(r.job_card_id)) parts.set(r.job_card_id, []);
      parts.get(r.job_card_id).push(toPartLine(r));
    }
  }

  return { services, parts };
}

/** GET /api/job-cards?limit=&offset= */
export async function listJobCards(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);

  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM job_cards
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    )
      .bind(limit.value, offset.value)
      .all();

    const rows = results ?? [];
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM job_cards`
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
    // A failed line query fails the whole request: half a job card, with its
    // totals but not the lines behind them, would read as a complete record.
    console.error('GET /api/job-cards failed:', err);
    return fail('database_error', 'Could not read job cards.', 500);
  }
}

/** GET /api/job-cards/:id */
export async function getJobCard(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  try {
    const row = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM job_cards
        WHERE id = ?1
        LIMIT 1`
    )
      .bind(id.value)
      .first();

    // readRecordId is shape-only, not prefix-specific, so a well-formed id
    // belonging to another collection lands here as a 404, not a 400. Returning
    // before the line queries is deliberate: an id that is not a job card must
    // cost one query, not three.
    if (!row) return fail('not_found', 'No job card with that id.', 404);

    const { services, parts } = await fetchLines(env, [row.id]);

    return ok(toRecord(row, services.get(row.id) ?? [], parts.get(row.id) ?? []));
  } catch (err) {
    console.error('GET /api/job-cards/:id failed:', err);
    return fail('database_error', 'Could not read job card.', 500);
  }
}
