/* inbox-nav — Social Inbox › All Conversations, with real Facebook data.

   What must hold:
     1. In the sidebar, All Conversations is a link to its page, labelled
        Facebook (the one connected channel); active only on that page.
     2. The Social Inbox holds exactly All Conversations, Facebook, WhatsApp
        and Website Forms.
     3. The page is not a demo: no sample data or DEMO banner; its script
        reads the Worker (Api) and touches no browser storage.
     4. Helpers: a Messenger conversation becomes a Facebook row linking to
        the Facebook inbox; rows from every channel merge newest first; the
        query carries search and status.
     5. In 'api' mode: real Facebook conversations are listed, escaped,
        tagged Facebook; WhatsApp and Website say "not connected" and list
        nothing -- no fake conversations; search and status re-query.
     6. Failures: Retry, never demo data; no backend says so.

   Drives the REAL js/app.js and js/inbox-conversations.js through the harness. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

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

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const conv = (id, extra = {}) => ({ id, platform: 'Facebook', customerPsid: `9000${id.slice(-2)}`, customerName: 'Customer', nameKnown: true,
  status: 'Open', unreadCount: 0, lastMessage: 'Hello', lastMessageAt: iso(60000), lastDirection: 'in', lastInboundAt: iso(60000),
  canReply: true, replyWindowEndsAt: new Date(NOW + 23 * 3600000).toISOString(), assignedTo: '', notes: '', createdAt: iso(3600000), updatedAt: iso(60000), ...extra });
const CONVS = [
  conv('FBC-0002', { customerName: '<img src=x onerror=alert(1)>', unreadCount: 2, lastMessage: 'Brake noise <b>loud</b>' }),
  conv('FBC-0001', { customerName: 'Rahim Uddin', lastMessage: 'Thanks', lastDirection: 'out', lastMessageAt: iso(7200000) }),
];
// WhatsApp conversations and website enquiries, in the shapes their routes return.
const WA = [
  { id: 'WAC-0001', platform: 'WhatsApp', customerWaId: '8801711000001', customerPhone: '+8801711000001', customerName: 'Karim Mia', nameKnown: true,
    status: 'Pending', unreadCount: 1, lastMessage: 'Is the car ready?', lastMessageAt: iso(30000), lastDirection: 'in', createdAt: iso(9000000) },
];
const FORMS = [
  { id: 'WEB-0003', formType: 'booking', name: 'Salma Begum', phone: '01811000003', service: 'Oil change', vehicle: 'Axio', message: '',
    status: 'New', createdAt: iso(90000), submittedAt: iso(90000), updatedAt: iso(90000) },
  { id: 'WEB-0002', formType: 'contact', name: 'Old Enquiry', phone: '01811000002', message: 'Price for AC service?',
    status: 'Confirmed', createdAt: iso(86400000 * 3), submittedAt: iso(86400000 * 3), updatedAt: iso(86400000 * 3) },
];
// Booking requests (0023), in the shape GET /api/bookings returns. BKG- ids, a
// different record from a website enquiry (WEB-) even for the same customer.
const BOOKINGS = [
  { id: 'BKG-0002', source: 'Website', customerName: 'Salma Begum', phone: '01811000003', vehicleMake: 'Toyota', vehicleModel: 'Axio',
    serviceLabel: 'Oil change', preferredDate: '2026-11-12', preferredTime: '10:00', message: '', status: 'New', createdAt: iso(45000) },
  { id: 'BKG-0001', source: 'Phone', customerName: 'Nasir Ahmed', phone: '01911000009', vehicleMake: 'Honda', vehicleModel: 'Civic',
    serviceLabel: 'Full service', preferredDate: '2026-11-02', preferredTime: '09:30', message: '', status: 'Confirmed', createdAt: iso(86400000 * 4) },
];
const MSGS = [
  { id: 1, conversationId: 'FBC-0002', direction: 'in', senderType: 'customer', sentBy: '', kind: 'message', text: 'Is my car <ready>?',
    attachments: [{ type: 'image', url: 'https://scontent.example/x.jpg', title: null }, { type: 'file', url: null, title: null }], status: 'received', error: '', createdAt: iso(60000) },
  { id: 2, conversationId: 'FBC-0002', direction: 'out', senderType: 'staff', sentBy: 'karim', kind: 'message', text: 'Yes', attachments: [], status: 'read', error: '', createdAt: iso(30000) },
];

/** fakeApi for hydration; /messenger answered as the Worker would. `send` decides the reply's fate. */
function api({ convs = CONVS, msgs = MSGS, failList = null, failTimes = Infinity, send = 'ok', connection = { send: true, webhook: true },
  wa = WA, forms = FORMS, bookings = BOOKINGS, failPaths = [] } = {}) {
  const base = fakeApi({ rows: {} });
  const calls = base.calls;
  let failures = 0, nextId = 100;
  const thread = JSON.parse(JSON.stringify(msgs));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    // WhatsApp and Website lists, answered as their routes would (status / q / limit / offset).
    for (const [prefix, rows, summary] of [['/whatsapp/conversations', wa, (r) => ({ unreadConversations: r.filter(c => c.unreadCount).length })],
      ['/website-forms', forms, (r) => ({ new: r.filter(f => f.status === 'New').length })],
      ['/bookings', bookings, (r) => ({ new: r.filter(b => b.status === 'New').length })]]) {
      if (!path.startsWith(prefix)) continue;
      calls.push({ method: init.method || 'GET', path });
      if (failPaths.some(p => path.startsWith(p))) return res(500, { error: { code: 'database_error', message: 'x' } });
      const q = new URL('http://x' + path).searchParams;
      const want = q.get('status'), needle = (q.get('q') || '').toLowerCase();
      const limit = Number(q.get('limit') || 50), offset = Number(q.get('offset') || 0);
      const hit = rows.filter(r => (!want || r.status === want) && (!q.get('unread') || r.unreadCount)
        && (!needle || JSON.stringify(r).toLowerCase().includes(needle)));
      return res(200, { data: hit.slice(offset, offset + limit), count: Math.min(limit, hit.length), total: hit.length, limit, offset,
        summary: summary(rows), ...(prefix.startsWith('/whatsapp') ? { connection } : {}) });
    }
    if (!path.startsWith('/messenger')) return base(url, init);
    if (failPaths.some(p => path.startsWith(p)) && path.startsWith('/messenger/conversations?')) {
      calls.push({ method: 'GET', path });
      return res(500, { error: { code: 'database_error', message: 'x' } });
    }
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const [p] = path.split('?');
    if (p === '/messenger/conversations' && method === 'GET') {
      if (failList && failures < failTimes) { failures++; return res(failList.status, { error: failList.error }); }
      // Searched as the Worker does (name, message); the summary still covers every conversation.
      const needle = (new URL('http://x' + path).searchParams.get('q') || '').toLowerCase();
      const hit = convs.filter(c => !needle || `${c.customerName} ${c.lastMessage}`.toLowerCase().includes(needle));
      return res(200, { data: hit, count: hit.length, total: hit.length, limit: 50, offset: 0,
        summary: { total: convs.length, unreadConversations: convs.filter(c => c.unreadCount).length, unreadMessages: 2, open: 2, pending: 0, resolved: 0 }, connection });
    }
    const m = /^\/messenger\/conversations\/(FBC-\d+)(?:\/([a-z]+))?$/.exec(p);
    const c = m && convs.find(x => x.id === m[1]);
    if (!c) return res(404, { error: { code: 'not_found', message: 'No conversation with that id.' } });
    if (!m[2]) return res(200, { data: c });
    if (m[2] === 'messages') return res(200, { data: thread.filter(x => x.conversationId === c.id), count: 2, hasMore: false, nextBefore: null });
    if (m[2] === 'read') { c.unreadCount = 0; return res(200, { data: c }); }
    if (m[2] === 'status') { Object.assign(c, body); return res(200, { data: c }); }
    if (m[2] === 'reply') {
      if (send === 'window') return res(409, { error: { code: 'conflict', message: 'This customer last wrote more than 24 hours ago.', reason: 'outside_messaging_window' } });
      const row = { id: nextId++, conversationId: c.id, direction: 'out', senderType: 'staff', sentBy: 'API token', kind: 'message', text: body.text, attachments: [], clientRequestId: body.clientRequestId,
        status: send === 'ok' ? 'sent' : 'failed', error: send === 'ok' ? '' : 'Facebook refused the message.', createdAt: new Date().toISOString() };
      thread.push(row);
      if (send === 'ok') return res(201, { data: row });
      return res(502, { error: { code: 'send_failed', message: 'Facebook refused the message.', reason: 'meta_100' } });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'no' } });
  };
  fn.calls = calls;
  return fn;
}

