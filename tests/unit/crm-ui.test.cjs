/* crm-ui — the Customer CRM is visual only in this release.

   What must hold until the CRM is built:
     1. The sidebar has a "Customer CRM" group after Expenses and before
        Reports, with five entries that link to real pages, mark the current
        one as active and open the group on a CRM page.
     2. The Dashboard's CRM Overview shows four cards with a "—" placeholder
        and "Coming soon" -- never a number, and nothing in dashboard.js
        calculates one.
     3. The five placeholder pages share the app's <head> (so the CSP hash
        still covers them), say "Coming soon", and carry no data, forms,
        actions or page script of their own.

   Drives the REAL js/app.js through the shared harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ENTRIES = [
  ['crm-reminders', 'Service Reminders', 'pages/crm-reminders.html'],
  ['crm-follow-up', 'Customer Follow-up', 'pages/crm-follow-up.html'],
  ['crm-history', 'Service History', 'pages/crm-history.html'],
  ['crm-tasks', 'Follow-up Tasks', 'pages/crm-tasks.html'],
  ['crm-reports', 'CRM Reports', 'pages/crm-reports.html'],
];

// Pages with a stylesheet of their own (loaded after responsive.css).
const PAGE_CSS = { 'crm-reminders': 'crm-reminders.css', 'crm-follow-up': 'crm-follow-up.css', 'crm-history': 'crm-history.css', 'crm-tasks': 'crm-tasks.css' };

/* The CRM pages that show their (not yet connected) layout rather than a
   "Coming soon" card, and exactly what that layout must contain. */
const LAYOUTS = {
  'crm-reminders': {
    prefix: 'crr', noun: 'reminder',
    options: ['All statuses', 'Upcoming', 'Due Today', 'Overdue'],
    cols: ['Customer', 'Vehicle', 'Registration Number', 'Last Service', 'Next Service Due', 'Status', 'Actions'],
    cards: ['Upcoming Services', 'Due Today', 'Overdue Services', 'Customers Requiring Follow-up'],
  },
  'crm-follow-up': {
    prefix: 'crf', noun: 'follow-up',
    options: ['All statuses', 'Pending', 'Due Today', 'Overdue', 'Completed'],
    cols: ['Customer', 'Vehicle', 'Follow-up Reason', 'Last Contact', 'Next Follow-up', 'Status', 'Actions'],
    cards: ['Total Follow-ups', 'Due Today', 'Contacted', 'Overdue'],
  },
  'crm-history': {
    prefix: 'crh', noun: 'service records', dates: 2, compact: true,   // a From / To date range; compact below 1200px
    options: ['All Statuses', 'Completed', 'Pending', 'Cancelled'],
    cols: ['Service Date', 'Customer', 'Vehicle', 'Registration Number', 'Job Card', 'Services Performed',
      'Mileage', 'Total Cost', 'Status', 'Actions'],
    cards: ['Total Service Visits', 'Completed Services', 'Pending Services', 'Total Service Cost'],
  },
  'crm-tasks': {
    prefix: 'ctk', noun: 'task', selects: 3,   // status, priority, assigned staff (no staff names: none are invented)
    options: ['All Statuses', 'Pending', 'In Progress', 'Completed', 'Overdue',
      'All Priorities', 'Low', 'Medium', 'High', 'Urgent',
      'All Staff'],
    cols: ['Task', 'Customer / Vehicle', 'Assigned To', 'Priority', 'Due Date', 'Status', 'Actions'],
    cards: ['Total Tasks', 'Due Today', 'Overdue Tasks', 'Completed Tasks'],
    legends: {
      'Status colours': [['neutral', 'Pending'], ['info', 'In Progress'], ['good', 'Completed'], ['bad', 'Overdue']],
      'Priority colours': [['neutral', 'Low'], ['info', 'Medium'], ['warn', 'High'], ['bad', 'Urgent']],
    },
  },
};

