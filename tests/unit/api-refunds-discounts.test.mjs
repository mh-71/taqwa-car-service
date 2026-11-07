/* Refunds and post-completion discounts (0026) — unit tests against the REAL
   Worker, on an in-memory SQLite database built from every migration, through
   a minimal D1-shaped wrapper (prepare/bind/first/all/run/batch, the batch in
   one transaction). Real D1 is the integration suite's job.

     A. Refunds: success, partial, multiple, over-refund, Void invoice, zero /
        negative / sub-paisa amounts, duplicate and concurrent submissions,
        reversal, dates, server-owned fields, the invoice's figures.
     B. Post-completion discounts: fixed, percentage, multiple, over-discount,
        Void invoice, duplicate, reversal, a discount on a paid invoice and the
        customer credit it leaves, the interaction with write-offs and payments.
     C. Permissions: no credential, a Mechanic, a Manager (view only), an
        Accountant (full), the shared credentials.
     D. Integrations: payment void and invoice void/delete guards, the change
        log devices pull from, notifications, offline push refused.

   Every name and number is a fictional test value. Needs node:sqlite. */
import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectionPermission, can, DEFAULT_ROLES } from '../../src/lib/permissions.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version.');
  console.log(`\nRefunds & discounts unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const PW2 = 'Own-Chosen-Pass-77';
const AT = '2026-10-08T00:00:00Z';

function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of ALL_MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw, prepare: (sql) => new Stmt(sql),
    async batch(list) { raw.exec('BEGIN'); try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
  };
}

const PEOPLE = ['Mechanic Test', 'Manager Test', 'Accountant Test'];
function fresh() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Test Customer', '01700000001', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'TEST-1', 'B', 'M', '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'M', '017', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection IN ('customers', 'vehicles', 'mechanics');
    ${PEOPLE.map((n, i) => `INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-000${i + 1}', '${n}', '0191100000${i}', 'Active', 'Test', 'Test', '${AT}');`).join('\n')}
    UPDATE id_counters SET last_value = ${PEOPLE.length} WHERE collection = 'staff';`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const api = async (method, path, body, cred = 'token') => {
    const headers = {};
    if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
    else if (cred !== 'none') headers.cookie = cred;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env, ctx);
    const text = await res.text();
    await Promise.all(pending.splice(0));
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const person = async (n, username, role) => {
    const made = await api('POST', '/api/accounts', { staffId: `STF-000${n}`, username, role, password: PW });
    if (made.status !== 201) throw new Error(`could not create ${username}: ${made.text}`);
    const s = await api('POST', '/api/session', { username, password: PW }, 'none');
    const changed = await api('POST', '/api/session/password', { currentPassword: PW, newPassword: PW2 }, s.cookie);
    if (changed.status !== 204) throw new Error(`could not change ${username}'s password: ${changed.text}`);
    return { id: made.body.data.id, cookie: changed.cookie };
  };
  const inv = (id) => one(`SELECT total, paid, post_discount AS postDiscount, written_off AS writtenOff, refunded, due, status
                             FROM invoices WHERE id = ?`, id);
  return { DB, env, api, one, person, inv };
}

/** A Completed job card and its invoice, for `total`. */
async function invoice(h, total) {
  const j = await h.api('POST', '/api/job-cards', {
    customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-01', complaint: 'x',
    services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: total }], partsUsed: [],
  });
  if (j.status !== 201) throw new Error(j.text);
  for (const s of ['Inspection', 'In Progress', 'Completed']) await h.api('POST', `/api/job-cards/${j.body.data.id}/status`, { status: s });
  const i = await h.api('POST', '/api/invoices', { jobCardId: j.body.data.id });
  if (i.status !== 201) throw new Error(i.text);
  return i.body.data.id;
}
const pay = (h, invoiceId, amount) => h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId, amount, date: '2026-10-02' });
const refund = (h, invoiceId, amount, expectedRefundable, extra = {}, cred) =>
  h.api('POST', '/api/invoice-refunds', { invoiceId, amount, method: 'Cash', reason: 'Part returned unused', expectedRefundable, ...extra }, cred);
const discount = (h, invoiceId, amount, expectedPayable, extra = {}, cred) =>
  h.api('POST', '/api/invoice-discounts', { invoiceId, amount, reason: 'Goodwill, delayed delivery', expectedPayable, ...extra }, cred);
