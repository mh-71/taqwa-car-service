/* ============================================================
   routes/estimates.js — Estimates & Quotations (0007)
   ------------------------------------------------------------
   GET  /api/estimates[/:id]
   POST /api/estimates
   PUT  /api/estimates/:id
   POST /api/estimates/:id/send
   POST /api/estimates/:id/approve
   POST /api/estimates/:id/reject
   POST /api/estimates/:id/cancel
   POST /api/estimates/:id/convert

   A repair estimate for one customer's vehicle, before work starts.
   Every route here sits behind the auth gate in src/index.js; there is
   no public route in this module.

   ---- the rules this route owns ----

   1. THE JOB CARD'S MONEY. Lines are read with the job card's own
      readLines() and every total comes from the job card's own
      computeTotals() (routes/job-cards.js), so an estimate and the job
      card it becomes can never disagree about arithmetic. subtotal, tax
      and total are refused by name if a caller sends them. Staff may set
      any unit price (a snapshot); the server still recomputes.

   2. STRICT FIELDS, ONE SUBMISSION, ONE ROW. Each write names the keys it
      accepts. A create requires `idempotencyKey` and stores a fingerprint
      of its normalised payload, as follow-ups and tasks do: same key +
      same payload replays, same key + other payload is a 409.

   3. CHECKS ARE PART OF THE WRITE. The vehicle must belong to the
      customer, and a newly chosen customer or vehicle must be Active.
      Status, version and updated_at are in every UPDATE's WHERE. The line
      rows and the history row in the same batch are conditional on a
      per-write random `write_token`, so a request that loses a race
      changes nothing at all; only then is the refusal explained.

   4. THE LIFECYCLE.
        create            -> Draft (version 1)
        edit  Draft|Pending -> Draft, version + 1  (an issued quotation
                             that changes must be issued again)
        send  Draft       -> Pending   (needs a line, a valid date, an
                                        active customer and vehicle)
        approve Pending   -> Approved  (staff-recorded: note required,
                                        decided_via = 'staff'; refused once
                                        expired)
        reject  Pending   -> Rejected  (note required)
        cancel  Draft|Pending|Approved-not-converted -> Cancelled (reason)
        convert Approved  -> job card  (once; see convertEstimate())
      Expired (Pending past valid_until, Asia/Dhaka) and Converted
      (job_card_id set) are derived on every read and never stored.

   5. HISTORY. Every write appends an estimate_events row in the same
      batch. Actor names are free text under the shared login and are
      reported as such; they are not verified identities.

   6. NO STOCK. Nothing here reads or writes parts.stock or
      inventory_transactions. A converted job card starts in its initial
      status and inventory follows the job card workflow.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readOptionalBody, readString, readNumber, readEnum, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { readIdempotencyKey, fingerprint } from './follow-ups.js';
import { computeTotals, readLines, createJobCard } from './job-cards.js';

export const DRAFT = 'Draft';
export const PENDING = 'Pending';
export const APPROVED = 'Approved';
export const REJECTED = 'Rejected';
export const CANCELLED = 'Cancelled';
const ACTIVE = 'Active';

/** Default validity, in days from the estimate date. */
export const VALIDITY_DAYS = 30;
/** How long a conversion may hold its claim before another request may look into it. */
const CLAIM_STALE_MS = 5 * 60 * 1000;
const DISCOUNT_TYPES = ['amount', 'percent'];
const JOB_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/* Field limits. The schema's CHECKs (0007) and the page's own validation use
   the same numbers. */
export const LIMITS = { complaint: 2000, notes: 2000, note: 1000, reason: 500, name: 100 };

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/* ---------------------------------------------------------------
   Records
   --------------------------------------------------------------- */

// write_token, conversion_claim and the idempotency columns are internal and
// never leave the Worker.
const COLUMNS = `
  id, customer_id, vehicle_id, date, valid_until, status, version, complaint, notes,
  labour_hours, labour_rate, labour_cost, discount, discount_type, discount_rate, tax_rate,
  subtotal, tax, total, sent_at, decided_at, decided_via, decided_by, decision_note,
  cancelled_at, cancel_reason, job_card_id, converted_at, conversion_claimed_at,
  created_by, updated_by, created_at, updated_at
`;
const lineSum = (lines) => lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

/** One estimates row (+ lines and history when loaded) -> the record the UI reads. */
export function toEstimate(row, today, extra = {}) {
  const isConverted = !!row.job_card_id;
  const isExpired = row.status === PENDING && row.valid_until < today;
  const services = extra.services;
  const partsUsed = extra.partsUsed;
  return {
    id: row.id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    date: row.date,                     // workshop calendar day, verbatim
    validUntil: row.valid_until,        // valid through the whole of this day
    status: row.status,                 // Draft | Pending | Approved | Rejected | Cancelled
    // What the list shows: Converted and Expired are derived, never stored.
    displayStatus: isConverted ? 'Converted' : (isExpired ? 'Expired' : row.status),
    isExpired,
    isConverted,
    version: row.version,
    complaint: row.complaint,
    notes: row.notes ?? '',
    labourHours: row.labour_hours ?? null,
    labourRate: row.labour_rate ?? null,
    labourCost: row.labour_cost,
    discount: row.discount,
    discountType: row.discount_type,
    discountRate: row.discount_rate ?? null,
    taxRate: row.tax_rate,
    servicesTotal: services ? lineSum(services) : (row.services_total ?? 0),
    partsTotal: partsUsed ? lineSum(partsUsed) : (row.parts_total ?? 0),
    lineCount: services ? services.length + partsUsed.length : (row.line_count ?? 0),
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    sentAt: row.sent_at ?? null,
    decidedAt: row.decided_at ?? null,
    decidedVia: row.decided_via ?? null,   // 'staff' (Recorded by staff) | 'online' (later stage) | null
    decidedBy: row.decided_by ?? '',
    decisionNote: row.decision_note ?? '',
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? '',
    jobCardId: row.job_card_id ?? null,
    convertedAt: row.converted_at ?? null,
    conversionInProgress: !!row.conversion_claimed_at && !isConverted,
    createdBy: row.created_by ?? '',
    updatedBy: row.updated_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(services ? { services, partsUsed } : {}),
    ...(extra.history ? { history: extra.history } : {}),
  };
}

