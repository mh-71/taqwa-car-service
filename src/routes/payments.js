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
import {
  ok, fail, methodNotAllowed, noDatabase, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readOptionalBody, readString, readNumber, readEnum, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';

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

/* ============================================================
   C-8 — the write half
   ------------------------------------------------------------
   POST /api/payments, PUT /api/payments/:id,
   POST /api/payments/:id/void, POST /api/payments/:id/link,
   DELETE /api/payments/:id.

   A port of js/payments.js, whose own header states the model:
   "Payments are the SOURCE OF TRUTH for an Invoice's
   paid/due/status." An invoice's balance is a cache of these rows,
   recomputed from scratch after every change -- "never trusted as
   a stale field."

   ---- the five things this route must get right ----

   1. OVERPAYMENT IS DECIDED BY THE DATABASE, NOT BY JAVASCRIPT.
      Reading the balance, subtracting in JS and inserting is a
      lost update: two concurrent payments both see the same room
      and both take it. So the guard is part of the write --
      `SUM(live payments) + amount <= total` inside the INSERT's
      own WHERE -- and meta.changes says whether it applied.

   2. THE RECOMPUTE IS ARITHMETIC IN SQL. paid, due and status are
      derived from SUM(amount) over the invoice's non-Void payments
      in one UPDATE, so they cannot be computed from a balance that
      has since moved. It is the exact expression
      recomputeInvoiceBalance() applies (:83-92), including its
      MIN/MAX clamps and its refusal to touch a Void invoice.

   3. EVERY OPERATION IS ONE BATCH. The payment row and the
      invoice's balance move together; the recompute is conditional
      on the payment mutation having landed, so a guard that
      matched nothing is never followed by a balance change.

   4. A JOB CARD'S paid/due ARE NEVER READ OR WRITTEN. They are the
      frozen pre-invoice snapshot (:22-24). No statement in this
      module names the job_cards table at all.

   5. HISTORY IS LOCKED. amount, date, method, customer, invoice and
      job card are fixed once written; only notes can be edited.
      Linking and voiding are their own operations, because each
      carries a rule a field assignment cannot.
   ============================================================ */

/* :34 — the four methods, and the column's own CHECK. */
const METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];
/* :151 — the method a payment falls back to when none is chosen. */
const DEFAULT_METHOD = 'Cash';
const VOID = 'Void';
const ACTIVE = 'Active';

/**
 * Fields the server owns. Refused by name rather than ignored, so a caller
 * cannot believe it set a status or a timestamp the server decided.
 *
 * `status` is here because a payment is born Active (:154) and leaves that
 * state only through the void operation, which has its own rule and its own
 * invoice recomputation. Letting a field assignment do it would put the same
 * rule in two places.
 */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  status: '`status` is set by the server. Use the void operation to cancel a payment.',
  paid: '`paid` is a figure on the invoice, not on a payment.',
  due: '`due` is a figure on the invoice, not on a payment.',
};

/**
 * What an invoice has actually been paid, as SQL.
 *
 * `MIN(total, MAX(0, SUM(...)))` is recomputeInvoiceBalance() (:88) exactly:
 * the sum of the invoice's non-Void payments, floored at zero and capped at
 * the invoice total. `total` is the column of the row being updated, so this
 * only ever appears inside a statement against `invoices`.
 *
 * It is written once and interpolated, rather than repeated by hand, so the
 * four places that need it cannot drift apart. Nothing in it comes from a
 * request: `param` is a placeholder this module chose.
 */
const settled = (param) =>
  `MIN(total, MAX(0, (SELECT COALESCE(SUM(amount), 0)
                        FROM payments
                       WHERE invoice_id = ${param} AND status <> '${VOID}')))`;

/**
 * Rewrite one invoice's paid/due/status from its live payments.
 *
 * The whole of recomputeInvoiceBalance(), in one statement:
 *
 *   paid    the settled figure above
 *   due     total - paid, floored at zero
 *   status  deriveInvoiceStatus(): Paid when the total is positive and
 *           covered, Partial when anything is paid, else Unpaid (:51-57)
 *
 * A VOID INVOICE IS NEVER TOUCHED (:86). Its figures are frozen at what it
 * had collected before it was cancelled -- audit Finding 7's other half --
 * and a payment change must not reactivate them.
 *
 * `guard` is what makes this conditional on the payment mutation in the same
 * batch having actually happened. Statements in a batch share one
 * transaction, so it can read the row the previous statement wrote.
 */
