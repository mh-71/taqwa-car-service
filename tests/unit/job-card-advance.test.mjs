/* Job Card Advance — recorded advances applied to the invoice on create.
   Runs the REAL Worker handlers against an in-memory SQLite database built
   from the real migrations, through a minimal D1-shaped wrapper (the same
   one api-invoice-adjustments-write.test.mjs uses).

   What is promised:
     - an advance is a payment: recorded against a job card of the SAME
       customer, before that job card is invoiced;
     - creating the invoice applies every such advance, whole, in the same
       batch, and paid/due/status come from the ledger -- never from the job
       card's typed Paid/Advance;
     - nothing is applied partly: advances over the total, an advance of
       another customer, or advances that changed under the request stop the
       create and write nothing;
     - void payments, payments already linked elsewhere and general advances
       (no job card) are never applied;
     - write-offs and the existing payment guards keep working on top;
     - no payment is created, and none counted twice.

   Real D1 -- its batch transaction and concurrent requests -- is the
   integration suite's job. Needs node:sqlite (Node 22.5+); says SKIPPED
   without it. */
import worker from '../../src/index.js';
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
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });

console.log('=== Job Card Advance: recorded advances applied on invoice create ===');
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }

if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
} else {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const AT = '2026-10-08T00:00:00Z';

  /** The smallest D1-shaped wrapper the handlers need: prepare/bind/first/all/run/batch. */
  function makeD1() {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_initial_schema.sql', '0002_invoice_adjustments.sql']) {
      raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
    }
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
      async first(col) { const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r; }
      async all() { return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
      async run() { return this.exec(); }
    }
    const db = {
      raw,
      beforeBatch: null,   // a hook a test sets to change data between read and write
      prepare: (sql) => new Stmt(sql),
      async batch(statements) {
        if (db.beforeBatch) { const f = db.beforeBatch; db.beforeBatch = null; f(raw, statements); }
        raw.exec('BEGIN');
        try { const out = statements.map((s) => s.exec()); raw.exec('COMMIT'); return out; }
        catch (e) { raw.exec('ROLLBACK'); throw e; }
      },
    };
    return db;
  }

  function fresh() {
    const DB = makeD1();
    DB.raw.exec(`
      INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'A', '01700000001', '${AT}');
      INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0002', 'B', '01700000002', '${AT}');
      INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'B', 'M', '${AT}');
      INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0002', 'CUS-0002', 'R2', 'B', 'M', '${AT}');
      INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'M', '017', '${AT}');`);
    const env = { DB };
    const api = async (method, path, body) => {
      const res = await call(path, env, method, body);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const q = (sql, ...a) => DB.raw.prepare(sql).get(...a);
    const qa = (sql, ...a) => DB.raw.prepare(sql).all(...a);
    const inv = (id) => ({ ...q('SELECT total, paid, written_off AS writtenOff, due, status FROM invoices WHERE id = ?', id) });
    const payment = (id) => ({ ...q('SELECT invoice_id, job_card_id, customer_id, date, amount, method, status, notes FROM payments WHERE id = ?', id) });
    const counts = () => ({
      invoices: q('SELECT count(*) AS n FROM invoices').n,
      lines: q('SELECT (SELECT count(*) FROM invoice_services) + (SELECT count(*) FROM invoice_parts) AS n').n,
      payments: q('SELECT count(*) AS n FROM payments').n,
      linked: q('SELECT count(*) AS n FROM payments WHERE invoice_id IS NOT NULL').n,
    });
    const cash = () => q(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE status <> 'Void'`).s;
    return { DB, api, q, qa, inv, payment, counts, cash };
  }

  /** A job card for `customer`, left at In Progress unless `complete`. */
  async function jobCard(h, total, { customer = 'CUS-0001', vehicle = 'VEH-0001', typedPaid = 0, complete = true } = {}) {
    const j = await h.api('POST', '/api/job-cards', {
      customerId: customer, vehicleId: vehicle, mechanicId: 'MEC-0001', date: '2026-10-01', complaint: 'x',
      services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: total }], partsUsed: [], paid: typedPaid,
    });
    if (j.status !== 201) throw new Error(`job card create failed: ${JSON.stringify(j.body)}`);
    const id = j.body.data.id;
    for (const s of ['Inspection', 'In Progress']) await h.api('POST', `/api/job-cards/${id}/status`, { status: s });
    if (complete) await complete_(h, id);
    return id;
  }
  const complete_ = (h, id) => h.api('POST', `/api/job-cards/${id}/status`, { status: 'Completed' });
  const advance = (h, jobCardId, amount, extra = {}) => h.api('POST', '/api/payments',
    { customerId: 'CUS-0001', jobCardId, amount, date: '2026-10-02', method: 'Cash', ...extra });
  const createInvoice = (h, jobCardId) => h.api('POST', '/api/invoices', { jobCardId });
  const fig = (o) => [o.paid, o.writtenOff, o.due, o.status];

  /* ---------------------------------------------------------- */
  console.log('\n-- 1. Success: an advance recorded on the job card is applied --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false, typedPaid: 800 });
    const a = await advance(h, job, 1000, { method: 'Mobile Banking', date: '2026-10-03', notes: 'bKash' });
    check('record an advance on an In Progress job card -> 201', a.status, 201);
    const pid = a.body.data.id;
    check('   ...it is an advance: no invoice, this job card', [a.body.data.invoiceId, a.body.data.jobCardId], [null, job]);
    await complete_(h, job);
    const before = { counts: h.counts(), cash: h.cash() };

    const r = await createInvoice(h, job);
    check('create the invoice -> 201', r.status, 201);
    const iid = r.body.data.id;
    check('   ...reports the advance it applied', r.body.appliedAdvances, [{ id: pid, date: '2026-10-03', amount: 1000, method: 'Mobile Banking' }]);
    check('   ...and the applied total', r.body.appliedAdvanceTotal, 1000);
    check('   ...the response already carries the ledger figures', [r.body.data.paid, r.body.data.due, r.body.data.status], [1000, 2000, 'Partial']);
    check('invoice paid/due/status come from the ledger, not the typed 800', fig(h.inv(iid)), [1000, 0, 2000, 'Partial']);
    check('the payment is now linked to the invoice, still naming the job card',
      [h.payment(pid).invoice_id, h.payment(pid).job_card_id], [iid, job]);
    check('   ...with its date, method, amount, notes and status untouched',
      [h.payment(pid).date, h.payment(pid).method, h.payment(pid).amount, h.payment(pid).notes, h.payment(pid).status],
      ['2026-10-03', 'Mobile Banking', 1000, 'bKash', 'Active']);
    ok_('   ...and an updated_at stamp', !!h.q('SELECT updated_at FROM payments WHERE id = ?', pid).updated_at);
    check('no payment was created by invoicing', h.counts().payments, before.counts.payments);
    check('cash received is unchanged -- nothing counted twice', h.cash(), before.cash);
    check('the job card keeps its typed figure and points at the invoice',
      [h.q('SELECT paid, invoice_id FROM job_cards WHERE id = ?', job).paid, h.q('SELECT invoice_id FROM job_cards WHERE id = ?', job).invoice_id], [800, iid]);
    const got = await h.api('GET', `/api/payments/${pid}`);
    check('GET /api/payments/:id shows both references', [got.body.data.invoiceId, got.body.data.jobCardId], [iid, job]);

    // the invoice then takes ordinary payments on top
    const p2 = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: iid, amount: 2000 });
    check('a later payment settles it', [p2.status, ...fig(h.inv(iid))], [201, 3000, 0, 0, 'Paid']);
    const p3 = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: iid, amount: 1 });
    check('   ...and the overpayment guard still counts the advance', [p3.status, p3.body.error?.reason], [409, 'overpayment']);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    const a1 = await advance(h, job, 700, { date: '2026-10-04' });
    const a2 = await advance(h, job, 500, { date: '2026-10-02', method: 'Card' });
    await complete_(h, job);
    const r = await createInvoice(h, job);
    check('two advances -> both applied, oldest first',
      r.body.appliedAdvances.map((x) => x.id), [a2.body.data.id, a1.body.data.id]);
    check('   ...paid is their sum', fig(h.inv(r.body.data.id)), [1200, 0, 1800, 'Partial']);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000);   // advance on a Completed, un-invoiced card is fine
    await advance(h, job, 3000);
    const r = await createInvoice(h, job);
    check('an advance equal to the total -> Paid, due 0', [r.status, ...fig(h.inv(r.body.data.id))], [201, 3000, 0, 0, 'Paid']);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { typedPaid: 1000 });
    const r = await createInvoice(h, job);
    check('a typed Paid/Advance with no recorded advance applies nothing', [r.status, ...fig(h.inv(r.body.data.id))], [201, 0, 0, 3000, 'Unpaid']);
    check('   ...and reports no advance', [r.body.appliedAdvances, r.body.appliedAdvanceTotal], [[], 0]);
    check('   ...no payment exists', h.counts().payments, 0);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 2. Duplicate and repeated submissions --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const a = await advance(h, job, 1000);
    const r1 = await createInvoice(h, job);
    const snap = { counts: h.counts(), inv: h.inv(r1.body.data.id) };
    const r2 = await createInvoice(h, job);
    check('creating the invoice again -> 409 invoice_exists', [r2.status, r2.body.error?.reason], [409, 'invoice_exists']);
    check('   ...nothing more was written', h.counts(), snap.counts);
    check('   ...the first invoice is unchanged', h.inv(r1.body.data.id), snap.inv);
    check('   ...the advance is linked once', h.payment(a.body.data.id).invoice_id, r1.body.data.id);

    const again = await h.api('POST', `/api/payments/${a.body.data.id}/link`, { invoiceId: r1.body.data.id });
    check('linking the applied advance by hand -> 409 payment_already_linked', [again.status, again.body.error?.reason], [409, 'payment_already_linked']);
    check('   ...paid is not doubled', h.inv(r1.body.data.id).paid, 1000);

    const late = await advance(h, job, 500);
    check('an advance for the now-invoiced job card -> 409 job_card_invoiced',
      [late.status, late.body.error?.reason, late.body.error?.invoiceId], [409, 'job_card_invoiced', r1.body.data.id]);
    check('   ...and no payment row was written', h.counts().payments, snap.counts.payments);
  }
  {
    // two creates racing: the second batch hits ux_invoices_live_job_card
    const h = fresh();
    const job = await jobCard(h, 3000);
    const a = await advance(h, job, 1000);
    const first = createInvoice(h, job);
    const second = createInvoice(h, job);
    const [x, y] = await Promise.all([first, second]);
    const statuses = [x.status, y.status].sort();
    check('two concurrent creates: one 201, one 409', statuses, [201, 409]);
    check('   ...one invoice exists', h.counts().invoices, 1);
    const winner = (x.status === 201 ? x : y).body.data.id;
    check('   ...the advance is applied to it, once', [h.payment(a.body.data.id).invoice_id, h.inv(winner).paid], [winner, 1000]);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 3. Wrong customer --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const r = await advance(h, job, 1000, { customerId: 'CUS-0002' });
    check('an advance from another customer for this job card -> 409 job_card_customer_mismatch',
      [r.status, r.body.error?.reason], [409, 'job_card_customer_mismatch']);
    check('   ...nothing was written', h.counts().payments, 0);
    const p = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', jobCardId: 'JOB-9999', amount: 10 });
    check('an advance for a job card that does not exist -> 409 job_card_not_found', [p.status, p.body.error?.reason], [409, 'job_card_not_found']);
  }
  {
    // a legacy row (before the guard) naming another customer stops the create
    const h = fresh();
    const job = await jobCard(h, 3000);
    await advance(h, job, 400);
    h.DB.raw.prepare(`INSERT INTO payments (id, invoice_id, customer_id, job_card_id, date, amount, method, status, created_at)
                      VALUES ('PAY-0900', NULL, 'CUS-0002', ?, '2026-10-01', 600, 'Cash', 'Active', ?)`).run(job, AT);
    const before = h.counts();
    const r = await createInvoice(h, job);
    check('an advance of another customer on the job card -> 409 advance_customer_mismatch',
      [r.status, r.body.error?.reason, r.body.error?.advances?.map((x) => x.id)], [409, 'advance_customer_mismatch', ['PAY-0900']]);
    check('   ...nothing was created or linked', h.counts(), before);
    check('   ...the job card is still un-invoiced', h.q('SELECT invoice_id FROM job_cards WHERE id = ?', job).invoice_id, null);

    // and the same legacy row cannot be linked to its own customer's invoice either
    const job2 = await jobCard(h, 2000, { customer: 'CUS-0002', vehicle: 'VEH-0002' });
    const r2 = await createInvoice(h, job2);
    const l = await h.api('POST', '/api/payments/PAY-0900/link', { invoiceId: r2.body.data.id });
    check('linking it to CUS-0002\'s invoice -> 409 job_card_customer_mismatch', [l.status, l.body.error?.reason], [409, 'job_card_customer_mismatch']);
    check('   ...the invoice is untouched', fig(h.inv(r2.body.data.id)), [0, 0, 2000, 'Unpaid']);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const job2 = await jobCard(h, 2000, { customer: 'CUS-0002', vehicle: 'VEH-0002' });
    const r2 = await createInvoice(h, job2);
    const p = await h.api('POST', '/api/payments', { customerId: 'CUS-0002', invoiceId: r2.body.data.id, jobCardId: job, amount: 100 });
    check('an invoice payment naming another customer\'s job card -> 409 job_card_customer_mismatch',
      [p.status, p.body.error?.reason], [409, 'job_card_customer_mismatch']);
    check('   ...the invoice is untouched', fig(h.inv(r2.body.data.id)), [0, 0, 2000, 'Unpaid']);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 4. Void payments are never applied --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const keep = await advance(h, job, 1000);
    const gone = await advance(h, job, 500);
    const v = await h.api('POST', `/api/payments/${gone.body.data.id}/void`, {});
    check('void one advance -> 200', v.status, 200);
    const r = await createInvoice(h, job);
    check('only the Active advance is applied', r.body.appliedAdvances.map((x) => x.id), [keep.body.data.id]);
    check('   ...paid excludes the void one', fig(h.inv(r.body.data.id)), [1000, 0, 2000, 'Partial']);
    check('   ...which stays unlinked and Void', [h.payment(gone.body.data.id).invoice_id, h.payment(gone.body.data.id).status], [null, 'Void']);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 5. Payments already linked, and general advances --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const general = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', amount: 250 });
    check('a general advance (no job card) -> 201', general.status, 201);
    await advance(h, job, 1000);
    const r = await createInvoice(h, job);
    check('a general advance is not applied automatically', [r.body.appliedAdvanceTotal, h.payment(general.body.data.id).invoice_id], [1000, null]);
    const l = await h.api('POST', `/api/payments/${general.body.data.id}/link`, { invoiceId: r.body.data.id });
    check('   ...it can still be linked by hand', [l.status, ...fig(h.inv(r.body.data.id))], [200, 1250, 0, 1750, 'Partial']);
  }
  {
    // void -> released advances keep the job card -> the replacement applies them
    const h = fresh();
    const job = await jobCard(h, 3000);
    await advance(h, job, 1000);
    const r1 = await createInvoice(h, job);
    await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: r1.body.data.id, amount: 1500 });
    const cashBefore = h.cash();
    const v = await h.api('POST', `/api/invoices/${r1.body.data.id}/void`, {});
    check('void the invoice -> 200', v.status, 200);
    check('   ...both payments are released as this job card\'s advances',
      h.qa('SELECT invoice_id, job_card_id FROM payments ORDER BY id').map((p) => [p.invoice_id, p.job_card_id]), [[null, job], [null, job]]);
    check('   ...the Void invoice keeps its frozen figures', fig(h.inv(r1.body.data.id)), [2500, 0, 500, 'Void']);
    const r2 = await createInvoice(h, job);
    check('the replacement invoice applies both', [r2.status, r2.body.appliedAdvanceTotal, ...fig(h.inv(r2.body.data.id))], [201, 2500, 2500, 0, 500, 'Partial']);
    check('   ...cash is unchanged through the round trip', h.cash(), cashBefore);
    check('   ...the Void invoice is still frozen', fig(h.inv(r1.body.data.id)), [2500, 0, 500, 'Void']);
    check('   ...and no payment is attached to it', h.q('SELECT count(*) AS n FROM payments WHERE invoice_id = ?', r1.body.data.id).n, 0);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 6. Write-offs on top of an applied advance --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    await advance(h, job, 1000);
    const r = await createInvoice(h, job);
    const iid = r.body.data.id;
    const wo = await h.api('POST', '/api/invoice-adjustments', { invoiceId: iid, amount: 500, reason: 'Customer concession', expectedDue: 2000 });
    check('a write-off sees the due left after the advance', wo.status, 201);
    check('   ...paid 1,000, written off 500, due 1,500', fig(h.inv(iid)), [1000, 500, 1500, 'Partial']);
    const over = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: iid, amount: 1501 });
    check('   ...a payment over what is left is refused', [over.status, over.body.error?.reason], [409, 'overpayment']);
    const fit = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: iid, amount: 1500 });
    check('   ...the exact remainder settles it', [fit.status, ...fig(h.inv(iid))], [201, 2500, 500, 0, 'Paid']);
    check('cash counts only payments, never the write-off', h.cash(), 2500);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 7. The invoice total is the limit --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000);
    const a1 = await advance(h, job, 2000);
    const a2 = await advance(h, job, 1500);
    const before = h.counts();
    const counter = h.q(`SELECT last_value FROM id_counters WHERE collection = 'invoices'`);
    const r = await createInvoice(h, job);
    check('advances over the total -> 409 advance_exceeds_total', [r.status, r.body.error?.reason], [409, 'advance_exceeds_total']);
    check('   ...the message says nothing was created', /Nothing was created/.test(r.body.error?.message), true);
    check('   ...nothing was written', h.counts(), before);
    check('   ...no invoice id was consumed', h.q(`SELECT last_value FROM id_counters WHERE collection = 'invoices'`), counter);
    check('   ...both advances stay unlinked', [h.payment(a1.body.data.id).invoice_id, h.payment(a2.body.data.id).invoice_id], [null, null]);
    check('   ...the job card is still un-invoiced', h.q('SELECT invoice_id FROM job_cards WHERE id = ?', job).invoice_id, null);

    // voiding the wrong one lets the create go ahead
    await h.api('POST', `/api/payments/${a2.body.data.id}/void`, {});
    const ok2 = await createInvoice(h, job);
    check('after voiding the extra advance -> 201, the other applied', [ok2.status, ok2.body.appliedAdvanceTotal], [201, 2000]);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 1000);
    await advance(h, job, 333.33);
    await advance(h, job, 333.33);
    await advance(h, job, 333.34);
    const r = await createInvoice(h, job);
    check('fractional advances that add up to the total -> Paid', [r.status, h.inv(r.body.data.id).status, h.inv(r.body.data.id).due], [201, 'Paid', 0]);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 8. Advances that change under the request --');
  for (const [label, change] of [
    ['an advance recorded between the read and the write', (raw, job) =>
      raw.prepare(`INSERT INTO payments (id, invoice_id, customer_id, job_card_id, date, amount, method, status, created_at)
                   VALUES ('PAY-0999', NULL, 'CUS-0001', ?, '2026-10-02', 100, 'Cash', 'Active', ?)`).run(job_(raw), AT)],
    ['an advance voided between the read and the write', (raw) =>
      raw.prepare(`UPDATE payments SET status = 'Void' WHERE id = (SELECT MIN(id) FROM payments)`).run()],
    ['an advance linked elsewhere between the read and the write', (raw) =>
      raw.prepare(`UPDATE payments SET invoice_id = 'INV-0777' WHERE id = (SELECT MIN(id) FROM payments)`).run()],
  ]) {
    const h = fresh();
    const job = await jobCard(h, 3000);
    await advance(h, job, 1000);
    await advance(h, job, 500);
    if (/linked elsewhere/.test(label)) {
      // a real invoice for the foreign key to point at
      h.DB.raw.exec(`INSERT INTO invoices (id, job_card_id, customer_id, vehicle_id, date, total, paid, due, status, created_at)
                     VALUES ('INV-0777', NULL, 'CUS-0001', 'VEH-0001', '2026-10-01', 5000, 0, 5000, 'Unpaid', '${AT}')`);
    }
    const before = h.counts();
    h.DB.beforeBatch = (raw) => change(raw, job);
    const r = await createInvoice(h, job);
    check(`${label} -> 409 advances_changed`, [r.status, r.body.error?.reason], [409, 'advances_changed']);
    const after = h.counts();
    check('   ...no invoice and no lines were written', [after.invoices, after.lines], [before.invoices, before.lines]);
    check('   ...the job card is still un-invoiced', h.q('SELECT invoice_id FROM job_cards WHERE id = ?', job).invoice_id, null);
    check('   ...no advance was linked to a new invoice',
      h.q(`SELECT count(*) AS n FROM payments WHERE invoice_id IS NOT NULL AND invoice_id <> 'INV-0777'`).n, 0);
    const retry = await createInvoice(h, job);
    check('   ...a retry applies exactly what is there now', retry.status, 201);
    const rid = retry.body?.data?.id ?? null;
    const expected = h.q(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ? AND status <> 'Void'`, rid).s;
    check('   ...and paid matches its linked payments', [retry.body?.appliedAdvanceTotal, rid && h.inv(rid).paid], [expected, expected]);
  }
  function job_(raw) { return raw.prepare('SELECT id FROM job_cards ORDER BY id DESC LIMIT 1').get().id; }

  /* ---------------------------------------------------------- */
  console.log('\n-- 9. Revenue: every taka counted once --');
  {
    const h = fresh();
    const job = await jobCard(h, 5000);
    await advance(h, job, 1000, { date: '2026-10-02' });
    await advance(h, job, 1500, { date: '2026-10-03' });
    const r = await createInvoice(h, job);
    await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: r.body.data.id, amount: 2500, date: '2026-10-05' });
    const byDay = h.qa(`SELECT date, SUM(amount) AS s FROM payments WHERE status <> 'Void' GROUP BY date ORDER BY date`);
    check('cash by day keeps each payment on the day it was taken',
      byDay.map((d) => [d.date, d.s]), [['2026-10-02', 1000], ['2026-10-03', 1500], ['2026-10-05', 2500]]);
    check('total cash equals invoice paid', [h.cash(), h.inv(r.body.data.id).paid], [5000, 5000]);
    check('   ...and the invoice is Paid', h.inv(r.body.data.id).status, 'Paid');
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 10. A job card holding money keeps its customer (M1) --');
  const putJob = (h, id, body) => h.api('PUT', `/api/job-cards/${id}`, body);
  const jobRow = (h, id) => ({ ...h.q('SELECT customer_id, vehicle_id, notes FROM job_cards WHERE id = ?', id) });
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    const a = await advance(h, job, 1000);
    const before = { row: jobRow(h, job), lines: h.qa('SELECT name, unit_price FROM job_card_services WHERE job_card_id = ?', job) };
    const r = await putJob(h, job, { customerId: 'CUS-0002', vehicleId: 'VEH-0002', notes: 'moved' });
    check('changing the customer of a job card with an Active advance -> 409 job_card_has_payments',
      [r.status, r.body.error?.reason, r.body.error?.payments], [409, 'job_card_has_payments', [a.body.data.id]]);
    ok_('   ...with a message that says why and what to do',
      /customer cannot be changed/.test(r.body.error?.message) && /Void those payments first/.test(r.body.error?.message), r.body.error?.message);
    check('   ...nothing was written: customer, vehicle and notes as before', jobRow(h, job), before.row);
    check('   ...and the lines untouched', h.qa('SELECT name, unit_price FROM job_card_services WHERE job_card_id = ?', job), before.lines);
    check('   ...the advance still belongs to its customer and job card',
      [h.payment(a.body.data.id).customer_id, h.payment(a.body.data.id).job_card_id], ['CUS-0001', job]);

    const same = await putJob(h, job, { customerId: 'CUS-0001', vehicleId: 'VEH-0001', notes: 'still CUS-0001' });
    check('an edit that keeps the customer still works with the advance in place', [same.status, jobRow(h, job).notes], [200, 'still CUS-0001']);
    const other = await putJob(h, job, { discount: 100 });
    check('   ...and so does an edit that does not name the customer', [other.status, h.q('SELECT total FROM job_cards WHERE id = ?', job).total], [200, 2900]);
    const inv = await (async () => { await complete_(h, job); return createInvoice(h, job); })();
    check('   ...and the job card still invoices with its advance applied', [inv.status, inv.body.appliedAdvanceTotal], [201, 1000]);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    const r = await putJob(h, job, { customerId: 'CUS-0002', vehicleId: 'VEH-0002' });
    check('no payment on the job card -> the customer change is allowed as before',
      [r.status, r.body.data?.customerId, jobRow(h, job).customer_id], [200, 'CUS-0002', 'CUS-0002']);
    const mismatch = await putJob(h, job, { customerId: 'CUS-0001' });
    check('   ...and the vehicle-ownership rule still applies', [mismatch.status, mismatch.body.error?.fields?.vehicleId],
      [422, 'Selected vehicle does not belong to this customer.']);
  }
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    const a = await advance(h, job, 500);
    await h.api('POST', `/api/payments/${a.body.data.id}/void`, {});
    const r = await putJob(h, job, { customerId: 'CUS-0002', vehicleId: 'VEH-0002' });
    check('only a Void payment on the job card -> the customer change is allowed', [r.status, jobRow(h, job).customer_id], [200, 'CUS-0002']);
  }
  {
    // the race: an advance lands between the check and the write
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    const before = { row: jobRow(h, job), lines: h.qa('SELECT name, unit_price FROM job_card_services WHERE job_card_id = ?', job) };
    h.DB.beforeBatch = (raw) => raw.prepare(
      `INSERT INTO payments (id, invoice_id, customer_id, job_card_id, date, amount, method, status, created_at)
       VALUES ('PAY-0888', NULL, 'CUS-0001', ?, '2026-10-02', 700, 'Cash', 'Active', ?)`).run(job, AT);
    const r = await putJob(h, job, {
      customerId: 'CUS-0002', vehicleId: 'VEH-0002', notes: 'raced',
      services: [{ serviceId: null, name: 'Changed', qty: 1, unitPrice: 9999 }],
    });
    check('an advance recorded during the edit -> 409 job_card_has_payments',
      [r.status, r.body.error?.reason, r.body.error?.payments], [409, 'job_card_has_payments', ['PAY-0888']]);
    check('   ...the whole edit rolled back: customer, vehicle, notes', jobRow(h, job), before.row);
    check('   ...and the lines', h.qa('SELECT name, unit_price FROM job_card_services WHERE job_card_id = ?', job), before.lines);
    check('   ...the advance stays with its customer', h.payment('PAY-0888').customer_id, 'CUS-0001');
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 11. No advance on a Cancelled job card (L1) --');
  {
    const h = fresh();
    const job = await jobCard(h, 3000, { complete: false });
    await h.api('POST', `/api/job-cards/${job}/status`, { status: 'Cancelled' });
    const before = h.counts();
    const r = await advance(h, job, 500);
    check('an advance for a Cancelled job card -> 409 job_card_cancelled',
      [r.status, r.body.error?.reason, r.body.error?.jobCardId], [409, 'job_card_cancelled', job]);
    ok_('   ...saying why', /Cancelled/.test(r.body.error?.message), r.body.error?.message);
    check('   ...and no payment row was written', h.counts(), before);
    const general = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', amount: 500 });
    check('a general advance for the same customer is unaffected', general.status, 201);
  }
  {
    // every status an advance may be taken in, reached by the real transitions
    const h = fresh();
    const walk = {
      'Received': [], 'Inspection': ['Inspection'], 'Waiting for Approval': ['Inspection', 'Waiting for Approval'],
      'In Progress': ['Inspection', 'In Progress'], 'Waiting for Parts': ['Inspection', 'In Progress', 'Waiting for Parts'],
      'Completed': ['Inspection', 'In Progress', 'Completed'], 'Delivered': ['Inspection', 'In Progress', 'Completed', 'Delivered'],
    };
    const got = [];
    for (const [status, path] of Object.entries(walk)) {
      const j = await h.api('POST', '/api/job-cards', {
        customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-01', complaint: 'x',
        services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: 1000 }], partsUsed: [],
      });
      for (const s of path) await h.api('POST', `/api/job-cards/${j.body.data.id}/status`, { status: s });
      const st = h.q('SELECT status FROM job_cards WHERE id = ?', j.body.data.id).status;
      const r = await advance(h, j.body.data.id, 100);
      got.push([st, r.status]);
    }
    check('an advance is accepted in every other status',
      got, Object.keys(walk).map((st) => [st, 201]));
  }
}

console.log(`\nJob Card Advance: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
