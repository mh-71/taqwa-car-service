/* ============================================================
   routes/parts.js — GET /api/parts[/:id]   (read-only)
   ------------------------------------------------------------
   The parts catalogue with its stock levels. List/detail plumbing
   comes from lib/collection.js; this file supplies the table, its
   column list and the row mapper.

   Field names match what js/inventory.js reads today — partNo,
   purchasePrice, sellingPrice, minStock, reorderQty — so
   storage.js can later swap localStorage for fetch() without any
   UI module changing.

   ---- stock is read, never derived ----

   `parts.stock` is the authoritative running balance, and this route
   returns it straight from the column. It is NOT recomputed by summing
   inventory_transactions, because the client does not work that way
   either: Utils.Inventory.move() (utils.js:210-232) reads part.stock as
   prevStock, writes the transaction carrying both prevStock and
   newStock, then writes the new balance back to the part. The ledger
   records what happened to the balance; it is not the balance.
   js/inventory.js:4 says so outright — "the inventoryTransactions
   collection is the audit trail".

   Summing the ledger here would create a second answer to "how much is
   in stock", which is exactly the kind of drift the snapshot-versus-live
   work in the audit had to untangle elsewhere in this app.

   Two things deliberately absent:

   * No transaction history. The UI reads it separately, per part, via
     Inventory.history(partId). A useful endpoint for it needs a partId
     filter, which collectionRoutes() does not do by design, so it
     belongs in its own route module in a later phase.
   * No derived fields. Low stock (stock <= minStock) and stock value
     (stock * purchasePrice) are computed in the UI at render time
     (inventory.js:54-55, 94, 157); shipping them as stored-looking
     fields would invent a second definition of each.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum } from '../lib/write.js';
import { conflict } from '../lib/http.js';

const COLUMNS = `
  id, name, part_no, category, brand, supplier, location, unit,
  purchase_price, selling_price, stock, min_stock, reorder_qty,
  notes, status, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * purchase_price, selling_price, stock and min_stock are all NOT NULL with a
 * DEFAULT of 0, so they always arrive as numbers and a 0 is a real answer:
 * PRT-0007 ships with stock 0, which means out of stock, not unrecorded.
 *
 * reorder_qty is the one nullable number, and it stays null. The edit form
 * already supplies its own display default (`p.reorderQty ?? 10`,
 * inventory.js:266) and the detail tile falls back to 0 (`|| 0`, :636), so
 * filling either in here would turn "nobody set a reorder quantity" into a
 * stored instruction to reorder that many.
 *
 * `openingStock` is not here because it is not stored: inventory.js destructures
 * it out of the record (:341, :372) and turns it into an initial-stock
 * transaction instead, so every unit of stock has a ledger entry behind it.
 */
function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    partNo: row.part_no ?? '',
    category: row.category ?? '',
    brand: row.brand ?? '',
    supplier: row.supplier ?? '',
    location: row.location ?? '',
    unit: row.unit ?? '',
    purchasePrice: row.purchase_price,
    sellingPrice: row.selling_price,
    stock: row.stock,
    minStock: row.min_stock,
    reorderQty: row.reorder_qty ?? null,
    notes: row.notes ?? '',
    status: row.status,
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/* ---------- writes ----------------------------------------------------- */

const STATUSES = ['Active', 'Inactive'];

/**
 * `stock` is not writable through this route, in either direction.
 *
 * B-6 established that parts.stock is the authoritative balance and that the
 * ledger is its history. The app keeps the two in step through exactly one
 * door: Utils.Inventory.move() writes the transaction and the new stock
 * together. inventory.js creates a part with `{ ...master, stock: 0 }`
 * (:342) and its edit path says "stock deliberately untouched" (:373) --
 * an opening balance is recorded as a real audited movement, never as a field.
 *
 * So a body carrying `stock` is refused by name rather than ignored: silently
 * dropping it would let a caller believe it had set a balance that the ledger
 * knows nothing about. Stock moves in C-4, through
 * POST /api/inventory-transactions, and nowhere else.
 */