const toServiceLine = (r) => ({ serviceId: r.service_id ?? null, name: r.name, qty: r.qty, unitPrice: r.unit_price, total: r.total });
const toPartLine = (r) => ({ partId: r.part_id ?? null, name: r.name, partNo: r.part_no ?? '', qty: r.qty, unitPrice: r.unit_price, total: r.total });
const toEvent = (r) => ({
  event: r.event, fromStatus: r.from_status ?? null, toStatus: r.to_status, version: r.version,
  actor: r.actor ?? '', note: r.note ?? '', details: parseDetails(r.details), at: r.created_at,
});
function parseDetails(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readRow(env, id) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM estimates WHERE id = ?1 LIMIT 1`).bind(id).first();
}

/** The stored row, both line sets and the history, as one record. */
async function loadEstimate(env, id) {
  const row = await readRow(env, id);
  if (!row) return null;
  const [svc, prt, ev] = await Promise.all([
    env.DB.prepare('SELECT service_id, name, qty, unit_price, total FROM estimate_services WHERE estimate_id = ?1 ORDER BY line_no, id').bind(id).all(),
    env.DB.prepare('SELECT part_id, name, part_no, qty, unit_price, total FROM estimate_parts WHERE estimate_id = ?1 ORDER BY line_no, id').bind(id).all(),
    env.DB.prepare('SELECT event, from_status, to_status, version, actor, note, details, created_at FROM estimate_events WHERE estimate_id = ?1 ORDER BY id').bind(id).all(),
  ]);
  return {
    row,
    services: (svc.results ?? []).map(toServiceLine),
    partsUsed: (prt.results ?? []).map(toPartLine),
    history: (ev.results ?? []).map(toEvent),
  };
}

async function respondWith(env, id, status = 200, meta = {}) {
  const loaded = await loadEstimate(env, id);
  if (!loaded) return fail('not_found', 'No estimate with that id.', 404);
  return ok(toEstimate(loaded.row, todayInDhaka(), loaded), meta, status);
}

/* ---------------------------------------------------------------
   GET /api/estimates[/:id]
   --------------------------------------------------------------- */

export async function listEstimates(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  try {
    // The two line sums are what the list's Parts / Labour columns show; the
    // stored subtotal/tax/total are the authoritative money.
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS},
              (SELECT COALESCE(SUM(qty * unit_price), 0) FROM estimate_services s WHERE s.estimate_id = estimates.id) AS services_total,
              (SELECT COALESCE(SUM(qty * unit_price), 0) FROM estimate_parts p WHERE p.estimate_id = estimates.id) AS parts_total,
              (SELECT count(*) FROM estimate_services s WHERE s.estimate_id = estimates.id)
                + (SELECT count(*) FROM estimate_parts p WHERE p.estimate_id = estimates.id) AS line_count
         FROM estimates
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    ).bind(limit.value, offset.value).all();
    const rows = results ?? [];
    const total = await env.DB.prepare('SELECT count(*) AS n FROM estimates').first();
    const today = todayInDhaka();
    return ok(rows.map((r) => toEstimate(r, today)), {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
    });
  } catch (err) {
    console.error('GET /api/estimates failed:', err);
    return fail('database_error', 'Could not read estimates.', 500);
  }
}

export async function getEstimate(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  try {
    return await respondWith(env, id.value);
  } catch (err) {
    console.error('GET /api/estimates/:id failed:', err);
    return fail('database_error', 'Could not read estimate.', 500);
  }
}

/* ---------------------------------------------------------------
   Field readers
   --------------------------------------------------------------- */

/** Keys the server owns, refused by name with where the value comes from. */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  status: '`status` is set by the server. Use the send, approve, reject, cancel or convert operation.',
  displayStatus: '`displayStatus` is derived by the server.',
  isExpired: '`isExpired` is derived from the validity date.',
  isConverted: '`isConverted` is derived from the job card link.',
  version: '`version` is set by the server on every edit.',
  subtotal: '`subtotal` is calculated by the server from the lines.',
  tax: '`tax` is calculated by the server from the lines.',
  total: '`total` is calculated by the server from the lines.',
  servicesTotal: '`servicesTotal` is calculated by the server.',
  partsTotal: '`partsTotal` is calculated by the server.',
  lineCount: '`lineCount` is calculated by the server.',
  sentAt: '`sentAt` is set by the send operation.',
  decidedAt: '`decidedAt` is set when a decision is recorded.',
  decidedVia: '`decidedVia` is set when a decision is recorded.',
  decidedBy: '`decidedBy` is set when a decision is recorded.',
  decisionNote: '`decisionNote` is set when a decision is recorded.',
  cancelledAt: '`cancelledAt` is set by the cancel operation.',
  cancelReason: '`cancelReason` is set by the cancel operation.',
  jobCardId: '`jobCardId` is set by the convert operation.',
  convertedAt: '`convertedAt` is set by the convert operation.',
  conversionInProgress: '`conversionInProgress` is set by the server.',
  history: '`history` is written by the server.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  idempotencyFingerprint: '`idempotencyFingerprint` is calculated by the server.',
};

function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors[key] = SERVER_OWNED[key] || `\`${key}\` is not accepted here.`;
  }
  return errors;
}

/** Optional text: trimmed, '' stored as NULL. */
function readText(body, field, max) {
  const r = readString(body, field, { max });
  return r.error ? r : { value: r.value === '' ? null : r.value };
}

/** A required record id in a body field. */
function readRef(body, field) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return { error: `\`${field}\` is required.` };
  if (typeof raw !== 'string') return { error: `\`${field}\` must be a record id.` };
  const id = readRecordId(raw.trim());
  return id.error ? { error: `\`${field}\`: ${id.error}` } : { value: id.value };
}

/** YYYY-MM-DD plus n days, in calendar arithmetic (no time zone involved). */
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 to 100 with at most two decimals, or null when absent. */
function readRate(body, field) {
  const read = readNumber(body, field, { min: 0, max: 100, fallback: null });
  if (read.error || read.value === null) return read;
  if (Math.abs(read.value * 100 - Math.round(read.value * 100)) >= 1e-9) {
    return { error: `\`${field}\` can have at most two decimal places.` };
  }
  return read;
}

const sent = (body, key) => body[key] !== undefined && body[key] !== null && body[key] !== '';

/**
 * The money inputs of a create or an edit, merged over `stored` (null on a
 * create). Returns { values, errors }. The discount follows the job card's
 * rules: a percentage is derived from its rate (so `discount` may not be sent
 * with one), a fixed amount is taken as sent, and naming neither keeps what
 * the estimate already has.
 */
