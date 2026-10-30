/* ============================================================
   workshop-assets-demo.js — shared engine of the Workshop Assets
   demo pages (DEMO, UI ONLY)
   ------------------------------------------------------------
   Loaded by the five Workshop Assets demo pages (Equipment
   Inventory, Maintenance & Repairs, Asset Assignment, Asset History
   and Asset Reports), each of which hands it a description of the
   page and its FICTIONAL sample rows. It draws the summary cards,
   the toolbar, the table (or the page's own view) and the modals.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage data);
     - read or write browser storage;
     - make any request, download anything or send anything.

   Search and filters work on the page's in-memory sample list. Every
   form, assign, return, schedule and export action is a preview: it
   says "Demo preview only — Nothing was saved or sent." and changes
   nothing. All content is built with createElement and textContent --
   nothing from the data is parsed as HTML.
   ============================================================ */

const AssetDemo = (() => {

  const NOT_SAVED = 'Demo preview only — Nothing was saved or sent.';
  // A fixed "today" for the sample data, so date filters always show the same rows.
  const DEMO_TODAY = '2026-10-30';

  /* ---------- Lucide outline icons, drawn as [tag, attributes] shapes ---------- */

  const ICONS = {
    package: [['path', { d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' }], ['path', { d: 'M12 22V12' }], ['path', { d: 'm3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7' }], ['path', { d: 'm7.5 4.27 9 5.15' }]],
    check: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
    wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
    alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
    coins: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M18.09 10.37A6 6 0 1 1 10.34 18' }], ['path', { d: 'M7 6h1v4' }], ['path', { d: 'm16.71 13.88.7.71-2.82 2.82' }]],
    calendar: [['path', { d: 'M8 2v4' }], ['path', { d: 'M16 2v4' }], ['rect', { width: 18, height: 18, x: 3, y: 4, rx: 2 }], ['path', { d: 'M3 10h18' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 6v6l4 2' }]],
    cog: [['path', { d: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z' }], ['path', { d: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 22v-2' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }]],
    user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
    userCheck: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['polyline', { points: '16 11 18 13 22 9' }]],
    history: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7v5l4 2' }]],
    chart: [['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }], ['path', { d: 'M18 17V9' }], ['path', { d: 'M13 17V5' }], ['path', { d: 'M8 17v-3' }]],
    cart: [['circle', { cx: 8, cy: 21, r: 1 }], ['circle', { cx: 19, cy: 21, r: 1 }], ['path', { d: 'M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12' }]],
    undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11' }]],
    refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
    plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
    download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: 12, x2: 12, y1: 15, y2: 3 }]],
    eye: [['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    info: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
    home: [['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }], ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
    inbox: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  };

  const SVG = 'http://www.w3.org/2000/svg';
  function icon(name, size = 20) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
    for (const [tag, attrs] of ICONS[name] || ICONS.info) {
      const shape = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
      svg.appendChild(shape);
    }
    return svg;
  }

  /* ---------- small helpers (pure ones are exported for the tests) ---------- */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  /** Whole Taka with thousands separators: 1250000 -> "৳1,250,000". */
  function money(n) {
    return '৳' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "2026-10-04" -> "4 Oct 2026"; anything else is shown as a dash. */
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
  }

  /** Days from a to b (ISO dates), counted in whole UTC days. */
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  /** The preset date ranges every page offers, relative to the fixed demo "today". */
  const DATE_RANGES = [
    ['all', 'All dates'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['future', 'Upcoming'],
  ];
  function inDateRange(iso, range, today = DEMO_TODAY) {
    if (!range || range === 'all') return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
    const d = daysBetween(iso, today);
    if (range === 'future') return d < 0;
    return d >= 0 && d <= Number(range);
  }

  /**
   * The rows that match a search text (any of `fields`, any case) and every
   * filter in `filters` ({ key: [value, match(row, value)] } with value 'all'
   * meaning "no filter").
   */
  function filterRows(rows, query, fields, filters) {
    const q = String(query || '').trim().toLowerCase();
    return rows.filter(r => {
      for (const [value, match] of Object.values(filters || {})) {
        if (value && value !== 'all' && !match(r, value)) return false;
      }
      if (!q) return true;
      return fields.some(f => String(typeof f === 'function' ? f(r) : r[f] ?? '').toLowerCase().includes(q));
    });
  }

  /** A CSV text of the shown rows, for the export preview only (never downloaded). */
  function toCsv(columns, rows) {
    const cell = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.map(c => cell(c.label)), ...rows.map(r => columns.map(c => cell(c.csv(r))))].map(l => l.join(',')).join('\n');
  }

  /* ---------- badges ---------- */

  // Status words mapped to the shared badge tones.
  const TONES = {
    Available: 'good', Good: 'good', Excellent: 'good', Completed: 'good', Returned: 'good', Active: 'good',
    'In Use': 'warn', Assigned: 'info', Scheduled: 'info', Upcoming: 'info', 'In Progress': 'warn', Fair: 'warn', 'Due Soon': 'warn',
    'Under Maintenance': 'bad', Maintenance: 'bad', Overdue: 'bad', 'Needs Service': 'bad', Poor: 'bad', 'Out of Service': 'bad',
  };
  function badge(text) {
    const b = el('span', `badge badge--${TONES[text] || 'neutral'} ad-badge`, text);
    return b;
  }

  /** A name cell: an icon tile, the name and a smaller second line. */
  function itemCell(iconName, name, sub) {
    const wrap = el('div', 'ad-item');
    const t = el('span', 'ad-thumb'); t.appendChild(icon(iconName, 20));
    const text = el('span', 'ad-item__text');
    text.appendChild(el('span', 'ad-item__name', name));
    if (sub) text.appendChild(el('span', 'ad-item__sub', sub));
    wrap.append(t, text);
    return wrap;
  }

  /** A person cell: initials and a name (sample people only). */
  function person(name) {
    const wrap = el('span', 'ad-person');
    const initials = String(name).replace(/\(Demo\)/, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const av = el('span', 'ad-avatar', initials); av.setAttribute('aria-hidden', 'true');
    wrap.append(av, el('span', null, name));
    return wrap;
  }

  /** A titled card holding a short list: items are [title, sub, side (string|Node)]. */
  function panel(title, iconName, tone, items, emptyText) {
    const card = el('section', `card ad-panel ad-tone--${tone}`);
    const head = el('div', 'ad-panel__head');
    const ic = el('span', 'ad-panel__icon'); ic.appendChild(icon(iconName, 18));
    head.append(ic, el('h3', null, title), el('span', 'badge badge--neutral', String(items.length)));
    card.appendChild(head);
    if (!items.length) { card.appendChild(el('p', 'ad-mini__sub', emptyText || 'Nothing to show.')); return card; }
    const ul = el('ul', 'ad-mini');
    for (const [t, sub, side] of items) {
      const li = el('li');
      const text = el('span', 'ad-mini__text');
      text.append(el('span', 'ad-mini__title', t), el('span', 'ad-mini__sub', sub));
      const s = el('span', 'ad-mini__side');
      if (side instanceof Node) s.appendChild(side); else s.textContent = side || '';
      li.append(text, s);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    return card;
  }

  /* ---------- toast ---------- */

  function say(message, type = 'info') {
    if (typeof Utils !== 'undefined' && Utils.toast) Utils.toast(message, type);
  }

  /* ---------- modal ---------- */

  let lastFocus = null;
  function modalRoot() {
    let root = document.getElementById('adModal');
    if (root) return root;
    root = el('div', 'modal-overlay ad-modal');
    root.id = 'adModal';
    root.hidden = true;
    const box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'adModalTitle');
    const head = el('div', 'modal__head');
    const h = el('h2'); h.id = 'adModalTitle';
    const close = el('button', 'icon-btn modal__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.dataset.adClose = '';
    close.appendChild(icon('x', 18));
    head.append(h, close);
    const body = el('div', 'modal__body'); body.id = 'adModalBody';
    const foot = el('div', 'modal__foot'); foot.id = 'adModalFoot';
    box.append(head, body, foot);
    root.appendChild(box);
    root.addEventListener('click', e => { if (e.target === root || e.target.closest('[data-ad-close]')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) closeModal(); });
    document.getElementById('page-content').appendChild(root);
    return root;
  }

  function closeModal() {
    const root = document.getElementById('adModal');
    if (!root || root.hidden) return;
    root.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /**
   * Open the shared modal. `body` is a node; `submit` (optional) is the label
   * of the preview button, which only says nothing was saved and closes.
   */
  function openModal({ title, body, submit, wide }) {
    const root = modalRoot();
    lastFocus = document.activeElement;
    root.querySelector('.modal').classList.toggle('modal--lg', !!wide);
    document.getElementById('adModalTitle').textContent = title;
    const b = document.getElementById('adModalBody');
    const note = el('p', 'ad-modal__note');
    note.append(icon('info', 16), el('span', null, submit
      ? 'Demo form: nothing you enter here is saved or sent.'
      : 'Sample record: fictional data for the page design.'));
    b.replaceChildren(note, body);
    const f = document.getElementById('adModalFoot');
    const cancel = el('button', 'btn btn--ghost', submit ? 'Cancel' : 'Close');
    cancel.type = 'button';
    cancel.dataset.adClose = '';
    f.replaceChildren(cancel);
    if (submit) {
      const ok = el('button', 'btn btn--primary', submit);
      ok.type = 'button';
      ok.dataset.adSubmit = '';
      ok.addEventListener('click', () => { closeModal(); say(NOT_SAVED); });
      f.appendChild(ok);
    }
    root.hidden = false;
    const first = b.querySelector('input, select, textarea') || cancel;
    first.focus();
  }

  /** A demo form: [{ label, type: 'text'|'number'|'date'|'select'|'textarea', options, value, wide }]. */
  function form(fields) {
    const grid = el('div', 'form-grid');
    fields.forEach((f, i) => {
      const field = el('div', `field${f.wide ? ' span-2' : ''}`);
      const id = `adf${i}`;
      const label = el('label', null, f.label);
      label.htmlFor = id;
      let input;
      if (f.type === 'select') {
        input = el('select', 'select');
        for (const o of f.options) input.appendChild(el('option', null, o));
        if (f.value) input.value = f.value;
      } else if (f.type === 'textarea') {
        input = el('textarea', 'input');
        input.rows = 3;
        if (f.value) input.value = f.value;
      } else {
        input = el('input', 'input');
        input.type = f.type || 'text';
        if (f.value != null) input.value = f.value;
        if (f.placeholder) input.placeholder = f.placeholder;
        input.autocomplete = 'off';
      }
      input.id = id;
      field.append(label, input);
      grid.appendChild(field);
    });
    return grid;
  }

  /** A read-only details list: [[label, value or node], ...]. */
  function details(pairs) {
    const dl = el('dl', 'ad-details');
    for (const [k, v] of pairs) {
      const dd = el('dd');
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = v == null || v === '' ? '—' : String(v);
      dl.append(el('dt', null, k), dd);
    }
    return dl;
  }

  /* ---------- page parts ---------- */

  function header(cfg) {
    const wrap = el('div', 'ad-top');
    const crumbs = el('nav', 'ad-crumbs');
    crumbs.setAttribute('aria-label', 'Breadcrumb');
    const ol = el('ol');
    const home = el('li'); const a = el('a'); a.href = '../index.html'; a.append(icon('home', 16), el('span', null, 'Dashboard')); home.appendChild(a);
    const mid = el('li'); const t = el('a', null, 'Workshop Assets'); t.href = 'workshop-tools.html'; mid.appendChild(t);
    const cur = el('li', null, cfg.title); cur.setAttribute('aria-current', 'page');
    ol.append(home, mid, cur); crumbs.appendChild(ol);

    const head = el('div', 'ad-head');
    const ic = el('span', 'ad-head__icon'); ic.appendChild(icon(cfg.icon, 30));
    const text = el('div', 'ad-head__text');
    const h2 = el('h2', 'ad-head__title', cfg.title);
    h2.appendChild(el('span', 'badge badge--neutral', 'Demo'));
    text.append(h2, el('p', 'page-subtitle', cfg.subtitle));
    head.append(ic, text);
    const actions = el('div', 'ad-head__actions');
    for (const b of cfg.headerButtons || []) {
      const btn = el('button', `btn ${b.primary ? 'btn--primary' : 'btn--ghost'}`);
      btn.type = 'button';
      btn.append(icon(b.icon, 18), el('span', null, b.label));
      btn.addEventListener('click', b.onClick);
      if (b.id) btn.id = b.id;
      actions.appendChild(btn);
    }
    head.appendChild(actions);

    const banner = el('div', 'ad-demo');
    banner.setAttribute('role', 'note');
    banner.append(icon('info', 18), el('p', null, 'DEMO MODE — Sample data only. Nothing is saved or sent.'));
    wrap.append(crumbs, head, banner);
    return wrap;
  }

  function stats(cards) {
    const s = el('section', 'ad-stats');
    s.setAttribute('aria-label', 'Summary (sample figures)');
    for (const c of cards) {
      const card = el('div', `ad-stat ad-tone--${c.tone || 'neutral'}`);
      const ic = el('span', 'ad-stat__icon'); ic.appendChild(icon(c.icon, 22));
      const body = el('div', 'ad-stat__body');
      const v = el('div', `ad-stat__value${c.money ? ' ad-stat__value--money' : ''}`, c.value);
      if (c.id) v.id = c.id;
      body.append(el('div', 'ad-stat__label', c.label), v);
      if (c.sub) body.appendChild(el('div', 'ad-stat__sub', c.sub));
      card.append(ic, body);
      s.appendChild(card);
    }
    return s;
  }

  function select(id, label, options) {
    const s = el('select', 'select ad-select');
    s.id = id;
    s.setAttribute('aria-label', label);
    for (const o of options) {
      const [value, text] = Array.isArray(o) ? o : [o, o];
      const opt = el('option', null, text); opt.value = value;
      s.appendChild(opt);
    }
    return s;
  }

  /**
   * Mount a list page. cfg:
   *   page, title, subtitle, icon, headerButtons, cards, before(container),
   *   rows, search: { placeholder, fields }, filters: [{ id, label, options, match }],
   *   date: { label, get(row) }, columns: [{ label, cell(row) -> string|Node, csv(row) }],
   *   rowActions: [{ label, icon, run(row) }], emptyTitle, view(container, rows) (instead of a table),
   *   noun (for the count line), exportName.
   */
  function mount(cfg) {
    const root = document.getElementById('adRoot');
    if (!root) return null;
    const state = { query: '', filters: {}, date: 'all' };
    for (const f of cfg.filters || []) state.filters[f.id] = 'all';

    root.appendChild(header(cfg));
    if (cfg.cards) root.appendChild(stats(cfg.cards));
    if (cfg.before) cfg.before(root);

    const card = el('section', 'card ad-card');
    card.setAttribute('aria-label', cfg.listLabel || cfg.title);
    const bar = el('div', 'ad-toolbar');
    bar.setAttribute('role', 'search');
    const search = el('label', 'ad-search');
    search.appendChild(icon('search', 18));
    const input = el('input', 'input');
    input.type = 'search'; input.id = 'adSearch'; input.autocomplete = 'off';
    input.placeholder = cfg.search.placeholder;
    input.setAttribute('aria-label', cfg.search.placeholder.replace(/…$/, ''));
    search.appendChild(input);
    bar.appendChild(search);
    const selects = [];
    for (const f of cfg.filters || []) {
      const s = select(`adf-${f.id}`, f.label, [['all', f.allLabel || `All ${f.label.replace(/^Filter by /, '')}`], ...f.options]);
      s.addEventListener('change', () => { state.filters[f.id] = s.value; draw(); });
      selects.push([s, f]);
      bar.appendChild(s);
    }
    let dateSel = null;
    if (cfg.date) {
      dateSel = select('adf-date', cfg.date.label, DATE_RANGES.filter(([v]) => !cfg.date.ranges || cfg.date.ranges.includes(v)));
      dateSel.addEventListener('change', () => { state.date = dateSel.value; draw(); });
      bar.appendChild(dateSel);
    }
    if (cfg.columns && cfg.exportName !== false) {
      const ex = el('button', 'btn btn--ghost ad-export');
      ex.type = 'button'; ex.id = 'adExport';
      ex.append(icon('download', 18), el('span', null, 'Export Preview'));
      ex.addEventListener('click', () => {
        const rows = shown();
        const pre = el('pre', 'ad-csv', toCsv(cfg.columns, rows));
        const wrap = el('div');
        wrap.append(el('p', 'ad-csv__lead', `${rows.length} sample ${rows.length === 1 ? 'row' : 'rows'} as CSV. Nothing is downloaded or sent.`), pre);
        openModal({ title: `Export Preview — ${cfg.title}`, body: wrap, wide: true });
      });
      bar.appendChild(ex);
    }
    card.appendChild(bar);

    const holder = el('div', 'ad-view');
    card.appendChild(holder);
    const empty = el('div', 'empty ad-empty');
    empty.hidden = true;
    empty.append(icon('inbox', 40), el('h3', null, cfg.emptyTitle || 'No records found'), el('p', null, 'Try a different search or filter.'));
    const clear = el('button', 'btn btn--ghost btn--sm', 'Clear filters');
    clear.type = 'button'; clear.id = 'adClear';
    clear.addEventListener('click', () => {
      state.query = ''; input.value = '';
      for (const [s, f] of selects) { s.value = 'all'; state.filters[f.id] = 'all'; }
      if (dateSel) { dateSel.value = 'all'; state.date = 'all'; }
      draw();
    });
    empty.appendChild(clear);
    card.appendChild(empty);
    const foot = el('div', 'ad-foot');
    const count = el('span', null); count.id = 'adCount'; count.setAttribute('aria-live', 'polite');
    foot.appendChild(count);
    card.appendChild(foot);
    root.appendChild(card);

    input.addEventListener('input', () => { state.query = input.value; draw(); });

    function shown() {
      const filters = {};
      for (const f of cfg.filters || []) filters[f.id] = [state.filters[f.id], f.match];
      if (cfg.date) filters.__date = [state.date, (r, v) => inDateRange(cfg.date.get(r), v)];
      return filterRows(cfg.rows, state.query, cfg.search.fields, filters);
    }

    function table(rows) {
      const wrap = el('div', 'table-wrap ad-table-wrap');
      const t = el('table', 'table ad-table');
      const thead = el('thead'); const tr = el('tr');
      for (const c of cfg.columns) tr.appendChild(el('th', c.cls || null, c.label));
      if (cfg.rowActions) tr.appendChild(el('th', 'ad-th-actions', 'Actions'));
      thead.appendChild(tr);
      const tbody = el('tbody');
      for (const r of rows) {
        const row = el('tr');
        for (const c of cfg.columns) {
          const td = el('td', c.cls || null);
          td.dataset.label = c.label;
          const v = c.cell(r);
          if (v instanceof Node) td.appendChild(v); else td.textContent = v == null || v === '' ? '—' : String(v);
          row.appendChild(td);
        }
        if (cfg.rowActions) {
          const td = el('td', 'ad-actions');
          td.dataset.label = 'Actions';
          for (const a of cfg.rowActions) {
            if (a.when && !a.when(r)) continue;
            const b = el('button', 'icon-btn ad-act');
            b.type = 'button';
            b.title = a.label;
            b.setAttribute('aria-label', `${a.label}: ${r[cfg.nameKey || 'name']}`);
            b.appendChild(icon(a.icon, 17));
            b.addEventListener('click', () => a.run(r));
            td.appendChild(b);
          }
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
      t.append(thead, tbody);
      wrap.appendChild(t);
      return wrap;
    }

    function draw() {
      const rows = shown();
      holder.hidden = !rows.length;
      empty.hidden = !!rows.length;
      holder.replaceChildren(rows.length ? (cfg.view ? cfg.view(rows) : table(rows)) : '');
      count.textContent = `Showing ${rows.length} of ${cfg.rows.length} sample ${cfg.noun || 'records'}`;
      if (cfg.onDraw) cfg.onDraw(rows);
    }

    draw();
    return { draw, shown, state };
  }

  /**
   * Run `start` once the page's markup is parsed (the scripts sit at the end of
   * <body>), but only on the page that `page` names.
   */
  function boot(page, start) {
    if (typeof document === 'undefined' || !document.body || !document.body.dataset) return;
    if (document.body.dataset.page !== page) return;
    start();
  }

  return {
    NOT_SAVED, DEMO_TODAY, DATE_RANGES, ICONS,
    el, icon, badge, money, fmtDate, daysBetween, inDateRange, filterRows, toCsv,
    itemCell, person, panel,
    openModal, closeModal, form, details, say, mount, boot, stats,
  };
})();