function page(pageKey, module, ids, { origin = 'http://localhost:8787', fetch, plantDemo = false, search = '' } = {}) {
  const h = boot({
    origin, fetch, modules: [module],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = pageKey;
      ctx.setInterval = () => 0; ctx.clearInterval = () => {};
      ctx.location.search = search;
      const els = new Map();
      const make = (id) => {
        const e = makeElement(id); e.hidden = false; e.disabled = false;
        e.querySelector = () => make(`${id}-child`);
        e.classList = (() => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
          toggle: (x) => (s.has(x) ? (s.delete(x), false) : (s.add(x), true)), contains: (x) => s.has(x) }; })();
        e.requestSubmit = () => e.dispatch('submit', { preventDefault() {} });
        return e;
      };
      doc.getElementById = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
      doc.querySelectorAll = () => [];
      if (plantDemo) ctx.localStorage.setItem('taqwa_messengerConversations', JSON.stringify([conv('FBC-9999', { customerName: 'DEMO ROW' })]));
    },
  });
  return { h, el: id => h.ctx.document.getElementById(id) };
}
const msgCalls = calls => calls.filter(c => c.path.startsWith('/messenger'));
const codeOf = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

(async () => {
console.log('=== inbox-nav: All Conversations ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'All Conversations');
  ok('All Conversations is a link to pages/inbox-conversations.html', /^<a class="nav__sub" href="pages\/inbox-conversations\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-conversations.html')), '');
  ok('   ...labelled All channels, no longer Facebook only or Demo', /<small>All channels<\/small>/.test(row) && !/<small>(Demo|Facebook)<\/small>/.test(row) && !/not connected/i.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-conversations', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'All Conversations');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...and the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
}

console.log('\n-- 2. the Social Inbox entries --');
{
  const html = shellFor('dashboard');
  const group = inboxGroup(html);
  check('Social Inbox has exactly five entries', group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1).length, 5);
  for (const [label, href] of [['All Conversations', 'inbox-conversations'], ['Facebook', 'inbox-facebook'], ['WhatsApp', 'inbox-whatsapp'], ['Website Forms', 'inbox-website-forms'], ['Bookings', 'inbox-bookings']]) {
    ok(`${label} links to pages/${href}.html`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(subFor(group, label)), subFor(group, label).slice(0, 120));
  }
  ok('Book Now and Comments are not in the Social Inbox', !/<span>Book Now<\/span>/.test(group) && !/<span>Comments<\/span>/.test(group), '');
  ok('the main Appointments link is still in the sidebar', /<a class="nav__link[^"]*" href="pages\/appointments\.html">[\s\S]*?<span>Appointments<\/span><\/a>/.test(html), '');
}

console.log('\n-- 3. real, not a demo --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-conversations.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-conversations.js'), 'utf8');
{
  ok('the page declares data-page="inbox-conversations"', html.includes('<body data-page="inbox-conversations" data-root="../">'), '');
  ok('the page has no Demo banner', !/Demo Mode|sample data/i.test(html), '');
  ok('no channel is marked Not connected or demo only any more', !/Not connected/i.test(html) && !/demo only/i.test(src), '');
  const code = codeOf(src);
  ok('the script reads the Worker through Api', /\bApi\.get\(/.test(code), '');
  for (const [what, re] of [['a direct fetch', /\bfetch\s*\(/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['sample data', /SAMPLE|\(Demo\)/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
}

console.log('\n-- 4. helpers --');
{
  const { h } = page('nothing', 'js/inbox-conversations.js', [], { origin: '' });
  vm.runInContext('globalThis.IC = InboxConversations;', h.ctx);
  const C = h.ctx.IC;
  const row = C.fromMessenger(CONVS[0]);
  check('a Messenger conversation becomes a Facebook row that opens it in the Facebook inbox',
    [row.platform, row.id, row.unread, row.href], ['Facebook', 'FBC-0002', 2, 'inbox-facebook.html?c=FBC-0002']);
  check('rows merge newest first across channels', C.mergeRows([{ id: 'a', at: '2026-10-01' }], [{ id: 'b', at: '2026-10-03' }, { id: 'c', at: '2026-10-02' }]).map(r => r.id), ['b', 'c', 'a']);
  check('the query carries search and status', C.messengerQuery({ q: ' x ', status: 'unread' }), { limit: '50', offset: '0', q: 'x', unread: '1' });
  check('all four channels are connected, each to its own route (Bookings behind bookings.view)',
    C.CHANNELS.map(c => [c.key, c.connected, c.path, c.permission || '']),
    [['Facebook', true, '/messenger/conversations', ''], ['WhatsApp', true, '/whatsapp/conversations', ''], ['Website', true, '/website-forms', ''], ['Bookings', true, '/bookings', 'bookings.view']]);
  const bk = C.fromBooking(BOOKINGS[0]);
  check('a booking opens that booking, shows when it is for, what and where from, keeps its status and invents no unread count',
    [bk.platform, bk.id, bk.phone, bk.unread, bk.isNew, bk.status, bk.href, bk.preview],
    ['Bookings', 'BKG-0002', '01811000003', 0, true, 'New', 'inbox-bookings.html?id=BKG-0002', 'For 12 Nov, 10:00 · Oil change · Toyota Axio · via Website']);
  check('   ...an unreadable booking date shows no date rather than a guess', [C.bookingWhen('soon', '10:00'), C.bookingWhen('2026-11-12', 'x')], ['', '12 Nov']);
  check('booking statuses map as the owner decided (Confirmed is Open, never Resolved)',
    ['', 'unread', 'Open', 'Pending', 'Resolved'].map(st => C.feedsFor('Bookings', st).map(x => x.formStatus)),
    [[null], ['New'], ['New', 'Pending', 'Confirmed', 'Rescheduled'], ['Pending', 'Rescheduled'], ['Completed', 'Cancelled', 'Rejected']]);
  check('without bookings.view no booking is asked for, even under All',
    [C.feedsFor('all', '', p => p !== 'bookings.view').map(x => x.channel), C.feedsFor('Bookings', '', () => false).length],
    [['Facebook', 'WhatsApp', 'Website'], 0]);
  check('a website enquiry and a booking for the same customer stay two rows',
    C.mergeRows([C.fromWebsite(FORMS[0])], [C.fromBooking(BOOKINGS[0])]).map(r => r.id), ['BKG-0002', 'WEB-0003']);
  const w = C.fromWhatsApp(WA[0]);
  check('a WhatsApp conversation opens in the WhatsApp inbox, with its phone and unread count',
    [w.platform, w.id, w.phone, w.unread, w.status, w.href], ['WhatsApp', 'WAC-0001', '+8801711000001', 1, 'Pending', 'inbox-whatsapp.html?c=WAC-0001']);
  const f = C.fromWebsite(FORMS[0]);
  check('a website enquiry opens that enquiry, keeps its own status, and invents no unread count',
    [f.platform, f.id, f.phone, f.unread, f.isNew, f.status, f.href, f.preview], ['Website', 'WEB-0003', '01811000003', 0, true, 'New', 'inbox-website-forms.html?id=WEB-0003', 'Booking request · Oil change · Axio']);
  check('a row without a time sorts last and shows no time',
    [C.mergeRows([{ platform: 'Website', id: 'x', at: null }], [{ platform: 'WhatsApp', id: 'y', at: '2026-10-01T00:00:00Z' }]).map(r => r.id), C.rowHtml({ ...f, at: 'nonsense' }).includes('<time class="inb-row__time"></time>')],
    [['y', 'x'], true]);
  check('the same id on two channels stays two conversations; the same row twice is one',
    C.mergeRows([{ platform: 'Facebook', id: 'A-1', at: '2026-10-01' }, { platform: 'WhatsApp', id: 'A-1', at: '2026-10-01' }], [{ platform: 'Facebook', id: 'A-1', at: '2026-10-01' }]).length, 2);
  check('status filters map onto Website statuses (Resolved = Confirmed and Rejected, two feeds)',
    ['', 'unread', 'Open', 'Pending', 'Resolved'].map(st => C.feedsFor('Website', st).map(x => x.formStatus)),
    [[null], ['New'], ['New'], ['Contacted'], ['Confirmed', 'Rejected']]);
  check('a channel filter reads only that channel', [C.feedsFor('all', '').map(x => x.channel), C.feedsFor('WhatsApp', 'Open').map(x => x.channel)],
    [['Facebook', 'WhatsApp', 'Website', 'Bookings'], ['WhatsApp']]);
  const feeds = [
    { channel: 'Facebook', total: 2, rows: [{ platform: 'Facebook', id: 'f1', at: '2026-10-05T00:00:00Z' }] },
    { channel: 'Website', total: 1, rows: [{ platform: 'Website', id: 'w1', at: '2026-10-01T00:00:00Z' }] },
  ];
  check('a row older than an unfinished feed\'s oldest loaded row waits for "Load more"', C.visibleRows(feeds).map(r => r.id), ['f1']);
  feeds[0].total = 1;
  check('   ...and shows once every feed is finished', C.visibleRows(feeds).map(r => r.id), ['f1', 'w1']);
  const r = C.rowHtml(row);
  ok('a row is escaped and tagged Facebook', r.includes('&lt;img src=x') && !r.includes('<img src=x') && r.includes('inb-plat--facebook" title="Facebook">Facebook'), r);
}

console.log('\n-- 5. the page --');
{
  const fetch = api();
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch });
  h.fireReady();
  await tick(80);
  const list = el('inbList').innerHTML;
  check('All lists every channel together: 2 Facebook, 1 WhatsApp, 2 Website, 2 Bookings',
    [(list.match(/<li>/g) || []).length, (list.match(/inb-plat--facebook/g) || []).length, (list.match(/inb-plat--whatsapp/g) || []).length,
      (list.match(/inb-plat--website/g) || []).length, (list.match(/inb-plat--bookings/g) || []).length],
    [7, 2, 1, 2, 2]);
  check('   ...newest first across channels', [...list.matchAll(/href="inbox-[a-z-]+\.html\?(?:c|id)=([A-Z]+-\d+)"/g)].map(m => m[1]),
    ['WAC-0001', 'BKG-0002', 'FBC-0002', 'WEB-0003', 'FBC-0001', 'WEB-0002', 'BKG-0001']);
  ok('   ...each opening its own inbox on that conversation or booking',
    list.includes('href="inbox-facebook.html?c=FBC-0002"') && list.includes('href="inbox-whatsapp.html?c=WAC-0001"')
      && list.includes('href="inbox-website-forms.html?id=WEB-0003"') && list.includes('href="inbox-bookings.html?id=BKG-0002"'), '');
  ok('   ...a booking row shows its date, service, vehicle, source and real status',
    list.includes('For 12 Nov, 10:00 · Oil change · Toyota Axio · via Website') && /inb-status--confirmed">Confirmed</.test(list), '');
  ok('   ...the WhatsApp phone is shown, and a New enquiry is marked New (no unread number invented)',
    list.includes('+8801711000001') && /inb-badge--new[^>]*>New</.test(list), '');
  check('no channel shows a "not connected" note', el('inbNotes').innerHTML, '');
  check('the footer counts every channel', el('inbCount').textContent, '7 of 7 conversations');
  check('each channel chip shows its own count (unread, new enquiries, new bookings)',
    [el('inbCountFacebook').textContent, el('inbCountWhatsApp').textContent, el('inbCountWebsite').textContent, el('inbCountBookings').textContent], ['1', '1', '1', '1']);
  el('inbStatus').value = 'unread'; el('inbStatus').dispatch('change');
  await tick(60);
  ok('a status filter re-queries the Worker', msgCalls(fetch.calls).slice(-1)[0].path.includes('unread=1'), msgCalls(fetch.calls).slice(-1)[0].path);
  el('inbSearch').value = 'brake'; el('inbSearch').dispatch('input');
  await tick(400);
  ok('search re-queries the Worker', msgCalls(fetch.calls).slice(-1)[0].path.includes('q=brake'), msgCalls(fetch.calls).slice(-1)[0].path);
}

console.log('\n-- 6. failures --');
{
  const fetch = api({ failPaths: ['/messenger/conversations', '/whatsapp/conversations', '/website-forms', '/bookings'] });
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('every channel failing shows one error with Retry, and lists nothing', /could not be loaded/.test(el('inbState').innerHTML) && /data-retry/.test(el('inbState').innerHTML) && el('inbList').hidden, el('inbState').innerHTML);
  check('   ...with no per-channel notes on top of it', el('inbNotes').innerHTML, '');
}
for (const [down, others] of [['/messenger/conversations', ['whatsapp', 'website', 'bookings']], ['/whatsapp/conversations', ['facebook', 'website', 'bookings']],
  ['/website-forms', ['facebook', 'whatsapp', 'bookings']], ['/bookings', ['facebook', 'whatsapp', 'website']]]) {
  const fetch = api({ failPaths: [down] });
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch });
  h.fireReady();
  await tick(80);
  const list = el('inbList').innerHTML;
  const name = { '/messenger/conversations': 'Facebook', '/whatsapp/conversations': 'WhatsApp', '/website-forms': 'Website', '/bookings': 'Bookings' }[down];
  ok(`${name} failing: the other channels are still listed`, !el('inbList').hidden && others.every(o => list.includes(`inb-plat--${o}`)) && !list.includes(`inb-plat--${name.toLowerCase()}`), list.slice(0, 200));
  const said = name === 'Bookings' ? 'Booking requests' : `${name} conversations`;
  ok(`   ...and a note says ${name} could not be loaded, with Retry`, new RegExp(`${said} could not be loaded`).test(el('inbNotes').innerHTML) && /data-retry/.test(el('inbNotes').innerHTML), el('inbNotes').innerHTML);
}
{
  // The channel and status filters re-read only what they need, through the existing routes.
  const fetch = api();
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch });
  vm.runInContext('globalThis.IC = InboxConversations;', h.ctx);
  h.fireReady();
  await tick(80);
  const IC = h.ctx.IC;
  IC._state.channel = 'Website'; IC._state.status = 'Resolved';
  const before = fetch.calls.length;
  await IC.load();
  const asked = fetch.calls.slice(before).map(c => c.path);
  check('Website + Resolved asks the Website route twice (Confirmed, Rejected) and nothing else',
    asked.map(p => p.replace(/\?.*status=([A-Za-z]+).*/, ' $1')), ['/website-forms Confirmed', '/website-forms Rejected']);
  check('   ...and lists the one Confirmed enquiry', [...el('inbList').innerHTML.matchAll(/id=(WEB-\d+)/g)].map(m => m[1]), ['WEB-0002']);
  IC._state.channel = 'Bookings'; IC._state.status = 'Open';
  const b4 = fetch.calls.length;
  await IC.load();
  check('Bookings + Open asks the bookings route once per status (New, Pending, Confirmed, Rescheduled) and nothing else',
    fetch.calls.slice(b4).map(c => c.path.replace(/\?.*status=([A-Za-z]+).*/, ' $1')),
    ['/bookings New', '/bookings Pending', '/bookings Confirmed', '/bookings Rescheduled']);
  check('   ...and lists the New and the Confirmed booking', [...el('inbList').innerHTML.matchAll(/id=(BKG-\d+)/g)].map(m => m[1]), ['BKG-0002', 'BKG-0001']);
  IC._state.status = 'Resolved';
  await IC.load();
  check('   ...a Confirmed booking is not Resolved: nothing listed, the empty state shown',
    [IC._state.rows.map(r => r.id), el('inbList').hidden, /No conversations match/.test(el('inbState').innerHTML)], [[], true, true]);
  IC._state.channel = 'all'; IC._state.status = ''; IC._state.q = 'karim';
  await IC.load();
  check('search reaches every channel and finds the WhatsApp customer', [...el('inbList').innerHTML.matchAll(/(?:c|id)=([A-Z]+-\d+)/g)].map(m => m[1]), ['WAC-0001']);
  ok('   ...every channel route was asked with q=karim', ['/messenger/conversations', '/whatsapp/conversations', '/website-forms', '/bookings'].every(p => fetch.calls.some(c => c.path.startsWith(p) && c.path.includes('q=karim'))), '');
}
{
  const fetch = api();
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { origin: '', fetch });
  h.fireReady();
  await tick(40);
  ok('no backend: says the database is not connected, and asks for nothing', /not connected/.test(el('inbState').innerHTML) && msgCalls(fetch.calls).length === 0, el('inbState').innerHTML);
}

process.exit(summary('inbox-nav') === 0 ? 0 : 1);
})();
