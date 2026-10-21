/* staff-management-ui — Staff Management: the sidebar group and its nine
   UI-preview pages.

   What must hold:
     1. The sidebar has a "Staff Management" group right after Mechanics and
        before Inventory, with nine entries that link to real pages, mark the
        current one as active and open the group on a Staff page. The original
        six keep their order and URLs; Attendance, Leave Management and
        Performance sit between Roles & Permissions and Activity Log. The group
        follows the approved reference design: outline icons (the group's own
        and all nine entries') while every other link and group keeps its filled
        icons, and its styling is scoped to #navStaff. It is no longer a
        top-level link, and every other link keeps its order.
     2. On each Staff page only its own entry is active and the header title
        names the page; on any other page nothing in the group is active.
     3. Every Staff page shares the Settings <head> (title and the staff
        stylesheet aside), declares its own page key, says plainly that it is a
        preview whose content is not saved or sent, loads exactly the shared
        shell scripts plus js/staff-ui.js, and has no form, file or password
        input, inline handler or inline script. Every button is type="button".
     4. js/staff-ui.js never touches the database, browser storage or the
        network, and never writes HTML: content is built as text.
     5. The demo data is unmistakably fictional (Demo Staff names, example.com
        addresses, masked phones), holds no password, and the summaries,
        filters and paging the pages show are computed from it correctly --
        including the attendance week, the leave requests and the sample
        performance figures.
     6. css/staff.css reaches the Staff pages only.

   Drives the REAL js/app.js through the shared harness; js/staff-ui.js is
   loaded on its own with no page, which runs none of its rendering. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ENTRIES = [
  ['staff-management', 'Overview', 'pages/staff-management.html', 'Staff Management'],
  ['staff-list', 'Staff List', 'pages/staff-list.html', 'Staff List'],
  ['staff-add', 'Add Staff', 'pages/staff-add.html', 'Add Staff'],
  ['staff-accounts', 'User Accounts', 'pages/staff-accounts.html', 'User Accounts'],
  ['staff-roles', 'Roles & Permissions', 'pages/staff-roles.html', 'Roles & Permissions'],
  ['staff-attendance', 'Attendance', 'pages/staff-attendance.html', 'Attendance'],
  ['staff-leave', 'Leave Management', 'pages/staff-leave.html', 'Leave Management'],
  ['staff-performance', 'Performance', 'pages/staff-performance.html', 'Performance'],
  ['staff-activity-log', 'Activity Log', 'pages/staff-activity-log.html', 'Activity Log'],
];
// The approved reference design: one outline icon per entry, in order (24-unit stroke markup).
const REF_ICONS = [
  ['staff-management', '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'],
  ['staff-list', '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>'],
  ['staff-add', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>'],
  ['staff-accounts', '<path d="M8 2v2"/><path d="M16 2v2"/><rect width="18" height="18" x="3" y="4" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>'],
  ['staff-roles', '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'],
  ['staff-attendance', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>'],
  ['staff-leave', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>'],
  ['staff-performance', '<path d="M4 18v3"/><path d="M8 14v7"/><path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.65 8.65a.5.5 0 0 1-.7 0L9.35 8.35a.5.5 0 0 0-.7 0L2 15"/>'],
  ['staff-activity-log', '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'],
];
const NEW_KEYS = ['staff-attendance', 'staff-leave', 'staff-performance'];

/** Render the shell for one page; return the HTML the shell wrote. */
function shellFor(page, root = '', sessionHint = null) {
  const session = new Map(sessionHint ? [['taqwa_nav_staff_open', sessionHint]] : []);
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
const staffBlock = html => (html.match(/<details class="nav__group[^"]*" id="navStaff"[\s\S]*?<\/details>/) || [''])[0];
// Top-level links only: group entries are nav__sub.
const topLinks = html => [...html.matchAll(/<a class="nav__link( is-active)?" href="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)]
  .map(m => ({ active: !!m[1], href: m[2], label: m[3] }));

console.log('=== staff-management-ui: Staff Management group and preview pages ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  check('the top-level links, in order (Staff Management is a group, not a link)', topLinks(html).map(l => l.label),
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Estimates & Quotations', 'Services', 'Mechanics',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Workshop Tools', 'Reports', 'Settings']);
  const block = staffBlock(html);
  ok('the sidebar has a Staff Management group', /<summary class="nav__summary"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"[^>]*>[\s\S]*?<\/svg><span>Staff Management<\/span>/.test(block), block.slice(0, 200));
  const iMec = html.indexOf('href="pages/mechanics.html"'), iGrp = html.indexOf('id="navStaff"'), iInv = html.indexOf('href="pages/inventory.html"');
  ok('   ...placed right after Mechanics and before Inventory', iMec > -1 && iMec < iGrp && iGrp < iInv
    && !/<a class="nav__link/.test(html.slice(iMec + 1, iGrp).replace(/^[^>]*>/, '')), JSON.stringify({ iMec, iGrp, iInv }));
  const links = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  check('   ...with the nine entries, in order', links, ENTRIES.map(([, label, href]) => [href, label]));
  check('   ...the three new entries sit right after Roles & Permissions and right before Activity Log',
    links.slice(4, 9).map(l => l[1]), ['Roles & Permissions', 'Attendance', 'Leave Management', 'Performance', 'Activity Log']);
  const subs = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*><svg ([^>]*)>([\s\S]*?)<\/svg><span>([^<]+)<\/span><\/a>/g)]
    .map(m => ({ href: m[1], attrs: m[2], icon: m[3], label: m[4] }));
  check('   ...each entry has the outline icon of the approved reference design, in order',
    subs.map(x => [x.href, x.icon]), REF_ICONS.map(([k, icon]) => [`pages/${k}.html`, icon]));
  ok('   ...drawn as 16px stroke icons that follow the text colour',
    subs.length === 9 && subs.every(x => /^viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"$/.test(x.attrs)), JSON.stringify(subs.map(x => x.attrs)));
  ok('   ...nine different icons', new Set(subs.map(x => x.icon)).size === 9, '');
  ok('   ...the chevron is an outline chevron that turns with the group',
    /<svg class="nav__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"[^>]*><path d="m6 9 6 6 6-6"\/><\/svg><\/summary>/.test(block), '');
  const crm = (html.match(/<details class="nav__group[^"]*" id="navCrm"[\s\S]*?<\/details>/) || [''])[0];
  ok('every other group and link keeps its filled icons (the outline style is the Staff group\'s only)',
    crm && !/fill="none"/.test(crm) && !/fill="none"/.test((html.match(/<nav[\s\S]*?<\/nav>/) || [''])[0].replace(block, ''))
      && (html.match(/<a class="nav__link[^"]*" href="[^"]+"><svg[^>]*fill="currentColor"/g) || []).length === 15, '');
  ok('   ...each linking to a page that exists', ENTRIES.every(([, , href]) => fs.existsSync(path.join(ROOT, href))), '');
  ok('   ...the Overview keeps its existing URL', links[0] && links[0][0] === 'pages/staff-management.html', '');
  ok('   ...a native <details> with a chevron, so it opens from the keyboard',
    /^<details[\s\S]*<summary class="nav__summary">/.test(block) && /<svg class="nav__chevron"/.test(block), '');
  ok('   ...closed by default on another page, with nothing marked active',
    /^<details class="nav__group" id="navStaff">/.test(block) && !/is-active|aria-current|has-active/.test(block), block.slice(0, 120));
  ok('the Customer CRM and Social Inbox groups are still there', /id="navCrm"/.test(html) && /id="navInbox"/.test(html), '');
}
{
  const block = staffBlock(shellFor('dashboard', '', '1'));
  ok('a group the user left open stays open on the next page', /^<details class="nav__group" id="navStaff" open>/.test(block), block.slice(0, 80));
}

/* ---------- 2. active state and header ---------- */
console.log('\n-- 2. active state --');
for (const [key, label, href, title] of ENTRIES) {
  const html = shellFor(key, '../');
  const block = staffBlock(html);
  const active = [...block.matchAll(/<a class="nav__sub is-active" href="([^"]+)" aria-current="page">/g)].map(m => m[1]);
  ok(`on ${label}: the group is open and marked, and only its entry is active`,
    /^<details class="nav__group has-active" id="navStaff" open>/.test(block) && active.length === 1 && active[0] === `../${href}`,
    JSON.stringify({ head: block.slice(0, 70), active }));
  ok(`   ...no top-level link and no Customer CRM entry is active`,
    topLinks(html).every(l => !l.active) && !/id="navCrm"[^>]*has-active/.test(html), '');
  ok(`   ...and the header title reads "${title}"`, html.includes(`<h1>${title}</h1>`), '');
}
for (const page of ['mechanics', 'crm-reports', 'settings']) {
  const html = shellFor(page, '../');
  ok(`on ${page}: nothing in the Staff group is active`, !/is-active|aria-current|has-active/.test(staffBlock(html)), '');
}

/* ---------- 3. the pages ---------- */
console.log('\n-- 3. the pages --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
const SCRIPTS = ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/staff-ui.js'];
const pages = {};
for (const [key, label] of ENTRIES) {
  const html = read(`pages/${key}.html`);
  const body = html.slice(html.indexOf('<body data-page='));
  pages[key] = body;
  const titleText = label === 'Overview' ? 'Staff Management' : label;
  check(`${label}: <head> is the Settings head with only the title and the staff stylesheet changed`, head(html),
    settingsHead.replace('<title>Settings — ', `<title>${titleText} — `)
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/staff.css">'));
  ok('   ...declares its own page key', body.startsWith(`<body data-page="${key}" data-root="../">`), body.slice(0, 60));
  ok('   ...says it is a preview and that nothing is saved or sent',
    /<div class="stf-preview" role="note">/.test(body) && /<strong>Preview: [^<]+<\/strong>/.test(body) && /Nothing on this page is saved or sent/.test(body), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus js/staff-ui.js, last', scripts, SCRIPTS);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...has no form, file input or password input', !/<form\b|type="file"|type="password"/i.test(body), '');
  ok('   ...has no inline handler and no inline script in the body', !/\son[a-z]+=/i.test(html) && !/<script>/.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  ok('   ...every button is type="button"', buttons.every(b => /\stype="button"/.test(b)), JSON.stringify(buttons.filter(b => !/type="button"/.test(b))));
  if (key !== 'staff-management') {
    ok('   ...has a breadcrumb back to the Overview', /<nav class="stf-crumbs" aria-label="Breadcrumb">/.test(body)
      && body.includes('<a href="staff-management.html">Staff Management</a>') && body.includes(`<li aria-current="page">${label}</li>`), '');
  }
}
{
  const o = pages['staff-management'];
  ok('Overview: four summary cards, two charts with legends and the Recent Staff table',
    ['stfTotal', 'stfActive', 'stfInactive', 'stfAccounts', 'stfRoleChart', 'stfRoleLegend', 'stfStatusChart', 'stfStatusLegend', 'stfRecentBody']
      .every(id => o.includes(`id="${id}"`)), '');
  ok('   ...the subtitle and a View All Staff link to the list',
    o.includes('<p class="page-subtitle">Manage workshop staff and employee information.</p>') && /<a class="btn btn--ghost btn--sm" href="staff-list.html"><span>View All Staff<\/span>/.test(o), '');
  ok('   ...every card that shows data is badged "Demo"', (o.match(/<span class="badge badge--neutral">Demo<\/span>/g) || []).length === 3, '');
  const l = pages['staff-list'];
  ok('Staff List: search, role, department and status filters, pager, empty state',
    ['stfSearch', 'stfRole', 'stfDept', 'stfStatus', 'stfListClear', 'stfListPrev', 'stfListNext', 'stfListEmpty'].every(id => l.includes(`id="${id}"`)), '');
  check('   ...the requested columns', [...l.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]),
    ['Staff ID', 'Name', 'Designation', 'Department', 'Phone', 'Email', 'Status', 'Joining Date', 'Actions']);
  const a = pages['staff-add'];
  ok('Add Staff: personal, contact and employment sections and a photo area',
    ['stf-sec-personal', 'stf-sec-contact', 'stf-sec-employment', 'stfPhotoTitle'].every(id => a.includes(`id="${id}"`)), '');
  ok('   ...required fields are marked', (a.match(/<span class="req" aria-hidden="true">\*<\/span>/g) || []).length >= 6, '');
  ok('   ...Save Staff and the photo button only explain they are a preview',
    a.includes('<button type="button" class="btn btn--primary" data-preview="Save Staff">Save Staff</button>')
      && a.includes('data-preview="Upload photo"'), '');
  const u = pages['staff-accounts'];
  ok('User Accounts: says accounts are not active and passwords are never shown',
    /not active yet: the workshop still signs in with the shared passphrase/.test(u) && /Passwords are never shown/.test(u), '');
  check('   ...the requested columns, with no password column', [...u.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]),
    ['Staff', 'Username', 'Role', 'Account Status', 'Actions']);
  ok('   ...Create Account only explains it is a preview', u.includes('data-preview="Create Account"'), '');
  const r = pages['staff-roles'];
  ok('Roles & Permissions: says the permissions are an example and not applied', /<strong>not applied<\/strong>/.test(r), '');
  check('   ...a matrix with View, Create, Edit and Delete', [...r.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Module', 'View', 'Create', 'Edit', 'Delete']);
  const g = pages['staff-activity-log'];
  ok('Activity Log: says logging is not active and the entries are examples', /Activity logging is not active yet/.test(g), '');
  ok('   ...search, date range, user and action filters, details panel, pager, empty state',
    ['stfActSearch', 'stfActFrom', 'stfActTo', 'stfActUser', 'stfActAction', 'stfActDetails', 'stfActPrev', 'stfActNext', 'stfActEmpty'].every(id => g.includes(`id="${id}"`)), '');
}
{
  const cols = body => [...body.matchAll(/<th(?: class="num")?>([^<]+)<\/th>/g)].map(m => m[1]);
  const demoBadges = body => (body.match(/<span class="badge badge--neutral">Demo<\/span>/g) || []).length;
  const t = pages['staff-attendance'];
  ok('Attendance: says attendance is not recorded yet and the week is only an example',
    /<strong>Preview: demo data, not real attendance records\.<\/strong>/.test(t) && /Attendance is not recorded yet/.test(t), '');
  check('   ...a summary card for each of the six statuses, in order',
    [...t.matchAll(/<div class="stat__value" id="stfAtt-([a-z-]+)">/g)].map(m => m[1]), ['present', 'late', 'half-day', 'absent', 'on-leave', 'holiday']);
  ok('   ...day picker, search, status and department filters, the week grid with its key, empty state',
    ['stfAttDay', 'stfAttSearch', 'stfAttStatus', 'stfAttDept', 'stfAttClear', 'stfAttBody', 'stfWeekHead', 'stfWeekBody', 'stfWeekKey', 'stfAttEmpty'].every(id => t.includes(`id="${id}"`)), '');
  check('   ...the daily columns', cols(t), ['Staff', 'Department', 'Status', 'Check-in', 'Check-out', 'Hours', 'Actions']);
  check('   ...both data cards are badged "Demo"', demoBadges(t), 2);
  const v = pages['staff-leave'];
  ok('Leave Management: says leave cannot be requested, approved or rejected yet',
    /<strong>Preview: demo data, not real leave requests\.<\/strong>/.test(v) && /Leave cannot be requested, approved or rejected yet/.test(v), '');
  ok('   ...New Leave Request only explains it is a preview', /<button type="button" class="btn btn--primary" data-preview="New Leave Request">/.test(v), '');
  ok('   ...Pending, Approved, Rejected and approved-days cards, both charts, filters, pager, empty state',
    ['stfLvPending', 'stfLvApproved', 'stfLvRejected', 'stfLvDays', 'stfLvTypeChart', 'stfLvTypeLegend', 'stfLvStatusChart', 'stfLvStatusLegend',
      'stfLvSearch', 'stfLvType', 'stfLvStatus', 'stfLvClear', 'stfLvPrev', 'stfLvNext', 'stfLvEmpty'].every(id => v.includes(`id="${id}"`)), '');
  check('   ...the requested columns', cols(v), ['Request', 'Staff', 'Leave Type', 'Dates', 'Days', 'Reason', 'Status', 'Actions']);
  check('   ...every data card is badged "Demo"', demoBadges(v), 3);
  const f = pages['staff-performance'];
  ok('Performance: says every figure is a sample and performance is not measured yet',
    /<strong>Preview: sample figures, not real performance\.<\/strong>/.test(f) && /Every number here is demo data: performance is not measured yet/.test(f), '');
  check('   ...the four requested measures, in order', [...f.matchAll(/<div class="stat__label">([^<]+)<\/div>/g)].map(m => m[1]),
    ['Completed Jobs', 'On-time Completion', 'Average Turnaround Time', 'Labour Value']);
  check('   ...each card says it is a sample figure', (f.match(/<div class="stf-stat__sub"[^>]*>Sample figure/g) || []).length, 4);
  check('   ...the staff table columns', cols(f), ['#', 'Staff', 'Role', 'Completed Jobs', 'On-time Completion', 'Avg. Turnaround', 'Labour Value']);
  ok('   ...a sort choice for each measure, the period label and an empty state',
    ['stfPerfSort', 'stfPerfPeriod', 'stfPerfBody', 'stfPerfEmpty'].every(id => f.includes(`id="${id}"`))
      && ['jobs', 'onTime', 'turnaround', 'labour'].every(o => f.includes(`<option value="${o}">`)), '');
  check('   ...the table is badged "Demo"', demoBadges(f), 1);
  ok('the three new pages each have an empty-state switch in their preview notice',
    NEW_KEYS.every(k => /<div class="stf-preview" role="note">[\s\S]*?data-empty-toggle aria-pressed="false">Show the empty state<\/button>/.test(pages[k])), '');
}

/* ---------- 4. the page script ---------- */
console.log('\n-- 4. js/staff-ui.js --');
const src = read('js/staff-ui.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
check('it never reaches the database, browser storage or the network',
  ['fetch(', 'XMLHttpRequest', 'Api.', 'Storage.', 'localStorage', 'sessionStorage', 'sendBeacon', 'WebSocket', 'FileReader', 'indexedDB']
    .filter(t => code.includes(t)), []);
check('it never writes HTML', ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'].filter(t => code.includes(t)), []);
ok('it does not format the demo amounts with Utils.money (which reads the workshop settings)', !code.includes('Utils.money'), '');
check('it renders exactly the nine Staff pages',
  [...code.match(/const RENDER = \{([\s\S]*?)\};/)[1].matchAll(/'([a-z-]+)':/g)].map(m => m[1]),
  ENTRIES.map(([k]) => k).filter(k => k !== 'staff-add'));
ok('every action button it creates is type="button" and only explains it is a preview',
  /type: 'button', class: `icon-btn icon-btn--sm\$\{extraClass\}`, title: label, 'aria-label': label, 'data-preview': label/.test(code)
    && /Preview only: .* is not available yet\. Nothing was saved or sent\./.test(code), '');

/* ---------- 5. demo data and helpers ---------- */
console.log('\n-- 5. demo data --');
const sb = { console, Math, JSON, Object, Array, String, Number, Set, Map };
vm.createContext(sb);
vm.runInContext(`${src}\nglobalThis.StaffUI = StaffUI;`, sb, { filename: 'js/staff-ui.js' });
const S = sb.StaffUI;
check('twelve demo staff', S.DEMO_STAFF.length, 12);
ok('   ...every name is "Demo Staff <letter>"', S.DEMO_STAFF.every(s => /^Demo Staff [A-L]$/.test(s.name)), '');
ok('   ...every ID is DEMO-nnn', S.DEMO_STAFF.every(s => /^DEMO-\d{3}$/.test(s.id)), '');
ok('   ...every email address is on example.com', S.DEMO_STAFF.every(s => /^[a-z.]+@example\.com$/.test(s.email)), '');
ok('   ...every phone number is masked', S.DEMO_STAFF.every(s => /^01XXX-XXX\d{3}$/.test(s.phone)), '');
ok('   ...no record has a password field, and no password appears anywhere in the data',
  S.DEMO_STAFF.every(s => !Object.keys(s).some(k => /pass/i.test(k))) && !/password\s*:/i.test(code), '');
ok('   ...every activity entry is by a demo person', S.DEMO_ACTIVITY.every(a => /^Demo Staff [A-L]$/.test(a.user)), '');
const sum = S.summary();
check('the summary the Overview shows', [sum.total, sum.active, sum.inactive, sum.accounts, sum.accountsActive, sum.accountsInactive],
  [12, 10, 2, 10, 9, 1]);
ok('   ...the role breakdown adds up to every staff member', sum.byRole.reduce((t, r) => t + r.n, 0) === 12 && sum.byRole.every(r => r.n > 0), JSON.stringify(sum.byRole));
check('filter: by role', S.filterStaff(S.DEMO_STAFF, { role: 'Mechanic' }).length, 5);
check('filter: by status', S.filterStaff(S.DEMO_STAFF, { status: 'Inactive' }).map(s => s.id), ['DEMO-005', 'DEMO-012']);
check('filter: search is case-insensitive over ID, name, designation, email and department',
  [S.filterStaff(S.DEMO_STAFF, { q: 'demo-008' }).length, S.filterStaff(S.DEMO_STAFF, { q: 'FRONT DESK' }).length, S.filterStaff(S.DEMO_STAFF, { q: 'nobody' }).length], [1, 2, 0]);
check('filter: filters combine', S.filterStaff(S.DEMO_STAFF, { role: 'Mechanic', department: 'Workshop', status: 'Active' }).length, 4);
check('paging: 12 rows by 8', [S.paginate(S.DEMO_STAFF, 1, 8), S.paginate(S.DEMO_STAFF, 2, 8)].map(p => [p.rows.length, p.from, p.to, p.pages]), [[8, 1, 8, 2], [4, 9, 12, 2]]);
check('paging: out-of-range pages are clamped, an empty list is one empty page',
  [S.paginate(S.DEMO_STAFF, 9, 8).page, S.paginate(S.DEMO_STAFF, 0, 8).page, S.paginate([], 1, 8).from, S.paginate([], 1, 8).pages], [2, 1, 0, 1]);
check('activity: the date range is inclusive at both ends',
  S.filterActivity(S.DEMO_ACTIVITY, { from: '2026-10-17', to: '2026-10-17' }).length, 4);
check('activity: user and action filters', [S.filterActivity(S.DEMO_ACTIVITY, { action: 'Sign in' }).length, S.filterActivity(S.DEMO_ACTIVITY, { user: 'Demo Staff H' }).length], [4, 3]);
check('dates read as day, month, year', S.fmtDay('2024-01-08'), '08 Jan 2024');
check('five example roles', S.ROLES.map(r => r.name), ['Admin', 'Manager', 'Service Advisor', 'Mechanic', 'Accountant']);
ok('   ...each lists all eleven modules with only V, C, E and D',
  S.MODULES.length === 11 && S.ROLES.every(r => S.MODULES.every(m => typeof r.perms[m] === 'string' && /^V?C?E?D?$/.test(r.perms[m]))), '');
ok('   ...following the recorded decisions (no counter payments for advisors, no money for mechanics, no staff data for accountants)',
  !S.ROLES[2].perms.Payments.includes('C') && S.ROLES[3].perms.Payments === '' && S.ROLES[3].perms.Invoices === ''
    && S.ROLES[4].perms['Staff Management'] === '', '');

// Attendance (demo week)
const activeIds = S.DEMO_STAFF.filter(s => s.status === 'Active').map(s => s.id).sort();
check('the attendance week runs Saturday to Friday', S.DEMO_DAYS.map(S.weekday), ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
check('   ...covers every active demo staff member and no inactive one', Object.keys(S.DEMO_WEEK).sort(), activeIds);
ok('   ...with one valid code per day', Object.values(S.DEMO_WEEK).every(w => /^[PLDAVH]{7}$/.test(w)), '');
check('   ...the six statuses, in order', S.ATTENDANCE_STATUSES, ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday']);
ok('   ...all six appear somewhere in the week',
  S.ATTENDANCE_STATUSES.every(st => S.DEMO_DAYS.some(d => S.attendanceFor(d).some(r => r.status === st))), '');
check('the default day (Wednesday) shows every status but Holiday',
  S.attendanceSummary(S.attendanceFor('2026-10-14')).map(x => [x.status, x.n]),
  [['Present', 6], ['Late', 1], ['Half-day', 1], ['Absent', 1], ['On Leave', 1], ['Holiday', 0]]);
check('Friday is a holiday for everyone', S.attendanceSummary(S.attendanceFor('2026-10-16')).find(x => x.status === 'Holiday').n, 10);
const wed = Object.fromEntries(S.attendanceFor('2026-10-14').map(r => [r.staff.id, r]));
check('times: late, half-day and present rows have times; absent and leave rows do not',
  [[wed['DEMO-001'].checkIn, wed['DEMO-001'].checkOut, wed['DEMO-001'].minutes], [wed['DEMO-003'].checkIn, wed['DEMO-003'].checkOut, wed['DEMO-003'].minutes],
    [wed['DEMO-010'].checkIn, wed['DEMO-010'].minutes], [wed['DEMO-007'].checkIn, wed['DEMO-007'].minutes], [wed['DEMO-002'].checkIn, wed['DEMO-002'].checkOut]],
  [['09:40', '18:10', 510], ['09:00', '13:30', 270], [null, 0], [null, 0], ['09:00', '18:10']]);
check('an unknown day has no rows', S.attendanceFor('2026-01-01').length, 0);
const wedRows = S.attendanceFor('2026-10-14');
check('attendance filters: status, department, search, combined',
  [S.filterAttendance(wedRows, { status: 'Late' }).length, S.filterAttendance(wedRows, { department: 'Front Desk' }).length,
    S.filterAttendance(wedRows, { q: 'DEMO-011' }).length, S.filterAttendance(wedRows, { status: 'Present', department: 'Workshop' }).length],
  [1, 2, 1, 3]);
check('durations read as hours and minutes', [S.fmtDuration(545), S.fmtDuration(270)], ['9h 05m', '4h 30m']);

// Leave Management
check('ten demo leave requests', S.DEMO_LEAVE.length, 10);
ok('   ...each belongs to a demo staff member and its reason says (demo)',
  S.DEMO_LEAVE.every(l => S.DEMO_STAFF.some(s => s.id === l.staffId) && /\(demo\)\.$/.test(l.reason) && /^LV-DEMO-\d{3}$/.test(l.id)), '');
check('   ...the four leave types and three statuses', [S.LEAVE_TYPES, S.LEAVE_STATUSES], [['Casual', 'Sick', 'Annual', 'Unpaid'], ['Pending', 'Approved', 'Rejected']]);
ok('   ...every type and every status appears',
  S.LEAVE_TYPES.every(t => S.DEMO_LEAVE.some(l => l.type === t)) && S.LEAVE_STATUSES.every(st => S.DEMO_LEAVE.some(l => l.status === st)), '');
ok('   ...only decided requests carry a decision, made by a demo person',
  S.DEMO_LEAVE.every(l => (l.status === 'Pending') === (l.decidedBy === null && l.note === null)
    && (l.decidedBy === null || /^Demo Staff [A-L]$/.test(l.decidedBy))), '');
ok('   ...no request ends before it starts', S.DEMO_LEAVE.every(l => l.from <= l.to), '');
const ls = S.leaveSummary();
check('the leave summary: by status, by type, approved days',
  [ls.byStatus.map(b => b.n), ls.byType.map(b => b.n), ls.approvedDays], [[4, 4, 2], [3, 2, 3, 2], 12]);
check('leave days include both ends, across a month end too',
  [S.leaveDays('2026-10-13', '2026-10-15'), S.leaveDays('2026-10-27', '2026-10-27'), S.leaveDays('2026-10-31', '2026-11-02')], [3, 1, 3]);
check('leave filters: type, status, search, combined',
  [S.filterLeave(S.DEMO_LEAVE, { type: 'Sick' }).length, S.filterLeave(S.DEMO_LEAVE, { status: 'Pending' }).length,
    S.filterLeave(S.DEMO_LEAVE, { q: 'lv-demo-006' }).length, S.filterLeave(S.DEMO_LEAVE, { type: 'Annual', status: 'Approved' }).length],
  [2, 4, 1, 1]);
const casual = S.DEMO_LEAVE.find(l => l.staffId === 'DEMO-007');
ok('the approved casual leave is the On Leave in the attendance week',
  casual.status === 'Approved' && S.DEMO_DAYS.filter(d => S.attendanceFor(d).find(r => r.staff.id === 'DEMO-007').status === 'On Leave').join() === '2026-10-13,2026-10-14,2026-10-15'
    && casual.from === '2026-10-13' && casual.to === '2026-10-15', '');

// Performance (sample figures)
check('sample performance for five workshop staff', S.DEMO_PERFORMANCE.map(p => p.staffId), ['DEMO-001', 'DEMO-002', 'DEMO-003', 'DEMO-004', 'DEMO-011']);
ok('   ...each figure is consistent (on time within jobs, positive turnaround and labour)',
  S.DEMO_PERFORMANCE.every(p => p.onTime <= p.jobs && p.jobs > 0 && p.turnaround > 0 && p.labour > 0), '');
ok('   ...the period is labelled as demo', /\(demo\)$/.test(S.PERFORMANCE_PERIOD), '');
const ps = S.performanceSummary();
check('the workshop totals', [ps.jobs, ps.onTime, ps.onTimePct, ps.turnaround, ps.labour], [156, 136, 87, 6, 291600]);
const pr = S.performanceRows();
check('sorting: best first by each measure', ['jobs', 'onTime', 'turnaround', 'labour'].map(k => S.sortPerformance(pr, k)[0].staffId),
  ['DEMO-001', 'DEMO-011', 'DEMO-011', 'DEMO-001']);
check('   ...on-time percentages per person', pr.map(r => r.onTimePct), [91, 82, 91, 81, 92]);
check('an empty period sums to zero', Object.values(S.performanceSummary([])), [0, 0, 0, 0, 0]);
check('amounts read as taka', S.taka(291600), '৳ 2,91,600');

/* ---------- 6. the stylesheet ---------- */
console.log('\n-- 6. css/staff.css --');
const css = read('css/staff.css').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean)
  // Split selector lists on top-level commas only: :is(a, b) is one selector.
  .flatMap(r => r.split('{')[0].split(/,(?![^(]*\))/).map(s => s.trim())).filter(Boolean);
const loose = selectors.filter(sel => !sel.startsWith('[data-page^="staff-"]'));
check('every rule is scoped to the Staff pages', loose, []);
const shared = read('css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const navStaffRules = shared.split('}').map(x => x.trim()).filter(x => x.includes('#navStaff')).flatMap(x => x.split('{')[0].split(/,(?![^(]*\))/).map(y => y.trim()));
ok('the Staff menu styling lives in the shared stylesheet (the sidebar is on every page), every rule scoped to #navStaff',
  navStaffRules.length >= 10 && navStaffRules.every(sel => sel.startsWith('#navStaff')), JSON.stringify(navStaffRules.filter(sel => !sel.startsWith('#navStaff'))));
ok('   ...and css/staff.css no longer restyles the menu on Staff pages only', !css.includes('#navStaff'), '');
ok('   ...and only the nine Staff pages load it',
  fs.readdirSync(path.join(ROOT, 'pages')).filter(f => read(`pages/${f}`).includes('../css/staff.css')).sort().join('|')
    === ENTRIES.map(([k]) => `${k}.html`).sort().join('|'), '');

summary('staff-management-ui');
