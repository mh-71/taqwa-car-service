/* Write-off balance calculation (0002) — property tests against SQLite.

   recomputeInvoice() in src/routes/payments.js is the one statement that
   writes an invoice's paid / written_off / due / status. 0002 extended it
   with the write-off. The promise that change makes is narrow and testable:

     FOR AN INVOICE WITH NO ACTIVE WRITE-OFF, THE NEW STATEMENT PRODUCES
     EXACTLY WHAT THE OLD ONE DID -- same paid, same due, same status, the
     same rows touched -- and written_off stays 0.

   So this suite runs BOTH statements against the same randomly generated
   invoices in an in-memory SQLite database built from the real migrations
   (0001 + 0002), and compares the rows they leave behind:

     - the OLD statement is a literal copy of recomputeInvoice() from main
       at 3dc2b1a, before 0002;
     - the NEW statement is whatever recomputeInvoice() builds today,
       captured through a stub binding, so the test follows the code.

   A second property checks invoices WITH write-offs against the formula the
   design locked:

     paid        = MIN(total, MAX(0, active payments))
     written_off = MIN(total - paid, MAX(0, active write-offs))
     due         = MAX(total - paid - written_off, 0)
     status      = Paid if total > 0 and paid + written_off >= total,
                   Partial if paid > 0, else Unpaid
     and a Void invoice is never touched.

   Both use a seeded generator, so a failure prints a case that reproduces.

   Needs node:sqlite (Node 22.5+). Without it the suite says SKIPPED and
   checks nothing -- it never reports a pass it did not earn. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeInvoice } from '../../src/routes/payments.js';

let pass = 0, fail = 0;
// Per-case checks are grouped by property: each property is ONE assertion
// that holds only if it held in every case, and its first counterexample is
// printed. 3,000 cases do not become 20,000 lines of PASS.
const props = new Map();
const quietOk = (name, cond, detail = '') => {
  const key = name.replace(/^(case|wo) \d+: /, '$1: ');
  const p = props.get(key) ?? { n: 0, bad: 0, first: '' };
  p.n++;
  if (!cond) { p.bad++; if (!p.first) p.first = `${name} -- ${detail}`; }
  props.set(key, p);
};
const flush = () => {
  for (const [key, p] of props) {
    loud(`${key} (${p.n} cases)`, p.bad === 0, `${p.bad} failing; first: ${p.first}`);
  }
  props.clear();
};
const loud = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('SKIPPED  node:sqlite is not available in this Node version; no property was checked.');
  console.log('\nWrite-off calc (SKIPPED, no node:sqlite): 0 passed, 0 failed');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (f) => readFileSync(join(ROOT, 'migrations', f), 'utf8');

const CASES = 1500;          // the brief asks for at least 1,000
const EPS = 1e-6;

/* ------------------------------------------------------------
   The two statements
   ------------------------------------------------------------ */

// recomputeInvoice() at 3dc2b1a, verbatim but for VOID inlined. Do not edit:
// this is the behaviour 0002 promised to keep.
const OLD_SETTLED = `MIN(total, MAX(0, (SELECT COALESCE(SUM(amount), 0)
                        FROM payments
                       WHERE invoice_id = ?1 AND status <> 'Void')))`;
const OLD_SQL = `UPDATE invoices
        SET paid       = ${OLD_SETTLED},
            due        = MAX(total - ${OLD_SETTLED}, 0),
            status     = CASE WHEN total > 0 AND ${OLD_SETTLED} >= total THEN 'Paid'
                              WHEN ${OLD_SETTLED} > 0                    THEN 'Partial'
                              ELSE 'Unpaid' END,
            updated_at = ?2
      WHERE id = ?1
        AND status <> 'Void'
        AND 1 = 1`;

// Whatever the route builds today, captured rather than copied.
function captureNew() {
  let captured = null;
  const env = { DB: { prepare(sql) { return { bind(...binds) { captured = { sql, binds }; return captured; } }; } } };
  recomputeInvoice(env, { invoiceId: 'INV-P', at: 'AT', guard: '1 = 1' });
  return captured;
}
const NEW = captureNew();
loud('recomputeInvoice() builds one UPDATE against invoices', /^\s*UPDATE invoices/.test(NEW.sql), NEW.sql);
loud('   ...binds only the invoice id and the time', JSON.stringify(NEW.binds) === '["INV-P","AT"]', JSON.stringify(NEW.binds));
loud('   ...still refuses to touch a Void invoice', /status <> 'Void'/.test(NEW.sql), NEW.sql);
loud('   ...and names no job card', !/job_card/.test(NEW.sql), NEW.sql);

