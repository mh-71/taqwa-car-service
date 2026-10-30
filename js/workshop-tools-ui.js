/* ============================================================
   workshop-tools-ui.js — Workshop Assets › Tools & Equipment
   ------------------------------------------------------------
   Loaded only by pages/workshop-tools.html. Every tool shown here
   comes from the workshop database (GET /api/tools, migration 0013)
   through Storage.loadPage, and every change goes back through the
   API -- Storage.create, Storage.update and the retire action:

     Add / Edit     POST /api/tools, PUT /api/tools/:id (expectedUpdatedAt)
     Retire         POST /api/tools/:id/retire -- an administrator only;
                    the server decides, the button is only hidden for an
                    account that is not one
     Export CSV     every tool matching the current search and filters,
                    read page by page from the API, not only the page shown

   The server filters, sorts and pages the list, and its `summary` fills
   the cards. When the database cannot be read the page says so and offers
   Retry: no sample or browser-stored tools are ever shown in its place.

   Everything from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const WorkshopToolsUI = (() => {

  /* ---------- the vocabulary (the API's own lists; 0013's CHECKs) ---------- */

  const CATEGORIES = ['Diagnostic Equipment', 'Engine Tools', 'Electrical Tools', 'AC Service Equipment',
    'Lifting Equipment', 'Workshop Hand Tools', 'Safety Equipment', 'Cleaning Equipment', 'Other'];
  const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'];
  const STATUSES = ['Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired'];
  /** Retired is reached only through Retire, never chosen in the form. */
  const FORM_STATUSES = STATUSES.filter(s => s !== 'Retired');
  const USABLE = ['Available', 'In Use'];
  const USABLE_CONDITIONS = ['Excellent', 'Good', 'Fair'];

  const LIMITS = { name: 120, brand: 80, model: 80, serialNo: 80, supplier: 160, location: 80,
    description: 500, notes: 1000, reason: 300 };
  const MAX_PRICE = 100000000;
  const EARLIEST_PURCHASE = '1980-01-01';
  const EXPORT_PAGE = 1000;
  const WARRANTY_SOON_DAYS = 30;

  const FIELDS = ['name', 'category', 'brand', 'model', 'serialNo', 'purchaseDate', 'purchasePrice',
    'supplier', 'warrantyExpiry', 'location', 'condition', 'status', 'description', 'notes'];

  const STATUS_TONE = { Available: 'available', 'In Use': 'in-use', 'Under Maintenance': 'maintenance', Damaged: 'damaged', Retired: 'retired' };
  const CONDITION_TONE = { Excellent: 'excellent', Good: 'good', Fair: 'fair', Poor: 'poor', Damaged: 'damaged' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Today's calendar day in the workshop's zone, as YYYY-MM-DD. */
  function todayInDhaka(at = new Date()) {
    return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  }

  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  function isRealDate(s) {
    if (!DATE_ONLY.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }

  /** Whole days from `from` to `to` (both YYYY-MM-DD), no time zone involved. */
  function daysBetween(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  }

  /** { tone, label } for a tool's warranty, on `today`. */
  function warrantyState(tool, today = todayInDhaka()) {
    if (!tool || !tool.warrantyExpiry) return { tone: 'none', label: 'No warranty recorded' };
    const left = daysBetween(today, tool.warrantyExpiry);
    if (left < 0) return { tone: 'expired', label: `Expired ${Utils.fmtDate(tool.warrantyExpiry)}` };
    if (left === 0) return { tone: 'soon', label: 'Expires today' };
    if (left <= WARRANTY_SOON_DAYS) return { tone: 'soon', label: `Expires in ${left} day${left === 1 ? '' : 's'}` };
    return { tone: 'active', label: `Active until ${Utils.fmtDate(tool.warrantyExpiry)}` };
  }

  /**
   * Check a form's values with the server's own rules, so a mistake is named
   * before anything is sent. The server checks again; this is a courtesy.
   * Returns { field: message }.
   */
  function validate(v, today = todayInDhaka()) {
    const e = {};
    const text = (k) => String(v[k] ?? '').trim();
    if (!text('name')) e.name = 'Enter the tool name.';
    else if (text('name').length > LIMITS.name) e.name = `Keep the name to ${LIMITS.name} characters or fewer.`;
    if (!CATEGORIES.includes(v.category)) e.category = 'Choose a category.';
    if (!CONDITIONS.includes(v.condition)) e.condition = 'Choose the condition.';
    if (!FORM_STATUSES.includes(v.status)) e.status = 'Choose the status.';
    for (const k of ['brand', 'model', 'serialNo', 'supplier', 'location', 'description', 'notes']) {
      if (text(k).length > LIMITS[k]) e[k] = `Keep this to ${LIMITS[k]} characters or fewer.`;
    }
    const price = text('purchasePrice');
    if (price !== '') {
      const n = Number(price);
      if (!Number.isFinite(n)) e.purchasePrice = 'Enter the price as a number.';
      else if (n < 0) e.purchasePrice = 'The price cannot be negative.';
      else if (n > MAX_PRICE) e.purchasePrice = 'That price is too large.';
    }
    const bought = text('purchaseDate');
    if (bought) {
      if (!isRealDate(bought)) e.purchaseDate = 'Enter a real date.';
      else if (bought < EARLIEST_PURCHASE) e.purchaseDate = `The purchase date cannot be before ${EARLIEST_PURCHASE}.`;
      else if (bought > today) e.purchaseDate = 'The purchase date cannot be in the future.';
    }
    const warranty = text('warrantyExpiry');
    if (warranty) {
      if (!isRealDate(warranty)) e.warrantyExpiry = 'Enter a real date.';
      else if (bought && isRealDate(bought) && warranty < bought) e.warrantyExpiry = 'Warranty expiry must be on or after the purchase date.';
    }
    if (!e.status && !e.condition) {
      if (v.condition === 'Damaged' && USABLE.includes(v.status)) {
        e.status = 'A damaged tool cannot be Available or In Use. Choose Damaged or Under Maintenance.';
      } else if (USABLE.includes(v.status) && !USABLE_CONDITIONS.includes(v.condition)) {
        e.status = `A tool in ${v.condition} condition cannot be ${v.status}. Choose Under Maintenance or Damaged.`;
      }
    }
    return e;
  }

  /** The form's values as the API takes them: trimmed text, a number or nothing for the price. */
  function normalise(v) {
    const out = {};
    for (const k of FIELDS) {
      const raw = String(v[k] ?? '').trim();
      out[k] = k === 'purchasePrice' ? (raw === '' ? null : Number(raw)) : raw;
    }
    return out;
  }

  /**
   * The body to send. A new tool sends every field; an edit sends only what
   * changed, plus the updatedAt it was made from (stale-edit protection).
   * An edit that changes nothing returns null.
   */
  function payload(values, original = null) {
    const v = normalise(values);
    if (!original) {
      const body = {};
      for (const k of FIELDS) if (v[k] !== '' && v[k] !== null) body[k] = v[k];
      return body;
    }
    const before = normalise(original);
    const body = {};
    for (const k of FIELDS) if (v[k] !== before[k]) body[k] = v[k] === null ? '' : v[k];
    if (!Object.keys(body).length) return null;
    body.expectedUpdatedAt = original.updatedAt;
    return body;
  }

  /** The list's query string parameters for `state`. Empty filters are left out. */
  function buildQuery(state) {
    const q = {};
    if (state.q) q.q = state.q;
    for (const k of ['category', 'status', 'condition']) if (state[k]) q[k] = state[k];
    const [sort, order] = String(state.sort || 'createdAt:desc').split(':');
    q.sort = sort; q.order = order;
    q.limit = String(state.limit);
    q.offset = String(state.offset || 0);
    return q;
  }

  /** May this browser's sign-in retire tools? Mirrors the server: passphrase, or an Administrator account. */
  function canRetire(account) {
    return !account || account.role === 'Administrator';
  }

  const CSV_COLUMNS = [
    ['Tool ID', 'id'], ['Tool Name', 'name'], ['Category', 'category'], ['Brand', 'brand'], ['Model', 'model'],
    ['Serial Number', 'serialNo'], ['Location', 'location'], ['Condition', 'condition'], ['Status', 'status'],
    ['Purchase Date', 'purchaseDate'], ['Purchase Price', 'purchasePrice'], ['Supplier', 'supplier'],
    ['Warranty Expiry', 'warrantyExpiry'], ['Description', 'description'], ['Notes', 'notes'],
    ['Retired At', 'retiredAt'], ['Retired Reason', 'retiredReason'], ['Created At', 'createdAt'], ['Updated At', 'updatedAt'],
  ];

  /**
   * CSV text for `rows`. Every cell is quoted; a cell that a spreadsheet would
   * read as a formula (= + - @ or a tab/return first) is prefixed with ' so it
   * stays text.
   */
  function toCsv(rows) {
    const cell = (value) => {
      let s = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [CSV_COLUMNS.map(([h]) => cell(h)).join(',')];
    for (const r of rows) lines.push(CSV_COLUMNS.map(([, k]) => cell(r[k])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Read EVERY tool matching `state`'s search and filters, page by page.
   * `getPage(query)` is Storage.loadPage('tools', query) in the page.
   * Resolves to { ok, rows } or the failing page's { ok: false, ... }.
   */
  async function fetchAllMatching(state, getPage) {
    const rows = [];
    for (let guard = 0; guard < 200; guard++) {
      const res = await getPage(buildQuery({ ...state, limit: EXPORT_PAGE, offset: rows.length }));
      if (!res.ok) return res;
      rows.push(...res.rows);
      const total = res.meta && Number.isFinite(res.meta.total) ? res.meta.total : rows.length;
      if (!res.rows.length || rows.length >= total) return { ok: true, rows };
    }
    return { ok: false, code: 'too_many_pages', message: 'There were too many tools to export at once.' };
  }

  /* ---------- page state ---------- */

  const state = {
    q: '', category: '', status: '', condition: '', sort: 'createdAt:desc', limit: 25, offset: 0,
    rows: [], meta: null, loading: false, error: null,
  };
  let requestSeq = 0;
  let searchTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const ICON = {
    view: '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
    edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
    retire: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
    alert: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>',
    empty: '<path d="M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z"/>',
  };
  const svg = (path, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${path}</svg>`;

  const statusBadge = (s) => `<span class="wt-status wt-status--${STATUS_TONE[s] || 'retired'}">${esc(s)}</span>`;
  const conditionBadge = (c) => `<span class="wt-cond wt-cond--${CONDITION_TONE[c] || 'fair'}">${esc(c)}</span>`;
  const dash = '<span class="wt-none">&#8212;</span>';
  const orDash = (v) => (v === '' || v === null || v === undefined ? dash : esc(v));
  const brandModel = (t) => [t.brand, t.model].filter(Boolean).join(' · ');

  /* ---------- rendering ---------- */

  function setStat(id, n) { const el = $(id); if (el) el.textContent = Number.isFinite(n) ? String(n) : '—'; }

  function renderSummary(summary) {
    const s = summary || {};
    setStat('wtTotal', s.total);
    setStat('wtAvailable', s.available);
    setStat('wtInUse', s.inUse);
    setStat('wtMaint', s.underMaintenance);
    setStat('wtDamaged', s.damaged);
  }

  function showList(show) {
    $('wtTableWrap').hidden = !show;
    $('wtCards').hidden = !show;
    $('wtFoot').hidden = !show;
  }

  function renderState(kind, opts = {}) {
    const host = $('wtState');
    if (kind === 'none') { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    if (kind === 'loading') {
      host.innerHTML = `<div class="wt-skeleton" aria-label="Loading tools">${'<span class="wt-skeleton__row"></span>'.repeat(5)}</div>
        <span class="wt-sr-only">Loading tools…</span>`;
      return;
    }
    const tone = kind === 'empty' ? '' : ' wt-state__box--bad';
    host.innerHTML = `<div class="empty wt-state__box${tone}">
        ${svg(kind === 'empty' ? ICON.empty : ICON.alert, 40)}
        <h3>${esc(opts.title)}</h3>
        <p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}
      </div>`;
  }

  function actionButtons(t) {
    const retired = t.status === 'Retired';
    const mayRetire = !retired && canRetire(Storage.account);
    return `<div class="wt-actions">
        <button type="button" class="wt-act" data-act="view" data-id="${esc(t.id)}" aria-label="View ${esc(t.name)}" title="View details">${svg(ICON.view)}</button>
        ${retired ? '' : `<button type="button" class="wt-act" data-act="edit" data-id="${esc(t.id)}" aria-label="Edit ${esc(t.name)}" title="Edit">${svg(ICON.edit)}</button>`}
        ${mayRetire ? `<button type="button" class="wt-act wt-act--danger" data-act="retire" data-id="${esc(t.id)}" aria-label="Retire ${esc(t.name)}" title="Retire">${svg(ICON.retire)}</button>` : ''}
      </div>`;
  }

  function renderRows(rows) {
    $('wtBody').innerHTML = rows.map(t => `
      <tr${t.status === 'Retired' ? ' class="wt-row--retired"' : ''}>
        <td class="wt-c-code">${esc(t.id)}</td>
        <td><div class="wt-tool"><button type="button" class="wt-tool__name" data-act="view" data-id="${esc(t.id)}">${esc(t.name)}</button>
          <span class="wt-tool__desc wt-tool__cat">${esc(t.category)}</span>
          ${t.serialNo ? `<span class="wt-tool__desc">S/N ${esc(t.serialNo)}</span>` : ''}</div></td>
        <td><span class="wt-chip wt-cat--${slug(t.category)}">${esc(t.category)}</span></td>
        <td>${orDash(brandModel(t))}</td>
        <td>${orDash(t.location)}</td>
        <td>${conditionBadge(t.condition)}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="wt-c-date">${t.purchaseDate ? esc(Utils.fmtDate(t.purchaseDate)) : dash}</td>
        <td class="wt-c-actions">${actionButtons(t)}</td>
      </tr>`).join('');

    $('wtCards').innerHTML = rows.map(t => `
      <li class="wt-tcard${t.status === 'Retired' ? ' wt-row--retired' : ''}">
        <div class="wt-tcard__head">
          <div class="wt-tool">
            <button type="button" class="wt-tool__name" data-act="view" data-id="${esc(t.id)}">${esc(t.name)}</button>
            <span class="wt-tool__desc">${esc(t.id)} · ${esc(t.category)}</span>
          </div>
          ${statusBadge(t.status)}
        </div>
        <dl class="wt-tcard__facts">
          <div><dt>Brand / Model</dt><dd>${orDash(brandModel(t))}</dd></div>
          <div><dt>Location</dt><dd>${orDash(t.location)}</dd></div>
          <div><dt>Condition</dt><dd>${conditionBadge(t.condition)}</dd></div>
          <div><dt>Purchased</dt><dd>${t.purchaseDate ? esc(Utils.fmtDate(t.purchaseDate)) : dash}</dd></div>
        </dl>
        ${actionButtons(t)}
      </li>`).join('');
  }

  function renderFoot(meta) {
    const total = meta.total || 0;
    const from = total ? meta.offset + 1 : 0;
    const to = meta.offset + state.rows.length;
    $('wtCount').textContent = total ? `Showing ${from}–${to} of ${total} tool${total === 1 ? '' : 's'}` : 'No tools';
    const pages = Math.max(1, Math.ceil(total / state.limit));
    const page = Math.floor(meta.offset / state.limit) + 1;
    $('wtPageLabel').textContent = `Page ${page} of ${pages}`;
    $('wtPrev').disabled = meta.offset <= 0;
    $('wtNext').disabled = to >= total;
  }

  const filtered = () => Boolean(state.q || state.category || state.status || state.condition);

  function render() {
    $('wtClear').hidden = !filtered();
    if (state.loading && !state.rows.length) { showList(false); renderState('loading'); return; }
    if (state.error) {
      showList(false);
      $('wtExport').disabled = true;
      renderState('error', state.error);
      return;
    }
    renderSummary(state.meta && state.meta.summary);
    $('wtExport').disabled = !(state.meta && state.meta.total);
    if (!state.rows.length) {
      showList(false);
      renderState('empty', filtered()
        ? { title: 'No tools match', text: 'Try a different search or clear the filters.', action: 'clear', actionLabel: 'Clear filters' }
        : { title: 'No tools registered yet', text: 'Add the workshop’s first tool to start the register.', action: 'add', actionLabel: 'Add New Tool' });
      return;
    }
    renderState('none');
    renderRows(state.rows);
    renderFoot(state.meta);
    showList(true);
  }

  function errorFor(res) {
    if (res.code === 'no_api') {
      return { title: 'The workshop database is not connected', text: 'Tools are kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in its place.' };
    }
    if (res.code === 'unauthorized' || res.code === 'locked') {
      return { title: 'Your session has ended', text: 'Sign in again to see the tools. Nothing was changed.', action: 'reload', actionLabel: 'Sign in again' };
    }
    return { title: 'The tools could not be loaded', text: 'The workshop database did not answer, so no tools are shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  /* ---------- loading ---------- */

  async function load() {
    if (!Storage.isApi()) {
      state.loading = false;
      state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' });
      render();
      return false;
    }
    const seq = ++requestSeq;
    state.loading = true;
    state.error = null;
    render();
    const res = await Storage.loadPage('tools', buildQuery(state));
    if (seq !== requestSeq) return false;            // a newer search has been sent since
    state.loading = false;
    if (!res.ok) {
      state.rows = [];
      state.error = errorFor(res);
      render();
      return false;
    }
    // A page past the end (the last tool on it was just retired): step back.
    if (!res.rows.length && state.offset > 0 && res.meta && res.meta.total > 0) {
      state.offset = Math.max(0, (Math.ceil(res.meta.total / state.limit) - 1) * state.limit);
      return load();
    }
    state.rows = res.rows;
    state.meta = { ...res.meta, offset: state.offset };
    $('wtAdd').disabled = false;
    render();
    return true;
  }

  const findRow = (id) => state.rows.find(t => t.id === id) || null;

  /* ---------- the add / edit form ---------- */

  const options = (list, chosen, placeholder) =>
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(x => `<option value="${esc(x)}"${x === chosen ? ' selected' : ''}>${esc(x)}</option>`).join('');

  function field({ key, label, required = false, type = 'text', value = '', span = false, attrs = '', control = null, hint = '' }) {
    const id = `wtf-${key}`;
    const input = control || (type === 'textarea'
      ? `<textarea class="textarea" id="${id}" name="${key}" rows="3" ${attrs}>${esc(value)}</textarea>`
      : `<input class="input" type="${type}" id="${id}" name="${key}" value="${esc(value)}" ${attrs}>`);
    return `<div class="field${span ? ' span-2' : ''}">
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${input}
        ${hint ? `<span class="wt-hint">${esc(hint)}</span>` : ''}
        <span class="field__error" data-err="${key}" id="${id}-err"></span>
      </div>`;
  }

  function formBody(t) {
    const v = t || { condition: 'Good', status: 'Available' };
    const today = todayInDhaka();
    const max = (n) => `maxlength="${n}"`;
    const section = (title, inner) => `<fieldset class="wt-fieldset"><legend>${esc(title)}</legend><div class="form-grid">${inner}</div></fieldset>`;
    return `<form id="wtForm" class="wt-form" novalidate>
      <p class="wt-form__note">Fields marked <span class="req">*</span> are required.${t ? ` Editing <strong>${esc(t.id)}</strong>.` : ' The Tool ID is assigned when you save.'}</p>
      ${section('Basic Information',
        field({ key: 'name', label: 'Tool name', required: true, value: v.name || '', span: true, attrs: `${max(LIMITS.name)} required autocomplete="off" placeholder="e.g. Hydraulic Floor Jack"` }) +
        field({ key: 'category', label: 'Category', required: true, control: `<select class="select" id="wtf-category" name="category" required>${options(CATEGORIES, v.category, 'Choose a category')}</select>` }) +
        field({ key: 'description', label: 'Description', value: v.description || '', attrs: `${max(LIMITS.description)} autocomplete="off" placeholder="e.g. 3 ton capacity"` }))}
      ${section('Identification',
        field({ key: 'brand', label: 'Brand', value: v.brand || '', attrs: `${max(LIMITS.brand)} autocomplete="off"` }) +
        field({ key: 'model', label: 'Model', value: v.model || '', attrs: `${max(LIMITS.model)} autocomplete="off"` }) +
        field({ key: 'serialNo', label: 'Serial number', value: v.serialNo || '', span: true, attrs: `${max(LIMITS.serialNo)} autocomplete="off" spellcheck="false"`, hint: 'Must be unique among tools in service.' }))}
      ${section('Purchase Information',
        field({ key: 'purchaseDate', label: 'Purchase date', type: 'date', value: v.purchaseDate || '', attrs: `min="${EARLIEST_PURCHASE}" max="${today}"` }) +
        field({ key: 'purchasePrice', label: 'Purchase price (৳)', type: 'number', value: v.purchasePrice ?? '', attrs: `min="0" max="${MAX_PRICE}" step="0.01" inputmode="decimal"` }) +
        field({ key: 'supplier', label: 'Supplier', value: v.supplier || '', attrs: `${max(LIMITS.supplier)} autocomplete="off"` }) +
        field({ key: 'warrantyExpiry', label: 'Warranty expiry', type: 'date', value: v.warrantyExpiry || '' }))}
      ${section('Location & Condition',
        field({ key: 'location', label: 'Location', value: v.location || '', span: true, attrs: `${max(LIMITS.location)} autocomplete="off" placeholder="e.g. Bay 2 cabinet"` }) +
        field({ key: 'condition', label: 'Condition', required: true, control: `<select class="select" id="wtf-condition" name="condition" required>${options(CONDITIONS, v.condition)}</select>` }) +
        field({ key: 'status', label: 'Status', required: true, control: `<select class="select" id="wtf-status" name="status" required>${options(FORM_STATUSES, v.status)}</select>`, hint: 'Retire a tool with the Retire action.' }))}
      ${section('Additional Information',
        field({ key: 'notes', label: 'Notes', type: 'textarea', value: v.notes || '', span: true, attrs: max(LIMITS.notes) }))}
    </form>`;
  }

  function readForm(form) {
    const v = {};
    for (const k of FIELDS) { const el = form.elements[k]; v[k] = el ? el.value : ''; }
    return v;
  }

  function showErrors(form, errors) {
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      const slot = form.querySelector(`[data-err="${k}"]`);
      const input = form.elements[k];
      if (slot) slot.textContent = msg;
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `wtf-${k}-err`); first = first || input; }
    }
    if (first) first.focus();
    return Boolean(first);
  }

  function openForm(tool = null) {
    const ov = Utils.Modal.open({
      title: tool ? `Edit ${tool.name}` : 'Add New Tool',
      size: 'lg',
      body: formBody(tool),
      footer: `<button type="button" class="btn btn--ghost" data-wt-cancel>Cancel</button>
        <button type="submit" form="wtForm" class="btn btn--primary" data-wt-save>${tool ? 'Save Changes' : 'Save Tool'}</button>`,
    });
    ov.classList.add('wt-modal');
    const form = ov.querySelector('#wtForm');
    const start = JSON.stringify(readForm(form));
    const dirty = () => JSON.stringify(readForm(form)) !== start;
    ov.querySelector('[data-wt-cancel]').addEventListener('click', () => {
      if (!dirty() || window.confirm('Discard the changes you made to this tool?')) Utils.Modal.close();
    });
    const saveBtn = ov.querySelector('[data-wt-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(saveBtn, () => save(form, tool));
    });
  }

  async function save(form, tool) {
    const values = readForm(form);
    const errors = validate(values);
    if (showErrors(form, errors)) return;
    const body = payload(values, tool);
    if (tool && !body) { Utils.Modal.close(); Utils.toast('Nothing was changed.', 'info'); return; }
    const res = tool ? await Storage.update('tools', tool.id, body) : await Storage.create('tools', body);
    if (!res.ok) {
      if (res.fields && showErrors(form, res.fields)) {
        Utils.toast(res.message || 'Some fields need attention.', 'error');
        return;
      }
      Utils.toast(res.message || 'The tool could not be saved.', 'error');
      if (res.errorReason === 'concurrent_modification' || res.errorReason === 'tool_retired') { Utils.Modal.close(); load(); }
      return;
    }
    Utils.Modal.close();
    Utils.toast(tool ? `${res.record.name} (${res.record.id}) was updated.` : `${res.record.name} was added as ${res.record.id}.`, 'success');
    if (!tool) state.offset = 0;
    await load();
  }

  /* ---------- details ---------- */

  function detailsBody(t) {
    const w = warrantyState(t);
    const item = (label, value, span = false) => `<div class="detail-item${span ? ' span-2' : ''}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
    const stamp = (iso, by) => `${iso ? esc(new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' })) : dash}${by ? ` <span class="wt-by">by ${esc(by)}</span>` : ''}`;
    return `<div class="wt-detail">
      <div class="wt-detail__head">
        <div><div class="wt-detail__id">${esc(t.id)}</div><div class="wt-detail__cat">${esc(t.category)}</div></div>
        <div class="wt-detail__badges">${statusBadge(t.status)} ${conditionBadge(t.condition)}</div>
      </div>
      ${t.description ? `<p class="wt-detail__desc">${esc(t.description)}</p>` : ''}
      ${t.status === 'Retired' ? `<div class="wt-retired-note"><strong>Retired ${esc(t.retiredAt ? Utils.fmtDate(t.retiredAt.slice(0, 10)) : '')}</strong> — ${esc(t.retiredReason)}</div>` : ''}
      <h3 class="wt-detail__h">Identification</h3>
      <div class="detail-grid">${item('Brand', orDash(t.brand))}${item('Model', orDash(t.model))}${item('Serial number', orDash(t.serialNo), true)}</div>
      <h3 class="wt-detail__h">Purchase &amp; warranty</h3>
      <div class="detail-grid">
        ${item('Purchase date', t.purchaseDate ? esc(Utils.fmtDate(t.purchaseDate)) : dash)}
        ${item('Purchase price', t.purchasePrice === null || t.purchasePrice === undefined ? dash : esc(Utils.money(t.purchasePrice)))}
        ${item('Supplier', orDash(t.supplier))}
        ${item('Warranty', `<span class="wt-warranty wt-warranty--${w.tone}">${esc(w.label)}</span>`)}
      </div>
      <h3 class="wt-detail__h">Location</h3>
      <div class="detail-grid">${item('Location', orDash(t.location), true)}</div>
      <h3 class="wt-detail__h">Notes</h3>
      <p class="wt-detail__notes">${t.notes ? esc(t.notes) : dash}</p>
      <div class="detail-grid wt-detail__stamps">${item('Created', stamp(t.createdAt, t.createdBy))}${item('Last updated', stamp(t.updatedAt, t.updatedBy))}</div>
    </div>`;
  }

  async function openDetails(id) {
    const res = await Storage.loadOne('tools', id);
    if (!res.ok) { Utils.toast(res.message || 'The tool could not be loaded.', 'error'); return; }
    const t = res.record;
    const retired = t.status === 'Retired';
    const ov = Utils.Modal.open({
      title: t.name,
      size: 'lg',
      body: detailsBody(t),
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${!retired && canRetire(Storage.account) ? '<button type="button" class="btn btn--danger-ghost wt-retire-btn" data-wt-retire>Retire</button>' : ''}
        ${retired ? '' : '<button type="button" class="btn btn--primary" data-wt-edit>Edit</button>'}`,
    });
    ov.classList.add('wt-modal');
    const edit = ov.querySelector('[data-wt-edit]');
    if (edit) edit.addEventListener('click', () => openForm(t));
    const retire = ov.querySelector('[data-wt-retire]');
    if (retire) retire.addEventListener('click', () => openRetire(t));
  }

  /* ---------- retire ---------- */

  function openRetire(t) {
    const ov = Utils.Modal.open({
      title: `Retire ${t.name}?`,
      body: `<form id="wtRetireForm" novalidate>
          <p class="wt-retire__text"><strong>${esc(t.id)}</strong> will leave the active register. Its record is kept and stays in Asset History; a retired tool cannot be edited or returned to service.</p>
          <div class="field">
            <label for="wtf-reason">Reason <span class="req" aria-hidden="true">*</span></label>
            <textarea class="textarea" id="wtf-reason" name="reason" rows="3" maxlength="${LIMITS.reason}" required placeholder="e.g. Beyond economical repair"></textarea>
            <span class="field__error" data-err="reason" id="wtf-reason-err"></span>
          </div>
        </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="wtRetireForm" class="btn btn--danger" data-wt-confirm>Retire Tool</button>`,
    });
    const form = ov.querySelector('#wtRetireForm');
    const btn = ov.querySelector('[data-wt-confirm]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const reason = form.elements.reason.value.trim();
        if (!reason) { showErrors(form, { reason: 'Say why the tool is being retired.' }); return; }
        const res = await Storage.action('tools', t.id, 'retire', { reason, expectedUpdatedAt: t.updatedAt });
        if (!res.ok) {
          if (res.fields && showErrors(form, res.fields)) return;
          Utils.toast(res.message || 'The tool could not be retired.', 'error');
          if (res.status === 409 || res.status === 403) { Utils.Modal.close(); load(); }
          return;
        }
        Utils.Modal.close();
        Utils.toast(`${t.name} (${t.id}) was retired.`, 'success');
        await load();
      });
    });
  }

  /* ---------- export ---------- */

  async function exportCsv(btn) {
    await Utils.guard(btn, async () => {
      const res = await fetchAllMatching(state, (q) => Storage.loadPage('tools', q));
      if (!res.ok) { Utils.toast(res.message || 'The export could not be prepared.', 'error'); return; }
      const blob = new Blob(['﻿' + toCsv(res.rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tools-${todayInDhaka()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Utils.toast(`Exported ${res.rows.length} tool${res.rows.length === 1 ? '' : 's'}.`, 'success');
      // loadPage replaced the cache with the export; the page shown is unchanged on screen.
    });
  }

  /* ---------- events ---------- */

  function fillFilters() {
    $('wtCategory').insertAdjacentHTML('beforeend', options(CATEGORIES));
    $('wtStatus').insertAdjacentHTML('beforeend', options(STATUSES));
    $('wtCondition').insertAdjacentHTML('beforeend', options(CONDITIONS));
  }

  function resetFilters() {
    state.q = ''; state.category = ''; state.status = ''; state.condition = ''; state.offset = 0;
    $('wtSearch').value = ''; $('wtCategory').value = ''; $('wtStatus').value = ''; $('wtCondition').value = '';
    load();
  }

  function onAct(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const t = findRow(btn.dataset.id);
    if (btn.dataset.act === 'view') openDetails(btn.dataset.id);
    else if (btn.dataset.act === 'edit' && t) openForm(t);
    else if (btn.dataset.act === 'retire' && t) openRetire(t);
  }

  function bind() {
    fillFilters();
    $('wtAdd').addEventListener('click', () => openForm());
    $('wtSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('wtSearch').value.trim(); state.offset = 0; load(); }, 300);
    });
    for (const [id, key] of [['wtCategory', 'category'], ['wtStatus', 'status'], ['wtCondition', 'condition'], ['wtSort', 'sort']]) {
      $(id).addEventListener('change', () => { state[key] = $(id).value; state.offset = 0; load(); });
    }
    $('wtPageSize').addEventListener('change', () => { state.limit = Number($('wtPageSize').value) || 25; state.offset = 0; load(); });
    $('wtPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
    $('wtNext').addEventListener('click', () => { state.offset += state.limit; load(); });
    $('wtClear').addEventListener('click', resetFilters);
    $('wtExport').addEventListener('click', (ev) => exportCsv(ev.currentTarget));
    $('wtBody').addEventListener('click', onAct);
    $('wtCards').addEventListener('click', onAct);
    $('wtState').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-state-action]');
      if (!b) return;
      const a = b.dataset.stateAction;
      if (a === 'retry') load();
      else if (a === 'clear') resetFilters();
      else if (a === 'add') openForm();
      else if (a === 'reload') location.reload();
    });
  }

  function init() {
    if (document.body.dataset.page !== 'workshop-tools') return;
    bind();
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return {
    CATEGORIES, CONDITIONS, STATUSES, FORM_STATUSES, LIMITS,
    validate, payload, buildQuery, toCsv, warrantyState, canRetire, fetchAllMatching, todayInDhaka,
    init, _state: state, load,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkshopToolsUI };

// The page's markup is already parsed (this script is at the end of <body>),
// so it is wired now; the list is read once the data source is settled.
if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) WorkshopToolsUI.init();
