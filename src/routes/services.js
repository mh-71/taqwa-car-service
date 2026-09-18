/* ============================================================
   routes/services.js — GET /api/services[/:id]   (read-only)
   ------------------------------------------------------------
   The service catalogue. List/detail plumbing comes from
   lib/collection.js; this file supplies the table, its column list
   and the row mapper.

   Field names match what js/services.js reads today — name,
   category, description, estTime, price, status, createdAt.

   Note on snapshots: a Job Card copies a service's name and price
   at the moment the line is added, so editing the catalogue never
   rewrites history. This route reads the LIVE catalogue; the
   frozen copies live in job_card_services.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';

const COLUMNS = `
  id, name, category, description, est_time, price,
  status, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * `price` is NOT NULL in the schema and defaults to 0, so it always arrives
 * as a number. `est_time` is nullable and stays null when unset: 0 would
 * claim a service takes no time rather than that nobody recorded an estimate.
 */
function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? '',
    description: row.description ?? '',
    estTime: row.est_time ?? null,
    price: row.price,
    status: row.status,
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'services',
  columns: COLUMNS,
  toRecord,
  singular: 'service',
  plural: 'services',
});

export const listServices = routes.list;
export const getService = routes.detail;
