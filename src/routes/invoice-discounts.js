/* ============================================================
   routes/invoice-discounts.js — post-completion discounts (0026)
   ------------------------------------------------------------
   GET  /api/invoice-discounts[/:id]
   POST /api/invoice-discounts
   POST /api/invoice-discounts/:id/void

   A post-completion discount reduces what an ISSUED invoice asks the
   customer to pay. It is recorded here, one row per decision:

     * the invoice's issued total, tax and original discount stay as
       they were;
     * payable = total - Active post-completion discounts, and the
       invoice's post_discount/due/status are recomputed from it by
       recomputeInvoice() in payments.js, in the same batch;
     * payments are untouched: a discount is not cash. On an invoice
       that is already paid, a discount leaves a customer CREDIT
       (paid - refunded - payable). That credit is NEVER refunded
       automatically -- returning it is an explicit refund
       (routes/invoice-refunds.js).

   ---- the rules, all decided by the server ----

   1. NOTHING FINANCIAL COMES FROM THE CLIENT. A percentage discount
      is turned into an amount by the server (rate % of the issued
      total, to the paisa); the customer comes from the invoice; who
      approved it is the authenticated caller. The request also names
      `expectedPayable`, the payable amount the user was shown.

   2. THE CHECKS ARE PART OF THE WRITE: not Void, the payable amount
      the user saw, 0 < amount <= what is still discountable (payable
      minus what is already written off), and a date not before the
      invoice's. So the payable amount can never go below zero, total
      discounts can never exceed the invoice, and the same discount
      submitted twice -- or two at once -- is recorded only once.

   3. ONE BATCH. 4. NEVER DELETED OR EDITED: reversed by voiding, with
      a reason, a time and who. 5. A VOID INVOICE IS FROZEN.
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
import { isPaisa } from './invoice-refunds.js';

const VOID = 'Void';
const ACTIVE = 'Active';
export const DISCOUNT_TYPES = ['amount', 'percent'];
const MONEY_EPSILON = 0.005;

const COLUMNS = `
  id, invoice_id, customer_id, discount_type, rate, amount, reason, notes, date,
  payable_before, payable_after, status,
  created_by_kind, created_by_id, created_by_name,
  void_reason, voided_at, voided_by_id, voided_by_name,
  created_at, updated_at
`;

function toRecord(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    discountType: row.discount_type,      // amount | percent
    rate: row.rate ?? null,               // percent only
    amount: row.amount,                   // always the amount taken off
    reason: row.reason,
    notes: row.notes ?? '',
    date: row.date,
    payableBefore: row.payable_before,
    payableAfter: row.payable_after,
    status: row.status,                   // Active | Void
    approvedBy: row.created_by_name,
    approvedByKind: row.created_by_kind,
    approvedById: row.created_by_id ?? null,
    voidReason: row.void_reason ?? '',
    voidedAt: row.voided_at ?? null,
    voidedBy: row.voided_by_name ?? '',
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

const routes = collectionRoutes({
  table: 'invoice_discounts',
  columns: COLUMNS,
  toRecord,
  singular: 'post-completion discount',
  plural: 'post-completion discounts',
});

export const listInvoiceDiscounts = routes.list;
export const getInvoiceDiscount = routes.detail;

const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  customerId: '`customerId` is taken from the invoice.',
  status: '`status` is set by the server. Use the void operation to reverse a discount.',
  payableBefore: '`payableBefore` is calculated by the server.',
  payableAfter: '`payableAfter` is calculated by the server.',
  approvedBy: '`approvedBy` is the signed-in user.',
  approvedByKind: '`approvedByKind` is the signed-in user.',
  approvedById: '`approvedById` is the signed-in user.',
  voidReason: '`voidReason` is set by the void operation.',
  voidedAt: '`voidedAt` is set by the void operation.',
  voidedBy: '`voidedBy` is set by the void operation.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
};
const ACCEPTED = new Set(['invoiceId', 'discountType', 'amount', 'rate', 'reason', 'notes', 'date', 'expectedPayable']);

async function respondWithDiscount(env, id, status) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM invoice_discounts WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) {
    console.error(`Post-completion discount ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the discount back.', 500);
  }
  return ok(toRecord(row), {}, status);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Why a discount was refused. Run ONLY when the guarded INSERT matched nothing. */
