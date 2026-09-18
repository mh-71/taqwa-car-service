/* ============================================================
   routes/vehicles.js — GET /api/vehicles[/:id]   (read-only)
   ------------------------------------------------------------
   List/detail plumbing comes from lib/collection.js; this file
   supplies the table, its column list and the row mapper.

   Field names match what js/vehicles.js reads today — customerId,
   regNo, engineNo, chassisNo, fuelType, nextServiceDate — so
   storage.js can later swap localStorage for fetch() without any
   UI module changing.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum, readDate } from '../lib/write.js';
import { conflict } from '../lib/http.js';

const COLUMNS = `
  id, customer_id, reg_no, brand, model, year, color, vin,
  engine_no, chassis_no, mileage, fuel_type, transmission,
  next_service_date, notes, status, created_at, updated_at
`;

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

/* ---------- writes ----------------------------------------------------- */

const STATUSES = ['Active', 'Inactive'];

/** vehicles.js:274 compares registrations with spaces and hyphens removed. */
const normReg = (reg) => String(reg || '').replace(/[\s-]/g, '').toLowerCase();

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';
  // vehicles.js:281 — the upper bound moves with the calendar, exactly as the
  // form's does, so a new model year is accepted the day it becomes plausible.
  const maxYear = new Date().getUTCFullYear() + 1;

  f.take('customer_id', 'customerId', readString(body, 'customerId', { required, max: 32 }));
  f.take('reg_no', 'regNo', readString(body, 'regNo', { required, max: 40 }));
  f.take('brand', 'brand', readString(body, 'brand', { required, max: 80 }));
  f.take('model', 'model', readString(body, 'model', { required, max: 80 }));
  // The form's range is narrower than the column's CHECK (1900-2200); the
  // form's is the one users see, so it is the one enforced.
  f.take('year', 'year', readNumber(body, 'year', { min: 1950, max: maxYear, integer: true }));
  f.take('color', 'color', readString(body, 'color', { max: 40 }));
  f.take('vin', 'vin', readString(body, 'vin', { max: 64 }));
  f.take('engine_no', 'engineNo', readString(body, 'engineNo', { max: 64 }));
  f.take('chassis_no', 'chassisNo', readString(body, 'chassisNo', { max: 64 }));
  f.take('mileage', 'mileage', readNumber(body, 'mileage', { min: 0, integer: true }));
  f.take('fuel_type', 'fuelType', readString(body, 'fuelType', { max: 40 }));
  f.take('transmission', 'transmission', readString(body, 'transmission', { max: 40 }));
  f.take('next_service_date', 'nextServiceDate', readDate(body, 'nextServiceDate'));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  return f;
}

/**
 * The duplicate-registration rule.
 *
 * ux_vehicles_reg_no is an EXACT unique index, but vehicles.js:274 treats
 * 'DHA-1234' and 'dha 1234' as the same plate. This closes that gap; the index
 * stays the backstop for an exact duplicate arriving in a race.
 *
 * The customer reference is deliberately NOT pre-checked: customer_id is
 * NOT NULL REFERENCES customers(id), so a bad one raises a FOREIGN KEY error
 * that collection-write maps to 409 without a second round trip.
 */
async function beforeWrite(env, values, { id }) {
  if (values.reg_no === undefined) return null;

  const clash = await env.DB.prepare(
    `SELECT id, reg_no
       FROM vehicles
      WHERE lower(replace(replace(reg_no, ' ', ''), '-', '')) = ?1
        AND (?2 IS NULL OR id <> ?2)
      LIMIT 1`
  )
    .bind(normReg(values.reg_no), id)
    .first();

  if (clash) {
    return conflict('A vehicle with this registration number already exists.',
      { conflictsWith: clash.id, field: 'regNo' });
  }
  return null;
}

const routes = collectionRoutes({
  table: 'vehicles',
  columns: COLUMNS,
  toRecord,
  singular: 'vehicle',
  plural: 'vehicles',
});

// Job cards, invoices and appointments all hold ON DELETE RESTRICT references
// to vehicles, so the schema itself blocks the delete the UI blocks
// (vehicles.js:358-372). No beforeDelete needed; the constraint becomes a 409.
const writes = collectionWrite({
  table: 'vehicles',
  columns: COLUMNS,
  toRecord,
  singular: 'vehicle',
  plural: 'vehicles',
  collection: 'vehicles',
  readFields,
  beforeWrite,
});

export const listVehicles = routes.list;
export const getVehicle = routes.detail;
export const createVehicle = writes.create;
export const updateVehicle = writes.update;
export const deleteVehicle = writes.remove;
