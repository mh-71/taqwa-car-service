/* estimates-demo-ui — Estimates & Quotations: a DEMO-ONLY sidebar link and
   three preview pages (Overview, New Estimate, Estimate Details).

   What must hold:
     1. The sidebar has an "Estimates & Quotations" link right after Job Cards
        and before Services; every other link keeps its order.
     2. On the three Estimates pages that link is the only active one and the
        header reads "Estimates & Quotations"; on any other page it is not
        active.
     3. Every Estimates page shares the Settings <head> (title and the
        estimates stylesheet aside), declares data-page="estimates" and its
        own view, shows "DEMO ONLY — No real data is loaded or saved.", loads
        exactly the shared shell scripts plus js/estimates-demo.js, and has no
        form, file or password input, inline handler or inline script. Every
        button is type="button".
     4. js/estimates-demo.js never touches the API, the database, browser
        storage, cookies, IndexedDB or the network, never writes HTML, and
        every action other than Print only explains it is a preview. Print
        opens the browser's own print dialog and nothing else.
     5. The demo data is unmistakably fictional, and the totals follow the
        Job Card rules exactly: the demo calc() gives the same numbers as the
        REAL computeTotals() in js/job-cards.js.
     6. css/estimates.css reaches the Estimates pages only.

   Drives the REAL js/app.js through the shared harness; js/estimates-demo.js
   is loaded on its own with no document, which runs none of its rendering. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGES = [
  ['estimates', 'overview', 'Estimates &amp; Quotations'],
  ['estimate-create', 'create', 'New Estimate'],
  ['estimate-details', 'details', 'Estimate Details'],
];

/** Render the shell for one page; return the HTML the shell wrote. */
function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: () => null, setItem() {} };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
// Top-level links only: group entries are nav__sub.
const topLinks = html => [...html.matchAll(/<a class="nav__link( is-active)?" href="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)]
  .map(m => ({ active: !!m[1], href: m[2], label: m[3] }));

console.log('=== estimates-demo-ui: Estimates & Quotations demo pages ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  check('the top-level links, in order (Estimates & Quotations right after Job Cards)', topLinks(html).map(l => l.label),
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Estimates & Quotations', 'Services', 'Mechanics',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Reports', 'Settings']);
  const est = topLinks(html).find(l => l.label === 'Estimates & Quotations');
  ok('   ...linking to the Overview page, which exists', est && est.href === 'pages/estimates.html' && fs.existsSync(path.join(ROOT, 'pages/estimates.html')), JSON.stringify(est));
  ok('   ...with an icon, like every other link',
    /<a class="nav__link" href="pages\/estimates\.html"><svg[^>]*><path d="M[^"]+"\/><\/svg><span>Estimates & Quotations<\/span><\/a>/.test(html), '');
  ok('   ...not active on another page', est && !est.active, '');
  ok('the Staff Management, Social Inbox and Customer CRM groups are still there',
    /id="navStaff"/.test(html) && /id="navInbox"/.test(html) && /id="navCrm"/.test(html), '');
}

/* ---------- 2. active state and header ---------- */
console.log('\n-- 2. active state --');
{
  const html = shellFor('estimates', '../');
  const active = topLinks(html).filter(l => l.active);
  check('on an Estimates page: only the Estimates link is active', active.map(l => l.href), ['../pages/estimates.html']);
  ok('   ...nothing in a sidebar group is active', !/nav__sub is-active|has-active/.test(html), '');
  ok('   ...and the header title reads "Estimates & Quotations"', html.includes('<h1>Estimates & Quotations</h1>'), '');
}
for (const page of ['job-cards', 'services', 'invoices', 'staff-list']) {
  const html = shellFor(page, '../');
  ok(`on ${page}: the Estimates link is not active`, topLinks(html).some(l => l.label === 'Estimates & Quotations' && !l.active), '');
}
ok('on Job Cards: the Job Cards link is still the active one',
  topLinks(shellFor('job-cards', '../')).filter(l => l.active).map(l => l.label).join() === 'Job Cards', '');