const fig = (o) => [o.paid, o.postDiscount, o.writtenOff, o.refunded, o.due, o.status];
const reason = (r) => [r.status, r.body?.error?.reason ?? r.body?.error?.code];

/* ============================================================
   A. Refunds
   ============================================================ */
console.log('\n=== A. Refunds ===');
{
  const h = fresh();
  const i = await invoice(h, 1000);
  check('an issued invoice starts clean: paid, discount, written off, refunded, due, status',
    fig(h.inv(i)), [0, 0, 0, 0, 1000, 'Unpaid']);
  const none = await refund(h, i, 100, 0);
  check('nothing collected yet -> 409 nothing_to_refund', reason(none), [409, 'nothing_to_refund']);

  await pay(h, i, 1000);
  check('paid in full', fig(h.inv(i)), [1000, 0, 0, 0, 0, 'Paid']);

  const r1 = await refund(h, i, 300, 1000, { method: 'Mobile Banking', notes: 'bKash 017...' });
  check('1. a refund -> 201', r1.status, 201);
  check('   ...the record: amount, method, snapshots, Active, processed by the caller',
    [r1.body.data.amount, r1.body.data.method, r1.body.data.refundableBefore, r1.body.data.refundableAfter,
      r1.body.data.status, r1.body.data.processedBy, r1.body.data.customerId, r1.body.data.notes],
    [300, 'Mobile Banking', 1000, 700, 'Active', 'API token', 'CUS-0001', 'bKash 017...']);
  // A refused request also uses up a number (as write-offs and payments do): ids are unique, not gap-free.
  ok_('   ...the id is allocated from its counter (RFD-nnnn)', /^RFD-\d{4}$/.test(r1.body.data.id), r1.body.data.id);
  check('2. partial: paid stays 1,000 (cash received), refunded 300, due stays 0, still Paid -- no new debt',
    fig(h.inv(i)), [1000, 0, 0, 300, 0, 'Paid']);
  check('   ...and no payment row was created or changed',
    [h.one('SELECT count(*) AS n FROM payments').n, h.one('SELECT SUM(amount) AS s FROM payments').s], [1, 1000]);

  const dup = await refund(h, i, 300, 1000, { method: 'Mobile Banking' });
  check('8. the same submission again -> 409 stale_balance (never recorded twice)', reason(dup), [409, 'stale_balance']);
  check('   ...still one refund', h.one('SELECT count(*) AS n FROM invoice_refunds').n, 1);

  const r2 = await refund(h, i, 200, 700);
  check('3. a second refund -> 201', r2.status, 201);
  check('   ...refunded adds up to 500', h.inv(i).refunded, 500);

  const over = await refund(h, i, 500.01, 500);
  check('4. more than the 500 still refundable -> 409 over_refund', reason(over), [409, 'over_refund']);
  check('   ...nothing written', h.one('SELECT count(*) AS n FROM invoice_refunds').n, 2);

  for (const [label, amount] of [['6. zero', 0], ['7. negative', -50], ['three decimals', 10.005], ['text', 'abc']]) {
    const bad = await refund(h, i, amount, 500);
    check(`${label} amount -> 422 on amount`, [bad.status, Object.keys(bad.body?.error?.fields ?? {})], [422, ['amount']]);
  }
  const noReason = await refund(h, i, 10, 500, { reason: '  ' });
  check('a blank reason -> 422', [noReason.status, Object.keys(noReason.body?.error?.fields ?? {})], [422, ['reason']]);
  const badMethod = await refund(h, i, 10, 500, { method: 'Cheque' });
  check('a method that is not a payment method -> 422', [badMethod.status, Object.keys(badMethod.body?.error?.fields ?? {})], [422, ['method']]);
  const future = await refund(h, i, 10, 500, { date: '2999-01-01' });
  check('a future date -> 422', [future.status, Object.keys(future.body?.error?.fields ?? {})], [422, ['date']]);
  const early = await refund(h, i, 10, 500, { date: '2020-01-01' });
  check('a date before the invoice -> 409 date_before_invoice', reason(early), [409, 'date_before_invoice']);
  const owned = await refund(h, i, 10, 500, { customerId: 'CUS-9', refundableAfter: 0, processedBy: 'Someone else', status: 'Void' });
  check('server-owned fields are refused by name',
    [owned.status, Object.keys(owned.body?.error?.fields ?? {}).sort()], [422, ['customerId', 'processedBy', 'refundableAfter', 'status']]);
  const unknown = await refund(h, 'INV-9999', 10, 0);
  check('an invoice that does not exist -> 409 invoice_not_found', reason(unknown), [409, 'invoice_not_found']);

  const v = await h.api('POST', `/api/invoice-refunds/${r1.body.data.id}/void`, { voidReason: 'Recorded by mistake' });
  check('10. reverse a refund -> 200, Void, with reason and who', [v.status, v.body.data.status, v.body.data.voidReason, v.body.data.voidedBy],
    [200, 'Void', 'Recorded by mistake', 'API token']);
  check('   ...the invoice counts only the Active refund', fig(h.inv(i)), [1000, 0, 0, 200, 0, 'Paid']);
  check('   ...the row is kept, amount untouched', h.one('SELECT amount, status FROM invoice_refunds WHERE id = ?', r1.body.data.id), { amount: 300, status: 'Void' });
  const v2 = await h.api('POST', `/api/invoice-refunds/${r1.body.data.id}/void`, { voidReason: 'again' });
  check('   ...reversing it again -> 409 refund_void', reason(v2), [409, 'refund_void']);
  const v3 = await h.api('POST', `/api/invoice-refunds/${r2.body.data.id}/void`, {});
  check('   ...a reversal needs a reason -> 422', v3.status, 422);
  check('no PUT and no DELETE on a refund',
    [(await h.api('PUT', `/api/invoice-refunds/${r1.body.data.id}`, { amount: 1 })).status,
      (await h.api('DELETE', `/api/invoice-refunds/${r1.body.data.id}`)).status], [405, 405]);
  const list = await h.api('GET', `/api/invoice-refunds`);
  check('the history lists both, reversed one included', list.body.data.map((r) => [r.id, r.status]).sort(),
    [[r1.body.data.id, 'Void'], [r2.body.data.id, 'Active']].sort());
}
{
  const h = fresh();
  const i = await invoice(h, 1000);
  await pay(h, i, 1000);
  // 11. Two requests at once for the whole refundable amount: one wins.
  const both = await Promise.all([refund(h, i, 800, 1000), refund(h, i, 800, 1000)]);
  check('11. two concurrent refunds of 800 against 1,000 -> one 201 and one 409',
    both.map((r) => r.status).sort(), [201, 409]);
  check('   ...only 800 refunded', [h.one('SELECT count(*) AS n FROM invoice_refunds').n, h.inv(i).refunded], [1, 800]);
  const rest = await refund(h, i, 200, 200);
  check('   ...the remaining 200 can still be refunded, to exactly the cash collected', [rest.status, h.inv(i).refunded], [201, 1000]);
  const more = await refund(h, i, 0.01, 0);
  check('   ...and not one paisa more', reason(more), [409, 'nothing_to_refund']);
}

