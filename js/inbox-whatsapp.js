/* ============================================================
   inbox-whatsapp.js — Social Inbox › WhatsApp (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/inbox-whatsapp.html. It fills that page in
   from the FICTIONAL sample chats below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request, or contact WhatsApp, Meta or any webhook --
       nothing is connected and nothing is sent.

   Demo Send, Mark as read, Assign and the status change all work on
   this page's in-memory copy of the samples, so a reload brings the
   page back as it was. All content is built with textContent --
   nothing from the data is parsed as HTML.
   ============================================================ */

const InboxWhatsApp = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  const STATUSES = ['Open', 'Pending', 'Resolved'];
  // Fictional staff for the Assign menu -- not read from the staff roster.
  const STAFF = ['Unassigned', 'Demo Advisor A', 'Demo Advisor B', 'Demo Mechanic C'];
  // The only phone number shown anywhere: a placeholder that cannot be dialled.
  const PHONE = '+880 1X-XXX-XXXX';

  // Seven sample chats, newest first. Every name ends in "(Demo)", every
  // number is the placeholder above, and references carry DEMO.
  const SAMPLE = [
    { id: 'w1', name: 'Rahim Uddin (Demo)', status: 'Open', unread: 2, assignee: 'Unassigned', when: '10:42 AM',
      since: '2023 (sample)', vehicle: 'Toyota Axio (sample)', reg: 'DEMO-REG-0101', last: 'Brake inspection, 3 months ago (sample)',
      messages: [
        { from: 'customer', at: '10:38 AM', text: 'Assalamu alaikum. My car is making a noise when I brake.' },
        { from: 'customer', at: '10:42 AM', text: 'Can I bring it in tomorrow morning?' },
      ] },
    { id: 'w2', name: 'Farhana Akter (Demo)', status: 'Pending', unread: 0, assignee: 'Demo Mechanic C', when: '9:50 AM',
      since: '2021 (sample)', vehicle: 'Toyota Premio (sample)', reg: 'DEMO-REG-0102', last: 'In workshop now, job card DEMO-JC-1042',
      messages: [
        { from: 'customer', at: '9:30 AM', text: 'Is my car ready? Job card DEMO-JC-1042.' },
        { from: 'staff',    at: '9:50 AM', text: 'We are waiting for one part. We will update you by this evening.', by: 'Demo Mechanic C' },
      ] },
    { id: 'w3', name: 'Imran Chowdhury (Demo)', status: 'Open', unread: 1, assignee: 'Demo Advisor A', when: 'Yesterday',
      since: '2024 (sample)', vehicle: 'Honda Grace (sample)', reg: 'DEMO-REG-0103', last: 'Oil change, 5 months ago (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 5:10 PM', text: 'Salam. How much for a full service on a hybrid?' },
        { from: 'staff',    at: 'Yesterday, 5:25 PM', text: 'Sample reply: it depends on the checks needed. Could you share the model year?', by: 'Demo Advisor A' },
        { from: 'customer', at: 'Yesterday, 6:02 PM', text: 'It is a 2017 model.' },
      ] },
    { id: 'w4', name: 'Mahmud Hasan (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor B', when: 'Yesterday',
      since: '2020 (sample)', vehicle: 'Toyota Corolla (sample)', reg: 'DEMO-REG-0104', last: 'Full service, last week (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 10:10 AM', text: 'Got the car back, it drives well now. Thanks.' },
        { from: 'staff',    at: 'Yesterday, 10:20 AM', text: 'Glad to hear it. Thank you for choosing us.', by: 'Demo Advisor B' },
      ] },
    { id: 'w5', name: 'Shirin Sultana (Demo)', status: 'Open', unread: 3, assignee: 'Unassigned', when: 'Mon',
      since: 'New contact (sample)', vehicle: 'Suzuki Wagon R (sample)', reg: 'DEMO-REG-0105', last: 'No visits yet (sample)',
      messages: [
        { from: 'customer', at: 'Mon, 8:01 PM', text: 'Hello?' },
        { from: 'customer', at: 'Mon, 8:02 PM', text: 'My AC is blowing warm air.' },
        { from: 'customer', at: 'Mon, 8:05 PM', text: 'Are you open on Friday?' },
      ] },
    { id: 'w6', name: 'Kamal Hossain (Demo)', status: 'Pending', unread: 1, assignee: 'Demo Advisor B', when: 'Sun',
      since: '2022 (sample)', vehicle: 'Mitsubishi Pajero (sample)', reg: 'DEMO-REG-0106', last: 'Estimate DEMO-EST-0031 sent (sample)',
      messages: [
        { from: 'staff',    at: 'Sun, 12:00 PM', text: 'Sample message: your estimate DEMO-EST-0031 is ready for review.', by: 'Demo Advisor B' },
        { from: 'customer', at: 'Sun, 3:15 PM', text: 'Thanks, I will confirm tomorrow.' },
      ] },
    { id: 'w7', name: 'Nadia Karim (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor A', when: 'Sat',
      since: '2019 (sample)', vehicle: 'Nissan Sunny (sample)', reg: 'DEMO-REG-0107', last: 'Wheel alignment, 2 weeks ago (sample)',
      messages: [
        { from: 'customer', at: 'Sat, 11:00 AM', text: 'What time do you close today?' },
        { from: 'staff',    at: 'Sat, 11:05 AM', text: 'Sample reply: we close at 7 PM today.', by: 'Demo Advisor A' },
      ] },
  ];

  /* ---------- pure helpers (testable on their own) ---------- */

  /** Chats matching a filter ('all', 'unread' or a status) and a search text (name or message). */
  function filterChats(list, filter, query) {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(c => {
      if (filter === 'unread' && !c.unread) return false;
      if (STATUSES.includes(filter) && c.status !== filter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.messages.some(m => m.text.toLowerCase().includes(q));
    });
  }

  /** A demo reply: trimmed, capped and refused when blank. Never sent anywhere. */
  function makeReply(text, by) {
    const t = String(text || '').trim().slice(0, 1000);
    if (!t) return null;
    return { from: 'staff', at: 'Just now', text: t, by: by && by !== 'Unassigned' ? by : 'You (demo)', demo: true };
  }

  /** Add a demo reply to a chat in place; returns the chat or null if refused. */
  function sendDemo(chat, text) {
    const m = chat && makeReply(text, chat.assignee);
    if (!m) return null;
    chat.messages.push(m);
    chat.unread = 0;
    chat.when = 'Just now';
    return chat;
  }

  /** A fresh, deep copy of the samples: what a reload starts from. */
  const freshCopy = () => SAMPLE.map(c => Object.assign({}, c, { messages: c.messages.map(m => Object.assign({}, m)) }));

  /* ---------- rendering ---------- */

  const state = { items: [], filter: 'all', query: '', selected: null };
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
    const btn = el('button', `wa-row${c.unread ? ' is-unread' : ''}${c.id === state.selected ? ' is-selected' : ''}`);
    btn.type = 'button';
    btn.dataset.id = c.id;
    if (c.id === state.selected) btn.setAttribute('aria-current', 'true');
    btn.setAttribute('aria-label', `${c.name}, ${c.status}${c.unread ? `, ${c.unread} unread` : ''}, ${c.when}`);

    const av = el('span', 'wa-avatar', initials(c.name));
    av.setAttribute('aria-hidden', 'true');
    btn.appendChild(av);

    const body = el('span', 'wa-row__body');
    const top = el('span', 'wa-row__top');
    top.appendChild(el('span', 'wa-row__name', c.name));
    top.appendChild(el('span', 'wa-row__when', c.when));
    body.appendChild(top);
    body.appendChild(el('span', 'wa-row__phone', PHONE));
    const last = c.messages[c.messages.length - 1];
    const bottom = el('span', 'wa-row__bottom');
    bottom.appendChild(el('span', 'wa-row__preview', (last.from === 'staff' ? 'You: ' : '') + last.text));
    if (c.unread) bottom.appendChild(el('span', 'wa-unread', String(c.unread)));
    body.appendChild(bottom);
    body.appendChild(el('span', `wa-status wa-status--${c.status.toLowerCase()}`, c.status));
    btn.appendChild(body);

    li.appendChild(btn);
    return li;
  }

  function messageNode(m) {
    const li = el('li', `wa-msg wa-msg--${m.from === 'staff' ? 'out' : 'in'}${m.demo ? ' is-demo' : ''}`);
    li.appendChild(el('p', 'wa-msg__text', m.text));
    const meta = el('span', 'wa-msg__meta', m.from === 'staff' ? `${m.by || 'Staff'} · ${m.at}` : m.at);
    li.appendChild(meta);
    if (m.demo) li.appendChild(el('span', 'wa-msg__demo', 'Demo only — not sent'));
    return li;
  }

  function drawDetail() {
    const c = selected();
    $('waShell').classList.toggle('has-selection', !!c);
    $('waNone').hidden = !!c;
    $('waChat').hidden = !c;
    $('waInfo').hidden = !c;
    if (!c) return;
    $('waChatAvatar').textContent = initials(c.name);
    $('waChatName').textContent = c.name;
    $('waChatMeta').textContent = `${PHONE} · ${c.status}`;
    $('waMarkRead').disabled = !c.unread;
    $('waThread').replaceChildren(...c.messages.map(messageNode));
    $('waThread').scrollTop = $('waThread').scrollHeight;
    $('waInfoName').textContent = c.name;
    $('waInfoPhone').textContent = PHONE;
    $('waInfoSince').textContent = c.since;
    $('waInfoVehicle').textContent = c.vehicle;
    $('waInfoReg').textContent = c.reg;
    $('waInfoLast').textContent = c.last;
    $('waAssign').value = c.assignee;
    $('waStatus').value = c.status;
  }

  function drawList() {
    const shown = filterChats(state.items, state.filter, state.query);
    const none = !state.items.length;
    $('waNoChats').hidden = !none;
    $('waList').hidden = none || !shown.length;
    $('waEmpty').hidden = none || !!shown.length;
    $('waList').replaceChildren(...shown.map(rowNode));
    const unread = state.items.filter(c => c.unread).length;
    $('waFoot').textContent = `${shown.length} of ${state.items.length} sample chats · ${unread} unread`;
    document.querySelectorAll('.wa-chip').forEach(b => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-count]').forEach(s => {
      s.textContent = String(filterChats(state.items, s.dataset.count, '').length);
    });
  }

  function draw() { drawList(); drawDetail(); }

  const demoToast = msg => { if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(msg, 'success'); };

  function bind() {
    document.querySelector('.wa-filters').addEventListener('click', e => {
      const b = e.target.closest('.wa-chip');
      if (!b) return;
      state.filter = b.dataset.filter;
      drawList();
    });
    $('waSearch').addEventListener('input', e => { state.query = e.target.value; drawList(); });
    $('waClear').addEventListener('click', () => {
      state.filter = 'all'; state.query = ''; $('waSearch').value = '';
      drawList();
    });
    $('waList').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      state.selected = b.dataset.id;
      draw();
      $('waReply').focus();
    });
    $('waBack').addEventListener('click', () => {
      const id = state.selected;
      state.selected = null;
      draw();
      const row = document.querySelector(`.wa-row[data-id="${id}"]`);
      if (row) row.focus();
    });
    $('waMarkRead').addEventListener('click', () => {
      const c = selected();
      if (!c || !c.unread) return;
      c.unread = 0;
      draw();
      demoToast('Marked as read (demo only).');
    });
    $('waAssign').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.assignee = e.target.value;
      draw();
      demoToast(c.assignee === 'Unassigned' ? 'Unassigned (demo only).' : `Assigned to ${c.assignee} (demo only).`);
    });
    $('waStatus').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.status = e.target.value;
      draw();
      demoToast(`Status set to ${c.status} (demo only).`);
    });
    const reply = $('waReply');
    reply.addEventListener('input', () => { $('waSend').disabled = !reply.value.trim(); });
    reply.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('waComposer').requestSubmit(); }
    });
    // Demo Send adds the reply to this page's copy of the sample only. Nothing is sent.
    $('waComposer').addEventListener('submit', e => {
      e.preventDefault();
      if (!sendDemo(selected(), reply.value)) return;
      reply.value = '';
      $('waSend').disabled = true;
      draw();
      demoToast('Demo only — not sent to WhatsApp.');
    });
  }

  function load() {
    try {
      state.items = freshCopy();
      $('waLoading').hidden = true;
      draw();
    } catch (err) {
      $('waLoading').hidden = true;
      $('waList').hidden = true;
      $('waError').hidden = false;
    }
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-whatsapp') return;
    $('waAssign').replaceChildren(...STAFF.map(s => { const o = el('option', null, s); o.value = s; return o; }));
    bind();
    load();
  }

  return { SAMPLE, STATUSES, STAFF, PHONE, filterChats, makeReply, sendDemo, freshCopy, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) InboxWhatsApp.init();