function readMoney(body, stored) {
  const errors = {};
  const v = {};
  const num = (field, col, opts) => {
    if (body[field] === undefined) { v[col] = stored ? stored[col] : (opts.fallback ?? null); return; }
    const r = readNumber(body, field, opts);
    if (r.error) errors[field] = r.error; else v[col] = r.value;
  };
  num('labourHours', 'labour_hours', { min: 0 });
  num('labourRate', 'labour_rate', { min: 0 });
  num('labourCost', 'labour_cost', { min: 0, fallback: 0 });
  if (v.labour_cost === null) v.labour_cost = 0;
  num('taxRate', 'tax_rate', { min: 0, max: 100 });

  let type;
  if (sent(body, 'discountType')) {
    const r = readEnum(body, 'discountType', DISCOUNT_TYPES, { required: true });
    if (r.error) errors.discountType = r.error; else type = r.value;
  } else if (sent(body, 'discount')) type = 'amount';
  else if (sent(body, 'discountRate')) type = 'percent';
  else type = stored ? stored.discount_type : 'amount';
  v.discount_type = type;

  if (type === 'percent') {
    if (sent(body, 'discount')) errors.discount = 'A percentage discount is calculated from `discountRate`; do not send `discount`.';
    const rate = sent(body, 'discountRate') ? readRate(body, 'discountRate')
      : { value: stored && stored.discount_type === 'percent' ? stored.discount_rate : null };
    if (rate.error) errors.discountRate = rate.error;
    else if (rate.value === null || rate.value === undefined) errors.discountRate = '`discountRate` is required for a percentage discount.';
    else v.discount_rate = rate.value;
    v.discount = 0;
  } else if (type === 'amount') {
    if (sent(body, 'discountRate')) errors.discountRate = '`discountRate` applies only to a percentage discount.';
    v.discount_rate = null;
    if (sent(body, 'discount')) {
      const r = readNumber(body, 'discount', { min: 0 });
      if (r.error) errors.discount = r.error; else v.discount = r.value;
    } else v.discount = stored && stored.discount_type === 'amount' ? stored.discount : 0;
  }
  return { values: v, errors };
}

/** Totals for a merged estimate, via the job card's computeTotals(). */
function totalsOf(v, services, partsUsed) {
  return computeTotals({
    services, partsUsed,
    labourHours: v.labour_hours, labourRate: v.labour_rate, labourCost: v.labour_cost,
    discount: v.discount, discountType: v.discount_type, discountRate: v.discount_rate,
    taxRate: v.tax_rate, paid: 0,
  });
}

/** The cross-field rules, on the estimate as it will be after the write. */
function checkRecord(v, services, partsUsed, totals) {
  const errors = {};
  if (v.valid_until < v.date) errors.validUntil = 'Valid Until cannot be earlier than the estimate date.';
  if (v.discount_type !== 'percent' && (Number(v.discount) || 0) > totals.subtotal) {
    errors.discount = 'Discount cannot exceed the subtotal.';
  }
  if (!services.length && !partsUsed.length && !(totals.labourCost > 0)) {
    errors.services = 'Add at least one service, part, or labour entry.';
  }
  return errors;
}

/** The workshop's configured tax rate, or 0 only when there is no Settings row. */
async function settingsTaxRate(env) {
  const row = await env.DB.prepare('SELECT tax_rate FROM settings WHERE id = 1').first();
  const rate = row ? Number(row.tax_rate) : 0;
  return Number.isFinite(rate) ? rate : 0;
}

/* ---------------------------------------------------------------
   SQL building blocks
   --------------------------------------------------------------- */

/** Numbered placeholders: p(value) binds a value and returns its `?n`. */
function binder() {
  const list = [];
  return { list, p: (value) => { list.push(value === undefined ? null : value); return `?${list.length}`; } };
}

const newToken = () => crypto.randomUUID();

/**
 * The WHERE fragment that makes a write conditional on its customer and
 * vehicle agreeing. A newly chosen customer or vehicle must be Active; one
 * that is merely kept may have been deactivated since, and stays (send and
 * convert check Active separately).
 */
function partyGuard(c, v, fresh) {
  const active = (on) => (on ? ` AND status = '${ACTIVE}'` : '');
  return `EXISTS (SELECT 1 FROM customers WHERE id = ${c}${active(fresh.customer)})
      AND EXISTS (SELECT 1 FROM vehicles WHERE id = ${v} AND customer_id = ${c}${active(fresh.vehicle)})`;
}

const fieldError = (field, message) => unprocessable('Some estimate fields are not valid.', { [field]: message });

/** Why a customer/vehicle pair cannot take this write, or null if it can. */
async function explainParty(env, customerId, vehicleId, fresh) {
  const row = await env.DB.prepare(
    `SELECT (SELECT status FROM customers WHERE id = ?1)     AS customer_status,
            (SELECT customer_id FROM vehicles WHERE id = ?2) AS vehicle_owner,
            (SELECT status FROM vehicles WHERE id = ?2)      AS vehicle_status`
  ).bind(customerId, vehicleId).first();
  if (!row || row.customer_status === null) return conflict('That customer does not exist.', { reason: 'customer_not_found' });
  if (fresh.customer && row.customer_status !== ACTIVE) {
    return conflict('That customer is Inactive. Reactivate the customer or choose another.', { reason: 'customer_inactive' });
  }
  if (row.vehicle_owner === null) return conflict('That vehicle does not exist.', { reason: 'vehicle_not_found' });
  if (row.vehicle_owner !== customerId) return fieldError('vehicleId', 'Selected vehicle does not belong to this customer.');
  if (fresh.vehicle && row.vehicle_status !== ACTIVE) {
    return conflict('That vehicle is Inactive. Choose an active vehicle.', { reason: 'vehicle_inactive' });
  }
  return null;
}

/** Line inserts for one estimate, each conditional on this request's write_token. */
function lineStatements(env, id, token, services, partsUsed) {
  const out = [];
  services.forEach((l, i) => {
    out.push(env.DB.prepare(
      `INSERT INTO estimate_services (estimate_id, service_id, name, qty, unit_price, total, line_no)
       SELECT id, ?2, ?3, ?4, ?5, ?6, ?7 FROM estimates WHERE id = ?1 AND write_token = ?8`
    ).bind(id, l.serviceId, l.name, l.qty, l.unitPrice, l.total, i + 1, token));
  });
  partsUsed.forEach((l, i) => {
    out.push(env.DB.prepare(
      `INSERT INTO estimate_parts (estimate_id, part_id, name, part_no, qty, unit_price, total, line_no)
       SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM estimates WHERE id = ?1 AND write_token = ?9`
    ).bind(id, l.partId, l.name, l.partNo || null, l.qty, l.unitPrice, l.total, i + 1, token));
  });
  return out;
}

/** The history row for a write, conditional on this request's write_token. */
function eventStatement(env, { id, token, event, fromStatus, actor, note, details, at }) {
  return env.DB.prepare(
    `INSERT INTO estimate_events (estimate_id, event, from_status, to_status, version, actor, note, details, created_at)
     SELECT id, ?2, ?3, status, version, ?4, ?5, ?6, ?7 FROM estimates WHERE id = ?1 AND write_token = ?8`
  ).bind(id, event, fromStatus ?? null, actor ?? null, note ?? null, details ? JSON.stringify(details) : null, at, token);
}

