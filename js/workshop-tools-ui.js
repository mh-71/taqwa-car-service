/* ============================================================
   workshop-tools-ui.js — Workshop Tools & Equipment (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/workshop-tools.html. It fills that page in
   from the SAMPLE tools below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request or send anything.

   Search, the filters and the action menus work on the sample list in
   memory; "Add New Tool" and every row action only say they are not
   available yet. Export builds a CSV of the shown sample rows in the
   browser and hands it to the download, nothing more. All content is
   built with textContent -- nothing from the data is parsed as HTML.
   ============================================================ */

const WorkshopToolsUI = (() => {

  /* ---------- sample data (clearly fictional; never saved) ---------- */

  // Stroke icons (24-unit, Lucide style) drawn as tool thumbnails: [tag, attributes] per shape.
  const THUMBS = {
    scanner: [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['rect', { x: 8, y: 5, width: 8, height: 6, rx: 1 }],
      ['path', { d: 'M9 15h.01M12 15h.01M15 15h.01M9 18h6' }]],
    meter: [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['rect', { x: 8, y: 5, width: 8, height: 4, rx: 1 }],
      ['circle', { cx: 12, cy: 15.5, r: 3 }], ['path', { d: 'M12 15.5l1.6-1.6' }]],
    jack: [['path', { d: 'M2 18h14' }], ['circle', { cx: 5, cy: 18, r: 2 }], ['circle', { cx: 13, cy: 18, r: 2 }],
      ['path', { d: 'M8 16l7-9 4 2' }], ['path', { d: 'M18 8l2-3h2' }]],
    wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
    battery: [['path', { d: 'M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1' }],
      ['path', { d: 'm11 7-3 5h4l-3 5' }], ['path', { d: 'M22 11v2' }]],
    gauge: [['path', { d: 'm12 14 4-4' }], ['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }]],
  };

  const CATEGORIES = ['Diagnostic', 'Electrical', 'Lifting', 'Hand Tools', 'Engine Tools'];
  const STATUSES = ['Available', 'In Use', 'Maintenance'];

  // Six sample tools, as in the reference design. "inStock / total" is the quantity column.
  const SAMPLE = [
    { code: 'TL-001', name: 'OBD-II Scanner', desc: 'Professional diagnostic scanner', category: 'Diagnostic', thumb: 'scanner',
      inStock: 2, total: 3, assignee: 'Rahim Uddin', role: 'Mechanic', condition: 'Good', status: 'In Use' },
    { code: 'TL-002', name: 'Digital Multimeter', desc: 'Electrical testing equipment', category: 'Electrical', thumb: 'meter',
      inStock: 5, total: 5, assignee: null, role: null, condition: 'Good', status: 'Available' },
    { code: 'TL-003', name: 'Hydraulic Floor Jack', desc: '3 Ton capacity', category: 'Lifting', thumb: 'jack',
      inStock: 3, total: 4, assignee: 'Karim Sheikh', role: 'Mechanic', condition: 'Needs Service', status: 'Maintenance' },
    { code: 'TL-004', name: 'Torque Wrench', desc: '1/2" Drive (20-200 Nm)', category: 'Hand Tools', thumb: 'wrench',
      inStock: 4, total: 4, assignee: null, role: null, condition: 'Good', status: 'Available' },
    { code: 'TL-005', name: 'Battery Tester', desc: '12V Battery Analyzer', category: 'Electrical', thumb: 'battery',
      inStock: 2, total: 2, assignee: 'Salim Ahmed', role: 'Mechanic', condition: 'Good', status: 'In Use' },
    { code: 'TL-006', name: 'Engine Compression Tester', desc: 'Petrol & Diesel', category: 'Engine Tools', thumb: 'gauge',
      inStock: 1, total: 2, assignee: null, role: null, condition: 'Good', status: 'Available' },
  ];

  // Maintenance due soon: days from today, so the sample never shows a date in the past.
  const DUE = [
    { code: 'TL-003', inDays: 3 },
    { code: 'TL-004', inDays: 7 },
  ];

  /* ---------- filtering (pure, so it can be tested on its own) ---------- */

  /** The sample tools that match a search text, a category, a status and a condition ('all' = any). */
  function filterTools(list, f) {
    const q = String(f.query || '').trim().toLowerCase();
    return list.filter(t => {
      if (f.category && f.category !== 'all' && t.category !== f.category) return false;
      if (f.status && f.status !== 'all' && t.status !== f.status) return false;
      if (f.condition && f.condition !== 'all' && t.condition !== f.condition) return false;
      if (!q) return true;
      return [t.name, t.desc, t.code, t.category].some(s => s.toLowerCase().includes(q));
    });
  }

  /** CSV of the given tools; every field quoted, so commas and quotes in the data stay intact. */
  function toCsv(list) {
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Tool Name', 'Description', 'Tool Code', 'Category', 'In Stock', 'Total', 'Assigned To', 'Condition', 'Status'];
    const rows = list.map(t => [t.name, t.desc, t.code, t.category, t.inStock, t.total, t.assignee || '', t.condition, t.status]);
    return [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- rendering ---------- */

  const state = { query: '', category: 'all', status: 'all', condition: 'all' };
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const MORE = 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z';
  const CHEVRON = 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z';
  const CALENDAR = 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function filledIcon(d, size) {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  function thumbIcon(name) {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 26, height: 26, fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
    for (const [tag, attrs] of THUMBS[name]) {
      const s = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
      svg.appendChild(s);
    }
    return svg;
  }

  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const initials = name => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  function cell(label, cls) {
    const td = el('td', cls);
    td.dataset.label = label;
    return td;
  }

  function rowNode(t) {
    const tr = el('tr');
    tr.dataset.code = t.code;

    const tool = cell('Tool Name', 'wt-c-tool');
    const toolWrap = el('span', 'wt-toolcell');
    const thumb = el('span', `wt-thumb wt-cat--${slug(t.category)}`);
    thumb.appendChild(thumbIcon(t.thumb));
    const names = el('span', 'wt-tool');
    names.appendChild(el('span', 'wt-tool__name', t.name));
    names.appendChild(el('span', 'wt-tool__desc', t.desc));
    toolWrap.appendChild(thumb); toolWrap.appendChild(names);
    tool.appendChild(toolWrap);
    tr.appendChild(tool);

    const code = cell('Tool Code', 'wt-c-code'); code.textContent = t.code; tr.appendChild(code);

    const cat = cell('Category', 'wt-c-cat');
    cat.appendChild(el('span', `wt-chip wt-cat--${slug(t.category)}`, t.category));
    tr.appendChild(cat);

    const qty = cell('Quantity', 'wt-c-qty');
    qty.textContent = `${t.inStock} / ${t.total}`;
    qty.title = `${t.inStock} in stock of ${t.total}`;
    tr.appendChild(qty);

    const who = cell('Assigned To', 'wt-c-who');
    if (t.assignee) {
      const wrap = el('span', 'wt-person');
      wrap.appendChild(el('span', 'wt-avatar', initials(t.assignee)));
      const txt = el('span', 'wt-person__text');
      txt.appendChild(el('span', 'wt-person__name', t.assignee));
      txt.appendChild(el('span', 'wt-person__role', t.role));
      wrap.appendChild(txt);
      who.appendChild(wrap);
    } else {
      const none = el('span', 'wt-none', '—');
      none.setAttribute('aria-label', 'Not assigned');
      who.appendChild(none);
    }
    tr.appendChild(who);

    const cond = cell('Condition', 'wt-c-cond');
    cond.appendChild(el('span', `wt-cond wt-cond--${slug(t.condition)}`, t.condition));
    tr.appendChild(cond);

    const st = cell('Status', 'wt-c-status');
    st.appendChild(el('span', `wt-status wt-status--${slug(t.status)}`, t.status));
    tr.appendChild(st);

    const act = cell('Actions', 'wt-c-actions');
    const btn = el('button', 'wt-more');
    btn.type = 'button';
    btn.dataset.row = t.code;
    btn.setAttribute('aria-label', `Actions for ${t.name}`);
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(filledIcon(MORE, 20));
    act.appendChild(btn);
    tr.appendChild(act);
    return tr;
  }

  function shown() { return filterTools(SAMPLE, state); }

  function draw() {
    const list = shown();
    $('wtBody').replaceChildren(...list.map(rowNode));
    $('wtEmpty').hidden = !!list.length;
    document.querySelector('.wt-table-wrap').hidden = !list.length;
    $('wtCount').textContent = list.length
      ? `Showing 1 to ${list.length} of ${list.length} tool${list.length === 1 ? '' : 's'}${list.length < SAMPLE.length ? ` (filtered from ${SAMPLE.length})` : ''}`
      : `No tools match (0 of ${SAMPLE.length})`;
    const active = ['category', 'status', 'condition'].filter(k => state[k] !== 'all').length;
    $('wtFiltersBtn').classList.toggle('is-active', state.condition !== 'all');
    $('wtFiltersBtn').setAttribute('aria-label', active ? `Filters (${active} active)` : 'Filters');
  }

  function drawDue() {
    const today = new Date();
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    $('wtDueList').replaceChildren(...DUE.map(({ code, inDays }) => {
      const t = SAMPLE.find(x => x.code === code);
      const when = new Date(today.getFullYear(), today.getMonth(), today.getDate() + inDays);
      const li = el('li');
      const b = el('button', 'wt-due__item');
      b.type = 'button';
      b.dataset.preview = `Maintenance details for ${t.name}`;
      const thumb = el('span', `wt-thumb wt-thumb--lg wt-cat--${slug(t.category)}`);
      thumb.appendChild(thumbIcon(t.thumb));
      const txt = el('span', 'wt-due__text');
      txt.appendChild(el('span', 'wt-due__name', t.name));
      txt.appendChild(el('span', 'wt-due__in', `Due in ${inDays} days`));
      const date = el('span', 'wt-due__date');
      date.appendChild(filledIcon(CALENDAR, 13));
      date.appendChild(el('span', null, fmt(when)));
      txt.appendChild(date);
      const chev = el('span', 'wt-due__chev');
      chev.appendChild(filledIcon(CHEVRON, 20));
      b.appendChild(thumb); b.appendChild(txt); b.appendChild(chev);
      li.appendChild(b);
      return li;
    }));
  }

  /* ---------- menus, the modal and export ---------- */

  let menuRow = null;   // the tool code whose action menu is open

  function closeMenus(except) {
    for (const [btnId, menuId] of [['wtFiltersBtn', 'wtFiltersPanel'], ['wtExportBtn', 'wtExportMenu']]) {
      if (menuId === except) continue;
      $(menuId).hidden = true;
      $(btnId).setAttribute('aria-expanded', 'false');
    }
    if (except !== 'wtRowMenu') {
      $('wtRowMenu').hidden = true;
      document.querySelectorAll('.wt-more[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      menuRow = null;
    }
  }

  function toggle(btnId, menuId) {
    const open = $(menuId).hidden;
    closeMenus(menuId);
    $(menuId).hidden = !open;
    $(btnId).setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = $(menuId).querySelector('select, button'); if (first) first.focus(); }
  }

  function openRowMenu(btn) {
    const code = btn.dataset.row;
    if (menuRow === code) { closeMenus(); return; }
    closeMenus();
    const menu = $('wtRowMenu');
    menu.hidden = false;
    const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
    btn.setAttribute('aria-expanded', 'true');
    menuRow = code;
    const first = menu.querySelector('button'); if (first) first.focus();
  }

  function say(label) {
    if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(`Preview only: "${label}" is not available yet. Nothing was saved or sent.`, 'info');
  }

  function openModal() {
    closeMenus();
    $('wtModal').hidden = false;
    document.body.classList.add('no-scroll');
    $('wtfName').focus();
  }
  function closeModal() {
    if ($('wtModal').hidden) return;
    $('wtModal').hidden = true;
    document.body.classList.remove('no-scroll');
    $('wtAdd').focus();
  }

  function exportCsv() {
    const blob = new Blob([toCsv(shown())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = 'workshop-tools-demo.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeMenus();
    if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast('Demo CSV downloaded: the shown sample rows only.', 'info');
  }

  function clearFilters() {
    Object.assign(state, { query: '', category: 'all', status: 'all', condition: 'all' });
    $('wtSearch').value = ''; $('wtCategory').value = 'all'; $('wtStatus').value = 'all'; $('wtCondition').value = 'all';
    closeMenus();
    draw();
  }

  function bind() {
    $('wtSearch').addEventListener('input', e => { state.query = e.target.value; draw(); });
    $('wtCategory').addEventListener('change', e => { state.category = e.target.value; draw(); });
    $('wtStatus').addEventListener('change', e => { state.status = e.target.value; draw(); });
    $('wtCondition').addEventListener('change', e => { state.condition = e.target.value; draw(); });
    $('wtClear').addEventListener('click', clearFilters);
    $('wtEmptyClear').addEventListener('click', clearFilters);
    $('wtFiltersBtn').addEventListener('click', () => toggle('wtFiltersBtn', 'wtFiltersPanel'));
    $('wtExportBtn').addEventListener('click', () => toggle('wtExportBtn', 'wtExportMenu'));
    $('wtExportCsv').addEventListener('click', exportCsv);
    $('wtBody').addEventListener('click', e => { const b = e.target.closest('.wt-more'); if (b) openRowMenu(b); });
    $('wtRowMenu').addEventListener('click', e => {
      const b = e.target.closest('[data-preview]');
      if (!b) return;
      const t = SAMPLE.find(x => x.code === menuRow);
      closeMenus();
      say(`${b.dataset.preview}${t ? ` (${t.name})` : ''}`);
    });
    $('wtDueList').addEventListener('click', e => { const b = e.target.closest('[data-preview]'); if (b) say(b.dataset.preview); });
    $('wtDueAll').addEventListener('click', () => say('All maintenance due'));
    $('wtAdd').addEventListener('click', openModal);
    $('wtModal').addEventListener('click', e => { if (e.target === $('wtModal') || e.target.closest('[data-wt-close]')) closeModal(); });
    $('wtModalSave').addEventListener('click', () => { closeModal(); say('Save Tool'); });
    // Close what is open: a click elsewhere, Escape, or the page moving under a floating menu.
    document.addEventListener('click', e => {
      if (!e.target.closest('.wt-pop, .wt-more, #wtRowMenu')) closeMenus();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('wtModal').hidden) closeModal(); else closeMenus();
    });
    window.addEventListener('resize', () => closeMenus());
    window.addEventListener('scroll', () => { if (menuRow) closeMenus(); }, true);
  }

  function init() {
    if (document.body.dataset.page !== 'workshop-tools') return;
    bind();
    drawDue();
    draw();
    // The shell's header has no title for this page (js/app.js is not changed by this demo),
    // so give it one once the shell is drawn.
    if (typeof Storage !== 'undefined' && Storage.ready) {
      Storage.ready(() => {
        const h1 = document.querySelector('.topbar__title h1');
        if (h1) h1.textContent = 'Workshop Tools & Equipment';
      });
    }
  }

  return { SAMPLE, CATEGORIES, STATUSES, DUE, filterTools, toCsv, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) WorkshopToolsUI.init();
