/* d1-writes — the REAL business transactions, driven against a backend.

   The five multi-table operations (record a payment, link one, void one,
   invoice a job card, void an invoice) used to be orchestrated here, in the
   browser, as two or three separate writes. The server now does each of them
   in ONE transaction. This suite drives the real shipped functions in API
   mode and asserts what actually goes over the wire -- because the failure
   this guards against is silent: a frontend that ALSO performs the second
   half would double-apply it, and a frontend that still reached for a
   synchronous writer would throw.

   Function bodies are lifted out of js/ the same way finding7.test.cjs does
   it: no logic is copied, and a change to the shipped file is felt here. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

/* Lift the transaction functions into a sandbox sharing this context's
   Storage/Utils, exactly as the Finding 7 suite does. */
function transactions(ctx) {
  const inv = fs.readFileSync(`${ROOT}/js/invoices.js`, 'utf8');
  const pay = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j <= i) throw new Error(`slice failed: ${a}`); return s.slice(i, j); };
  const sb = { Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    fmtDate: ctx.Utils.fmtDate, badge: ctx.Utils.badge,
    METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    ELIGIBLE_JOB_STATUSES: ['Completed', 'Delivered'],
    Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise, console, api: {} };
  vm.createContext(sb);
  vm.runInContext(
    cut(inv, 'function deriveStatus', '/* ---------- summary cards') + '\n' +
    cut(pay, 'function deriveInvoiceStatus', '/* ---------- summary cards') + `
    api.createInvoiceFromJobCard = createInvoiceFromJobCard; api.voidInvoice = voidInvoice;
    api.linkedActivePayments = linkedActivePayments; api.recordPayment = recordPayment;
    api.voidPayment = voidPayment; api.linkPaymentToInvoice = linkPaymentToInvoice;
    api.recomputeInvoiceBalance = recomputeInvoiceBalance;
  `, sb);
  return sb.api;
}

const JOB = { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', status: 'Completed',
  services: [{ serviceId: 'SRV-0001', name: 'Oil', qty: 1, price: 800 }], partsUsed: [],
  labourCost: 0, discount: 0, taxRate: 5, subtotal: 800, tax: 40, total: 840, paid: 0, due: 840,
  invoiceId: null, completedAt: '2026-09-01T10:00:00Z', actualDelivery: '' };
const INV = { id: 'INV-0001', jobCardId: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001',
  date: '2026-09-01', total: 840, paid: 0, due: 840, status: 'Unpaid' };

/* A backend holding one customer, one completed job card and its invoice. */
async function live(extra = {}) {
  const f = fakeApi({ rows: {
    customers: [{ id: 'CUS-0001', name: 'Rahim' }],
    vehicles: [{ id: 'VEH-0001', regNo: 'DHK-1234', customerId: 'CUS-0001' }],
    'job-cards': [{ ...JOB }],
    invoices: [{ ...INV }],
    parts: [{ id: 'PRT-0001', name: 'Filter', stock: 10 }],
    ...extra,
  } });
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  return { ...h, f, a: transactions(h.ctx) };
}

const sent = (f, method, re) => f.calls.filter(c => c.method === method && re.test(c.path));

console.log('=== d1-writes: business transactions against a backend ===\n');

(async () => {

/* ============================================================
   1. Recording a payment
   ============================================================ */
console.log('-- 1. record a payment --');
{
  const { ctx, f, a } = await live();
  check('the app is talking to the backend', ctx.Storage.mode, 'api');
  const res = await a.recordPayment({ invoiceId: 'INV-0001', customerId: 'CUS-0001',
    jobCardId: 'JOB-0001', date: '2026-09-02', amount: 500, method: 'Cash', notes: '' });
  ok('the payment is recorded', res.ok, JSON.stringify(res));
  check('   ...by ONE POST to /payments', sent(f, 'POST', /^\/payments$/).length, 1);

  const body = sent(f, 'POST', /^\/payments$/)[0].body;
  check('   ...carrying the amount', body.amount, 500);
  ok('THE INVOICE BALANCE IS NOT SENT -- the server recomputes it',
    !('paid' in body) && !('due' in body), JSON.stringify(body));
  check('and NO write is made to the invoice', sent(f, 'PUT', /^\/invoices/).length, 0);
  check('   ...nor to the job card', sent(f, 'PUT', /^\/job-cards/).length, 0);
  ok('the invoice is RE-READ instead, so the balance shown is the server\'s',
    sent(f, 'GET', /^\/invoices/).length >= 2,
    JSON.stringify(f.calls.filter(c => /invoices/.test(c.path)).map(c => c.method)));
  check('the payment kept the id the server gave it', res.payment.id, 'PAY-0901');
}
{
  const { a, f } = await live();
  const res = await a.recordPayment({ invoiceId: null, customerId: 'CUS-0001',
    jobCardId: null, date: '2026-09-02', amount: 500, method: 'Cash', notes: '' });
  ok('an advance is recorded', res.ok, JSON.stringify(res));
  check('   ...and touches no invoice at all', f.calls.filter(c => /invoices/.test(c.path) && c.method !== 'GET').length, 0);
  check('   ...with invoiceId null on the wire', sent(f, 'POST', /^\/payments$/)[0].body.invoiceId, null);
}
{
  // The rule the server enforces in the INSERT's own WHERE.
  const f = fakeApi({ rows: { customers: [{ id: 'CUS-0001' }], vehicles: [{ id: 'VEH-0001' }],
    invoices: [{ ...INV }], 'job-cards': [{ ...JOB }] },
    fail: ({ method, path }) => method === 'POST' && path === '/payments'
      ? { status: 409, error: { code: 'conflict',
          message: 'That would overpay the invoice. Outstanding: 840.00.' } } : null });
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 't' });
  const a = transactions(h.ctx);
  const res = await a.recordPayment({ invoiceId: 'INV-0001', customerId: 'CUS-0001',
    jobCardId: 'JOB-0001', date: '2026-09-02', amount: 99999, method: 'Cash', notes: '' });
  ok('an overpayment the server refuses is reported, not worked around', res.ok === false, JSON.stringify(res));
  ok('   ...in the server\'s own words', /overpay/i.test(res.reason), res.reason);
  check('   ...and no payment is in the cache', h.ctx.Storage.getData('payments').length, 0);
  check('   ...and the invoice is untouched', h.ctx.Storage.getById('invoices', 'INV-0001').paid, 0);
}
{
  const { a } = await live();
  for (const [label, amount] of [['zero', 0], ['negative', -5], ['non-numeric', 'abc']]) {
    const res = await a.recordPayment({ invoiceId: 'INV-0001', customerId: 'CUS-0001',
      jobCardId: 'JOB-0001', date: '2026-09-02', amount, method: 'Cash', notes: '' });
    ok(`a ${label} amount is refused before any request`, res.ok === false, JSON.stringify(res));
  }
}

