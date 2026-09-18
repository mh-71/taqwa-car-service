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

const routes = collectionRoutes({
  table: 'parts',
  columns: COLUMNS,
  toRecord,
  singular: 'part',
  plural: 'parts',
});

export const listParts = routes.list;
export const getPart = routes.detail;