/* ============================================================
   B. Post-completion discounts
   ============================================================ */
console.log('\n=== B. Post-completion discounts ===');
{
  const h = fresh();
  const i = await invoice(h, 1000);
  const d1 = await discount(h, i, 100, 1000);
  check('1. a fixed discount on an unpaid invoice -> 201', d1.status, 201);
  check('   ...the record: type, amount, snapshots, approved by the caller',
    [d1.body.data.id, d1.body.data.discountType, d1.body.data.rate, d1.body.data.amount, d1.body.data.payableBefore, d1.body.data.payableAfter, d1.body.data.approvedBy],
    ['PCD-0001', 'amount', null, 100, 1000, 900, 'API token']);
  check('   ...the invoice: total kept, payable 900, due 900', [h.inv(i).total, ...fig(h.inv(i))], [1000, 0, 100, 0, 0, 900, 'Unpaid']);

  const d2 = await discount(h, i, undefined, 900, { discountType: 'percent', rate: 12.5 });
  check('2. a 12.5% discount is 12.5% of the issued total, calculated by the server', [d2.status, d2.body.data.amount, d2.body.data.rate], [201, 125, 12.5]);
  check('3. two discounts add up: payable 775', fig(h.inv(i)), [0, 225, 0, 0, 775, 'Unpaid']);
  const pctWithAmount = await discount(h, i, 50, 775, { discountType: 'percent', rate: 5 });
  check('   ...a percentage discount refuses a client amount', [pctWithAmount.status, Object.keys(pctWithAmount.body?.error?.fields ?? {})], [422, ['amount']]);
  const pctOver = await discount(h, i, undefined, 775, { discountType: 'percent', rate: 100.5 });
  check('   ...and a percentage above 100', [pctOver.status, Object.keys(pctOver.body?.error?.fields ?? {})], [422, ['rate']]);

  const over = await discount(h, i, 775.01, 775);
  check('4. more than the 775 still payable -> 409 over_discount', reason(over), [409, 'over_discount']);
  const dup = await discount(h, i, 100, 1000);
  check('6. a duplicate of the first request -> 409 stale_balance', reason(dup), [409, 'stale_balance']);
  check('   ...still two discounts', h.one('SELECT count(*) AS n FROM invoice_discounts').n, 2);
  for (const [label, amount] of [['zero', 0], ['negative', -1], ['three decimals', 1.234]]) {
    const bad = await discount(h, i, amount, 775);
    check(`a ${label} discount -> 422 on amount`, [bad.status, Object.keys(bad.body?.error?.fields ?? {})], [422, ['amount']]);
  }

  // A payment now: the room is the payable amount, not the issued total.
  const overpay = await pay(h, i, 776);
  check('a payment above the payable 775 is an overpayment', reason(overpay), [409, 'overpayment']);
  check('   ...whose message reports the discounted due', overpay.body.error.outstandingDue, 775);
  await pay(h, i, 400);
  check('a partial payment: due 375, Partial', fig(h.inv(i)), [400, 225, 0, 0, 375, 'Partial']);
  await pay(h, i, 375);
  check('paying the rest settles it: Paid', fig(h.inv(i)), [775, 225, 0, 0, 0, 'Paid']);

  const v = await h.api('POST', `/api/invoice-discounts/${d2.body.data.id}/void`, { voidReason: 'Approved in error' });
  check('8. reverse the percentage discount -> 200, Void', [v.status, v.body.data.status, v.body.data.voidedBy], [200, 'Void', 'API token']);
  check('   ...the payable amount rises back to 900 and 125 is owed again', fig(h.inv(i)), [775, 100, 0, 0, 125, 'Partial']);
}
{
  const h = fresh();
  const i = await invoice(h, 1000);
  await pay(h, i, 1000);
  const d = await discount(h, i, 200, 1000);
  check('9. a discount on a fully paid invoice -> 201', d.status, 201);
  check('   ...due 0, still Paid, cash unchanged', fig(h.inv(i)), [1000, 200, 0, 0, 0, 'Paid']);
  const got = (await h.api('GET', `/api/invoices/${i}`)).body.data;
  const credit = Math.max(got.paid - got.refunded - (got.total - got.postDiscount), 0);
  check('10. the customer now holds a credit of 200 (paid - refunded - payable)', credit, 200);
  check('   ...and it is NOT refunded automatically', h.one('SELECT count(*) AS n FROM invoice_refunds').n, 0);
  const extra = await pay(h, i, 1);
  check('   ...no further payment is accepted', reason(extra), [409, 'overpayment']);
  const r = await refund(h, i, 200, 1000);
  check('   ...an explicit refund returns it', [r.status, ...fig(h.inv(i))], [201, 1000, 200, 0, 200, 0, 'Paid']);
  const after = (await h.api('GET', `/api/invoices/${i}`)).body.data;
  check('   ...net cash retained (800) now equals the payable amount (800)', [after.paid - after.refunded, after.total - after.postDiscount], [800, 800]);
}
{
  const h = fresh();
  const i = await invoice(h, 1000);
  const wo = await h.api('POST', '/api/invoice-adjustments', { invoiceId: i, amount: 300, reason: 'Concession', expectedDue: 1000 });
  check('with 300 written off', [wo.status, h.inv(i).due], [201, 700]);
  const tooMuch = await discount(h, i, 701, 1000);
  check('a discount cannot also cover what is written off -> 409 over_discount', reason(tooMuch), [409, 'over_discount']);
  const exact = await discount(h, i, 700, 1000);
  check('   ...the remaining 700 can be discounted: payable 300, all written off, Paid',
    [exact.status, ...fig(h.inv(i))], [201, 0, 700, 300, 0, 0, 'Paid']);
  const woMore = await h.api('POST', '/api/invoice-adjustments', { invoiceId: i, amount: 1, reason: 'x', expectedDue: 0 });
  check('   ...and nothing more can be written off', woMore.status, 409);
  const vVoid = await h.api('POST', `/api/invoices/${i}/void`, {});
  check('5. void the invoice (no refunds on it) -> 200', vVoid.status, 200);
  const dVoid = await discount(h, i, 1, 300);
  check('   ...a discount on a Void invoice -> 409 invoice_void', reason(dVoid), [409, 'invoice_void']);
  const rVoid = await refund(h, i, 1, 0);
  check('   ...and so is a refund', reason(rVoid), [409, 'invoice_void']);
  const revVoid = await h.api('POST', `/api/invoice-discounts/${exact.body.data.id}/void`, { voidReason: 'x' });
  check('   ...and its discounts are frozen', reason(revVoid), [409, 'invoice_void']);
  const del = await h.api('DELETE', `/api/invoices/${i}`);
  check('   ...and the Void invoice cannot be deleted while it has discounts on record', reason(del), [409, 'invoice_has_adjustments']);
}