/* ---------------------------------------------------------------
   POST /api/estimates
   --------------------------------------------------------------- */

const MONEY_FIELDS = ['labourHours', 'labourRate', 'labourCost', 'discountType', 'discount', 'discountRate', 'taxRate'];
const CREATE_FIELDS = ['customerId', 'vehicleId', 'date', 'validUntil', 'complaint', 'notes', 'services', 'partsUsed',
  ...MONEY_FIELDS, 'createdBy', 'idempotencyKey'];

async function replayCreate(env, key, fp) {
  const row = await env.DB.prepare(
    'SELECT id, idempotency_fingerprint FROM estimates WHERE idempotency_key = ?1 LIMIT 1'
  ).bind(key).first();
  if (!row) return null;
  if (row.idempotency_fingerprint !== fp) {
    return conflict('This submission key was already used for a different estimate. Start a new submission.',
      { reason: 'idempotency_key_reused' });
  }
  return respondWith(env, row.id, 200, { replayed: true });
}

/** Read both line arrays; absent arrays are `undefined` so an edit keeps the stored ones. */
function readBothLines(b, errors, create) {
  const out = {};
  for (const [field, isService] of [['services', true], ['partsUsed', false]]) {
    if (b[field] === undefined) { if (create) out[field] = []; continue; }
    const r = readLines(b[field], { isService, field });
    if (r.error) errors[field] = r.error; else out[field] = r.value;
  }
  return out;
}

export async function createEstimate(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = unknownKeys(b, CREATE_FIELDS);
  const customerId = readRef(b, 'customerId');
  if (customerId.error) errors.customerId = customerId.error;
  const vehicleId = readRef(b, 'vehicleId');
  if (vehicleId.error) errors.vehicleId = vehicleId.error;
  const date = readDate(b, 'date', { fallback: '' });
  if (date.error) errors.date = date.error;
  const validUntil = readDate(b, 'validUntil', { fallback: '' });
  if (validUntil.error) errors.validUntil = validUntil.error;
  const complaint = readString(b, 'complaint', { required: true, max: LIMITS.complaint });
  if (complaint.error) errors.complaint = complaint.error;
  const notes = readText(b, 'notes', LIMITS.notes);
  if (notes.error) errors.notes = notes.error;
  const createdBy = readText(b, 'createdBy', LIMITS.name);
  if (createdBy.error) errors.createdBy = createdBy.error;
  const key = readIdempotencyKey(b);
  if (key.error) errors.idempotencyKey = key.error;
  const lines = readBothLines(b, errors, true);
  const money = readMoney(b, null);
  Object.assign(errors, money.errors);
  if (Object.keys(errors).length) return unprocessable('Some estimate fields are not valid.', errors);

  try {
    const v = { ...money.values };
    v.date = date.value || todayInDhaka();
    v.valid_until = validUntil.value || addDays(v.date, VALIDITY_DAYS);
    // The tax default is the server's to apply, from Settings.
    if (v.tax_rate === null || v.tax_rate === undefined) v.tax_rate = await settingsTaxRate(env);

    const totals = totalsOf(v, lines.services, lines.partsUsed);
    const cross = checkRecord(v, lines.services, lines.partsUsed, totals);
    if (Object.keys(cross).length) return unprocessable('Some estimate fields are not valid.', cross);

    const fp = await fingerprint([
      'estimate.create.v1', customerId.value, vehicleId.value, v.date, v.valid_until, complaint.value, notes.value,
      lines.services, lines.partsUsed, v.labour_hours, v.labour_rate, v.labour_cost, v.discount_type, v.discount,
      v.discount_rate, v.tax_rate, createdBy.value,
    ]);

    // A retry finds its own row before anything else is checked.
    const replay = await replayCreate(env, key.value, fp);
    if (replay) return replay;

    const allocated = await allocateId(env, 'estimates');
    if (allocated.error) {
      console.error('POST /api/estimates could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the estimate.', 500);
    }
    const at = nowIso();
    const token = newToken();
    const fresh = { customer: true, vehicle: true };

    const q = binder();
    const cols = {
      id: q.p(allocated.id), customer_id: null, vehicle_id: null, date: q.p(v.date), valid_until: q.p(v.valid_until),
      status: q.p(DRAFT), version: '1', complaint: q.p(complaint.value), notes: q.p(notes.value),
      labour_hours: q.p(v.labour_hours), labour_rate: q.p(v.labour_rate), labour_cost: q.p(totals.labourCost),
      discount: q.p(totals.discount), discount_type: q.p(v.discount_type), discount_rate: q.p(v.discount_rate),
      tax_rate: q.p(totals.taxRate), subtotal: q.p(totals.subtotal), tax: q.p(totals.tax), total: q.p(totals.total),
      write_token: q.p(token), created_by: q.p(createdBy.value), updated_by: q.p(createdBy.value),
      idempotency_key: q.p(key.value), idempotency_fingerprint: q.p(fp), created_at: q.p(at), updated_at: null,
    };
    cols.updated_at = cols.created_at;
    const c = q.p(customerId.value);
    const veh = q.p(vehicleId.value);
    cols.customer_id = c;
    cols.vehicle_id = veh;
    const names = Object.keys(cols);

    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO estimates (${names.join(', ')})
         SELECT ${names.map((n) => cols[n]).join(', ')}
          WHERE ${partyGuard(c, veh, fresh)}
         ON CONFLICT(idempotency_key) DO NOTHING`
      ).bind(...q.list),
      ...lineStatements(env, allocated.id, token, lines.services, lines.partsUsed),
      eventStatement(env, {
        id: allocated.id, token, event: 'created', fromStatus: null, actor: createdBy.value, at,
        details: { total: totals.total },
      }),
    ]);
    if (Number(results[0]?.meta?.changes) === 1) return respondWith(env, allocated.id, 201);

    // Nothing was inserted: a concurrent request with the same key won, or
    // the customer / vehicle was refused.
    const raced = await replayCreate(env, key.value, fp);
    if (raced) return raced;
    const refusal = await explainParty(env, customerId.value, vehicleId.value, fresh);
    if (refusal) return refusal;
    return conflict('The customer or vehicle was changed by another request. Reload and try again.',
      { reason: 'concurrent_modification' });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/estimates failed:', err);
    return fail('database_error', 'Could not create the estimate.', 500);
  }
}

/* ---------------------------------------------------------------
   PUT /api/estimates/:id
   --------------------------------------------------------------- */

const UPDATE_FIELDS = ['customerId', 'vehicleId', 'date', 'validUntil', 'complaint', 'notes', 'services', 'partsUsed',
  ...MONEY_FIELDS, 'updatedBy', 'expectedUpdatedAt'];
const EDITABLE = [DRAFT, PENDING];

function closedConflict(row) {
  if (row.job_card_id) {
    return conflict(`This estimate was converted to job card ${row.job_card_id} and can no longer be changed.`,
      { reason: 'estimate_converted', currentStatus: row.status, jobCardId: row.job_card_id });
  }
  return conflict(`This estimate is ${row.status}; it can no longer be edited.`,
    { reason: 'estimate_closed', currentStatus: row.status });
}

function readExpected(b, errors, { required }) {
  const raw = b.expectedUpdatedAt;
  if (raw === undefined || raw === null || raw === '') {
    if (required) errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the edit was made from.';
    return null;
  }
  if (typeof raw !== 'string' || raw.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` must be the updatedAt value the edit was made from.';
    return null;
  }
  return raw;
}

