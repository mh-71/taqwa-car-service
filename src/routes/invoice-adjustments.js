/* ============================================================
   routes/invoice-adjustments.js — write-offs (0002)
   ------------------------------------------------------------
   GET  /api/invoice-adjustments[/:id]
   POST /api/invoice-adjustments
   POST /api/invoice-adjustments/:id/void

   A write-off waives part of an invoice's outstanding balance after
   the invoice was issued. It is recorded here, one row per decision,
   and it is NOT a payment:

     * the invoice's total, tax and discount stay as issued;
     * payments stay the only record of cash, so `paid`, Revenue and
       every "collected" figure are untouched by anything here;
     * the invoice's written_off/due/status are recomputed from its
       payments AND its Active write-offs by recomputeInvoice() in
       payments.js -- the one home of that formula.

   ---- the five things this route must get right ----

   1. NOTHING FINANCIAL COMES FROM THE CLIENT. The customer, the date,
      due_before and due_after are all derived by the server, the
      dates in the workshop's calendar. A request names the invoice,
      the amount, the reason and the due it was shown -- nothing else.

   2. THE CHECKS ARE PART OF THE WRITE. Not Void, the due the user saw
      (`expectedDue`), amount <= due, and payments + write-offs +
      amount <= total are all in the INSERT's own WHERE, so two
      concurrent requests -- a payment and a write-off, or the same
      write-off sent twice -- cannot both take the same room. The
      second one simply matches nothing.

   3. ONE BATCH. The adjustment and the invoice's new balance move
      together; the recompute is conditional on the adjustment having
      been written.

   4. NEVER DELETED, NEVER EDITED. A write-off is reversed by voiding
      it, with a reason, and the invoice is recomputed. There is no PUT
      and no DELETE, so the router answers 405 for both.

   5. A VOID INVOICE IS FROZEN. Nothing can be written off against it
      and none of its write-offs can be reversed: like its paid/due,
      they are the historical record of a cancelled document.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import {
  ok, fail, methodNotAllowed, noDatabase, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { recomputeInvoice } from './payments.js';

const VOID = 'Void';
const ACTIVE = 'Active';
const TYPES = ['write_off'];
/** Equality tolerance for money, the schema's own rule for REAL amounts. */
const MONEY_EPSILON = 0.005;

const COLUMNS = `
  id, invoice_id, customer_id, type, amount, reason, date,
  due_before, due_after, status, recorded_by, void_reason, voided_at,
  created_at, updated_at
`;

/** One D1 row -> the record shape the UI reads. */
function toRecord(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    type: row.type,
    amount: row.amount,
    reason: row.reason,
    date: row.date,                 // workshop calendar day, verbatim
    dueBefore: row.due_before,
    dueAfter: row.due_after,
    status: row.status,             // Active | Void
    recordedBy: row.recorded_by ?? '',
    voidReason: row.void_reason ?? '',
    voidedAt: row.voided_at ?? null,
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'invoice_adjustments',
  columns: COLUMNS,
  toRecord,
  singular: 'invoice adjustment',
  plural: 'invoice adjustments',
});

export const listInvoiceAdjustments = routes.list;
export const getInvoiceAdjustment = routes.detail;

/**
 * Fields the server owns. Refused by name rather than ignored, so a caller
 * cannot believe it set a figure the server decided. `date` is here because
 * the first version records write-offs on today's date only: no backdating.
 */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  customerId: '`customerId` is taken from the invoice.',
  status: '`status` is set by the server. Use the void operation to reverse a write-off.',
  dueBefore: '`dueBefore` is calculated by the server.',
  dueAfter: '`dueAfter` is calculated by the server.',
  voidReason: '`voidReason` is set by the void operation.',
  voidedAt: '`voidedAt` is set by the void operation.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  date: '`date` is set by the server: a write-off is recorded on today’s date.',
};

/**
 * One invoice's live balance, as SQL, for the invoice the statement binds as
 * `param`. pay_sum/adj_sum are the Active payments and write-offs; `due` is
 * recomputeInvoice()'s formula exactly, so the due this route checks is the
 * due the recompute will write.
 */
