/* ============================================================
   routes/invoice-refunds.js — refunds (0026)
   ------------------------------------------------------------
   GET  /api/invoice-refunds[/:id]
   POST /api/invoice-refunds
   POST /api/invoice-refunds/:id/void

   A refund is cash that was collected against an invoice and is
   RETURNED to the customer. It is recorded here, one row per
   decision, and it is NOT a payment and NOT a discount:

     * payments stay the record of cash received, so the invoice's
       `paid` is unchanged by a refund;
     * the invoice's payable amount is unchanged, and so is its due:
       giving cash back never creates a new debt;
     * the invoice's cached `refunded` total is recomputed from its
       Active refunds by recomputeInvoice() in payments.js, in the same
       batch. Net cash retained = paid - refunded.

   ---- the rules, all decided by the server ----

   1. NOTHING FINANCIAL COMES FROM THE CLIENT. The customer is taken
      from the invoice, the refundable balance is computed in SQL, and
      who issued the refund is the authenticated caller. A request
      names the invoice, the amount, the method, the reason, an
      optional date and notes, and `expectedRefundable` -- the balance
      the user was shown.

   2. THE CHECKS ARE PART OF THE WRITE. Not Void, the refundable
      balance the user saw, amount <= that balance (so Active refunds
      never exceed the cash collected), and a date not before the
      invoice's own are all in the INSERT's WHERE. Two concurrent
      refunds -- or the same one submitted twice -- cannot both take
      the same money: the second sees a different balance and matches
      nothing (409), so it is never recorded twice.

   3. ONE BATCH. The refund and the invoice's new totals move together.

   4. NEVER DELETED, NEVER EDITED. A refund is reversed by voiding it,
      with a reason; who reversed it and when are recorded. There is
      no PUT and no DELETE.

   5. A VOID INVOICE IS FROZEN. No refund can be issued against it and
      none of its refunds can be reversed. (An invoice with an Active
      refund cannot be voided in the first place: routes/invoices.js.)

   Money is checked to the paisa: at most two decimal places.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import {
  ok, fail, methodNotAllowed, noDatabase, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { actorOf } from '../lib/activity.js';
import { recomputeInvoice, liveInvoice } from './payments.js';

const VOID = 'Void';
const ACTIVE = 'Active';
/** The payment methods -- payments.method's CHECK, and the refund's. */
export const REFUND_METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];
/** Equality tolerance for money, the schema's own rule for REAL amounts. */
const MONEY_EPSILON = 0.005;

/** At most two decimal places: the currency's precision. */
export const isPaisa = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const COLUMNS = `
  id, invoice_id, customer_id, amount, method, reason, notes, date,
  refundable_before, refundable_after, status,
  created_by_kind, created_by_id, created_by_name,
  void_reason, voided_at, voided_by_id, voided_by_name,
  created_at, updated_at
`;

/** One D1 row -> the record shape the UI reads. */
function toRecord(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    amount: row.amount,
    method: row.method,
    reason: row.reason,
    notes: row.notes ?? '',
    date: row.date,                       // workshop calendar day, verbatim
    refundableBefore: row.refundable_before,
    refundableAfter: row.refundable_after,
    status: row.status,                   // Active | Void
    processedBy: row.created_by_name,
    processedByKind: row.created_by_kind,
    processedById: row.created_by_id ?? null,
    voidReason: row.void_reason ?? '',
    voidedAt: row.voided_at ?? null,
    voidedBy: row.voided_by_name ?? '',
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'invoice_refunds',
  columns: COLUMNS,
  toRecord,
  singular: 'refund',
  plural: 'refunds',
});

export const listInvoiceRefunds = routes.list;
export const getInvoiceRefund = routes.detail;

