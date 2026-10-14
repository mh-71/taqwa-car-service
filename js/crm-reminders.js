/* ============================================================
   crm-reminders.js — Customer CRM › Service Reminders
   ------------------------------------------------------------
   Lists active vehicles that have a next service date, with the
   customer they belong to, the last completed visit and whether the
   service is Upcoming, Due Today or Overdue.

   Source of truth: the workshop database, and nothing else.
     - Rows come from the vehicles, customers and job cards the app
       already loaded through Storage (GET /api/vehicles, /customers,
       /job-cards). No endpoint, column or record is added here.
     - Records are shown ONLY when Storage is in 'api' mode. In every
       other mode -- a backend that failed, no backend at all, or a
       signed-out browser -- this page reads nothing and says so. That
       keeps it clear of the browser-only store, which is where demo
       data lives (see Storage.seedIfEmpty / app.js), so a failed load
       can never be shown here as if it were the workshop's reminders.
     - Nothing is written. Nothing is sent: no SMS, WhatsApp or email.

   Rules (also asserted in tests/unit/crm-reminders.test.cjs):
     - "Today" is the Asia/Dhaka calendar day -- the same convention the
       Worker uses (src/lib/write.js todayInDhaka), not the device's own.
     - Only vehicles with status 'Active' and a real YYYY-MM-DD next
       service date are listed. Overdue: before today. Due Today: equal.
       Upcoming: after.
     - Last service: the latest Completed or Delivered job card for the
       vehicle (the server's only finished states; Cancelled and every
       unfinished state are ignored), dated by completedAt in Dhaka
       time, else actualDelivery, else the job card's own date.
   ============================================================ */

