/* crm-ui — the Customer CRM: three pages connected, two still visual only.

   What must hold:
     1. The sidebar has a "Customer CRM" group after Expenses and before
        Reports, with five entries that link to real pages, mark the current
        one as active and open the group on a CRM page.
     2. The Dashboard's CRM Overview shows four cards with a "—" placeholder
        and "Coming soon" -- never a number, and nothing in dashboard.js
        calculates one. (Service Reminders being connected does not change
        the Dashboard.)
     3. The two placeholder pages (Tasks, Reports) share the
        app's <head> (so the CSP hash still covers them), say "Coming soon",
        and carry no data, forms, actions or page script of their own.
     4. Service Reminders shares the same <head>, keeps its layout, starts in
        a loading state with every control disabled, and loads exactly one
        page script of its own. Its behaviour is tested in
        crm-reminders.test.cjs.
     5. Customer Follow-up shares the same <head>, starts in a loading state
        with every control (and its one static button) disabled, loads
        exactly one page script of its own, and that script reads no browser
        storage and writes only follow-ups through the database. Its
        behaviour is tested in crm-follow-up.test.cjs.
     6. Service History shares the same <head>, keeps its layout (status
        filter, From / To range, ten columns, four cards), starts in a
        loading state with every control disabled, loads exactly one page
        script of its own, and that script reads no browser storage, makes no
        requests and writes nothing. Its behaviour is tested in
        crm-history.test.cjs.

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
const PAGE_CSS = { 'crm-reminders': 'crm-reminders.css', 'crm-follow-up': 'crm-follow-up.css', 'crm-history': 'crm-history.css', 'crm-tasks': 'crm-tasks.css',
  'crm-reports': 'crm-reports.css' };

/* The CRM pages that show their (not yet connected) layout rather than a
   "Coming soon" card, and exactly what that layout must contain. */
const REMINDERS = {
  options: [['all', 'All statuses'], ['Upcoming', 'Upcoming'], ['Due Today', 'Due Today'], ['Overdue', 'Overdue']],
  cols: ['Customer', 'Vehicle', 'Registration Number', 'Last Service', 'Next Service Due', 'Status', 'Actions'],
  cards: ['Upcoming Services', 'Due Today', 'Overdue Services', 'Customers Requiring Follow-up'],
};
// Pages that are connected to the database and tested on their own below.
const CONNECTED = ['crm-reminders', 'crm-follow-up', 'crm-history'];
const PLACEHOLDERS = ENTRIES.filter(([key]) => !CONNECTED.includes(key));

/* Service History is connected; its layout is checked in section 6. */
const HISTORY = {
  options: [['all', 'All Statuses'], ['completed', 'Completed'], ['pending', 'Pending'], ['cancelled', 'Cancelled']],
  cols: ['Service Date', 'Customer', 'Vehicle', 'Registration Number', 'Job Card', 'Services Performed',
    'Mileage', 'Total Cost', 'Status', 'Actions'],
  cards: [['crhVisits', 'Total Service Visits'], ['crhCompleted', 'Completed Services'],
    ['crhPending', 'Pending Services'], ['crhCost', 'Total Service Cost']],
};