function recomputeInvoice(env, { invoiceId, at, guard, guardBinds = [] }) {
  const paid = settled('?1');
  return env.DB.prepare(
    `UPDATE invoices
        SET paid       = ${paid},
            due        = MAX(total - ${paid}, 0),
            status     = CASE WHEN total > 0 AND ${paid} >= total THEN 'Paid'
                              WHEN ${paid} > 0                    THEN 'Partial'
                              ELSE 'Unpaid' END,
            updated_at = ?2
      WHERE id = ?1
        AND status <> '${VOID}'
        AND ${guard}`
  ).bind(invoiceId, at, ...guardBinds);
}

/**
 * Why a payment against an invoice was refused.
 *
 * Run ONLY when the guarded write matched nothing, so the happy path costs
 * nothing -- the same division C-4 established. One query answers all four of
 * validatePayment()'s invoice rules (:113-124), with the client's own wording.
 */
async function explainInvoiceRefusal(env, invoiceId, customerId, amount) {
  const row = await env.DB.prepare(
    `SELECT i.status, i.customer_id, i.total,
            (SELECT COALESCE(SUM(amount), 0) FROM payments
              WHERE invoice_id = ?1 AND status <> '${VOID}') AS settled
       FROM invoices i WHERE i.id = ?1`
  ).bind(invoiceId).first();

  if (!row) {
    return conflict('That invoice no longer exists.', { reason: 'invoice_not_found', invoiceId });
  }
  if (row.status === VOID) {
    return conflict('Cannot record a payment against a Void invoice.',
      { reason: 'invoice_void', invoiceId });
  }
  if (row.customer_id !== customerId) {
    return conflict('This invoice belongs to a different customer.',
      { reason: 'customer_mismatch', invoiceId });
  }
  // :121-123 — the overpayment refusal, reporting the live outstanding due.
  const liveDue = Math.max((Number(row.total) || 0) - (Number(row.settled) || 0), 0);
  return conflict(
    `This would overpay the invoice. Outstanding due is ${liveDue}.`,
    { reason: 'overpayment', invoiceId, outstandingDue: liveDue, amount }
  );
}

