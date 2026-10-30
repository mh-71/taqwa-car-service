/* workshop-tools-nav — the Workshop Assets group in the sidebar.

   What must hold:
     1. "Workshop Assets" is an expandable group (like Customer CRM) placed
        right after the Customer CRM group and right before Notifications
        Center. It holds exactly six entries in order: Tools & Equipment,
        a link to the existing demo page at its unchanged address, then five
        "Coming soon" entries that are plain text, never links.
     2. There is no top-level "Workshop Tools" link any more.
     3. On the Tools & Equipment page that entry is active, the group is open
        and marked, the header keeps its title, and no top-level link is
        active; elsewhere the group starts closed and nothing in it is active.

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
const assetsGroup = html => (html.match(/<details class="nav__group[^"]*" id="navAssets"[\s\S]*?<\/details>/) || [''])[0];
const entriesOf = group => group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1);
const LABELS = ['Tools & Equipment', 'Equipment Inventory', 'Maintenance & Repairs', 'Asset Assignment', 'Asset History', 'Asset Reports'];

console.log('=== workshop-tools-nav: the Workshop Assets group ===\n');

console.log('-- 1. the group and its entries --');
{
  const html = shellFor('dashboard');
  const group = assetsGroup(html);
  ok('the sidebar has a "Workshop Assets" group', /<summary class="nav__summary">[\s\S]*?<span>Workshop Assets<\/span>/.test(group), group.slice(0, 200));
  check('   ...exactly once', html.split('id="navAssets"').length - 1, 1);
  ok('   ...that starts closed on another page', /^<details class="nav__group" id="navAssets">/.test(group), group.slice(0, 80));
  const iCrm = html.indexOf('id="navCrm"'), iAssets = html.indexOf('id="navAssets"'), iNotify = html.indexOf('id="navNotify"');
  ok('   ...after the Customer CRM group and before Notifications Center', iCrm > -1 && iCrm < iAssets && iAssets < iNotify, JSON.stringify({ iCrm, iAssets, iNotify }));
  ok('   ...directly after the CRM group', !/<a |<details /.test(html.slice(html.indexOf('</details>', iCrm) + '</details>'.length, html.lastIndexOf('<details', iAssets))), '');
  ok('   ...and directly before Notifications Center', html.slice(html.indexOf('</details>', iAssets) + '</details>'.length, html.lastIndexOf('<a ', iNotify)).trim() === '', '');

  const entries = entriesOf(group);
  check('it holds exactly six entries', entries.length, 6);
  check('   ...in order', entries.map(e => (e.match(/<span>([^<]+)<\/span>/) || [])[1]).map(l => l && l.replace('&amp;', '&')), LABELS);
  ok('Tools & Equipment links to pages/workshop-tools.html (unchanged)', /^<a class="nav__sub" href="pages\/workshop-tools\.html">/.test(entries[0] || ''), (entries[0] || '').slice(0, 120));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/workshop-tools.html')), '');
  check('   ...and it is the only link in the group', (group.match(/<a /g) || []).length, 1);
  for (const e of entries.slice(1)) {
    const label = (e.match(/<span>([^<]+)<\/span>/) || [])[1];
    ok(`${label} is "Coming soon", plain text and not a link`,
      /^<span class="nav__sub nav__sub--off" aria-disabled="true"/.test(e) && /<small>Coming soon<\/small>/.test(e) && !/href=/.test(e), e.slice(0, 140));
  }
  ok('every entry has a stroke (Lucide-style) icon', entries.every(e => /<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"/.test(e)), '');
}

console.log('\n-- 2. the old top-level link is gone --');
{
  const html = shellFor('dashboard');
  ok('there is no top-level "Workshop Tools" link', !/<a class="nav__link[^"]*" href="pages\/workshop-tools\.html"/.test(html) && !/<span>Workshop Tools<\/span>/.test(html), '');
  check('workshop-tools.html is linked exactly once in the sidebar', html.split('href="pages/workshop-tools.html"').length - 1, 1);
}

console.log('\n-- 3. on the Tools & Equipment page --');
{
  const html = shellFor('workshop-tools', '../');
  const group = assetsGroup(html);
  ok('the group is open and marked as holding the current page', /^<details class="nav__group has-active" id="navAssets" open>/.test(group), group.slice(0, 80));
  ok('Tools & Equipment is active and the current page', /<a class="nav__sub is-active" href="\.\.\/pages\/workshop-tools\.html" aria-current="page">/.test(group), '');
  check('   ...the only active entry in the sidebar', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  check('no top-level link is active', (html.match(/class="nav__link[^"]*is-active/g) || []).length, 0);
  ok('the header shows the page title', /<h1>Workshop Tools &(amp;)? Equipment<\/h1>/.test(html), (html.match(/<h1>[^<]*<\/h1>/) || [''])[0]);
  ok('the page itself declares data-page="workshop-tools"',
    fs.readFileSync(path.join(ROOT, 'pages/workshop-tools.html'), 'utf8').includes('<body data-page="workshop-tools" data-root="../">'), '');
}

process.exit(summary('workshop-tools-nav') === 0 ? 0 : 1);
