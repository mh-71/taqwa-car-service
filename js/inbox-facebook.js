/* ============================================================
   inbox-facebook.js — Social Inbox › Facebook (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/inbox-facebook.html. It fills that page in
   from the FICTIONAL sample Messenger threads and page comments
   below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request, or contact Facebook, Messenger, Meta or any
       webhook -- nothing is connected and nothing is sent or posted.

   Demo Reply, Mark as read, Assign and the status change all work on
   this page's in-memory copy of the samples, so a reload brings the
   page back as it was. All content is built with textContent --
   nothing from the data is parsed as HTML.
   ============================================================ */

const InboxFacebook = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  const STATUSES = ['Open', 'Pending', 'Resolved'];
  const TYPES = { messenger: 'Messenger', comment: 'Page comment' };
  // Fictional staff for the Assign menu -- not read from the staff roster.
  const STAFF = ['Unassigned', 'Demo Advisor A', 'Demo Advisor B', 'Demo Mechanic C'];
  // Shown in place of a profile link: there is no real Facebook profile behind any sample.
  const PROFILE = 'Sample profile (no link)';
  const NOT_SENT = { messenger: 'Demo only — not sent', comment: 'Demo only — not posted' };

  // Eight samples, newest first: five Messenger threads and three comments on
  // sample page posts. Every name ends in "(Demo)" and every reference
  // carries DEMO, so nothing can be mistaken for a real customer or post.
  const SAMPLE = [
    { id: 'f1', type: 'messenger', name: 'Nusrat Jahan (Demo)', status: 'Open', unread: 1, assignee: 'Demo Advisor A', when: '11:05 AM',
      since: '2022 (sample)', vehicle: 'Honda Fit (sample)', reg: 'DEMO-REG-0201', last: 'Oil change, 4 months ago (sample)',
      messages: [
        { from: 'customer', at: '10:50 AM', text: 'How much is a full engine oil change?' },
        { from: 'staff',    at: '10:58 AM', text: 'Thank you for asking. It depends on the oil grade. Which car do you have?', by: 'Demo Advisor A' },
        { from: 'customer', at: '11:05 AM', text: 'Honda Fit 2016.' },
      ] },
    { id: 'f2', type: 'comment', name: 'Arif Rahman (Demo)', status: 'Open', unread: 2, assignee: 'Unassigned', when: '10:20 AM',
      post: { ref: 'DEMO-POST-014', text: 'Sample post: Free brake check with every full service this month.' },
      since: 'New contact (sample)', vehicle: 'Toyota Allion (sample)', reg: 'DEMO-REG-0202', last: 'No visits yet (sample)',
      messages: [
        { from: 'customer', at: '10:12 AM', text: 'Is this offer valid on Fridays too?' },
        { from: 'customer', at: '10:20 AM', text: 'And does it include the rear brakes?' },
      ] },
    { id: 'f3', type: 'messenger', name: 'Tanvir Ahmed (Demo)', status: 'Pending', unread: 0, assignee: 'Demo Advisor B', when: 'Yesterday',
      since: '2021 (sample)', vehicle: 'Mitsubishi Pajero (sample)', reg: 'DEMO-REG-0203', last: 'Estimate DEMO-EST-0044 sent (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 4:00 PM', text: 'Can you send me the estimate for the suspension work?' },
        { from: 'staff',    at: 'Yesterday, 4:30 PM', text: 'Sample reply: estimate DEMO-EST-0044 is ready. We will call you to explain it.', by: 'Demo Advisor B' },
      ] },
    { id: 'f4', type: 'comment', name: 'Lamia Haque (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor A', when: 'Yesterday',
      post: { ref: 'DEMO-POST-013', text: 'Sample post: Our workshop is now open on Saturdays.' },
      since: '2020 (sample)', vehicle: 'Toyota Corolla (sample)', reg: 'DEMO-REG-0204', last: 'Full service, 2 weeks ago (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 9:15 AM', text: 'Great service last time, thank you!' },
        { from: 'staff',    at: 'Yesterday, 9:40 AM', text: 'Thank you for the kind words. See you next time.', by: 'Demo Advisor A' },
      ] },
    { id: 'f5', type: 'messenger', name: 'Sabbir Hossain (Demo)', status: 'Open', unread: 3, assignee: 'Unassigned', when: 'Mon',
      since: 'New contact (sample)', vehicle: 'Nissan X-Trail (sample)', reg: 'DEMO-REG-0205', last: 'No visits yet (sample)',
      messages: [
        { from: 'customer', at: 'Mon, 7:40 PM', text: 'Hi' },
        { from: 'customer', at: 'Mon, 7:41 PM', text: 'My check engine light came on this morning.' },
        { from: 'customer', at: 'Mon, 7:45 PM', text: 'Do you do diagnostics?' },
      ] },
    { id: 'f6', type: 'comment', name: 'Rumana Begum (Demo)', status: 'Pending', unread: 1, assignee: 'Demo Mechanic C', when: 'Sun',
      post: { ref: 'DEMO-POST-012', text: 'Sample post: AC servicing before the summer heat.' },
      since: '2023 (sample)', vehicle: 'Suzuki Swift (sample)', reg: 'DEMO-REG-0206', last: 'AC gas refill, last year (sample)',
      messages: [
        { from: 'customer', at: 'Sun, 1:10 PM', text: 'How long does AC servicing take?' },
      ] },
    { id: 'f7', type: 'messenger', name: 'Jahid Islam (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor B', when: 'Sat',
      since: '2019 (sample)', vehicle: 'Toyota Noah (sample)', reg: 'DEMO-REG-0207', last: 'Battery replacement, last week (sample)',
      messages: [
        { from: 'customer', at: 'Sat, 3:00 PM', text: 'Thanks, the new battery works well.' },
        { from: 'staff',    at: 'Sat, 3:05 PM', text: 'Glad to help. Drive safe!', by: 'Demo Advisor B' },
      ] },
    { id: 'f8', type: 'messenger', name: 'Mitu Akter (Demo)', status: 'Pending', unread: 0, assignee: 'Demo Advisor A', when: 'Fri',
      since: '2024 (sample)', vehicle: 'Honda Vezel (sample)', reg: 'DEMO-REG-0208', last: 'Hybrid check booked (sample)',
      messages: [
        { from: 'customer', at: 'Fri, 6:20 PM', text: 'Can I move my booking to next week?' },
        { from: 'staff',    at: 'Fri, 6:45 PM', text: 'Sample reply: yes, we will confirm a new time with you.', by: 'Demo Advisor A' },
      ] },
  ];

  /* ---------- pure helpers (testable on their own) ---------- */

  /**
   * Conversations matching a type ('all', 'messenger' or 'comment'), a filter
   * ('all', 'unread' or a status) and a search text (name, message or post).
   */
  function filterItems(list, type, filter, query) {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(c => {
      if (type !== 'all' && c.type !== type) return false;
      if (filter === 'unread' && !c.unread) return false;
      if (STATUSES.includes(filter) && c.status !== filter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q)
        || c.messages.some(m => m.text.toLowerCase().includes(q))
        || (c.post ? c.post.text.toLowerCase().includes(q) : false);
    });
  }

  /** A demo reply: trimmed, capped and refused when blank. Never sent or posted anywhere. */
  function makeReply(text, by) {
    const t = String(text || '').trim().slice(0, 1000);
    if (!t) return null;
    return { from: 'staff', at: 'Just now', text: t, by: by && by !== 'Unassigned' ? by : 'You (demo)', demo: true };
  }

  /** Add a demo reply to a conversation in place; returns it, or null if refused. */
  function replyDemo(item, text) {
    const m = item && makeReply(text, item.assignee);
    if (!m) return null;
    item.messages.push(m);
    item.unread = 0;
    item.when = 'Just now';
    return item;
  }

  /** A fresh, deep copy of the samples: what a reload starts from. */
  const freshCopy = () => SAMPLE.map(c => Object.assign({}, c, {
    post: c.post ? Object.assign({}, c.post) : undefined,
    messages: c.messages.map(m => Object.assign({}, m)),
  }));

  /* ---------- rendering ---------- */

  const state = { items: [], type: 'all', filter: 'all', query: '', selected: null };
  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const initials = name => name.replace(/\(Demo\)/, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const selected = () => state.items.find(x => x.id === state.selected);

  function rowNode(c) {
    const li = el('li');
    const btn = el('button', `fb-row${c.unread ? ' is-unread' : ''}${c.id === state.selected ? ' is-selected' : ''}`);
    btn.type = 'button';
    btn.dataset.id = c.id;
    if (c.id === state.selected) btn.setAttribute('aria-current', 'true');
    btn.setAttribute('aria-label', `${c.name}, ${TYPES[c.type]}, ${c.status}${c.unread ? `, ${c.unread} unread` : ''}, ${c.when}`);

    const av = el('span', 'fb-avatar', initials(c.name));
    av.setAttribute('aria-hidden', 'true');
    btn.appendChild(av);

    const body = el('span', 'fb-row__body');
    const top = el('span', 'fb-row__top');
    top.appendChild(el('span', 'fb-row__name', c.name));
    top.appendChild(el('span', 'fb-row__when', c.when));
    body.appendChild(top);
    const last = c.messages[c.messages.length - 1];
    const bottom = el('span', 'fb-row__bottom');
    bottom.appendChild(el('span', 'fb-row__preview', (last.from === 'staff' ? 'You: ' : '') + last.text));
    if (c.unread) bottom.appendChild(el('span', 'fb-unread', String(c.unread)));
    body.appendChild(bottom);
    const tags = el('span', 'fb-row__tags');
    tags.appendChild(el('span', `fb-kind fb-kind--${c.type}`, TYPES[c.type]));
    tags.appendChild(el('span', `fb-status fb-status--${c.status.toLowerCase()}`, c.status));
    body.appendChild(tags);
    btn.appendChild(body);

    li.appendChild(btn);
    return li;
  }

  function messageNode(m, type) {
    const li = el('li', `fb-msg fb-msg--${m.from === 'staff' ? 'out' : 'in'}${m.demo ? ' is-demo' : ''}`);
    li.appendChild(el('p', 'fb-msg__text', m.text));
    li.appendChild(el('span', 'fb-msg__meta', m.from === 'staff' ? `${m.by || 'Staff'} · ${m.at}` : m.at));
    if (m.demo) li.appendChild(el('span', 'fb-msg__demo', NOT_SENT[type]));
    return li;
  }

  function drawDetail() {
    const c = selected();
    $('fbShell').classList.toggle('has-selection', !!c);
    $('fbNone').hidden = !!c;
    $('fbChat').hidden = !c;
    $('fbInfo').hidden = !c;
    if (!c) return;
    const isComment = c.type === 'comment';
    $('fbChatAvatar').textContent = initials(c.name);
    $('fbChatName').textContent = c.name;
    $('fbChatMeta').textContent = `${TYPES[c.type]} · ${c.status}`;
    $('fbMarkRead').disabled = !c.unread;
    $('fbPost').hidden = !isComment;
    $('fbPostRef').textContent = isComment ? c.post.ref : '';
    $('fbPostText').textContent = isComment ? c.post.text : '';
    $('fbShell').classList.toggle('is-comment', isComment);
    $('fbThread').setAttribute('aria-label', isComment ? 'Comment and replies' : 'Messages');
    $('fbThread').replaceChildren(...c.messages.map(m => messageNode(m, c.type)));
    $('fbThread').scrollTop = $('fbThread').scrollHeight;
    $('fbReply').placeholder = isComment ? 'Write a public reply (demo, nothing is posted)…' : 'Type a reply (demo, nothing is sent)…';
    $('fbComposerNote').textContent = isComment
      ? 'Demo only: a reply appears on this page and is not posted to Facebook.'
      : 'Demo only: a reply appears on this page and is not sent to Facebook.';
    $('fbInfoName').textContent = c.name;
    $('fbInfoProfile').textContent = PROFILE;
    $('fbInfoType').textContent = TYPES[c.type];
    $('fbInfoSince').textContent = c.since;
    $('fbInfoVehicle').textContent = c.vehicle;
    $('fbInfoReg').textContent = c.reg;
    $('fbInfoLast').textContent = c.last;
    $('fbAssign').value = c.assignee;
    $('fbStatus').value = c.status;
  }

  function drawList() {
    const shown = filterItems(state.items, state.type, state.filter, state.query);
    const none = !state.items.length;
    $('fbNoItems').hidden = !none;
    $('fbList').hidden = none || !shown.length;
    $('fbEmpty').hidden = none || !!shown.length;
    $('fbList').replaceChildren(...shown.map(rowNode));
    const unread = state.items.filter(c => c.unread).length;
    $('fbFoot').textContent = `${shown.length} of ${state.items.length} sample conversations · ${unread} unread`;
    document.querySelectorAll('.fb-type').forEach(b => {
      const on = b.dataset.type === state.type;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('.fb-chip').forEach(b => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // Status counts follow the chosen type; type counts cover every status.
    document.querySelectorAll('[data-count]').forEach(s => {
      s.textContent = String(filterItems(state.items, state.type, s.dataset.count, '').length);
    });
    document.querySelectorAll('[data-type-count]').forEach(s => {
      s.textContent = String(filterItems(state.items, s.dataset.typeCount, 'all', '').length);
    });
  }

  function draw() { drawList(); drawDetail(); }

  const demoToast = msg => { if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(msg, 'success'); };

  function bind() {
    document.querySelector('.fb-types').addEventListener('click', e => {
      const b = e.target.closest('.fb-type');
      if (!b) return;
      state.type = b.dataset.type;
      drawList();
    });
    document.querySelector('.fb-filters').addEventListener('click', e => {
      const b = e.target.closest('.fb-chip');
      if (!b) return;
      state.filter = b.dataset.filter;
      drawList();
    });
    $('fbSearch').addEventListener('input', e => { state.query = e.target.value; drawList(); });
    $('fbClear').addEventListener('click', () => {
      state.type = 'all'; state.filter = 'all'; state.query = ''; $('fbSearch').value = '';
      drawList();
    });
    $('fbList').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      state.selected = b.dataset.id;
      draw();
      $('fbReply').focus();
    });
    $('fbBack').addEventListener('click', () => {
      const id = state.selected;
      state.selected = null;
      draw();
      const row = document.querySelector(`.fb-row[data-id="${id}"]`);
      if (row) row.focus();
    });
    $('fbMarkRead').addEventListener('click', () => {
      const c = selected();
      if (!c || !c.unread) return;
      c.unread = 0;
      draw();
      demoToast('Marked as read (demo only).');
    });
    $('fbAssign').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.assignee = e.target.value;
      draw();
      demoToast(c.assignee === 'Unassigned' ? 'Unassigned (demo only).' : `Assigned to ${c.assignee} (demo only).`);
    });
    $('fbStatus').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.status = e.target.value;
      draw();
      demoToast(`Status set to ${c.status} (demo only).`);
    });
    const reply = $('fbReply');
    reply.addEventListener('input', () => { $('fbSend').disabled = !reply.value.trim(); });
    reply.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('fbComposer').requestSubmit(); }
    });
    // Demo Reply adds the reply to this page's copy of the sample only. Nothing is sent or posted.
    $('fbComposer').addEventListener('submit', e => {
      e.preventDefault();
      const c = selected();
      if (!replyDemo(c, reply.value)) return;
      reply.value = '';
      $('fbSend').disabled = true;
      draw();
      demoToast(`${NOT_SENT[c.type]} to Facebook.`);
    });
  }

  function load() {
    try {
      state.items = freshCopy();
      $('fbLoading').hidden = true;
      draw();
    } catch (err) {
      $('fbLoading').hidden = true;
      $('fbList').hidden = true;
      $('fbError').hidden = false;
    }
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-facebook') return;
    $('fbAssign').replaceChildren(...STAFF.map(s => { const o = el('option', null, s); o.value = s; return o; }));
    bind();
    load();
  }

  return { SAMPLE, STATUSES, TYPES, STAFF, PROFILE, NOT_SENT, filterItems, makeReply, replyDemo, freshCopy, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) InboxFacebook.init();