const LAYOUTS = {
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
  'crm-reports': {
    // No search box: a period select (Last 30 days pre-selected) and a From / To
    // range, plus ONE disabled Export CSV button -- nothing exists to export yet.
    prefix: 'crp', noun: 'CRM activity', search: false, dates: 2,
    options: ['Last 7 days', 'Last 30 days', 'This month', 'Custom range'], selected: 'Last 30 days',
    // The only digits allowed on the page: these period names, and only as the
    // select's options and the "Selected period" label (never as a figure).
    periods: ['Last 7 days', 'Last 30 days'],
    button: 'Export CSV',
    cols: ['Customer', 'Vehicle', 'Service Date', 'Follow-up Status', 'Assigned Staff'],
    cards: ['Service Reminders Due', 'Pending Follow-ups', 'Completed Follow-ups', 'Returning Customers'],
    chart: ['Reminders due', 'Pending follow-ups', 'Completed follow-ups', 'Returning customers'],   // planned series only
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
for (const [key, label, href] of PLACEHOLDERS) {
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
  const L = LAYOUTS[key];
  let rest = body;
  if (L && L.button) {
    // Exactly one button, and it cannot do anything: type="button", disabled,
    // no handler, explained by a note. Everything else is checked as on the
    // other pages, with that one button taken out.
    const buttons = body.match(/<button\b[\s\S]*?<\/button>/g) || [];
    const b = buttons[0] || '', tag = (b.match(/^<button\b[^>]*>/) || [''])[0];
    const note = (tag.match(/\saria-describedby="([^"]+)"/) || [])[1];
    ok(`   ...has exactly one button, "${L.button}", and it is disabled`,
      buttons.length === 1 && (body.match(/<button\b/g) || []).length === 1 && /^<button type="button"/.test(tag) && /\sdisabled\b/.test(tag)
        && b.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').trim() === L.button, JSON.stringify(buttons));
    // Taken out of the page-wide check below, so its own tag is checked here:
    // no inline handler (onclick=...) and nothing that could submit or send it
    // (form=, formaction=, formmethod=, formenctype=, formtarget=, formnovalidate).
    ok('   ...with no inline event handler on that button', !!tag && !/\son[a-z]+\s*=/i.test(tag), tag);
    ok('   ...and no form or submission attribute on it', !!tag && !/\sform[a-z]*(\s*=|[\s>])/i.test(tag), tag);
    ok('   ...with a note saying why it is disabled and that no file is created',
      !!note && new RegExp(`<span id="${note}">[^<]*disabled until there is real CRM data[^<]*no file is created[^<]*</span>`).test(body), String(note));
    rest = body.replace(b, '');
  }
  ok('   ...has no form, button, textarea or inline handler', !/<form|<textarea|<button|\son[a-z]+=/i.test(rest), '');
  if (L) {
    // The layout shows its search, filters and table, but none of it works
    // yet: every control is disabled, the table holds only its empty state,
    // and no value is a number.
    const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
    const dates = L.dates || 1, selects = L.selects || 1, search = L.search === false ? 0 : 1;
    ok(`   ...shows ${search ? 'a search box, ' : ''}${selects === 1 ? (L.selected ? 'a period select' : 'a status filter') : `${selects} filters`} and ${dates === 1 ? 'a date filter' : `${dates} date fields`}, ALL disabled`,
      controls.length === search + selects + dates && controls.every(c => /\sdisabled\b/.test(c))
        && (!search || /type="search"/.test(controls[0])) && controls.slice(search, search + selects).every(c => c.startsWith('<select'))
        && controls.slice(search + selects).every(c => /type="date"/.test(c)), JSON.stringify(controls));
    ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
    const options = [...body.matchAll(/<option\b([^>]*)>([^<]+)<\/option>/g)];
    if (L.selected) {
      check(`   ...the period select offers exactly ${L.options.join(' / ')}`, options.map(m => m[2]), L.options);
      check(`   ...with "${L.selected}" pre-selected, and no other option attributes`,
        options.filter(m => m[1] !== '').map(m => [m[1], m[2]]), [[' selected', L.selected]]);
      ok(`   ...and the label reads "Selected period: ${L.selected} · not yet connected" (no dates computed)`,
        new RegExp(`<p class="${L.prefix}-period" id="\\w+">Selected period: <strong class="${L.prefix}-period__value">${L.selected}</strong> &#183; not yet connected</p>`).test(body), '');
    } else {
      check(`   ...the ${selects === 1 ? 'status filter offers' : 'filters offer'} exactly ${L.options.slice(1).join(' / ')}`,
        options.map(m => m[2]), L.options);
      ok('   ...with no option pre-selected', options.every(m => m[1] === ''), '');
    }
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
    if (L.chart) {
      // The trends chart is an empty CSS frame: a key of the planned series and
      // an explanation, but no bars, points, axis values or data of any kind.
      const trends = (body.match(new RegExp(`<section class="card ${L.prefix}-trends"[\\s\\S]*?<\\/section>`)) || [''])[0];
      const frame = (trends.match(new RegExp(`<div class="${L.prefix}-chart">([\\s\\S]*)<\\/div>\\s*<\\/div>\\s*<\\/section>`)) || [])[1] || '';
      check('   ...a trends chart whose key lists only the planned series',
        [...trends.matchAll(new RegExp(`<li><span class="${L.prefix}-key__dot ${L.prefix}-key__dot--\\w+" aria-hidden="true"><\\/span>([^<]+)<\\/li>`, 'g'))].map(m => m[1]), L.chart);
      const classes = [...frame.matchAll(/class="([^"]+)"/g)].map(m => m[1]);
      ok('   ...and an empty frame: only its explanation, no bars, values, canvas or table',
        /<h3>No activity to chart yet<\/h3>/.test(frame) && /No chart data is generated\./.test(frame)
          && classes.every(c => /__(empty|icon)$/.test(c)) && !/<(canvas|table|img|li)\b|\sstyle=/.test(frame)
          && !/\d/.test(frame.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')),
        JSON.stringify(classes));
    }
    ok('   ...whose empty state says "Not yet connected"',
      new RegExp(`<span class="badge badge--neutral ${L.prefix}-empty__status">Not yet connected</span>`).test(body), '');
    const stats = [...body.matchAll(new RegExp(`<div class="stat__value">([\\s\\S]*?)<\\/div>\\s*<div class="stat__label">([^<]+)<\\/div>\\s*<div class="${L.prefix}-pending">([^<]+)<\\/div>`, 'g'))]
      .map(m => ({ value: m[1], label: m[2], pending: m[3] }));
    check('   ...four summary cards', stats.map(x => x.label), L.cards);
    ok('   ...each with a "—" placeholder marked "Not yet connected", never a number',
      stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>' && x.pending === 'Not yet connected'), JSON.stringify(stats));
    // Period names ("Last 30 days") are removed only where they are allowed:
    // as an option of the period select and as the "Selected period" label.
    let visible = body;
    for (const name of L.periods || []) {
      visible = visible.split(`<option>${name}</option>`).join('').split(`<option selected>${name}</option>`).join('')
        .split(`<strong class="${L.prefix}-period__value">${name}</strong>`).join('');
    }
    ok(`   ...with no digit anywhere in the page's visible text${L.periods ? ' (other than the period names)' : ''}`,
      !/\d/.test(visible.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
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

/* ---------- 4. Service Reminders (connected) ---------- */
console.log('\n-- 4. Service Reminders --');
{
  const html = read('pages/crm-reminders.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Service Reminders: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Service Reminders — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-reminders.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-reminders" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon"', !/Coming soon|activated in a future release/.test(body), '');
  ok('   ...has no form, textarea, static button or inline handler (actions are rendered from data)',
    !/<form|<textarea|<button|\son[a-z]+=/i.test(body), '');
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box, a status filter and a due-by date, all disabled until the reminders load',
    controls.length === 3 && /type="search"/.test(controls[0]) && controls[1].startsWith('<select') && /type="date"/.test(controls[2])
      && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  check('   ...the status filter offers All / Upcoming / Due Today / Overdue, by value',
    [...body.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]), REMINDERS.options);
  ok('   ...with no option pre-selected', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the reminder table keeps its columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]), REMINDERS.cols);
  const rows = [...body.matchAll(/<tbody id="crrBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crr-empty-row">\s*<td colspan="7">/.test(rows[0]) && /Loading service reminders/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value"( id="\w+")?>([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="(crr-sub|crr-pending)"( id="\w+")?>([^<]+)<\/div>/g)]
    .map(m => ({ id: (m[1] || '').trim(), value: m[2], label: m[3], kind: m[4], note: m[6] }));
  check('   ...four summary cards', stats.map(x => x.label), REMINDERS.cards);
  check('   ...the first three wired by id', stats.slice(0, 3).map(x => x.id), ['id="crrUpcoming"', 'id="crrDueToday"', 'id="crrOverdue"']);
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...and "Customers Requiring Follow-up" stays "Not yet connected" (no follow-up data exists)',
    stats[3] && stats[3].kind === 'crr-pending' && stats[3].note === 'Not yet connected'
      && /<div class="stat crr-stat crr-stat--pending">/.test(body), JSON.stringify(stats[3]));
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-reminders.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-reminders.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-reminders"]'))), '');
  const js = read('js/crm-reminders.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...writes nothing: no Storage write, seed or reset call',
    !/Storage\.(create|update|remove|action|addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings)\b/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 5. Customer Follow-up (connected) ---------- */
console.log('\n-- 5. Customer Follow-up --');
{
  const html = read('pages/crm-follow-up.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Customer Follow-up: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Customer Follow-up — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-follow-up.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-follow-up" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (dialogs are rendered by the page module)',
    !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  ok('   ...exactly one static button, "New Follow-up", type="button" and disabled until the data loads',
    buttons.length === 1 && /id="crfNew"/.test(buttons[0]) && /type="button"/.test(buttons[0]) && /\sdisabled\b/.test(buttons[0]),
    JSON.stringify(buttons));
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box and three filters (status, due date, priority), all disabled until the data loads',
    controls.length === 4 && /type="search"/.test(controls[0]) && controls.slice(1).every(c => c.startsWith('<select'))
      && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  const selects = [...body.matchAll(/<select[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)]
    .map(m => [m[1], [...m[2].matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(o => [o[1], o[2]])]);
  check('   ...the filters offer exactly these values', selects, [
    ['crfStatus', [['open', 'Open'], ['all', 'All statuses'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']]],
    ['crfDue', [['any', 'Any due date'], ['today', 'Due today'], ['overdue', 'Overdue']]],
    ['crfPriority', [['all', 'All priorities'], ['high', 'High'], ['normal', 'Normal']]],
  ]);
  ok('   ...with no option pre-selected (Open is first, so it is the default)', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the follow-up table has its columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Customer', 'Vehicle', 'Follow-up Reason', 'Priority', 'Due Date', 'Status', 'Last Contact', 'Actions']);
  const rows = [...body.matchAll(/<tbody id="crfBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crf-empty-row">\s*<td colspan="8">/.test(rows[0]) && /Loading follow-ups/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3] }));
  check('   ...four summary cards, labelled as Open counts and wired by id', stats.map(x => [x.id, x.label]),
    [['crfTotal', 'Open Follow-ups'], ['crfDueToday', 'Due Today'], ['crfContacted', 'Contacted'], ['crfOverdue', 'Overdue']]);
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-follow-up.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-follow-up.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-follow-up"]'))), '');
  const js = read('js/crm-follow-up.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...never seeds, resets or writes browser storage',
    !/Storage\.(addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings|remove)\b/.test(js), '');
  const writes = [...js.matchAll(/Storage\.(create|update|action)\('(\w+)'/g)].map(m => m[2]);
  ok('   ...and writes only follow-ups and their contacts, through the database',
    writes.length > 0 && writes.every(c => c === 'followUps' || c === 'followUpContacts'), JSON.stringify(writes));
  ok('   ...never makes a key with Math.random', !/Math\.random/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 6. Service History (connected) ---------- */
console.log('\n-- 6. Service History --');
{
  const html = read('pages/crm-history.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Service History: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Service History — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-history.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-history" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (rows and messages are rendered by the page module)',
    !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  check('   ...three static buttons: Clear filters, Previous, Next', buttons.map(b => (b.match(/id="(\w+)"/) || [])[1]), ['crhClear', 'crhPrev', 'crhNext']);
  ok('   ...each type="button" and disabled until the data loads',
    buttons.every(b => /type="button"/.test(b) && /\sdisabled\b/.test(b)), JSON.stringify(buttons));
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box, a status filter and a From / To range, all disabled until the data loads',
    controls.length === 4 && /type="search"/.test(controls[0]) && controls[1].startsWith('<select')
      && controls.slice(2).every(c => /type="date"/.test(c)) && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  ok('   ...and the date range tied to its inline error message',
    controls.slice(2).every(c => /aria-describedby="crhRangeError"/.test(c)) && /<p class="crh-range-error" id="crhRangeError" role="alert" hidden><\/p>/.test(body), '');
  check('   ...the status filter offers All / Completed / Pending / Cancelled, by value',
    [...body.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]), HISTORY.options);
  ok('   ...with no option pre-selected', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the service records table keeps its ten columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]), HISTORY.cols);
  const rows = [...body.matchAll(/<tbody id="crhBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crh-empty-row">\s*<td colspan="10">/.test(rows[0]) && /Loading service history/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="crh-sub" id="(\w+)">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3], sub: m[4] }));
  check('   ...four summary cards, wired by id', stats.map(x => [x.id, x.label]), HISTORY.cards);
  ok('   ...each with its own note line', stats.every(x => x.sub === `${x.id}Sub`), JSON.stringify(stats));
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...a hidden, empty timeline panel and a hidden pager',
    /<section class="card crh-timeline" id="crhTimeline" aria-labelledby="crhTimelineTitle" hidden><\/section>/.test(body)
      && /<nav class="crh-pager" id="crhPager" aria-label="Service records pages" hidden>/.test(body), '');
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-history.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-history.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-history"]'))), '');
  const js = read('js/crm-history.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...writes nothing: no Storage write, seed or reset call',
    !/Storage\.(create|update|remove|action|addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings)\b/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

process.exit(summary('CRM UI unit') === 0 ? 0 : 1);
