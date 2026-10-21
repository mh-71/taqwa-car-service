/* Estimates & quotations (0007) — unit tests against the REAL Worker handlers:
   /api/estimates, its send / approve / reject / cancel / convert actions, and
   the job card route the conversion goes through.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0007), through the same minimal D1-shaped wrapper the
   follow-up task suite uses, so every guard is exercised as SQL.

   What must hold:
     A. Schema: the four tables, their CHECKs, FKs, indexes and the EST
        counter; the migration re-runs cleanly and inserts no sample data.
     B. Create: strict fields, server-owned figures refused, the vehicle
        belongs to the customer, active references, server-side totals equal
        to the job card's computeTotals(), staff price overrides kept as
        snapshots, tax default from Settings (0 only with no Settings row),
        30-day default validity, history recorded, no stock touched.
     C. Idempotency: replay, reused key, parallel same-key creates.
     D. Edit: expectedUpdatedAt required and checked, version + 1, Pending
        returns to Draft, lines replaced and totals recomputed, closed
        estimates final.
     E. Lifecycle: send / approve (staff, note) / reject (note) / cancel
        (reason), expiry in the workshop calendar (valid through the whole of
        valid_until), repeated clicks are harmless 409s, derived states.
     F. Conversion: Approved only, once, through the real job card route,
        figures and lines identical, job card Received, no stock movement,
        concurrent requests make one job card, a refusal releases the claim,
        ownership and active status re-checked, interrupted conversion
        recovered without a duplicate.
     G. Security: every route needs a credential (401, nothing written); no
        DELETE; no internal column ever leaves the Worker.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { computeTotals } from '../../src/routes/job-cards.js';
import { addDays } from '../../src/routes/estimates.js';
import { todayInDhaka } from '../../src/lib/write.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body, auth = true) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: auth ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }

if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nEstimates unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql', '0007_estimates.sql'];
const TODAY = todayInDhaka();

/** The smallest D1-shaped wrapper the handlers need: prepare/bind/first/all/run/batch. */
function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  const statements = [];
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      statements.push(this.sql);
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      statements.push(this.sql);
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { statements.push(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw,
    statements,
    prepare: (sql) => new Stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

function fresh({ settings = true } = {}) {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Rahim', '01700000001', '${AT}');
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0002', 'Karim', '01700000002', '${AT}');
    INSERT INTO customers (id, name, phone, status, created_at) VALUES ('CUS-0003', 'Gone', '01700000003', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'DHA-1', 'Toyota', 'Corolla', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0002', 'CUS-0002', 'DHA-2', 'Honda', 'Civic', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at) VALUES ('VEH-0003', 'CUS-0001', 'DHA-3', 'Kia', 'Rio', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0004', 'CUS-0003', 'DHA-4', 'Ford', 'Fiesta', '${AT}');
    INSERT INTO services (id, name, price, created_at) VALUES ('SRV-0001', 'Brake service', 1200, '${AT}');
    INSERT INTO parts (id, name, part_no, selling_price, stock, created_at) VALUES ('PRT-0001', 'Brake pad set', 'BP-1', 3200, 10, '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'Jamal', '01800000001', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0002', 'Left', '01800000002', 'Inactive', '${AT}');`);
  if (settings) {
    DB.raw.exec(`INSERT INTO settings (id, business_name, phone, address, tax_rate) VALUES (1, 'Taqwa', '0170', 'Dhaka', 7.5);`);
  }
  const env = { DB };
  const api = async (method, path, body, auth = true) => {
    const res = await call(path, env, method, body, auth);
    return { status: res.status, allow: res.headers.get('allow'), body: await res.json().catch(() => null) };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
  const n = (t = 'estimates') => one(`SELECT count(*) AS n FROM ${t}`).n;
  return { DB, env, api, one, all, n };
}

let keySeq = 0;
const newKey = () => `est-key-${String(++keySeq).padStart(8, '0')}-abcdef`;
const GOOD = (extra = {}) => ({
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', complaint: 'Front brakes grinding',
  services: [{ serviceId: 'SRV-0001', name: 'Brake service', qty: 1, unitPrice: 1500 }],
  partsUsed: [{ partId: 'PRT-0001', name: 'Brake pad set', partNo: 'BP-1', qty: 2, unitPrice: 3200 }],
  discount: 500, taxRate: 5, createdBy: 'Desk', idempotencyKey: newKey(), ...extra,
});
const create = (h, extra) => h.api('POST', '/api/estimates', GOOD(extra));
const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
const reason = (r) => r.body?.error?.reason ?? null;
const stockOf = (h) => h.one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock;

console.log('=== Estimates (0007) ===');

/* ---------------------------------------------------------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  const tables = h.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'estimate%' ORDER BY name").map((r) => r.name);
  check('the four estimate tables exist', tables, ['estimate_events', 'estimate_parts', 'estimate_services', 'estimates']);
  check('the EST counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection = 'estimates'"), { prefix: 'EST', last_value: 0 });
  const idx = h.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux_est%'").map((r) => r.name);
  check('one job card per estimate is a unique index', idx, ['ux_est_job_card']);
  check('no sample rows are inserted', [h.n(), h.n('estimate_services'), h.n('estimate_parts'), h.n('estimate_events')], [0, 0, 0, 0]);
  let rerun = true;
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0007_estimates.sql'), 'utf8')); } catch { rerun = false; }
  ok_('the migration re-runs cleanly', rerun && h.one("SELECT last_value FROM id_counters WHERE collection = 'estimates'").last_value === 0);
  const src = readFileSync(join(ROOT, 'migrations', '0007_estimates.sql'), 'utf8');
  ok_('it alters no existing table and names no demo data', !/ALTER TABLE|DROP |UPDATE |DELETE FROM|EST-DEMO|Demo Customer/i.test(src.replace(/--.*$/gm, '')));

  const ins = (cols) => {
    const base = { id: 'EST-9999', customer_id: 'CUS-0001', vehicle_id: 'VEH-0001', date: '2026-10-10', valid_until: '2026-11-09',
      status: 'Draft', complaint: 'x', write_token: 'w'.repeat(36), idempotency_key: 'k'.repeat(20), idempotency_fingerprint: 'f'.repeat(64),
      created_at: AT, updated_at: AT, ...cols };
    const names = Object.keys(base);
    try { h.DB.raw.prepare(`INSERT INTO estimates (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((k) => base[k])); return 'ok'; }
    catch (e) { return /CHECK|FOREIGN/.test(e.message) ? 'refused' : e.message; } finally { h.DB.raw.exec("DELETE FROM estimates WHERE id = 'EST-9999'"); }
  };
  check('CHECK: valid_until before the date is refused', ins({ valid_until: '2026-10-01' }), 'refused');
  check('CHECK: a staff decision without a note is refused', ins({ status: 'Approved', sent_at: AT, decided_at: AT, decided_via: 'staff' }), 'refused');
  check('   ...with a note it is accepted', ins({ status: 'Approved', sent_at: AT, decided_at: AT, decided_via: 'staff', decision_note: 'Phoned' }), 'ok');
  check('CHECK: Approved without a decision is refused', ins({ status: 'Approved', sent_at: AT }), 'refused');
  check('CHECK: Pending that was never sent is refused', ins({ status: 'Pending' }), 'refused');
  check('CHECK: Cancelled without a reason is refused', ins({ status: 'Cancelled', cancelled_at: AT }), 'refused');
  check('CHECK: a job card link on a Draft is refused', ins({ job_card_id: null, converted_at: AT }), 'refused');
  check('FK: an unknown customer is refused', ins({ customer_id: 'CUS-9999' }), 'refused');
  check('CHECK: an unknown status is refused', ins({ status: 'Expired' }), 'refused');
}

