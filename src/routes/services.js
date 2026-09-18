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
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum } from '../lib/write.js';
import { conflict } from '../lib/http.js';

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

/* ---------- writes ----------------------------------------------------- */

const STATUSES = ['Active', 'Inactive'];

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';

  f.take('name', 'name', readString(body, 'name', { required, max: 120 }));
  // services.js:248 requires a category on the form even though the column is
  // nullable, so the API requires it on create too.
  f.take('category', 'category', readString(body, 'category', { required, max: 80 }));
  f.take('description', 'description', readString(body, 'description', { max: 1000 }));
  // est_time's CHECK is "NULL or > 0": absent stays null, a supplied value
  // must be positive. services.js:254 says the same.
  f.take('est_time', 'estTime', readNumber(body, 'estTime', { min: 1, integer: true }));
  // Price is required on create and defaults to 0 nowhere: services.js:249
  // treats a blank price as an error rather than a free service.
  f.take('price', 'price', readNumber(body, 'price', { required, min: 0 }));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  return f;
}

/**
 * services.js:260 — one service name per category, compared case-insensitively
 * and after trimming. Nothing in the schema enforces this, so it is entirely
 * an application rule and lives here.
 *
 * A merge update that changes only one of the pair still has to be judged
 * against the stored other half, so the row is read when exactly one side is
 * supplied. That is the one extra SELECT in this file and it only happens on
 * an update that touches name or category.
 */
async function beforeWrite(env, values, { id }) {
  const touchesName = values.name !== undefined;
  const touchesCategory = values.category !== undefined;
  if (!touchesName && !touchesCategory) return null;

  let { name, category } = values;
  if (id && (name === undefined || category === undefined)) {
    const current = await env.DB.prepare(
      'SELECT name, category FROM services WHERE id = ?1'
    ).bind(id).first();
    if (!current) return null;            // the UPDATE itself will 404
    if (name === undefined) name = current.name;
    if (category === undefined) category = current.category;
  }
  if (!name || !category) return null;

  const clash = await env.DB.prepare(
    `SELECT id FROM services
      WHERE category = ?1
        AND lower(trim(name)) = lower(trim(?2))
        AND (?3 IS NULL OR id <> ?3)
      LIMIT 1`
  )
    .bind(category, name, id)
    .first();

  if (clash) {
    return conflict('This service already exists in this category.',
      { conflictsWith: clash.id, field: 'name' });
  }
  return null;
}

const routes = collectionRoutes({
  table: 'services',
  columns: COLUMNS,
  toRecord,
  singular: 'service',
  plural: 'services',
});

// job_card_services.service_id and appointments.service_id are both
// ON DELETE RESTRICT, which is exactly the "already used in historical
// records" guard services.js:341 shows. The constraint becomes the 409.
const writes = collectionWrite({
  table: 'services',
  columns: COLUMNS,
  toRecord,
  singular: 'service',
  plural: 'services',
  collection: 'services',
  readFields,
  beforeWrite,
});

export const listServices = routes.list;
export const getService = routes.detail;
export const createService = writes.create;
export const updateService = writes.update;
export const deleteService = writes.remove;
