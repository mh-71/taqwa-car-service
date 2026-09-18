/* ============================================================
   routes/customers.js — GET /api/customers   (read-only)
   ------------------------------------------------------------
   Phase B: the first real read route. Nothing writes, and the
   frontend does not call this yet -- it still runs on localStorage.

   Two rules this file establishes for every route that follows:

   1. SQL is a fixed string. Every value from the request is passed
      through .bind(), never concatenated. The column list is spelled
      out rather than SELECT * so an internal column (phone_digits,
      the generated duplicate-detection key) can never leak.

   2. The API speaks the frontend's vocabulary. The database is
      snake_case; every UI module reads camelCase (altPhone,
      createdAt). Mapping here means js/storage.js can later swap
      localStorage for fetch() without a single UI module changing.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
} from '../lib/http.js';

// Spelled out deliberately -- see rule 1 above.
const COLUMNS = `
  id, name, phone, alt_phone, email, address, notes,
  status, created_at, updated_at
`;

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/** One D1 row -> the record shape the app's UI modules already expect. */
function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    notes: row.notes ?? '',
    status: row.status,
    createdAt: row.created_at,
    // Absent until the record is first updated; omitted rather than null
    // so the shape matches what storage.js produces today.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * GET /api/customers?limit=&offset=
 *
 * Ordered newest first, matching the order customers.js renders today.
 * `id` is the tie-breaker so paging is stable when two records share a
 * created_at.
 */
export async function listCustomers(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);

  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM customers
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    )
      .bind(limit.value, offset.value)
      .all();

    const rows = results ?? [];
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM customers`
    ).first();

    return ok(rows.map(toRecord), {
      count: rows.length,
      total: total ? total.n : rows.length,
      limit: limit.value,
      offset: offset.value,
    });
  } catch (err) {
    // The client gets a stable code and a plain message; the detail goes
    // to the Worker log, not across the wire.
    console.error('GET /api/customers failed:', err);
    return fail('database_error', 'Could not read customers.', 500);
  }
}

/**
 * GET /api/customers/:id
 *
 * One customer by its human-readable id (CUS-0001). Returns the same record
 * shape as the list route, wrapped as { data: {...} } rather than an array.
 *
 * The id is validated for shape before any query is prepared, and is then
 * bound as a parameter — it is never concatenated into the SQL.
 */
export async function getCustomer(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  try {
    const row = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM customers
        WHERE id = ?1
        LIMIT 1`
    )
      .bind(id.value)
      .first();

    if (!row) {
      // A well-formed id that simply is not here. The message names no table
      // and echoes nothing back that could confirm internals.
      return fail('not_found', 'No customer with that id.', 404);
    }

    return ok(toRecord(row));
  } catch (err) {
    console.error('GET /api/customers/:id failed:', err);
    return fail('database_error', 'Could not read customer.', 500);
  }
}