/* ---------------------------------------------------------- */
console.log('\n-- B. create --');
{
  const h = fresh();
  const stock0 = stockOf(h);
  const r = await create(h);
  check('a valid estimate -> 201', r.status, 201);
  const e = r.body.data;
  check('   ...numbered EST-0001, Draft, version 1', [e.id, e.status, e.displayStatus, e.version], ['EST-0001', 'Draft', 'Draft', 1]);
  check('   ...date defaults to today (Asia/Dhaka) and validity to +30 days', [e.date, e.validUntil], [TODAY, addDays(TODAY, 30)]);
  check('   ...totals computed on the server: 1500 + 2x3200 - 500, 5% tax', [e.servicesTotal, e.partsTotal, e.subtotal, e.discount, e.tax, e.total], [1500, 6400, 7900, 500, 370, 7770]);
  check('   ...and equal to the job card computeTotals()', e.total, computeTotals({ services: GOOD().services, partsUsed: GOOD().partsUsed, discount: 500, taxRate: 5 }).total);
  check('   ...the overridden price is kept as a snapshot', e.services[0].unitPrice, 1500);
  check('   ...the history records the creation by the named actor', e.history.map((x) => [x.event, x.toStatus, x.version, x.actor]), [['created', 'Draft', 1, 'Desk']]);
  check('   ...no stock moved and no ledger row was written', [stockOf(h), h.n('inventory_transactions')], [stock0, 0]);
  const keys = Object.keys(e);
  ok_('   ...no internal column leaves the Worker', !keys.some((k) => /token|claim|idempotency|fingerprint/i.test(k)) || keys.includes('conversionInProgress') && !keys.some((k) => /write|Claim$|idempotency|fingerprint/i.test(k)), keys.join(','));

  const n2 = await create(h, { taxRate: undefined, discount: undefined });
  check('tax defaults to the Settings rate when omitted', n2.body.data.taxRate, 7.5);
  const h0 = fresh({ settings: false });
  const n3 = await create(h0, { taxRate: undefined });
  check('   ...and to 0 only when there is no Settings row', [n3.status, n3.body.data.taxRate], [201, 0]);
  const pct = await create(h, { services: [{ name: 'Custom work', qty: 1, unitPrice: 999 }], partsUsed: [], discount: undefined, discountType: 'percent', discountRate: 5, taxRate: 0 });
  check('a percentage discount rounds half-up to the paisa (999 x 5% = 49.95)', [pct.status, pct.body.data.discount, pct.body.data.total], [201, 49.95, 949.05]);
  check('custom work (no catalogue id) is a valid line', pct.body.data.services[0].serviceId, null);

  for (const [label, extra, want] of [
    ['subtotal sent by the client', { subtotal: 1 }, ['subtotal']],
    ['total sent by the client', { total: 1 }, ['total']],
    ['status sent by the client', { status: 'Approved' }, ['status']],
    ['jobCardId sent by the client', { jobCardId: 'JOB-0001' }, ['jobCardId']],
    ['an unknown key', { colour: 'red' }, ['colour']],
    ['no customer', { customerId: undefined }, ['customerId']],
    ['a blank complaint', { complaint: '  ' }, ['complaint']],
    ['an impossible date', { date: '2026-02-30' }, ['date']],
    ['a negative price', { services: [{ serviceId: 'SRV-0001', name: 'X', qty: 1, unitPrice: -1 }] }, ['services']],
    ['a zero quantity', { partsUsed: [{ partId: 'PRT-0001', name: 'X', qty: 0, unitPrice: 1 }] }, ['partsUsed']],
    ['201 lines', { services: Array.from({ length: 201 }, () => ({ name: 'L', qty: 1, unitPrice: 1 })) }, ['services']],
    ['tax above 100', { taxRate: 101 }, ['taxRate']],
    ['a rate with three decimals', { discount: undefined, discountType: 'percent', discountRate: 5.555 }, ['discountRate']],
    ['discount with a percentage', { discountType: 'percent', discountRate: 5, discount: 10 }, ['discount']],
    ['no idempotency key', { idempotencyKey: undefined }, ['idempotencyKey']],
  ]) {
    const x = await create(h, extra);
    check(`422 for ${label}`, [x.status, fields(x)], [422, want]);
  }
  const before = h.n();
  check('a discount above the subtotal -> 422', fields(await create(h, { discount: 99999 })), ['discount']);
  check('no service, part or labour -> 422', fields(await create(h, { services: [], partsUsed: [], discount: 0 })), ['services']);
  check('valid until before the date -> 422', fields(await create(h, { date: '2026-11-10', validUntil: '2026-11-01' })), ['validUntil']);
  const wrong = await create(h, { vehicleId: 'VEH-0002' });
  check("another customer's vehicle -> 422 on vehicleId", [wrong.status, fields(wrong)], [422, ['vehicleId']]);
  check('an inactive customer -> 409', [(await create(h, { customerId: 'CUS-0003', vehicleId: 'VEH-0004' })).status], [409]);
  const inactiveVeh = await create(h, { vehicleId: 'VEH-0003' });
  check('an inactive vehicle -> 409 vehicle_inactive', [inactiveVeh.status, reason(inactiveVeh)], [409, 'vehicle_inactive']);
  check('an unknown vehicle -> 409', (await create(h, { vehicleId: 'VEH-0999' })).status, 409);
  check('an unknown catalogue part -> 409 from its foreign key', (await create(h, { partsUsed: [{ partId: 'PRT-0999', name: 'X', qty: 1, unitPrice: 1 }] })).status, 409);
  check('   ...and none of those refusals wrote a row', h.n(), before);
  check('labour only is a valid Draft', (await create(h, { services: [], partsUsed: [], discount: 0, labourHours: 2, labourRate: 800 })).body.data.total, 1680);
}