/** Render the shell for one page; return the sidebar HTML the shell wrote. */
function shellFor(page, root = '', sessionHint = null) {
  const session = new Map(sessionHint ? [['taqwa_nav_crm_open', sessionHint]] : []);
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)) };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const crmBlock = html => (html.match(/<details class="nav__group[^"]*" id="navCrm"[\s\S]*?<\/details>/) || [''])[0];

console.log('=== crm-ui: Customer CRM, visual only ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  const block = crmBlock(html);
  ok('the sidebar has a Customer CRM group', /<span>Customer CRM<\/span>/.test(block), block.slice(0, 200));
  const iExp = html.indexOf('pages/expenses.html'), iCrm = html.indexOf('id="navCrm"'), iRep = html.indexOf('pages/reports.html');
  ok('   ...placed after Expenses and before Reports', iExp > -1 && iExp < iCrm && iCrm < iRep, JSON.stringify({ iExp, iCrm, iRep }));
  const links = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  check('   ...with the five entries, in order', links, ENTRIES.map(([, label, href]) => [href, label]));
  ok('   ...each linking to a page that exists', ENTRIES.every(([, , href]) => fs.existsSync(path.join(ROOT, href))), '');
  ok('   ...a native <details>, so it opens from the keyboard', /^<details[\s\S]*<summary class="nav__summary">/.test(block), '');
  ok('   ...with an expand/collapse chevron', /<svg class="nav__chevron"/.test(block), '');
  ok('   ...closed by default on a non-CRM page, with nothing marked active',
    !/ open>/.test(block.slice(0, block.indexOf('>') + 1) + '>') && !/is-active|aria-current|has-active/.test(block), block.slice(0, 120));
  ok('existing navigation is all still there (Dashboard ... Settings, Social Inbox)',
    ['index.html', 'pages/customers.html', 'pages/vehicles.html', 'pages/appointments.html', 'pages/job-cards.html', 'pages/services.html',
      'pages/mechanics.html', 'pages/inventory.html', 'pages/invoices.html', 'pages/payments.html', 'pages/expenses.html', 'pages/reports.html',
      'pages/settings.html'].every(h => html.includes(`href="${h}"`)) && /id="navInbox"/.test(html), '');
}
{
  const block = crmBlock(shellFor('dashboard', '', '1'));
  ok('a group the user left open stays open on the next page', /^<details class="nav__group" id="navCrm" open>/.test(block), block.slice(0, 80));
}
for (const [key, label, href] of ENTRIES) {
  const html = shellFor(key, '../');
  const block = crmBlock(html);
  const active = [...block.matchAll(/<a class="nav__sub is-active" href="([^"]+)" aria-current="page">/g)].map(m => m[1]);
  ok(`on ${label}: the group is open and marked, and only its entry is active`,
    /^<details class="nav__group has-active" id="navCrm" open>/.test(block) && active.length === 1 && active[0] === `../${href}`,
    JSON.stringify({ head: block.slice(0, 70), active }));
  ok(`   ...and the header title reads "${label}"`, html.includes(`<h1>${label}</h1>`), '');
  ok('   ...while no top-level link claims to be active', !/class="nav__link is-active"/.test(html), '');
}

/* ---------- 2. dashboard overview ---------- */
console.log('\n-- 2. dashboard CRM overview --');
const index = read('index.html');
const overview = (index.match(/<section class="card crm-overview"[\s\S]*?<\/section>/) || [''])[0];
ok('the Dashboard has a Customer CRM Overview section', /<h2 id="crmOverviewTitle">Customer CRM Overview<\/h2>/.test(overview), '');
ok('   ...between the KPI cards and Revenue Overview',
  index.indexOf('id="statsGrid"') < index.indexOf('crm-overview') && index.indexOf('crm-overview') < index.indexOf('Revenue Overview'), '');
const cards = [...overview.matchAll(/<a class="crm-card crm-card--\w+" href="([^"]+)">[\s\S]*?<span class="crm-card__title">([^<]+)<\/span>[\s\S]*?<span class="crm-card__value">([\s\S]*?)<\/span><span class="crm-card__soon">([^<]+)<\/span>/g)]
  .map(m => ({ href: m[1], title: m[2], value: m[3], soon: m[4] }));
check('   ...with the four cards', cards.map(c => c.title), ['Upcoming Reminders', 'Overdue Services', 'Customers to Follow Up', 'Vehicles Due for Service']);
ok('   ...each showing a "—" placeholder and "Coming soon", never a number',
  cards.length === 4 && cards.every(c => c.value === '<span aria-hidden="true">—</span>' && c.soon === 'Coming soon'), JSON.stringify(cards));
ok('   ...with no digit anywhere in the section\'s visible text',
  !/\d/.test(overview.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')), '');
ok('   ...each card opening a CRM page that exists', cards.every(c => fs.existsSync(path.join(ROOT, c.href))), JSON.stringify(cards.map(c => c.href)));
ok('   ...and saying nothing is calculated or sent yet', /Nothing is calculated or sent yet\./.test(overview), '');
const dash = read('js/dashboard.js');
ok('dashboard.js does not compute anything for the CRM (untouched)', !/crm|nextServiceDate|follow/i.test(dash), '');
ok('the existing Dashboard sections are all still there',
  ['id="statsGrid"', 'Revenue Overview', 'id="revChart"', "Today's Appointments", 'id="apptList"', 'Recent Service Jobs', 'id="recentJobsBody"']
    .every(s => index.includes(s)), '');

/* ---------- 3. placeholder pages ---------- */
console.log('\n-- 3. placeholder pages --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
for (const [key, label, href] of ENTRIES) {
  const html = read(href);
  const body = html.slice(html.indexOf('<body data-page='));   // not the '<body>' named in a head comment
  // The CRM pages with a layout have their own page stylesheet,
  // added after responsive.css exactly as Profile and Account Settings add theirs.
  const ownCss = PAGE_CSS[key]
    ? `\n  <link rel="stylesheet" href="../css/${PAGE_CSS[key]}">` : '';
  check(`${label}: <head> is the Settings head with only the title${ownCss ? ' and its stylesheet' : ''} changed`, head(html),
    settingsHead.replace('<title>Settings — ', `<title>${label} — `)
      .replace('<link rel="stylesheet" href="../css/responsive.css">', `<link rel="stylesheet" href="../css/responsive.css">${ownCss}`));
  ok('   ...declares its own page key', body.startsWith(`<body data-page="${key}" data-root="../">`), body.slice(0, 60));
  ok('   ...says "Coming soon" and that it arrives in a future release',
    body.includes('Coming soon') && /activated in a future release/.test(body), '');
  ok('   ...has no form, button, textarea or inline handler', !/<form|<textarea|<button|\son[a-z]+=/i.test(body), '');
  const L = LAYOUTS[key];
  if (L) {
    // The layout shows its search, filters and table, but none of it works
    // yet: every control is disabled, the table holds only its empty state,
    // and no value is a number.
    const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
    const dates = L.dates || 1, selects = L.selects || 1;
    ok(`   ...shows a search box, ${selects === 1 ? 'a status filter' : `${selects} filters`} and ${dates === 1 ? 'a date filter' : `${dates} date fields`}, ALL disabled`,
      controls.length === 1 + selects + dates && controls.every(c => /\sdisabled\b/.test(c))
        && /type="search"/.test(controls[0]) && controls.slice(1, 1 + selects).every(c => c.startsWith('<select'))
        && controls.slice(1 + selects).every(c => /type="date"/.test(c)), JSON.stringify(controls));
    ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
    check(`   ...the ${selects === 1 ? 'status filter offers' : 'filters offer'} exactly ${L.options.slice(1).join(' / ')}`,
      [...body.matchAll(/<option>([^<]+)<\/option>/g)].map(m => m[1]), L.options);
    const cols = [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]);
    check(`   ...the ${L.noun} table has the planned columns`, cols, L.cols);
    const rows = [...body.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
    ok('   ...and no data rows -- only the one empty-state row',
      rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
        && new RegExp(`<tr class="${L.prefix}-empty-row">\\s*<td colspan="${L.cols.length}">`).test(rows[0]), '');
    if (L.compact) {
      // Too many columns for a narrow card: below its breakpoint the page hides
      // the heading row and the empty state names every column instead.
      const fields = ((body.match(new RegExp(`<p class="${L.prefix}-fields">([\\s\\S]*?)<\\/p>`)) || [])[1] || '').replace(/<[^>]+>/g, ' ').toLowerCase();
      ok('   ...and, for narrow screens, an empty state that names every column',
        L.cols.every(c => fields.includes(c.toLowerCase())), fields);
    }
    for (const [name, keys] of Object.entries(L.legends || {})) {
      const list = (body.match(new RegExp(`<ul class="${L.prefix}-legend" aria-label="${name}">([\\s\\S]*?)<\\/ul>`)) || [])[1] || '';
      check(`   ...a ${name.toLowerCase()} key in the app's tones`,
        [...list.matchAll(/<span class="badge badge--(\w+)">([^<]+)<\/span>/g)].map(m => [m[1], m[2]]), keys);
    }
    ok('   ...whose empty state says "Not yet connected"',
      new RegExp(`<span class="badge badge--neutral ${L.prefix}-empty__status">Not yet connected</span>`).test(body), '');
    const stats = [...body.matchAll(new RegExp(`<div class="stat__value">([\\s\\S]*?)<\\/div>\\s*<div class="stat__label">([^<]+)<\\/div>\\s*<div class="${L.prefix}-pending">([^<]+)<\\/div>`, 'g'))]
      .map(m => ({ value: m[1], label: m[2], pending: m[3] }));
    check('   ...four summary cards', stats.map(x => x.label), L.cards);
    ok('   ...each with a "—" placeholder marked "Not yet connected", never a number',
      stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>' && x.pending === 'Not yet connected'), JSON.stringify(stats));
    ok('   ...with no digit anywhere in the page\'s visible text',
      !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
        .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
    ok('   ...and planned actions shown as plain text, not as links or buttons',
      new RegExp(`class="${L.prefix}-planned"`).test(body) && !/<a\b/.test(body), '');
    ok('   ...whose stylesheet is scoped to this page alone',
      read(`css/${PAGE_CSS[key]}`).replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
        .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith(`[data-page="${key}"]`))), '');
  } else {
    ok('   ...has no input, select or table', !/<input|<select|<table/i.test(body), '');
  }
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads only the shared shell scripts (no page module, no requests of its own)', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
}

process.exit(summary('CRM UI unit') === 0 ? 0 : 1);
