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

const routes = collectionRoutes({
  table: 'customers',
  columns: COLUMNS,
  toRecord,
  singular: 'customer',
  plural: 'customers',
});

export const listCustomers = routes.list;
export const getCustomer = routes.detail;
