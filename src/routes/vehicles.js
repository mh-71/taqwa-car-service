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

const routes = collectionRoutes({
  table: 'vehicles',
  columns: COLUMNS,
  toRecord,
  singular: 'vehicle',
  plural: 'vehicles',
});

export const listVehicles = routes.list;
export const getVehicle = routes.detail;
