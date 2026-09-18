/* ============================================================
   routes/expenses.js — GET /api/expenses[/:id]   (read-only)
   ------------------------------------------------------------
   The workshop's operating-cost ledger: rent, utilities, wages,
   tools, parts purchases. A flat table with no foreign keys, no
   child lines, and nothing referencing it — the only collection in
   this API that stands entirely alone — so it goes straight
   through lib/collection.js with nothing to add.

   ---- amounts are stored, totals are not ----

   Each row's `amount` is a stored historical fact. The figures the
   app shows on top of them are not stored anywhere: reports.js
   builds total, byCategory, byMethod, byDay and the Net Result at
   render time (reports.js:130-144), and dashboard.js sums today's
   expenses the same way (:19). This route returns rows, not
   aggregates. Shipping a total here would define it a second time,
   and the definition is not trivial — the Net Result banner spells
   out that it is "Collected Revenue − Active Expenses", a
   management indicator rather than an accounting profit.

   ---- Void rows are returned, not filtered ----

   voidExpense() only flips status to 'Void'; the amount and every
   other field stay exactly as they were, and the row stays in the
   table. Both reports.js and dashboard.js filter `status !== 'Void'`
   themselves before summing.

   This route deliberately does NOT apply that filter. Excluding
   Void rows would make an expense that exists in the database
   invisible through the API, and would move the decision of what
   counts as spending out of the consumer that already makes it. A
   caller that wants active spending filters on `status`, exactly as
   the two existing consumers do.

   ---- category is not constrained ----

   Unlike appointments.source and payments.method, which carry CHECK
   constraints, expenses.category is a plain TEXT column: the
   sixteen categories live in expenses.js's own CATEGORIES array and
   are enforced by its form, not by the database. So whatever string
   a row holds is returned verbatim, including one the current list
   no longer offers. Validating against the frontend's list here
   would reject data the database accepts.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum, readDate } from '../lib/write.js';
import { conflict } from '../lib/http.js';

const COLUMNS = `
  id, date, category, description, amount, method,
  payee, reference, notes, status, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * payee, reference and notes are the only nullable columns and all three fall
 * back to '': they are text the UI renders directly, and expenses.js itself
 * stores `(payee || '').trim()` rather than null, so '' is what a record
 * written by the app already contains.
 *
 * `amount` is NOT NULL with CHECK (amount > 0), so it always arrives as a
 * positive number — there is no zero-versus-null question here, the same as
 * payments and unlike every other money column in this schema.
 *
 * `date` is a local calendar day and is passed straight through: no Date
 * parsing, no toISOString(), no timezone maths, for the reason audit Finding 2
 * recorded.
 */
function toRecord(row) {
  return {
    id: row.id,
    date: row.date,                 // local calendar day, verbatim
    category: row.category,         // no CHECK in the schema — returned as stored
    description: row.description,
    amount: row.amount,             // stored, never aggregated or recomputed
    method: row.method,
    payee: row.payee ?? '',
    reference: row.reference ?? '',
    notes: row.notes ?? '',
    status: row.status,             // Active | Void, returned, never filtered on
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/* ---------- writes ----------------------------------------------------- */

// The four the column's CHECK allows. expenses.js offers the same four.
const METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];
const STATUSES = ['Active', 'Void'];

/**
 * An expense is editable in only two ways in the app, and the API matches
 * that exactly rather than inventing a general edit:
 *
 *   notes   expenses.js:325 — the one field the edit dialog writes
 *   status  expenses.js:89  — voidExpense(), which flips status and nothing
 *                             else, leaving the amount intact
 *
 * Every other column is a financial fact recorded when the money moved.
 * Allowing a PUT to change an amount or a date after the fact would be a new
 * financial workflow, which C-2 is not. A body that tries is refused by name
 * rather than silently ignored, so a caller cannot believe it edited
 * something it did not.
 */
const UPDATABLE = ['notes', 'status'];

function readFields(body, mode) {
  const f = fieldSet(body, mode);

  if (mode === 'update') {
    for (const key of Object.keys(body)) {
      if (!UPDATABLE.includes(key)) {
        f.reject(key, `\`${key}\` cannot be changed after an expense is recorded.`);
      }
    }
    f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
    f.take('status', 'status', readEnum(body, 'status', STATUSES));
    // Void is a one-way door: expenses.js has no un-void, and reinstating a
    // cancelled expense would silently change every total that excluded it.
    if (f.values.status === 'Active') {
      f.reject('status', 'An expense cannot be moved back to Active once voided.');
    }
    return f;
  }

  f.take('date', 'date', readDate(body, 'date', { required: true }));
  f.take('category', 'category', readString(body, 'category', { required: true, max: 80 }));
  f.take('description', 'description', readString(body, 'description', { required: true, max: 500 }));
  // CHECK (amount > 0): zero is not a valid expense, which is why this is the
  // one money field in the schema with no zero case to preserve.
  f.take('amount', 'amount', readNumber(body, 'amount', { required: true, min: 0.01 }));
  f.take('method', 'method', readEnum(body, 'method', METHODS, { required: true }));
  f.take('payee', 'payee', readString(body, 'payee', { max: 160 }));
  f.take('reference', 'reference', readString(body, 'reference', { max: 120 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));
  // Always created Active; voiding is a separate, later act.
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  return f;
}

/**
 * expenses.js:356 — an active expense is a live financial record and cannot be
 * deleted; it has to be voided first, and only then removed. Nothing in the
 * schema says so (expenses has no foreign keys in either direction), so this
 * rule exists only here.
 */
async function beforeDelete(env, id) {
  const row = await env.DB.prepare('SELECT status FROM expenses WHERE id = ?1')
    .bind(id)
    .first();
  if (!row) return null;                       // let the DELETE report the 404

  if (row.status !== 'Void') {
    return conflict(
      'This is an active financial record. Void it first if it needs to be removed from the books.',
      { reason: 'expense_is_active', status: row.status }
    );
  }
  return null;
}

const routes = collectionRoutes({
  table: 'expenses',
  columns: COLUMNS,
  toRecord,
  singular: 'expense',
  plural: 'expenses',
});

const writes = collectionWrite({
  table: 'expenses',
  columns: COLUMNS,
  toRecord,
  singular: 'expense',
  plural: 'expenses',
  collection: 'expenses',
  readFields,
  beforeDelete,
});

export const listExpenses = routes.list;
export const getExpense = routes.detail;
export const createExpense = writes.create;
export const updateExpense = writes.update;
export const deleteExpense = writes.remove;