/* ============================================================
   2. Linking and voiding a payment
   ============================================================ */
console.log('\n-- 2. link / void --');
{
  const { a, f } = await live({ payments: [{ id: 'PAY-0001', invoiceId: null,
    customerId: 'CUS-0001', jobCardId: null, amount: 200, status: 'Active' }] });
  const res = await a.linkPaymentToInvoice('PAY-0001', 'INV-0001');
  ok('an advance can be linked', res.ok, JSON.stringify(res));
  check('   ...by the named action, not a field edit',
    sent(f, 'POST', /^\/payments\/PAY-0001\/link$/).length, 1);
  check('   ...and never by PUT', sent(f, 'PUT', /^\/payments/).length, 0);
  check('   ...and the invoice is not written either', sent(f, 'PUT', /^\/invoices/).length, 0);
}
{
  const { a, f } = await live({ payments: [{ id: 'PAY-0001', invoiceId: 'INV-0001',
    customerId: 'CUS-0001', amount: 200, status: 'Active' }] });
  const res = await a.voidPayment('PAY-0001');
  ok('a payment can be voided', res.ok, JSON.stringify(res));
  check('   ...by the named action', sent(f, 'POST', /^\/payments\/PAY-0001\/void$/).length, 1);
  check('   ...and never by PUT', sent(f, 'PUT', /^\/payments/).length, 0);
  ok('   ...and the invoice balance is re-read, not rewritten',
    sent(f, 'PUT', /^\/invoices/).length === 0 && sent(f, 'GET', /^\/invoices/).length >= 2, '');
}
{
  const { a, f } = await live({ payments: [{ id: 'PAY-0001', invoiceId: null,
    customerId: 'CUS-0001', amount: 200, status: 'Active' }] });
  await a.voidPayment('PAY-0001');
  check('voiding an ADVANCE re-reads no invoice, because none was involved',
    sent(f, 'GET', /^\/invoices/).length, 1);
}
{
  const { a, f } = await live({ payments: [{ id: 'PAY-0001', invoiceId: 'INV-0001',
    customerId: 'CUS-0001', amount: 200, status: 'Void' }] });
  const res = await a.voidPayment('PAY-0001');
  ok('an already-void payment is refused locally', res.ok === false, JSON.stringify(res));
  check('   ...without a request', sent(f, 'POST', /void/).length, 0);
}

/* ============================================================
   3. The balance is never computed here
   ============================================================ */
console.log('\n-- 3. recomputeInvoiceBalance is inert against a backend --');
{
  const { ctx, a, f } = await live();
  const before = f.calls.length;
  a.recomputeInvoiceBalance('INV-0001');
  check('it issues no request', f.calls.length, before);
  check('   ...and changes nothing', ctx.Storage.getById('invoices', 'INV-0001').paid, 0);
  ok('   ...rather than throwing, so a stray call is harmless', true, '');
}

/* ============================================================
   4. Invoicing a job card
   ============================================================ */
