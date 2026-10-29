/* inbox-whatsapp — Social Inbox › WhatsApp (demo page).

   What must hold:
     1. In the sidebar, WhatsApp is a link to the demo page, which exists,
        marked Demo, and active (aria-current) only on that page.
     2. All Conversations and Book Now are still links; Facebook, Website
        Forms and Comments stay "Not configured".
     3. The page shows the DEMO MODE banner and "Not connected"; its script
        makes no request, touches neither the API, Storage nor browser
        storage, and shows only placeholder phone numbers.
     4. Search, filters, Demo Send, assignment and status work in memory,
        and a fresh copy restores the samples.

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

console.log('=== inbox-whatsapp: the WhatsApp demo page ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'WhatsApp');
  ok('WhatsApp is a link to pages/inbox-whatsapp.html', /^<a class="nav__sub" href="pages\/inbox-whatsapp\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-whatsapp.html')), '');
  ok('   ...labelled Demo', /<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-whatsapp', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'WhatsApp');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...with the page-relative address', /href="\.\.\/pages\/inbox-whatsapp\.html"/.test(row), row.slice(0, 160));
  ok('   ...the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  ok('   ...and the header says WhatsApp Inbox', /<h1>WhatsApp Inbox<\/h1>/.test(html), '');
}

console.log('\n-- 2. the other entries --');
{
  const group = inboxGroup(shellFor('dashboard'));
  ok('All Conversations still links to its page', /^<a class="nav__sub" href="pages\/inbox-conversations\.html"/.test(subFor(group, 'All Conversations')), '');
  ok('Book Now still links to Appointments', /^<a class="nav__sub" href="pages\/appointments\.html"/.test(subFor(group, 'Book Now')), '');
  for (const label of ['Facebook', 'Website Forms', 'Comments']) {
    const row = subFor(group, label);
    ok(`${label} is still "Not configured"`, /^<span class="nav__sub nav__sub--off" aria-disabled="true"/.test(row) && /Not configured/.test(row), row.slice(0, 120));
  }
}

console.log('\n-- 3. demo only --');
const page = fs.readFileSync(path.join(ROOT, 'pages/inbox-whatsapp.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-whatsapp.js'), 'utf8');
{
  ok('the page declares data-page="inbox-whatsapp"', page.includes('<body data-page="inbox-whatsapp" data-root="../">'), '');
  ok('the page shows "DEMO MODE — No real WhatsApp messages are sent"', page.includes('DEMO MODE — No real WhatsApp messages are sent'), '');
  ok('the page says Not connected', page.includes('Not connected'), '');
  ok('the page loads its script and stylesheet', page.includes('../js/inbox-whatsapp.js') && page.includes('../css/inbox-whatsapp.css'), '');
  ok('demo replies are labelled "Demo only — not sent"', src.includes("'Demo only — not sent'"), '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [what, re] of [
    ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket/EventSource', /WebSocket|EventSource/],
    ['sendBeacon', /sendBeacon/], ['Api.', /\bApi\./], ['Storage.', /\bStorage\./],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/],
    ['innerHTML', /innerHTML|insertAdjacentHTML|outerHTML/], ['a URL other than the SVG namespace', /https?:\/\/(?!www\.w3\.org\/2000\/svg)/],
  ]) ok(`the script uses no ${what}`, !re.test(code), '');
  // Icon path data (d="...") is all digits and spaces, so it is left out of this check.
  const digits = (page.replace(/ d="[^"]*"/g, '') + code).match(/\+?\d[\d\s-]{8,}\d/g) || [];
  check('no real-looking phone number in the page or script', digits.join(), '');
}

console.log('\n-- 4. demo behaviour --');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.W = InboxWhatsApp;`, ctx);
  const { SAMPLE, PHONE, filterChats: f, sendDemo, freshCopy } = ctx.W;
  check('the phone placeholder', PHONE, '+880 1X-XXX-XXXX');
  ok('every sample name is marked (Demo)', SAMPLE.length >= 6 && SAMPLE.every(c => / \(Demo\)$/.test(c.name)), '');
  ok('every vehicle is marked (sample)', SAMPLE.every(c => /\(sample\)$/.test(c.vehicle)), '');
  check('All shows every chat', f(SAMPLE, 'all', '').length, SAMPLE.length);
  check('Unread', f(SAMPLE, 'unread', '').every(c => c.unread > 0) && f(SAMPLE, 'unread', '').length > 0, true);
  for (const s of ['Open', 'Pending', 'Resolved']) check(`${s}`, f(SAMPLE, s, '').length > 0 && f(SAMPLE, s, '').every(c => c.status === s), true);
  check('search by name (any case)', f(SAMPLE, 'all', 'SHIRIN').map(c => c.id).join(), 'w5');
  check('search by message text', f(SAMPLE, 'all', 'warm air').map(c => c.id).join(), 'w5');
  check('filter and search together', f(SAMPLE, 'Resolved', 'warm air').length, 0);

  const items = freshCopy();
  const chat = items.find(c => c.id === 'w1');
  check('a blank Demo Send is refused', sendDemo(chat, '   '), null);
  sendDemo(chat, '  We can see you at 10 AM.  ');
  const last = chat.messages[chat.messages.length - 1];
  ok('Demo Send adds a staff reply marked demo', last.text === 'We can see you at 10 AM.' && last.from === 'staff' && last.demo === true, JSON.stringify(last));
  check('   ...and clears the unread count', chat.unread, 0);
  chat.assignee = 'Demo Advisor B'; chat.status = 'Resolved';
  check('assignment and status change the copy', [chat.assignee, chat.status].join(), 'Demo Advisor B,Resolved');
  const orig = SAMPLE.find(c => c.id === 'w1');
  ok('the samples themselves are untouched', orig.messages.length === 2 && orig.unread === 2 && orig.status === 'Open' && orig.assignee === 'Unassigned', '');
  check('a fresh copy (a reload) restores them', freshCopy().find(c => c.id === 'w1').messages.length, 2);
}

process.exit(summary('inbox-whatsapp') === 0 ? 0 : 1);