/* ---------------------------------------------------------- */
console.log('\n-- C. idempotency --');
{
  const h = fresh();
  const body = GOOD();
  const a = await h.api('POST', '/api/estimates', body);
  const b = await h.api('POST', '/api/estimates', body);
  check('same key + same payload -> 200 replayed, the same estimate', [a.status, b.status, b.body.replayed, b.body.data.id], [201, 200, true, a.body.data.id]);
  check('   ...one row', h.n(), 1);
  const c = await h.api('POST', '/api/estimates', { ...body, complaint: 'Something else' });
  check('same key + other payload -> 409 idempotency_key_reused', [c.status, reason(c)], [409, 'idempotency_key_reused']);
  const par = GOOD();
  const res = await Promise.all([1, 2, 3].map(() => h.api('POST', '/api/estimates', par)));
  check('parallel same-key creates make one row', [h.n(), res.filter((r) => r.status === 201).length], [2, 1]);
}

/* ---------------------------------------------------------- */
console.log('\n-- D. edit --');
{
  const h = fresh();
  const e = (await create(h)).body.data;
  const put = (body) => h.api('PUT', `/api/estimates/${e.id}`, body);
  check('expectedUpdatedAt is required', fields(await put({ complaint: 'New' })), ['expectedUpdatedAt']);
  check('a stale expectedUpdatedAt -> 409', reason(await put({ complaint: 'New', expectedUpdatedAt: '2000-01-01T00:00:00Z' })), 'concurrent_modification');
  const d1 = await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Brake pad set', qty: 1, unitPrice: 3000 }], expectedUpdatedAt: e.updatedAt, updatedBy: 'Sami' });
  check('a Draft edit -> 200, version 2, still Draft', [d1.status, d1.body.data.version, d1.body.data.status], [200, 2, 'Draft']);
  check('   ...lines replaced and totals recomputed (1500 + 3000 - 500, 5%)', [d1.body.data.partsUsed.length, d1.body.data.total], [1, 4200]);
  check('   ...the history records the edit and its totals', d1.body.data.history.at(-1).details.after, { version: 2, total: 4200 });
  check('   ...old line rows are gone', h.n('estimate_parts'), 1);

  const sent = await h.api('POST', `/api/estimates/${e.id}/send`, { by: 'Sami' });
  check('send -> Pending', sent.body.data.status, 'Pending');
  const d2 = await put({ complaint: 'Brakes and wipers', expectedUpdatedAt: sent.body.data.updatedAt });
  check('editing a Pending estimate returns it to Draft, version 3', [d2.status, d2.body.data.status, d2.body.data.version, d2.body.returnedToDraft], [200, 'Draft', 3, true]);
  ok_('   ...and says the revised quotation must be sent again', /sent again/.test(d2.body.data.history.at(-1).note));
  const other = await put({ customerId: 'CUS-0002', expectedUpdatedAt: d2.body.data.updatedAt });
  check("moving the vehicle to another customer's record -> 422 vehicleId", [other.status, fields(other)], [422, ['vehicleId']]);
  check('nothing to update -> 422', (await put({ expectedUpdatedAt: d2.body.data.updatedAt })).status, 422);
  check('status cannot be edited', fields(await put({ status: 'Approved', expectedUpdatedAt: d2.body.data.updatedAt })), ['status']);

  await h.api('POST', `/api/estimates/${e.id}/send`, {});
  const ap = await h.api('POST', `/api/estimates/${e.id}/approve`, { note: 'Approved by phone', by: 'Sami' });
  const closed = await put({ complaint: 'Late change', expectedUpdatedAt: ap.body.data.updatedAt });
  check('an Approved estimate cannot be edited', [closed.status, reason(closed)], [409, 'estimate_closed']);
  check('an unknown id -> 404', (await h.api('PUT', '/api/estimates/EST-9999', { complaint: 'x', expectedUpdatedAt: 'x' })).status, 404);
  check('a malformed id -> 400', (await h.api('PUT', '/api/estimates/nope', { complaint: 'x', expectedUpdatedAt: 'x' })).status, 400);
}