console.log('\n-- 4. create an invoice --');
{
  const f = fakeApi({ rows: { customers: [{ id: 'CUS-0001' }], vehicles: [{ id: 'VEH-0001' }],
    'job-cards': [{ ...JOB }], invoices: [] } });
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 't' });
  const a = transactions(h.ctx);
  const res = await a.createInvoiceFromJobCard('JOB-0001', { date: '2026-09-03', notes: 'hi' });
  ok('the invoice is created', res.ok, JSON.stringify(res));
  const body = sent(f, 'POST', /^\/invoices$/)[0].body;
  check('   ...by ONE POST', sent(f, 'POST', /^\/invoices$/).length, 1);
  check('   ...naming the job card it bills', body.jobCardId, 'JOB-0001');
  ok('EVERY FIGURE IS THE SERVER\'S: none is sent',
    !['total', 'subtotal', 'tax', 'paid', 'due', 'discount', 'taxRate', 'labourCost',
      'services', 'partsUsed', 'customerId', 'vehicleId', 'status'].some(k => k in body),
    JSON.stringify(body));
  check('   ...only the date and the note the user typed',
    Object.keys(body).sort(), ['date', 'jobCardId', 'notes']);
  check('and the job card is NOT written to', sent(f, 'PUT', /^\/job-cards/).length, 0);
  ok('   ...it is re-read, because the same transaction stamped its invoiceId',
    sent(f, 'GET', /^\/job-cards/).length >= 2, '');
}
{
  const { a, f } = await live();   // JOB-0001 already has INV-0001 in this fixture
  const withInvoice = { ...JOB, invoiceId: 'INV-0001' };
  f.db['job-cards'][0] = withInvoice;
  await live();
  const res = await a.createInvoiceFromJobCard('JOB-9999', {});
  ok('a job card that does not exist is refused before any request', res.ok === false,
    JSON.stringify(res));
}

/* ============================================================
   5. Voiding an invoice — audit Finding 7
   ============================================================ */
console.log('\n-- 5. void an invoice (Finding 7) --');
{
  const { a, f } = await live({ payments: [
    { id: 'PAY-0001', invoiceId: 'INV-0001', customerId: 'CUS-0001', amount: 200, status: 'Active' },
    { id: 'PAY-0002', invoiceId: 'INV-0001', customerId: 'CUS-0001', amount: 300, status: 'Void' },
  ] });
  const res = await a.voidInvoice('INV-0001');
  ok('the invoice is voided', res.ok, JSON.stringify(res));
  check('   ...by the named action', sent(f, 'POST', /^\/invoices\/INV-0001\/void$/).length, 1);
  check('   ...and never by PUT', sent(f, 'PUT', /^\/invoices/).length, 0);
  check('it reports the ACTIVE payment it released', res.released.map(p => p.id), ['PAY-0001']);
  ok('   ...not the void one, which stays where it is',
    !res.released.some(p => p.id === 'PAY-0002'), JSON.stringify(res.released));
  check('NO payment is written from here -- the release is server-side',
    sent(f, 'PUT', /^\/payments/).length, 0);
  check('   ...nor is the job card', sent(f, 'PUT', /^\/job-cards/).length, 0);
  ok('   ...both are re-read instead',
    sent(f, 'GET', /^\/payments/).length >= 2 && sent(f, 'GET', /^\/job-cards/).length >= 2, '');
}
{
  const { a, f } = await live();
  f.db.invoices[0].status = 'Void';
  await a.voidInvoice('INV-0001');   // cache still says Unpaid, so it goes out
  const { a: a2, f: f2 } = await live({ invoices: [{ ...INV, status: 'Void' }] });
  const res = await a2.voidInvoice('INV-0001');
  ok('an already-void invoice is refused locally', res.ok === false, JSON.stringify(res));
  check('   ...without a request', sent(f2, 'POST', /void/).length, 0);
}

/* ============================================================
   6. A stock movement
   ============================================================ */
console.log('\n-- 6. inventory movement --');
{
  const { ctx, f } = await live();
  const res = await ctx.Utils.Inventory.move({ partId: 'PRT-0001', type: 'purchase',
    quantity: 5, unitCost: 100, referenceType: 'manual', referenceId: null, notes: 'n' });
  ok('the movement is recorded', res.ok, JSON.stringify(res));
  const posts = sent(f, 'POST', /^\/inventory-transactions$/);
  check('   ...by ONE POST to the ledger', posts.length, 1);
  ok('THE STOCK SNAPSHOTS ARE NOT SENT -- the server computes them in SQL',
    !('prevStock' in posts[0].body) && !('newStock' in posts[0].body),
    JSON.stringify(posts[0].body));
  check('and parts.stock is NEVER written directly', sent(f, 'PUT', /^\/parts/).length, 0);
  ok('   ...the part is re-read instead', sent(f, 'GET', /^\/parts/).length >= 2, '');
}
{
  const { ctx, f } = await live();
  const res = await ctx.Utils.Inventory.move({ partId: 'PRT-0001', type: 'sale', quantity: 999 });
  ok('an obvious shortage is refused without a round trip', res.ok === false, JSON.stringify(res));
  check('   ...sending nothing', sent(f, 'POST', /inventory-transactions/).length, 0);
  ok('   ...and saying which part and how much', /Filter/.test(res.error), res.error);
}

process.exit(summary('D1 writes unit') === 0 ? 0 : 1);
})();