/** The record a successful write reports — identical to what a GET returns. */
async function respondWithPayment(env, id, status) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM payments WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) {
    console.error(`Payment ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the payment back.', 500);
  }
  return ok(toRecord(row), {}, status);
}

/* ---------------------------------------------------------------
   POST /api/payments
   --------------------------------------------------------------- */

/**
 * POST /api/payments
 *
 * Record a payment, either against an invoice or as an ADVANCE with no
 * invoice yet (:11-13). Both shapes come through here, exactly as
 * recordPayment() takes them; the form's own rule that a payment is either
 * invoice-linked OR job-card-tagged is a rule of the FORM (:412-413), not of
 * recordPayment(), so it is not reproduced -- and a released advance that is
 * later linked really does carry both.
 *
 * ---- the overpayment guard ----
 *
 * validatePayment() refuses an amount larger than the live outstanding due
 * (:118-124). Checking that in JavaScript and then inserting would let two
 * concurrent payments both pass, so the check IS the insert's WHERE clause:
 * the row is produced only while the invoice still exists, is not Void,
 * belongs to this customer, and has room for the amount. Whichever request
 * reaches the database second sees the first one's row in the sum.
 */
export async function createPayment(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }

  const customerId = readString(b, 'customerId', { required: true, max: 32 });
  if (customerId.error) errors.customerId = customerId.error;

  // :139 — `invoiceId || null` and `jobCardId || null`: blank means absent.
  const invoiceId = readString(b, 'invoiceId', { max: 32, fallback: '' });
  if (invoiceId.error) errors.invoiceId = invoiceId.error;
  const jobCardId = readString(b, 'jobCardId', { max: 32, fallback: '' });
  if (jobCardId.error) errors.jobCardId = jobCardId.error;

  // :103-104 — `!amt || amt <= 0` rejects zero, negatives and anything that
  // is not a number. The column's own CHECK says the same thing.
  const amount = readNumber(b, 'amount', { required: true });
  if (amount.error) errors.amount = amount.error;
  else if (!(amount.value > 0)) errors.amount = 'Amount must be greater than 0.';

  // :149 — the date the money arrived; today, in the WORKSHOP's calendar,
  // when none is given. Utils.todayStr() reads the browser's local day.
  const date = readDate(b, 'date', { fallback: '' });
  if (date.error) errors.date = date.error;

  // :151 — `METHODS.includes(method) ? method : 'Cash'`. Absent or blank
  // really does mean Cash, and that is preserved. A method that is neither
  // absent nor one of the four is REFUSED rather than silently turned into
  // Cash: the form is a <select> and cannot produce one, so no existing
  // behaviour changes, and quietly filing money under the wrong method is
  // not a thing an API should do on a caller's behalf.
  const method = readEnum(b, 'method', METHODS, { fallback: DEFAULT_METHOD });
  if (method.error) errors.method = method.error;

  const notes = readString(b, 'notes', { max: 1000 });
  if (notes.error) errors.notes = notes.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some payment fields are not valid.', errors);
  }

  const allocated = await allocateId(env, 'payments');
  if (allocated.error) {
    console.error('POST /api/payments could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not record the payment.', 500);
  }

  const at = nowIso();
  const values = [
    allocated.id,
    invoiceId.value || null,
    customerId.value,
    jobCardId.value || null,
    date.value || todayInDhaka(),
    amount.value,
    method.value,
    notes.value,
    at,
  ];

  // An advance touches no invoice at all, so it has nothing to guard against
  // and nothing to recompute (:155). It is a plain insert.
  const statements = [];
  if (!invoiceId.value) {
    statements.push(env.DB.prepare(
      `INSERT INTO payments
         (id, invoice_id, customer_id, job_card_id, date, amount, method, status, notes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '${ACTIVE}', ?8, ?9)`
    ).bind(...values));
  } else {
    statements.push(env.DB.prepare(
      `INSERT INTO payments
         (id, invoice_id, customer_id, job_card_id, date, amount, method, status, notes, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, '${ACTIVE}', ?8, ?9
        WHERE EXISTS (
          SELECT 1 FROM invoices i
           WHERE i.id          = ?2
             AND i.status     <> '${VOID}'
             AND i.customer_id = ?3
             AND (SELECT COALESCE(SUM(amount), 0) FROM payments
                   WHERE invoice_id = ?2 AND status <> '${VOID}') + ?6 <= i.total)`
    ).bind(...values));
    statements.push(recomputeInvoice(env, {
      invoiceId: invoiceId.value, at,
      guard: 'EXISTS (SELECT 1 FROM payments WHERE id = ?3)',
      guardBinds: [allocated.id],
    }));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/payments failed:', err);
    return fail('database_error', 'Could not record the payment.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // The guard matched nothing, so nothing was written -- not the payment
    // and, because it is conditional on the payment, not the balance either.
    return explainInvoiceRefusal(env, invoiceId.value, customerId.value, amount.value);
  }

  return respondWithPayment(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   PUT /api/payments/:id
   --------------------------------------------------------------- */

/**
 * PUT /api/payments/:id
 *
 * Notes, and nothing else.
 *
 * The module header is explicit: "Once created, a Payment's
 * amount/date/method/invoiceId/jobCardId are locked. Only `notes` stays
 * editable." openNotesModal() (:473-490) is the whole edit surface and writes
 * exactly one column, on an Active payment and a Void one alike.
 *
 * Linking is refused here rather than ignored: it has a customer rule, an
 * overpayment rule and an invoice recomputation behind it, and it lives at
 * its own endpoint so none of that can be bypassed by a field assignment.
 */
export async function updatePayment(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }
  // :17-19 — the historical fields, each named so a caller is told which rule
  // it met rather than being quietly ignored.
  for (const [key, message] of Object.entries({
    amount: '`amount` is a historical figure and cannot be edited. Void the payment instead.',
    date: '`date` is a historical figure and cannot be edited. Void the payment instead.',
    method: '`method` is a historical figure and cannot be edited. Void the payment instead.',
    customerId: '`customerId` is fixed when the payment is recorded.',
    jobCardId: '`jobCardId` is fixed when the payment is recorded.',
    invoiceId: '`invoiceId` is changed by the link operation, not by an edit.',
  })) {
    if (b[key] !== undefined) errors[key] = message;
  }

  const notes = readString(b, 'notes', { max: 1000 });
  if (b.notes !== undefined && notes.error) errors.notes = notes.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some payment fields are not valid.', errors);
  }
  if (b.notes === undefined) {
    return unprocessable('No payment fields were supplied to update. Only `notes` can be edited.');
  }

  try {
    const row = await env.DB.prepare(
      `UPDATE payments SET notes = ?2, updated_at = ?3 WHERE id = ?1 RETURNING ${COLUMNS}`
    ).bind(id.value, notes.value, nowIso()).first();
    if (!row) return fail('not_found', 'No payment with that id.', 404);
    return ok(toRecord(row));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/payments/:id failed:', err);
    return fail('database_error', 'Could not update the payment.', 500);
  }
}

/* ---------------------------------------------------------------
   POST /api/payments/:id/link
   --------------------------------------------------------------- */

/**
 * POST /api/payments/:id/link
 *
 * Apply an existing advance to an invoice — linkPaymentToInvoice()
 * (:158-172). The body names the invoice, which is all the link modal
 * collects (:459).
 *
 * The three rules about the PAYMENT are checked first, because each has its
 * own message (:160-162): it must exist, it must not be Void, and it must not
 * already be linked. The rules about the INVOICE are the same four
 * validatePayment() applies on create, and they are enforced the same way --
 * inside the UPDATE's own WHERE, so two concurrent links cannot both find
 * room. The payment's own amount and customer are read from the row being
 * updated, never from the request, so a link cannot smuggle in a different
 * figure.
 */
export async function linkPayment(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const key of Object.keys(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = SERVER_OWNED[key];
  }
  for (const key of ['amount', 'date', 'method', 'customerId', 'jobCardId', 'notes']) {
    if (b[key] !== undefined) {
      errors[key] = `\`${key}\` is not a field of the link operation. It is taken from the payment.`;
    }
  }
  const invoiceId = readString(b, 'invoiceId', { required: true, max: 32 });
  if (invoiceId.error) errors.invoiceId = invoiceId.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some link fields are not valid.', errors);
  }

  const payment = await env.DB.prepare(
    'SELECT id, status, invoice_id, customer_id, amount FROM payments WHERE id = ?1'
  ).bind(id.value).first();
  // :160-162 — the client's own three refusals, in its own order.
  if (!payment) return fail('not_found', 'Payment not found.', 404);
  if (payment.status === VOID) {
    return conflict('Cannot link a voided payment.', { reason: 'payment_void' });
  }
  if (payment.invoice_id) {
    return conflict('This payment is already linked to an invoice.',
      { reason: 'payment_already_linked', invoiceId: payment.invoice_id });
  }

  const at = nowIso();
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE payments
            SET invoice_id = ?2, updated_at = ?3
          WHERE id          = ?1
            AND status     <> '${VOID}'
            AND invoice_id IS NULL
            AND EXISTS (
              SELECT 1 FROM invoices i
               WHERE i.id          = ?2
                 AND i.status     <> '${VOID}'
                 AND i.customer_id = payments.customer_id
                 AND (SELECT COALESCE(SUM(amount), 0) FROM payments p2
                       WHERE p2.invoice_id = ?2 AND p2.status <> '${VOID}')
                     + payments.amount <= i.total)`
      ).bind(id.value, invoiceId.value, at),
      recomputeInvoice(env, {
        invoiceId: invoiceId.value, at,
        guard: '(SELECT invoice_id FROM payments WHERE id = ?3) = ?1',
        guardBinds: [id.value],
      }),
    ]);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/payments/:id/link failed:', err);
    return fail('database_error', 'Could not link the payment.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return explainInvoiceRefusal(env, invoiceId.value, payment.customer_id, payment.amount);
  }

  return respondWithPayment(env, id.value, 200);
}

/* ---------------------------------------------------------------
   POST /api/payments/:id/void
   --------------------------------------------------------------- */

/**
 * POST /api/payments/:id/void
 *
 * Soft-cancel a payment — voidPayment() (:175-183).
 *
 * The money's own record is kept: amount, date, method, customer, invoice and
 * job card are all untouched, and only the status moves. What changes is that
 * the invoice stops counting it, which is why the linked invoice is
 * recomputed from what is left. An advance has no invoice and so has nothing
 * to recompute.
 *
 * The status UPDATE carries `AND status <> 'Void'` and is the gate, so two
 * concurrent voids cannot both take effect and the balance cannot be reduced
 * twice by the same payment.
 */
export async function voidPayment(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readOptionalBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const sent = Object.keys(body.value);
  if (sent.length) {
    return unprocessable('Voiding a payment takes no fields.',
      Object.fromEntries(sent.map((k) => [k, `\`${k}\` is not a field of the void operation.`])));
  }

  const payment = await env.DB.prepare(
    'SELECT id, status, invoice_id FROM payments WHERE id = ?1'
  ).bind(id.value).first();
  // :177-178 — the client's own two refusals.
  if (!payment) return fail('not_found', 'Payment not found.', 404);
  if (payment.status === VOID) {
    return conflict('Payment is already void.', { reason: 'payment_void', status: payment.status });
  }

  const at = nowIso();
  const statements = [
    // THE GATE.
    env.DB.prepare(
      `UPDATE payments SET status = '${VOID}', updated_at = ?2
        WHERE id = ?1 AND status <> '${VOID}'`
    ).bind(id.value, at),
  ];
  // :181 — only a linked payment moves an invoice.
  if (payment.invoice_id) {
    statements.push(recomputeInvoice(env, {
      invoiceId: payment.invoice_id, at,
      guard: `(SELECT status FROM payments WHERE id = ?3) = '${VOID}'`,
      guardBinds: [id.value],
    }));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/payments/:id/void failed:', err);
    return fail('database_error', 'Could not void the payment.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict('This payment was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' });
  }

  return respondWithPayment(env, id.value, 200);
}