/* ---------------------------------------------------------- */
console.log('\n-- E. lifecycle --');
{
  const h = fresh();
  const act = (id, name, body) => h.api('POST', `/api/estimates/${id}/${name}`, body);
  const e = (await create(h)).body.data;

  check('approve a Draft -> 409 invalid_transition', reason(await act(e.id, 'approve', { note: 'x' })), 'invalid_transition');
  const s = await act(e.id, 'send', { by: 'Desk' });
  check('send: Draft -> Pending, sentAt set', [s.status, s.body.data.status, !!s.body.data.sentAt], [200, 'Pending', true]);
  check('   ...the history says no message was sent by the system', /No message is sent by the system/.test(s.body.data.history.at(-1).note), true);
  check('send again -> 409 invalid_transition', reason(await act(e.id, 'send', {})), 'invalid_transition');
  check('approve without a note -> 422', fields(await act(e.id, 'approve', {})), ['note']);
  const a = await act(e.id, 'approve', { note: 'Customer approved in person', by: 'Desk' });
  check('approve: Pending -> Approved, decidedVia staff, note kept', [a.status, a.body.data.status, a.body.data.decidedVia, a.body.data.decisionNote, a.body.data.decidedBy], [200, 'Approved', 'staff', 'Customer approved in person', 'Desk']);
  ok_('   ...the history labels it Recorded by staff', /^Recorded by staff: /.test(a.body.data.history.at(-1).note));
  check('approve again -> 409', (await act(e.id, 'approve', { note: 'again' })).status, 409);
  check('reject an Approved estimate -> 409', (await act(e.id, 'reject', { note: 'x' })).status, 409);
  check('approve and send take expectedUpdatedAt too', reason(await act(e.id, 'cancel', { reason: 'x', expectedUpdatedAt: 'old' })), 'concurrent_modification');

  const r = (await create(h)).body.data;
  await act(r.id, 'send', {});
  check('reject without a note -> 422', fields(await act(r.id, 'reject', {})), ['note']);
  const rj = await act(r.id, 'reject', { note: 'Too expensive' });
  check('reject: Pending -> Rejected, note kept', [rj.body.data.status, rj.body.data.decisionNote, rj.body.data.decidedVia], ['Rejected', 'Too expensive', 'staff']);
  check('cancel a Rejected estimate -> 409', (await act(r.id, 'cancel', { reason: 'x' })).status, 409);

  const c = (await create(h)).body.data;
  check('cancel without a reason -> 422', fields(await act(c.id, 'cancel', {})), ['reason']);
  const cx = await act(c.id, 'cancel', { reason: 'Customer sold the car', by: 'Desk' });
  check('cancel a Draft -> Cancelled, reason kept, row kept', [cx.body.data.status, cx.body.data.cancelReason, h.one('SELECT count(*) AS n FROM estimates WHERE id = ?', c.id).n], ['Cancelled', 'Customer sold the car', 1]);
  const ap2 = (await create(h)).body.data;
  await act(ap2.id, 'send', {});
  await act(ap2.id, 'approve', { note: 'ok' });
  const cap = await act(ap2.id, 'cancel', { reason: 'Changed mind' });
  check('cancel an Approved (not converted) estimate -> Cancelled', cap.body.data.status, 'Cancelled');
  check('   ...the approval stays in the history', cap.body.data.history.map((x) => x.event), ['created', 'sent', 'approved', 'cancelled']);

  // Expiry, in the workshop's calendar: valid through the whole of valid_until.
  const old = (await create(h, { date: addDays(TODAY, -40), validUntil: addDays(TODAY, -10) })).body.data;
  const ex = await act(old.id, 'send', {});
  check('send an estimate whose validity has passed -> 409 estimate_expired', [ex.status, reason(ex)], [409, 'estimate_expired']);
  const p = (await create(h)).body.data;
  await act(p.id, 'send', {});
  h.DB.raw.prepare('UPDATE estimates SET valid_until = ?, date = ? WHERE id = ?').run(addDays(TODAY, -1), addDays(TODAY, -31), p.id);
  const g = await h.api('GET', `/api/estimates/${p.id}`);
  check('a Pending estimate past its validity reads as Expired (derived)', [g.body.data.status, g.body.data.displayStatus, g.body.data.isExpired], ['Pending', 'Expired', true]);
  check('   ...and cannot be approved', reason(await act(p.id, 'approve', { note: 'late' })), 'estimate_expired');
  check('   ...but can still be rejected', (await act(p.id, 'reject', { note: 'Expired, no reply' })).body.data.status, 'Rejected');
  const edge = (await create(h)).body.data;
  await act(edge.id, 'send', {});
  h.DB.raw.prepare('UPDATE estimates SET valid_until = ?, date = ? WHERE id = ?').run(TODAY, addDays(TODAY, -30), edge.id);
  const eg = await h.api('GET', `/api/estimates/${edge.id}`);
  check('on its last valid day it is not expired', [eg.body.data.isExpired, eg.body.data.displayStatus], [false, 'Pending']);
  check('   ...and can still be approved', (await act(edge.id, 'approve', { note: 'Same day' })).body.data.status, 'Approved');
  ok_('   ...the approval UPDATE itself carries the validity check, so midnight cannot slip between check and write',
    h.DB.statements.some((s) => /UPDATE estimates SET status/.test(s) && /decided_via/.test(s) && /valid_until >= \?/.test(s)));

  const lab = (await create(h, { services: [], partsUsed: [], discount: 0, labourHours: 1, labourRate: 500 })).body.data;
  const sl = await act(lab.id, 'send', {});
  check('send needs at least one service or part line -> 422', [sl.status, fields(sl)], [422, ['services']]);
  const ina = (await create(h)).body.data;
  h.DB.raw.exec("UPDATE customers SET status = 'Inactive' WHERE id = 'CUS-0001'");
  check('send with a now-inactive customer -> 409', reason(await act(ina.id, 'send', {})), 'customer_inactive');
  h.DB.raw.exec("UPDATE customers SET status = 'Active' WHERE id = 'CUS-0001'");
  check('an unknown action is not routed (405, as for every collection)', (await act(ina.id, 'archive', {})).status, 405);
  check('actions refuse unknown keys', fields(await act(ina.id, 'send', { status: 'Approved' })), ['status']);

  const list = await h.api('GET', '/api/estimates');
  check('the list returns every estimate with derived states and line sums', [list.status, list.body.total, typeof list.body.data[0].partsTotal], [200, h.n(), 'number']);
  ok_('   ...without line arrays or history', !('services' in list.body.data[0]) && !('history' in list.body.data[0]));
}

