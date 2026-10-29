/* ============================================================
   inbox-website-forms.js — Social Inbox › Website Forms
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/inbox-website-forms.html. It fills that
   page in from the FICTIONAL sample form submissions below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data),
       and in particular never reads the real website bookings that
       Appointments lists;
     - read or write browser storage;
     - make any request, or contact a form service, webhook or email
       service;
     - create a booking, appointment, customer, vehicle, CRM task or
       job card.

   Mark as read, Assign, the status change and internal notes all
   work on this page's in-memory copy of the samples, so a reload
   brings the page back as it was. All content is built with
   textContent -- nothing from the data is parsed as HTML.
   ============================================================ */

const InboxWebsiteForms = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  const STATUSES = ['Open', 'Pending', 'Resolved'];
  const SERVICES = ['AC service', 'Engine repair', 'LPG/CNG conversion', 'Hybrid service', 'Car detailing'];
  // Fictional staff for the Assign menu -- not read from the staff roster.
  const STAFF = ['Unassigned', 'Demo Advisor A', 'Demo Advisor B', 'Demo Mechanic C'];
  // The only contact details shown anywhere: placeholders that reach no one.
  const PHONE = '+880 1X-XXX-XXXX';
  const EMAIL = 'customer@example.invalid';
  const NOTE_LABEL = 'Demo note — not saved, not sent';

  // Eight sample submissions, newest first. Every name ends in "(Demo)",
  // every vehicle is "(sample)", and every reference and registration
  // carries DEMO, so none can be mistaken for a real booking.
  const SAMPLE = [
    { id: 'DEMO-FORM-008', name: 'Rafiq Islam (Demo)', status: 'Open', unread: true, assignee: 'Unassigned',
      submitted: '29 Oct, 10:40 AM (sample)', form: 'Service request form', service: 'AC service', preferred: 'Saturday morning (sample)',
      make: 'Toyota', model: 'Axio (sample)', year: '2016', reg: 'DEMO-REG-008',
      message: 'The AC is not cooling well in traffic. I would like a full AC check and gas top-up if needed.', notes: [] },
    { id: 'DEMO-FORM-007', name: 'Sharmin Akter (Demo)', status: 'Open', unread: true, assignee: 'Demo Advisor A',
      submitted: '29 Oct, 9:05 AM (sample)', form: 'Quote request form', service: 'Hybrid service', preferred: 'Next week (sample)',
      make: 'Toyota', model: 'Aqua (sample)', year: '2015', reg: 'DEMO-REG-007',
      message: 'Hybrid warning light comes on sometimes. Please quote for a hybrid battery health check.', notes: [] },
    { id: 'DEMO-FORM-006', name: 'Habib Rahman (Demo)', status: 'Pending', unread: false, assignee: 'Demo Mechanic C',
      submitted: '28 Oct, 5:30 PM (sample)', form: 'Quote request form', service: 'LPG/CNG conversion', preferred: 'Flexible (sample)',
      make: 'Toyota', model: 'Premio (sample)', year: '2012', reg: 'DEMO-REG-006',
      message: 'How much would a CNG conversion cost, and how long does it take?',
      notes: [{ at: '28 Oct, 6:00 PM (sample)', by: 'Demo Mechanic C', text: 'Sample note: needs a cylinder size check before quoting.' }] },
    { id: 'DEMO-FORM-005', name: 'Taslima Khatun (Demo)', status: 'Open', unread: true, assignee: 'Unassigned',
      submitted: '28 Oct, 11:15 AM (sample)', form: 'Service request form', service: 'Engine repair', preferred: 'As soon as possible (sample)',
      make: 'Honda', model: 'Civic (sample)', year: '2014', reg: 'DEMO-REG-005',
      message: 'Engine is making a knocking sound when cold. Can someone look at it this week?', notes: [] },
    { id: 'DEMO-FORM-004', name: 'Noman Chowdhury (Demo)', status: 'Resolved', unread: false, assignee: 'Demo Advisor B',
      submitted: '27 Oct, 3:20 PM (sample)', form: 'Contact form', service: 'Car detailing', preferred: 'Friday afternoon (sample)',
      make: 'Mitsubishi', model: 'Pajero (sample)', year: '2018', reg: 'DEMO-REG-004',
      message: 'Do you offer interior and exterior detailing as one package?',
      notes: [{ at: '27 Oct, 4:00 PM (sample)', by: 'Demo Advisor B', text: 'Sample note: answered by phone, customer will visit later.' }] },
    { id: 'DEMO-FORM-003', name: 'Rehana Parvin (Demo)', status: 'Pending', unread: false, assignee: 'Demo Advisor A',
      submitted: '26 Oct, 1:45 PM (sample)', form: 'Service request form', service: 'AC service', preferred: 'Sunday (sample)',
      make: 'Suzuki', model: 'Swift (sample)', year: '2019', reg: 'DEMO-REG-003',
      message: 'AC makes a rattling noise when switched on.', notes: [] },
    { id: 'DEMO-FORM-002', name: 'Fahim Ahmed (Demo)', status: 'Open', unread: false, assignee: 'Demo Mechanic C',
      submitted: '25 Oct, 8:10 PM (sample)', form: 'Quote request form', service: 'Engine repair', preferred: 'Next month (sample)',
      make: 'Nissan', model: 'X-Trail (sample)', year: '2013', reg: 'DEMO-REG-002',
      message: 'Oil leak under the engine. Please give a rough estimate for the repair.', notes: [] },
    { id: 'DEMO-FORM-001', name: 'Moushumi Das (Demo)', status: 'Resolved', unread: false, assignee: 'Demo Advisor B',
      submitted: '24 Oct, 10:00 AM (sample)', form: 'Contact form', service: 'Car detailing', preferred: 'Weekend (sample)',
      make: 'Honda', model: 'Vezel (sample)', year: '2017', reg: 'DEMO-REG-001',
      message: 'Thank you for the quick reply about the ceramic coating.', notes: [] },
  ];

  /* ---------- pure helpers (testable on their own) ---------- */

  const vehicleOf = s => `${s.make} ${s.model}`;

  /**
   * Submissions matching a filter ('all', 'unread' or a status) and a search
   * text: customer name, service, vehicle, registration or reference.
   */
  function filterSubmissions(list, filter, query) {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(s => {
      if (filter === 'unread' && !s.unread) return false;
      if (STATUSES.includes(filter) && s.status !== filter) return false;
      if (!q) return true;
      return [s.name, s.service, vehicleOf(s), s.reg, s.id].some(v => v.toLowerCase().includes(q));
    });
  }

  /** Add an internal demo note in place; returns the note, or null if blank. Never saved or sent. */
  function addDemoNote(sub, text) {
    const t = String(text || '').trim().slice(0, 500);
    if (!sub || !t) return null;
    const note = { at: 'Just now', by: sub.assignee && sub.assignee !== 'Unassigned' ? sub.assignee : 'You (demo)', text: t, demo: true };
    sub.notes.push(note);
    return note;
  }

  /** A fresh, deep copy of the samples: what a reload starts from. */
  const freshCopy = () => SAMPLE.map(s => Object.assign({}, s, { notes: s.notes.map(n => Object.assign({}, n)) }));

  /* ---------- rendering ---------- */

  const state = { items: [], filter: 'all', query: '', selected: null };
  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const selected = () => state.items.find(x => x.id === state.selected);

  function rowNode(s) {
    const li = el('li');
    const btn = el('button', `wf-row${s.unread ? ' is-unread' : ''}${s.id === state.selected ? ' is-selected' : ''}`);
    btn.type = 'button';
    btn.dataset.id = s.id;
    if (s.id === state.selected) btn.setAttribute('aria-current', 'true');
    btn.setAttribute('aria-label', `${s.name}, ${s.service}, ${s.id}, ${s.status}${s.unread ? ', unread' : ''}`);

    const body = el('span', 'wf-row__body');
    const top = el('span', 'wf-row__top');
    top.appendChild(el('span', 'wf-row__name', s.name));
    if (s.unread) {
      const dot = el('span', 'wf-dot');
      dot.setAttribute('aria-hidden', 'true');
      top.appendChild(dot);
    }
    body.appendChild(top);
    body.appendChild(el('span', 'wf-row__service', `${s.service} · ${vehicleOf(s)}`));
    body.appendChild(el('span', 'wf-row__preview', s.message));
    const meta = el('span', 'wf-row__meta');
    meta.appendChild(el('span', 'wf-row__ref', s.id));
    meta.appendChild(el('span', `wf-status wf-status--${s.status.toLowerCase()}`, s.status));
    body.appendChild(meta);
    body.appendChild(el('span', 'wf-row__when', s.submitted));
    btn.appendChild(body);

    li.appendChild(btn);
    return li;
  }

  function noteNode(n) {
    const li = el('li', `wf-note${n.demo ? ' is-demo' : ''}`);
    li.appendChild(el('p', 'wf-note__text', n.text));
    li.appendChild(el('span', 'wf-note__meta', `${n.by} · ${n.at}`));
    if (n.demo) li.appendChild(el('span', 'wf-note__demo', NOTE_LABEL));
    return li;
  }

  function drawDetail() {
    const s = selected();
    $('wfShell').classList.toggle('has-selection', !!s);
    $('wfNone').hidden = !!s;
    $('wfDetail').hidden = !s;
    $('wfInfo').hidden = !s;
    if (!s) return;
    $('wfDetailTitle').textContent = `${s.service} request`;
    $('wfDetailMeta').textContent = `${s.name} · ${s.id} · ${s.status}`;
    $('wfMarkRead').disabled = !s.unread;
    $('wfRef').textContent = s.id;
    $('wfWhen').textContent = s.submitted;
    $('wfForm').textContent = s.form;
    $('wfService').textContent = s.service;
    $('wfPreferred').textContent = s.preferred;
    $('wfMessage').textContent = s.message;
    $('wfNotes').replaceChildren(...s.notes.map(noteNode));
    $('wfNotes').hidden = !s.notes.length;
    $('wfNotesEmpty').hidden = !!s.notes.length;
    $('wfInfoName').textContent = s.name;
    $('wfInfoPhone').textContent = PHONE;
    $('wfInfoEmail').textContent = EMAIL;
    $('wfInfoVehicle').textContent = vehicleOf(s);
    $('wfInfoYear').textContent = `${s.year} (sample)`;
    $('wfInfoReg').textContent = s.reg;
    $('wfAssign').value = s.assignee;
    $('wfStatus').value = s.status;
  }

  function drawList() {
    const shown = filterSubmissions(state.items, state.filter, state.query);
    const none = !state.items.length;
    $('wfNoItems').hidden = !none;
    $('wfList').hidden = none || !shown.length;
    $('wfEmpty').hidden = none || !!shown.length;
    $('wfList').replaceChildren(...shown.map(rowNode));
    const unread = state.items.filter(s => s.unread).length;
    $('wfFoot').textContent = `${shown.length} of ${state.items.length} sample submissions · ${unread} unread`;
    document.querySelectorAll('.wf-chip').forEach(b => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-count]').forEach(c => {
      c.textContent = String(filterSubmissions(state.items, c.dataset.count, '').length);
    });
  }

  function draw() { drawList(); drawDetail(); }

  const demoToast = msg => { if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(msg, 'success'); };

  function bind() {
    document.querySelector('.wf-filters').addEventListener('click', e => {
      const b = e.target.closest('.wf-chip');
      if (!b) return;
      state.filter = b.dataset.filter;
      drawList();
    });
    $('wfSearch').addEventListener('input', e => { state.query = e.target.value; drawList(); });
    $('wfClear').addEventListener('click', () => {
      state.filter = 'all'; state.query = ''; $('wfSearch').value = '';
      drawList();
    });
    // Opening a submission shows it; it does not mark it read -- that is its own action.
    $('wfList').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      state.selected = b.dataset.id;
      draw();
      $('wfDetailTitle').focus();
    });
    $('wfBack').addEventListener('click', () => {
      const id = state.selected;
      state.selected = null;
      draw();
      const row = document.querySelector(`.wf-row[data-id="${id}"]`);
      if (row) row.focus();
    });
    $('wfMarkRead').addEventListener('click', () => {
      const s = selected();
      if (!s || !s.unread) return;
      s.unread = false;
      draw();
      demoToast('Marked as read (demo only).');
    });
    $('wfAssign').addEventListener('change', e => {
      const s = selected();
      if (!s) return;
      s.assignee = e.target.value;
      draw();
      demoToast(s.assignee === 'Unassigned' ? 'Unassigned (demo only).' : `Assigned to ${s.assignee} (demo only).`);
    });
    $('wfStatus').addEventListener('change', e => {
      const s = selected();
      if (!s) return;
      s.status = e.target.value;
      draw();
      demoToast(`Status set to ${s.status} (demo only). No booking was created.`);
    });
    const note = $('wfNote');
    note.addEventListener('input', () => { $('wfAddNote').disabled = !note.value.trim(); });
    $('wfNoteForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!addDemoNote(selected(), note.value)) return;
      note.value = '';
      $('wfAddNote').disabled = true;
      draw();
      demoToast('Demo note added. It is not saved or sent.');
    });
  }

  function load() {
    try {
      state.items = freshCopy();
      $('wfLoading').hidden = true;
      draw();
    } catch (err) {
      $('wfLoading').hidden = true;
      $('wfList').hidden = true;
      $('wfError').hidden = false;
    }
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-website-forms') return;
    $('wfAssign').replaceChildren(...STAFF.map(s => { const o = el('option', null, s); o.value = s; return o; }));
    $('wfDetailTitle').tabIndex = -1;
    bind();
    load();
  }

  return {
    SAMPLE, STATUSES, SERVICES, STAFF, PHONE, EMAIL, NOTE_LABEL,
    filterSubmissions, addDemoNote, freshCopy, init,
  };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) InboxWebsiteForms.init();