/* ------------------------------------------------------------
   Database
   ------------------------------------------------------------ */
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(migration('0001_initial_schema.sql'));
db.exec(migration('0002_invoice_adjustments.sql'));
db.exec(`INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-P', 'Prop', '01900000000', 't');
         INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at)
              VALUES ('VEH-P', 'CUS-P', 'PROP-1', 'B', 'M', 't');`);

const oldStmt = db.prepare(OLD_SQL);
const newStmt = db.prepare(NEW.sql);
const readRow = db.prepare('SELECT paid, due, status, written_off, updated_at, total FROM invoices WHERE id = ?');

/* ------------------------------------------------------------
   Seeded generator (mulberry32)
   ------------------------------------------------------------ */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x7A9A;
const rand = rng(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];

/** A money figure: mostly whole Taka, sometimes fractional, sometimes tiny. */
function money(max) {
  const r = rand();
  if (r < 0.70) return int(1, max);
  if (r < 0.85) return Math.round(rand() * max * 100) / 100 || 0.01;
  if (r < 0.95) return pick([0.01, 0.5, 1, 0.004, 0.006]);
  return int(1, 3) * max;      // larger than the invoice: legacy over-collection
}

/** One invoice with payments and (optionally) write-offs, inserted fresh. */
function makeCase({ activeWriteOffs }) {
  const r = rand();
  const total = r < 0.08 ? 0 : (r < 0.15 ? Math.round(rand() * 5000 * 100) / 100 : int(1, 50000));
  const status = pick(['Unpaid', 'Partial', 'Paid', 'Void', 'Unpaid', 'Partial']);
  const initPaid = total === 0 ? 0 : pick([0, total, Math.min(total, int(0, Math.max(1, Math.floor(total))))]);
  const initDue = Math.max(total - initPaid, 0);

  const payments = [];
  for (let k = int(0, 6); k > 0; k--) {
    payments.push({ amount: money(Math.max(1, Math.floor(total / 2) || 100)), status: rand() < 0.25 ? 'Void' : 'Active' });
  }
  const adjustments = [];
  // Void write-offs exist in BOTH properties: "no active write-off" must
  // include an invoice whose only write-offs were reversed.
  for (let k = int(0, 3); k > 0; k--) {
    adjustments.push({ amount: money(Math.max(1, Math.floor(total / 3) || 100)), status: 'Void' });
  }
  if (activeWriteOffs) {
    for (let k = int(1, 3); k > 0; k--) {
      adjustments.push({ amount: money(Math.max(1, Math.floor(total / 3) || 100)), status: 'Active' });
    }
  }

  db.exec('DELETE FROM invoice_adjustments; DELETE FROM payments; DELETE FROM invoices;');
  db.prepare(`INSERT INTO invoices (id, customer_id, vehicle_id, date, total, paid, due, status, created_at, updated_at)
              VALUES ('INV-P', 'CUS-P', 'VEH-P', '2026-10-01', ?, ?, ?, ?, 't', 'BEFORE')`)
    .run(total, initPaid, initDue, status);
  const insPay = db.prepare(`INSERT INTO payments (id, invoice_id, customer_id, date, amount, method, status, created_at)
                             VALUES (?, 'INV-P', 'CUS-P', '2026-10-01', ?, 'Cash', ?, 't')`);
  payments.forEach((p, i) => insPay.run(`PAY-${i}`, p.amount, p.status));
  const insAdj = db.prepare(`INSERT INTO invoice_adjustments
      (id, invoice_id, customer_id, type, amount, reason, date, due_before, due_after,
       status, void_reason, voided_at, created_at)
      VALUES (?, 'INV-P', 'CUS-P', 'write_off', ?, 'r', '2026-10-01', ?, 0, ?, ?, ?, 't')`);
  adjustments.forEach((a, i) => insAdj.run(
    `ADJ-${i}`, a.amount, a.amount, a.status,
    a.status === 'Void' ? 'reversed' : null, a.status === 'Void' ? 't' : null));

  return { total, status, initPaid, initDue, payments, adjustments };
}

const restore = (c) => db.prepare(
  `UPDATE invoices SET paid = ?, due = ?, status = ?, written_off = 0, updated_at = 'BEFORE' WHERE id = 'INV-P'`
).run(c.initPaid, c.initDue, c.status);

const close = (a, b) => Math.abs(a - b) < EPS;
const show = (c) => JSON.stringify(c);

/* ============================================================
   1. Zero active write-offs: new === old
   ============================================================ */