const liveBalance = (param) => `
  SELECT i.id, i.customer_id, i.status, i.total, b.pay_sum, b.adj_sum,
         MAX(i.total - MIN(i.total, MAX(0, b.pay_sum))
                     - MIN(i.total - MIN(i.total, MAX(0, b.pay_sum)), MAX(0, b.adj_sum)), 0) AS due
    FROM invoices i,
         (SELECT (SELECT COALESCE(SUM(amount), 0) FROM payments
                   WHERE invoice_id = ${param} AND status <> '${VOID}') AS pay_sum,
                 (SELECT COALESCE(SUM(amount), 0) FROM invoice_adjustments
                   WHERE invoice_id = ${param} AND status <> '${VOID}') AS adj_sum) b
   WHERE i.id = ${param}`;

/** The record a successful write reports — identical to what a GET returns. */
async function respondWithAdjustment(env, id, status) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM invoice_adjustments WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) {
    console.error(`Invoice adjustment ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the write-off back.', 500);
  }
  return ok(toRecord(row), {}, status);
}

/**
 * Why a write-off was refused. Run ONLY when the guarded INSERT matched
 * nothing, so the happy path costs nothing -- the same division payments use.
 */
async function explainRefusal(env, invoiceId, amount, expectedDue) {
  const row = await env.DB.prepare(liveBalance('?1')).bind(invoiceId).first();
  if (!row) {
    return conflict('That invoice no longer exists.', { reason: 'invoice_not_found', invoiceId });
  }
  if (row.status === VOID) {
    return conflict('Cannot write off a balance on a Void invoice.', { reason: 'invoice_void', invoiceId });
  }
  const due = Math.max(Number(row.due) || 0, 0);
  if (Math.abs(due - expectedDue) >= MONEY_EPSILON) {
    return conflict(
      `The invoice balance has changed. Outstanding due is now ${due}.`,
      { reason: 'stale_balance', invoiceId, currentDue: due, expectedDue }
    );
  }
  if (amount > due
      || (Number(row.pay_sum) || 0) + (Number(row.adj_sum) || 0) + amount > (Number(row.total) || 0)) {
    return conflict(
      `The write-off cannot exceed the outstanding due of ${due}.`,
      { reason: 'over_adjustment', invoiceId, outstandingDue: due, amount }
    );
  }
  return conflict('This invoice was changed by another request. Reload it and try again.',
    { reason: 'concurrent_modification', invoiceId });
}

/* ---------------------------------------------------------------
   POST /api/invoice-adjustments
   --------------------------------------------------------------- */

/**
 * POST /api/invoice-adjustments
 *
 * Write off part or all of an invoice's outstanding due. The body names the
 * invoice, the amount, the reason and `expectedDue` -- the due the user was
 * shown -- and may name `recordedBy` and `type` ('write_off', the only type).
 */
export async function createInvoiceAdjustment(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }
  const invoiceId = readString(b, 'invoiceId', { required: true, max: 32 });
  if (invoiceId.error) errors.invoiceId = invoiceId.error;
  const type = readEnum(b, 'type', TYPES, { fallback: 'write_off' });
  if (type.error) errors.type = type.error;
  const amount = readNumber(b, 'amount', { required: true });
  if (amount.error) errors.amount = amount.error;
  else if (!(amount.value > 0)) errors.amount = 'Amount must be greater than 0.';
  const reason = readString(b, 'reason', { required: true, max: 500 });
  if (reason.error) errors.reason = reason.error;
  const expectedDue = readNumber(b, 'expectedDue', { required: true, min: 0 });
  if (expectedDue.error) errors.expectedDue = expectedDue.error;
  const recordedBy = readString(b, 'recordedBy', { max: 100 });
  if (recordedBy.error) errors.recordedBy = recordedBy.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some write-off fields are not valid.', errors);
  }

  const allocated = await allocateId(env, 'invoiceAdjustments');
  if (allocated.error) {
    console.error('POST /api/invoice-adjustments could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not record the write-off.', 500);
  }
  const at = nowIso();

  // ?1 id  ?2 invoice  ?3 type  ?4 amount  ?5 reason  ?6 date
  // ?7 recorded_by  ?8 created_at  ?9 expectedDue
  const statements = [
    env.DB.prepare(
      `INSERT INTO invoice_adjustments
         (id, invoice_id, customer_id, type, amount, reason, date,
          due_before, due_after, status, recorded_by, created_at)
       SELECT ?1, l.id, l.customer_id, ?3, ?4, ?5, ?6,
              l.due, l.due - ?4, '${ACTIVE}', ?7, ?8
         FROM (${liveBalance('?2')}) l
        WHERE l.status <> '${VOID}'
          AND ABS(l.due - ?9) < ${MONEY_EPSILON}
          AND ?4 <= l.due
          AND l.pay_sum + l.adj_sum + ?4 <= l.total`
    ).bind(
      allocated.id, invoiceId.value, type.value, amount.value, reason.value,
      todayInDhaka(), recordedBy.value || null, at, expectedDue.value,
    ),
    recomputeInvoice(env, {
      invoiceId: invoiceId.value, at,
      guard: 'EXISTS (SELECT 1 FROM invoice_adjustments WHERE id = ?3)',
      guardBinds: [allocated.id],
    }),
  ];

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-adjustments failed:', err);
    return fail('database_error', 'Could not record the write-off.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // The guard matched nothing, so nothing was written -- not the
    // adjustment and, because it is conditional on it, not the balance.
    return explainRefusal(env, invoiceId.value, amount.value, expectedDue.value);
  }

  return respondWithAdjustment(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   POST /api/invoice-adjustments/:id/void
   --------------------------------------------------------------- */

/**
 * POST /api/invoice-adjustments/:id/void
 *
 * Reverse a write-off. The row is kept -- amount, reason and snapshots
 * untouched -- and only its status moves to Void, with the reason and time.
 * The invoice is then recomputed from what is left, so its due rises again.
 *
 * The status UPDATE carries `AND status = 'Active'` and the invoice's own
 * status, and is the gate: two concurrent reversals cannot both apply, and a
 * write-off on an invoice voided in the meantime is left alone.
 */
export async function voidInvoiceAdjustment(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const key of Object.keys(b)) {
    if (key !== 'voidReason') errors[key] = `\`${key}\` is not a field of the void operation.`;
  }
  const voidReason = readString(b, 'voidReason', { required: true, max: 500 });
  if (voidReason.error) errors.voidReason = voidReason.error;
  if (Object.keys(errors).length) {
    return unprocessable('Some void fields are not valid.', errors);
  }

  const adj = await env.DB.prepare(
    `SELECT a.id, a.status, a.invoice_id, i.status AS invoice_status
       FROM invoice_adjustments a LEFT JOIN invoices i ON i.id = a.invoice_id
      WHERE a.id = ?1`
  ).bind(id.value).first();
  if (!adj) return fail('not_found', 'Write-off not found.', 404);
  if (adj.status === VOID) {
    return conflict('This write-off is already reversed.', { reason: 'adjustment_void' });
  }
  if (adj.invoice_status === VOID) {
    return conflict('The invoice is Void, so its write-offs are frozen.',
      { reason: 'invoice_void', invoiceId: adj.invoice_id });
  }

  const at = nowIso();
  let results;
  try {
    results = await env.DB.batch([
      // THE GATE.
      env.DB.prepare(
        `UPDATE invoice_adjustments
            SET status = '${VOID}', void_reason = ?2, voided_at = ?3, updated_at = ?3
          WHERE id = ?1
            AND status = '${ACTIVE}'
            AND (SELECT status FROM invoices WHERE id = invoice_adjustments.invoice_id) <> '${VOID}'`
      ).bind(id.value, voidReason.value, at),
      recomputeInvoice(env, {
        invoiceId: adj.invoice_id, at,
        guard: `(SELECT status FROM invoice_adjustments WHERE id = ?3) = '${VOID}'`,
        guardBinds: [id.value],
      }),
    ]);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-adjustments/:id/void failed:', err);
    return fail('database_error', 'Could not reverse the write-off.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict('This write-off was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' });
  }

  return respondWithAdjustment(env, id.value, 200);
}
