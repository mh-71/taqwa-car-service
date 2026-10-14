/* ============================================================
   crm-follow-up.js — Customer CRM › Customer Follow-up
   ------------------------------------------------------------
   Follow-ups (call this customer, optionally about one of their
   vehicles, about something, by a due date) and the contact
   attempts made for each.

   Source of truth: the workshop database, and nothing else.
     - Follow-ups and contacts are read on demand through
       Storage.load() (GET /api/follow-ups, /api/follow-up-contacts),
       ONLY when Storage is in 'api' mode. They are not part of the
       app-wide hydration, so if they cannot be read this page says so
       and every other page is unaffected.
     - In every other mode -- no backend, a backend that failed, a
       signed-out browser -- this page reads nothing and writes
       nothing. Demo data lives in browser storage; none of it is ever
       shown here as if it were a follow-up.
     - Customer and vehicle names come from the collections the app
       already loaded. A follow-up whose customer or vehicle is missing
       shows its id and "Unknown", never an invented name.
     - Nothing is sent: no SMS, WhatsApp or email. The call button is a
       tel: link to a validated number.

   Rules (also asserted in tests/unit/crm-follow-up.test.cjs):
     - "Today" is the Asia/Dhaka calendar day, as in the Worker.
     - Pending / Due Today / Overdue are Open follow-ups whose due date
       is after / on / before today. Completed and Cancelled are shown
       as such and never counted in a KPI.
     - KPIs count Open follow-ups only, and ignore the toolbar filters.
       Contacted = Open with a latest valid contact outcome of reached.
     - Every create (follow-up or contact) carries an idempotency key,
       made fresh when its dialog opens. After an answer that does not
       say whether the server saved it (timeout, network, 5xx) the form
       is frozen and Retry resends the SAME key and payload, so it can
       never be saved twice. Success is shown only once the server has
       said so.
   ============================================================ */

