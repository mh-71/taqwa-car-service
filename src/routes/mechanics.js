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
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum, readDate, todayInDhaka } from '../lib/write.js';
import { conflict } from '../lib/http.js';

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

/* ---------- writes ----------------------------------------------------- */

const PHONE = /^[0-9\+\-\s()]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['Active', 'Inactive'];
const EARLIEST_JOINING = '1980-01-01';

const digits = (phone) => String(phone || '').replace(/\D/g, '');

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';

  f.take('name', 'name', readString(body, 'name', { required, max: 120 }));
  f.take('phone', 'phone', readString(body, 'phone', { required, max: 20 }));
  f.take('alt_phone', 'altPhone', readString(body, 'altPhone', { max: 20 }));
  f.take('email', 'email', readString(body, 'email', { max: 160 }));
  f.take('address', 'address', readString(body, 'address', { max: 500 }));
  // mechanics.js:290 requires a specialization on the form.
  f.take('specialization', 'specialization', readString(body, 'specialization', { required, max: 80 }));
  // The three nullable numerics keep null apart from zero: 0 years of
  // experience and a 0% commission are both real, and the read route already
  // reports them as such.
  f.take('experience', 'experience', readNumber(body, 'experience', { min: 0, integer: true }));
  f.take('salary', 'salary', readNumber(body, 'salary', { min: 0 }));
  f.take('commission_rate', 'commissionRate', readNumber(body, 'commissionRate', { min: 0, max: 100 }));
  f.take('joining_date', 'joiningDate', readDate(body, 'joiningDate'));
  f.take('employment_type', 'employmentType', readString(body, 'employmentType', { max: 40 }));
  f.take('salary_type', 'salaryType', readString(body, 'salaryType', { max: 40 }));
  f.take('availability', 'availability', readString(body, 'availability', { max: 80 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  if (f.values.phone !== undefined && !PHONE.test(f.values.phone)) {
    f.reject('phone', 'Enter a valid phone number (digits, +, -, spaces).');
  }
  if (f.values.alt_phone && !PHONE.test(f.values.alt_phone)) {
    f.reject('altPhone', 'Enter a valid phone number.');
  }
  if (f.values.email && !EMAIL.test(f.values.email)) {
    f.reject('email', 'Enter a valid email address.');
  }
  // mechanics.js:297 — a joining date cannot predate the shop or be in the
  // future. "Today" is the workshop's calendar day, not the Worker's UTC one.
  if (f.values.joining_date) {
    if (f.values.joining_date < EARLIEST_JOINING) {
      f.reject('joiningDate', 'Joining date looks too old.');
    } else if (f.values.joining_date > todayInDhaka()) {
      f.reject('joiningDate', 'Joining date cannot be in the future.');
    }
  }
  return f;
}

/**
 * mechanics.js:279 — one ACTIVE mechanic per phone number. An inactive
 * mechanic does not block the number, so this is not something a plain unique
 * index could express, and the schema has none. Application rule, enforced
 * here only.
 */
async function beforeWrite(env, values, { id }) {
  if (values.phone === undefined) return null;

  const clash = await env.DB.prepare(
    `SELECT id, name
       FROM mechanics
      WHERE status = 'Active'
        AND replace(replace(replace(replace(replace(phone,
              '+', ''), '-', ''), ' ', ''), '(', ''), ')', '') = ?1
        AND (?2 IS NULL OR id <> ?2)
      LIMIT 1`
  )
    .bind(digits(values.phone), id)
    .first();

  if (clash) {
    return conflict('A mechanic with this phone number already exists.',
      { conflictsWith: clash.id, field: 'phone' });
  }
  return null;
}

const routes = collectionRoutes({
  table: 'mechanics',
  columns: COLUMNS,
  toRecord,
  singular: 'mechanic',
  plural: 'mechanics',
});

// job_cards.mechanic_id and appointments.mechanic_id are ON DELETE RESTRICT,
// which is the "associated with historical work records" guard at
// mechanics.js:385. The constraint becomes the 409.
const writes = collectionWrite({
  table: 'mechanics',
  columns: COLUMNS,
  toRecord,
  singular: 'mechanic',
  plural: 'mechanics',
  collection: 'mechanics',
  readFields,
  beforeWrite,
});

export const listMechanics = routes.list;
export const getMechanic = routes.detail;
export const createMechanic = writes.create;
export const updateMechanic = writes.update;
export const deleteMechanic = writes.remove;