const staleConflict = () => conflict('This estimate was changed by someone else after you opened it. Reload it and try again.',
  { reason: 'concurrent_modification' });

/**
 * Merge the permitted fields into a Draft or Pending estimate. Every edit
 * raises the version and leaves the estimate in Draft: a Pending quotation
 * that changes is no longer the one the customer was given, so it has to be
 * issued again. (The later online-approval stage invalidates that stage's
 * link in this same batch.)
 */
export async function updateEstimate(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = unknownKeys(b, UPDATE_FIELDS);
  if (b.idempotencyKey !== undefined) errors.idempotencyKey = '`idempotencyKey` is only used when creating an estimate.';
  if (b.createdBy !== undefined) errors.createdBy = '`createdBy` is recorded when the estimate is created.';
  const values = {};
  for (const [field, col] of [['customerId', 'customer_id'], ['vehicleId', 'vehicle_id']]) {
    if (b[field] === undefined) continue;
    const r = readRef(b, field);
    if (r.error) errors[field] = r.error; else values[col] = r.value;
  }
  for (const [field, col] of [['date', 'date'], ['validUntil', 'valid_until']]) {
    if (b[field] === undefined) continue;
    const r = readDate(b, field, { required: true });
    if (r.error) errors[field] = r.error; else values[col] = r.value;
  }
  if (b.complaint !== undefined) {
    const r = readString(b, 'complaint', { required: true, max: LIMITS.complaint });
    if (r.error) errors.complaint = r.error; else values.complaint = r.value;
  }
  if (b.notes !== undefined) {
    const r = readText(b, 'notes', LIMITS.notes);
    if (r.error) errors.notes = r.error; else values.notes = r.value;
  }
  const updatedBy = readText(b, 'updatedBy', LIMITS.name);
  if (updatedBy.error) errors.updatedBy = updatedBy.error;
  const expected = readExpected(b, errors, { required: true });
  const lines = readBothLines(b, errors, false);
  const touched = Object.keys(b).filter((k) => !['updatedBy', 'expectedUpdatedAt'].includes(k));
  if (Object.keys(errors).length) return unprocessable('Some estimate fields are not valid.', errors);
  if (!touched.length) return unprocessable('No estimate fields were supplied to update.');

  try {
    const current = await loadEstimate(env, id.value);
    if (!current) return fail('not_found', 'No estimate with that id.', 404);
    const cur = current.row;
    if (!EDITABLE.includes(cur.status) || cur.job_card_id) return closedConflict(cur);
    if (expected !== cur.updated_at) return staleConflict();

    const money = readMoney(b, cur);
    if (Object.keys(money.errors).length) return unprocessable('Some estimate fields are not valid.', money.errors);
    const v = {
      customer_id: values.customer_id ?? cur.customer_id,
      vehicle_id: values.vehicle_id ?? cur.vehicle_id,
      date: values.date ?? cur.date,
      valid_until: values.valid_until ?? cur.valid_until,
      complaint: values.complaint ?? cur.complaint,
      notes: 'notes' in values ? values.notes : cur.notes,
      ...money.values,
    };
    const services = lines.services ?? current.services;
    const partsUsed = lines.partsUsed ?? current.partsUsed;
    const totals = totalsOf(v, services, partsUsed);
    const cross = checkRecord(v, services, partsUsed, totals);
    if (Object.keys(cross).length) return unprocessable('Some estimate fields are not valid.', cross);
    const fresh = { customer: v.customer_id !== cur.customer_id, vehicle: v.vehicle_id !== cur.vehicle_id };

    const at = nowIso();
    const token = newToken();
    const q = binder();
    const sets = {
      customer_id: v.customer_id, vehicle_id: v.vehicle_id, date: v.date, valid_until: v.valid_until,
      complaint: v.complaint, notes: v.notes, labour_hours: v.labour_hours, labour_rate: v.labour_rate,
      labour_cost: totals.labourCost, discount: totals.discount, discount_type: v.discount_type,
      discount_rate: v.discount_rate, tax_rate: totals.taxRate, subtotal: totals.subtotal, tax: totals.tax,
      total: totals.total, status: DRAFT, write_token: token, updated_by: updatedBy.value, updated_at: at,
    };
    const assignments = Object.entries(sets).map(([col, val]) => `${col} = ${q.p(val)}`);
    assignments.push('version = version + 1');
    const where = `id = ${q.p(id.value)} AND status = ${q.p(cur.status)} AND updated_at = ${q.p(cur.updated_at)}
      AND job_card_id IS NULL AND conversion_claim IS NULL
      AND ${partyGuard(q.p(v.customer_id), q.p(v.vehicle_id), fresh)}`;

    const returned = cur.status === PENDING;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE estimates SET ${assignments.join(', ')} WHERE ${where}`).bind(...q.list),
      env.DB.prepare(
        `DELETE FROM estimate_services WHERE estimate_id = ?1
            AND EXISTS (SELECT 1 FROM estimates WHERE id = ?1 AND write_token = ?2)`
      ).bind(id.value, token),
      env.DB.prepare(
        `DELETE FROM estimate_parts WHERE estimate_id = ?1
            AND EXISTS (SELECT 1 FROM estimates WHERE id = ?1 AND write_token = ?2)`
      ).bind(id.value, token),
      ...lineStatements(env, id.value, token, services, partsUsed),
      eventStatement(env, {
        id: id.value, token, event: 'updated', fromStatus: cur.status, actor: updatedBy.value, at,
        note: returned ? 'Edited while Pending: returned to Draft. The revised quotation must be sent again.' : null,
        details: {
          before: { version: cur.version, total: cur.total },
          after: { version: cur.version + 1, total: totals.total },
          fields: touched.sort(),
        },
      }),
    ]);
    if (Number(results[0]?.meta?.changes) === 1) {
      return respondWith(env, id.value, 200, returned ? { returnedToDraft: true } : {});
    }

    const now = await readRow(env, id.value);
    if (!now) return fail('not_found', 'No estimate with that id.', 404);
    if (!EDITABLE.includes(now.status) || now.job_card_id) return closedConflict(now);
    if (now.updated_at !== cur.updated_at) return staleConflict();
    const refusal = await explainParty(env, v.customer_id, v.vehicle_id, fresh);
    if (refusal) return refusal;
    return staleConflict();
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/estimates/:id failed:', err);
    return fail('database_error', 'Could not update the estimate.', 500);
  }
}

/* ---------------------------------------------------------------
   Lifecycle actions: send | approve | reject | cancel
   --------------------------------------------------------------- */

/** Read an action body: only `allowed` keys; returns { b, errors } or { response }. */
async function readActionBody(request, allowed, { required = false } = {}) {
  const body = required ? await readJsonBody(request) : await readOptionalBody(request);
  if (body.error) return { response: fail('invalid_body', body.error, 400) };
  return { b: body.value, errors: unknownKeys(body.value, allowed) };
}

const invalidTransition = (row, label) => conflict(
  `This estimate is ${row.job_card_id ? 'converted' : row.status}; it cannot be ${label} from there.`,
  { reason: 'invalid_transition', currentStatus: row.status, ...(row.job_card_id ? { jobCardId: row.job_card_id } : {}) },
);
const expiredConflict = (row) => conflict(
  `This estimate expired after ${row.valid_until}. Edit it to extend the validity date, then send it again.`,
  { reason: 'estimate_expired', validUntil: row.valid_until },
);

/**
 * Move an estimate from `from` to `to` in one guarded batch: the UPDATE
 * carries the status and updated_at it was read at (plus `guards`), and the
 * history row is conditional on that UPDATE. Anything that changed in between
 * is a 409 explaining what the estimate is now.
 */
async function transition(env, id, { from, to, event, label, sets, guards = '', expected, actor, note, pre }) {
  try {
    const cur = await readRow(env, id);
    if (!cur) return fail('not_found', 'No estimate with that id.', 404);
    if (!from.includes(cur.status) || cur.job_card_id) return invalidTransition(cur, label);
    if (expected !== null && expected !== cur.updated_at) return staleConflict();
    if (pre) {
      const refusal = await pre(cur);
      if (refusal) return refusal;
    }

    const at = nowIso();
    const token = newToken();
    const q = binder();
    const assignments = [`status = ${q.p(to)}`, `updated_at = ${q.p(at)}`, `write_token = ${q.p(token)}`, `updated_by = ${q.p(actor)}`];
    for (const [col, val] of Object.entries(sets(at))) assignments.push(`${col} = ${val === SQL_NOW ? q.p(at) : q.p(val)}`);
    const where = `id = ${q.p(id)} AND status = ${q.p(cur.status)} AND updated_at = ${q.p(cur.updated_at)}
      AND job_card_id IS NULL AND conversion_claim IS NULL${guards ? ` AND ${guards(q)}` : ''}`;

    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE estimates SET ${assignments.join(', ')} WHERE ${where}`).bind(...q.list),
      eventStatement(env, { id, token, event, fromStatus: cur.status, actor, note, at }),
    ]);
    if (Number(results[0]?.meta?.changes) === 1) return respondWith(env, id);

    const now = await readRow(env, id);
    if (!now) return fail('not_found', 'No estimate with that id.', 404);
    if (!from.includes(now.status) || now.job_card_id) return invalidTransition(now, label);
    if (now.updated_at !== cur.updated_at) return staleConflict();
    if (pre) {
      const refusal = await pre(now);
      if (refusal) return refusal;
    }
    return staleConflict();
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error(`POST /api/estimates/:id (${label}) failed:`, err);
    return fail('database_error', 'Could not update the estimate.', 500);
  }
}
/** Marker for "the time of this write" inside an action's `sets`. */
const SQL_NOW = Symbol('now');

