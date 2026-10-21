/* ============================================================
   estimates.js — Estimates & Quotations (staff pages)
   ------------------------------------------------------------
   Loaded by pages/estimates.html (overview), estimate-create.html
   (new, or ?id= to edit) and estimate-details.html (?id=). All three
   share <body data-page="estimates"> so the sidebar link stays
   active; which page this is comes from data-est-view.

   Source of truth: the workshop database, and nothing else.
     - Estimates are read on demand through Storage.load('estimates')
       and Storage.loadOne('estimates', id), ONLY in 'api' mode. They
       are not part of the app-wide hydration, so if they cannot be
       read this page says so and every other page is unaffected.
     - In every other mode -- no backend, a backend that failed, a
       signed-out browser -- these pages read nothing and write
       nothing. There is no browser-storage or demo fallback.
     - Customer, vehicle, service, part, mechanic and Settings data come
       from the collections the app already loaded.
     - The Worker re-checks every field and calculates every stored
       total itself (src/routes/estimates.js). The preview here uses the
       same computeTotals() as the Job Card page, only to show the
       figure before saving.

   Rules (also asserted in tests/unit/estimates-ui.test.cjs):
     - "Today" is the Asia/Dhaka calendar day, as in the Worker. An
       estimate is valid through the whole of its valid-until day.
     - Expired and Converted are derived by the Worker (displayStatus);
       this page never stores a status.
     - A create carries an idempotency key made when the page opens;
       after an answer that does not say whether the server saved it,
       the form freezes and Retry resends the SAME key and payload. An
       edit carries the version it was made from (expectedUpdatedAt).
     - Names typed under the shared login are labelled as unverified.
     - Print opens the browser's print dialog for the quotation sheet.
   ============================================================ */