/* ============================================================
   C. Permissions
   ============================================================ */
console.log('\n=== C. Permissions ===');
{
  check('each route needs its own permission',
    [collectionPermission('invoice-refunds', 'view'), collectionPermission('invoice-refunds', 'create'), collectionPermission('invoice-refunds', 'void'),
      collectionPermission('invoice-discounts', 'view'), collectionPermission('invoice-discounts', 'create'), collectionPermission('invoice-discounts', 'void')],
    ['refunds.view', 'refunds.create', 'refunds.manage', 'discounts.view', 'discounts.create', 'discounts.manage']);
  check('   ...with no update or remove', [collectionPermission('invoice-refunds', 'update'), collectionPermission('invoice-discounts', 'remove')], ['full', 'full']);
  const role = (name) => DEFAULT_ROLES.find((r) => r.name === name).permissions.filter((p) => /^(refunds|discounts)\./.test(p)).sort();
  check('defaults: Admin and Accountant have all six', [role('Admin'), role('Accountant')],
    [['discounts.create', 'discounts.manage', 'discounts.view', 'refunds.create', 'refunds.manage', 'refunds.view'],
      ['discounts.create', 'discounts.manage', 'discounts.view', 'refunds.create', 'refunds.manage', 'refunds.view']]);
  check('   ...Manager may only see them; Service Advisor, Mechanic, Store Manager and Staff have none',
    [role('Manager'), role('Service Advisor'), role('Mechanic'), role('Store Manager'), role('Staff')],
    [['discounts.view', 'refunds.view'], [], [], [], []]);
  ok_('   ...invoices.edit alone does not allow a refund', !can({ kind: 'account', permissions: ['invoices.view', 'invoices.edit'] }, 'refunds.create'));

  const h = fresh();
  const i = await invoice(h, 1000);
  await pay(h, i, 1000);
  const anon = await refund(h, i, 10, 1000, {}, 'none');
  check('9. no credential -> 401, nothing written', [anon.status, h.one('SELECT count(*) AS n FROM invoice_refunds').n], [401, 0]);
  const mech = await h.person(1, 'mech.test', 'ROL-0007');
  const mgr = await h.person(2, 'manager.test', 'ROL-0003');
  const acc = await h.person(3, 'accountant.test', 'ROL-0004');
  check('a Mechanic: refund, discount and reading either -> 403',
    [(await refund(h, i, 10, 1000, {}, mech.cookie)).status, (await discount(h, i, 10, 1000, {}, mech.cookie)).status,
      (await h.api('GET', '/api/invoice-refunds', undefined, mech.cookie)).status], [403, 403, 403]);
  check('a Manager: may read refunds and discounts, may not give either',
    [(await h.api('GET', '/api/invoice-refunds', undefined, mgr.cookie)).status, (await h.api('GET', '/api/invoice-discounts', undefined, mgr.cookie)).status,
      (await refund(h, i, 10, 1000, {}, mgr.cookie)).status, (await discount(h, i, 10, 1000, {}, mgr.cookie)).status], [200, 200, 403, 403]);
  check('   ...nothing was written by the refused requests', h.one('SELECT (SELECT count(*) FROM invoice_refunds) + (SELECT count(*) FROM invoice_discounts) AS n').n, 0);
  const accRefund = await refund(h, i, 10, 1000, {}, acc.cookie);
  check('an Accountant may refund, and is recorded by name and account', [accRefund.status, accRefund.body.data.processedBy, accRefund.body.data.processedById, accRefund.body.data.processedByKind],
    [201, 'accountant.test', acc.id, 'account']);
  const mgrVoid = await h.api('POST', `/api/invoice-refunds/${accRefund.body.data.id}/void`, { voidReason: 'x' }, mgr.cookie);
  check('   ...a Manager cannot reverse it', mgrVoid.status, 403);
  const accVoid = await h.api('POST', `/api/invoice-refunds/${accRefund.body.data.id}/void`, { voidReason: 'Wrong amount' }, acc.cookie);
  check('   ...the Accountant can, and is recorded as who reversed it', [accVoid.status, accVoid.body.data.voidedBy], [200, 'accountant.test']);
  const pass = await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none');
  const viaPassphrase = await refund(h, i, 5, 1000, {}, pass.cookie);
  check('the shared passphrase (full access, as before) is recorded as such', [viaPassphrase.status, viaPassphrase.body?.data?.processedBy], [201, 'Workshop passphrase']);
}

