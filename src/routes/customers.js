/* ============================================================
   routes/customers.js — GET /api/customers[/:id]   (read-only)
   ------------------------------------------------------------
   The list/detail plumbing lives in lib/collection.js; this file
   supplies only what is specific to customers: the table, its
   column list, how a row becomes a record, and the nouns used in
   messages.

   The column list is spelled out rather than SELECT * so that
   phone_digits — the generated column backing the duplicate-phone
   rule — can never leak.

   The record shape is the frontend's, not the database's: every UI
   module reads camelCase (altPhone, createdAt), so mapping here is
   what will let js/storage.js swap localStorage for fetch() later
   without a single UI module changing.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readEnum } from '../lib/write.js';
import { conflict } from '../lib/http.js';

const COLUMNS = `
  id, name, phone, alt_phone, email, address, notes,
  status, created_at, updated_at
`;

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

/* ---------- writes ----------------------------------------------------- */

// customers.js:152 — the shape the form accepts, kept verbatim so the API
// refuses exactly what the UI refuses and nothing more.
const PHONE = /^[0-9\+\-\s()]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['Active', 'Inactive'];

/** Digits only, the way customers.js compares two phone numbers. */
const digits = (phone) => String(phone || '').replace(/\D/g, '');

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';

  f.take('name', 'name', readString(body, 'name', { required, max: 120 }));
  f.take('phone', 'phone', readString(body, 'phone', { required, max: 20 }));
  f.take('alt_phone', 'altPhone', readString(body, 'altPhone', { max: 20 }));
  f.take('email', 'email', readString(body, 'email', { max: 160 }));
  f.take('address', 'address', readString(body, 'address', { max: 500 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  // Format rules the primitives cannot express. Only applied to a value that
  // was actually supplied, so a merge update never re-judges a stored one.
  if (f.values.phone !== undefined && !PHONE.test(f.values.phone)) {
    f.reject('phone', 'Enter a valid phone number (digits, +, -, spaces).');
  }
  if (f.values.alt_phone) {
    if (!PHONE.test(f.values.alt_phone)) f.reject('altPhone', 'Enter a valid phone number.');
  }
  if (f.values.email) {
    if (!EMAIL.test(f.values.email)) f.reject('email', 'Enter a valid email address.');
  }
  return f;
}

/**
 * The duplicate-phone rule.
 *
 * ux_customers_phone_digits already makes this near-impossible to bypass, but
 * the generated column only strips `- ( ) space` while customers.js:163
 * compares ALL non-digits -- so '+8801711' and '8801711' are one number to the
 * UI and two to the index. This check closes that gap and reports the existing
 * customer by name, the way the form does; the index remains the backstop if
 * two requests race.
 */
async function beforeWrite(env, values, { id }) {
  if (values.phone === undefined) return null;

  // Stripping the same five characters in SQL rather than pulling every
  // customer into the Worker. PHONE above already restricts input to digits,
  // +, -, space and parentheses, so removing exactly those is `\D` for any
  // value that reached this point.
  const clash = await env.DB.prepare(
    `SELECT id, name
       FROM customers
      WHERE replace(replace(replace(replace(replace(phone,
              '+', ''), '-', ''), ' ', ''), '(', ''), ')', '') = ?1
        AND (?2 IS NULL OR id <> ?2)
      LIMIT 1`
  )
    .bind(digits(values.phone), id)
    .first();

  if (clash) {
    return conflict(
      `This phone number already belongs to ${clash.name} (${clash.id}).`,
      { conflictsWith: clash.id, field: 'phone' }
    );
  }
  return null;
}

const routes = collectionRoutes({
  table: 'customers',
  columns: COLUMNS,
  toRecord,
  singular: 'customer',
  plural: 'customers',
});

// Deleting a customer who still has vehicles or job cards is blocked by the
// schema itself (both columns are ON DELETE RESTRICT), so there is no
// beforeDelete here: the constraint raises and collection-write maps it to a
// 409. Re-checking it in JS would be a second copy of a rule the database
// already owns.
const writes = collectionWrite({
  table: 'customers',
  columns: COLUMNS,
  toRecord,
  singular: 'customer',
  plural: 'customers',
  collection: 'customers',
  readFields,
  beforeWrite,
});

export const listCustomers = routes.list;
export const getCustomer = routes.detail;
export const createCustomer = writes.create;
export const updateCustomer = writes.update;
export const deleteCustomer = writes.remove;
