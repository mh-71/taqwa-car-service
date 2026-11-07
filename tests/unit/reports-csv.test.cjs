/* reports-csv — Reports page: CSV export for all ten reports, and the
   workshop-day (Asia/Dhaka) date rule (audit L1).

   Drives the REAL js/reports.js with the real api.js, storage.js and
   utils.js through the shared harness, against the in-memory fake API.
   Every name and number is a fictional test value.

     1. dayOf / inRange: date-only values unchanged; timestamps by Dhaka day,
        across the 18:00 UTC midnight.
     2. Every report exports: BOM, its own headers, its rows for the range.
     3. The figures in the files match the reports' own rules.
     4. CSV safety: formula injection, quotes, commas, newlines, Bangla.
     5. Permission: no reports.export -> no button, no file.
     6. Nothing is written and nothing is fetched to build a file. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

const D = '2026-11-05';
const ROWS = {
  customers: [
    { id: 'CUS-0001', name: 'রহিম উদ্দিন', phone: '01711000001', createdAt: '2026-11-04T19:30:00.000Z' },   // 01:30 on 5 Nov in Dhaka
    { id: 'CUS-0002', name: '=HYPERLINK("http://evil")', phone: '01711000002', createdAt: '2026-10-01T05:00:00.000Z' },
  ],
  vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHA-1', brand: 'Toyota', model: 'Axio', status: 'Active' }],
  mechanics: [{ id: 'MEC-0001', name: 'Karim, "Senior"', phone: '017' }],
  parts: [{ id: 'PRT-0001', partNo: 'P-100', name: 'Oil filter', category: 'Filters', status: 'Active', stock: 10, minStock: 2, purchasePrice: 150, sellingPrice: 250 }],
  'job-cards': [{ id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: D, status: 'Completed', total: 1500,
    services: [{ serviceId: 'SRV-0001', name: 'Oil change', qty: 1, unitPrice: 1500, total: 1500 }], partsUsed: [] }],
  invoices: [{ id: 'INV-0001', jobCardId: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', date: D, total: 1500, paid: 1500, due: 0,
    writtenOff: 0, postDiscount: 0, refunded: 200, status: 'Paid', services: [], partsUsed: [] }],
  payments: [
    { id: 'PAY-0001', customerId: 'CUS-0001', invoiceId: 'INV-0001', jobCardId: null, date: D, amount: 1500, method: 'Cash', status: 'Active' },
    { id: 'PAY-0002', customerId: 'CUS-0002', invoiceId: null, jobCardId: null, date: '2026-10-01', amount: 999, method: 'Cash', status: 'Active' },
  ],
  'invoice-refunds': [{ id: 'RFD-0001', invoiceId: 'INV-0001', customerId: 'CUS-0001', amount: 200, method: 'Mobile Banking', date: D, status: 'Active' }],
  expenses: [{ id: 'EXP-0001', date: D, category: 'Utilities', description: 'বিদ্যুৎ বিল\nNovember', payee: '+Power Co', method: 'Cash', reference: '-R1', amount: 300, status: 'Active' }],
  'inventory-transactions': [
    { id: 'STK-0001', partId: 'PRT-0001', type: 'job-card-use', quantity: 2, createdAt: '2026-11-04T18:30:00.000Z' },   // 00:30 on 5 Nov in Dhaka
    { id: 'STK-0002', partId: 'PRT-0001', type: 'purchase', quantity: 5, createdAt: '2026-11-05T17:59:00.000Z' },       // 23:59 on 5 Nov in Dhaka
    { id: 'STK-0003', partId: 'PRT-0001', type: 'purchase', quantity: 9, createdAt: '2026-11-05T18:00:00.000Z' },       // 00:00 on 6 Nov: outside
  ],
};

function page({ api, can = null } = {}) {
  const h = boot({ origin: 'http://localhost:8787', fetch: api, modules: ['js/reports.js'] });
  return { h, el: id => h.ctx.document.getElementById(id), can };
}
const parse = (csv) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');
const RANGE = { from: D, to: D, label: 'test' };

(async () => {
console.log('=== reports-csv: Reports CSV export and Dhaka dates ===\n');
const api = fakeApi({ rows: JSON.parse(JSON.stringify(ROWS)) });
const { h, el } = page({ api });
h.fireReady();
await tick(150);
const R = h.ctx.ReportsCsv;

/* ---------- 1. dates ---------- */
console.log('-- 1. workshop (Dhaka) days --');
check('a date-only value is used as it is', R.dayOf('2026-11-05'), '2026-11-05');
check('17:59:59Z is still 5 Nov in Dhaka; 18:00:00Z is already 6 Nov',
  [R.dayOf('2026-11-05T17:59:59.000Z'), R.dayOf('2026-11-05T18:00:00.000Z')], ['2026-11-05', '2026-11-06']);