/* ---------- 3. the pages ---------- */
console.log('\n-- 3. the pages --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
const SCRIPTS = ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/estimates-demo.js'];
const bodies = {};
for (const [file, view, title] of PAGES) {
  const html = read(`pages/${file}.html`);
  const body = html.slice(html.indexOf('<body data-page='));
  bodies[view] = body;
  check(`${file}: <head> is the Settings head with only the title and the estimates stylesheet changed`, head(html),
    settingsHead.replace('<title>Settings — ', `<title>${title} — `)
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/estimates.css">'));
  ok('   ...declares the estimates page key', body.startsWith('<body data-page="estimates" data-root="../">'), body.slice(0, 60));
  ok(`   ...and the "${view}" view`, body.includes(`<div id="page-content" data-est-view="${view}">`), '');
  ok('   ...shows the demo-only notice',
    /<div class="est-demo" role="note">/.test(body) && body.includes('<strong>DEMO ONLY &#8212; No real data is loaded or saved.</strong>'), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus js/estimates-demo.js, last', scripts, SCRIPTS);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...has no form, file input or password input', !/<form\b|type="file"|type="password"/i.test(body), '');
  ok('   ...has no inline handler and no inline script in the body', !/\son[a-z]+=/i.test(html) && !/<script>/.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  ok('   ...every button is type="button"', buttons.every(b => /\stype="button"/.test(b)), JSON.stringify(buttons.filter(b => !/type="button"/.test(b))));
  const hrefs = [...body.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map(m => m[1]);
  ok('   ...links only to the Estimates pages', hrefs.every(h => /^estimate(s|-create)\.html$/.test(h)), JSON.stringify(hrefs));
  if (view !== 'overview') {
    ok('   ...has a breadcrumb back to the Overview', /<nav class="est-crumbs" aria-label="Breadcrumb">/.test(body)
      && body.includes('<li><a href="estimates.html">Estimates &amp; Quotations</a></li>'), '');
  }
}
{
  const o = bodies.overview;
  ok('Overview: six summary cards, search, status and date filters, table, pager, empty state',
    ['estTotal', 'estPending', 'estApproved', 'estRejected', 'estExpired', 'estPendingValue', 'estSearch', 'estStatus', 'estFrom', 'estTo',
      'estClear', 'estBody', 'estPrev', 'estNext', 'estRange', 'estEmpty'].every(id => o.includes(`id="${id}"`)), '');
  check('   ...the table columns', [...o.matchAll(/<th(?: class="num")?>([^<]+)<\/th>/g)].map(m => m[1]),
    ['Estimate No.', 'Date', 'Customer', 'Vehicle', 'Parts', 'Labour', 'Total', 'Valid Until', 'Status']);
  check('   ...every status can be filtered', [...o.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]),
    ['all', 'Pending', 'Approved', 'Rejected', 'Expired']);
  ok('   ...New Estimate opens the Create page', /<a class="btn btn--primary" href="estimate-create\.html">[\s\S]*?<span>New Estimate<\/span><\/a>/.test(o), '');
  const c = bodies.create;
  ok('Create: customer, vehicle, description, parts, labour, discount and VAT, and the totals preview',
    ['estCustomer', 'estVehicle', 'estDate', 'estValid', 'estDescription', 'estPartRows', 'estLabourRows', 'estAddPart', 'estAddLabour',
      'estDiscType', 'estDiscValue', 'estVat', 'estPvParts', 'estPvLabour', 'estPvSubtotal', 'estPvDiscount', 'estPvVat', 'estPvTotal']
      .every(id => c.includes(`id="${id}"`)), '');
  check('   ...the save and send buttons only explain they are a preview', [...c.matchAll(/<button type="button" class="btn [^"]+" data-preview="([^"]+)">/g)].map(m => m[1]),
    ['Save &amp; Approve', 'Send to Customer', 'Save Draft']);
  ok('   ...Cancel goes back to the Overview', c.includes('<a class="btn btn--ghost" href="estimates.html">Cancel</a>'), '');
  const d = bodies.details;
  ok('Details: header, quotation sheet, cost breakdown and a not-found state',
    ['estDetailId', 'estDetailStatus', 'estDetailValidity', 'estDetailActions', 'estPrint', 'estShNo', 'estShDate', 'estShValid', 'estShStatus',
      'estShCustomer', 'estShVehicle', 'estShDesc', 'estShParts', 'estShLabour', 'estShSummary', 'estShTerms', 'estBreakdown', 'estNotFound']
      .every(id => d.includes(`id="${id}"`)), '');
  ok('   ...the sheet says it is a demo and not a tax invoice', /<span class="est-sheet__mark" aria-hidden="true">DEMO<\/span>/.test(d)
    && d.includes('<footer class="est-sheet__foot">DEMO ONLY &#8212; not a real quotation. This is an estimate, not a tax invoice.</footer>'), '');
  ok('   ...Print is a plain button, not a preview action', /<button type="button" class="btn btn--ghost btn--sm" id="estPrint">/.test(d), '');
}

/* ---------- 4. the page script ---------- */
console.log('\n-- 4. js/estimates-demo.js --');
const src = read('js/estimates-demo.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
check('it never reaches the API, the database, browser storage, cookies, IndexedDB or the network',
  ['fetch(', 'XMLHttpRequest', 'Api.', 'Storage.', 'localStorage', 'sessionStorage', 'cookie', 'indexedDB', 'caches', 'sendBeacon',
    'WebSocket', 'EventSource', 'FileReader', 'import(', 'window.open', '.submit(', 'navigator.'].filter(t => code.includes(t)), []);
check('it never writes HTML', ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'].filter(t => code.includes(t)), []);
check('the only shared helper it uses is Utils.toast (Utils.money reads Settings through Storage)',
  [...new Set(code.match(/\b(?:Utils|App|SeedData)\.[A-Za-z]+/g) || [])], ['Utils.toast']);
check('window.print() is called once, from the Print button', (code.match(/window\.print\(/g) || []).length, 1);
ok('   ...and only by the Print button\'s click handler', /\$\('estPrint'\)\.addEventListener\('click', \(\) => window\.print\(\)\);/.test(code), '');
const buttonsMade = code.match(/h\('button', \{[^}]*\}/g) || [];
ok('every button it creates is type="button"', buttonsMade.length >= 3 && buttonsMade.every(b => /type: 'button'/.test(b)), JSON.stringify(buttonsMade));
ok('every preview action only explains it is a preview, and nothing else happens',
  /function explainPreview\(ev\) \{\s*const btn = ev\.target\.closest\('\[data-preview\]'\);\s*if \(!btn\) return;\s*ev\.preventDefault\(\);\s*Utils\.toast\(`Preview only — not available yet: "\$\{btn\.getAttribute\('data-preview'\)\}"\. Nothing was saved or sent\.`, 'info'\);\s*\}/.test(code), '');
ok('   ...including every action on the Details page and the More button in the table',
  /'data-preview': a, text: a/.test(code) && /'data-preview': `More actions for \$\{e\.id\}`/.test(code), '');
ok('it renders only on the Estimates pages', /if \(document\.body\.dataset\.page !== 'estimates'\) return;/.test(code), '');

/* ---------- 5. demo data and the totals ---------- */
console.log('\n-- 5. demo data and totals --');
const sb = { console, Math, JSON, Object, Array, String, Number, Set, Map, Date, URLSearchParams };
vm.createContext(sb);
vm.runInContext(`${src}\nglobalThis.EstimatesDemo = EstimatesDemo;`, sb, { filename: 'js/estimates-demo.js' });
const E = sb.EstimatesDemo;
check('six demo customers, eight demo vehicles, fourteen demo estimates', [E.CUSTOMERS.length, E.VEHICLES.length, E.ESTIMATES.length], [6, 8, 14]);
ok('   ...every customer is "Demo Customer <letter>"', E.CUSTOMERS.every(c => /^Demo Customer [A-F]$/.test(c.name)), '');
ok('   ...every email address is on example.com', E.CUSTOMERS.every(c => /^demo\.customer\.[a-f]@example\.com$/.test(c.email)), '');
ok('   ...every phone number is masked', E.CUSTOMERS.every(c => /^01XXX-XXX\d{3}$/.test(c.phone)), '');
ok('   ...every vehicle is a "Demo" model with a DEMO- registration', E.VEHICLES.every(v => /^Demo [A-Za-z]+$/.test(v.model) && /^DEMO-\d{4}$/.test(v.reg)), '');
ok('   ...every estimate is EST-DEMO-nnn and belongs to a demo customer and their own vehicle',
  E.ESTIMATES.every(e => /^EST-DEMO-\d{3}$/.test(e.id) && E.VEHICLES.some(v => v.id === e.vehicleId && v.customerId === e.customerId)), '');
ok('   ...no field anywhere holds an address, a password or a token', !/\b(address|password|token|secret)\s*:/i.test(code), '');
check('the validity date is the estimate date plus the validity period', [E.addDays('2026-09-02', 15), E.addDays('2026-12-25', 15), E.daysBetween('2026-10-20', '2026-11-04')],
  ['2026-09-17', '2027-01-09', 15]);

const count = s => E.ESTIMATES.filter(e => E.effectiveStatus(e) === s).length;
check('the Overview counts: pending, approved, rejected, expired', ['Pending', 'Approved', 'Rejected', 'Expired'].map(count), [5, 5, 2, 2]);
check('   ...a Pending estimate past its validity date reads as Expired; nothing else changes',
  E.ESTIMATES.filter(e => E.effectiveStatus(e) === 'Expired').map(e => [e.id, e.status]), [['EST-DEMO-003', 'Pending'], ['EST-DEMO-005', 'Pending']]);
check('   ...the validity date itself is still valid', E.effectiveStatus({ status: 'Pending', validUntil: E.DEMO_TODAY }), 'Pending');
check('   ...the pending value', Math.round(E.ESTIMATES.filter(e => E.effectiveStatus(e) === 'Pending').reduce((s, e) => s + E.calc(e).total, 0) * 100) / 100, 29205.25);

const t1 = E.calc(E.ESTIMATES[0]);
check('EST-DEMO-001: parts, labour, subtotal, discount, VAT, total',
  [t1.partsTotal, t1.labourTotal, t1.subtotal, t1.discount, t1.vat, t1.total], [12200, 1200, 13400, 500, 645, 13545]);
check('a percentage discount is rounded half-up to the paisa: 999 x 5% = 49.95',
  [E.calc({ parts: [{ qty: 1, unitPrice: 999 }], discountType: 'percent', discountValue: 5 }).discount,
    E.calc({ parts: [{ qty: 1, unitPrice: 999 }], discountType: 'percent', discountValue: 5 }).total], [49.95, 949.05]);
check('VAT is taken after the discount and rounded to whole taka', E.calc({ labour: [{ hours: 1, rate: 931 }], vatRate: 5 }).vat, 47);
check('an amount discount is capped at the subtotal; a negative one counts as none',
  [E.calc({ parts: [{ qty: 1, unitPrice: 300 }], discountValue: 500, vatRate: 5 }).total, E.calc({ parts: [{ qty: 1, unitPrice: 300 }], discountValue: -50 }).total], [0, 300]);
check('blank or invalid line values count as zero', E.calc({ parts: [{ qty: '', unitPrice: 'x' }], labour: [{ hours: '2', rate: '800' }], vatRate: '' }).total, 1600);

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
const jc = {};
{
  const text = read('js/job-cards.js');
  vm.runInNewContext(`${fnSource(text, 'percentDiscount')}\n${fnSource(text, 'computeTotals')}\nthis.computeTotals = computeTotals;`, jc);
}
// mulberry32: a seeded generator whose low bits are not periodic, so the cases are independent.
let seed = 20261020;
const rnd = n => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const cases = E.ESTIMATES.map(e => ({ ...e }));
for (let i = 0; i < 5000; i++) {
  const percent = rnd(2) === 1;
  cases.push({
    parts: Array.from({ length: rnd(4) }, () => ({ qty: rnd(5) + 1, unitPrice: rnd(2000000) / 100 })),
    labour: Array.from({ length: rnd(4) }, () => ({ hours: rnd(17) / 4, rate: rnd(200000) / 100 })),
    discountType: percent ? 'percent' : 'amount', discountValue: percent ? rnd(10001) / 100 : rnd(5000000) / 100, vatRate: rnd(4) * 2.5,
  });
}
const bad = cases.filter(c => {
  const d = E.calc(c);
  const j = jc.computeTotals({ services: c.labour.map(l => ({ qty: l.hours, unitPrice: l.rate })), partsUsed: c.parts,
    discountType: c.discountType, discount: c.discountValue, discountRate: c.discountValue, taxRate: c.vatRate });
  return JSON.stringify([d.subtotal, d.discount, d.vat, d.total]) !== JSON.stringify([j.subtotal, j.discount, j.tax, j.total]);
});
check(`the demo calc() equals the REAL Job Card computeTotals() on ${cases.length} cases (both discount modes)`, bad.slice(0, 2), []);

check('filter: search is case-insensitive over estimate no., customer, vehicle and work',
  [E.filterEstimates(E.ESTIMATES, { q: 'est-demo-007' }).length, E.filterEstimates(E.ESTIMATES, { q: 'DEMO CUSTOMER A' }).length,
    E.filterEstimates(E.ESTIMATES, { q: 'demo-1003' }).length, E.filterEstimates(E.ESTIMATES, { q: 'CLUTCH' }).length,
    E.filterEstimates(E.ESTIMATES, { q: 'nobody' }).length], [1, 3, 3, 1, 0]);
check('filter: by the status shown', E.filterEstimates(E.ESTIMATES, { status: 'Expired' }).map(e => e.id), ['EST-DEMO-003', 'EST-DEMO-005']);
check('filter: the date range is inclusive at both ends', E.filterEstimates(E.ESTIMATES, { from: '2026-10-01', to: '2026-10-10' }).map(e => e.id),
  ['EST-DEMO-006', 'EST-DEMO-007', 'EST-DEMO-008', 'EST-DEMO-009']);
check('filter: filters combine', E.filterEstimates(E.ESTIMATES, { q: 'demo customer b', status: 'Pending' }).map(e => e.id), ['EST-DEMO-008', 'EST-DEMO-014']);
check('paging: 14 rows by 8', [E.paginate(E.ESTIMATES, 1, 8), E.paginate(E.ESTIMATES, 2, 8)].map(p => [p.rows.length, p.from, p.to, p.pages]), [[8, 1, 8, 2], [6, 9, 14, 2]]);
check('paging: out-of-range pages are clamped, an empty list is one empty page',
  [E.paginate(E.ESTIMATES, 9, 8).page, E.paginate(E.ESTIMATES, 0, 8).page, E.paginate([], 1, 8).from, E.paginate([], 1, 8).pages], [2, 1, 0, 1]);
check('money reads in taka with Indian grouping, paisa only when there are any', [E.money(13545), E.money(949.05), E.money(1234567)],
  ['৳ 13,545', '৳ 949.05', '৳ 12,34,567']);
check('dates read as day, month, year', E.fmtDay('2026-09-02'), '02 Sep 2026');

/* ---------- 6. the stylesheet ---------- */
console.log('\n-- 6. css/estimates.css --');
const css = read('css/estimates.css').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean)
  // Split selector lists on top-level commas only: :is(a, b) is one selector.
  .flatMap(r => r.split('{')[0].split(/,(?![^(]*\))/).map(s => s.trim())).filter(Boolean);
check('every rule is scoped to the Estimates pages', selectors.filter(sel => !sel.startsWith('[data-page="estimates"]')), []);
ok('   ...there are rules to check', selectors.length > 40, String(selectors.length));
ok('   ...the print rules show only the quotation sheet', /@media print\s*\{\s*\[data-page="estimates"\] #page-content > :not\(#estDetail\),\s*\[data-page="estimates"\] \.est-detail-head,\s*\[data-page="estimates"\] \.est-side\s*\{\s*display:\s*none !important;/.test(css), '');
const loaders = needle => fs.readdirSync(path.join(ROOT, 'pages')).filter(f => read(`pages/${f}`).includes(needle)).sort().join('|');
const own = PAGES.map(([f]) => `${f}.html`).sort().join('|');
ok('   ...and only the three Estimates pages load it', loaders('../css/estimates.css') === own, loaders('../css/estimates.css'));
ok('only the three Estimates pages load js/estimates-demo.js', loaders('../js/estimates-demo.js') === own, loaders('../js/estimates-demo.js'));

summary('estimates-demo-ui');