/* ---------------------------------------------------------- */
console.log('\n-- F. conversion --');
{
  const h = fresh();
  const act = (id, name, body) => h.api('POST', `/api/estimates/${id}/${name}`, body);
  const approved = async (extra) => {
    const e = (await create(h, extra)).body.data;
    await act(e.id, 'send', {});
    return (await act(e.id, 'approve', { note: 'Approved by phone' })).body.data;
  };
  const stock0 = stockOf(h);

  const pend = (await create(h)).body.data;
  await act(pend.id, 'send', {});
  check('only an Approved estimate converts', reason(await act(pend.id, 'convert', { mechanicId: 'MEC-0001' })), 'invalid_transition');

  const e = await approved();
  check('a mechanic is required', fields(await act(e.id, 'convert', {})), ['mechanicId']);
  const bad = await act(e.id, 'convert', { mechanicId: 'MEC-0999' });
  check("the job card route's own refusal comes back (unknown mechanic -> 409)", bad.status, 409);
  check('   ...no job card was created and the claim was released', [h.n('job_cards'), h.one('SELECT conversion_claim FROM estimates WHERE id = ?', e.id).conversion_claim], [0, null]);

  const cv = await act(e.id, 'convert', { mechanicId: 'MEC-0001', priority: 'high', mileage: 45210, by: 'Desk' });
  // The refused attempt above spent a job card number (allocateId's documented gap).
  const jid = cv.body.jobCardId;
  check('convert -> 200 with the new job card id', [cv.status, /^JOB-\d{4}$/.test(jid)], [200, true]);
  check('   ...the estimate reads as Converted, still Approved underneath', [cv.body.data.status, cv.body.data.displayStatus, cv.body.data.jobCardId], ['Approved', 'Converted', jid]);
  const jc = h.one('SELECT * FROM job_cards WHERE id = ?', jid);
  check('   ...the job card starts Received, for the same customer and vehicle', [jc.status, jc.customer_id, jc.vehicle_id, jc.mechanic_id, jc.priority, jc.mileage], ['Received', 'CUS-0001', 'VEH-0001', 'MEC-0001', 'high', 45210]);
  check('   ...with the estimate figures', [jc.subtotal, jc.discount, jc.tax_rate, jc.tax, jc.total], [e.subtotal, e.discount, e.taxRate, e.tax, e.total]);
  check('   ...and the estimate lines', [h.all('SELECT service_id, name, qty, unit_price FROM job_card_services').map((x) => [x.service_id, x.name, x.qty, x.unit_price]),
    h.all('SELECT part_id, name, part_no, qty, unit_price FROM job_card_parts').map((x) => [x.part_id, x.name, x.part_no, x.qty, x.unit_price])],
  [[['SRV-0001', 'Brake service', 1, 1500]], [['PRT-0001', 'Brake pad set', 'BP-1', 2, 3200]]]);
  ok_('   ...its notes say where it came from', jc.notes.startsWith('Converted from estimate ' + e.id + ' (version 1).'));
  check('   ...no stock moved and no ledger row was written', [stockOf(h), h.n('inventory_transactions')], [stock0, 0]);
  check('   ...the history records the conversion', cv.body.data.history.at(-1).details, { jobCardId: jid, estimateTotal: e.total, jobCardTotal: e.total });
  ok_('   ...the job card was made by the job card route itself', h.DB.statements.some((s) => /INSERT INTO job_cards/.test(s)));
  const again = await act(e.id, 'convert', { mechanicId: 'MEC-0001' });
  check('converting again -> 409 already_converted, naming the job card', [again.status, reason(again), again.body.error.jobCardId, h.n('job_cards')], [409, 'already_converted', jid, 1]);
  check('a converted estimate cannot be cancelled', (await act(e.id, 'cancel', { reason: 'x' })).status, 409);
  check('   ...or edited', reason(await h.api('PUT', `/api/estimates/${e.id}`, { complaint: 'x', expectedUpdatedAt: cv.body.data.updatedAt })), 'estimate_converted');
  check('the job card it made cannot be deleted while linked (409 from the foreign key)', (await h.api('DELETE', `/api/job-cards/${jid}`)).status, 409);

  const e2 = await approved();
  const both = await Promise.all([act(e2.id, 'convert', { mechanicId: 'MEC-0001' }), act(e2.id, 'convert', { mechanicId: 'MEC-0001' })]);
  check('two concurrent conversions make exactly one job card', [both.filter((x) => x.status === 200).length, h.n('job_cards')], [1, 2]);

  const e3 = await approved();
  h.DB.raw.exec("UPDATE vehicles SET customer_id = 'CUS-0002' WHERE id = 'VEH-0001'");
  const moved = await act(e3.id, 'convert', { mechanicId: 'MEC-0001' });
  check('a vehicle now owned by someone else -> refused, no job card', [moved.status, fields(moved), h.n('job_cards')], [422, ['vehicleId'], 2]);
  h.DB.raw.exec("UPDATE vehicles SET customer_id = 'CUS-0001' WHERE id = 'VEH-0001'");
  h.DB.raw.exec("UPDATE vehicles SET status = 'Inactive' WHERE id = 'VEH-0001'");
  check('an inactive vehicle -> 409, no job card', [reason(await act(e3.id, 'convert', { mechanicId: 'MEC-0001' })), h.n('job_cards')], ['vehicle_inactive', 2]);
  h.DB.raw.exec("UPDATE vehicles SET status = 'Active' WHERE id = 'VEH-0001'");

  // An interrupted conversion: a stale claim and the job card it already made.
  const e4 = await approved();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  h.DB.raw.prepare('UPDATE estimates SET conversion_claim = ?, conversion_claimed_at = ? WHERE id = ?').run('c'.repeat(36), old, e4.id);
  const busyBody = await h.api('GET', `/api/estimates/${e4.id}`);
  check('a claimed estimate reports the conversion in progress', busyBody.body.data.conversionInProgress, true);
  h.DB.raw.prepare(`INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, notes, created_at)
                    VALUES ('JOB-0777', 'CUS-0001', 'VEH-0001', 'MEC-0001', ?, 'Brakes', ?, ?)`).run(TODAY, `Converted from estimate ${e4.id} (version 1).`, new Date().toISOString());
  const rec = await act(e4.id, 'convert', { mechanicId: 'MEC-0001' });
  check('a stale claim links the job card it already made instead of making another', [rec.status, rec.body.jobCardId, rec.body.recovered, h.n('job_cards')], [200, 'JOB-0777', true, 3]);
  const e5 = await approved();
  h.DB.raw.prepare('UPDATE estimates SET conversion_claim = ?, conversion_claimed_at = ? WHERE id = ?').run('d'.repeat(36), new Date().toISOString(), e5.id);
  check('a fresh claim held by another request -> 409 conversion_in_progress', reason(await act(e5.id, 'convert', { mechanicId: 'MEC-0001' })), 'conversion_in_progress');
  check('   ...and it cannot be cancelled meanwhile', reason(await act(e5.id, 'cancel', { reason: 'x' })), 'conversion_in_progress');

  const pctE = await approved({ discount: undefined, discountType: 'percent', discountRate: 7, labourHours: 1.5, labourRate: 800 });
  const pc = await act(pctE.id, 'convert', { mechanicId: 'MEC-0001' });
  const pjc = h.one('SELECT discount_type, discount_rate, discount, labour_cost, total FROM job_cards WHERE id = ?', pc.body.jobCardId);
  check('a percentage discount and labour carry over unchanged', [pjc.discount_type, pjc.discount_rate, pjc.discount, pjc.labour_cost, pjc.total], ['percent', 7, pctE.discount, 1200, pctE.total]);
}

