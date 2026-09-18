/* ============================================================
   routes/inventory-transactions.js — GET /api/inventory-transactions[/:id]
   ------------------------------------------------------------
   The stock audit trail: one append-only row per movement, written
   by Utils.Inventory.move() (utils.js:206-232) alongside the change
   it makes to parts.stock.

   This is the eleventh and last of the localStorage collections the
   schema set out to mirror ("Mirrors the eleven localStorage
   collections the app uses today", 0001_initial_schema.sql:4), and
   the only one the read API had not yet exposed.

   ---- the ledger is history, parts.stock is the balance ----

   B-6 established which of the two is authoritative and this route
   does not reopen it: parts.stock is the operational quantity, and
   the parts route reads it from its own column. The rows here are
   the record of how it got there, not an alternative way to compute
   it. Nothing in this module sums quantity, and nothing reads or
   reconciles against parts.

   `prev_stock` and `new_stock` are snapshots taken at the moment of
   the move, exactly like the price columns on a job card line. They
   are what stock WAS and BECAME then -- not a claim about now -- so
   they are returned as stored and never recomputed from the rows
   around them.

   ---- no aggregates, no per-part rollups ----

   Every figure the app shows on top of this ledger is derived at
   render time, and each one belongs to the consumer that defines it:

     Utils.Inventory.history(partId)              utils.js:235-240
     Utils.Inventory.getIssuedQtyForJobPart()     utils.js:250-259
     Utils.Inventory.hasJobDeduction()            utils.js:242-246
     movementIn / movementOut / usageByPart       reports.js:215-222

   getIssuedQtyForJobPart() in particular is deliberately computed
   from this ledger rather than from a job card's current partsUsed,
   so it stays right after the lines are edited. Shipping a server-
   side version would define that rule twice, and reconciliation is
   the one place in the app where a second, drifting definition
   would silently corrupt stock. Callers get rows and filter them
   the way those four functions already do.

   ---- read-only, and the writes stay where they are ----

   move() is the only thing that appends here, and it writes the
   transaction and the new parts.stock back-to-back so the store is
   never left half-applied. returnForJob() and reconcileJobInventory()
   drive it for job-card edits and cancellations. None of that logic
   belongs in a GET, and none of it is imported here.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { ok, fail, methodNotAllowed, noDatabase, conflict, unprocessable } from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum,
  allocateId, nowIso, constraintFailure,
} from '../lib/write.js';

const COLUMNS = `
  id, part_id, type, quantity, unit_cost,
  reference_type, reference_id, reason, notes,
  prev_stock, new_stock, created_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * Three different null rules apply here, each matching what the app itself
 * stores rather than a blanket fallback:
 *
 *   - `unit_cost` keeps null. inventory.js:608 renders it as
 *     `t.unitCost != null ? money(t.unitCost) : '—'`, so null and 0 mean
 *     different things on screen: a movement with no cost recorded versus one
 *     that genuinely cost nothing. Collapsing null to 0 or '' would print
 *     "৳ 0" for an unknown cost. Same null-versus-zero rule as mechanics.
 *
 *   - `reference_type` / `reference_id` keep null, matching every other
 *     reference in this API (payments.invoiceId, job_cards.appointmentId).
 *     move() defaults referenceId to null for a manual movement, so null is
 *     the value the app actually writes.
 *
 *   - `reason` and `notes` fall back to ''. They are free text rendered
 *     straight into the table, and move() stores '' for them rather than null.
 *
 * `quantity`, `prev_stock` and `new_stock` are NOT NULL with CHECK
 * constraints (quantity > 0, both stocks >= 0), so they always arrive as
 * numbers and are passed through bare.
 *
 * There is no `updated_at` column: the ledger is append-only, so a row is
 * never updated and the key is absent from this record entirely.
 */
