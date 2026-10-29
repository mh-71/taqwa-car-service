/* inbox-nav — Social Inbox › All Conversations (demo page).

   What must hold:
     1. In the sidebar, All Conversations is a link to the demo page, which
        exists; it is active (aria-current) only on that page, and the
        Social Inbox group is open there.
     2. Facebook, WhatsApp, Website Forms and Comments stay "Not configured"
        and Book Now still links to Appointments.
     3. The page says it is Demo Mode and nothing is sent; its script makes
        no request and touches neither the API, Storage nor browser storage.
     4. The demo filters and reply helper behave, and every sample name is
        marked (Demo).

   Drives the REAL js/app.js through the harness. */
const fs = require('fs'), path = require('path'), vm = require('vm');
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
const inboxGroup = html => (html.match(/<details class="nav__inbox"[\s\S]*?<\/details>/) || [''])[0];
// One sidebar entry per piece: each starts at its own <a|span class="nav__sub ...">.
const subFor = (group, label) => group.split(/(?=<(?:a|span) class="nav__sub[ "])/).find(p => p.includes(`<span>${label}</span>`)) || '';

console.log('=== inbox-nav: All Conversations ===\n');

console.log('-- 1. the link --');
{
  const group = inboxGroup(shellFor('dashboard'));
  const row = subFor(group, 'All Conversations');
  ok('All Conversations is a link to pages/inbox-conversations.html', /^<a class="nav__sub" href="pages\/inbox-conversations\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-conversations.html')), '');
  ok('   ...labelled Demo', /<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const group = inboxGroup(shellFor('inbox-conversations', '../'));
  const row = subFor(group, 'All Conversations');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...with the page-relative address', /href="\.\.\/pages\/inbox-conversations\.html"/.test(row), row.slice(0, 160));
  ok('   ...and the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (shellFor('inbox-conversations', '../').match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
}

console.log('\n-- 2. the other entries are unchanged --');
{
  const group = inboxGroup(shellFor('dashboard'));
  for (const label of ['Facebook', 'WhatsApp', 'Website Forms', 'Comments']) {
    const row = subFor(group, label);
    ok(`${label} is still "Not configured" and not a link`, /^<span class="nav__sub nav__sub--off" aria-disabled="true"/.test(row) && /Not configured/.test(row), row.slice(0, 120));
  }
  ok('Book Now still links to Appointments', /^<a class="nav__sub" href="pages\/appointments\.html"/.test(subFor(group, 'Book Now')), '');
}

console.log('\n-- 3. demo only --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-conversations.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-conversations.js'), 'utf8');
{
  ok('the page declares data-page="inbox-conversations"', html.includes('<body data-page="inbox-conversations" data-root="../">'), '');
  ok('the page shows "Demo Mode — sample data, nothing is sent."', html.includes('Demo Mode — sample data, nothing is sent.'), '');
  ok('the page loads its script and stylesheet', html.includes('../js/inbox-conversations.js') && html.includes('../css/inbox-conversations.css'), '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [what, re] of [
    ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket', /WebSocket|EventSource/],
    ['sendBeacon', /sendBeacon/], ['Api.', /\bApi\./], ['Storage.', /\bStorage\./],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/],
    ['innerHTML', /innerHTML|insertAdjacentHTML|outerHTML/],
  ]) ok(`the script uses no ${what}`, !re.test(code), '');
}

console.log('\n-- 4. demo behaviour --');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.IC = InboxConversations;`, ctx);
  const { SAMPLE, filterConversations: f, makeReply } = ctx.IC;
  ok('every sample name is marked (Demo)', SAMPLE.length >= 6 && SAMPLE.every(c => / \(Demo\)$/.test(c.name)), '');
  ok('every channel has samples', ['facebook', 'whatsapp', 'website'].every(ch => SAMPLE.some(c => c.channel === ch)), '');
  check('All shows every conversation', f(SAMPLE, 'all', 'all', '').length, SAMPLE.length);
  check('the WhatsApp filter', f(SAMPLE, 'whatsapp', 'all', '').every(c => c.channel === 'whatsapp'), true);
  check('the Unread filter', f(SAMPLE, 'all', 'unread', '').every(c => c.unread > 0), true);
  check('the Resolved filter', f(SAMPLE, 'all', 'Resolved', '').every(c => c.status === 'Resolved'), true);
  check('search by name (any case)', f(SAMPLE, 'all', 'all', 'NUSRAT').map(c => c.id).join(), 'c2');
  check('search by message text', f(SAMPLE, 'all', 'all', 'hybrid battery').map(c => c.id).join(), 'c8');
  check('a search that matches nothing', f(SAMPLE, 'facebook', 'all', 'AC servicing').length, 0);
  check('a blank reply is refused', makeReply('   ', 'Unassigned'), null);
  const r = makeReply('  Hello  ', 'Demo Advisor A');
  ok('a reply is trimmed, from staff and marked demo', r && r.text === 'Hello' && r.from === 'staff' && r.demo === true && r.by === 'Demo Advisor A', JSON.stringify(r));
  check('a reply is capped at 1000 characters', makeReply('x'.repeat(1500)).text.length, 1000);
}

process.exit(summary('inbox-nav') === 0 ? 0 : 1);