const STOCK_IS_NOT_WRITABLE =
  '`stock` cannot be set here. Stock changes are recorded as inventory transactions.';

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';

  if (body.stock !== undefined) f.reject('stock', STOCK_IS_NOT_WRITABLE);
  // The frontend's own field name for an opening balance, refused for the
  // same reason: inventory.js turns it into a movement, not a column write.
  if (body.openingStock !== undefined) f.reject('openingStock', STOCK_IS_NOT_WRITABLE);

  f.take('name', 'name', readString(body, 'name', { required, max: 160 }));
  f.take('part_no', 'partNo', readString(body, 'partNo', { required, max: 80 }));
  f.take('category', 'category', readString(body, 'category', { required, max: 80 }));
  f.take('brand', 'brand', readString(body, 'brand', { max: 80 }));
  f.take('supplier', 'supplier', readString(body, 'supplier', { max: 160 }));
  f.take('location', 'location', readString(body, 'location', { max: 80 }));
  f.take('unit', 'unit', readString(body, 'unit', { required, max: 20 }));
  f.take('purchase_price', 'purchasePrice', readNumber(body, 'purchasePrice', { required, min: 0 }));
  f.take('selling_price', 'sellingPrice', readNumber(body, 'sellingPrice', { required, min: 0 }));
  f.take('min_stock', 'minStock', readNumber(body, 'minStock', { required, min: 0 }));
  f.take('reorder_qty', 'reorderQty', readNumber(body, 'reorderQty', { min: 0 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  // inventory.js:281-282 normalises both before storing, so the same values
  // reach the database whichever door they came through.
  if (f.values.part_no !== undefined) f.values.part_no = f.values.part_no.toUpperCase();
  if (f.values.name !== undefined) f.values.name = f.values.name.replace(/\s+/g, ' ');

  return f;
}

/**
 * inventory.js:298 — one ACTIVE part per part number.
 *
 * ux_parts_part_no_active enforces this already, but case-sensitively, while
 * the form uppercases before comparing. readFields() uppercases too, so the
 * two now agree; this check exists to name the clashing part the way the form
 * does, and the index remains the backstop for a race.
 */
async function beforeWrite(env, values, { id }) {
  if (values.part_no === undefined || values.part_no === '') return null;

  const clash = await env.DB.prepare(
    `SELECT id, name FROM parts
      WHERE status = 'Active'
        AND upper(part_no) = ?1
        AND (?2 IS NULL OR id <> ?2)
      LIMIT 1`
  )
    .bind(values.part_no, id)
    .first();

  if (clash) {
    return conflict(`An active part with this part number already exists (${clash.name}).`,
      { conflictsWith: clash.id, field: 'partNo' });
  }
  return null;
}

/**
 * inventory.js:548-552 blocks the delete when the part has job-card usage,
 * stock movements beyond its opening balance, or any stock left. Two of those
 * three are foreign keys and would raise anyway; all three are read here in
 * ONE query so the caller learns which rule stopped it rather than getting a
 * bare constraint failure.
 */
async function beforeDelete(env, id) {
  const state = await env.DB.prepare(
    `SELECT
       (SELECT stock FROM parts WHERE id = ?1) AS stock,
       (SELECT count(*) FROM inventory_transactions
         WHERE part_id = ?1 AND type <> 'initial-stock') AS movements,
       (SELECT count(*) FROM job_card_parts WHERE part_id = ?1) AS usage_count`
  )
    .bind(id)
    .first();

  if (!state || state.stock === null) return null;   // let the DELETE 404

  const reasons = [];
  if (state.usage_count > 0) reasons.push(`${state.usage_count} job card line(s)`);
  if (state.movements > 0) reasons.push(`${state.movements} stock transaction(s)`);
  if (Number(state.stock) > 0) reasons.push(`${state.stock} still in stock`);

  if (reasons.length) {
    return conflict(`This part cannot be deleted: ${reasons.join(', ')}.`, {
      reason: 'part_in_use',
      usageCount: state.usage_count,
      movements: state.movements,
      stock: state.stock,
    });
  }
  return null;
}

/**
 * A part that passes the guard may still own its opening-stock rows, which
 * hold an ON DELETE RESTRICT reference to it. inventory.js:577-580 removes
 * those first and then the part; both statements go in one batch so a part is
 * never left without its ledger, nor a ledger without its part.
 */
function deleteStatements(env, id) {
  return [
    env.DB.prepare('DELETE FROM inventory_transactions WHERE part_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM parts WHERE id = ?1').bind(id),
  ];
}

const routes = collectionRoutes({
  table: 'parts',
  columns: COLUMNS,
  toRecord,
  singular: 'part',
  plural: 'parts',
});

const writes = collectionWrite({
  table: 'parts',
  columns: COLUMNS,
  toRecord,
  singular: 'part',
  plural: 'parts',
  collection: 'parts',
  readFields,
  beforeWrite,
  beforeDelete,
  deleteStatements,
});

export const listParts = routes.list;
export const getPart = routes.detail;
export const createPart = writes.create;
export const updatePart = writes.update;
export const deletePart = writes.remove;
