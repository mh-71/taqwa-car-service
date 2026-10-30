/* inbox-facebook — Social Inbox › Facebook (demo page).

   What must hold:
     1. In the sidebar, Facebook is a link to the demo page, which exists,
        marked Demo, and active (aria-current) only on that page.
     2. The Social Inbox holds exactly All Conversations, Facebook, WhatsApp
        and Website Forms; Book Now and Comments are gone from it, and the
        main Appointments link is untouched.
     3. The page shows the DEMO MODE banner and "Not connected (demo)"; its
        script makes no request, touches neither the API, Storage nor
        browser storage, inserts no HTML and names no URL or token.
     4. Messenger threads and page comments are separate types; search,
        type and status filters, demo replies, assignment and status work
        in memory, and a fresh copy restores the samples.

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

console.log('=== inbox-facebook: the Facebook demo page ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'Facebook');
  ok('Facebook is a link to pages/inbox-facebook.html', /^<a class="nav__sub" href="pages\/inbox-facebook\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-facebook.html')), '');
  ok('   ...labelled Demo', /<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-facebook', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'Facebook');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...with the page-relative address', /href="\.\.\/pages\/inbox-facebook\.html"/.test(row), row.slice(0, 160));
  ok('   ...the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  ok('   ...and the header says Facebook Inbox', /<h1>Facebook Inbox<\/h1>/.test(html), '');
}

console.log('\n-- 2. the Social Inbox entries --');
{
  // The Social Inbox holds exactly these four entries, each a Demo link.
  // Book Now (website bookings live in Appointments) and Comments (Facebook
  // page comments live in the Facebook inbox) are no longer in it.
  const html = shellFor('dashboard');
  const group = inboxGroup(html);
  const entries = group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1);
  check('Social Inbox has exactly four entries', entries.length, 4);
  for (const [label, href] of [['All Conversations', 'inbox-conversations'], ['Facebook', 'inbox-facebook'], ['WhatsApp', 'inbox-whatsapp'], ['Website Forms', 'inbox-website-forms']]) {
    ok(`${label} links to pages/${href}.html`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(subFor(group, label)), subFor(group, label).slice(0, 120));
  }
  ok('Book Now is not in the Social Inbox', !/<span>Book Now<\/span>/.test(group) && !/pages\/appointments\.html/.test(group), '');
  ok('Comments is not in the Social Inbox', !/<span>Comments<\/span>/.test(group), '');
  ok('no Social Inbox entry is shown as not configured', !/nav__sub--off/.test(group), '');
  ok('the main Appointments link is still in the sidebar', /<a class="nav__link[^"]*" href="pages\/appointments\.html">[\s\S]*?<span>Appointments<\/span><\/a>/.test(html), '');
}

console.log('\n-- 3. demo only --');
const page = fs.readFileSync(path.join(ROOT, 'pages/inbox-facebook.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-facebook.js'), 'utf8');
{
  ok('the page declares data-page="inbox-facebook"', page.includes('<body data-page="inbox-facebook" data-root="../">'), '');
  ok('the page shows "DEMO MODE — No real Facebook messages or comments are sent."', page.includes('DEMO MODE — No real Facebook messages or comments are sent.'), '');
  ok('the page says "Not connected (demo)"', page.includes('Not connected (demo)'), '');
  ok('the page loads its script and stylesheet', page.includes('../js/inbox-facebook.js') && page.includes('../css/inbox-facebook.css'), '');
  ok('demo replies are labelled not sent / not posted', src.includes("'Demo only — not sent'") && src.includes("'Demo only — not posted'"), '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [what, re] of [
    ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket/EventSource', /WebSocket|EventSource/],
    ['sendBeacon', /sendBeacon/], ['Api.', /\bApi\./], ['Storage.', /\bStorage\./],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/],
    ['innerHTML', /innerHTML|insertAdjacentHTML|outerHTML|document\.write/], ['eval', /\beval\s*\(|new Function/],
    ['a URL other than the SVG namespace', /https?:\/\/(?!www\.w3\.org\/2000\/svg)/],
    ['Graph API or SDK reference', /graph\.facebook|connect\.facebook|FB\.init|access_token|appsecret/i],
  ]) ok(`the script uses no ${what}`, !re.test(code), '');
  // Icon path data (d="...") is all digits and spaces, so it is left out of this check.
  const digits = (page.replace(/ d="[^"]*"/g, '') + code).match(/\+?\d[\d\s-]{8,}\d/g) || [];
  check('no phone-number-like text in the page or script', digits.join(), '');
}

console.log('\n-- 4. demo behaviour --');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.F = InboxFacebook;`, ctx);
  const { SAMPLE, filterItems: f, replyDemo, freshCopy, NOT_SENT } = ctx.F;
  ok('every sample name is marked (Demo)', SAMPLE.length >= 6 && SAMPLE.every(c => / \(Demo\)$/.test(c.name)), '');
  ok('every vehicle is marked (sample) and every registration DEMO-', SAMPLE.every(c => /\(sample\)$/.test(c.vehicle) && /^DEMO-REG-/.test(c.reg)), '');
  ok('both types are present', SAMPLE.some(c => c.type === 'messenger') && SAMPLE.some(c => c.type === 'comment'), '');
  ok('every comment names a DEMO post; no Messenger thread has one', SAMPLE.every(c => c.type === 'comment' ? /^DEMO-POST-/.test(c.post.ref) : !c.post), '');
  check('All shows everything', f(SAMPLE, 'all', 'all', '').length, SAMPLE.length);
  check('Messenger type', f(SAMPLE, 'messenger', 'all', '').every(c => c.type === 'messenger'), true);
  check('Page comments type', f(SAMPLE, 'comment', 'all', '').map(c => c.id).join(), 'f2,f4,f6');
  check('Unread', f(SAMPLE, 'all', 'unread', '').every(c => c.unread > 0) && f(SAMPLE, 'all', 'unread', '').length > 0, true);
  for (const s of ['Open', 'Pending', 'Resolved']) check(s, f(SAMPLE, 'all', s, '').length > 0 && f(SAMPLE, 'all', s, '').every(c => c.status === s), true);
  check('type and status together', f(SAMPLE, 'comment', 'Pending', '').map(c => c.id).join(), 'f6');
  check('search by name (any case)', f(SAMPLE, 'all', 'all', 'SABBIR').map(c => c.id).join(), 'f5');
  check('search by message text', f(SAMPLE, 'all', 'all', 'check engine').map(c => c.id).join(), 'f5');
  check('search by post text', f(SAMPLE, 'all', 'all', 'summer heat').map(c => c.id).join(), 'f6');
  check('a search that matches nothing', f(SAMPLE, 'messenger', 'all', 'summer heat').length, 0);

  const items = freshCopy();
  const thread = items.find(c => c.id === 'f5');
  check('a blank demo reply is refused', replyDemo(thread, '   '), null);
  replyDemo(thread, '  Yes, bring it in any weekday.  ');
  const last = thread.messages[thread.messages.length - 1];
  ok('a Messenger reply is added as staff, trimmed and marked demo', last.text === 'Yes, bring it in any weekday.' && last.from === 'staff' && last.demo === true, JSON.stringify(last));
  check('   ...and clears the unread count', thread.unread, 0);
  const comment = items.find(c => c.id === 'f2');
  replyDemo(comment, 'Sample reply: yes, Fridays too.');
  ok('a comment reply is added the same way', comment.messages.length === 3 && comment.messages[2].demo === true, '');
  check('comment replies are labelled not posted', NOT_SENT.comment, 'Demo only — not posted');
  comment.assignee = 'Demo Advisor B'; comment.status = 'Resolved';
  check('assignment and status change the copy', [comment.assignee, comment.status].join(), 'Demo Advisor B,Resolved');
  const orig = SAMPLE.find(c => c.id === 'f2');
  ok('the samples themselves are untouched', orig.messages.length === 2 && orig.unread === 2 && orig.status === 'Open' && orig.assignee === 'Unassigned', '');
  check('a fresh copy (a reload) restores them', freshCopy().find(c => c.id === 'f2').messages.length, 2);
}

process.exit(summary('inbox-facebook') === 0 ? 0 : 1);