const Estimates = (() => {

  const esc = (typeof Utils !== 'undefined' && Utils.esc) ? Utils.esc : (s => String(s ?? ''));

  /* Field limits: the Worker's (src/routes/estimates.js LIMITS) and the
     schema's CHECKs (0007) use the same numbers. */
  const LIMITS = { complaint: 2000, notes: 2000, note: 1000, reason: 500, name: 100 };
  const VALIDITY_DAYS = 30;
  const MAX_LINES = 200;
  const PAGE_SIZE = 10;
  const STATUS_FILTERS = ['all', 'Draft', 'Pending', 'Expired', 'Approved', 'Converted', 'Rejected', 'Cancelled'];
  const STATUS_TONE = {
    Draft: 'neutral', Pending: 'warn', Expired: 'neutral', Approved: 'good',
    Converted: 'info', Rejected: 'bad', Cancelled: 'neutral',
  };
  const EDITABLE = ['Draft', 'Pending'];
  const JOB_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

  /* ---------- dates (the Worker's convention) ---------- */

  let dhakaFormat = null;
  try {
    dhakaFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (e) { dhakaFormat = null; }
  function dhakaToday(now = new Date()) {
    if (dhakaFormat) return dhakaFormat.format(now);
    return new Date(now.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const isDateOnly = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function daysBetween(from, to) {
    const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((t(to) - t(from)) / 86400000);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function formatDay(iso) {
    if (!isDateOnly(iso)) return '—';
    const [y, m, d] = iso.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }
  function formatStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return `${formatDay(dhakaToday(d))}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' })}`;
  }

  /* ---------- money (the Job Card page's own functions, verbatim) ---------- */

  /** rate% of subtotal, half-up to the paisa, in integer arithmetic; the server's percentDiscount() is the same. */
  function percentDiscount(subtotal, rate) {
    const bp = Math.round(rate * 100);
    const paisa = Math.floor((Math.round(subtotal * 10000) * bp + 500000) / 1000000);
    return Math.min(paisa / 100, subtotal);
  }

  function computeTotals(job) {
    const serviceTotal = (job.services || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const partsTotal = (job.partsUsed || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const hours = Number(job.labourHours) || 0;
    const rate = Number(job.labourRate) || 0;
    // hours×rate wins when provided; otherwise a directly entered labourCost stands (legacy support)
    const labourCost = (hours > 0 && rate > 0) ? hours * rate : (Number(job.labourCost) || 0);
    const subtotal = serviceTotal + partsTotal + labourCost;
    const taxRate = Number(job.taxRate) || 0;
    const paid = Number(job.paid) || 0;
    let discount, tax, total;
    if (job.discountType === 'percent') {
      // worked in paisa so a discount such as 49.95 leaves no float residue in the total
      discount = percentDiscount(subtotal, Number(job.discountRate) || 0);
      const net = Math.round(subtotal * 100) - Math.round(discount * 100);
      tax = Math.round(net * taxRate / 10000);
      total = (net + tax * 100) / 100;
    } else {
      discount = Math.min(Number(job.discount) || 0, subtotal);
      tax = Math.round((subtotal - discount) * taxRate / 100);
      total = subtotal - discount + tax;
    }
    return { serviceTotal, partsTotal, labourCost, subtotal, discount, taxRate, tax, total, paid, due: Math.max(total - paid, 0) };
  }

  function money(n) {
    if (typeof Utils !== 'undefined' && Utils.money) return Utils.money(n);
    return `৳ ${(Number(n) || 0).toLocaleString('en-IN')}`;
  }

  /* ---------- list logic (pure) ---------- */

  const isActiveRow = e => e && e.status !== 'Cancelled';

  /** The summary cards, always over the whole list. */
  function summary(list) {
    const rows = (list || []).filter(Boolean);
    const by = s => rows.filter(e => e.displayStatus === s);
    const pending = by('Pending');
    return {
      total: rows.filter(isActiveRow).length,
      drafts: by('Draft').length,
      converted: by('Converted').length,
      pending: pending.length,
      approved: by('Approved').length,
      rejected: by('Rejected').length,
      expired: by('Expired').length,
      cancelled: by('Cancelled').length,
      pendingValue: Math.round(pending.reduce((s, e) => s + (Number(e.total) || 0), 0) * 100) / 100,
    };
  }

  /** Free-text search over number, customer name and phone, vehicle and the complaint. */
  function matches(e, q, lookup) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    const c = lookup.customer(e.customerId) || {};
    const v = lookup.vehicle(e.vehicleId) || {};
    return [e.id, e.complaint, c.name, c.phone, v.regNo, v.brand, v.model]
      .some(s => String(s || '').toLowerCase().includes(needle));
  }

  function filterList(list, { q = '', status = 'all', from = '', to = '' } = {}, lookup) {
    return (list || []).filter(e => e
      && (status === 'all' || e.displayStatus === status)
      && (!from || e.date >= from) && (!to || e.date <= to)
      && matches(e, q, lookup));
  }

  function paginate(list, page, size = PAGE_SIZE) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page), pages);
    const rows = list.slice((p - 1) * size, p * size);
    return { rows, page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: (p - 1) * size + rows.length, total: list.length };
  }

  /** Which actions an estimate in this state offers. The Worker refuses anything else. */
  function actionsFor(e) {
    if (!e) return [];
    if (e.isConverted) return ['jobcard'];
    if (e.conversionInProgress) return [];
    switch (e.status) {
      case 'Draft': return ['edit', 'send', 'cancel'];
      case 'Pending': return e.isExpired ? ['edit', 'reject', 'cancel'] : ['edit', 'approve', 'reject', 'cancel'];
      case 'Approved': return ['convert', 'cancel'];
      default: return [];
    }
  }

  /* ---------- submissions (the Follow-up Tasks page's pattern) ---------- */

  function newKey(cryptoObj = (typeof crypto !== 'undefined' ? crypto : null)) {
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }
  function isAmbiguous(res) {
    if (!res || res.ok) return false;
    if (['timeout', 'network_error', 'malformed_response'].includes(res.code)) return true;
    return typeof res.status === 'number' && (res.status === 0 || res.status >= 500);
  }
  function createSubmission(cryptoObj) {
    const key = newKey(cryptoObj);
    let payload = null;
    let frozen = false;
    return {
      get key() { return key; },
      get frozen() { return frozen; },
      body(next) {
        if (!key) return null;
        if (!frozen) payload = { ...next, idempotencyKey: key };
        return payload;
      },
      settle(res) { if (isAmbiguous(res)) frozen = true; return res; },
    };
  }

  /* ---------- form validation (pure; the Worker checks again) ---------- */

  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));

  function validateForm(v, today = dhakaToday()) {
    const e = {};
    if (!v.customerId) e.customerId = 'Choose a customer.';
    if (!v.vehicleId) e.vehicleId = 'Choose one of this customer’s vehicles.';
    if (!String(v.complaint || '').trim()) e.complaint = 'Describe the complaint or the work proposed.';
    else if (v.complaint.length > LIMITS.complaint) e.complaint = `Keep the description to ${LIMITS.complaint} characters.`;
    if ((v.notes || '').length > LIMITS.notes) e.notes = `Keep the notes to ${LIMITS.notes} characters.`;
    if (v.date && !isDateOnly(v.date)) e.date = 'Enter a valid date.';
    if (v.validUntil && !isDateOnly(v.validUntil)) e.validUntil = 'Enter a valid date.';
    if (isDateOnly(v.date) && isDateOnly(v.validUntil) && v.validUntil < v.date) e.validUntil = 'Valid Until cannot be earlier than the estimate date.';
    if (v.services.length > MAX_LINES) e.services = `No more than ${MAX_LINES} lines.`;
    if (v.partsUsed.length > MAX_LINES) e.partsUsed = `No more than ${MAX_LINES} lines.`;
    for (const [field, lines] of [['services', v.services], ['partsUsed', v.partsUsed]]) {
      for (const l of lines) {
        if (!String(l.name || '').trim()) { e[field] = 'Every line needs a description.'; break; }
        if (!(Number(l.qty) > 0) || !(Number(l.unitPrice) >= 0) || !Number.isFinite(Number(l.unitPrice))) {
          e[field] = 'Quantity must be more than 0 and the price cannot be negative.'; break;
        }
      }
    }
    for (const [k, label] of [['labourHours', 'Labour hours'], ['labourRate', 'Rate per hour'], ['labourCost', 'Labour cost']]) {
      if (v[k] !== null && !(v[k] >= 0)) e[k] = `${label} cannot be negative.`;
    }
    if (v.taxRate !== null && !(v.taxRate >= 0 && v.taxRate <= 100)) e.taxRate = 'Tax must be between 0 and 100.';
    const t = computeTotals({ ...v, discount: v.discountType === 'percent' ? 0 : v.discount });
    if (v.discountType === 'percent') {
      if (!(v.discountRate >= 0 && v.discountRate <= 100)) e.discountRate = 'A percentage discount must be between 0 and 100.';
    } else if (!(v.discount >= 0)) e.discount = 'Discount cannot be negative.';
    else if (v.discount > t.subtotal) e.discount = 'Discount cannot exceed the subtotal.';
    if (!v.services.length && !v.partsUsed.length && !(t.labourCost > 0)) e.services = 'Add at least one service, part, or labour entry.';
    if ((v.by || '').length > LIMITS.name) e.by = `Keep the name to ${LIMITS.name} characters.`;
    return e;
  }

  /** The request body for a create or an edit, from the form values. */
  function formBody(v) {
    const body = {
      customerId: v.customerId, vehicleId: v.vehicleId, date: v.date || undefined, validUntil: v.validUntil || undefined,
      complaint: v.complaint.trim(), notes: (v.notes || '').trim(),
      services: v.services.map(l => ({ serviceId: l.serviceId || null, name: l.name.trim(), qty: Number(l.qty), unitPrice: Number(l.unitPrice) })),
      partsUsed: v.partsUsed.map(l => ({ partId: l.partId || null, name: l.name.trim(), partNo: (l.partNo || '').trim(), qty: Number(l.qty), unitPrice: Number(l.unitPrice) })),
      labourHours: v.labourHours, labourRate: v.labourRate, labourCost: v.labourCost ?? 0,
      discountType: v.discountType,
      ...(v.discountType === 'percent' ? { discountRate: v.discountRate } : { discount: v.discount ?? 0 }),
      taxRate: v.taxRate,
    };
    if (body.taxRate === null) delete body.taxRate;
    return body;
  }

  /* ---------- shared DOM helpers ---------- */

  const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const lookup = {
    customer: id => (typeof Storage !== 'undefined' ? Storage.getById('customers', id) : null),
    vehicle: id => (typeof Storage !== 'undefined' ? Storage.getById('vehicles', id) : null),
  };
  const customerName = id => (lookup.customer(id) || {}).name || `Unknown customer (${id})`;
  function vehicleText(id) {
    const v = lookup.vehicle(id);
    return v ? `${v.regNo || ''} · ${[v.brand, v.model].filter(Boolean).join(' ')}` : `Unknown vehicle (${id})`;
  }
  const statusBadge = s => `<span class="badge badge--${STATUS_TONE[s] || 'neutral'}">${esc(s)}</span>`;
  const detailHref = (id, extra = '') => `estimate-details.html?id=${encodeURIComponent(id)}${extra}`;
  const editHref = id => `estimate-create.html?id=${encodeURIComponent(id)}`;
  const toast = (msg, type) => { if (typeof Utils !== 'undefined') Utils.toast(msg, type); };
  function notice(el, text, tone) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    if (tone) el.className = `est-notice est-notice--${tone}`;
  }
  function stateRow(cols, title, text, extraHtml = '') {
    return `<tr class="est-empty-row"><td colspan="${cols}"><div class="est-empty-row__box"><strong>${esc(title)}</strong><span>${esc(text)}</span>${extraHtml}</div></td></tr>`;
  }
  const UNAVAILABLE = {
    no_api: 'This copy of the app is not connected to the workshop database, so no estimates are shown and none can be saved.',
    other: 'The workshop database did not answer, so no estimates are shown. Nothing stored in this browser is used in their place.',
  };

  /* ============================================================
     Overview
     ============================================================ */

  const state = { q: '', status: 'all', from: '', to: '', page: 1, loaded: false };
  let debounce = null;

  function setCards(s) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    if (!s) { ['estTotal', 'estPending', 'estApproved', 'estRejected', 'estExpired', 'estPendingValue'].forEach(id => set(id, '—')); return; }
    set('estTotal', String(s.total));
    set('estTotalSub', `${s.drafts} draft${s.drafts === 1 ? '' : 's'} · ${s.converted} converted`);
    set('estPending', String(s.pending));
    set('estApproved', String(s.approved));
    set('estRejected', String(s.rejected));
    set('estExpired', String(s.expired));
    set('estPendingValue', money(s.pendingValue));
  }

  function setControls(on) {
    ['estSearch', 'estStatus', 'estFrom', 'estTo', 'estClear'].forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  }

  function renderOverviewList() {
    const all = Storage.getData('estimates');
    setCards(summary(all));
    const bad = state.from && state.to && state.from > state.to;
    const err = $('estRangeError');
    if (err) err.hidden = !bad;
    const rows = bad ? [] : filterList(all, state, lookup);
    const pg = paginate(rows, state.page);
    state.page = pg.page;
    const body = $('estBody');
    const count = $('estCount');
    if (count) count.textContent = `${rows.length} of ${all.length} estimate${all.length === 1 ? '' : 's'}`;
    if (!all.length) {
      body.innerHTML = stateRow(10, 'No estimates yet', 'Estimates you prepare for customers will be listed here.',
        '<a class="btn btn--primary btn--sm" href="estimate-create.html">New Estimate</a>');
    } else if (!rows.length) {
      body.innerHTML = stateRow(10, 'No estimates match', 'Try another search or clear the filters.',
        '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>');
    } else {
      body.innerHTML = pg.rows.map(e => {
        const editable = EDITABLE.includes(e.status) && !e.isConverted;
        return `<tr>
          <td><a class="est-link" href="${esc(detailHref(e.id))}">${esc(e.id)}</a></td>
          <td class="est-nowrap">${esc(formatDay(e.date))}</td>
          <td>${esc(customerName(e.customerId))}</td>
          <td>${esc(vehicleText(e.vehicleId))}</td>
          <td class="num">${esc(money(e.partsTotal))}</td>
          <td class="num">${esc(money((Number(e.servicesTotal) || 0) + (Number(e.labourCost) || 0)))}</td>
          <td class="num est-strong">${esc(money(e.total))}</td>
          <td class="est-nowrap">${esc(formatDay(e.validUntil))}</td>
          <td>${statusBadge(e.displayStatus)}</td>
          <td class="est-row-actions">
            <a class="btn btn--ghost btn--sm" href="${esc(detailHref(e.id))}">View</a>
            ${editable ? `<a class="btn btn--ghost btn--sm" href="${esc(editHref(e.id))}">Edit</a>` : ''}
            <a class="btn btn--ghost btn--sm" href="${esc(detailHref(e.id, '&print=1'))}">Print</a>
          </td>
        </tr>`;
      }).join('');
    }
    const range = $('estRange');
    if (range) range.textContent = rows.length ? `Showing ${pg.from}–${pg.to} of ${pg.total}` : '';
    const prev = $('estPrev'), next = $('estNext');
    if (prev) prev.disabled = pg.page <= 1;
    if (next) next.disabled = pg.page >= pg.pages;
  }

  function renderOverviewUnavailable(code) {
    state.loaded = false;
    setControls(false);
    setCards(null);
    $('estBody').innerHTML = stateRow(10, code === 'no_api' ? 'Estimates need the workshop database' : 'Estimates could not be loaded',
      UNAVAILABLE[code === 'no_api' ? 'no_api' : 'other'],
      code === 'no_api' ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-action="retry">Try again</button>');
    const n = $('estNew'); if (n && code === 'no_api') n.hidden = true;
  }

  async function loadOverview() {
    if (!Storage.isApi()) { renderOverviewUnavailable('no_api'); return; }
    setControls(false);
    $('estBody').innerHTML = stateRow(10, 'Loading estimates…', 'Reading estimates from the workshop database.');
    const res = await Storage.load('estimates');
    if (!res.ok) { renderOverviewUnavailable(res.code); return; }
    state.loaded = true;
    setControls(true);
    renderOverviewList();
  }

  function bindOverview() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('estSearch', 'input', e => {
      const value = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.q = value; state.page = 1; renderOverviewList(); }, 200);
    });
    on('estStatus', 'change', e => { state.status = STATUS_FILTERS.includes(e.target.value) ? e.target.value : 'all'; state.page = 1; renderOverviewList(); });
    on('estFrom', 'change', e => { state.from = e.target.value || ''; state.page = 1; renderOverviewList(); });
    on('estTo', 'change', e => { state.to = e.target.value || ''; state.page = 1; renderOverviewList(); });
    const clear = () => {
      Object.assign(state, { q: '', status: 'all', from: '', to: '', page: 1 });
      ['estSearch', 'estFrom', 'estTo'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      const s = $('estStatus'); if (s) s.value = 'all';
      renderOverviewList();
    };
    on('estClear', 'click', clear);
    on('estPrev', 'click', () => { state.page -= 1; renderOverviewList(); });
    on('estNext', 'click', () => { state.page += 1; renderOverviewList(); });
    on('estBody', 'click', e => {
      const btn = e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'retry') loadOverview();
      if (btn.dataset.action === 'clear') clear();
    });
  }

  /* ============================================================
     Create / edit
     ============================================================ */

  let editing = null;          // the estimate being edited (detail shape), or null for a new one
  let dirty = false;
  let validTouched = false;
  const submission = createSubmission();

  const activeServices = () => Storage.getData('services').filter(s => s && s.status !== 'Inactive')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const activeParts = () => Storage.getData('parts').filter(p => p && p.status !== 'Inactive')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  function customerOptions(query, selected) {
    const q = String(query || '').trim().toLowerCase();
    const list = Storage.getData('customers')
      .filter(c => c && (c.status !== 'Inactive' || c.id === selected))
      .filter(c => !q || c.id === selected || String(c.name || '').toLowerCase().includes(q) || String(c.phone || '').toLowerCase().includes(q))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return `<option value="">${list.length ? 'Select a customer' : 'No customer matches'}</option>`
      + list.map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.status === 'Inactive' ? ' (inactive)' : ''}</option>`).join('');
  }
  function vehicleOptions(customerId, selected) {
    if (!customerId) return '<option value="">Select a customer first</option>';
    const cars = Storage.getData('vehicles').filter(v => v && v.customerId === customerId && (v.status !== 'Inactive' || v.id === selected));
    if (!cars.length) return '<option value="">This customer has no active vehicle</option>';
    return '<option value="">Select a vehicle</option>' + cars.map(v =>
      `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} · ${esc([v.brand, v.model].filter(Boolean).join(' '))}${v.status === 'Inactive' ? ' (inactive)' : ''}</option>`).join('');
  }

  const removeBtn = kind => `<button type="button" class="icon-btn icon-btn--sm" data-remove aria-label="Remove this ${kind} line" title="Remove this line"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>`;

  function serviceRowHtml(l = {}) {
    const custom = l.name && !l.serviceId;
    const opts = activeServices();
    const known = opts.some(s => s.id === l.serviceId);
    return `<tr class="est-line" data-kind="service">
      <td>
        <select class="select est-l-ref" aria-label="Service">
          <option value="">Choose a service…</option>
          ${opts.map(s => `<option value="${esc(s.id)}" data-name="${esc(s.name)}" data-price="${esc(s.price)}"${s.id === l.serviceId ? ' selected' : ''}>${esc(s.name)} — ${esc(money(s.price))}</option>`).join('')}
          ${l.serviceId && !known ? `<option value="${esc(l.serviceId)}" data-name="${esc(l.name)}" selected>${esc(l.name)} (no longer in the catalogue)</option>` : ''}
          <option value="__custom"${custom ? ' selected' : ''}>Custom work…</option>
        </select>
        <input class="input est-l-name" type="text" maxlength="200" aria-label="Description" placeholder="Description" value="${esc(l.name || '')}"${custom ? '' : ' hidden'}>
        <span class="est-muted est-l-hint"></span>
      </td>
      <td class="num"><input class="input est-l-qty" type="number" min="0" step="0.25" inputmode="decimal" aria-label="Quantity" value="${esc(l.qty ?? 1)}"></td>
      <td class="num"><input class="input est-l-price" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Unit price" value="${esc(l.unitPrice ?? '')}"></td>
      <td class="num est-l-total">—</td>
      <td>${removeBtn('service')}</td>
    </tr>`;
  }

  function partRowHtml(l = {}) {
    const manual = l.name && !l.partId;
    const opts = activeParts();
    const known = opts.some(p => p.id === l.partId);
    return `<tr class="est-line" data-kind="part">
      <td>
        <select class="select est-l-ref" aria-label="Part">
          <option value="">Choose a part…</option>
          ${opts.map(p => `<option value="${esc(p.id)}" data-name="${esc(p.name)}" data-price="${esc(p.sellingPrice)}" data-no="${esc(p.partNo || '')}" data-stock="${esc(p.stock)}"${p.id === l.partId ? ' selected' : ''}>${esc(p.name)}${p.partNo ? ` · ${esc(p.partNo)}` : ''} — ${esc(money(p.sellingPrice))}</option>`).join('')}
          ${l.partId && !known ? `<option value="${esc(l.partId)}" data-name="${esc(l.name)}" data-no="${esc(l.partNo || '')}" selected>${esc(l.name)} (no longer active)</option>` : ''}
          <option value="__manual"${manual ? ' selected' : ''}>Manual part…</option>
        </select>
        <input class="input est-l-name" type="text" maxlength="200" aria-label="Part name" placeholder="Part name" value="${esc(l.name || '')}"${manual ? '' : ' hidden'}>
        <input class="input est-l-no" type="text" maxlength="100" aria-label="Part number" placeholder="Part no. (optional)" value="${esc(l.partNo || '')}"${manual ? '' : ' hidden'}>
        <span class="est-muted est-l-hint"></span>
      </td>
      <td class="num"><input class="input est-l-qty" type="number" min="0" step="1" inputmode="decimal" aria-label="Quantity" value="${esc(l.qty ?? 1)}"></td>
      <td class="num"><input class="input est-l-price" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Unit price" value="${esc(l.unitPrice ?? '')}"></td>
      <td class="num est-l-total">—</td>
      <td>${removeBtn('part')}</td>
    </tr>`;
  }

  /** One line row -> { serviceId|partId, name, partNo, qty, unitPrice }, or null for an untouched empty row. */
  function readRow(tr) {
    const kind = tr.dataset.kind;
    const sel = tr.querySelector('.est-l-ref');
    const ref = sel.value;
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    const isFree = ref === '__custom' || ref === '__manual';
    const qty = tr.querySelector('.est-l-qty').value;
    const unitPrice = tr.querySelector('.est-l-price').value;
    if (!ref) return null;
    const name = isFree ? tr.querySelector('.est-l-name').value : ((opt && opt.dataset.name) || '');
    const line = { name, qty, unitPrice };
    if (kind === 'service') line.serviceId = isFree ? null : ref;
    else {
      line.partId = isFree ? null : ref;
      line.partNo = isFree ? tr.querySelector('.est-l-no').value : (opt && opt.dataset.no) || '';
    }
    return line;
  }

  function readForm() {
    const val = id => ($(id) ? $(id).value : '');
    const lines = kind => Array.from($(kind === 'service' ? 'estServiceRows' : 'estPartRows').querySelectorAll('tr.est-line'))
      .map(readRow).filter(Boolean);
    const type = val('estDiscType') === 'percent' ? 'percent' : 'amount';
    const d = num(val('estDiscValue'));
    return {
      customerId: val('estCustomer'), vehicleId: val('estVehicle'), date: val('estDate'), validUntil: val('estValid'),
      complaint: val('estDescription'), notes: val('estNotes'),
      services: lines('service'), partsUsed: lines('part'),
      labourHours: num(val('estLabourHours')), labourRate: num(val('estLabourRate')), labourCost: num(val('estLabourCost')),
      discountType: type, discount: type === 'amount' ? (d ?? 0) : 0, discountRate: type === 'percent' ? (d ?? 0) : null,
      taxRate: num(val('estTax')), by: val('estBy').trim(),
    };
  }

  function updateRow(tr) {
    const sel = tr.querySelector('.est-l-ref');
    const ref = sel.value;
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    const isFree = ref === '__custom' || ref === '__manual';
    tr.querySelectorAll('.est-l-name, .est-l-no').forEach(el => { el.hidden = !isFree; });
    const qty = Number(tr.querySelector('.est-l-qty').value) || 0;
    const price = Number(tr.querySelector('.est-l-price').value) || 0;
    tr.querySelector('.est-l-total').textContent = ref ? money(qty * price) : '—';
    const hint = tr.querySelector('.est-l-hint');
    const listPrice = opt && opt.dataset.price !== undefined && opt.dataset.price !== '' ? Number(opt.dataset.price) : null;
    const bits = [];
    if (!isFree && listPrice !== null && tr.querySelector('.est-l-price').value !== '' && price !== listPrice) bits.push(`Catalogue price ${money(listPrice)} — overridden`);
    if (tr.dataset.kind === 'part' && opt && opt.dataset.stock !== undefined && !isFree && ref) bits.push(`In stock: ${opt.dataset.stock} (not reserved)`);
    hint.textContent = bits.join(' · ');
  }

  function updatePreview() {
    const v = readForm();
    document.querySelectorAll('#estServiceRows tr.est-line, #estPartRows tr.est-line').forEach(updateRow);
    const t = computeTotals(v);
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('estPvParts', money(t.partsTotal));
    set('estPvLabour', money(t.serviceTotal + t.labourCost));
    set('estPvSubtotal', money(t.subtotal));
    set('estPvDiscLabel', v.discountType === 'percent' ? `Discount (${v.discountRate || 0}%)` : 'Discount');
    set('estPvDiscount', `− ${money(t.discount)}`);
    set('estPvTaxLabel', `Tax (${t.taxRate}%)`);
    set('estPvTax', money(t.tax));
    set('estPvTotal', money(t.total));
    const noS = $('estNoServices'), noP = $('estNoParts');
    if (noS) noS.hidden = !!$('estServiceRows').querySelector('tr');
    if (noP) noP.hidden = !!$('estPartRows').querySelector('tr');
    if ($('estValidDays')) {
      const d = $('estDate').value, u = $('estValid').value;
      $('estValidDays').textContent = isDateOnly(d) && isDateOnly(u) && u >= d ? `${daysBetween(d, u)} days` : '';
    }
    const notes = [];
    const errs = validateForm(v);
    Object.values(errs).forEach(m => { if (!notes.includes(m)) notes.push(m); });
    const box = $('estPvNotes');
    if (box) {
      box.hidden = !notes.length;
      box.innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
    }
  }

  function showFieldErrors(errors) {
    const root = $('estForm');
    root.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    root.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    Object.entries(errors).forEach(([k, msg]) => {
      const key = k === 'by' ? (editing ? 'updatedBy' : 'createdBy') : k;
      const el = root.querySelector(`[data-err="${key}"]`);
      if (el) { el.textContent = msg; const f = el.closest('.field'); if (f) f.classList.add('field--error'); }
    });
    return !Object.keys(errors).length;
  }

  function freezeForm() {
    document.querySelectorAll('#estForm input, #estForm select, #estForm textarea, #estForm button').forEach(el => { el.disabled = true; });
  }

  function setFormUnavailable(text) {
    const layout = $('estFormLayout');
    if (layout) layout.hidden = true;
    notice($('estFormNotice'), text, 'bad');
  }

  async function saveForm(andSend) {
    const v = readForm();
    const errors = validateForm(v);
    if (!submission.frozen && !showFieldErrors(errors)) {
      notice($('estFormNotice'), 'Some fields need attention before saving.', 'bad');
      return;
    }
    notice($('estFormNotice'), '');
    let res;
    if (editing) {
      res = await Storage.update('estimates', editing.id, { ...formBody(v), updatedBy: v.by || undefined, expectedUpdatedAt: editing.updatedAt });
      if (!res.ok && res.errorReason === 'concurrent_modification') {
        notice($('estFormNotice'), 'Someone else changed this estimate after you opened it. Reload the page to see their changes; your edits here were not saved.', 'bad');
        return;
      }
      if (!res.ok && ['estimate_closed', 'estimate_converted'].includes(res.errorReason)) {
        notice($('estFormNotice'), `${res.message} Nothing was saved.`, 'bad');
        return;
      }
    } else {
      const body = submission.body({ ...formBody(v), createdBy: v.by || undefined });
      if (!body) { notice($('estFormNotice'), 'This browser cannot create a secure submission key, so nothing was sent. Use an up-to-date browser over https.', 'bad'); return; }
      res = submission.settle(await Storage.create('estimates', body));
      if (submission.frozen && !res.ok) {
        freezeForm();
        ['estSaveDraft', 'estSaveSend'].forEach(id => { const b = $(id); if (b) { b.disabled = false; setTimeout(() => { b.textContent = 'Retry'; }, 0); } });
        notice($('estFormNotice'), 'The workshop database did not confirm this. It may or may not have been saved. Retry sends exactly the same request again and can never save it twice.', 'warn');
        return;
      }
      if (!res.ok && res.errorReason === 'idempotency_key_reused') {
        notice($('estFormNotice'), 'This submission could not be matched. Reload the page and start again.', 'bad');
        return;
      }
    }
    if (!res.ok) {
      showFieldErrors(res.fields || {});
      notice($('estFormNotice'), res.message || 'Could not save. Please try again.', 'bad');
      return;
    }
    const saved = res.record;
    dirty = false;
    if (andSend) {
      const sent = await Storage.action('estimates', saved.id, 'send', { by: v.by || undefined, expectedUpdatedAt: saved.updatedAt });
      if (!sent.ok) {
        location.href = detailHref(saved.id, `&msg=${encodeURIComponent('saved-not-sent')}`);
        return;
      }
    }
    location.href = detailHref(saved.id, `&msg=${encodeURIComponent(andSend ? 'sent' : (editing ? 'updated' : 'created'))}`);
  }

  async function initForm() {
    if (!Storage.isApi()) { setFormUnavailable(UNAVAILABLE.no_api); return; }
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const settings = Storage.getSettings() || {};
    if (id) {
      const res = await Storage.loadOne('estimates', id);
      if (!res.ok) {
        setFormUnavailable(res.status === 404 ? `There is no estimate ${id}.` : UNAVAILABLE.other);
        return;
      }
      editing = res.record;
      if (!EDITABLE.includes(editing.status) || editing.isConverted) {
        setFormUnavailable(`Estimate ${editing.id} is ${editing.displayStatus} and can no longer be edited.`);
        return;
      }
      $('estFormCrumb').textContent = `Edit ${editing.id}`;
      $('estFormSubtitle').textContent = `Editing ${editing.id} (version ${editing.version}).`;
      $('estFormCancel').href = detailHref(editing.id);
      if (editing.status === 'Pending') {
        notice($('estEditNotice'), `${editing.id} has been issued to the customer. Saving changes returns it to Draft as version ${editing.version + 1}; it must then be sent again for the customer's decision.`, 'warn');
        $('estSaveSend').textContent = 'Save & Send again';
      }
    }
    const e = editing || {};
    const today = dhakaToday();
    $('estCustomer').innerHTML = customerOptions('', e.customerId);
    $('estVehicle').innerHTML = vehicleOptions(e.customerId, e.vehicleId);
    $('estDate').value = e.date || today;
    $('estValid').value = e.validUntil || addDays(e.date || today, VALIDITY_DAYS);
    validTouched = !!editing;
    $('estDescription').value = e.complaint || '';
    $('estNotes').value = e.notes || '';
    $('estLabourHours').value = e.labourHours ?? '';
    $('estLabourRate').value = e.labourRate ?? '';
    $('estLabourCost').value = editing && !(e.labourHours > 0 && e.labourRate > 0) && e.labourCost ? e.labourCost : '';
    $('estDiscType').value = e.discountType === 'percent' ? 'percent' : 'amount';
    $('estDiscValue').value = e.discountType === 'percent' ? (e.discountRate ?? 0) : (e.discount ?? 0);
    $('estTax').value = editing ? e.taxRate : (settings.taxRate ?? '');
    $('estServiceRows').innerHTML = (e.services || []).map(serviceRowHtml).join('');
    $('estPartRows').innerHTML = (e.partsUsed || []).map(partRowHtml).join('');
    if (!editing) { $('estServiceRows').innerHTML = serviceRowHtml(); }
    bindForm();
    updatePreview();
    if (!submission.key && !editing) notice($('estFormNotice'), 'This browser cannot create a secure submission key, so estimates cannot be saved here. Use an up-to-date browser over https.', 'bad');
  }

  function bindForm() {
    const form = $('estForm');
    const markDirty = () => { dirty = true; };
    form.addEventListener('input', e => {
      markDirty();
      if (e.target.id === 'estValid') validTouched = true;
      if (e.target.id === 'estDate' && !validTouched && isDateOnly(e.target.value)) $('estValid').value = addDays(e.target.value, VALIDITY_DAYS);
      updatePreview();
    });
    form.addEventListener('change', e => {
      markDirty();
      const t = e.target;
      if (t.id === 'estCustomer') $('estVehicle').innerHTML = vehicleOptions(t.value, '');
      if (t.classList.contains('est-l-ref')) {
        const opt = t.selectedOptions && t.selectedOptions[0];
        const tr = t.closest('tr');
        // Choosing a catalogue item fills its current price; staff may change it.
        if (opt && opt.dataset.price !== undefined) tr.querySelector('.est-l-price').value = opt.dataset.price;
      }
      updatePreview();
    });
    $('estCustomerSearch').addEventListener('input', e => {
      const keep = $('estCustomer').value;
      $('estCustomer').innerHTML = customerOptions(e.target.value, keep);
    });
    form.addEventListener('click', e => {
      const rm = e.target.closest && e.target.closest('[data-remove]');
      if (rm) { rm.closest('tr').remove(); markDirty(); updatePreview(); }
    });
    $('estAddService').addEventListener('click', () => { $('estServiceRows').insertAdjacentHTML('beforeend', serviceRowHtml()); updatePreview(); });
    $('estAddPart').addEventListener('click', () => { $('estPartRows').insertAdjacentHTML('beforeend', partRowHtml()); updatePreview(); });
    $('estSaveDraft').addEventListener('click', Utils.saving(() => saveForm(false)));
    $('estSaveSend').addEventListener('click', Utils.saving(() => saveForm(true)));
    window.addEventListener('beforeunload', ev => {
      if (!dirty) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
  }

  /* ============================================================
     Details
     ============================================================ */

  let current = null;

  const DONE_MESSAGES = {
    created: 'Estimate saved as a Draft.', updated: 'Estimate updated.', sent: 'Estimate saved and marked as sent.',
    'saved-not-sent': 'The estimate was saved, but it could not be marked as sent. Check the messages below and try Send again.',
  };
  const EVENT_LABEL = {
    created: 'Created', updated: 'Edited', sent: 'Sent to the customer', approved: 'Approved',
    rejected: 'Rejected', cancelled: 'Cancelled', converted: 'Converted to a job card',
  };
  const ACTION_LABEL = {
    edit: 'Edit', send: 'Send to Customer', approve: 'Record Approval', reject: 'Record Rejection',
    cancel: 'Cancel Estimate', convert: 'Convert to Job Card', jobcard: 'Open Job Card',
  };

  function terms(settings, e) {
    const out = [];
    if (settings.paymentTerms) out.push(...String(settings.paymentTerms).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    out.push(`Prices are valid until ${formatDay(e.validUntil)} and may change if further faults are found.`);
    out.push('Work starts only after the customer approves this quotation.');
    out.push('This is a quotation / estimate, not an invoice.');
    return out;
  }

  function renderDetail(e) {
    current = e;
    const settings = Storage.getSettings() || {};
    const today = dhakaToday();
    const c = lookup.customer(e.customerId);
    const v = lookup.vehicle(e.vehicleId);
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    document.title = `${e.id} — Estimates & Quotations`;
    set('estCrumb', e.id);
    set('estDetailId', e.id);
    $('estDetailStatus').innerHTML = statusBadge(e.displayStatus);
    set('estDetailVersion', `Version ${e.version}`);
    let validity;
    if (e.isConverted) validity = `Converted to job card ${e.jobCardId} on ${formatStamp(e.convertedAt)}`;
    else if (e.status === 'Cancelled') validity = `Cancelled on ${formatStamp(e.cancelledAt)}`;
    else if (e.isExpired) validity = `Expired — was valid until ${formatDay(e.validUntil)}. Edit it to extend the validity date, then send it again.`;
    else {
      const left = daysBetween(today, e.validUntil);
      validity = `Valid until ${formatDay(e.validUntil)}${left >= 0 && ['Draft', 'Pending'].includes(e.status) ? ` · ${left} day${left === 1 ? '' : 's'} left` : ''}`;
    }
    set('estDetailValidity', validity);
    $('estDetailActions').innerHTML = actionsFor(e).map((a, i) => (a === 'edit'
      ? `<a class="btn btn--ghost btn--sm" href="${esc(editHref(e.id))}">${ACTION_LABEL.edit}</a>`
      : a === 'jobcard'
        ? `<a class="btn btn--primary btn--sm" href="job-cards.html?view=${encodeURIComponent(e.jobCardId)}">${ACTION_LABEL.jobcard} ${esc(e.jobCardId)}</a>`
        : `<button type="button" class="btn ${i === 0 || a === 'convert' || a === 'send' || a === 'approve' ? 'btn--primary' : 'btn--ghost'} btn--sm" data-act="${a}">${ACTION_LABEL[a]}</button>`)).join('');

    // The quotation sheet.
    set('estShBusiness', settings.businessName || '');
    set('estShBusinessLines', [settings.address, settings.phone, settings.email, settings.taxId ? `Tax ID: ${settings.taxId}` : ''].filter(Boolean).join(' · '));
    set('estShNo', e.id);
    set('estShDate', formatDay(e.date));
    set('estShValid', formatDay(e.validUntil));
    set('estShVersion', String(e.version));
    $('estShCustomer').innerHTML = c
      ? `<strong>${esc(c.name)}</strong>${c.phone ? `<span>${esc(c.phone)}</span>` : ''}${c.email ? `<span>${esc(c.email)}</span>` : ''}${c.address ? `<span>${esc(c.address)}</span>` : ''}`
      : `<strong>${esc(customerName(e.customerId))}</strong>`;
    $('estShVehicle').innerHTML = v
      ? `<strong>${esc([v.brand, v.model].filter(Boolean).join(' '))}</strong><span>Reg. ${esc(v.regNo)}</span>${v.year ? `<span>Year ${esc(v.year)}</span>` : ''}`
      : `<strong>${esc(vehicleText(e.vehicleId))}</strong>`;
    set('estShDesc', e.complaint);
    $('estShNotesBlock').hidden = !e.notes;
    set('estShNotes', e.notes || '');
    const lineRows = (lines, empty, extra) => (lines.length ? lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td>${esc(l.name)}${extra(l)}</td><td class="num">${esc(l.qty)}</td><td class="num">${esc(money(l.unitPrice))}</td><td class="num">${esc(money(l.qty * l.unitPrice))}</td></tr>`).join('')
      : `<tr><td colspan="5" class="est-sh-none">${esc(empty)}</td></tr>`);
    $('estShServices').innerHTML = lineRows(e.services || [], 'No services on this estimate.', () => '');
    $('estShParts').innerHTML = lineRows(e.partsUsed || [], 'No parts on this estimate.', l => (l.partNo ? ` <span class="est-muted">(${esc(l.partNo)})</span>` : ''));
    const labourLine = e.labourHours > 0 && e.labourRate > 0 ? `Labour (${e.labourHours} h × ${money(e.labourRate)})` : 'Labour';
    const summaryRows = [
      ['Services', money(e.servicesTotal)], ['Parts', money(e.partsTotal)],
      ...(e.labourCost > 0 ? [[labourLine, money(e.labourCost)]] : []),
      ['Subtotal', money(e.subtotal)],
      [e.discountType === 'percent' ? `Discount (${e.discountRate}%)` : 'Discount', `− ${money(e.discount)}`],
      [`Tax (${e.taxRate}%)`, money(e.tax)],
    ];
    $('estShSummary').innerHTML = summaryRows.map(([k, val]) => `<tr><th scope="row">${esc(k)}</th><td class="num">${esc(val)}</td></tr>`).join('')
      + `<tr class="est-sh-total"><th scope="row">Estimated Total</th><td class="num">${esc(money(e.total))}</td></tr>`;
    $('estShTerms').innerHTML = terms(settings, e).map(t => `<li>${esc(t)}</li>`).join('');

    // Side panel: status / decision, breakdown, history.
    let decision = `<p class="est-muted">${esc(validity)}</p>`;
    if (e.status === 'Approved' || e.status === 'Rejected') {
      decision = `<p><strong>${esc(e.status)}</strong> — ${e.decidedVia === 'staff' ? 'Recorded by staff' : 'Online by the customer'} on ${esc(formatStamp(e.decidedAt))}${e.decidedBy ? ` by ${esc(e.decidedBy)} <span class="est-muted">(name entered, not verified)</span>` : ''}.</p>`
        + (e.decisionNote ? `<p class="est-quote">${esc(e.decisionNote)}</p>` : '')
        + (e.isConverted ? `<p>Job card: <a href="job-cards.html?view=${encodeURIComponent(e.jobCardId)}">${esc(e.jobCardId)}</a></p>` : '');
    } else if (e.status === 'Cancelled') {
      decision = `<p><strong>Cancelled</strong> on ${esc(formatStamp(e.cancelledAt))}.</p><p class="est-quote">${esc(e.cancelReason)}</p>`;
    } else if (e.status === 'Pending') {
      decision = `<p><strong>${e.isExpired ? 'Expired' : 'Waiting for the customer’s decision'}</strong> — sent on ${esc(formatStamp(e.sentAt))}.</p><p class="est-muted">Record the decision when the customer approves or declines by phone or in person.</p>`;
    } else if (e.status === 'Draft') {
      decision = `<p><strong>Draft</strong> — not yet issued to the customer.</p>${e.sentAt ? '<p class="est-muted">It was sent before and edited since, so the revised quotation must be sent again.</p>' : ''}`;
    }
    if (e.conversionInProgress) decision += '<p class="est-muted">A conversion to a job card is in progress. Reload in a moment.</p>';
    $('estDecision').innerHTML = decision;
    $('estBreakdown').innerHTML = [['Services', e.servicesTotal], ['Parts', e.partsTotal], ['Labour', e.labourCost], ['Subtotal', e.subtotal], ['Discount', -e.discount], ['Tax', e.tax]]
      .map(([k, val]) => `<div class="est-bd__row"><span>${esc(k)}</span><strong>${esc(val < 0 ? `− ${money(-val)}` : money(val))}</strong></div>`).join('')
      + `<div class="est-bd__row est-bd__total"><span>Estimated Total</span><strong>${esc(money(e.total))}</strong></div>`;
    $('estHistory').innerHTML = (e.history || []).slice().reverse().map(h => `<li>
        <strong>${esc(EVENT_LABEL[h.event] || h.event)}</strong>
        <span class="est-muted">${esc(formatStamp(h.at))} · version ${esc(h.version)}${h.actor ? ` · ${esc(h.actor)}` : ''}</span>
        ${h.note ? `<p>${esc(h.note)}</p>` : ''}
      </li>`).join('') || '<li class="est-muted">No activity recorded.</li>';

    $('estDetail').hidden = false;
  }

  function byField(id) {
    return `<div class="field"><label for="${id}">Your name</label><input class="input" id="${id}" type="text" maxlength="${LIMITS.name}" autocomplete="off"><p class="muted-note">A name only — the workshop shares one login, so it is not verified.</p></div>`;
  }

  /** A guarded action dialog: one text field (note / reason), then the action. */
  function openTextAction({ act, title, label, max, required, intro, submitText }) {
    const ov = Utils.Modal.open({
      title,
      body: `<div id="estActForm">
          ${intro ? `<p>${intro}</p>` : ''}
          <div class="field"><label for="estActText">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
            <textarea class="textarea" id="estActText" rows="3" maxlength="${max}"></textarea>
            <div class="field__error" data-err="${act === 'cancel' ? 'reason' : 'note'}"></div></div>
          ${byField('estActBy')}
        </div>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn btn--primary" data-submit>${esc(submitText)}</button>`,
    });
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const text = ov.querySelector('#estActText').value.trim();
      const by = ov.querySelector('#estActBy').value.trim();
      const form = ov.querySelector('#estActForm');
      if (required && !text) {
        const err = form.querySelector('[data-err]');
        err.textContent = `${label} is required.`;
        err.closest('.field').classList.add('field--error');
        return;
      }
      const body = { ...(act === 'cancel' ? { reason: text } : { note: text }), by: by || undefined, expectedUpdatedAt: current.updatedAt };
      await runAction(act, body, form);
    }));
  }

  async function runAction(act, body, form) {
    const res = await Storage.action('estimates', current.id, act, body, act === 'convert' ? ['jobCards'] : []);
    if (!res.ok && ['concurrent_modification', 'invalid_transition', 'estimate_closed', 'already_converted', 'conversion_in_progress', 'estimate_expired'].includes(res.errorReason)) {
      Utils.Modal.close();
      toast(res.message || 'This estimate was changed elsewhere. It has been reloaded.', 'info');
      await loadDetail();
      return;
    }
    if (!Utils.wrote(res, form)) return;
    Utils.Modal.close();
    const done = { send: 'Estimate marked as sent. No message was sent by the system — give or share the printed quotation.', approve: 'Approval recorded by staff.', reject: 'Rejection recorded.', cancel: 'Estimate cancelled.', convert: `Job card ${res.meta && res.meta.jobCardId ? res.meta.jobCardId : ''} created.` };
    toast(done[act] || 'Saved.', 'success');
    await loadDetail();
  }

  function openConvert() {
    const mechanics = Storage.getData('mechanics').filter(m => m && m.status !== 'Inactive')
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const today = dhakaToday();
    const ov = Utils.Modal.open({
      title: `Convert ${current.id} to a Job Card`,
      body: `<div id="estConvForm" class="form-grid">
          <p class="span-2">A new job card is created in its first status (Received) with this estimate's lines and figures. No stock is used until work starts on the job card.</p>
          <div class="field"><label for="estConvMech">Mechanic <span class="req">*</span></label>
            <select class="select" id="estConvMech"><option value="">Select a mechanic</option>${mechanics.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
            <div class="field__error" data-err="mechanicId"></div></div>
          <div class="field"><label for="estConvPriority">Priority</label>
            <select class="select" id="estConvPriority">${JOB_PRIORITIES.map(p => `<option value="${p}"${p === 'normal' ? ' selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>
            <div class="field__error" data-err="priority"></div></div>
          <div class="field"><label for="estConvDate">Job date</label><input class="input" type="date" id="estConvDate" value="${esc(today)}"><div class="field__error" data-err="date"></div></div>
          <div class="field"><label for="estConvDelivery">Estimated delivery</label><input class="input" type="date" id="estConvDelivery"><div class="field__error" data-err="estDelivery"></div></div>
          <div class="field"><label for="estConvMileage">Mileage in</label><input class="input" type="number" min="0" step="1" id="estConvMileage"><div class="field__error" data-err="mileage"></div></div>
          ${byField('estConvBy')}
        </div>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn btn--primary" data-submit>Create Job Card</button>`,
    });
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#estConvForm');
      const val = id => ov.querySelector(id).value;
      if (!val('#estConvMech')) {
        const err = form.querySelector('[data-err="mechanicId"]');
        err.textContent = 'Choose the mechanic for this job.';
        err.closest('.field').classList.add('field--error');
        return;
      }
      const body = {
        mechanicId: val('#estConvMech'), priority: val('#estConvPriority'), date: val('#estConvDate') || undefined,
        estDelivery: val('#estConvDelivery') || undefined, mileage: val('#estConvMileage') === '' ? undefined : Number(val('#estConvMileage')),
        by: val('#estConvBy').trim() || undefined, expectedUpdatedAt: current.updatedAt,
      };
      await runAction('convert', body, form);
    }));
  }

  function openSend() {
    const ov = Utils.Modal.open({
      title: `Send ${current.id}`,
      body: `<div id="estSendForm"><p>This marks the quotation as issued to the customer. The system does not send any message: print it or share it yourself.</p>${byField('estSendBy')}</div>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn btn--primary" data-submit>Mark as Sent</button>`,
    });
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const by = ov.querySelector('#estSendBy').value.trim();
      await runAction('send', { by: by || undefined, expectedUpdatedAt: current.updatedAt }, ov.querySelector('#estSendForm'));
    }));
  }

  function onDetailAction(act) {
    if (!current) return;
    if (act === 'send') openSend();
    else if (act === 'approve') openTextAction({ act, title: `Record approval of ${current.id}`, label: 'How the customer approved', max: LIMITS.note, required: true, submitText: 'Record Approval',
      intro: 'Use this when the customer approved by phone or in person. It is recorded as <strong>Recorded by staff</strong>, not as an online approval.' });
    else if (act === 'reject') openTextAction({ act, title: `Record rejection of ${current.id}`, label: 'Reason or note', max: LIMITS.note, required: true, submitText: 'Record Rejection' });
    else if (act === 'cancel') openTextAction({ act, title: `Cancel ${current.id}`, label: 'Reason for cancelling', max: LIMITS.reason, required: true, submitText: 'Cancel Estimate',
      intro: 'The estimate and its history are kept; it cannot be changed afterwards.' });
    else if (act === 'convert') openConvert();
  }

  async function loadDetail() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const stateBox = $('estStateNotice');
    if (!Storage.isApi()) { notice(stateBox, UNAVAILABLE.no_api, 'bad'); return; }
    if (!id) { notice(stateBox, 'No estimate was chosen. Open one from the Estimates list.', 'bad'); return; }
    const res = await Storage.loadOne('estimates', id);
    if (!res.ok) {
      $('estDetail').hidden = true;
      notice(stateBox, res.status === 404 ? `There is no estimate ${id}.` : UNAVAILABLE.other, 'bad');
      return;
    }
    const msg = params.get('msg');
    notice(stateBox, DONE_MESSAGES[msg] || '', msg === 'saved-not-sent' ? 'warn' : 'good');
    // Shown once: a later reload (after an action) must not repeat an old result.
    if (msg && typeof history !== 'undefined' && history.replaceState) {
      params.delete('msg');
      history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
    }
    renderDetail(res.record);
    return res.record;
  }

  function bindDetail() {
    $('estDetailActions').addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('[data-act]');
      if (btn) onDetailAction(btn.dataset.act);
    });
    $('estPrint').addEventListener('click', () => window.print());
  }

  /* ============================================================
     Start
     ============================================================ */

  function start(outcome) {
    // Signed out: the sign-in screen covers the window and the app reloads
    // after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    const content = $('page-content');
    const view = content ? content.dataset.estView : '';
    if (view === 'overview') { bindOverview(); loadOverview(); }
    else if (view === 'create') initForm();
    else if (view === 'details') {
      bindDetail();
      loadDetail().then(e => {
        if (e && new URLSearchParams(location.search).get('print') === '1') setTimeout(() => window.print(), 300);
      });
    }
  }

  if (typeof document !== 'undefined' && typeof Storage !== 'undefined' && document.body
      && document.body.dataset && document.body.dataset.page === 'estimates') {
    Storage.ready(start);
  }

  return {
    LIMITS, VALIDITY_DAYS, PAGE_SIZE, STATUS_FILTERS,
    dhakaToday, addDays, daysBetween, formatDay, percentDiscount, computeTotals,
    summary, matches, filterList, paginate, actionsFor,
    newKey, isAmbiguous, createSubmission, validateForm, formBody, state,
  };
})();
