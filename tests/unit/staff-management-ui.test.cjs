/* staff-management-ui — the Staff Management menu entry and its placeholder.

   What must hold:
     1. The sidebar has a "Staff Management" link immediately after Mechanics,
        linking to a page that exists, and every other link keeps its order.
     2. On the Staff Management page that link -- and only that link -- is
        active, and the header title reads "Staff Management". On every other
        page it is not active.
     3. The page shares the Settings <head> with only its title changed,
        declares its own page key, and shows the subtitle and an empty state.
     4. It is a placeholder and nothing more: no form, input, button, table,
        inline handler, figure or record, and no page script of its own --
        only the shared shell scripts every page loads.

   Drives the REAL js/app.js through the shared harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Render the shell for one page; return the HTML the shell wrote. */
function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
// Top-level links only: the Social Inbox and Customer CRM groups render their
// entries as nav__sub, and Inbox entries without a page are not links at all.
const topLinks = html => [...html.matchAll(/<a class="nav__link( is-active)?" href="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)]
  .map(m => ({ active: !!m[1], href: m[2], label: m[3] }));

console.log('=== staff-management-ui: Staff Management menu and placeholder ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const links = topLinks(shellFor('dashboard'));
  check('the top-level links, in order, with Staff Management right after Mechanics', links.map(l => l.label),
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Services', 'Mechanics', 'Staff Management',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Reports', 'Settings']);
  const staff = links.find(l => l.label === 'Staff Management') || {};
  check('   ...linking to the Staff Management page', staff.href, 'pages/staff-management.html');
  ok('   ...which exists', fs.existsSync(path.join(ROOT, 'pages/staff-management.html')), '');
  ok('   ...drawn with an icon, like every other link',
    /<a class="nav__link" href="pages\/staff-management.html"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M[^"]+"\/><\/svg><span>Staff Management<\/span><\/a>/
      .test(shellFor('dashboard')), '');
  ok('   ...and not active on the Dashboard', staff.active === false, '');
}

/* ---------- 2. active state and header ---------- */
console.log('\n-- 2. active state --');
{
  const html = shellFor('staff-management', '../');
  const active = topLinks(html).filter(l => l.active);
  check('on Staff Management: exactly one link is active, and it is Staff Management', active.map(l => [l.label, l.href]),
    [['Staff Management', '../pages/staff-management.html']]);
  ok('   ...no Customer CRM entry is active', !/nav__sub is-active|has-active/.test(html), '');
  ok('   ...and the header title reads "Staff Management"', html.includes('<h1>Staff Management</h1>'), '');
}
for (const [page, label] of [['mechanics', 'Mechanics'], ['settings', 'Settings'], ['crm-reports', null]]) {
  const active = topLinks(shellFor(page, '../')).filter(l => l.active).map(l => l.label);
  check(`on ${page}: Staff Management is not active${label ? `, ${label} is` : ''}`, active, label ? [label] : []);
}

/* ---------- 3. the page ---------- */
console.log('\n-- 3. the page --');
const head = s => s.slice(0, s.indexOf('</head>'));
const html = read('pages/staff-management.html');
const body = html.slice(html.indexOf('<body data-page='));
check('<head> is the Settings head with only the title changed', head(html),
  head(read('pages/settings.html')).replace('<title>Settings — ', '<title>Staff Management — '));
ok('declares its own page key', body.startsWith('<body data-page="staff-management" data-root="../">'), body.slice(0, 60));
ok('shows the subtitle', body.includes('<p class="page-subtitle">Manage workshop staff and employee information.</p>'), '');
const empty = (body.match(/<div class="empty">([\s\S]*?)<\/div>/) || [])[1] || '';
ok('shows an empty state with a team icon', /<svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" aria-hidden="true"><path d="M[^"]+"\/><\/svg>/.test(empty), empty.slice(0, 120));
ok('   ...the heading "Staff Management"', /<h3 id="staffSoonTitle">Staff Management<\/h3>/.test(empty)
  && /<section class="card" aria-labelledby="staffSoonTitle">/.test(body), '');
ok('   ...and the future-release description', empty.includes('<p>Staff management features will be available in a future release.</p>'), '');

/* ---------- 4. placeholder only ---------- */
console.log('\n-- 4. placeholder only --');
ok('no form, input, select, textarea, button or table', !/<(form|input|select|textarea|button|table)\b/i.test(body), '');
ok('no inline handler', !/\son[a-z]+=/i.test(html), '');
ok('no link of its own (no Add Staff, no sign-in)', !/<a\b/i.test(body), '');
const visible = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
ok('no figure anywhere in the visible text (no records, no statistics)', !/\d/.test(visible), visible.replace(/\s+/g, ' ').trim());
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
check('only the shared shell scripts, no page module', scripts,
  ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js']);
ok('no inline script in the body', !/<script>/.test(body), '');
ok('keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');

summary('staff-management-ui');
