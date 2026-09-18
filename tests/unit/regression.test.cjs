/* Regression smoke: every page module must load and render against seeded data
   without throwing, and the Customers "With due" filter is driven for real. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

console.log('=== Regression smoke ===\n');

const MODULES = ['dashboard', 'customers', 'vehicles', 'appointments', 'job-cards',
                 'services', 'mechanics', 'inventory', 'invoices', 'payments',
                 'expenses', 'reports', 'settings'];

console.log('-- every page module loads + renders on seeded data --');
for (const m of MODULES) {
  try {
    const { ctx, fireReady } = boot({ modules: [`js/${m}.js`] });
    ctx.Storage.seedIfEmpty();
    fireReady();
    ok(`${m}.js loads and renders`, true);
  } catch (e) {
    ok(`${m}.js loads and renders`, false, `${e.name}: ${e.message}`);
  }
}

console.log('\n-- Customers "With due" filter, driven through the real change handler --');
{
  const { ctx, els, fireReady } = boot({ modules: ['js/customers.js'] });
  ctx.Storage.seedIfEmpty();
  fireReady();

  const sel = els.get('custFilter');
  const rows = () => [...els.get('custTableBody').innerHTML.matchAll(/<tr data-id="([^"]+)">/g)].map(m => m[1]);

  sel.value = 'with-due';
  sel.dispatch('change', { target: sel });
  const withDueBefore = rows();
  ok('CUS-0002 listed under "With due" before payment', withDueBefore.includes('CUS-0002'), withDueBefore.join(','));

  // settle Karim's invoice in full using the shipped payments logic
  const pay = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const sandbox = { Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money,
    METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    Date, Math, JSON, Number, String, Object, Array, api: {} };
  vm.createContext(sandbox);
  vm.runInContext(pay.slice(pay.indexOf('function deriveInvoiceStatus'),
    pay.indexOf('/* ---------- eligible invoices')) + 'api.recordPayment = recordPayment;', sandbox);
  const r = sandbox.api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002',
    jobCardId: null, date: ctx.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  ok('settlement recorded', r.ok, JSON.stringify(r));

  sel.dispatch('change', { target: sel });
  const withDueAfter = rows();
  ok('CUS-0002 drops out of "With due" once settled', !withDueAfter.includes('CUS-0002'), withDueAfter.join(','));
  ok('customers still carrying real debt remain listed',
     withDueAfter.includes('CUS-0003') && withDueAfter.includes('CUS-0004'), withDueAfter.join(','));

  // and the unfiltered list still shows everyone
  sel.value = 'all'; sel.dispatch('change', { target: sel });
  check('all customers still listed with filter cleared', rows().length, 5);
}

console.log('\n-- seed data is unchanged (no demo timestamps touched) --');
{
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const jobs = ctx.Storage.getData('jobCards');
  check('5 seeded job cards', jobs.length, 5);
  check('JOB-0002 snapshot intact after seeding', [jobs[1].paid, jobs[1].due], [3000, 1935]);
  const totals = ctx.Utils.sumJobsDue(jobs);
  check('seed total outstanding unchanged by the fix', totals, 7810);
}

process.exit(summary('Regression') === 0 ? 0 : 1);
