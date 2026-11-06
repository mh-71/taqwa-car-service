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
     - The fourth card counts customers with an Open follow-up that is due
       today or overdue (GET /api/follow-ups, the same records and the same
       Dhaka-day rule as Customer CRM › Customer Follow-up), and links there.
     - The one write: "Mark as Completed" sets the vehicle's next service
       date (PUT /api/vehicles/:id, the existing route; queued for sync when
       offline). It is allowed only when a Completed / Delivered job card
       exists within COMPLETE_WINDOW days before the due date or later --
       the service itself is recorded by the job-card workflow, never here.
       The new date must fall after today and at least COMPLETE_WINDOW days
       after that job card, so the same visit cannot complete a reminder
       twice. Nothing is sent: no SMS, WhatsApp or email.

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
  const STATUSES = ['Upcoming', 'Due Today', 'Overdue'];
  // How long before the due date a finished job card still counts as that service.
  const COMPLETE_WINDOW = 30;
  // The default gap to the next service, offered (and editable) on completion.
  const DEFAULT_INTERVAL_MONTHS = 6;

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

  /** YYYY-MM-DD plus n days (n may be negative). */
  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  /** YYYY-MM-DD plus n calendar months, clamped to the month's last day. */
  function addMonths(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
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
        phoneText: customer ? String(customer.phone || '') : '',
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

  /**
   * Can this reminder be marked as completed? Only when a finished job card
   * (the service itself) is dated no earlier than COMPLETE_WINDOW days before
   * the due date. Returns { ok, reason }.
   */
  function completionCheck(row) {
    if (!row || !isDateOnly(row.next)) return { ok: false, reason: 'This reminder has no readable due date.' };
    if (!row.lastService) {
      return { ok: false, reason: 'No completed or delivered job card for this vehicle. Complete the service through Job Cards first.' };
    }
    const from = addDays(row.next, -COMPLETE_WINDOW);
    if (row.lastService < from) {
      return { ok: false, reason: `No completed or delivered job card since ${formatDay(from)}. Complete the service through Job Cards first.` };
    }
    return { ok: true, reason: '' };
  }

  /** The next service date offered by default when completing a reminder. */
  function suggestedNext(row, today) {
    const base = row.lastService && row.lastService > today ? row.lastService : today;
    return addMonths(base, DEFAULT_INTERVAL_MONTHS);
  }

  /** Why a proposed next service date is refused ('' when it is fine). */
  function nextDateProblem(value, row, today) {
    if (!isDateOnly(value)) return 'Enter a valid date.';
    if (value <= today) return 'The next service date must be after today.';
    if (row.lastService && value < addDays(row.lastService, COMPLETE_WINDOW)) {
      return `The next service date must be at least ${COMPLETE_WINDOW} days after the last service (${formatDay(row.lastService)}).`;
    }
    return '';
  }

  /**
   * Customers requiring follow-up: distinct customers with an Open follow-up
   * whose due date is today or has passed (Due Today / Overdue on the
   * Customer Follow-up page). Returns { customers, followUps }.
   */
  function followUpNeed(followUps, today) {
    const people = new Set();
    let count = 0;
    for (const f of followUps || []) {
      if (!f || f.status !== 'Open' || !isDateOnly(f.dueDate) || f.dueDate > today) continue;
      count++;
      if (f.customerId) people.add(f.customerId);
    }
    return { customers: people.size, followUps: count };
  }

  /** Counts by status. */
  function countByStatus(rows) {
    const out = { 'Upcoming': 0, 'Due Today': 0, 'Overdue': 0 };
    for (const r of rows) out[r.status]++;
    return out;
  }

  /**
   * Search (customer name, phone, registration, brand, model), status, and "due
   * by": a reminder whose next service date is on or before that day --
   * overdue ones included, since they are due by then too.
   */
  function filterRows(rows, { search = '', status = 'all', dueBy = '' } = {}) {
    const term = String(search).trim().toLowerCase();
    const compact = term.replace(/[\s-]/g, '');
    const digits = term.replace(/[\s().+-]/g, '');
    const phoneTerm = /^\d{3,}$/.test(digits) ? digits : '';
    const by = isDateOnly(dueBy) ? dueBy : '';
    return rows.filter(r => {
      if (status !== 'all' && r.status !== status) return false;
      if (by && r.next > by) return false;
      if (!term) return true;
      const hay = [r.customerName, r.regNo, r.brand, r.model, `${r.brand} ${r.model}`, r.phoneText || ''].join(' ').toLowerCase();
      if (hay.includes(term)) return true;
      if (compact && r.regNo.toLowerCase().replace(/[\s-]/g, '').includes(compact)) return true;
      return !!phoneTerm && String(r.phoneText || '').replace(/\D/g, '').includes(phoneTerm);
    });
  }

  /* ---------- rendering ---------- */

  const ICON = {
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>',
    call: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>',
    done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>',
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

  function completeBtn(r, name) {
    const check = completionCheck(r);
    if (!check.ok) {
      return `<button type="button" class="icon-btn icon-btn--sm crr-act--off" disabled title="${esc(check.reason)}" aria-label="Mark as completed unavailable: ${esc(check.reason)}">${ICON.done}</button>`;
    }
    return `<button type="button" class="icon-btn icon-btn--sm" data-action="complete" data-id="${esc(r.vehicleId)}" title="Mark as completed and set the next service date" aria-label="Mark service for ${esc(name)} as completed">${ICON.done}</button>`;
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
            ${completeBtn(r, name)}
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

  const state = { rows: [], invalid: 0, search: '', status: 'all', dueBy: '', today: '' };
  const $ = id => document.getElementById(id);

  function filterButtons() {
    return document.querySelectorAll ? Array.from(document.querySelectorAll('.crr-filter[data-filter]')) : [];
  }

  function setControls(enabled) {
    for (const id of ['crrSearch', 'crrStatus', 'crrDueBy']) {
      const el = $(id);
      if (el) el.disabled = !enabled;
    }
    for (const b of filterButtons()) b.disabled = !enabled;
  }

  /** The status cards and the status dropdown always show the same filter. */
  function syncStatusControls() {
    const select = $('crrStatus');
    if (select && select.value !== state.status) select.value = state.status;
    for (const b of filterButtons()) {
      const on = b.getAttribute('data-filter') === state.status;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /** Set the status filter (a status, or 'all') and redraw the list only. */
  function setStatus(value) {
    state.status = STATUSES.includes(value) ? value : 'all';
    syncStatusControls();
    renderList();
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

  /** The fourth card: customers with an Open follow-up due today or overdue. */
  function setFollowUpCard(value, sub) {
    const v = $('crrFollowUp'), n = $('crrFollowUpSub');
    if (v) v.innerHTML = value === null ? '<span aria-hidden="true">&#8212;</span>' : esc(String(value));
    if (n) n.textContent = sub;
  }

  let followUpSeq = 0;
  async function loadFollowUps(now = new Date()) {
    const seq = ++followUpSeq;
    if (!Storage.isApi()) {
      setFollowUpCard(null, Storage.isOffline && Storage.isOffline() ? 'Unavailable offline' : 'Unavailable');
      return;
    }
    setFollowUpCard(null, 'Loading…');
    let res;
    try { res = await Storage.load('followUps'); } catch (e) { res = { ok: false }; }
    if (seq !== followUpSeq) return;
    if (!res || !res.ok) {
      const denied = res && (res.status === 403 || res.code === 'forbidden');
      setFollowUpCard(null, denied ? 'No access to follow-ups' : 'Could not be loaded');
      return;
    }
    const need = followUpNeed(Storage.getData('followUps'), dhakaToday(now));
    setFollowUpCard(need.customers, need.followUps
      ? `${need.followUps} follow-up${need.followUps === 1 ? '' : 's'} due today or overdue`
      : 'No follow-up due today or overdue');
  }

  function render(outcome, now = new Date()) {
    // Signed out: the app covers the window with its sign-in screen and
    // reloads after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    // Offline, the encrypted copy of the workshop database is shown (the
    // same records, as last synced). Every other mode reads nothing.
    const offline = !!(Storage.isOffline && Storage.isOffline());
    if (!Storage.isApi() && !offline) { renderUnavailable(outcome); setFollowUpCard(null, 'Unavailable'); return; }
    state.offline = offline;

    const built = buildReminders({
      vehicles: Storage.getData('vehicles'),
      customers: Storage.getData('customers'),
      jobCards: Storage.getData('jobCards'),
      today: dhakaToday(now),
    });
    state.today = dhakaToday(now);
    state.rows = built.rows;
    state.invalid = built.invalid;
    setCards(countByStatus(built.rows));
    setControls(true);
    syncStatusControls();
    renderList();
  }

  /* ---------- mark as completed ---------- */

  let completing = false;

  function openComplete(vehicleId) {
    const row = state.rows.find(r => r.vehicleId === vehicleId);
    if (!row) return;
    const check = completionCheck(row);
    if (!check.ok) { Utils.toast(check.reason, 'error'); return; }
    const today = state.today || dhakaToday();
    const name = row.customerName || 'Unknown customer';
    const vehicle = [row.brand, row.model].filter(Boolean).join(' ') || '—';
    const ov = Utils.Modal.open({
      title: 'Mark service as completed',
      body: `
        <form id="crrCompleteForm" novalidate>
          <p style="margin:0 0 12px">${esc(name)} · ${esc(vehicle)} · <strong>${esc(row.regNo || '—')}</strong></p>
          <p style="margin:0 0 12px">Due ${esc(formatDay(row.next))}. Last completed job card: <strong>${esc(formatDay(row.lastService))}</strong>.</p>
          <div class="field">
            <label for="crrNextDate">Next service date</label>
            <input type="date" class="input" id="crrNextDate" name="nextServiceDate" required
                   min="${esc(addDays(today, 1))}" value="${esc(suggestedNext(row, today))}">
            <small class="field__error" data-err="nextServiceDate" role="alert"></small>
          </div>
          ${state.offline ? '<p class="crr-sub" style="margin-top:10px">You are offline: the change is kept on this computer and sent when the internet is back.</p>' : ''}
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" class="btn btn--primary" form="crrCompleteForm" data-complete-save>Mark as completed</button>`,
    });
    const form = ov.querySelector('#crrCompleteForm');
    const save = ov.querySelector('[data-complete-save]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (completing) return;   // one request per click, never two
      const input = form.querySelector('#crrNextDate');
      const err = form.querySelector('[data-err="nextServiceDate"]');
      const value = input ? input.value : '';
      const problem = nextDateProblem(value, row, today);
      if (err) err.textContent = problem;
      if (problem) { if (input) input.focus(); return; }
      // The record may have changed since the list was drawn.
      const fresh = Storage.getById('vehicles', vehicleId);
      if (!fresh || fresh.nextServiceDate !== row.next) {
        Utils.Modal.close();
        Utils.toast('This reminder has already been updated. The list has been refreshed.', 'warning');
        render({});
        return;
      }
      completing = true;
      if (save) save.disabled = true;
      try {
        const res = await Storage.update('vehicles', vehicleId, { nextServiceDate: value });
        if (!Utils.wrote(res, form)) return;
        Utils.Modal.close();
        Utils.toast(`Service for ${row.regNo || vehicle} marked as completed. Next service: ${formatDay(value)}.`);
        render({});
      } finally {
        completing = false;
        if (save) save.disabled = false;
      }
    });
  }

  /** A fresh page load re-runs hydration, the same way signing in does. */
  function retry() { location.reload(); }

  function bindEvents() {
    const search = $('crrSearch'), status = $('crrStatus'), dueBy = $('crrDueBy'), body = $('crrBody');
    if (search) search.addEventListener('input', e => { state.search = e.target.value; renderList(); });
    if (status) status.addEventListener('change', e => setStatus(e.target.value || 'all'));
    // Clicking a status card filters by it; clicking the active one shows all again.
    for (const b of filterButtons()) {
      b.addEventListener('click', () => {
        const value = b.getAttribute('data-filter');
        setStatus(state.status === value ? 'all' : value);
      });
    }
    if (dueBy) dueBy.addEventListener('change', e => {
      const v = e.target.value;
      // A date the browser could not read (typed by hand) is cleared, not guessed.
      if (v && !isDateOnly(v)) { e.target.value = ''; state.dueBy = ''; Utils.toast('Enter a valid date.', 'error'); }
      else state.dueBy = v;
      renderList();
    });
    if (body) body.addEventListener('click', e => {
      const find = sel => (e.target && e.target.closest ? e.target.closest(sel) : null);
      if (find('[data-action="retry"]')) { retry(); return; }
      const done = find('[data-action="complete"]');
      if (done && done.getAttribute) openComplete(done.getAttribute('data-id'));
    });
  }

  Storage.ready(outcome => {
    bindEvents();
    render(outcome);
    if (!outcome || outcome.mode !== 'locked') loadFollowUps();
  });

  return {
    dhakaToday, dhakaDateOf, isDateOnly, formatDay, telNumber,
    lastServiceDates, buildReminders, countByStatus, filterRows,
    completionCheck, suggestedNext, nextDateProblem, followUpNeed, addDays, addMonths,
    render, renderList, setStatus, loadFollowUps, openComplete, state,
  };
})();