async function explainRefusal(env, invoiceId, { type, rate, amount, expected, date }) {
  const row = await env.DB.prepare(liveInvoice('?1')).bind(invoiceId).first();
  if (!row) {
    return conflict('That invoice no longer exists.', { reason: 'invoice_not_found', invoiceId });
  }
  if (row.status === VOID) {
    return conflict('Cannot discount a Void invoice.', { reason: 'invoice_void', invoiceId });
  }
  const payable = round2(row.payable);
  if (Math.abs(payable - expected) >= MONEY_EPSILON) {
    return conflict(
      `The invoice has changed. Its payable amount is now ${payable}.`,
      { reason: 'stale_balance', invoiceId, payable, expectedPayable: expected }
    );
  }
  const eligible = Math.max(round2((Number(row.payable) || 0) - (Number(row.written_off) || 0)), 0);
  const value = type === 'percent' ? round2((Number(row.total) || 0) * rate / 100) : amount;
  if (!(value > 0)) {
    return conflict('That percentage of this invoice comes to less than one paisa.',
      { reason: 'zero_discount', invoiceId });
  }
  if (value > eligible + 1e-9) {
    return conflict(
      `The discount cannot exceed the amount still payable on this invoice (${eligible}).`,
      { reason: 'over_discount', invoiceId, eligible, amount: value }
    );
  }
  if (date < row.date) {
    return conflict(`The discount date cannot be before the invoice date (${row.date}).`,
      { reason: 'date_before_invoice', invoiceId, invoiceDate: row.date });
  }
  return conflict('This invoice was changed by another request. Reload it and try again.',
    { reason: 'concurrent_modification', invoiceId });
}

/* ---------------------------------------------------------------
   POST /api/invoice-discounts
   --------------------------------------------------------------- */