/** The SQL that says "this estimate is still within its validity date". */
const notExpiredSql = (q, today) => `valid_until >= ${q.p(today)}`;
/** The SQL that says "the customer is active and still owns the active vehicle". */
const activePartySql = () => `EXISTS (SELECT 1 FROM customers c WHERE c.id = estimates.customer_id AND c.status = '${ACTIVE}')
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = estimates.vehicle_id AND v.customer_id = estimates.customer_id AND v.status = '${ACTIVE}')`;
const hasLineSql = () => `(EXISTS (SELECT 1 FROM estimate_services s WHERE s.estimate_id = estimates.id)
       OR EXISTS (SELECT 1 FROM estimate_parts p WHERE p.estimate_id = estimates.id))`;

/** Why an estimate's customer/vehicle cannot be issued or converted now, or null. */
async function explainActiveParty(env, row) {
  return explainParty(env, row.customer_id, row.vehicle_id, { customer: true, vehicle: true });
}
async function lineCount(env, id) {
  const r = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM estimate_services WHERE estimate_id = ?1)
          + (SELECT count(*) FROM estimate_parts WHERE estimate_id = ?1) AS n`
  ).bind(id).first();
  return r ? Number(r.n) : 0;
}

function actionPreamble(request, env, rawId, methodName = 'POST') {
  if (request.method !== methodName) return { response: methodNotAllowed([methodName]) };
  if (!env.DB) return { response: noDatabase() };
  const id = readRecordId(rawId);
  if (id.error) return { response: fail('invalid_id', id.error, 400) };
  return { id: id.value };
}

/** POST /api/estimates/:id/send — Draft -> Pending. Body optional: { by, expectedUpdatedAt }. */
export async function sendEstimate(request, env, rawId) {
  const pre = actionPreamble(request, env, rawId);
  if (pre.response) return pre.response;
  const r = await readActionBody(request, ['by', 'expectedUpdatedAt']);
  if (r.response) return r.response;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  const expected = readExpected(r.b, r.errors, { required: false });
  if (Object.keys(r.errors).length) return unprocessable('Some fields are not valid.', r.errors);
  const today = todayInDhaka();
  return transition(env, pre.id, {
    from: [DRAFT], to: PENDING, event: 'sent', label: 'sent', expected, actor: by.value,
    note: 'Issued to the customer (printed or shared by staff). No message is sent by the system.',
    sets: () => ({ sent_at: SQL_NOW }),
    guards: (q) => `${notExpiredSql(q, today)} AND ${hasLineSql()} AND ${activePartySql()}`,
    pre: async (row) => {
      if (row.valid_until < today) return expiredConflict(row);
      if (await lineCount(env, row.id) === 0) {
        return unprocessable('Add at least one service or part line before sending the estimate.',
          { services: 'Add at least one service or part line before sending the estimate.' });
      }
      return explainActiveParty(env, row);
    },
  });
}

/** POST /api/estimates/:id/approve — Pending -> Approved, recorded by staff. Body: { note (required), by, expectedUpdatedAt }. */
export async function approveEstimate(request, env, rawId) {
  const pre = actionPreamble(request, env, rawId);
  if (pre.response) return pre.response;
  const r = await readActionBody(request, ['note', 'by', 'expectedUpdatedAt'], { required: true });
  if (r.response) return r.response;
  const note = readString(r.b, 'note', { required: true, max: LIMITS.note });
  if (note.error) r.errors.note = note.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  const expected = readExpected(r.b, r.errors, { required: false });
  if (Object.keys(r.errors).length) return unprocessable('Some approval fields are not valid.', r.errors);
  const today = todayInDhaka();
  return transition(env, pre.id, {
    from: [PENDING], to: APPROVED, event: 'approved', label: 'approved', expected, actor: by.value,
    note: `Recorded by staff: ${note.value}`,
    sets: () => ({ decided_at: SQL_NOW, decided_via: 'staff', decided_by: by.value, decision_note: note.value }),
    guards: (q) => `${notExpiredSql(q, today)}
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = estimates.vehicle_id AND v.customer_id = estimates.customer_id)`,
    pre: async (row) => {
      if (row.valid_until < today) return expiredConflict(row);
      const owner = await env.DB.prepare('SELECT customer_id FROM vehicles WHERE id = ?1').bind(row.vehicle_id).first();
      if (!owner || owner.customer_id !== row.customer_id) {
        return conflict('The vehicle on this estimate now belongs to another customer. Edit the estimate and send it again.',
          { reason: 'vehicle_owner_changed' });
      }
      return null;
    },
  });
}

/** POST /api/estimates/:id/reject — Pending -> Rejected. Body: { note (required), by, expectedUpdatedAt }. */
export async function rejectEstimate(request, env, rawId) {
  const pre = actionPreamble(request, env, rawId);
  if (pre.response) return pre.response;
  const r = await readActionBody(request, ['note', 'by', 'expectedUpdatedAt'], { required: true });
  if (r.response) return r.response;
  const note = readString(r.b, 'note', { required: true, max: LIMITS.note });
  if (note.error) r.errors.note = note.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  const expected = readExpected(r.b, r.errors, { required: false });
  if (Object.keys(r.errors).length) return unprocessable('Some rejection fields are not valid.', r.errors);
  return transition(env, pre.id, {
    from: [PENDING], to: REJECTED, event: 'rejected', label: 'rejected', expected, actor: by.value,
    note: `Recorded by staff: ${note.value}`,
    sets: () => ({ decided_at: SQL_NOW, decided_via: 'staff', decided_by: by.value, decision_note: note.value }),
  });
}

/** POST /api/estimates/:id/cancel — Draft | Pending | Approved (not converted) -> Cancelled. Body: { reason (required), by, expectedUpdatedAt }. */
export async function cancelEstimate(request, env, rawId) {
  const pre = actionPreamble(request, env, rawId);
  if (pre.response) return pre.response;
  const r = await readActionBody(request, ['reason', 'by', 'expectedUpdatedAt'], { required: true });
  if (r.response) return r.response;
  const reason = readString(r.b, 'reason', { required: true, max: LIMITS.reason });
  if (reason.error) r.errors.reason = reason.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  const expected = readExpected(r.b, r.errors, { required: false });
  if (Object.keys(r.errors).length) return unprocessable('Some cancellation fields are not valid.', r.errors);
  return transition(env, pre.id, {
    from: [DRAFT, PENDING, APPROVED], to: CANCELLED, event: 'cancelled', label: 'cancelled', expected, actor: by.value,
    note: reason.value,
    // A cancelled estimate keeps any decision it had; the CHECK pairs
    // decided_* with Approved/Rejected, so those are cleared here and the
    // decision stays in the history.
    sets: () => ({ cancelled_at: SQL_NOW, cancel_reason: reason.value, decided_at: null, decided_via: null, decided_by: null, decision_note: null }),
    pre: async (row) => (row.conversion_claimed_at ? conversionBusy() : null),
  });
}

/* ---------------------------------------------------------------
   POST /api/estimates/:id/convert
   --------------------------------------------------------------- */

const CONVERT_FIELDS = ['mechanicId', 'date', 'estDelivery', 'priority', 'mileage', 'by', 'expectedUpdatedAt'];
const conversionBusy = () => conflict('This estimate is being converted to a job card right now. Wait a moment and reload.',
  { reason: 'conversion_in_progress' });
const alreadyConverted = (row) => conflict(`This estimate was already converted to job card ${row.job_card_id}.`,
  { reason: 'already_converted', jobCardId: row.job_card_id });

/** The note every converted job card starts with; also how an interrupted conversion is recognised. */
export const conversionMarker = (id) => `Converted from estimate ${id}`;

/**
 * Convert an Approved estimate into a job card, once.
 *
 * The job card is created by the EXISTING job card route, createJobCard(),
 * with a body built here from the STORED estimate -- never from the browser's
 * lines or figures -- so every job card rule (required mechanic, complaint,
 * at least one line, vehicle ownership, discount limits, initial status
 * Received, no stock movement on create) applies exactly as it does to a card
 * created on the Job Cards page.
 *
 * Because that route commits its own batch, the conversion is made safe in
 * three steps rather than one:
 *
 *   1. CLAIM: one guarded UPDATE puts a random claim on the estimate, only if
 *      it is Approved, not converted, unclaimed and unchanged. A second
 *      request finds the claim and gets a 409, so two clicks cannot make two
 *      job cards.
 *   2. CREATE the job card through createJobCard(). If it refuses (e.g. the
 *      mechanic does not exist), the claim is released and its refusal is
 *      returned as it stands.
 *   3. LINK: one batch sets job_card_id and clears the claim -- conditional
 *      on still holding it -- and appends the 'converted' history row. The
 *      unique index on estimates.job_card_id is the last word.
 *
 * If a Worker is interrupted between 2 and 3, the claim goes stale. A later
 * request that finds a stale claim first looks for the job card it may have
 * made (same customer and vehicle, created since the claim, notes starting
 * with conversionMarker()) and links that one instead of creating another.
 */
export async function convertEstimate(request, env, rawId) {
  const pre = actionPreamble(request, env, rawId);
  if (pre.response) return pre.response;
  const id = pre.id;
  const r = await readActionBody(request, CONVERT_FIELDS, { required: true });
  if (r.response) return r.response;
  const errors = r.errors;
  const mechanicId = readRef(r.b, 'mechanicId');
  if (mechanicId.error) errors.mechanicId = mechanicId.error;
  const date = readDate(r.b, 'date', { fallback: '' });
  if (date.error) errors.date = date.error;
  const estDelivery = readDate(r.b, 'estDelivery', { fallback: '' });
  if (estDelivery.error) errors.estDelivery = estDelivery.error;
  const priority = readEnum(r.b, 'priority', JOB_PRIORITIES, { fallback: 'normal' });
  if (priority.error) errors.priority = priority.error;
  const mileage = readNumber(r.b, 'mileage', { min: 0, integer: true });
  if (mileage.error) errors.mileage = mileage.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) errors.by = by.error;
  const expected = readExpected(r.b, errors, { required: false });
  if (Object.keys(errors).length) return unprocessable('Some job card fields are not valid.', errors);

  try {
    const loaded = await loadEstimate(env, id);
    if (!loaded) return fail('not_found', 'No estimate with that id.', 404);
    const est = loaded.row;
    if (est.job_card_id) return alreadyConverted(est);
    if (est.status !== APPROVED) {
      return conflict(`Only an Approved estimate can be converted to a job card (this one is ${est.status}).`,
        { reason: 'invalid_transition', currentStatus: est.status });
    }
    if (expected !== null && expected !== est.updated_at) return staleConflict();

    const now = Date.now();
    let staleClaim = null;
    if (est.conversion_claimed_at) {
      if (now - Date.parse(est.conversion_claimed_at) < CLAIM_STALE_MS) return conversionBusy();
      const claimRow = await env.DB.prepare('SELECT conversion_claim FROM estimates WHERE id = ?1').bind(id).first();
      staleClaim = claimRow ? claimRow.conversion_claim : null;
      // An interrupted conversion may already have made its job card.
      const orphan = await env.DB.prepare(
        `SELECT id FROM job_cards
          WHERE customer_id = ?1 AND vehicle_id = ?2 AND created_at >= ?3 AND notes LIKE ?4
            AND id NOT IN (SELECT job_card_id FROM estimates WHERE job_card_id IS NOT NULL)
          ORDER BY created_at, id LIMIT 1`
      ).bind(est.customer_id, est.vehicle_id, est.conversion_claimed_at, `${conversionMarker(id)} %`).first();
      if (orphan && staleClaim) return linkJobCard(env, id, staleClaim, orphan.id, by.value, est, { recovered: true });
    }

    if (!loaded.services.length && !loaded.partsUsed.length) {
      return unprocessable('This estimate has no service or part lines to put on a job card.',
        { services: 'Add at least one service or part line before converting.' });
    }
    const party = await explainActiveParty(env, est);
    if (party) return party;

    // 1. CLAIM
    const claim = newToken();
    const claimed = await env.DB.prepare(
      `UPDATE estimates SET conversion_claim = ?1, conversion_claimed_at = ?2
        WHERE id = ?3 AND status = '${APPROVED}' AND job_card_id IS NULL AND updated_at = ?4
          AND (conversion_claim IS NULL OR conversion_claim = ?5)
          AND ${activePartySql()}`
    ).bind(claim, new Date(now).toISOString(), id, est.updated_at, staleClaim).run();
    if (Number(claimed?.meta?.changes) !== 1) {
      const again = await readRow(env, id);
      if (!again) return fail('not_found', 'No estimate with that id.', 404);
      if (again.job_card_id) return alreadyConverted(again);
      if (again.conversion_claimed_at) return conversionBusy();
      if (again.status !== APPROVED) return invalidTransition(again, 'converted');
      const refusal = await explainActiveParty(env, again);
      return refusal || staleConflict();
    }

    // 2. CREATE, through the job card route itself.
    const jobBody = {
      customerId: est.customer_id,
      vehicleId: est.vehicle_id,
      mechanicId: mechanicId.value,
      date: date.value || todayInDhaka(),
      ...(estDelivery.value ? { estDelivery: estDelivery.value } : {}),
      priority: priority.value,
      ...(mileage.value !== null ? { mileage: mileage.value } : {}),
      complaint: est.complaint,
      notes: `${conversionMarker(id)} (version ${est.version}).${est.notes ? ` ${est.notes}` : ''}`.slice(0, 2000),
      services: loaded.services.map((l) => ({ serviceId: l.serviceId, name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
      partsUsed: loaded.partsUsed.map((l) => ({ partId: l.partId, name: l.name, partNo: l.partNo, qty: l.qty, unitPrice: l.unitPrice })),
      labourHours: est.labour_hours,
      labourRate: est.labour_rate,
      labourCost: est.labour_cost,
      discountType: est.discount_type,
      ...(est.discount_type === 'percent' ? { discountRate: est.discount_rate } : { discount: est.discount }),
      taxRate: est.tax_rate,
      paid: 0,
    };
    let created;
    try {
      created = await createJobCard(new Request('https://worker.internal/api/job-cards', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jobBody),
      }), env);
    } catch (err) {
      await releaseClaim(env, id, claim);
      throw err;
    }
    if (created.status !== 201) {
      await releaseClaim(env, id, claim);
      return created;   // the job card route's own refusal, as it stands
    }
    const job = (await created.json()).data;

    // 3. LINK
    return linkJobCard(env, id, claim, job.id, by.value, est, { jobTotal: job.total });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/estimates/:id/convert failed:', err);
    return fail('database_error', 'Could not convert the estimate.', 500);
  }
}

async function releaseClaim(env, id, claim) {
  try {
    await env.DB.prepare(
      'UPDATE estimates SET conversion_claim = NULL, conversion_claimed_at = NULL WHERE id = ?1 AND conversion_claim = ?2'
    ).bind(id, claim).run();
  } catch (err) {
    console.error('Could not release a conversion claim:', err);
  }
}

/** Step 3: link the job card and clear the claim, conditional on still holding it. */
async function linkJobCard(env, id, claim, jobCardId, actor, est, { recovered = false, jobTotal = null } = {}) {
  const at = nowIso();
  const token = newToken();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE estimates
          SET job_card_id = ?1, converted_at = ?2, conversion_claim = NULL, conversion_claimed_at = NULL,
              updated_at = ?2, updated_by = ?3, write_token = ?4
        WHERE id = ?5 AND conversion_claim = ?6 AND job_card_id IS NULL AND status = '${APPROVED}'`
    ).bind(jobCardId, at, actor, token, id, claim),
    eventStatement(env, {
      id, token, event: 'converted', fromStatus: APPROVED, actor, at,
      note: recovered ? `Linked job card ${jobCardId} left by an interrupted conversion.` : `Job card ${jobCardId} created.`,
      details: { jobCardId, estimateTotal: est.total, ...(jobTotal !== null ? { jobCardTotal: jobTotal } : {}) },
    }),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    console.error(`Estimate ${id}: job card ${jobCardId} was created but could not be linked.`);
    return fail('conversion_incomplete',
      `Job card ${jobCardId} was created, but linking it to this estimate failed. Do not convert again; reload the estimate.`,
      500, { jobCardId });
  }
  return respondWith(env, id, 200, { jobCardId, ...(recovered ? { recovered: true } : {}) });
}