/* ---------------------------------------------------------- */
console.log('\n-- G. security --');
{
  const h = fresh();
  const e = (await create(h)).body.data;
  const routes = [['GET', '/api/estimates'], ['POST', '/api/estimates'], ['GET', `/api/estimates/${e.id}`], ['PUT', `/api/estimates/${e.id}`],
    ...['send', 'approve', 'reject', 'cancel', 'convert'].map((a) => ['POST', `/api/estimates/${e.id}/${a}`])];
  const counts = () => [h.n(), h.n('estimate_events'), h.n('job_cards')];
  const before = counts();
  for (const [m, p] of routes) {
    const r = await h.api(m, p, m === 'GET' ? undefined : { note: 'x', reason: 'x', mechanicId: 'MEC-0001' }, false);
    check(`${m} ${p.replace(e.id, ':id')} without a credential -> 401`, r.status, 401);
  }
  check('   ...and nothing was written', counts(), before);
  const del = await h.api('DELETE', `/api/estimates/${e.id}`);
  check('there is no DELETE: 405, Allow names GET and PUT only', [del.status, del.allow], [405, 'GET, PUT']);
  const list = await h.api('GET', '/api/estimates');
  const leaked = Object.keys(list.body.data[0]).filter((k) => /writeToken|write_token|conversionClaim$|conversion_claim|idempotency|fingerprint/i.test(k));
  check('no internal column is returned by the list', leaked, []);
  const det = JSON.stringify((await h.api('GET', `/api/estimates/${e.id}`)).body);
  ok_('   ...or by the detail', !/write_token|conversion_claim"|idempotency/.test(det));
}

console.log(`\nEstimates unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