const CrmReminders = (() => {

  const { esc } = Utils;

  const FINISHED = ['Completed', 'Delivered'];
  const STATUS_TONE = { 'Overdue': 'bad', 'Due Today': 'warn', 'Upcoming': 'info' };

  /* ---------- dates ---------- */

  // The Worker's formatter, word for word (src/lib/write.js). en-CA formats
  // as YYYY-MM-DD, so the result compares correctly as a string.
  let dhakaFormat = null;
  try {
    dhakaFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch (e) { dhakaFormat = null; }

  /** The Dhaka calendar day of an instant, as YYYY-MM-DD ('' if invalid). */
  function dhakaDateOf(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (value === null || value === undefined || value === '' || isNaN(d)) return '';
    if (dhakaFormat) return dhakaFormat.format(d);
    // Bangladesh has kept UTC+6 without daylight saving since 2009.
    return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** Today in Dhaka, as YYYY-MM-DD. */
  function dhakaToday(now = new Date()) { return dhakaDateOf(now); }

  /** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
  function isDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  /** Whole days from `from` to `to`, both YYYY-MM-DD. */
  function daysBetween(from, to) {
    const ms = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((ms(to) - ms(from)) / 86400000);
  }

  /**
   * "14 Oct 2026" for a YYYY-MM-DD date. Formatted as a UTC calendar day so
   * no device timezone can move it; anything that is not a date shows '—'
   * rather than being echoed back into the page.
   */
  function formatDay(value) {
    if (!isDateOnly(value)) return '—';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------- the reminder list ---------- */

  /** The day a finished job card counts as a service visit ('' if none). */
  function visitDate(job) {
    const completed = dhakaDateOf(job.completedAt);
    if (completed) return completed;
    if (isDateOnly(job.actualDelivery)) return job.actualDelivery;
    return isDateOnly(job.date) ? job.date : '';
  }

  /** vehicleId -> latest finished visit, in one pass over the job cards. */
  function lastServiceDates(jobCards) {
    const latest = new Map();
    for (const job of jobCards || []) {
      if (!job || !FINISHED.includes(job.status)) continue;
      const day = visitDate(job);
      if (!day) continue;
      const seen = latest.get(job.vehicleId);
      if (!seen || day > seen) latest.set(job.vehicleId, day);
    }
    return latest;
  }

  function statusFor(next, today) {
    if (next < today) return 'Overdue';
    if (next === today) return 'Due Today';
    return 'Upcoming';
  }

  /** A dialable number (digits, optional leading +), or '' if there is none. */
  function telNumber(phone) {
    const raw = String(phone ?? '').trim();
    const digits = raw.replace(/[\s().-]/g, '');
    return /^\+?\d{6,15}$/.test(digits) ? digits : '';
  }

  /**
   * Every reminder, from the three collections. Pure: same input, same
   * output. Returns the rows (soonest first) and how many vehicles were left
   * out because their stored next service date is not a real date.
   */
  function buildReminders({ vehicles, customers, jobCards, today }) {
    const people = new Map((customers || []).map(c => [c.id, c]));
    const lastService = lastServiceDates(jobCards);
    const rows = [];
    let invalid = 0;
    for (const v of vehicles || []) {
      if (!v || v.status !== 'Active') continue;
      const next = v.nextServiceDate;
      if (next === undefined || next === null || next === '') continue;
      if (!isDateOnly(next)) { invalid++; continue; }
      const customer = people.get(v.customerId) || null;
      rows.push({
        vehicleId: v.id,
        customerId: customer ? customer.id : '',
        customerName: customer ? String(customer.name || '') : '',
        phone: customer ? telNumber(customer.phone) : '',
        brand: String(v.brand || ''),
        model: String(v.model || ''),
        regNo: String(v.regNo || ''),
        lastService: lastService.get(v.id) || '',
        next,
        status: statusFor(next, today),
        days: daysBetween(today, next),
      });
    }
    rows.sort((a, b) => a.next.localeCompare(b.next) || a.regNo.localeCompare(b.regNo));
    return { rows, invalid };
  }

  /** Counts by status. */
  function countByStatus(rows) {
    const out = { 'Upcoming': 0, 'Due Today': 0, 'Overdue': 0 };
    for (const r of rows) out[r.status]++;
    return out;
  }

  /**
   * Search (customer name, registration, brand, model), status, and "due
   * by": a reminder whose next service date is on or before that day --
   * overdue ones included, since they are due by then too.
   */
  function filterRows(rows, { search = '', status = 'all', dueBy = '' } = {}) {
    const term = String(search).trim().toLowerCase();
    const compact = term.replace(/[\s-]/g, '');
    const by = isDateOnly(dueBy) ? dueBy : '';
    return rows.filter(r => {
      if (status !== 'all' && r.status !== status) return false;
      if (by && r.next > by) return false;
      if (!term) return true;
      const hay = [r.customerName, r.regNo, r.brand, r.model, `${r.brand} ${r.model}`].join(' ').toLowerCase();
      return hay.includes(term) || (!!compact && r.regNo.toLowerCase().replace(/[\s-]/g, '').includes(compact));
    });
  }

  /* ---------- rendering ---------- */

  const ICON = {
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>',
    call: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>',
    task: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>',
    car: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  const COLS = 7;

  function dueText(r) {
    if (r.days === 0) return 'Today';
    if (r.days > 0) return r.days === 1 ? 'In 1 day' : `In ${r.days} days`;
    const late = -r.days;
    return late === 1 ? '1 day overdue' : `${late} days overdue`;
  }

  function rowHtml(r) {
    const name = r.customerName || 'Unknown customer';
    const vehicle = [r.brand, r.model].filter(Boolean).join(' ') || '—';
    const view = `vehicles.html?view=${encodeURIComponent(r.vehicleId)}`;
    const history = r.customerId
      ? `<a class="icon-btn icon-btn--sm" href="customers.html?view=${encodeURIComponent(r.customerId)}" title="Customer service history" aria-label="Service history for ${esc(name)}">${ICON.history}</a>`
      : `<button type="button" class="icon-btn icon-btn--sm crr-act--off" disabled title="No customer record is linked to this vehicle" aria-label="Service history unavailable">${ICON.history}</button>`;
    const call = r.phone
      ? `<a class="icon-btn icon-btn--sm" href="tel:${esc(r.phone)}" title="Call customer" aria-label="Call ${esc(name)}">${ICON.call}</a>`
      : `<button type="button" class="icon-btn icon-btn--sm crr-act--off" disabled title="No valid phone number on record" aria-label="Call unavailable">${ICON.call}</button>`;
    return `
      <tr data-id="${esc(r.vehicleId)}">
        <td class="cell-main${r.customerName ? '' : ' crr-unknown'}">${esc(name)}</td>
        <td>${esc(vehicle)}</td>
        <td>${esc(r.regNo || '—')}</td>
        <td>${r.lastService ? esc(formatDay(r.lastService)) : '<span class="crr-muted" title="No completed or delivered job card on record">—</span>'}</td>
        <td>${esc(formatDay(r.next))}<span class="cell-sub">${esc(dueText(r))}</span></td>
        <td><span class="badge badge--${STATUS_TONE[r.status]}">${esc(r.status)}</span></td>
        <td>
          <div class="row-actions">
            <a class="icon-btn icon-btn--sm" href="${esc(view)}" title="View vehicle" aria-label="View vehicle ${esc(r.regNo || vehicle)}">${ICON.view}</a>
            ${history}
            ${call}
            <button type="button" class="icon-btn icon-btn--sm crr-act--off" disabled title="Available once Follow-up Tasks is connected" aria-label="Create follow-up task (not available yet)">${ICON.task}</button>
          </div>
        </td>
      </tr>`;
  }

  /** One full-width message row: loading, empty, no matches, or unavailable. */
  function stateRow({ icon = ICON.car, title, text, retry = false, tone = 'neutral', badge = '' }) {
    return `
      <tr class="crr-empty-row">
        <td colspan="${COLS}">
          <div class="crr-empty${tone === 'bad' ? ' crr-empty--bad' : ''}">
            <span class="crr-empty__icon">${icon}</span>
            <div class="crr-empty__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${retry ? '<p class="crr-retry"><button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button></p>' : ''}
            </div>
            ${badge ? `<span class="badge badge--${tone === 'bad' ? 'bad' : 'neutral'} crr-empty__status">${esc(badge)}</span>` : ''}
          </div>
        </td>
      </tr>`;
  }

  /* ---------- the page ---------- */

  const state = { rows: [], invalid: 0, search: '', status: 'all', dueBy: '' };
  const $ = id => document.getElementById(id);

  function setControls(enabled) {
    for (const id of ['crrSearch', 'crrStatus', 'crrDueBy']) {
      const el = $(id);
      if (el) el.disabled = !enabled;
    }
  }

  function setCards(counts) {
    const cards = [['crrUpcoming', 'Upcoming', 'Next service after today'],
                   ['crrDueToday', 'Due Today', 'Next service is today'],
                   ['crrOverdue', 'Overdue', 'Next service date has passed']];
    for (const [id, key, sub] of cards) {
      const value = $(id), note = $(`${id}Sub`);
      if (value) value.innerHTML = counts ? esc(String(counts[key])) : '<span aria-hidden="true">&#8212;</span>';
      if (note) note.textContent = counts ? sub : 'Unavailable';
    }
  }

  function setTable(html, hasRows) {
    const body = $('crrBody');
    if (body) body.innerHTML = html;
    const table = $('crrTable');
    if (table && table.classList) table.classList.toggle('crr-table--rows', !!hasRows);
  }

  function note(text) {
    const el = $('crrToolbarNote');
    if (el) el.textContent = text;
  }

  /** Re-render the table and the visible-count note from the current filters. */
  function renderList() {
    const total = state.rows.length;
    const shown = filterRows(state.rows, state);
    const skipped = state.invalid
      ? ` · ${state.invalid} vehicle${state.invalid === 1 ? '' : 's'} skipped: unreadable next service date` : '';
    if (!total) {
      setTable(stateRow({
        title: 'No service reminders yet',
        text: 'No active vehicle has a next service date. Set one on a vehicle (Vehicles › Edit › Next Service Date) and it will be listed here.',
      }), false);
      note(`0 reminders${skipped}`);
      return;
    }
    if (!shown.length) {
      setTable(stateRow({ title: 'No reminders match your search or filters',
        text: 'Change or clear the search, status or due-by date to see more reminders.' }), false);
    } else {
      setTable(shown.map(rowHtml).join(''), true);
    }
    note(`Showing ${shown.length} of ${total} reminder${total === 1 ? '' : 's'}${skipped}`);
  }

  /** The page cannot show reminders: say why, and offer a retry where useful. */
  function renderUnavailable(outcome) {
    const noBackend = outcome && outcome.reason === 'no_api';
    setControls(false);
    setCards(null);
    note('Search and filters are unavailable until the reminders load.');
    setTable(stateRow({
      icon: ICON.alert, tone: 'bad', badge: 'Unavailable', retry: !noBackend,
      title: noBackend ? 'Service reminders need the workshop database'
                       : 'Service reminders could not be loaded',
      text: noBackend
        ? 'This copy of the app is not connected to the workshop database, so no reminders are shown.'
        : 'The workshop database did not answer, so no reminders are shown. Nothing stored in this browser is used in their place.',
    }), false);
  }

  function render(outcome, now = new Date()) {
    // Signed out: the app covers the window with its sign-in screen and
    // reloads after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    if (!Storage.isApi()) { renderUnavailable(outcome); return; }

    const built = buildReminders({
      vehicles: Storage.getData('vehicles'),
      customers: Storage.getData('customers'),
      jobCards: Storage.getData('jobCards'),
      today: dhakaToday(now),
    });
    state.rows = built.rows;
    state.invalid = built.invalid;
    setCards(countByStatus(built.rows));
    setControls(true);
    renderList();
  }

  /** A fresh page load re-runs hydration, the same way signing in does. */
  function retry() { location.reload(); }

  function bindEvents() {
    const search = $('crrSearch'), status = $('crrStatus'), dueBy = $('crrDueBy'), body = $('crrBody');
    if (search) search.addEventListener('input', e => { state.search = e.target.value; renderList(); });
    if (status) status.addEventListener('change', e => { state.status = e.target.value || 'all'; renderList(); });
    if (dueBy) dueBy.addEventListener('change', e => { state.dueBy = e.target.value; renderList(); });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action="retry"]') : null;
      if (btn) retry();
    });
  }

  Storage.ready(outcome => { bindEvents(); render(outcome); });

  return {
    dhakaToday, dhakaDateOf, isDateOnly, formatDay, telNumber,
    lastServiceDates, buildReminders, countByStatus, filterRows,
    render, renderList, state,
  };
})();