function toRecord(row) {
  return {
    id: row.id,
    partId: row.part_id,
    type: row.type,                          // one of the 8 CHECKed types, verbatim
    quantity: row.quantity,                  // stored, never summed here
    unitCost: row.unit_cost ?? null,         // null !== 0; see above
    referenceType: row.reference_type ?? null,
    referenceId: row.reference_id ?? null,
    reason: row.reason ?? '',
    notes: row.notes ?? '',
    prevStock: row.prev_stock,               // snapshot at move time
    newStock: row.new_stock,                 // snapshot at move time
    createdAt: row.created_at,
  };
}

/* ---------- POST: a manual stock movement ------------------------------ */

/* The eight types and their direction, copied from utils.js:200-201 and
   matching the column's own CHECK exactly. There is ONE authoritative
   mapping: direction is derived from the type server-side and is never a
   field a client can send, so `type: 'purchase'` can never arrive claiming
   to be outbound. */
const IN_TYPES = ['purchase', 'adjustment-in', 'return', 'initial-stock'];
const OUT_TYPES = ['sale', 'job-card-use', 'adjustment-out', 'damaged'];
const TYPES = [...IN_TYPES, ...OUT_TYPES];

/* The schema comments reference_type as 'job-card' | 'manual'. C-4 writes the
   manual half only: a job-card movement is one side of a larger operation
   (deductForJob / returnForJob / reconcileJobInventory, utils.js:262-420) that
   also touches the job card, and getIssuedQtyForJobPart() TRUSTS these rows to
   reconcile what a job has actually been issued. Letting a client post one by
   hand would let it forge that history. C-5 writes them, inside its own batch. */
const MANUAL = 'manual';

/* Fields the server owns. Refused by name rather than ignored, so a caller
   cannot believe it set a stock snapshot that the database actually computed. */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  prevStock: '`prevStock` is recorded by the server from the live stock.',
  newStock: '`newStock` is recorded by the server from the live stock.',
  createdAt: '`createdAt` is set by the server.',
  jobCardId: '`jobCardId` is not a field on a stock movement. '
    + 'Job card movements are written by job card operations.',
};

function readFields(body) {
  const values = {};
  const errors = {};
  const take = (column, key, result) => {
    if (result.error) errors[key] = result.error;
    else values[column] = result.value;
  };

  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (body[key] !== undefined) errors[key] = message;
  }

  take('part_id', 'partId', readString(body, 'partId', { required: true, max: 32 }));
  take('type', 'type', readEnum(body, 'type', TYPES, { required: true }));
  // utils.js:210-211 — `!qty || qty <= 0` rejects 0, negatives and anything
  // non-numeric. Fractional quantities are allowed: the column is REAL and the
  // ledger already holds a 1.5.
  take('quantity', 'quantity', readNumber(body, 'quantity', { required: true }));
  // Strictly greater than zero, with the engine's own wording rather than a
  // machine-generated bound: a "must be at least 5e-324" message helps nobody.
  if (values.quantity !== undefined && !(values.quantity > 0)) {
    errors.quantity = 'Quantity must be greater than 0.';
    delete values.quantity;
  }
  // utils.js:226 — null when absent or blank, otherwise the number. 0 is a
  // real cost (a supplier sample) and must not become null; null is "no cost
  // recorded" and must not become 0.
  take('unit_cost', 'unitCost', readNumber(body, 'unitCost', { min: 0 }));
  take('reference_id', 'referenceId', readString(body, 'referenceId', { max: 32, fallback: null }));
  take('reason', 'reason', readString(body, 'reason', { max: 200 }));
  take('notes', 'notes', readString(body, 'notes', { max: 1000 }));

  // Accepted only as 'manual', and defaulted to it — the same value all three
  // manual call sites pass (inventory.js:347, :449, :514).
  if (body.referenceType !== undefined && body.referenceType !== MANUAL) {
    errors.referenceType =
      "`referenceType` must be 'manual'. Job card movements are written by job card operations.";
  }
  values.reference_type = MANUAL;

  // A blank reference is stored as NULL, which is what the receive form does
  // with an empty box (inventory.js:449: `.trim() || null`).
  if (values.reference_id === '') values.reference_id = null;

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/**
 * POST /api/inventory-transactions
 *
 * The first operation in this API that changes two tables, and the reason C-1
 * proved batch rollback before any of it was designed.
 *
 * ---- why there is no SELECT of the current stock ----
 *
 * Reading stock, computing the new value in JavaScript and writing it back is
 * a lost update: two concurrent movements both read the same balance and the
 * second overwrites the first. The stock column's CHECK would not catch it,
 * and the ledger's prev_stock/new_stock would record a balance that never
 * existed.
 *
 * So the arithmetic happens in SQL, against the live row, inside one batch:
 *
 *   1. INSERT ... SELECT reads `stock` from parts and writes it as
 *      prev_stock, with stock + delta as new_stock.
 *   2. UPDATE applies the same delta.
 *
 * Both carry the SAME guard -- `stock + delta >= 0` -- so for an outbound
 * movement they either both apply or both match nothing. The INSERT runs
 * first and therefore sees the balance BEFORE the update, which is exactly
 * what prev_stock means. Neither statement trusts a value from the Worker:
 * only the delta is bound.
 *
 * A guard that matches nothing is not an error, so the batch commits having
 * changed nothing at all -- no half-applied movement, and no need to roll
 * back. meta.changes tells us which happened.
 */
