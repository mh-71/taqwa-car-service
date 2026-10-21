/* ============================================================
   notifications-ui.js — Notifications Center (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/notifications.html. It fills that page in
   from the SAMPLE notifications below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request, poll, or send e-mail, SMS or push messages.

   Filters, search and "Mark as read" work on the sample list in
   memory only, so a reload brings the page back as it was. All
   content is built with textContent -- nothing from the data is
   parsed as HTML.
   ============================================================ */

const NotificationsUI = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  const ICONS = {
    alert:    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    car:      'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z',
    people:   'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    box:      'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    invoice:  'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    wrench:   'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z',
    gear:     'M19.1 12.9c0-.3.1-.6.1-.9s0-.6-.1-.9l2-1.6c.2-.1.2-.4.1-.6l-1.9-3.3c-.1-.2-.4-.3-.6-.2l-2.4 1c-.5-.4-1-.7-1.6-.9l-.4-2.5c0-.2-.2-.4-.5-.4h-3.8c-.2 0-.4.2-.5.4l-.4 2.5c-.6.2-1.1.6-1.6.9l-2.4-1c-.2-.1-.5 0-.6.2L2.6 9c-.1.2-.1.4.1.6l2 1.6c0 .3-.1.6-.1.9s0 .6.1.9l-2 1.6c-.2.1-.2.4-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6.9l.4 2.5c0 .2.2.4.5.4h3.8c.2 0 .4-.2.5-.4l.4-2.5c.6-.2 1.1-.6 1.6-.9l2.4 1c.2.1.5 0 .6-.2l1.9-3.3c.1-.2.1-.4-.1-.6l-2-1.6zM12 15.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z',
    card:     'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    clock:    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  };

  const CATEGORIES = ['Workshop', 'Finance', 'Staff', 'System'];

  // Eight sample notifications, newest first: three unread, two important (the
  // summary cards say 3 unread and 2 important). Reference numbers carry DEMO,
  // so none can be mistaken for a real invoice or job card.
  const SAMPLE = [
    { id: 'n1', icon: 'alert',   category: 'Finance',  important: true,  unread: true,  when: '10 minutes ago',
      title: 'Pending Payment Reminder', text: 'Invoice #DEMO-INV-1024 still has a balance due. Please follow up with the customer.' },
    { id: 'n2', icon: 'car',     category: 'Workshop', important: false, unread: true,  when: '25 minutes ago',
      title: 'Vehicle Service Completed', text: 'Job card #DEMO-JC-1042 is completed and the vehicle is ready for delivery.' },
    { id: 'n3', icon: 'people',  category: 'Staff',    important: false, unread: true,  when: '1 hour ago',
      title: 'Leave Request Submitted', text: 'A staff member has submitted a casual leave request for review.' },
    { id: 'n4', icon: 'box',     category: 'Workshop', important: true,  unread: false, when: '2 hours ago',
      title: 'Low Stock Alert', text: 'Engine oil 5W-30 (sample part) is below its reorder level.' },
    { id: 'n5', icon: 'invoice', category: 'Finance',  important: false, unread: false, when: '3 hours ago',
      title: 'New Invoice Generated', text: 'Invoice #DEMO-INV-1025 has been generated for a completed job card.' },
    { id: 'n6', icon: 'wrench',  category: 'Workshop', important: false, unread: false, when: '5 hours ago',
      title: 'Service Due Soon', text: 'A sample customer vehicle is due for its periodic service in 5 days.' },
    { id: 'n7', icon: 'gear',    category: 'System',   important: false, unread: false, when: 'Yesterday',
      title: 'System Update Notice', text: 'Example notice: the system will be updated during a scheduled maintenance window.' },
    { id: 'n8', icon: 'card',    category: 'Finance',  important: false, unread: false, when: '2 days ago',
      title: 'Payment Received', text: 'A payment was recorded against invoice #DEMO-INV-1019.' },
  ];
  // The sample period the Total card speaks for; the list shows only the most recent.
  const SAMPLE_TOTAL = 24;

  /* ---------- filtering (pure, so it can be tested on its own) ---------- */

  /** The sample notifications that match a filter ('all', 'unread' or a category) and a search text. */
  function filterNotifications(list, filter, query) {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(n => {
      if (filter === 'unread' && !n.unread) return false;
      if (CATEGORIES.includes(filter) && n.category !== filter) return false;
      if (!q) return true;
      return [n.title, n.text, n.category].some(s => s.toLowerCase().includes(q));
    });
  }

  /* ---------- rendering ---------- */

  const state = { items: SAMPLE.map(n => Object.assign({}, n)), filter: 'all', query: '' };
  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgIcon(name, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function itemNode(n) {
    const cat = n.category.toLowerCase();
    const li = el('li', `ntf-item${n.unread ? ' is-unread' : ''}${n.important ? ' is-important' : ''}`);
    li.dataset.id = n.id;

    const icon = el('span', `ntf-item__icon ntf-tone--${n.important ? 'important' : cat}`);
    icon.appendChild(svgIcon(n.icon, 22));
    li.appendChild(icon);

    const body = el('div', 'ntf-item__body');
    const top = el('div', 'ntf-item__top');
    top.appendChild(el('h3', 'ntf-item__title', n.title));
    if (n.important) top.appendChild(el('span', 'badge badge--bad', 'Important'));
    body.appendChild(top);
    body.appendChild(el('p', 'ntf-item__text', n.text));
    const meta = el('p', 'ntf-item__meta');
    meta.appendChild(svgIcon('clock', 14));
    meta.appendChild(el('span', null, n.when));
    meta.appendChild(el('span', 'ntf-item__sep', '·'));
    meta.appendChild(el('span', null, n.category));
    body.appendChild(meta);
    li.appendChild(body);

    const side = el('div', 'ntf-item__side');
    side.appendChild(el('span', `ntf-cat ntf-tone--${cat}`, n.category));
    if (n.unread) {
      const dot = el('span', 'ntf-dot');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
      side.appendChild(dot);
      const btn = el('button', 'btn btn--ghost btn--sm ntf-read', 'Mark as read');
      btn.type = 'button';
      btn.dataset.read = n.id;
      side.appendChild(btn);
    } else {
      side.appendChild(el('span', 'ntf-state', 'Read'));
    }
    li.appendChild(side);
    return li;
  }

  function draw() {
    const shown = filterNotifications(state.items, state.filter, state.query);
    const list = $('ntfList');
    list.replaceChildren(...shown.map(itemNode));
    list.hidden = !shown.length;
    $('ntfEmpty').hidden = !!shown.length;
    $('ntfUnread').textContent = String(state.items.filter(n => n.unread).length);
    $('ntfFoot').textContent = state.filter === 'all' && !state.query.trim()
      ? `Showing the ${shown.length} most recent of ${SAMPLE_TOTAL} sample notifications`
      : `${shown.length} matching sample notification${shown.length === 1 ? '' : 's'}`;
    document.querySelectorAll('.ntf-filter').forEach(b => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function bind() {
    document.querySelector('.ntf-filters').addEventListener('click', e => {
      const b = e.target.closest('.ntf-filter');
      if (!b) return;
      state.filter = b.dataset.filter;
      draw();
    });
    $('ntfSearch').addEventListener('input', e => { state.query = e.target.value; draw(); });
    $('ntfClear').addEventListener('click', () => {
      state.filter = 'all'; state.query = ''; $('ntfSearch').value = '';
      draw();
    });
    // "Mark as read" changes this page's copy of the sample list only.
    $('ntfList').addEventListener('click', e => {
      const b = e.target.closest('[data-read]');
      if (!b) return;
      const n = state.items.find(x => x.id === b.dataset.read);
      if (n) n.unread = false;
      draw();
    });
  }

  function init() {
    if (document.body.dataset.page !== 'notifications') return;
    bind();
    draw();
    // The shell's header has no title for this page yet (js/app.js is not changed
    // by this demo), so give it one once the shell is drawn.
    if (typeof Storage !== 'undefined' && Storage.ready) {
      Storage.ready(() => {
        const h1 = document.querySelector('.topbar__title h1');
        if (h1) h1.textContent = 'Notifications Center';
      });
    }
  }

  return { SAMPLE, SAMPLE_TOTAL, CATEGORIES, filterNotifications, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) NotificationsUI.init();
