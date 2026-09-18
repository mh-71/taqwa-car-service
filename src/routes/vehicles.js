/* ============================================================
   routes/vehicles.js — GET /api/vehicles   (read-only)
   ------------------------------------------------------------
   Phase B-3. Follows routes/customers.js exactly: fixed SQL with
   bound parameters, an explicit column list rather than SELECT *,
   and a row mapper that turns the database's snake_case into the
   camelCase every UI module already reads.

   Field names here match what js/vehicles.js reads today
   (regNo, engineNo, chassisNo, fuelType, nextServiceDate,
   customerId), so storage.js can later swap localStorage for
   fetch() without any UI module changing.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
} from '../lib/http.js';

const COLUMNS = `
  id, customer_id, reg_no, brand, model, year, color, vin,
  engine_no, chassis_no, mileage, fuel_type, transmission,
  next_service_date, notes, status, created_at, updated_at
`;

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * Text columns fall back to '' because the UI concatenates and renders them
 * directly. `year` and `mileage` fall back to null instead: '' would become 0
 * through Number(), which would claim a vehicle has zero kilometres rather
 * than an unrecorded reading.
 */
function toRecord(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    regNo: row.reg_no,
    brand: row.brand,
    model: row.model,
    year: row.year ?? null,
    color: row.color ?? '',
    vin: row.vin ?? '',
    engineNo: row.engine_no ?? '',
    chassisNo: row.chassis_no ?? '',
    mileage: row.mileage ?? null,
    fuelType: row.fuel_type ?? '',
    transmission: row.transmission ?? '',
    nextServiceDate: row.next_service_date ?? '',
    notes: row.notes ?? '',
    status: row.status,
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * GET /api/vehicles?limit=&offset=
 *
 * Newest first, the order vehicles.js renders by default ('added-desc').
 * `id` is the tie-breaker so paging stays stable when two records share a
 * created_at.
 */
export async function listVehicles(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);

  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM vehicles
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    )
      .bind(limit.value, offset.value)
      .all();

    const rows = results ?? [];
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM vehicles`
    ).first();

    return ok(rows.map(toRecord), {
      count: rows.length,
      total: total ? total.n : rows.length,
      limit: limit.value,
      offset: offset.value,
    });
  } catch (err) {
    console.error('GET /api/vehicles failed:', err);
    return fail('database_error', 'Could not read vehicles.', 500);
  }
}

/**
 * GET /api/vehicles/:id
 *
 * One vehicle by its human-readable id (VEH-0001). Same record shape as the
 * list route, wrapped as { data: {...} }.
 *
 * readRecordId() is shape-only and not prefix-specific, so CUS-0001 here is a
 * well-formed id that simply is not a vehicle -- a 404, not a 400.
 */
export async function getVehicle(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  try {
    const row = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM vehicles
        WHERE id = ?1
        LIMIT 1`
    )
      .bind(id.value)
      .first();

    if (!row) return fail('not_found', 'No vehicle with that id.', 404);

    return ok(toRecord(row));
  } catch (err) {
    console.error('GET /api/vehicles/:id failed:', err);
    return fail('database_error', 'Could not read vehicle.', 500);
  }
}
