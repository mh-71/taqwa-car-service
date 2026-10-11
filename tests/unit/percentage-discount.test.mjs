/* Percentage discount — a job card discount given as a percentage of the
   subtotal, as well as (never together with) the fixed amount it always had.

   What is promised:
     - the amount is rate% of the subtotal, half-up to the paisa, worked in
       integers: 16,000 x 7% = 1,120 and 999 x 5% = 49.95, with no float
       residue in the total; tax is still taken AFTER the discount and still
       rounded to whole taka;
     - the client's computeTotals() and the server's are the same function, in
       both modes, and the fixed-amount mode is unchanged from before;
     - the server derives the money itself: a rate outside 0-100 or with more
       than two decimals is refused, a `discount` sent with a percentage is
       refused, a rate sent without `discountType: "percent"` is refused;
     - a client that predates percentages (it sends `discount` and nothing
       else) keeps working exactly as before;
     - the type and rate are stored (migrations 0003/0004), come back on a
       read, and an edit that only changes lines re-applies a stored rate;
     - existing rows read back as 'amount' with no rate; invoices copy the
       money discount as before.

   Runs the REAL Worker handlers against in-memory SQLite built from the real
   migrations (same wrapper as job-card-advance.test.mjs). Needs node:sqlite
   (Node 22.5+) for part 2; says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

/** The source of `function <name>(...) { ... }`, by brace matching. */
function fnSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${name} is unbalanced`);
}
function load(file) {
  const text = src(file);
  const ctx = {};
  vm.runInNewContext(`${fnSource(text, 'percentDiscount')}\n${fnSource(text, 'computeTotals')}\n
    this.percentDiscount = percentDiscount; this.computeTotals = computeTotals;`, ctx);
  return ctx;
}

console.log('=== Percentage discount ===');

/* ---------------------------------------------------------- */
console.log('\n-- 1. The arithmetic: client = server = exact reference --');
const client = load('js/job-cards.js');
const server = load('src/routes/job-cards.js');

// exact: rate% of subtotal, half-up to the paisa, capped at the subtotal (BigInt)
function reference(subtotalPaisa, rateBp) {
  const p = (BigInt(subtotalPaisa) * BigInt(rateBp) + 5000n) / 10000n;   // paisa, half-up
  return Number(p > BigInt(subtotalPaisa) ? BigInt(subtotalPaisa) : p) / 100;
}
let seed = 20261011;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
let bad = 0, cases = 0;
const samples = [[1600000, 700], [99900, 500], [99900, 1250], [1, 5000], [1, 4999], [10000000000, 10000], [12345, 3333], [0, 1000]];
for (let i = 0; i < 20000; i++) samples.push([rnd(i % 3 ? 10000000 : 1000000000), rnd(10001)]);
for (const [sp, bp] of samples) {
  const s = sp / 100, r = bp / 100, want = reference(sp, bp);
  const c = client.percentDiscount(s, r), sv = server.percentDiscount(s, r);
  cases++;
  if (c !== want || sv !== want) { if (bad++ < 3) console.log(`        ${s} x ${r}% -> client ${c}, server ${sv}, exact ${want}`); }
}
ok_(`percentDiscount matches the exact BigInt result on ${cases} cases (client and server)`, bad === 0, `${bad} mismatches`);
check('16,000 x 7% = 1,120', client.percentDiscount(16000, 7), 1120);
check('999 x 5% = 49.95', client.percentDiscount(999, 5), 49.95);
check('999 x 12.5% = 124.88 (124.875 rounds half up)', client.percentDiscount(999, 12.5), 124.88);
check('100% = the whole subtotal', client.percentDiscount(16000, 100), 16000);
check('0% = nothing', client.percentDiscount(16000, 0), 0);

const job = (o) => ({ services: [{ qty: 1, unitPrice: o.price }], partsUsed: [], labourCost: o.labour || 0, taxRate: o.tax || 0, paid: o.paid || 0, ...o.d });
const pick = (t) => [t.subtotal, t.discount, t.tax, t.total, t.due];
check('7% of 16,000, tax 0: total 14,880', pick(client.computeTotals(job({ price: 16000, d: { discountType: 'percent', discountRate: 7 } }))), [16000, 1120, 0, 14880, 14880]);
check('7% of 16,000, tax 5% after the discount: tax 744, total 15,624', pick(client.computeTotals(job({ price: 16000, tax: 5, d: { discountType: 'percent', discountRate: 7 } }))), [16000, 1120, 744, 15624, 15624]);
check('5% of 999: total exactly 949.05 (no float residue)', pick(client.computeTotals(job({ price: 999, d: { discountType: 'percent', discountRate: 5 } }))), [999, 49.95, 0, 949.05, 949.05]);
check('paid still reduces due the same way', pick(client.computeTotals(job({ price: 16000, paid: 5000, d: { discountType: 'percent', discountRate: 7 } }))), [16000, 1120, 0, 14880, 9880]);

// the fixed-amount mode is the formula it always was
const original = (j) => {
  const lineSum = (ls) => (ls || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const hours = Number(j.labourHours) || 0, rate = Number(j.labourRate) || 0;
  const labourCost = (hours > 0 && rate > 0) ? hours * rate : (Number(j.labourCost) || 0);
  const subtotal = lineSum(j.services) + lineSum(j.partsUsed) + labourCost;
  const discount = Math.min(Number(j.discount) || 0, subtotal);
  const taxRate = Number(j.taxRate) || 0;
  const tax = Math.round((subtotal - discount) * taxRate / 100);
  const total = subtotal - discount + tax;
  const paid = Number(j.paid) || 0;
  return [subtotal, discount, tax, total, Math.max(total - paid, 0)];
};
let fixedBad = 0, parityBad = 0;
for (let i = 0; i < 5000; i++) {
  const j = { services: [{ qty: 1 + rnd(3), unitPrice: rnd(500000) / 100 }], partsUsed: [{ qty: 1, unitPrice: rnd(90000) / 100 }],
              labourHours: rnd(2) ? rnd(10) : '', labourRate: rnd(2) ? rnd(800) : '', labourCost: rnd(5000),
              discount: rnd(3) ? rnd(200000) / 100 : 0, taxRate: rnd(4) * 2.5, paid: rnd(100000) / 100 };
  const fixed = [client.computeTotals(j), server.computeTotals(j), client.computeTotals({ ...j, discountType: 'amount' })];
  if (fixed.some((t) => JSON.stringify(pick(t)) !== JSON.stringify(original(j)))) fixedBad++;
  const pj = { ...j, discountType: 'percent', discountRate: rnd(10001) / 100 };
  if (JSON.stringify(client.computeTotals(pj)) !== JSON.stringify(server.computeTotals(pj))) parityBad++;
}
ok_('fixed-amount totals are unchanged from the original formula (5000 random cards, client and server)', fixedBad === 0, `${fixedBad} differ`);
ok_('percentage totals: client and server agree on every field (5000 random cards)', parityBad === 0, `${parityBad} differ`);

/* ---------------------------------------------------------- */
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('\nSKIPPED  part 2: node:sqlite is not available in this Node version.');
} else {
  const AT = '2026-10-08T00:00:00Z';
  const TEST_TOKEN = 'unit-test-token';
  const call = (path, env, method, body) =>
    worker.fetch(new Request('http://worker.local' + path, {
      method, headers: { authorization: `Bearer ${TEST_TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { API_TOKEN: TEST_TOKEN, ...env });

  function makeD1() {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql', '0004_job_card_discount_rate.sql']) {
      raw.exec(src(join('migrations', f)));
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
    return {
      raw,
      prepare: (sql) => new Stmt(sql),
      async batch(statements) {
        raw.exec('BEGIN');
        try { const out = statements.map((s) => s.exec()); raw.exec('COMMIT'); return out; }
        catch (e) { raw.exec('ROLLBACK'); throw e; }
      },
    };
  }
  function fresh() {
    const DB = makeD1();
    DB.raw.exec(`
      INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'A', '01700000001', '${AT}');
      INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'B', 'M', '${AT}');
      INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'M', '017', '${AT}');`);
    const env = { DB };
    const api = async (method, path, body) => {
      const res = await call(path, env, method, body);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const row = (id) => ({ ...DB.raw.prepare('SELECT discount, discount_type, discount_rate, tax_rate, subtotal, tax, total, paid, due FROM job_cards WHERE id = ?').get(id) });
    const count = () => DB.raw.prepare('SELECT count(*) AS n FROM job_cards').get().n;
    return { DB, api, row, count };
  }
  const base = (price, extra = {}) => ({
    customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-01', complaint: 'x',
    services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: price }], partsUsed: [], ...extra,
  });
  const money = (r) => [r.discount, r.discount_type, r.discount_rate, r.subtotal, r.tax, r.total, r.due];

  /* ---------------------------------------------------------- */
  console.log('\n-- 2. Create: the server derives and stores the percentage --');
  {
    const h = fresh();
    const r = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 7, taxRate: 0 }));
    check('7% of 16,000 -> 201', r.status, 201);
    check('stored: 1,120 percent 7, total 14,880, due 14,880', money(h.row(r.body.data.id)), [1120, 'percent', 7, 16000, 0, 14880, 14880]);
    check('the record reports the type and rate', [r.body.data.discount, r.body.data.discountType, r.body.data.discountRate, r.body.data.total], [1120, 'percent', 7, 14880]);
    const g = await h.api('GET', `/api/job-cards/${r.body.data.id}`);
    check('a reload returns the same type, rate and amount', [g.body.data.discountType, g.body.data.discountRate, g.body.data.discount, g.body.data.total], ['percent', 7, 1120, 14880]);

    const t = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 7, taxRate: 5 }));
    check('tax is taken after the discount: 744 on 14,880, total 15,624', money(h.row(t.body.data.id)), [1120, 'percent', 7, 16000, 744, 15624, 15624]);
    const z = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 0 }));
    check('0% -> no discount', money(h.row(z.body.data.id)), [0, 'percent', 0, 16000, 0, 16000, 16000]);
    const f = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 100 }));
    check('100% (the maximum) -> discount = subtotal, total 0', money(h.row(f.body.data.id)), [16000, 'percent', 100, 16000, 0, 0, 0]);
    const d = await h.api('POST', '/api/job-cards', base(999, { discountType: 'percent', discountRate: 12.5, taxRate: 5 }));
    check('12.5% of 999 = 124.88; tax 5% of 874.12 = 44; total 918.12', money(h.row(d.body.data.id)), [124.88, 'percent', 12.5, 999, 44, 918.12, 918.12]);
    const p = await h.api('POST', '/api/job-cards', base(999, { discountType: 'percent', discountRate: 5 }));
    check('5% of 999: total exactly 949.05', [h.row(p.body.data.id).discount, h.row(p.body.data.id).total], [49.95, 949.05]);
    const paid = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 7, paid: 4000 }));
    check('a typed Paid / Advance is kept as before; due = total - paid', [h.row(paid.body.data.id).paid, h.row(paid.body.data.id).due], [4000, 10880]);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 3. Refused, with nothing written --');
  {
    const h = fresh();
    const cases = [
      ['rate above 100', { discountType: 'percent', discountRate: 100.01 }, 'discountRate'],
      ['negative rate', { discountType: 'percent', discountRate: -1 }, 'discountRate'],
      ['non-numeric rate', { discountType: 'percent', discountRate: 'abc' }, 'discountRate'],
      ['three decimals', { discountType: 'percent', discountRate: 7.255 }, 'discountRate'],
      ['percent without a rate', { discountType: 'percent' }, 'discountRate'],
      ['a discount sent with a percentage', { discountType: 'percent', discountRate: 7, discount: 1120 }, 'discount'],
      ['a rate without discountType', { discountRate: 7 }, 'discountRate'],
      ['a rate with an amount discount', { discountType: 'amount', discountRate: 7, discount: 100 }, 'discountRate'],
      ['an unknown discountType', { discountType: 'both', discountRate: 7 }, 'discountType'],
    ];
    for (const [name, extra, field] of cases) {
      const r = await h.api('POST', '/api/job-cards', base(16000, extra));
      ok_(`${name} -> 422 naming ${field}`, r.status === 422 && r.body && r.body.error && JSON.stringify(r.body.error).includes(field), `${r.status} ${JSON.stringify(r.body)}`);
    }
    check('none of those created a job card', h.count(), 0);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 4. The fixed amount is unchanged --');
  {
    const h = fresh();
    const r = await h.api('POST', '/api/job-cards', base(16000, { discount: 1120, taxRate: 5 }));
    check('a request with only `discount` is a fixed amount, as before', money(h.row(r.body.data.id)), [1120, 'amount', null, 16000, 744, 15624, 15624]);
    check('its record says amount, no rate', [r.body.data.discountType, r.body.data.discountRate], ['amount', null]);
    const over = await h.api('POST', '/api/job-cards', base(1000, { discount: 1500 }));
    ok_('a fixed amount above the subtotal is still refused', over.status === 422 && JSON.stringify(over.body).includes('Discount cannot exceed the subtotal.'), JSON.stringify(over.body));
    const neg = await h.api('POST', '/api/job-cards', base(1000, { discount: -5 }));
    check('a negative fixed amount is still refused', neg.status, 422);
    const none = await h.api('POST', '/api/job-cards', base(1000, {}));
    check('no discount at all -> 0, amount', money(h.row(none.body.data.id)), [0, 'amount', null, 1000, 0, 1000, 1000]);

    // a row written before 0003/0004 (columns omitted) reads back as an amount
    h.DB.raw.exec(`INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, status, complaint, labour_cost, discount, tax_rate, subtotal, tax, total, paid, due, created_at)
                   VALUES ('JOB-0900', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-09-01', 'Received', 'old', 0, 300, 0, 3000, 0, 2700, 0, 2700, '${AT}')`);
    const old = await h.api('GET', '/api/job-cards/JOB-0900');
    check('an existing row reads back unchanged, as an amount discount', [old.body.data.discount, old.body.data.discountType, old.body.data.discountRate, old.body.data.total], [300, 'amount', null, 2700]);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 4b. Migrating a database that already has job cards (what Production does) --');
  {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_initial_schema.sql', '0002_invoice_adjustments.sql']) raw.exec(src(join('migrations', f)));
    raw.exec(`
      INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'A', '01700000001', '${AT}');
      INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'B', 'M', '${AT}');
      INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'M', '017', '${AT}');
      INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, status, complaint, labour_cost, discount, tax_rate, subtotal, tax, total, paid, due, created_at)
        VALUES ('JOB-0001', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-09-01', 'Completed', 'a', 0, 1500, 5, 10000, 425, 8925, 0, 8925, '${AT}'),
               ('JOB-0002', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-09-02', 'Received', 'b', 0, 0, 0, 2000, 0, 2000, 500, 1500, '${AT}');`);
    const snap = () => raw.prepare('SELECT id, status, discount, tax_rate, subtotal, tax, total, paid, due, created_at, updated_at FROM job_cards ORDER BY id').all().map((r) => ({ ...r }));
    const before = snap();
    for (const f of ['0003_job_card_discount_type.sql', '0004_job_card_discount_rate.sql']) raw.exec(src(join('migrations', f)));
    check('every existing column of every existing job card is unchanged', snap(), before);
    check('existing job cards get type amount and no rate', raw.prepare('SELECT discount_type, discount_rate FROM job_cards ORDER BY id').all().map((r) => [r.discount_type, r.discount_rate]), [['amount', null], ['amount', null]]);
    let threw = '';
    try { raw.exec(`UPDATE job_cards SET discount_rate = 101 WHERE id = 'JOB-0002'`); } catch (e) { threw = String(e.message); }
    ok_('the database itself refuses a rate above 100', /CHECK constraint failed/.test(threw), threw);
    threw = '';
    try { raw.exec(`UPDATE job_cards SET discount_type = 'both' WHERE id = 'JOB-0002'`); } catch (e) { threw = String(e.message); }
    ok_('the database itself refuses an unknown discount type', /CHECK constraint failed/.test(threw), threw);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 5. Edit --');
  {
    const h = fresh();
    const c = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 7 }));
    const id = c.body.data.id;
    let u = await h.api('PUT', `/api/job-cards/${id}`, { services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: 20000 }] });
    check('changing only the lines re-applies the stored 7%: 1,400 off 20,000', [u.status, ...money(h.row(id))], [200, 1400, 'percent', 7, 20000, 0, 18600, 18600]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { discountType: 'percent', discountRate: 10 });
    check('a new rate: 10% -> 2,000', money(h.row(id)), [2000, 'percent', 10, 20000, 0, 18000, 18000]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { discount: 500 });
    check('sending only `discount` (an older client) switches to that fixed amount and clears the rate', money(h.row(id)), [500, 'amount', null, 20000, 0, 19500, 19500]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { discountType: 'percent', discountRate: 2.5 });
    check('and back to a percentage: 2.5% -> 500', money(h.row(id)), [500, 'percent', 2.5, 20000, 0, 19500, 19500]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: 300 }] });
    check('lines cut below the old amount: the percentage follows (7.50), no false "exceeds subtotal"', [u.status, h.row(id).discount], [200, 7.5]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { discountType: 'percent', discountRate: 150 });
    check('an edit with a bad rate is refused and changes nothing', [u.status, h.row(id).discount_rate], [422, 2.5]);
    u = await h.api('PUT', `/api/job-cards/${id}`, { discountType: 'amount', discount: 100 });
    check('discountType amount + discount -> fixed 100', money(h.row(id)), [100, 'amount', null, 300, 0, 200, 200]);
  }

  /* ---------------------------------------------------------- */
  console.log('\n-- 6. Invoice and advance: the money discount carries over as before --');
  {
    const h = fresh();
    const c = await h.api('POST', '/api/job-cards', base(16000, { discountType: 'percent', discountRate: 7 }));
    const id = c.body.data.id;
    for (const s of ['Inspection', 'In Progress']) await h.api('POST', `/api/job-cards/${id}/status`, { status: s });
    const adv = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', jobCardId: id, amount: 4000, date: '2026-10-02', method: 'Cash' });
    check('an advance is recorded against the percentage-discounted card', adv.status, 201);
    await h.api('POST', `/api/job-cards/${id}/status`, { status: 'Completed' });
    const inv = await h.api('POST', '/api/invoices', { jobCardId: id });
    check('the invoice is created', inv.status, 201);
    const row = h.DB.raw.prepare('SELECT discount, subtotal, tax, total, paid, due, status FROM invoices WHERE job_card_id = ?').get(id);
    check('invoice: discount 1,120, total 14,880, advance 4,000 applied, due 10,880', [row.discount, row.subtotal, row.total, row.paid, row.due, row.status], [1120, 16000, 14880, 4000, 10880, 'Partial']);
  }
}

console.log(`\nPercentage discount: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