export async function createInvoiceDiscount(request, env) {
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
    else if (!ACCEPTED.has(key)) errors[key] = `\`${key}\` is not a field of a post-completion discount.`;
  }
  const invoiceId = readString(b, 'invoiceId', { required: true, max: 32 });
  if (invoiceId.error) errors.invoiceId = invoiceId.error;
  const type = readEnum(b, 'discountType', DISCOUNT_TYPES, { fallback: 'amount' });
  if (type.error) errors.discountType = type.error;

  let amount = { value: null };
  let rate = { value: null };
  if (type.value === 'percent') {
    rate = readNumber(b, 'rate', { required: true });
    if (rate.error) errors.rate = rate.error;
    else if (!(rate.value > 0 && rate.value <= 100)) errors.rate = 'The percentage must be more than 0 and at most 100.';
    else if (!isPaisa(rate.value)) errors.rate = 'The percentage can have at most 2 decimal places.';
    // The amount of a percentage discount is the server's to calculate.
    if (b.amount !== undefined) errors.amount = '`amount` is calculated by the server for a percentage discount.';
  } else {
    amount = readNumber(b, 'amount', { required: true });
    if (amount.error) errors.amount = amount.error;
    else if (!(amount.value > 0)) errors.amount = 'The discount must be greater than 0.';
    else if (!isPaisa(amount.value)) errors.amount = 'The discount can have at most 2 decimal places.';
    if (b.rate !== undefined) errors.rate = '`rate` applies to a percentage discount only.';
  }
  const reason = readString(b, 'reason', { required: true, max: 500 });
  if (reason.error) errors.reason = reason.error;
  const notes = readString(b, 'notes', { max: 1000 });
  if (notes.error) errors.notes = notes.error;
  const today = todayInDhaka();
  const date = readDate(b, 'date', { fallback: today });
  if (date.error) errors.date = date.error;
  else if (date.value > today) errors.date = 'The discount date cannot be in the future.';
  const expected = readNumber(b, 'expectedPayable', { required: true, min: 0 });
  if (expected.error) errors.expectedPayable = expected.error;

  if (Object.keys(errors).length) {
    return unprocessable('Some discount fields are not valid.', errors);
  }

  const allocated = await allocateId(env, 'invoiceDiscounts');
  if (allocated.error) {
    console.error('POST /api/invoice-discounts could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not record the discount.', 500);
  }
  const at = nowIso();

  // ?1 id  ?2 invoice  ?3 type  ?4 rate  ?5 amount (fixed)  ?6 reason  ?7 notes
  // ?8 date  ?9 created_at  ?10 expectedPayable  ?11-13 actor kind/id/name
  const statements = [
    env.DB.prepare(
      `INSERT INTO invoice_discounts
         (id, invoice_id, customer_id, discount_type, rate, amount, reason, notes, date,
          payable_before, payable_after, status,
          created_by_kind, created_by_id, created_by_name, created_at)
       SELECT ?1, q.id, q.customer_id, ?3, ?4, q.amt, ?6, ?7, ?8,
              ROUND(q.payable, 2), ROUND(q.payable - q.amt, 2), '${ACTIVE}',
              ?11, ?12, ?13, ?9
         FROM (SELECT l.*,
                      CASE WHEN ?3 = 'percent' THEN ROUND(l.total * ?4 / 100.0, 2) ELSE ?5 END AS amt
                 FROM (${liveInvoice('?2')}) l) q
        WHERE q.status <> '${VOID}'
          AND ABS(ROUND(q.payable, 2) - ?10) < ${MONEY_EPSILON}
          AND q.amt > 0
          AND q.amt <= ROUND(q.payable - q.written_off, 2)
          AND ?8 >= q.date`
    ).bind(
      allocated.id, invoiceId.value, type.value, rate.value, amount.value,
      reason.value, notes.value || null, date.value, at, expected.value,
      actor.kind, actor.accountId, actor.name,
    ),
    recomputeInvoice(env, {
      invoiceId: invoiceId.value, at,
      guard: 'EXISTS (SELECT 1 FROM invoice_discounts WHERE id = ?3)',
      guardBinds: [allocated.id],
    }),
  ];

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-discounts failed:', err);
    return fail('database_error', 'Could not record the discount.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return explainRefusal(env, invoiceId.value, {
      type: type.value, rate: rate.value, amount: amount.value, expected: expected.value, date: date.value,
    });
  }

  return respondWithDiscount(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   POST /api/invoice-discounts/:id/void
   --------------------------------------------------------------- */

/**
 * Reverse a post-completion discount. The row is kept; its status moves to
 * Void with the reason, the time and who did it, and the invoice's payable
 * amount, due and status are recomputed from what is left. (If the customer
 * has already paid, the payable amount rising simply removes the credit the
 * discount created; any refund already issued stays on record.)
 */
export async function voidInvoiceDiscount(request, env, rawId) {
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

  const disc = await env.DB.prepare(
    `SELECT d.id, d.status, d.invoice_id, i.status AS invoice_status
       FROM invoice_discounts d LEFT JOIN invoices i ON i.id = d.invoice_id
      WHERE d.id = ?1`
  ).bind(id.value).first();
  if (!disc) return fail('not_found', 'Discount not found.', 404);
  if (disc.status === VOID) {
    return conflict('This discount is already reversed.', { reason: 'discount_void' });
  }
  if (disc.invoice_status === VOID) {
    return conflict('The invoice is Void, so its discounts are frozen.',
      { reason: 'invoice_void', invoiceId: disc.invoice_id });
  }

  const at = nowIso();
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE invoice_discounts
            SET status = '${VOID}', void_reason = ?2, voided_at = ?3, updated_at = ?3,
                voided_by_id = ?4, voided_by_name = ?5
          WHERE id = ?1
            AND status = '${ACTIVE}'
            AND (SELECT status FROM invoices WHERE id = invoice_discounts.invoice_id) <> '${VOID}'`
      ).bind(id.value, voidReason.value, at, actor.accountId, actor.name),
      recomputeInvoice(env, {
        invoiceId: disc.invoice_id, at,
        guard: `(SELECT status FROM invoice_discounts WHERE id = ?3) = '${VOID}'`,
        guardBinds: [id.value],
      }),
    ]);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/invoice-discounts/:id/void failed:', err);
    return fail('database_error', 'Could not reverse the discount.', 500);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict('This discount was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' });
  }

  return respondWithDiscount(env, id.value, 200);
}