check('a record at 01:30 Dhaka time (19:30Z the day before) counts on its Dhaka day, not the UTC one',
  [R.dayOf('2026-11-04T19:30:00.000Z'), R.inRange('2026-11-04T19:30:00.000Z', RANGE)], ['2026-11-05', true]);
check('   ...and one at 00:00 the next Dhaka day is outside', R.inRange('2026-11-05T18:00:00.000Z', RANGE), false);
check('empty or unreadable values are never in range', [R.inRange('', RANGE), R.inRange(null, RANGE), R.inRange('soon', RANGE)], [false, false, false]);

/* ---------- 2. every report ---------- */
console.log('\n-- 2. all ten reports export --');
check('ten report types', R.TYPES, ['revenue', 'expense', 'net', 'payment', 'invoice', 'jobcard', 'inventory', 'customer', 'mechanic', 'service']);
const files = {};
for (const t of R.TYPES) files[t] = R.buildReportCsv(t, RANGE);
ok('every file starts with the UTF-8 byte-order mark (Excel reads Bangla)', R.TYPES.every(t => files[t].csv.charCodeAt(0) === 0xFEFF), '');
check('every file is named for its report and range', R.TYPES.map(t => files[t].name), R.TYPES.map(t => `taqwa-${t}-report_${D}_to_${D}.csv`));
check('clear headers for each report', R.TYPES.map(t => parse(files[t].csv)[0].split('","')[0].replace(/^"/, '')),
  ['Date', 'Date', 'Date', 'Payment #', 'Invoice #', 'Job Card #', 'Part #', 'Customer #', 'Mechanic', 'Service']);

/* ---------- 3. figures ---------- */
console.log('\n-- 3. the figures follow the reports\' rules --');
const rev = parse(files.revenue.csv);
check('Revenue: the payment and the refund in range (refund negative), then the total after refunds',
  rev.slice(1), [`"${D}","Payment","PAY-0001","রহিম উদ্দিন","INV-0001","Cash",1500`, `"${D}","Refund","RFD-0001","রহিম উদ্দিন","INV-0001","Mobile Banking",-200`, '"","Total","","","","",1300']);
ok('   ...the out-of-range payment is not in it', !files.revenue.csv.includes('PAY-0002'), '');
check('Net Result: collected, refunded, after refunds, expenses, net — per day and in total',
  parse(files.net.csv).slice(1), [`"${D}",1500,200,1300,300,1000`, '"Total",1500,200,1300,300,1000']);
check('Payment: one row, its customer and status', parse(files.payment.csv).slice(1), [`"PAY-0001","${D}","রহিম উদ্দিন","INV-0001","","Cash",1500,"Active"`]);
check('Invoice: total, discount, paid, refunded, written off, due, status', parse(files.invoice.csv)[1],
  `"INV-0001","${D}","রহিম উদ্দিন","JOB-0001",1500,0,1500,200,0,0,"Paid"`);
check('Job Card: customer, vehicle, mechanic, status, total', parse(files.jobcard.csv)[1], `"JOB-0001","${D}","রহিম উদ্দিন","DHA-1","Karim, ""Senior""","Completed",1500`);
check('Inventory: stock now, value, and movements in the Dhaka day (00:30 counted, next-day 00:00 not)', parse(files.inventory.csv)[1],
  '"P-100","Oil filter","Filters","Active",10,2,"Normal",150,250,1500,2,5,2');
check('Customer: the new customer (created 01:30 Dhaka on the day) is marked new', parse(files.customer.csv).slice(1), ['"CUS-0001","রহিম উদ্দিন","01711000001","Yes",1,1500']);
check('Mechanic: assigned, active, completed, billed, collected', parse(files.mechanic.csv).slice(1), ['"Karim, ""Senior""",1,0,1,1500,1500']);
check('Service: times performed and billed value', parse(files.service.csv).slice(1), ['"Oil change",1,1500']);
const exp = parse(files.expense.csv);
// header, one expense (its line break stays inside the quoted cell), the total
check('Expense: the row and the total', [exp.length, exp[exp.length - 1]], [3, '"","Total","","","","","",300']);

/* ---------- 4. safety ---------- */
console.log('\n-- 4. CSV safety --');
check('a text cell starting with = + - @ is made plain text with an apostrophe',
  ['=SUM(A1)', '+1', '-R1', '@x', '  =x', '\tA'].map(R.csvCell), ['"\'=SUM(A1)"', '"\'+1"', '"\'-R1"', '"\'@x"', '"\'  =x"', '"\'\tA"']);
check('   ...a real negative number stays a number', [R.csvCell(-200), R.csvCell(1500.505), R.csvCell(NaN)], ['-200', '1500.51', '']);
check('quotes are doubled; commas and line breaks stay inside the cell', R.csvCell('Karim, "Senior"\nline 2'), '"Karim, ""Senior""\nline 2"');
ok('the expense\'s payee "+Power Co" and reference "-R1" are neutralised in the file',
  files.expense.csv.includes('"\'+Power Co"') && files.expense.csv.includes('"\'-R1"'), files.expense.csv);
const all = R.buildReportCsv('customer', { from: '2026-01-01', to: '2026-12-31' }).csv;
ok('a customer named =HYPERLINK(...) is exported as text, not a formula', all.includes('"\'=HYPERLINK(""http://evil"")"'), all);
ok('Bangla is written as-is in UTF-8', files.revenue.csv.includes('রহিম উদ্দিন') && files.expense.csv.includes('বিদ্যুৎ বিল'), '');

/* ---------- 5. permission ---------- */
console.log('\n-- 5. reports.export --');
ok('with the permission (or full access) the Export CSV button shows', el('exportCsvBtn').hidden === false, String(el('exportCsvBtn').hidden));
{
  const p2 = page({ api: fakeApi({ rows: JSON.parse(JSON.stringify(ROWS)) }) });
  p2.h.ctx.Storage.can = (perm) => perm !== 'reports.export';
  p2.h.fireReady();
  await tick(150);
  check('without reports.export the button is hidden', p2.el('exportCsvBtn').hidden, true);
  // A click (e.g. from an old page) is refused too.
  const toasts = [];
  p2.h.ctx.Utils.toast = (m) => toasts.push(m);
  p2.el('exportCsvBtn').dispatch('click');
  check('   ...and a click makes no file, saying why', toasts, ['Your role does not include exporting reports.']);
}

/* ---------- 6. read-only ---------- */
console.log('\n-- 6. read-only, no request --');
{
  const before = api.calls.length;
  for (const t of R.TYPES) R.buildReportCsv(t, RANGE);
  check('building every file asks the server nothing (works offline from the copy)', api.calls.length - before, 0);
  ok('and writes nothing (no POST/PUT/DELETE at any point)', !api.calls.some(c => c.method && c.method !== 'GET'), JSON.stringify(api.calls.filter(c => c.method !== 'GET')));
  ok('the Print Report button is still wired', typeof el('printReportBtn').dispatch === 'function', '');
}

process.exit(summary('Reports CSV unit') === 0 ? 0 : 1);
})();
