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

const routes = collectionRoutes({
  table: 'inventory_transactions',
  columns: COLUMNS,
  toRecord,
  singular: 'inventory transaction',
  plural: 'inventory transactions',
});

export const listInventoryTransactions = routes.list;
export const getInventoryTransaction = routes.detail;
