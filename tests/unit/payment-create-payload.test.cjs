/* payment-create-payload — the field a payment write must NOT send.

   The fourth production defect of this shape, after C-16 (`stock: 0`), C-17
   (`jobCardId: null`) and C-18 (subtotal/tax/total/due). recordPayment() sent
   `status: 'Active'`, and routes/payments.js refuses it by name through
   SERVER_OWNED:

     status: '`status` is set by the server. Use the void operation to cancel
              a payment.'

   A payment is born Active and leaves that state only through the void
   action, which carries its own rule and its own invoice recomputation.
   Letting a field assignment do it would put the same rule in two places --
   so the server refuses the field rather than ignoring it, and every
   "Record Payment" came back 422.

   Like C-18 and unlike C-16/C-17, the field is NOT dead weight: 'local' mode
   has no server to stamp it, so the offline branch must go on setting it. The
   two branches were already separate here (recordPayment has its own
   `if (Storage.isApi())`), so the fix is the removal of one line from the API
   branch -- and this suite asserts BOTH, because a fix that cleaned the wire
   by breaking the offline app would be the worse bug.

   These tests drive the REAL shipped js/payments.js. fake-api does not
   re-implement the Worker's refusals (its own header says so), which is why
   the assertion is "we never sent it" rather than "the server said no". */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

/* Lift the payment functions into a sandbox sharing this context's
   Storage/Utils, exactly as d1-writes.test.cjs and finding7.test.cjs do:
   no logic is copied, and a change to the shipped file is felt here. */
function payments(ctx) {
  const src = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const cut = (s, a, b) => {
    const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j <= i) throw new Error(`slice failed: ${a}`);
    return s.slice(i, j);
  };
  const sb = {
    Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    fmtDate: ctx.Utils.fmtDate, badge: ctx.Utils.badge,
    METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise, console, api: {},
  };
  vm.createContext(sb);
  vm.runInContext(
    cut(src, 'function deriveInvoiceStatus', '/* ---------- summary cards') + `
    api.recordPayment = recordPayment;
    api.voidPayment = voidPayment;
    api.recomputeInvoiceBalance = recomputeInvoiceBalance;
  `, sb);
  return sb.api;
}

/* An invoice matching the production report: Rasel, INV-0001, due 1733. */
const ROWS = {
  customers: [{ id: 'CUS-0001', name: 'Rasel', phone: '0160153567', status: 'Active' }],
  vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-METRO-GA-29-2345',
               brand: 'Toyota', model: 'Premio', status: 'Active' }],
  'job-cards': [{ id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001',
                  status: 'Completed', total: 1733, paid: 0, due: 1733, invoiceId: 'INV-0001' }],
  invoices: [{ id: 'INV-0001', jobCardId: 'JOB-0001', customerId: 'CUS-0001',
               vehicleId: 'VEH-0001', date: '2026-09-21', total: 1733, paid: 0, due: 1733,
               status: 'Unpaid' }],
  payments: [],
};

const PAYMENT = {
  invoiceId: 'INV-0001', customerId: 'CUS-0001', jobCardId: 'JOB-0001',
  date: '2026-09-21', amount: 500, method: 'Cash', notes: 'five hundred taka',
};

async function apiPage() {
  const f = fakeApi({ rows: JSON.parse(JSON.stringify(ROWS)) });
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  return { ...h, f, api: payments(h.ctx) };
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));

console.log('=== payments: the create payload wire contract ===\n');

(async () => {

/* ============================================================
   1. THE REGRESSION: no `status` key may leave the browser
   ============================================================ */
console.log('-- 1. the create payload --');
{
  const h = await apiPage();
  check('the app is talking to the backend', h.ctx.Storage.mode, 'api');

  const res = await h.api.recordPayment(PAYMENT);
  ok('the payment is recorded', res.ok, JSON.stringify(res));

  const posts = sent(h.f, 'POST', /^\/payments$/);
  check('exactly one POST /payments', posts.length, 1);
  const body = posts[0].body;

  ok('THE BODY CARRIES NO `status` KEY -- the server owns it',
    !('status' in body), JSON.stringify(body));

  check('   ...invoiceId is sent', body.invoiceId, 'INV-0001');
  check('   ...customerId is sent', body.customerId, 'CUS-0001');
  check('   ...jobCardId is sent', body.jobCardId, 'JOB-0001');
  check('   ...date is sent', body.date, '2026-09-21');
  check('   ...amount is a number', body.amount, 500);
  check('   ...method is sent', body.method, 'Cash');
  check('   ...notes are sent', body.notes, 'five hundred taka');
  ok('   ...and no invoice balance is sent: the server recomputes it',
    !('paid' in body) && !('due' in body), JSON.stringify(body));
}

/* ============================================================
   2. An advance (no invoice) is clean too
   ============================================================ */
console.log('\n-- 2. an advance payment --');
{
  const h = await apiPage();
  const res = await h.api.recordPayment({
    invoiceId: null, customerId: 'CUS-0001', jobCardId: null,
    date: '2026-09-21', amount: 500, method: 'Cash', notes: 'advance',
  });
  ok('the advance is recorded', res.ok, JSON.stringify(res));
  const body = sent(h.f, 'POST', /^\/payments$/)[0].body;
  ok('   ...and carries no `status` either', !('status' in body), JSON.stringify(body));
  check('   ...with a null invoiceId', body.invoiceId, null);
}

/* ============================================================
   3. Voiding still goes through the ACTION, never a status write
   ============================================================ */
console.log('\n-- 3. voiding is an action, not a field --');
{
  const h = await apiPage();
  await h.api.recordPayment(PAYMENT);
  const id = h.ctx.Storage.getData('payments')[0].id;
  const res = await h.api.voidPayment(id);
  ok('the payment is voided', res.ok, JSON.stringify(res));

  check('   ...through POST /payments/:id/void',
    sent(h.f, 'POST', /^\/payments\/[^/]+\/void$/).length, 1);
  const puts = sent(h.f, 'PUT', /^\/payments/);
  check('   ...and NOT through a PUT', puts.length, 0);
}

/* ============================================================
   4. LOCAL MODE MUST STILL STAMP Active -- no server to do it
   ============================================================ */
console.log('\n-- 4. local mode still sets the status itself --');
{
  const h = boot({});                                   // no fetch -> local
  h.ctx.Storage.seedIfEmpty();
  check('the app is in local mode', h.ctx.Storage.mode, 'local');
  const api = payments(h.ctx);

  const before = h.ctx.Storage.getData('payments').map((p) => p.id);
  const res = await api.recordPayment({
    invoiceId: null, customerId: 'CUS-0001', jobCardId: null,
    date: '2026-09-21', amount: 500, method: 'Cash', notes: 'offline',
  });
  ok('the payment is recorded offline', res.ok, JSON.stringify(res));
  const rec = h.ctx.Storage.getData('payments').find((p) => !before.includes(p.id));
  ok('   ...and stored', !!rec, 'none created');
  if (rec) {
    check('   ...with status Active, set by the client because nothing else can',
      rec.status, 'Active');
    check('   ...and the amount intact', rec.amount, 500);
  }
}

summary('Payment create payload');
})();