export async function createInventoryTransaction(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);

  const fields = readFields(body.value);
  if (!fields.ok) {
    return unprocessable('Some stock movement fields are not valid.', fields.errors);
  }
  const v = fields.values;

  // The one authoritative direction mapping. A client sends a type; whether
  // that adds or removes stock is decided here and nowhere else.
  const delta = IN_TYPES.includes(v.type) ? v.quantity : -v.quantity;

  const allocated = await allocateId(env, 'inventoryTransactions');
  if (allocated.error) {
    console.error('POST /api/inventory-transactions could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not record the stock movement.', 500);
  }
  const createdAt = nowIso();

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO inventory_transactions
           (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
            reason, notes, prev_stock, new_stock, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, stock, stock + ?10, ?11
           FROM parts
          WHERE id = ?2 AND stock + ?10 >= 0`
      ).bind(
        allocated.id, v.part_id, v.type, v.quantity, v.unit_cost,
        v.reference_type, v.reference_id, v.reason, v.notes, delta, createdAt
      ),
      env.DB.prepare(
        `UPDATE parts
            SET stock = stock + ?2, updated_at = ?3
          WHERE id = ?1 AND stock + ?2 >= 0`
      ).bind(v.part_id, delta, createdAt),
    ]);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/inventory-transactions failed:', err);
    return fail('database_error', 'Could not record the stock movement.', 500);
  }

  const inserted = results[0]?.meta?.changes ?? 0;
  const moved = results[1]?.meta?.changes ?? 0;

  if (inserted === 1 && moved === 1) {
    const row = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM inventory_transactions WHERE id = ?1`
    ).bind(allocated.id).first();
    return ok(toRecord(row), {}, 201);
  }

  // Nothing was written -- both guards matched the same row or neither did,
  // so there is no partial state to undo. One read, on the failure path only,
  // says which rule stopped it.
  const part = await env.DB.prepare(
    'SELECT name, stock FROM parts WHERE id = ?1'
  ).bind(v.part_id).first();

  if (!part) {
    return conflict('That part does not exist.',
      { reason: 'part_not_found', partId: v.part_id });
  }
  return conflict(
    `Insufficient stock for ${part.name}. Available: ${part.stock}, required: ${v.quantity}.`,
    { reason: 'insufficient_stock', partId: v.part_id, available: part.stock, required: v.quantity }
  );
}

const routes = collectionRoutes({
  table: 'inventory_transactions',
  columns: COLUMNS,
  toRecord,
  singular: 'inventory transaction',
  plural: 'inventory transactions',
});

export const listInventoryTransactions = routes.list;
export const getInventoryTransaction = routes.detail;