console.log('\n=== 1. No active write-off: the new statement equals the old one ===');
let compared = 0, voidCases = 0, overCollected = 0, withVoidAdj = 0;
for (let n = 0; n < CASES; n++) {
  const c = makeCase({ activeWriteOffs: false });
  const o = oldStmt.run('INV-P', 'NOW');
  const before = readRow.get('INV-P');
  restore(c);
  const nw = newStmt.run('INV-P', 'NOW');
  const after = readRow.get('INV-P');

  compared++;
  if (c.status === 'Void') voidCases++;
  if (c.adjustments.length) withVoidAdj++;
  if (c.payments.filter((p) => p.status === 'Active').reduce((s, p) => s + p.amount, 0) > c.total) overCollected++;

  quietOk(`case ${n}: same rows touched`, Number(o.changes) === Number(nw.changes), `${o.changes} vs ${nw.changes} ${show(c)}`);
  quietOk(`case ${n}: same paid`, before.paid === after.paid, `${before.paid} vs ${after.paid} ${show(c)}`);
  quietOk(`case ${n}: same due`, before.due === after.due, `${before.due} vs ${after.due} ${show(c)}`);
  quietOk(`case ${n}: same status`, before.status === after.status, `${before.status} vs ${after.status} ${show(c)}`);
  quietOk(`case ${n}: same updated_at`, before.updated_at === after.updated_at, `${before.updated_at} vs ${after.updated_at}`);
  quietOk(`case ${n}: written_off stays 0`, after.written_off === 0, `${after.written_off} ${show(c)}`);
}
flush();
loud(`${compared} random invoices compared (seed ${SEED})`, compared >= 1000, String(compared));
loud(`   ...including ${voidCases} Void invoices`, voidCases > 50, String(voidCases));
loud(`   ...${overCollected} with payments above the total (the clamp)`, overCollected > 50, String(overCollected));
loud(`   ...and ${withVoidAdj} carrying only reversed write-offs`, withVoidAdj > 200, String(withVoidAdj));

/* ============================================================
   2. With active write-offs: the locked formula
   ============================================================ */
console.log('\n=== 2. With write-offs: paid, written_off, due and status follow the formula ===');
function expected(c) {
  if (c.status === 'Void') return { frozen: true };
  const paySum = c.payments.filter((p) => p.status === 'Active').reduce((s, p) => s + p.amount, 0);
  const adjSum = c.adjustments.filter((a) => a.status === 'Active').reduce((s, a) => s + a.amount, 0);
  const paid = Math.min(c.total, Math.max(0, paySum));
  const writtenOff = Math.min(c.total - paid, Math.max(0, adjSum));
  const due = Math.max(c.total - paid - writtenOff, 0);
  const status = c.total > 0 && paid + writtenOff >= c.total ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
  return { paid, writtenOff, due, status };
}
let formula = 0, settled = 0, capped = 0;
for (let n = 0; n < CASES; n++) {
  const c = makeCase({ activeWriteOffs: true });
  const oldPaid = (() => { oldStmt.run('INV-P', 'NOW'); const p = readRow.get('INV-P').paid; restore(c); return p; })();
  newStmt.run('INV-P', 'NOW');
  const got = readRow.get('INV-P');
  const want = expected(c);
  formula++;

  if (want.frozen) {
    quietOk(`wo ${n}: a Void invoice is frozen`,
      got.paid === c.initPaid && got.due === c.initDue && got.status === 'Void'
        && got.written_off === 0 && got.updated_at === 'BEFORE', `${JSON.stringify(got)} ${show(c)}`);
    continue;
  }
  quietOk(`wo ${n}: paid`, close(got.paid, want.paid), `${got.paid} vs ${want.paid} ${show(c)}`);
  quietOk(`wo ${n}: a write-off never changes paid`, got.paid === oldPaid, `${got.paid} vs ${oldPaid}`);
  quietOk(`wo ${n}: written_off`, close(got.written_off, want.writtenOff), `${got.written_off} vs ${want.writtenOff} ${show(c)}`);
  quietOk(`wo ${n}: due`, close(got.due, want.due), `${got.due} vs ${want.due} ${show(c)}`);
  quietOk(`wo ${n}: status`, got.status === want.status, `${got.status} vs ${want.status} ${show(c)}`);
  quietOk(`wo ${n}: paid + written_off + due = total`,
    close(got.paid + got.written_off + got.due, got.total), JSON.stringify(got));
  quietOk(`wo ${n}: nothing negative`, got.paid >= 0 && got.written_off >= 0 && got.due >= 0, JSON.stringify(got));
  if (got.due < 0.005 && got.written_off > 0) settled++;
  const adjSum = c.adjustments.filter((a) => a.status === 'Active').reduce((s, a) => s + a.amount, 0);
  if (adjSum > c.total - got.paid + EPS) capped++;
}
flush();
loud(`${formula} random invoices with write-offs checked`, formula >= 1000, String(formula));
loud(`   ...${settled} of them settled by a write-off`, settled > 50, String(settled));
loud(`   ...${capped} where write-offs exceeded what cash left (the cap)`, capped > 50, String(capped));