/* ============================================================
   D. Integrations
   ============================================================ */
console.log('\n=== D. Integrations ===');
{
  const h = fresh();
  const i = await invoice(h, 1000);
  const p1 = await pay(h, i, 600);
  const p2 = await pay(h, i, 400);
  const r = await refund(h, i, 700, 1000);
  check('a 700 refund on 1,000 collected', r.status, 201);
  const vp = await h.api('POST', `/api/payments/${p1.body.data.id}/void`);
  check('12. voiding the 600 payment would leave 400 against a 700 refund -> 409 refunds_exceed_payments', reason(vp), [409, 'refunds_exceed_payments']);
  check('   ...the payment stays Active, the invoice unchanged', [h.one('SELECT status FROM payments WHERE id = ?', p1.body.data.id).status, ...fig(h.inv(i))],
    ['Active', 1000, 0, 0, 700, 0, 'Paid']);
  const vInv = await h.api('POST', `/api/invoices/${i}/void`, {});
  check('voiding the invoice while a refund stands -> 409 invoice_has_refunds', reason(vInv), [409, 'invoice_has_refunds']);
  check('   ...nothing released, invoice not Void', [h.inv(i).status, h.one('SELECT count(*) AS n FROM payments WHERE invoice_id IS NULL').n], ['Paid', 0]);
  await h.api('POST', `/api/invoice-refunds/${r.body.data.id}/void`, { voidReason: 'Customer kept the part' });
  const vp2 = await h.api('POST', `/api/payments/${p2.body.data.id}/void`);
  check('once the refund is reversed, a payment can be voided again', [vp2.status, ...fig(h.inv(i))], [200, 600, 0, 0, 0, 400, 'Partial']);

  const log = h.DB.raw.prepare(`SELECT collection, record_id AS id, op FROM change_log
                                 WHERE collection IN ('invoiceRefunds', 'invoices') ORDER BY seq`).all().map((x) => ({ ...x }));
  ok_('the change log tells other devices about the refund and its invoice',
    log.some((e) => e.collection === 'invoiceRefunds' && e.id === r.body.data.id && e.op === 'upsert')
      && log.some((e) => e.collection === 'invoices' && e.id === '*' && e.op === 'refresh'), JSON.stringify(log));
  const notes = h.DB.raw.prepare(`SELECT event_type, record_type, record_id, category FROM notifications WHERE event_type = 'refund.issued'`).all().map((x) => ({ ...x }));
  check('a Finance notification is raised for the refund, filed against its invoice', notes, [{ event_type: 'refund.issued', record_type: 'invoice', record_id: i, category: 'Finance' }]);

  // Offline: a refund or a discount cannot be pushed from a device.
  const dev = await h.api('POST', '/api/devices/register', { name: 'Test laptop', uuid: '11111111-2222-4333-8444-555555555555' });
  const push = await h.api('POST', '/api/sync/push', { deviceId: dev.body?.data?.deviceId ?? dev.body?.data?.id, ops: [{
    opId: '11111111-2222-4333-8444-666666666666', kind: 'create', collection: 'invoiceRefunds', tempId: 'OFF-A-RFD-0001',
    data: { invoiceId: i, amount: 1, method: 'Cash', reason: 'x', expectedRefundable: 400 }, at: AT,
  }] });
  const result = push.body?.data?.results?.[0];
  ok_('an offline refund pushed from a device is refused, and nothing is written',
    (push.status >= 400 || (result && result.status !== 'applied')) && h.one('SELECT count(*) AS n FROM invoice_refunds').n === 1,
    `${push.status} ${push.text.slice(0, 300)}`);
}

console.log(`\nRefunds & discounts unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
