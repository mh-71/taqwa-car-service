/* ============================================================
   routes/mechanics.js — GET /api/mechanics[/:id]   (read-only)
   ------------------------------------------------------------
   The workshop's staff roster. List/detail plumbing comes from
   lib/collection.js; this file supplies the table, its column list
   and the row mapper.

   Field names match what js/mechanics.js reads today — altPhone,
   joiningDate, employmentType, salaryType, commissionRate — so
   storage.js can later swap localStorage for fetch() without any
   UI module changing.

   Worth flagging while this is still local-only: these rows carry
   salary and commission, the most sensitive field set in the app.
   The API has no authentication yet (audit Finding 12), so this
   route must not be deployed before one exists.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';

const COLUMNS = `
  id, name, phone, alt_phone, email, address, specialization,
  experience, joining_date, employment_type, salary_type, salary,
  commission_rate, availability, notes, status, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * Text columns fall back to '' because the UI concatenates and renders them
 * directly, and already supplies its own display defaults for the three that
 * have one — employmentType, salaryType and availability all go through
 * `|| '...'` at render time (mechanics.js:215, 219, 233). Filling those in
 * here would turn "nobody recorded this" into a stored answer.
 *
 * experience, salary and commissionRate stay null instead. The UI tests each
 * with `!== '' && != null` before rendering (mechanics.js:458, 461, 462), so a
 * 0 fallback would print "0 years" and a salary of zero where the record
 * actually says nothing was recorded. For payroll that is not a cosmetic
 * difference.
 */
function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    specialization: row.specialization ?? '',
    experience: row.experience ?? null,
    joiningDate: row.joining_date ?? '',
    employmentType: row.employment_type ?? '',
    salaryType: row.salary_type ?? '',
    salary: row.salary ?? null,
    commissionRate: row.commission_rate ?? null,
    availability: row.availability ?? '',
    notes: row.notes ?? '',
    status: row.status,
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'mechanics',
  columns: COLUMNS,
  toRecord,
  singular: 'mechanic',
  plural: 'mechanics',
});

export const listMechanics = routes.list;
export const getMechanic = routes.detail;