/* ---------------------------------------------------------------
   DELETE /api/payments/:id
   --------------------------------------------------------------- */

/**
 * DELETE /api/payments/:id
 *
 * openDeleteModal() (:511-535) allows this only once a payment is already
 * Void: an Active one is a live financial record and must be voided first.
 *
 * The invoice is recomputed afterwards for the reason the client gives in its
 * own comment (:531-532) -- a Void payment is already excluded from the sum,
 * so this changes no figure, but it runs "in case void's recompute never
 * ran". The DELETE itself carries `AND status = 'Void'`, so the rule holds
 * even if the row changed between the check and the write.
 */
export async function deletePayment(request, env, rawId) {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const payment = await env.DB.prepare(
    'SELECT id, status, invoice_id FROM payments WHERE id = ?1'
  ).bind(id.value).first();
  if (!payment) return fail('not_found', 'No payment with that id.', 404);

  if (payment.status !== VOID) {
    return conflict(
      'This is an active financial record. Void it first if it needs to be removed from the books.',
      { reason: 'payment_active', status: payment.status }
    );
  }

  const at = nowIso();
  const statements = [
    env.DB.prepare(`DELETE FROM payments WHERE id = ?1 AND status = '${VOID}'`).bind(id.value),
  ];
  if (payment.invoice_id) {
    statements.push(recomputeInvoice(env, {
      invoiceId: payment.invoice_id, at,
      guard: 'NOT EXISTS (SELECT 1 FROM payments WHERE id = ?3)',
      guardBinds: [id.value],
    }));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('DELETE /api/payments/:id failed:', err);
    return fail('database_error', 'Could not delete the payment.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return fail('not_found', 'No payment with that id.', 404);
  }

  return ok({ id: id.value, deleted: true });
}
