/* ============================================================
   routes/payments.js — GET /api/payments[/:id]   (read-only)
   ------------------------------------------------------------
   The cash ledger. A flat table with no child lines, so unlike job
   cards and invoices this one goes straight through
   lib/collection.js: same fixed SQL, same one-row mapper, two
   queries for a list and one for a detail.

   ---- amount is a primary fact, and this route only reads it ----

   js/payments.js opens by saying "Payments are the SOURCE OF TRUTH
   for an Invoice's paid/due/status". An invoice's balance is derived
   from these rows; nothing derives these rows. So amount, date and
   method are returned exactly as stored, and nothing here computes
   an invoice balance, queries invoices, job cards or customers, or
   invents livePaid, due or invoiceStatus.

   That matters more here than anywhere else in this API, because
   payments is the one collection whose WRITE paths reach into
   another table: recomputeInvoiceBalance() rewrites an invoice's
   paid/due/status, and payments.js calls it on create (:153), link
   (:170), void (:181) and delete (:530) — every one a write, never
   a read. This module does not import it and has no write path at
   all, so a GET cannot move a single figure on an invoice.

   ---- three states that look alike and are not ----

   invoice_id and status are independent, which produces three
   records that read similarly and mean different things:

     * a linked payment      invoiceId set,  status Active
     * an advance            invoiceId null, status Active
     * a voided payment      invoiceId KEPT, status Void

   voidPayment() only flips the status; it leaves invoice_id,
   job_card_id and amount alone, and the invoice simply stops
   counting the row (sumActivePayments filters on status).

   A fourth state comes from the other direction: voiding an INVOICE
   releases its linked Active payments, setting invoice_id to NULL
   and inheriting the invoice's job card so Reports can still trace
   the collection to a mechanic. The result is an ordinary advance —
   invoiceId null, status Active — and nothing distinguishes it in
   storage from one recorded as an advance in the first place. So
   nothing distinguishes it here either: no isAdvance, no
   paymentType, no releasedFromInvoice. The stored columns are the
   whole answer, and the UI already reads them that way
   (payments.js:280 shows an Advance badge for a falsy invoiceId).
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';

const COLUMNS = `
  id, invoice_id, customer_id, job_card_id,
  date, amount, method, status, notes, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * invoice_id and job_card_id fall back to null rather than '': both are
 * checked for truthiness by the UI (payments.js:280-281) so either would
 * render the same, but '' is not an identifier and the foreign key would
 * reject it on write. null is also what payments.js itself stores —
 * recordPayment() writes `invoiceId || null` and `jobCardId || null`.
 *
 * `notes` falls back to '' because it is prose the UI renders directly, and
 * because recordPayment() stores `(notes || '').trim()` rather than null.
 *
 * `amount` is NOT NULL with CHECK (amount > 0), so it always arrives as a
 * positive number — there is no zero-versus-null question here, unlike every
 * other money column in this schema.
 */
function toRecord(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id ?? null,
    customerId: row.customer_id,
    jobCardId: row.job_card_id ?? null,
    date: row.date,                 // local calendar day, verbatim
    amount: row.amount,             // stored, never recomputed
    method: row.method,
    status: row.status,             // Active | Void, stored
    notes: row.notes ?? '',
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'payments',
  columns: COLUMNS,
  toRecord,
  singular: 'payment',
  plural: 'payments',
});

export const listPayments = routes.list;
export const getPayment = routes.detail;
