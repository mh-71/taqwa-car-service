/* staff-management-ui — Staff Management: the sidebar group and its six
   UI-preview pages.

   What must hold:
     1. The sidebar has a "Staff Management" group right after Mechanics and
        before Inventory, with six entries that link to real pages, mark the
        current one as active and open the group on a Staff page. It is no
        longer a top-level link, and every other link keeps its order.
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
        filters and paging the pages show are computed from it correctly.
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
  ['staff-activity-log', 'Activity Log', 'pages/staff-activity-log.html', 'Activity Log'],
];

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
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Services', 'Mechanics',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Reports', 'Settings']);
  const block = staffBlock(html);
  ok('the sidebar has a Staff Management group', /<summary class="nav__summary"><svg[^>]*><path d="M[^"]+"\/><\/svg><span>Staff Management<\/span>/.test(block), block.slice(0, 200));
  const iMec = html.indexOf('href="pages/mechanics.html"'), iGrp = html.indexOf('id="navStaff"'), iInv = html.indexOf('href="pages/inventory.html"');
  ok('   ...placed right after Mechanics and before Inventory', iMec > -1 && iMec < iGrp && iGrp < iInv
    && !/<a class="nav__link/.test(html.slice(iMec + 1, iGrp).replace(/^[^>]*>/, '')), JSON.stringify({ iMec, iGrp, iInv }));
  const links = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  check('   ...with the six entries, in order', links, ENTRIES.map(([, label, href]) => [href, label]));
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

/* ---------- 4. the page script ---------- */
console.log('\n-- 4. js/staff-ui.js --');
const src = read('js/staff-ui.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
check('it never reaches the database, browser storage or the network',
  ['fetch(', 'XMLHttpRequest', 'Api.', 'Storage.', 'localStorage', 'sessionStorage', 'sendBeacon', 'WebSocket', 'FileReader', 'indexedDB']
    .filter(t => code.includes(t)), []);
check('it never writes HTML', ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'].filter(t => code.includes(t)), []);
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

/* ---------- 6. the stylesheet ---------- */
console.log('\n-- 6. css/staff.css --');
const css = read('css/staff.css').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean)
  // Split selector lists on top-level commas only: :is(a, b) is one selector.
  .flatMap(r => r.split('{')[0].split(/,(?![^(]*\))/).map(s => s.trim())).filter(Boolean);
const loose = selectors.filter(sel => !sel.startsWith('[data-page^="staff-"]'));
check('every rule is scoped to the Staff pages', loose, []);
ok('   ...and only the six Staff pages load it',
  fs.readdirSync(path.join(ROOT, 'pages')).filter(f => read(`pages/${f}`).includes('../css/staff.css')).sort().join('|')
    === ENTRIES.map(([k]) => `${k}.html`).sort().join('|'), '');

summary('staff-management-ui');
