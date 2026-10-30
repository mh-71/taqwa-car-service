/* notifications-nav — the Notifications Center row in the sidebar.

   What must hold:
     1. The row sits after the Customer CRM group (right after the Workshop Assets group) and before Reports,
        and links to the demo page, which exists.
     2. On the Notifications page it is the active link (amber, aria-current)
        and no other top-level link is; elsewhere it is not active.
     3. The count badge is the fixed design placeholder 3 and says so.

   Drives the REAL js/app.js through the harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const notifyRow = html => (html.match(/<a class="nav__link nav__notify[^"]*" id="navNotify"[^>]*>[\s\S]*?<\/a>/) || [''])[0];

console.log('=== notifications-nav: the Notifications Center link ===\n');

console.log('-- 1. placement and target --');
{
  const html = shellFor('dashboard');
  const row = notifyRow(html);
  ok('the sidebar has one Notifications Center link', row && html.split('id="navNotify"').length - 1 === 1, row.slice(0, 160));
  ok('   ...linking to pages/notifications.html', /href="pages\/notifications\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/notifications.html')), '');
  const iCrm = html.indexOf('id="navCrm"'), iRow = html.indexOf('id="navNotify"'), iRep = html.indexOf('href="pages/reports.html"');
  ok('   ...placed after Customer CRM and before Reports', iCrm > -1 && iCrm < iRow && iRow < iRep, JSON.stringify({ iCrm, iRow, iRep }));
  const iRowStart = html.indexOf('<a class="nav__link nav__notify');
  const iAssets = html.indexOf('id="navAssets"');
  ok('   ...right after the Workshop Assets group, which follows the CRM group',
    iCrm < iAssets && iAssets < iRowStart && html.slice(html.indexOf('</details>', iAssets) + '</details>'.length, iRowStart).trim() === '', '');
  ok('   ...and not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
  ok('   ...no longer a disabled row', !/aria-disabled|not available yet/.test(row), row.slice(0, 160));
}

console.log('\n-- 2. on the Notifications page --');
{
  const html = shellFor('notifications', '../');
  const row = notifyRow(html);
  ok('the link is active and marked as the current page', /^<a class="nav__link nav__notify is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 160));
  ok('   ...with the page-relative address', /href="\.\.\/pages\/notifications\.html"/.test(row), row.slice(0, 160));
  check('   ...and no other top-level link is active', (html.match(/class="nav__link[^"]*is-active/g) || []).length, 1);
  ok('the page itself declares data-page="notifications"',
    fs.readFileSync(path.join(ROOT, 'pages/notifications.html'), 'utf8').includes('<body data-page="notifications" data-root="../">'), '');
}

console.log('\n-- 3. the badge --');
{
  const row = notifyRow(shellFor('dashboard'));
  ok('the count is the fixed placeholder 3', /<span class="nav__count"[^>]*>3<\/span>/.test(row), row.slice(-120));
  ok('   ...and says it is a design placeholder', /<span class="nav__count" title="The count is a design placeholder\.">/.test(row), row.slice(-120));
  ok('nothing in app.js computes it', /const NOTIFY_PLACEHOLDER_COUNT = 3;/.test(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8')), '');
}

process.exit(summary('notifications-nav') === 0 ? 0 : 1);