const CrmFollowUp = (() => {

  const { esc } = Utils;

  /* Field limits: the Worker's (src/routes/follow-ups.js LIMITS) and the
     schema's CHECKs (0005) use the same numbers. */
  const LIMITS = { reason: 200, notes: 1000, note: 1000, closeNote: 500, voidReason: 500, name: 100 };

  const OUTCOMES = {
    reached: 'Reached',
    unreachable: 'Unreachable',
    callback_requested: 'Callback requested',
    other: 'Other',
  };
  const OUTCOME_TONE = { reached: 'good', unreachable: 'bad', callback_requested: 'warn', other: 'neutral' };
  const STATUS_TONE = { 'Overdue': 'bad', 'Due Today': 'warn', 'Pending': 'info', 'Completed': 'good', 'Cancelled': 'neutral' };
  const PRIORITY_LABEL = { high: 'High', normal: 'Normal' };

  /* ---------- dates (the Worker's convention, as on Service Reminders) ---------- */

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
    return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  }

  function dhakaToday(now = new Date()) { return dhakaDateOf(now); }

  /** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
  function isDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  /** "14 Oct 2026" for a YYYY-MM-DD date; '—' for anything else. */
  function formatDay(value) {
    if (!isDateOnly(value)) return '—';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** "14 Oct 2026, 3:05 pm" for an ISO instant, in Dhaka time; '—' if invalid. */
  function formatMoment(value) {
    const d = new Date(value);
    if (!value || isNaN(d)) return '—';
    try {
      return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {
      return dhakaDateOf(d);
    }
  }

  /** A dialable number (digits, optional leading +), or '' if there is none. */
  function telNumber(phone) {
    const raw = String(phone ?? '').trim();
    const digits = raw.replace(/[\s().-]/g, '');
    return /^\+?\d{6,15}$/.test(digits) ? digits : '';
  }

  /* ---------- the follow-up list ---------- */

  /** Pending / Due Today / Overdue for an Open follow-up; its status otherwise. */
  function displayStatus(fu, today) {
    if (!fu || fu.status !== 'Open') return fu ? fu.status : '';
    if (!isDateOnly(fu.dueDate)) return 'Pending';
    if (fu.dueDate < today) return 'Overdue';
    if (fu.dueDate === today) return 'Due Today';
    return 'Pending';
  }

  /**
   * KPI counts. Open follow-ups only -- Completed and Cancelled never count --
   * and independent of any filter. Contacted: the latest valid (non-voided)
   * contact was reached, which the server keeps in lastOutcome.
   */
  function kpis(followUps, today) {
    const out = { total: 0, dueToday: 0, overdue: 0, contacted: 0 };
    for (const fu of followUps || []) {
      if (!fu || fu.status !== 'Open') continue;
      out.total++;
      const s = displayStatus(fu, today);
      if (s === 'Due Today') out.dueToday++;
      if (s === 'Overdue') out.overdue++;
      if (fu.lastOutcome === 'reached') out.contacted++;
    }
    return out;
  }

  /** One row per follow-up, with the names it refers to. Pure. */
  function buildRows({ followUps, customers, vehicles, today }) {
    const people = new Map((customers || []).map(c => [c.id, c]));
    const cars = new Map((vehicles || []).map(v => [v.id, v]));
    return (followUps || []).filter(Boolean).map(fu => {
      const c = people.get(fu.customerId) || null;
      const v = fu.vehicleId ? cars.get(fu.vehicleId) || null : null;
      return {
        id: fu.id,
        fu,
        customerId: fu.customerId || '',
        customerName: c ? String(c.name || '') : '',
        phone: c ? telNumber(c.phone) : '',
        phoneText: c ? String(c.phone || '') : '',
        vehicleId: fu.vehicleId || '',
        vehicleKnown: !fu.vehicleId || !!v,
        vehicleLabel: v ? [v.brand, v.model].filter(Boolean).map(String).join(' ') : '',
        regNo: v ? String(v.regNo || '') : '',
        reason: String(fu.reason || ''),
        priority: fu.priority === 'high' ? 'high' : 'normal',
        dueDate: fu.dueDate,
        status: displayStatus(fu, today),
        open: fu.status === 'Open',
        lastContactAt: fu.lastContactAt || '',
        lastOutcome: fu.lastOutcome || '',
        closedAt: fu.closedAt || '',
        createdAt: fu.createdAt || '',
      };
    });
  }

  /**
   * Deterministic order: Open first, soonest due first, high priority before
   * normal on the same day, then id; closed ones after, most recently closed
   * first, then id.
   */
  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      if (a.open) {
        const d = String(a.dueDate).localeCompare(String(b.dueDate));
        if (d) return d;
        if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
        return a.id.localeCompare(b.id);
      }
      const c = String(b.closedAt).localeCompare(String(a.closedAt));
      return c || a.id.localeCompare(b.id);
    });
  }

  const digitsOf = s => String(s || '').replace(/\D/g, '');

  /**
   * Search (customer name, phone, reason; registration as a convenience),
   * status (open / all / Completed / Cancelled), due (any / today / overdue --
   * Open follow-ups only) and priority.
   */
  function filterRows(rows, { search = '', status = 'open', due = 'any', priority = 'all' } = {}) {
    const term = String(search).trim().toLowerCase();
    const termDigits = digitsOf(term);
    return rows.filter(r => {
      if (status === 'open' && !r.open) return false;
      if (status !== 'open' && status !== 'all' && r.fu.status !== status) return false;
      if (due === 'today' && r.status !== 'Due Today') return false;
      if (due === 'overdue' && r.status !== 'Overdue') return false;
      if (priority !== 'all' && r.priority !== priority) return false;
      if (!term) return true;
      const hay = [r.customerName, r.reason, r.regNo, r.vehicleLabel].join(' ').toLowerCase();
      return hay.includes(term) || (termDigits.length >= 3 && digitsOf(r.phoneText).includes(termDigits));
    });
  }

  /* ---------- validation (the Worker re-checks everything) ---------- */

  const blank = v => String(v ?? '').trim() === '';
  const tooLong = (v, max) => String(v ?? '').trim().length > max;

  function validateFollowUp(v, { creating = true } = {}) {
    const e = {};
    if (creating && blank(v.customerId)) e.customerId = 'Select the customer to follow up.';
    if (blank(v.reason)) e.reason = 'Enter the reason for this follow-up.';
    else if (tooLong(v.reason, LIMITS.reason)) e.reason = `Keep the reason to ${LIMITS.reason} characters or fewer.`;
    if (tooLong(v.notes, LIMITS.notes)) e.notes = `Keep notes to ${LIMITS.notes} characters or fewer.`;
    if (!['normal', 'high'].includes(v.priority)) e.priority = 'Choose Normal or High.';
    if (blank(v.dueDate)) e.dueDate = 'Choose a due date.';
    else if (!isDateOnly(v.dueDate)) e.dueDate = 'Enter a real calendar date.';
    return e;
  }

  function validateContact(v) {
    const e = {};
    if (!OUTCOMES[v.outcome]) e.outcome = 'Choose the outcome of this contact.';
    if (tooLong(v.note, LIMITS.note)) e.note = `Keep the note to ${LIMITS.note} characters or fewer.`;
    else if (v.outcome === 'other' && blank(v.note)) e.note = 'A note is required when the outcome is "Other".';
    if (!blank(v.nextContactDate) && !isDateOnly(v.nextContactDate)) e.nextContactDate = 'Enter a real calendar date.';
    else if (v.outcome === 'callback_requested' && blank(v.nextContactDate)) {
      e.nextContactDate = 'Choose when to call back.';
    }
    if (tooLong(v.recordedBy, LIMITS.name)) e.recordedBy = `Keep the name to ${LIMITS.name} characters or fewer.`;
    return e;
  }

  function validateReason(value, max, what) {
    if (blank(value)) return `Enter the reason for ${what}.`;
    if (tooLong(value, max)) return `Keep the reason to ${max} characters or fewer.`;
    return '';
  }

  /* ---------- idempotent submissions ---------- */

  /**
   * A fresh idempotency key from the browser's cryptographic RNG. There is no
   * Math.random() fallback: without a secure source the page refuses to
   * submit rather than make a guessable, collidable key.
   */
  function newKey(cryptoObj = (typeof crypto !== 'undefined' ? crypto : null)) {
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  /**
   * An answer that does not say whether the server saved the request: the
   * request may or may not have committed, so the only safe next step is to
   * send the SAME request again with the SAME key.
   */
  function isAmbiguous(res) {
    if (!res || res.ok) return false;
    if (['timeout', 'network_error', 'malformed_response'].includes(res.code)) return true;
    return typeof res.status === 'number' && (res.status === 0 || res.status >= 500);
  }

  /**
   * One intentional submission. The key is made once, when the dialog opens;
   * the payload is fixed at the first send. A retry resends both unchanged.
   * After an ambiguous failure the submission is frozen: its payload can no
   * longer be replaced, only resent. A definitive refusal (4xx) wrote
   * nothing, so the form may be corrected and sent again.
   */
  function createSubmission(cryptoObj) {
    const key = newKey(cryptoObj);
    let payload = null;
    let frozen = false;
    return {
      get key() { return key; },
      get frozen() { return frozen; },
      get payload() { return payload; },
      /** The body to send now: the frozen one on a retry, else `next` with the key. */
      body(next) {
        if (!key) return null;
        if (!frozen) payload = { ...next, idempotencyKey: key };
        return payload;
      },
      settle(res) {
        if (isAmbiguous(res)) frozen = true;
        return res;
      },
    };
  }

  /* ---------- rendering ---------- */

  const ICON = {
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>',
    call: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>',
    note: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  const COLS = 8;

  const badge = (tone, text) => `<span class="badge badge--${tone}">${esc(text)}</span>`;
  const outcomeBadge = o => (OUTCOMES[o] ? badge(OUTCOME_TONE[o], OUTCOMES[o]) : '');

  function dueText(r, today) {
    if (!r.open || !isDateOnly(r.dueDate)) return '';
    const ms = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    const days = Math.round((ms(r.dueDate) - ms(today)) / 86400000);
    if (days === 0) return 'Today';
    if (days > 0) return days === 1 ? 'In 1 day' : `In ${days} days`;
    return -days === 1 ? '1 day overdue' : `${-days} days overdue`;
  }

  function customerCell(r) {
    const name = r.customerName || 'Unknown customer';
    return `<span class="${r.customerName ? '' : 'crf-unknown'}">${esc(name)}</span>`
      + `<span class="cell-sub">${esc(r.phoneText || r.customerId)}</span>`;
  }

  function vehicleCell(r) {
    if (!r.vehicleId) return '<span class="crf-muted">No vehicle</span>';
    if (!r.vehicleKnown) return `<span class="crf-unknown">Unknown vehicle</span><span class="cell-sub">${esc(r.vehicleId)}</span>`;
    return `${esc(r.vehicleLabel || '—')}<span class="cell-sub">${esc(r.regNo)}</span>`;
  }

  function rowHtml(r, today) {
    const name = r.customerName || 'Unknown customer';
    const call = r.phone
      ? `<a class="icon-btn icon-btn--sm" href="tel:${esc(r.phone)}" title="Call customer" aria-label="Call ${esc(name)}">${ICON.call}</a>`
      : `<button type="button" class="icon-btn icon-btn--sm crf-act--off" disabled title="No valid phone number on record" aria-label="Call unavailable">${ICON.call}</button>`;
    const openOnly = r.open ? `
            <button type="button" class="icon-btn icon-btn--sm" data-action="contact" data-id="${esc(r.id)}" title="Record contact" aria-label="Record a contact with ${esc(name)}">${ICON.note}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-action="complete" data-id="${esc(r.id)}" title="Mark completed" aria-label="Mark the follow-up for ${esc(name)} completed">${ICON.done}</button>` : '';
    return `
      <tr data-id="${esc(r.id)}">
        <td class="cell-main">${customerCell(r)}</td>
        <td>${vehicleCell(r)}</td>
        <td class="crf-reason">${esc(r.reason)}</td>
        <td>${r.priority === 'high' ? badge('warn', 'High') : '<span class="crf-muted">Normal</span>'}</td>
        <td>${esc(formatDay(r.dueDate))}${r.open ? `<span class="cell-sub">${esc(dueText(r, today))}</span>` : ''}</td>
        <td>${badge(STATUS_TONE[r.status] || 'neutral', r.status)}</td>
        <td>${r.lastContactAt
          ? `${esc(formatMoment(r.lastContactAt))}<span class="cell-sub">${esc(OUTCOMES[r.lastOutcome] || '')}</span>`
          : '<span class="crf-muted">No contact yet</span>'}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="icon-btn icon-btn--sm" data-action="view" data-id="${esc(r.id)}" title="View details" aria-label="View the follow-up for ${esc(name)}">${ICON.view}</button>
            ${openOnly}
            ${call}
          </div>
        </td>
      </tr>`;
  }

  function stateRow({ icon = ICON.list, title, text, retry = false, tone = 'neutral', badge: label = '' }) {
    return `
      <tr class="crf-empty-row">
        <td colspan="${COLS}">
          <div class="crf-empty${tone === 'bad' ? ' crf-empty--bad' : ''}">
            <span class="crf-empty__icon">${icon}</span>
            <div class="crf-empty__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${retry ? '<p class="crf-retry"><button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button></p>' : ''}
            </div>
            ${label ? `<span class="badge badge--${tone === 'bad' ? 'bad' : 'neutral'} crf-empty__status">${esc(label)}</span>` : ''}
          </div>
        </td>
      </tr>`;
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, rows: [], search: '', status: 'open', due: 'any', priority: 'all' };
  const $ = id => document.getElementById(id);
  const today = () => dhakaToday();

  function setControls(enabled) {
    for (const id of ['crfSearch', 'crfStatus', 'crfDue', 'crfPriority', 'crfNew']) {
      const el = $(id);
      if (el) el.disabled = !enabled;
    }
  }

  function setCards(counts) {
    const cards = [['crfTotal', 'total', 'All open follow-ups'],
                   ['crfDueToday', 'dueToday', 'Open, due today'],
                   ['crfContacted', 'contacted', 'Open, last contact reached'],
                   ['crfOverdue', 'overdue', 'Open, past the due date']];
    for (const [id, key, sub] of cards) {
      const value = $(id), note = $(`${id}Sub`);
      if (value) value.innerHTML = counts ? esc(String(counts[key])) : '<span aria-hidden="true">&#8212;</span>';
      if (note) note.textContent = counts ? sub : 'Unavailable';
    }
  }

  function setTable(html, hasRows) {
    const body = $('crfBody');
    if (body) body.innerHTML = html;
    const table = $('crfTable');
    if (table && table.classList) table.classList.toggle('crf-table--rows', !!hasRows);
  }

  function note(text) {
    const el = $('crfToolbarNote');
    if (el) el.textContent = text;
  }

  /** Rebuild rows and cards from what Storage holds now. */
  function refreshView() {
    const t = today();
    const followUps = Storage.getData('followUps');
    state.rows = sortRows(buildRows({
      followUps, customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'), today: t,
    }));
    setCards(kpis(followUps, t));
    renderList();
  }

  function renderList() {
    const t = today();
    const total = state.rows.length;
    const shown = filterRows(state.rows, state);
    if (!total) {
      setTable(stateRow({
        title: 'No follow-ups yet',
        text: 'Use “New Follow-up” to plan a call to a customer. Open follow-ups, their due dates and every contact attempt will be listed here.',
      }), false);
      note('0 follow-ups');
      return;
    }
    if (!shown.length) {
      setTable(stateRow({ title: 'No follow-ups match your search or filters',
        text: 'Change or clear the search, status, due date or priority filter to see more follow-ups.' }), false);
    } else {
      setTable(shown.map(r => rowHtml(r, t)).join(''), true);
    }
    note(`Showing ${shown.length} of ${total} follow-up${total === 1 ? '' : 's'}`);
  }

  function renderUnavailable(reason) {
    const noBackend = reason === 'no_api';
    state.loaded = false;
    setControls(false);
    setCards(null);
    note('Search and filters are unavailable until the follow-ups load.');
    setTable(stateRow({
      icon: ICON.alert, tone: 'bad', badge: 'Unavailable', retry: !noBackend,
      title: noBackend ? 'Customer follow-ups need the workshop database'
                       : 'Customer follow-ups could not be loaded',
      text: noBackend
        ? 'This copy of the app is not connected to the workshop database, so no follow-ups are shown and none can be recorded.'
        : 'The workshop database did not answer, so no follow-ups are shown. Nothing stored in this browser is used in their place.',
    }), false);
  }

  function renderLoading() {
    setControls(false);
    setCards(null);
    ['crfTotal', 'crfDueToday', 'crfContacted', 'crfOverdue'].forEach(id => { const n = $(`${id}Sub`); if (n) n.textContent = 'Loading…'; });
    note('Loading follow-ups…');
    setTable(stateRow({ title: 'Loading follow-ups…', text: 'Reading follow-ups and their contact history from the workshop database.' }), false);
  }

  /** Read both collections; on any failure show the unavailable state. */
  async function load() {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    renderLoading();
    const [a, b] = await Promise.all([Storage.load('followUps'), Storage.load('followUpContacts')]);
    if (!a.ok || !b.ok) { renderUnavailable((a.ok ? b : a).code); return false; }
    state.loaded = true;
    setControls(true);
    refreshView();
    return true;
  }

  /* ---------- dialogs ---------- */

  const contactsOf = id => Storage.getData('followUpContacts')
    .filter(c => c.followUpId === id)
    .slice()
    .sort((a, b) => String(b.contactedAt).localeCompare(String(a.contactedAt)) || String(b.id).localeCompare(String(a.id)));

  function field({ id, label, required = false, html, err, span = false, hint = '' }) {
    return `
      <div class="field${span ? ' span-2' : ''}">
        <label for="${id}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="muted-note">${esc(hint)}</p>` : ''}
        <div class="field__error" data-err="${err}"></div>
      </div>`;
  }

  /** A notice inside a dialog, e.g. "the server did not answer". */
  function setNotice(root, text, tone = 'bad') {
    const box = root.querySelector('[data-notice]');
    if (!box) return;
    box.hidden = !text;
    box.className = `crf-notice crf-notice--${tone}`;
    box.textContent = text || '';
  }

  function freeze(form) {
    form.querySelectorAll('input, select, textarea, .cust-picker__clear').forEach(el => { el.disabled = true; });
  }

  /**
   * Run one create through its submission. Returns the result. On an
   * ambiguous answer the form is frozen and the button becomes "Retry";
   * nothing is reported as saved until the server has said so.
   */
  async function submitOnce(sub, root, form, send, next, collections) {
    const body = sub.body(next);
    if (!body) {
      setNotice(root, 'This browser cannot create a secure submission key, so nothing was sent. Use an up-to-date browser over https.');
      return null;
    }
    const res = sub.settle(await send(body));
    const btn = root.querySelector('[data-submit]');
    if (sub.frozen && !res.ok) {
      freeze(form);
      // Utils.saving puts the button's own label back when this handler
      // returns, so the new one is set just after it.
      if (btn) setTimeout(() => { btn.textContent = 'Retry'; }, 0);
      setNotice(root, 'The workshop database did not confirm this. It may or may not have been saved. Retry sends exactly the same request again and can never save it twice.', 'warn');
      // Re-read what the database now holds, so the list behind the dialog is
      // true even if this dialog is closed instead of retried.
      Promise.all((collections || []).map(c => Storage.load(c))).then(refreshView, () => {});
      return res;
    }
    if (!res.ok && res.errorReason === 'idempotency_key_reused') {
      setNotice(root, 'This submission could not be matched. Close the dialog and start again.');
      return res;
    }
    setNotice(root, '');
    return res;
  }

  /* -- New follow-up -- */

  const PICKER_LIMIT = 50;

  function activeCustomers() {
    return Storage.getData('customers').filter(c => c && c.status !== 'Inactive')
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function matchCustomers(query) {
    const all = activeCustomers();
    const q = String(query).trim().toLowerCase();
    if (!q) return all;
    const qd = digitsOf(q);
    return all.filter(c => String(c.name || '').toLowerCase().includes(q) || (qd.length >= 3 && digitsOf(c.phone).includes(qd)));
  }

  function vehicleOptions(customerId, selected = '') {
    const cars = Storage.getData('vehicles')
      .filter(v => v && v.customerId === customerId && (v.status !== 'Inactive' || v.id === selected))
      .slice().sort((a, b) => String(a.regNo).localeCompare(String(b.regNo)));
    return '<option value="">No vehicle</option>' + cars.map(v =>
      `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} — ${esc([v.brand, v.model].filter(Boolean).join(' '))}${v.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('');
  }

  function bindCustomerPicker(root, onChange) {
    const hidden = root.querySelector('#ff-customer');
    const input = root.querySelector('#ff-customer-search');
    const list = root.querySelector('#ff-customer-list');
    const clear = root.querySelector('.cust-picker__clear');
    let matches = [];
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const highlight = i => {
      active = i;
      list.querySelectorAll('[role="option"]').forEach((li, n) => li.classList.toggle('is-active', n === i));
      const li = list.querySelector(`[data-index="${i}"]`);
      if (li) { li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
      else input.removeAttribute('aria-activedescendant');
    };
    const render = () => {
      matches = matchCustomers(input.value);
      const shown = matches.slice(0, PICKER_LIMIT);
      list.innerHTML = shown.length
        ? shown.map((c, i) => `
            <li role="option" id="ff-cust-opt-${i}" data-index="${i}" aria-selected="${c.id === hidden.value}">
              <span class="cust-picker__name">${esc(c.name)}</span>
              <span class="cust-picker__meta">${esc(c.phone || '')} · ${esc(c.id)}</span>
            </li>`).join('') +
          (matches.length > PICKER_LIMIT
            ? `<li class="cust-picker__more" aria-hidden="true">Showing ${PICKER_LIMIT} of ${matches.length} — keep typing to narrow down.</li>` : '')
        : '<li class="cust-picker__empty">No active customers found</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(shown.length ? 0 : -1);
    };
    const choose = c => {
      hidden.value = c.id;
      input.value = `${c.name} — ${c.phone || ''}`;
      clear.hidden = false;
      close();
      onChange(c.id);
    };
    const unselect = () => { if (hidden.value) { hidden.value = ''; onChange(''); } clear.hidden = true; };
    input.addEventListener('click', () => { if (list.hidden) render(); });
    input.addEventListener('input', () => { unselect(); render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { render(); return; }
        const n = Math.min(matches.length, PICKER_LIMIT);
        if (n) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) choose(matches[active]);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation();
        close();
      }
    });
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('[role="option"]');
      e.preventDefault();
      if (li) choose(matches[Number(li.dataset.index)]);
    });
    input.addEventListener('blur', close);
    clear.addEventListener('click', () => { input.value = ''; unselect(); input.focus(); });
  }

  function followUpFields(fu, { creating }) {
    const t = today();
    const customer = creating ? field({ id: 'ff-customer-search', label: 'Customer', required: true, err: 'customerId', span: true, html: `
          <div class="cust-picker">
            <div class="cust-picker__box">
              <input class="input" id="ff-customer-search" type="text" autocomplete="off"
                     placeholder="Search active customers by name or phone"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ff-customer-list">
              <button type="button" class="cust-picker__clear" aria-label="Clear selected customer" hidden>&times;</button>
            </div>
            <input type="hidden" id="ff-customer" name="customerId" value="">
            <ul class="cust-picker__list" id="ff-customer-list" role="listbox" aria-label="Matching customers" hidden></ul>
          </div>` })
      : `<div class="field span-2"><label>Customer</label><p class="crf-fixed">${esc(customerLabel(fu.customerId))}</p>
          <p class="muted-note">The customer of a follow-up cannot be changed.</p></div>`;
    return `
      <div class="crf-notice" data-notice hidden></div>
      <div class="form-grid">
        ${customer}
        ${field({ id: 'ff-vehicle', label: 'Vehicle', err: 'vehicleId', span: true, html: `
          <select class="select" id="ff-vehicle" name="vehicleId"${creating ? ' disabled' : ''}>${creating ? '<option value="">Select a customer first</option>' : vehicleOptions(fu.customerId, fu.vehicleId || '')}</select>`,
          hint: 'Optional. Only the selected customer’s active vehicles are listed.' })}
        ${field({ id: 'ff-reason', label: 'Follow-up reason', required: true, err: 'reason', span: true, html: `
          <input class="input" id="ff-reason" name="reason" maxlength="${LIMITS.reason}" value="${esc(fu.reason || '')}" placeholder="e.g. Check the brake noise after the service">` })}
        ${field({ id: 'ff-priority', label: 'Priority', err: 'priority', html: `
          <select class="select" id="ff-priority" name="priority">
            <option value="normal"${fu.priority !== 'high' ? ' selected' : ''}>Normal</option>
            <option value="high"${fu.priority === 'high' ? ' selected' : ''}>High</option>
          </select>` })}
        ${field({ id: 'ff-due', label: 'Due date', required: true, err: 'dueDate', html: `
          <input class="input" id="ff-due" name="dueDate" type="date" value="${esc(fu.dueDate || t)}">` })}
        ${field({ id: 'ff-notes', label: 'Notes', err: 'notes', span: true, html: `
          <textarea class="textarea" id="ff-notes" name="notes" rows="3" maxlength="${LIMITS.notes}">${esc(fu.notes || '')}</textarea>` })}
      </div>`;
  }

  function customerLabel(id) {
    const c = Storage.getById('customers', id);
    return c ? `${c.name} — ${c.phone || ''}` : `Unknown customer (${id})`;
  }

  function readFollowUpForm(form) {
    const val = n => (form.querySelector(`[name="${n}"]`) || { value: '' }).value;
    return {
      customerId: val('customerId').trim(), vehicleId: val('vehicleId'), reason: val('reason').trim(),
      notes: val('notes').trim(), priority: val('priority'), dueDate: val('dueDate'),
    };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    Object.entries(errors).forEach(([k, msg]) => {
      const el = form.querySelector(`[data-err="${k}"]`);
      if (el) { el.textContent = msg; const f = el.closest('.field'); if (f) f.classList.add('field--error'); }
    });
    return Object.keys(errors).length === 0;
  }

  function openCreate() {
    if (!state.loaded) return;
    const sub = createSubmission();
    const ov = Utils.Modal.open({
      title: 'New Follow-up',
      body: `<form id="crfForm" novalidate>${followUpFields({}, { creating: true })}</form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
               <button type="button" class="btn btn--primary" data-submit>Create Follow-up</button>`,
    });
    const form = ov.querySelector('#crfForm');
    const vehicle = form.querySelector('#ff-vehicle');
    bindCustomerPicker(form, id => {
      vehicle.innerHTML = id ? vehicleOptions(id) : '<option value="">Select a customer first</option>';
      vehicle.disabled = !id;
    });
    if (!sub.key) setNotice(ov, 'This browser cannot create a secure submission key, so follow-ups cannot be created here. Use an up-to-date browser over https.');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const values = readFollowUpForm(form);
      if (!sub.frozen && !showErrors(form, validateFollowUp(values))) return;
      const payload = {
        customerId: values.customerId, vehicleId: values.vehicleId || null, reason: values.reason,
        notes: values.notes, priority: values.priority, dueDate: values.dueDate,
      };
      const res = await submitOnce(sub, ov, form, body => Storage.create('followUps', body), payload, ['followUps']);
      if (!res || sub.frozen && !res.ok) return;
      if (!res.ok) { Utils.wrote(res, form); return; }
      Utils.Modal.close();
      refreshView();
      Utils.toast(res.meta && res.meta.replayed ? 'This follow-up was already saved.' : 'Follow-up created.', 'success');
    }));
  }

  /* -- Edit -- */

  function openEdit(id) {
    const fu = Storage.getById('followUps', id);
    if (!fu || fu.status !== 'Open') { Utils.toast('Only an open follow-up can be edited.', 'info'); return; }
    const ov = Utils.Modal.open({
      title: 'Edit Follow-up',
      body: `<form id="crfForm" novalidate>${followUpFields(fu, { creating: false })}</form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
               <button type="button" class="btn btn--primary" data-submit>Save Changes</button>`,
    });
    const form = ov.querySelector('#crfForm');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const values = readFollowUpForm(form);
      if (!showErrors(form, validateFollowUp(values, { creating: false }))) return;
      // A merge PUT: sending the same values twice changes nothing, so a
      // retry needs no key.
      const res = await Storage.update('followUps', id, {
        vehicleId: values.vehicleId || null, reason: values.reason, notes: values.notes,
        priority: values.priority, dueDate: values.dueDate,
      });
      if (!res.ok && res.errorReason === 'follow_up_closed') { closedElsewhere(res); return; }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast('Follow-up updated.', 'success');
    }));
  }

  /** Someone (or an earlier click) already closed it: say so, and show the truth. */
  async function closedElsewhere(res) {
    Utils.Modal.close();
    await Storage.load('followUps');
    refreshView();
    Utils.toast(`This follow-up is already ${String(res.currentStatus || 'closed').toLowerCase()}.`, 'info');
  }

  /* -- Record contact -- */

  function openContact(id) {
    const fu = Storage.getById('followUps', id);
    if (!fu || fu.status !== 'Open') { Utils.toast('A contact can only be recorded on an open follow-up.', 'info'); return; }
    const sub = createSubmission();
    const ov = Utils.Modal.open({
      title: 'Record Contact',
      body: `<form id="crfForm" novalidate>
        <div class="crf-notice" data-notice hidden></div>
        <p class="crf-fixed">${esc(customerLabel(fu.customerId))}<span class="cell-sub">${esc(fu.reason)}</span></p>
        <div class="form-grid">
          ${field({ id: 'fc-outcome', label: 'Outcome', required: true, err: 'outcome', html: `
            <select class="select" id="fc-outcome" name="outcome">
              <option value="">— Select outcome —</option>
              ${Object.entries(OUTCOMES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select>` })}
          ${field({ id: 'fc-next', label: 'Next contact date', err: 'nextContactDate', html: `
            <input class="input" id="fc-next" name="nextContactDate" type="date">`,
            hint: 'Optional, required for a callback. It becomes the follow-up’s due date.' })}
          ${field({ id: 'fc-note', label: 'Note', err: 'note', span: true, html: `
            <textarea class="textarea" id="fc-note" name="note" rows="3" maxlength="${LIMITS.note}"></textarea>`,
            hint: 'Required when the outcome is Other.' })}
          ${field({ id: 'fc-by', label: 'Recorded by', err: 'recordedBy', html: `
            <input class="input" id="fc-by" name="recordedBy" maxlength="${LIMITS.name}" placeholder="Optional">` })}
        </div></form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
               <button type="button" class="btn btn--primary" data-submit>Save Contact</button>`,
    });
    const form = ov.querySelector('#crfForm');
    if (!sub.key) setNotice(ov, 'This browser cannot create a secure submission key, so contacts cannot be recorded here. Use an up-to-date browser over https.');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const val = n => form.querySelector(`[name="${n}"]`).value;
      const values = { outcome: val('outcome'), note: val('note').trim(), nextContactDate: val('nextContactDate'), recordedBy: val('recordedBy').trim() };
      if (!sub.frozen && !showErrors(form, validateContact(values))) return;
      const payload = { outcome: values.outcome, note: values.note, nextContactDate: values.nextContactDate || null, recordedBy: values.recordedBy };
      const res = await submitOnce(sub, ov, form,
        body => Storage.action('followUps', id, 'contact', body, ['followUpContacts']), payload,
        ['followUps', 'followUpContacts']);
      if (!res || sub.frozen && !res.ok) return;
      if (!res.ok && res.errorReason === 'follow_up_closed') { closedElsewhere(res); return; }
      if (!res.ok) { Utils.wrote(res, form); return; }
      if (!Utils.wrote(res)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast(res.meta && res.meta.replayed ? 'This contact was already saved.' : 'Contact recorded.', 'success');
    }));
  }

  /* -- Complete / Cancel -- */

  function openClose(id, kind) {
    const fu = Storage.getById('followUps', id);
    if (!fu || fu.status !== 'Open') { Utils.toast('This follow-up is already closed.', 'info'); return; }
    const cancel = kind === 'cancel';
    const ov = Utils.Modal.open({
      title: cancel ? 'Cancel Follow-up' : 'Complete Follow-up',
      body: `<form id="crfForm" novalidate>
        <p class="crf-fixed">${esc(customerLabel(fu.customerId))}<span class="cell-sub">${esc(fu.reason)}</span></p>
        <p class="muted-note">${cancel
          ? 'A cancelled follow-up cannot be reopened. Create a new one if more work is needed.'
          : 'A completed follow-up cannot be reopened. Create a new one if more work is needed.'}</p>
        <div class="form-grid">
          ${field({ id: 'fx-note', label: cancel ? 'Reason for cancelling' : 'Completion note', required: cancel,
            err: cancel ? 'reason' : 'note', span: true, html: `
            <textarea class="textarea" id="fx-note" name="note" rows="3" maxlength="${LIMITS.closeNote}"></textarea>` })}
        </div></form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn ${cancel ? 'btn--danger' : 'btn--primary'}" data-submit>${cancel ? 'Cancel Follow-up' : 'Mark Completed'}</button>`,
    });
    const form = ov.querySelector('#crfForm');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const text = form.querySelector('[name="note"]').value.trim();
      if (cancel) {
        const err = validateReason(text, LIMITS.closeNote, 'cancelling');
        if (!showErrors(form, err ? { reason: err } : {})) return;
      } else if (!showErrors(form, tooLong(text, LIMITS.closeNote) ? { note: `Keep the note to ${LIMITS.closeNote} characters or fewer.` } : {})) return;
      const res = await Storage.action('followUps', id, cancel ? 'cancel' : 'complete', cancel ? { reason: text } : { note: text });
      if (!res.ok && res.errorReason === 'follow_up_closed') { closedElsewhere(res); return; }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast(cancel ? 'Follow-up cancelled.' : 'Follow-up completed.', 'success');
    }));
  }

  /* -- Void a contact -- */

  function openVoid(contactId, followUpId) {
    const c = Storage.getById('followUpContacts', contactId);
    if (!c || c.status !== 'Active') { Utils.toast('This contact is already voided.', 'info'); return; }
    const ov = Utils.Modal.open({
      title: 'Void Contact',
      body: `<form id="crfForm" novalidate>
        <p class="crf-fixed">${outcomeBadge(c.outcome)} <span>${esc(formatMoment(c.contactedAt))}</span></p>
        <p class="muted-note">The contact stays in the history, marked Void with your reason. It no longer counts as the latest contact. The due date is not changed.</p>
        <div class="form-grid">
          ${field({ id: 'fv-reason', label: 'Reason for voiding', required: true, err: 'reason', span: true, html: `
            <textarea class="textarea" id="fv-reason" name="reason" rows="3" maxlength="${LIMITS.voidReason}"></textarea>` })}
          ${field({ id: 'fv-by', label: 'Voided by', err: 'voidedBy', html: `
            <input class="input" id="fv-by" name="voidedBy" maxlength="${LIMITS.name}" placeholder="Optional">` })}
        </div></form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn btn--danger" data-submit>Void Contact</button>`,
    });
    const form = ov.querySelector('#crfForm');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const reason = form.querySelector('[name="reason"]').value.trim();
      const voidedBy = form.querySelector('[name="voidedBy"]').value.trim();
      const err = validateReason(reason, LIMITS.voidReason, 'voiding');
      const errors = err ? { reason: err } : {};
      if (tooLong(voidedBy, LIMITS.name)) errors.voidedBy = `Keep the name to ${LIMITS.name} characters or fewer.`;
      if (!showErrors(form, errors)) return;
      const res = await Storage.action('followUpContacts', contactId, 'void', { reason, voidedBy }, ['followUps']);
      if (!res.ok && res.errorReason === 'contact_void') {
        await Storage.load('followUpContacts');
        Utils.toast('This contact was already voided.', 'info');
        refreshView();
        openDetail(followUpId);
        return;
      }
      if (!Utils.wrote(res, form)) return;
      refreshView();
      Utils.toast('Contact voided.', 'success');
      openDetail(followUpId);
    }));
  }

  /* -- Details and history -- */

  function historyHtml(id) {
    const rows = contactsOf(id);
    if (!rows.length) return '<p class="muted-note">No contact has been recorded yet.</p>';
    return `
      <div class="table-wrap"><table class="table crf-history">
        <thead><tr><th scope="col">When</th><th scope="col">Outcome</th><th scope="col">Note</th>
          <th scope="col">Next contact</th><th scope="col">Recorded by</th><th scope="col"><span class="crf-sr-only">Actions</span></th></tr></thead>
        <tbody>${rows.map(c => {
          const voided = c.status === 'Void';
          return `
          <tr class="${voided ? 'crf-voided' : ''}">
            <td>${esc(formatMoment(c.contactedAt))}${voided ? `<span class="cell-sub">Voided ${esc(formatMoment(c.voidedAt))}${c.voidedBy ? ` by ${esc(c.voidedBy)}` : ''}</span>` : ''}</td>
            <td>${outcomeBadge(c.outcome)}${voided ? ` ${badge('neutral', 'Void')}` : ''}</td>
            <td class="crf-reason">${c.note ? esc(c.note) : '<span class="crf-muted">—</span>'}${voided && c.voidReason ? `<span class="cell-sub">Void reason: ${esc(c.voidReason)}</span>` : ''}</td>
            <td>${c.nextContactDate ? esc(formatDay(c.nextContactDate)) : '<span class="crf-muted">—</span>'}</td>
            <td>${c.recordedBy ? esc(c.recordedBy) : '<span class="crf-muted">—</span>'}</td>
            <td>${voided ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-void="${esc(c.id)}">Void</button>`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }

  function openDetail(id) {
    const fu = Storage.getById('followUps', id);
    if (!fu) { Utils.toast('That follow-up is no longer available.', 'info'); return; }
    const t = today();
    const row = buildRows({ followUps: [fu], customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'), today: t })[0];
    const fact = (label, value) => `<div class="crf-fact"><span class="crf-fact__label">${esc(label)}</span><span class="crf-fact__value">${value}</span></div>`;
    const ov = Utils.Modal.open({
      title: 'Follow-up Details',
      size: 'lg',
      body: `
        <div class="crf-facts">
          ${fact('Customer', customerCell(row))}
          ${fact('Vehicle', vehicleCell(row))}
          ${fact('Status', badge(STATUS_TONE[row.status] || 'neutral', row.status))}
          ${fact('Priority', esc(PRIORITY_LABEL[row.priority]))}
          ${fact('Due date', `${esc(formatDay(fu.dueDate))}${row.open ? `<span class="cell-sub">${esc(dueText(row, t))}</span>` : ''}`)}
          ${fact('Last contact', fu.lastContactAt ? `${esc(formatMoment(fu.lastContactAt))}<span class="cell-sub">${esc(OUTCOMES[fu.lastOutcome] || '')}</span>` : '<span class="crf-muted">No contact yet</span>')}
          <div class="crf-fact crf-fact--wide"><span class="crf-fact__label">Reason</span><span class="crf-fact__value crf-reason">${esc(fu.reason)}</span></div>
          ${fu.notes ? `<div class="crf-fact crf-fact--wide"><span class="crf-fact__label">Notes</span><span class="crf-fact__value crf-reason">${esc(fu.notes)}</span></div>` : ''}
          ${fu.status !== 'Open' ? `<div class="crf-fact crf-fact--wide"><span class="crf-fact__label">${fu.status === 'Cancelled' ? 'Cancelled' : 'Completed'} ${esc(formatMoment(fu.closedAt))}</span><span class="crf-fact__value crf-reason">${fu.closeNote ? esc(fu.closeNote) : '<span class="crf-muted">No note</span>'}</span></div>` : ''}
        </div>
        <h3 class="crf-subhead">Contact history</h3>
        ${historyHtml(id)}`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${fu.status === 'Open' ? `
        <button type="button" class="btn btn--ghost" data-do="cancel">Cancel Follow-up</button>
        <button type="button" class="btn btn--ghost" data-do="edit">Edit</button>
        <button type="button" class="btn btn--ghost" data-do="complete">Mark Completed</button>
        <button type="button" class="btn btn--primary" data-do="contact">Record Contact</button>` : ''}`,
    });
    ov.addEventListener('click', e => {
      const v = e.target.closest && e.target.closest('[data-void]');
      if (v) { openVoid(v.dataset.void, id); return; }
      const d = e.target.closest && e.target.closest('[data-do]');
      if (!d) return;
      const act = d.dataset.do;
      if (act === 'contact') openContact(id);
      else if (act === 'edit') openEdit(id);
      else if (act === 'complete') openClose(id, 'complete');
      else if (act === 'cancel') openClose(id, 'cancel');
    });
  }

  /* ---------- events ---------- */

  function bindEvents() {
    const search = $('crfSearch'), status = $('crfStatus'), due = $('crfDue'), priority = $('crfPriority');
    const body = $('crfBody'), add = $('crfNew');
    if (search) search.addEventListener('input', e => { state.search = e.target.value; renderList(); });
    if (status) status.addEventListener('change', e => { state.status = e.target.value || 'open'; renderList(); });
    if (due) due.addEventListener('change', e => { state.due = e.target.value || 'any'; renderList(); });
    if (priority) priority.addEventListener('change', e => { state.priority = e.target.value || 'all'; renderList(); });
    if (add) add.addEventListener('click', () => openCreate());
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      const id = btn.dataset.id;
      switch (btn.dataset.action) {
        case 'retry': load(); break;
        case 'view': openDetail(id); break;
        case 'contact': openContact(id); break;
        case 'complete': openClose(id, 'complete'); break;
        default: break;
      }
    });
  }

  function start(outcome) {
    // Signed out: the sign-in screen covers the window and the app reloads
    // after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return {
    LIMITS, OUTCOMES,
    dhakaToday, dhakaDateOf, isDateOnly, formatDay, telNumber,
    displayStatus, kpis, buildRows, sortRows, filterRows,
    validateFollowUp, validateContact, newKey, isAmbiguous, createSubmission,
    load, refreshView, renderList, state,
  };
})();