/* ============================================================
   3. Hand-picked cases, named
   ============================================================ */
console.log('\n=== 3. Named cases ===');
function named(label, { total, payments = [], adjustments = [], status = 'Unpaid' }, want) {
  db.exec('DELETE FROM invoice_adjustments; DELETE FROM payments; DELETE FROM invoices;');
  db.prepare(`INSERT INTO invoices (id, customer_id, vehicle_id, date, total, paid, due, status, created_at)
              VALUES ('INV-P', 'CUS-P', 'VEH-P', '2026-10-01', ?, 0, ?, ?, 't')`).run(total, total, status);
  payments.forEach(([amount, st = 'Active'], i) => db.prepare(
    `INSERT INTO payments (id, invoice_id, customer_id, date, amount, method, status, created_at)
     VALUES (?, 'INV-P', 'CUS-P', 'd', ?, 'Cash', ?, 't')`).run(`PAY-${i}`, amount, st));
  adjustments.forEach(([amount, st = 'Active'], i) => db.prepare(
    `INSERT INTO invoice_adjustments (id, invoice_id, customer_id, amount, reason, date, due_before, due_after,
       status, void_reason, voided_at, created_at)
     VALUES (?, 'INV-P', 'CUS-P', ?, 'r', 'd', ?, 0, ?, ?, ?, 't')`)
    .run(`ADJ-${i}`, amount, amount, st, st === 'Void' ? 'x' : null, st === 'Void' ? 't' : null));
  newStmt.run('INV-P', 'NOW');
  const got = readRow.get('INV-P');
  const g = { paid: got.paid, writtenOff: got.written_off, due: got.due, status: got.status };
  loud(label, JSON.stringify(g) === JSON.stringify(want), `got ${JSON.stringify(g)}`);
}
named('the business case: 3,000 total, 2,000 paid, 1,000 written off -> Paid, due 0',
  { total: 3000, payments: [[2000]], adjustments: [[1000]] },
  { paid: 2000, writtenOff: 1000, due: 0, status: 'Paid' });
named('a partial write-off leaves the cash status: 3,000 / 2,000 paid / 500 off -> Partial, due 500',
  { total: 3000, payments: [[2000]], adjustments: [[500]] },
  { paid: 2000, writtenOff: 500, due: 500, status: 'Partial' });
named('a write-off alone never makes an invoice Partial: 3,000 / 0 paid / 500 off -> Unpaid',
  { total: 3000, adjustments: [[500]] },
  { paid: 0, writtenOff: 500, due: 2500, status: 'Unpaid' });
named('a full write-off with no cash -> Paid, paid 0',
  { total: 3000, adjustments: [[3000]] },
  { paid: 0, writtenOff: 3000, due: 0, status: 'Paid' });
named('a reversed write-off counts for nothing',
  { total: 3000, payments: [[2000]], adjustments: [[1000, 'Void']] },
  { paid: 2000, writtenOff: 0, due: 1000, status: 'Partial' });
named('several write-offs add up',
  { total: 3000, payments: [[1000]], adjustments: [[700], [800], [500]] },
  { paid: 1000, writtenOff: 2000, due: 0, status: 'Paid' });
named('write-offs are capped at what cash left unpaid',
  { total: 3000, payments: [[2500]], adjustments: [[1000]] },
  { paid: 2500, writtenOff: 500, due: 0, status: 'Paid' });
named('a voided payment does not count as cash',
  { total: 3000, payments: [[2000, 'Void'], [500]], adjustments: [[1000]] },
  { paid: 500, writtenOff: 1000, due: 1500, status: 'Partial' });
named('a zero-total invoice stays Unpaid, as before',
  { total: 0 },
  { paid: 0, writtenOff: 0, due: 0, status: 'Unpaid' });
named('a Void invoice is not touched, write-offs or not',
  { total: 3000, payments: [[2000]], adjustments: [[1000]], status: 'Void' },
  { paid: 0, writtenOff: 0, due: 3000, status: 'Void' });

console.log(`\nWrite-off calc (property, ${CASES}+${CASES} cases): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
