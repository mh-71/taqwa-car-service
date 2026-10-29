/* inbox-website-forms — Social Inbox › Website Forms (demo page).

   What must hold:
     1. In the sidebar, Website Forms is a link to the demo page, which
        exists, marked Demo, and active (aria-current) only on that page.
     2. All Conversations, Facebook, WhatsApp and Book Now are still links;
        the separate Comments entry stays "Not configured".
     3. The page shows the DEMO MODE banner, the not-connected notice and
        the no-booking notice; its script makes no request, touches neither
        the API, Storage nor browser storage, inserts no HTML and names no
        URL; every contact detail is a placeholder.
     4. Search (name, service, vehicle, reference), every status filter,
        opening, mark as read, assignment, status and demo notes work in
        memory, and a fresh copy restores the samples.

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

console.log('=== inbox-website-forms: the Website Forms demo page ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'Website Forms');
  ok('Website Forms is a link to pages/inbox-website-forms.html', /^<a class="nav__sub" href="pages\/inbox-website-forms\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-website-forms.html')), '');
  ok('   ...labelled Demo', /<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-website-forms', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'Website Forms');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...with the page-relative address', /href="\.\.\/pages\/inbox-website-forms\.html"/.test(row), row.slice(0, 160));
  ok('   ...the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  ok('   ...and the header says Website Forms Inbox', /<h1>Website Forms Inbox<\/h1>/.test(html), '');
}

console.log('\n-- 2. the other entries --');
{
  const group = inboxGroup(shellFor('dashboard'));
  for (const [label, href] of [['All Conversations', 'inbox-conversations'], ['Facebook', 'inbox-facebook'], ['WhatsApp', 'inbox-whatsapp'], ['Book Now', 'appointments']]) {
    ok(`${label} still links to pages/${href}.html`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(subFor(group, label)), subFor(group, label).slice(0, 120));
  }
  const row = subFor(group, 'Comments');
  ok('the separate Comments entry is still "Not configured"', /^<span class="nav__sub nav__sub--off" aria-disabled="true"/.test(row) && /Not configured/.test(row), row.slice(0, 120));
}

console.log('\n-- 3. demo only --');
const page = fs.readFileSync(path.join(ROOT, 'pages/inbox-website-forms.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-website-forms.js'), 'utf8');
{
  ok('the page declares data-page="inbox-website-forms"', page.includes('<body data-page="inbox-website-forms" data-root="../">'), '');
  ok('the page shows "DEMO MODE — No real website submissions are processed."', page.includes('DEMO MODE — No real website submissions are processed.'), '');
  ok('the page shows "Demo only — not connected to live forms."', page.includes('Demo only — not connected to live forms.'), '');
  ok('the page says no booking has been created', page.includes('Sample submission — no booking has been created.'), '');
  ok('the page loads its script and stylesheet', page.includes('../js/inbox-website-forms.js') && page.includes('../css/inbox-website-forms.css'), '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [what, re] of [
    ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket/EventSource', /WebSocket|EventSource/],
    ['sendBeacon', /sendBeacon/], ['Api.', /\bApi\./], ['Storage.', /\bStorage\./],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/],
    ['innerHTML', /innerHTML|insertAdjacentHTML|outerHTML|document\.write/], ['eval', /\beval\s*\(|new Function/],
    ['a URL other than the SVG namespace', /https?:\/\/(?!www\.w3\.org\/2000\/svg)/],
    ['form, email or webhook service', /formspree|mailto:|sendgrid|webhook|hooks\./i],
  ]) ok(`the script uses no ${what}`, !re.test(code), '');
  // Icon path data (d="...") is all digits and spaces, so it is left out of this check.
  const digits = (page.replace(/ d="[^"]*"/g, '') + code).match(/\+?\d[\d\s-]{8,}\d/g) || [];
  check('no phone-number-like text in the page or script', digits.join(), '');
  const emails = (page + code).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
  ok('the only email address is the .invalid placeholder', emails.every(e => e === 'customer@example.invalid'), emails.join());
}

console.log('\n-- 4. demo behaviour --');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.W = InboxWebsiteForms;`, ctx);
  const { SAMPLE, SERVICES, PHONE, EMAIL, NOTE_LABEL, filterSubmissions: f, addDemoNote, freshCopy } = ctx.W;
  check('the phone placeholder', PHONE, '+880 1X-XXX-XXXX');
  check('the email placeholder', EMAIL, 'customer@example.invalid');
  ok('every sample name is marked (Demo)', SAMPLE.length >= 6 && SAMPLE.every(s => / \(Demo\)$/.test(s.name)), '');
  ok('every reference is DEMO-FORM-nnn and every registration DEMO-REG-nnn', SAMPLE.every(s => /^DEMO-FORM-\d{3}$/.test(s.id) && /^DEMO-REG-\d{3}$/.test(s.reg)), '');
  ok('every model is marked (sample)', SAMPLE.every(s => /\(sample\)$/.test(s.model)), '');
  ok('every requested service is one of the five demo services', SAMPLE.every(s => SERVICES.includes(s.service)), '');
  ok('all five services appear', SERVICES.every(v => SAMPLE.some(s => s.service === v)), '');
  check('All shows every submission', f(SAMPLE, 'all', '').length, SAMPLE.length);
  check('Unread', f(SAMPLE, 'unread', '').length > 0 && f(SAMPLE, 'unread', '').every(s => s.unread), true);
  for (const st of ['Open', 'Pending', 'Resolved']) check(st, f(SAMPLE, st, '').length > 0 && f(SAMPLE, st, '').every(s => s.status === st), true);
  check('search by customer name (any case)', f(SAMPLE, 'all', 'TASLIMA').map(s => s.id).join(), 'DEMO-FORM-005');
  check('search by service', f(SAMPLE, 'all', 'lpg/cng').map(s => s.id).join(), 'DEMO-FORM-006');
  check('search by vehicle', f(SAMPLE, 'all', 'toyota aqua').map(s => s.id).join(), 'DEMO-FORM-007');
  check('search by registration', f(SAMPLE, 'all', 'demo-reg-003').map(s => s.id).join(), 'DEMO-FORM-003');
  check('search by submission reference', f(SAMPLE, 'all', 'DEMO-FORM-001').map(s => s.id).join(), 'DEMO-FORM-001');
  check('filter and search together', f(SAMPLE, 'Resolved', 'hybrid').length, 0);

  const items = freshCopy();
  const sub = items.find(s => s.id === 'DEMO-FORM-008');
  ok('opening is a lookup by reference', !!sub && sub.name === 'Rafiq Islam (Demo)', '');
  sub.unread = false;
  check('mark as read changes the copy', sub.unread, false);
  sub.assignee = 'Demo Advisor B'; sub.status = 'Pending';
  check('assignment and status change the copy', [sub.assignee, sub.status].join(), 'Demo Advisor B,Pending');
  check('a blank note is refused', addDemoNote(sub, '   '), null);
  const n = addDemoNote(sub, '  Call back after 5 PM.  ');
  ok('a demo note is trimmed, attributed and marked demo', n && n.text === 'Call back after 5 PM.' && n.by === 'Demo Advisor B' && n.demo === true, JSON.stringify(n));
  check('demo notes are labelled unsaved', NOTE_LABEL, 'Demo note — not saved, not sent');
  check('a note is capped at 500 characters', addDemoNote(sub, 'x'.repeat(800)).text.length, 500);
  const orig = SAMPLE.find(s => s.id === 'DEMO-FORM-008');
  ok('the samples themselves are untouched', orig.unread === true && orig.status === 'Open' && orig.assignee === 'Unassigned' && orig.notes.length === 0, '');
  const again = freshCopy().find(s => s.id === 'DEMO-FORM-008');
  ok('a fresh copy (a reload) restores them', again.unread === true && again.notes.length === 0 && again.status === 'Open', '');
}

process.exit(summary('inbox-website-forms') === 0 ? 0 : 1);
