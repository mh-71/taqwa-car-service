/* ============================================================
   inbox-conversations.js — Social Inbox › All Conversations
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/inbox-conversations.html. It fills that
   page in from the FICTIONAL sample conversations below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request, or contact Facebook, WhatsApp, Meta or any
       website -- nothing is connected and nothing is sent.

   Send Reply, Mark as Read, Assign Staff and the status change all
   work on this page's in-memory copy of the samples, so a reload
   brings the page back as it was. All content is built with
   textContent -- nothing from the data is parsed as HTML.
   ============================================================ */

const InboxConversations = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  const CHANNELS = {
    facebook: { label: 'Facebook',      icon: 'M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.32l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07z' },
    whatsapp: { label: 'WhatsApp',      icon: 'M12 2C6.48 2 2 6.03 2 11c0 2.84 1.46 5.36 3.74 7L5 22l4.27-2.18c.87.12 1.79.18 2.73.18 5.52 0 10-4.03 10-9S17.52 2 12 2z' },
    website:  { label: 'Website Forms', icon: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z' },
  };
  const STATUSES = ['Open', 'Pending', 'Resolved'];

  // Fictional staff for the Assign menu -- not read from the staff roster.
  const STAFF = ['Unassigned', 'Demo Advisor A', 'Demo Advisor B', 'Demo Mechanic C'];

  // Eight sample conversations, newest first. Every name ends in "(Demo)",
  // phone-like details are omitted, and reference numbers carry DEMO, so
  // nothing can be mistaken for a real customer, job card or booking.
  const SAMPLE = [
    { id: 'c1', channel: 'whatsapp', name: 'Rahim Uddin (Demo)', status: 'Open', unread: 2, assignee: 'Unassigned', when: '10:42 AM',
      vehicle: 'Toyota Axio (sample)',
      messages: [
        { from: 'customer', at: '10:38 AM', text: 'Assalamu alaikum. My car is making a noise when I brake.' },
        { from: 'customer', at: '10:42 AM', text: 'Can I bring it in tomorrow morning?' },
      ] },
    { id: 'c2', channel: 'facebook', name: 'Nusrat Jahan (Demo)', status: 'Open', unread: 1, assignee: 'Demo Advisor A', when: '9:15 AM',
      vehicle: 'Honda Fit (sample)',
      messages: [
        { from: 'customer', at: '9:02 AM', text: 'How much is a full engine oil change?' },
        { from: 'staff',    at: '9:10 AM', text: 'Thank you for asking. It depends on the oil grade. Which car do you have?', by: 'Demo Advisor A' },
        { from: 'customer', at: '9:15 AM', text: 'Honda Fit 2016.' },
      ] },
    { id: 'c3', channel: 'website', name: 'Karim Hossain (Demo)', status: 'Pending', unread: 1, assignee: 'Unassigned', when: 'Yesterday',
      vehicle: 'Nissan X-Trail (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 6:20 PM', text: 'Website form: I would like a quotation for AC servicing. Reference DEMO-WEB-0042.' },
      ] },
    { id: 'c4', channel: 'whatsapp', name: 'Farhana Akter (Demo)', status: 'Pending', unread: 0, assignee: 'Demo Mechanic C', when: 'Yesterday',
      vehicle: 'Toyota Premio (sample)',
      messages: [
        { from: 'customer', at: 'Yesterday, 2:05 PM', text: 'Is my car ready? Job card DEMO-JC-1042.' },
        { from: 'staff',    at: 'Yesterday, 2:30 PM', text: 'We are waiting for one part. We will update you by this evening.', by: 'Demo Mechanic C' },
      ] },
    { id: 'c5', channel: 'facebook', name: 'Tanvir Ahmed (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor B', when: 'Mon',
      vehicle: 'Mitsubishi Pajero (sample)',
      messages: [
        { from: 'customer', at: 'Mon, 11:00 AM', text: 'What time do you open on Friday?' },
        { from: 'staff',    at: 'Mon, 11:12 AM', text: 'This is sample text: we open after Jumu’ah prayer on Fridays.', by: 'Demo Advisor B' },
        { from: 'customer', at: 'Mon, 11:15 AM', text: 'Thank you!' },
      ] },
    { id: 'c6', channel: 'website', name: 'Sadia Islam (Demo)', status: 'Open', unread: 0, assignee: 'Demo Advisor A', when: 'Sun',
      vehicle: 'Suzuki Swift (sample)',
      messages: [
        { from: 'customer', at: 'Sun, 4:40 PM', text: 'Website form: please call me about wheel alignment and balancing.' },
        { from: 'staff',    at: 'Sun, 5:00 PM', text: 'Thank you. An advisor will contact you during working hours.', by: 'Demo Advisor A' },
      ] },
    { id: 'c7', channel: 'whatsapp', name: 'Mahmud Hasan (Demo)', status: 'Resolved', unread: 0, assignee: 'Demo Advisor B', when: 'Sat',
      vehicle: 'Toyota Corolla (sample)',
      messages: [
        { from: 'customer', at: 'Sat, 10:10 AM', text: 'Got the car back, it drives well now. Thanks.' },
      ] },
    { id: 'c8', channel: 'facebook', name: 'Ayesha Rahman (Demo)', status: 'Open', unread: 3, assignee: 'Unassigned', when: 'Fri',
      vehicle: 'Honda Vezel (sample)',
      messages: [
        { from: 'customer', at: 'Fri, 8:01 PM', text: 'Hello?' },
        { from: 'customer', at: 'Fri, 8:02 PM', text: 'Do you do hybrid battery checks?' },
        { from: 'customer', at: 'Fri, 8:05 PM', text: 'I can come on Saturday.' },
      ] },
  ];

  /* ---------- filtering (pure, so it can be tested on its own) ---------- */

  /** Conversations matching a channel ('all' or a key), a status ('all', 'unread' or a status) and a search text. */
  function filterConversations(list, channel, status, query) {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(c => {
      if (channel !== 'all' && c.channel !== channel) return false;
      if (status === 'unread' && !c.unread) return false;
      if (STATUSES.includes(status) && c.status !== status) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.messages.some(m => m.text.toLowerCase().includes(q));
    });
  }

  /** A demo reply: trimmed, capped, and refused when blank. Returns the message or null. */
  function makeReply(text, by) {
    const t = String(text || '').trim().slice(0, 1000);
    if (!t) return null;
    return { from: 'staff', at: 'Just now', text: t, by: by && by !== 'Unassigned' ? by : 'You (demo)', demo: true };
  }

  /* ---------- rendering ---------- */

  const state = { items: [], channel: 'all', status: 'all', query: '', selected: null };
  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgIcon(d, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  const initials = name => name.replace(/\(Demo\)/, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const lastMessage = c => c.messages[c.messages.length - 1];

  function rowNode(c) {
    const ch = CHANNELS[c.channel];
    const li = el('li', 'inb-row-wrap');
    const btn = el('button', `inb-row${c.unread ? ' is-unread' : ''}${c.id === state.selected ? ' is-selected' : ''}`);
    btn.type = 'button';
    btn.dataset.id = c.id;
    if (c.id === state.selected) btn.setAttribute('aria-current', 'true');

    const av = el('span', 'inb-avatar', initials(c.name));
    av.setAttribute('aria-hidden', 'true');
    const badge = el('span', `inb-ch inb-ch--${c.channel}`);
    badge.appendChild(svgIcon(ch.icon, 11));
    av.appendChild(badge);
    btn.appendChild(av);

    const body = el('span', 'inb-row__body');
    const top = el('span', 'inb-row__top');
    top.appendChild(el('span', 'inb-row__name', c.name));
    top.appendChild(el('span', 'inb-row__when', c.when));
    body.appendChild(top);
    const last = lastMessage(c);
    body.appendChild(el('span', 'inb-row__preview', (last.from === 'staff' ? 'You: ' : '') + last.text));
    const meta = el('span', 'inb-row__meta');
    meta.appendChild(el('span', `inb-chan inb-chan--${c.channel}`, ch.label));
    meta.appendChild(el('span', `inb-status inb-status--${c.status.toLowerCase()}`, c.status));
    body.appendChild(meta);
    btn.appendChild(body);

    if (c.unread) {
      const n = el('span', 'inb-unread', String(c.unread));
      n.setAttribute('aria-label', `${c.unread} unread`);
      btn.appendChild(n);
    }
    btn.setAttribute('aria-label', `${c.name}, ${ch.label}, ${c.status}${c.unread ? `, ${c.unread} unread` : ''}, ${c.when}`);
    li.appendChild(btn);
    return li;
  }

  function messageNode(m) {
    const li = el('li', `inb-msg inb-msg--${m.from === 'staff' ? 'out' : 'in'}`);
    li.appendChild(el('p', 'inb-msg__text', m.text));
    const meta = el('span', 'inb-msg__meta', m.from === 'staff' ? `${m.by || 'Staff'} · ${m.at}` : m.at);
    if (m.demo) meta.appendChild(el('span', 'inb-msg__demo', 'Demo, not sent'));
    li.appendChild(meta);
    return li;
  }

  function drawDetail() {
    const c = state.items.find(x => x.id === state.selected);
    $('inbShell').classList.toggle('has-selection', !!c);
    $('inbNone').hidden = !!c;
    $('inbConvo').hidden = !c;
    if (!c) return;
    const ch = CHANNELS[c.channel];
    $('inbConvoAvatar').textContent = initials(c.name);
    $('inbConvoName').textContent = c.name;
    $('inbConvoMeta').textContent = `${ch.label} · ${c.vehicle} · ${c.status}`;
    $('inbAssign').value = c.assignee;
    $('inbConvoStatus').value = c.status;
    $('inbMarkRead').disabled = !c.unread;
    $('inbThread').replaceChildren(...c.messages.map(messageNode));
    const thread = $('inbThread');
    thread.scrollTop = thread.scrollHeight;
  }

  function drawList() {
    const shown = filterConversations(state.items, state.channel, state.status, state.query);
    const list = $('inbList');
    list.replaceChildren(...shown.map(rowNode));
    list.hidden = !shown.length;
    $('inbEmpty').hidden = !!shown.length;
    const unread = state.items.reduce((n, c) => n + (c.unread ? 1 : 0), 0);
    $('inbFoot').textContent = `${shown.length} of ${state.items.length} sample conversations · ${unread} unread`;
    document.querySelectorAll('.inb-chip').forEach(b => {
      const on = b.dataset.channel === state.channel;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-count]').forEach(s => {
      const key = s.dataset.count;
      s.textContent = String(state.items.filter(c => key === 'all' || c.channel === key).length);
    });
  }

  function draw() { drawList(); drawDetail(); }

  const selected = () => state.items.find(x => x.id === state.selected);
  const demoToast = msg => { if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(msg, 'success'); };

  function bind() {
    document.querySelector('.inb-channels').addEventListener('click', e => {
      const b = e.target.closest('.inb-chip');
      if (!b) return;
      state.channel = b.dataset.channel;
      drawList();
    });
    $('inbSearch').addEventListener('input', e => { state.query = e.target.value; drawList(); });
    $('inbStatus').addEventListener('change', e => { state.status = e.target.value; drawList(); });
    $('inbClear').addEventListener('click', () => {
      state.channel = 'all'; state.status = 'all'; state.query = '';
      $('inbSearch').value = ''; $('inbStatus').value = 'all';
      drawList();
    });
    $('inbList').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      state.selected = b.dataset.id;
      draw();
      $('inbReply').focus();
    });
    $('inbBack').addEventListener('click', () => {
      const id = state.selected;
      state.selected = null;
      draw();
      const row = document.querySelector(`.inb-row[data-id="${id}"]`);
      if (row) row.focus();
    });
    $('inbMarkRead').addEventListener('click', () => {
      const c = selected();
      if (!c || !c.unread) return;
      c.unread = 0;
      draw();
      demoToast('Marked as read (demo only).');
    });
    $('inbAssign').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.assignee = e.target.value;
      drawList();
      demoToast(c.assignee === 'Unassigned' ? 'Unassigned (demo only).' : `Assigned to ${c.assignee} (demo only).`);
    });
    $('inbConvoStatus').addEventListener('change', e => {
      const c = selected();
      if (!c) return;
      c.status = e.target.value;
      draw();
      demoToast(`Status set to ${c.status} (demo only).`);
    });
    const reply = $('inbReply');
    reply.addEventListener('input', () => { $('inbSend').disabled = !reply.value.trim(); });
    reply.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('inbComposer').requestSubmit(); }
    });
    // "Send Reply" adds the reply to this page's copy of the sample only. Nothing is sent.
    $('inbComposer').addEventListener('submit', e => {
      e.preventDefault();
      const c = selected();
      const m = c && makeReply(reply.value, c.assignee);
      if (!m) return;
      c.messages.push(m);
      c.unread = 0;
      c.when = 'Just now';
      reply.value = '';
      $('inbSend').disabled = true;
      draw();
      demoToast('Demo reply added. Nothing was sent to the customer.');
    });
  }

  function load() {
    try {
      state.items = SAMPLE.map(c => Object.assign({}, c, { messages: c.messages.map(m => Object.assign({}, m)) }));
      $('inbLoading').hidden = true;
      draw();
    } catch (err) {
      $('inbLoading').hidden = true;
      $('inbList').hidden = true;
      $('inbError').hidden = false;
    }
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-conversations') return;
    $('inbAssign').replaceChildren(...STAFF.map(s => { const o = el('option', null, s); o.value = s; return o; }));
    bind();
    load();
  }

  return { SAMPLE, CHANNELS, STATUSES, STAFF, filterConversations, makeReply, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) InboxConversations.init();