/** Fields the server owns, refused by name so a caller cannot believe it set them. */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  customerId: '`customerId` is taken from the invoice.',
  status: '`status` is set by the server. Use the void operation to reverse a refund.',
  refundableBefore: '`refundableBefore` is calculated by the server.',
  refundableAfter: '`refundableAfter` is calculated by the server.',
  processedBy: '`processedBy` is the signed-in user.',
  processedByKind: '`processedByKind` is the signed-in user.',
  processedById: '`processedById` is the signed-in user.',
  voidReason: '`voidReason` is set by the void operation.',
  voidedAt: '`voidedAt` is set by the void operation.',
  voidedBy: '`voidedBy` is set by the void operation.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
};
const ACCEPTED = new Set(['invoiceId', 'amount', 'method', 'reason', 'notes', 'date', 'expectedRefundable']);

/** The record a successful write reports — identical to what a GET returns. */
async function respondWithRefund(env, id, status) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM invoice_refunds WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) {
    console.error(`Refund ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the refund back.', 500);
  }
  return ok(toRecord(row), {}, status);
}

/** Why a refund was refused. Run ONLY when the guarded INSERT matched nothing. */
async function explainRefusal(env, invoiceId, amount, expected, date) {
  const row = await env.DB.prepare(liveInvoice('?1')).bind(invoiceId).first();
  if (!row) {
    return conflict('That invoice no longer exists.', { reason: 'invoice_not_found', invoiceId });
  }
  if (row.status === VOID) {
    return conflict('Cannot refund against a Void invoice.', { reason: 'invoice_void', invoiceId });
  }
  const refundable = Math.max(Math.round((Number(row.refundable) || 0) * 100) / 100, 0);
  if (Math.abs(refundable - expected) >= MONEY_EPSILON) {
    return conflict(
      `The invoice has changed. The refundable amount is now ${refundable}.`,
      { reason: 'stale_balance', invoiceId, refundable, expectedRefundable: expected }
    );
  }
  if (refundable <= 0) {
    return conflict('Nothing has been collected on this invoice that could be refunded.',
      { reason: 'nothing_to_refund', invoiceId, refundable });
  }
  if (amount > refundable + 1e-9) {
    return conflict(
      `The refund cannot exceed the refundable amount of ${refundable}.`,
      { reason: 'over_refund', invoiceId, refundable, amount }
    );
  }
  if (date < row.date) {
    return conflict(`The refund date cannot be before the invoice date (${row.date}).`,
      { reason: 'date_before_invoice', invoiceId, invoiceDate: row.date });
  }
  return conflict('This invoice was changed by another request. Reload it and try again.',
    { reason: 'concurrent_modification', invoiceId });
}

/* ---------------------------------------------------------------
   POST /api/invoice-refunds
   --------------------------------------------------------------- */

export async function createInvoiceRefund(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const actor = actorOf(request);
  if (!actor) return fail('unauthorized', 'Authentication required.', 401);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const key of Object.keys(b)) {
    if (SERVER_OWNED[key]) errors[key] = SERVER_OWNED[key];
    else if (!ACCEPTED.has(key)) errors[key] = `\`${key}\` is not a field of a refund.`;
  }
  const invoiceId = readString(b, 'invoiceId', { required: true, max: 32 });
  if (invoiceId.error) errors.invoiceId = invoiceId.error;
  const amount = readNumber(b, 'amount', { required: true });
  if (amount.error) errors.amount = amount.error;
  else if (!(amount.value > 0)) errors.amount = 'The refund amount must be greater than 0.';
  else if (!isPaisa(amount.value)) errors.amount = 'The refund amount can have at most 2 decimal places.';
  const method = readEnum(b, 'method', REFUND_METHODS, { required: true });
  if (method.error) errors.method = method.error;
  const reason = readString(b, 'reason', { required: true, max: 500 });
  if (reason.error) errors.reason = reason.error;
  const notes = readString(b, 'notes', { max: 1000 });
  if (notes.error) errors.notes = notes.error;
  const today = todayInDhaka();
  const date = readDate(b, 'date', { fallback: today });
  if (date.error) errors.date = date.error;
  else if (date.value > today) errors.date = 'The refund date cannot be in the future.';
  const expected = readNumber(b, 'expectedRefundable', { required: true, min: 0 });
  if (expected.error) errors.expectedRefundable = expected.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some refund fields are not valid.', errors);
  }

  const allocated = await allocateId(env, 'invoiceRefunds');
  if (allocated.error) {
    console.error('POST /api/invoice-refunds could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not record the refund.', 500);
  }
  const at = nowIso();

  // ?1 id  ?2 invoice  ?3 amount  ?4 method  ?5 reason  ?6 notes  ?7 date
  // ?8 created_at  ?9 expectedRefundable  ?10 actor kind  ?11 actor id  ?12 actor name
  const statements = [
    env.DB.prepare(
      `INSERT INTO invoice_refunds
         (id, invoice_id, customer_id, amount, method, reason, notes, date,
          refundable_before, refundable_after, status,
          created_by_kind, created_by_id, created_by_name, created_at)
       SELECT ?1, l.id, l.customer_id, ?3, ?4, ?5, ?6, ?7,
              ROUND(l.refundable, 2), ROUND(l.refundable - ?3, 2), '${ACTIVE}',
              ?10, ?11, ?12, ?8
         FROM (${liveInvoice('?2')}) l
        WHERE l.status <> '${VOID}'
          AND ABS(ROUND(l.refundable, 2) - ?9) < ${MONEY_EPSILON}
          AND ?3 <= ROUND(l.refundable, 2)
          AND ?7 >= l.date`
    ).bind(
      allocated.id, invoiceId.value, amount.value, method.value, reason.value,
      notes.value || null, date.value, at, expected.value,
      actor.kind, actor.accountId, actor.name,
    ),
    recomputeInvoice(env, {
      invoiceId: invoiceId.value, at,
      guard: 'EXISTS (SELECT 1 FROM invoice_refunds WHERE id = ?3)',
      guardBinds: [allocated.id],
    }),
  ];

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-refunds failed:', err);
    return fail('database_error', 'Could not record the refund.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // The guard matched nothing, so nothing was written -- not the refund
    // and, because it is conditional on it, not the invoice's totals.
    return explainRefusal(env, invoiceId.value, amount.value, expected.value, date.value);
  }

  return respondWithRefund(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   POST /api/invoice-refunds/:id/void
   --------------------------------------------------------------- */

/**
 * Reverse a refund (it was recorded by mistake, or the money came back). The
 * row is kept with its amount, reason and snapshots; only its status moves to
 * Void, with the reason, the time and who did it. The invoice's refunded
 * total is then recomputed from what is left.
 */
export async function voidInvoiceRefund(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const actor = actorOf(request);
  if (!actor) return fail('unauthorized', 'Authentication required.', 401);

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

  const refund = await env.DB.prepare(
    `SELECT r.id, r.status, r.invoice_id, i.status AS invoice_status
       FROM invoice_refunds r LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE r.id = ?1`
  ).bind(id.value).first();
  if (!refund) return fail('not_found', 'Refund not found.', 404);
  if (refund.status === VOID) {
    return conflict('This refund is already reversed.', { reason: 'refund_void' });
  }
  if (refund.invoice_status === VOID) {
    return conflict('The invoice is Void, so its refunds are frozen.',
      { reason: 'invoice_void', invoiceId: refund.invoice_id });
  }

  const at = nowIso();
  let results;
  try {
    results = await env.DB.batch([
      // THE GATE: Active, on an invoice that is not Void.
      env.DB.prepare(
        `UPDATE invoice_refunds
            SET status = '${VOID}', void_reason = ?2, voided_at = ?3, updated_at = ?3,
                voided_by_id = ?4, voided_by_name = ?5
          WHERE id = ?1
            AND status = '${ACTIVE}'
            AND (SELECT status FROM invoices WHERE id = invoice_refunds.invoice_id) <> '${VOID}'`
      ).bind(id.value, voidReason.value, at, actor.accountId, actor.name),
      recomputeInvoice(env, {
        invoiceId: refund.invoice_id, at,
        guard: `(SELECT status FROM invoice_refunds WHERE id = ?3) = '${VOID}'`,
        guardBinds: [id.value],
      }),
    ]);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-refunds/:id/void failed:', err);
    return fail('database_error', 'Could not reverse the refund.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict('This refund was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' });
  }

  return respondWithRefund(env, id.value, 200);
}
