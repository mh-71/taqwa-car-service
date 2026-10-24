/* ============================================================
   staff-leave.js — Staff Management › Leave Management
   ------------------------------------------------------------
   Leave requests and their decisions.

   Source of truth: the workshop database, and nothing else.
     - The people come from the staff roster (Storage.load('staff'),
       GET /api/staff): the same ids the Staff List shows -- a mechanic
       (MEC-0001) or any other employee (STF-0001). No person is copied.
     - The requests come from Storage.load('leaveRequests')
       (GET /api/leave-requests), ONLY in 'api' mode. In every other mode this
       page shows nothing and changes nothing.
     - New Leave Request goes through Storage.create (POST
       /api/leave-requests); Approve and Reject through Storage.action
       (POST /api/leave-requests/:id/approve | reject). The Worker re-checks
       every field, refuses a request overlapping another pending or approved
       one of the same person, lets only an administrator decide, decides a
       request once, and refuses a decision made from an out-of-date copy
       (expectedUpdatedAt). The checks here only spare a round trip.

   Approving leave changes nothing else: no attendance record is made, and
   no balance or pay is calculated.
   ============================================================ */

const StaffLeave = (() => {

  const { esc } = Utils;

  // The Worker's rules (src/routes/leave-requests.js), repeated only to spare a round trip.
  const TYPES = ['Casual', 'Sick', 'Annual', 'Unpaid'];
  const STATUSES = ['Pending', 'Approved', 'Rejected'];
  const TEXT_MAX = 500;
  const MAX_DAYS = 366;
  const PAGE = 10;
  const COLS = 9;
  const BADGE = { Pending: 'badge--warn', Approved: 'badge--good', Rejected: 'badge--bad' };
  // The colour slot of each type and status in the charts (the palette of css/staff.css).
  const TYPE_SLOT = { Casual: 1, Sick: 3, Annual: 2, Unpaid: 5 };
  const STATUS_SLOT = { Pending: 3, Approved: 2, Rejected: 4 };

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    review: svg('M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'),
    view: svg('M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z'),
    calendar: svg('M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const dayNumber = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

  /** Calendar days from one date to another, both included. */
  const leaveDays = (start, end) => dayNumber(end) - dayNumber(start) + 1;

  /** Counts by status and by type, and the calendar days of approved leave. Only real requests are counted. */
  function summary(list) {
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    const byType = Object.fromEntries(TYPES.map(t => [t, 0]));
    let approvedDays = 0;
    for (const r of list) {
      if (byStatus[r.status] !== undefined) byStatus[r.status]++;
      if (byType[r.leaveType] !== undefined) byType[r.leaveType]++;
      if (r.status === 'Approved') approvedDays += leaveDays(r.startDate, r.endDate);
    }
    return { total: list.length, byStatus, byType, approvedDays };
  }

  /** Requests matching a search text, a type and a status ('all' = no filter). */
  function filterRequests(list, { search = '', type = 'all', status = 'all' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    return list.filter(r =>
      (!q || [r.staffName, r.staffId, r.id, r.reason, r.department].some(v => String(v || '').toLowerCase().includes(q)))
      && (type === 'all' || r.leaveType === type)
      && (status === 'all' || r.status === status));
  }

  /** Pending first (oldest submission first, so nothing waits forever), then decided ones, newest first. */
  function sortRequests(list) {
    const pending = list.filter(r => r.status === 'Pending').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const decided = list.filter(r => r.status !== 'Pending').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
    return [...pending, ...decided];
  }

  /** One page of a list: the rows, and the 1-based range they cover. */
  function paginate(list, page, size = PAGE) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page), pages);
    const rows = list.slice((p - 1) * size, p * size);
    return { rows, page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: (p - 1) * size + rows.length, total: list.length };
  }

  /** The form's checks, as the Worker makes them. Returns { field: message }. */
  function validateRequest(v) {
    const e = {};
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!v.staffId) e.staffId = 'Choose a staff member.';
    if (!TYPES.includes(v.leaveType)) e.leaveType = 'Choose a leave type.';
    if (!date.test(v.startDate || '')) e.startDate = 'Choose the first day of leave.';
    if (!date.test(v.endDate || '')) e.endDate = 'Choose the last day of leave.';
    if (!e.startDate && !e.endDate) {
      if (v.endDate < v.startDate) e.endDate = 'The end date cannot be before the start date.';
      else if (leaveDays(v.startDate, v.endDate) > MAX_DAYS) e.endDate = `A request covers at most ${MAX_DAYS} days.`;
    }
    const reason = String(v.reason || '').trim();
    if (!reason) e.reason = 'Enter the reason.';
    else if (reason.length > TEXT_MAX) e.reason = `Use at most ${TEXT_MAX} characters.`;
    return e;
  }

  /* ---------- markup ---------- */

  const muted = text => `<span class="lv-muted">${esc(text)}</span>`;
  const badge = status => `<span class="badge ${BADGE[status] || 'badge--neutral'}">${esc(status)}</span>`;
  const typeBadge = type => `<span class="stf-role stf-role--${TYPE_SLOT[type] || 1}">${esc(type)} Leave</span>`;
  const fmtDay = day => Utils.fmtDate(day);
  const fmtWhen = iso => (iso ? Utils.fmtDate(String(iso).slice(0, 10)) : '');

  function rowHtml(r) {
    const sub = r.designation || (r.isMechanic ? 'Mechanic' : '');
    const decision = r.status === 'Pending' ? ''
      : `<span class="cell-sub">${esc(r.status)} by ${esc(r.decidedBy || '—')}${r.decisionNote ? `: ${esc(r.decisionNote)}` : ''}</span>`;
    const action = r.status === 'Pending'
      ? `<button type="button" class="btn btn--ghost btn--sm" data-action="review" data-id="${esc(r.id)}" aria-label="Review the leave request ${esc(r.id)} of ${esc(r.staffName || r.staffId)}">${ICON.review}<span>Review</span></button>`
      : `<button type="button" class="btn btn--ghost btn--sm" data-action="view" data-id="${esc(r.id)}" aria-label="View the leave request ${esc(r.id)} of ${esc(r.staffName || r.staffId)}">${ICON.view}<span>View</span></button>`;
    return `
      <tr data-id="${esc(r.id)}">
        <td data-label="Staff"><span class="cell-main">${esc(r.staffName || r.staffId)}</span><span class="cell-sub">${esc(r.staffId)}${sub ? ` · ${esc(sub)}` : ''}</span></td>
        <td data-label="Department">${r.department ? esc(r.department) : muted('—')}</td>
        <td data-label="Leave Type">${typeBadge(r.leaveType)}</td>
        <td data-label="Dates" class="stf-nowrap"><span>${esc(fmtDay(r.startDate))}</span><span class="cell-sub">to ${esc(fmtDay(r.endDate))}</span></td>
        <td data-label="Days" class="num">${leaveDays(r.startDate, r.endDate)}</td>
        <td data-label="Reason" class="stf-reason"><span>${esc(r.reason)}</span>${decision}</td>
        <td data-label="Submitted" class="stf-nowrap">${esc(fmtWhen(r.createdAt))}<span class="cell-sub">${esc(r.id)}</span></td>
        <td data-label="Status">${badge(r.status)}</td>
        <td data-label="Actions"><div class="row-actions">${action}</div></td>
      </tr>`;
  }

  function stateRow({ icon = ICON.calendar, title, text, retry = false, clear = false, signIn = false, add = false, tone = 'neutral' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : '',
      add ? '<button type="button" class="btn btn--primary btn--sm" data-action="new">New Leave Request</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="lv-state-row">
        <td colspan="${COLS}">
          <div class="lv-state${tone === 'bad' ? ' lv-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="lv-state__icon">${icon}</span>
            <div class="lv-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="lv-state__actions">${actions}</p>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  function skeletonRows(n = 4) {
    const cell = '<td><span class="lv-skel"></span></td>';
    return Array.from({ length: n }, () => `<tr class="lv-state-row lv-skel-row" aria-hidden="true">${cell.repeat(COLS)}</tr>`).join('');
  }

  /** A donut chart: one conic-gradient ring plus a legend that carries the numbers. */
  function donutHtml(parts, centreLabel, describe) {
    const total = parts.reduce((t, p) => t + p.n, 0);
    let at = 0;
    const stops = parts.map(p => {
      const start = at; at += total ? (p.n / total) * 100 : 0;
      return `var(--stf-c${p.slot}) ${start.toFixed(2)}% ${at.toFixed(2)}%`;
    });
    const ring = `<div class="stf-donut__ring" role="img" aria-label="${esc(describe)}" style="background:${total ? `conic-gradient(${stops.join(', ')})` : 'var(--line)'}">
      <div class="stf-donut__hole"><strong class="stf-donut__total">${total}</strong><span>${esc(centreLabel)}</span></div></div>`;
    const pct = n => (total ? Math.round((n / total) * 100) : 0);
    const legend = parts.map(p => `<li class="stf-legend__row"><span class="stf-dot stf-dot--${p.slot}" aria-hidden="true"></span>`
      + `<span class="stf-legend__label">${esc(p.label)}</span><span class="stf-legend__n">${p.n}</span><span class="stf-legend__pct">${pct(p.n)}%</span></li>`).join('');
    return { ring, legend };
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, today: '', search: '', type: 'all', status: 'all', page: 1 };
  const $ = id => document.getElementById(id);
  let debounce = null;
  const staff = () => Storage.getData('staff');
  const requests = () => Storage.getData('leaveRequests');

  const CONTROLS = ['lvNew', 'lvSearch', 'lvType', 'lvStatus', 'lvClear'];
  function setControls(enabled) { for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; } }
  function setBody(html, busy = false) {
    const el = $('lvBody'); if (el) el.innerHTML = html;
    const table = $('lvTable'); if (table && table.setAttribute) table.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  const note = text => { const el = $('lvCount'); if (el) el.textContent = text; };
  function setPager(res) {
    const prev = $('lvPrev'), next = $('lvNext'), range = $('lvRange');
    if (range) range.textContent = res && res.total ? `Showing ${res.from}–${res.to} of ${res.total}` : '';
    if (prev) prev.disabled = !res || res.page <= 1;
    if (next) next.disabled = !res || res.page >= res.pages;
  }
  function setCards(s) {
    const put = (id, v) => { const el = $(id); if (el) el.textContent = s ? String(v) : '—'; };
    put('lv-pending', s && s.byStatus.Pending);
    put('lv-approved', s && s.byStatus.Approved);
    put('lv-rejected', s && s.byStatus.Rejected);
    put('lv-days', s && s.approvedDays);
  }
  function setCharts(s) {
    const draw = (chartId, legendId, d) => { const c = $(chartId), l = $(legendId); if (c) c.innerHTML = d ? d.ring : ''; if (l) l.innerHTML = d ? d.legend : ''; };
    draw('lvTypeChart', 'lvTypeLegend', s && donutHtml(TYPES.map(t => ({ label: `${t} Leave`, n: s.byType[t], slot: TYPE_SLOT[t] })), 'Requests',
      `Leave requests by type: ${TYPES.map(t => `${t} ${s.byType[t]}`).join(', ')}.`));
    draw('lvStatusChart', 'lvStatusLegend', s && donutHtml(STATUSES.map(st => ({ label: st, n: s.byStatus[st], slot: STATUS_SLOT[st] })), 'Requests',
      `Leave requests by status: ${STATUSES.map(st => `${st} ${s.byStatus[st]}`).join(', ')}.`));
  }

  function fillFilters() {
    const t = $('lvType');
    if (t) { t.innerHTML = '<option value="all">All leave types</option>' + TYPES.map(x => `<option value="${esc(x)}">${esc(x)} Leave</option>`).join(''); t.value = state.type; }
    const s = $('lvStatus');
    if (s) { s.innerHTML = '<option value="all">All statuses</option>' + STATUSES.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join(''); s.value = state.status; }
  }

  function render() {
    const all = requests();
    const s = summary(all);
    setCards(s);
    setCharts(s);
    if (!all.length) {
      setBody(stateRow({ title: 'No leave requests yet', add: true, text: 'Use New Leave Request to submit the first one. Each request is saved in the workshop database.' }));
      note('0 requests');
      setPager(null);
      return;
    }
    const shown = sortRequests(filterRequests(all, state));
    const res = paginate(shown, state.page);
    state.page = res.page;
    setBody(res.rows.length ? res.rows.map(rowHtml).join('')
      : stateRow({ icon: ICON.search, title: 'No leave requests match your search or filters', clear: true, text: 'Change or clear the search, leave type or status filter.' }));
    note(`${shown.length} of ${all.length} requests · ${s.byStatus.Pending} pending`);
    setPager(res);
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setControls(false);
    setCards(null);
    setCharts(null);
    note('');
    setPager(null);
    let row;
    if (code === 'no_api') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Leave Management needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no leave requests are shown and none can be submitted.' });
    } else if (code === 'unauthorized') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your session has ended', signIn: true, text: 'Sign in again to see and submit leave requests. Nothing was changed.' });
    } else if (code === 'forbidden') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your account cannot see leave requests', text: 'Your account is not allowed to see or submit leave requests.' });
    } else {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Leave requests could not be loaded', retry: true,
        text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.' });
    }
    setBody(row);
  }

  /** Read the roster and every request. */
  async function load({ staffToo = true } = {}) {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    setControls(false);
    note('Loading leave requests…');
    setBody(skeletonRows(), true);
    const [st, lv] = await Promise.all([staffToo ? Storage.load('staff') : Promise.resolve({ ok: true }), Storage.load('leaveRequests')]);
    if (!st.ok) { renderUnavailable(st.code); return false; }
    if (!lv.ok) { renderUnavailable(lv.code); return false; }
    state.loaded = true;
    setControls(true);
    fillFilters();
    render();
    return true;
  }

  /* ---------- dialogs ---------- */

  function field({ id, label, required = false, html, err, hint = '' }) {
    return `
      <div class="field">
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="lv-hint" id="${id}-hint">${esc(hint)}</p>` : ''}
        <div class="field__error" id="${id}-err" data-err="${err}" role="alert"></div>
      </div>`;
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    Object.entries(errors).forEach(([key, msg]) => {
      const err = form.querySelector(`[data-err="${key}"]`);
      if (!err) return;
      err.textContent = msg;
      const wrap = err.closest('.field');
      if (wrap) wrap.classList.add('field--error');
    });
    let first = null;
    form.querySelectorAll('.field').forEach(wrap => {
      const ctl = wrap.querySelector('input, select, textarea');
      if (!ctl) return;
      if (wrap.classList.contains('field--error')) { ctl.setAttribute('aria-invalid', 'true'); if (!first) first = ctl; }
      else ctl.removeAttribute('aria-invalid');
    });
    if (first && first.focus) first.focus();
  }

  /** Submit a new request for an active staff member. */
  function openNew() {
    if (!state.loaded) return;
    const people = staff().filter(s => s.status === 'Active')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
    if (!people.length) {
      Utils.Modal.open({
        title: 'New Leave Request',
        body: '<p>There is no active staff member yet. Add staff in <strong>Add Staff</strong> first; leave is requested for the people on the Staff List.</p>',
        footer: '<button type="button" class="btn btn--primary" data-modal-close>OK</button>',
      });
      return;
    }
    const ov = Utils.Modal.open({
      title: 'New Leave Request',
      size: 'lg',
      body: `
        <form id="lvForm" novalidate>
          <p class="lv-hint">The request is saved as <strong>Pending</strong> until an administrator approves or rejects it.</p>
          <div class="form-grid">
            ${field({ id: 'lv-staff', label: 'Staff member', required: true, err: 'staffId',
              html: `<select class="select" id="lv-staff" required aria-required="true" aria-describedby="lv-staff-err"><option value="">Choose a staff member</option>${people.map(s => `<option value="${esc(s.id)}">${esc(s.name || s.id)} — ${esc(s.id)}</option>`).join('')}</select>` })}
            ${field({ id: 'lv-type', label: 'Leave type', required: true, err: 'leaveType',
              html: `<select class="select" id="lv-type" required aria-required="true" aria-describedby="lv-type-err"><option value="">Choose a leave type</option>${TYPES.map(t => `<option value="${esc(t)}">${esc(t)} Leave</option>`).join('')}</select>` })}
            ${field({ id: 'lv-start', label: 'Start date', required: true, err: 'startDate', hint: 'The first day of leave.',
              html: `<input class="input" type="date" id="lv-start" required aria-required="true" aria-describedby="lv-start-hint lv-start-err">` })}
            ${field({ id: 'lv-end', label: 'End date', required: true, err: 'endDate', hint: 'The last day of leave; the same day for one day.',
              html: `<input class="input" type="date" id="lv-end" required aria-required="true" aria-describedby="lv-end-hint lv-end-err">` })}
            ${field({ id: 'lv-reason', label: 'Reason', required: true, err: 'reason', hint: `At most ${TEXT_MAX} characters.`,
              html: `<textarea class="input" id="lv-reason" rows="3" maxlength="${TEXT_MAX}" required aria-required="true" aria-describedby="lv-reason-hint lv-reason-err"></textarea>` })}
          </div>
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>Submit Request</button>`,
    });
    const form = ov.querySelector('#lvForm');
    const start = form.querySelector('#lv-start'), end = form.querySelector('#lv-end');
    // The end date starts where the start date is, and can never be chosen before it.
    start.addEventListener('change', () => { end.min = start.value; if (!end.value || end.value < start.value) end.value = start.value; });
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const values = {
        staffId: form.querySelector('#lv-staff').value, leaveType: form.querySelector('#lv-type').value,
        startDate: start.value, endDate: end.value, reason: form.querySelector('#lv-reason').value.trim(),
      };
      const errors = validateRequest(values);
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const res = await Storage.create('leaveRequests', values);
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      Utils.toast(`Leave request ${res.record.id} for ${res.record.staffName} submitted. It waits for a decision.`, 'success');
      state.page = 1;
      render();
    }));
  }

  /** The facts of one request, as a definition list. */
  function detailsHtml(r) {
    const rows = [
      ['Request', r.id],
      ['Staff member', `${r.staffName || r.staffId} (${r.staffId})`],
      ['Department', r.department || '—'],
      ['Leave type', `${r.leaveType} Leave`],
      ['Dates', `${fmtDay(r.startDate)} to ${fmtDay(r.endDate)} (${leaveDays(r.startDate, r.endDate)} day${leaveDays(r.startDate, r.endDate) === 1 ? '' : 's'})`],
      ['Reason', r.reason],
      ['Submitted', fmtWhen(r.createdAt)],
      ['Status', r.status],
      ...(r.status === 'Pending' ? [] : [['Decided', `${fmtWhen(r.decidedAt)} by ${r.decidedBy || '—'}`], ['Decision note', r.decisionNote || '—']]),
    ];
    return `<dl class="lv-dl">${rows.map(([k, v]) => `<div class="lv-dl__row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  }

  /** A decided request: read only. */
  function openView(r) {
    Utils.Modal.open({
      title: `Leave request ${r.id}`,
      body: `${detailsHtml(r)}<p class="lv-hint">A decision cannot be changed.</p>`,
      footer: '<button type="button" class="btn btn--primary" data-modal-close>Close</button>',
    });
  }

  /** A pending request: approve, or reject with a reason. */
  function openReview(r) {
    if (!state.loaded) return;
    const ov = Utils.Modal.open({
      title: `Review leave request ${r.id}`,
      size: 'lg',
      body: `
        ${detailsHtml(r)}
        <form id="lvDecision" novalidate>
          ${field({ id: 'lv-note', label: 'Decision note', err: 'note', hint: `Required to reject (the reason); optional to approve. At most ${TEXT_MAX} characters.`,
            html: `<textarea class="input" id="lv-note" rows="2" maxlength="${TEXT_MAX}" aria-describedby="lv-note-hint lv-note-err"></textarea>` })}
          <p class="lv-hint">Only an administrator can decide. A decision is final, and approving changes nothing else &#8212; attendance is not marked.</p>
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--danger" data-decide="reject">Reject</button>
        <button type="button" class="btn btn--primary" data-decide="approve">Approve</button>`,
    });
    const form = ov.querySelector('#lvDecision');
    form.addEventListener('submit', e => e.preventDefault());
    const decide = act => Utils.saving(async () => {
      const text = form.querySelector('#lv-note').value.trim();
      const errors = {};
      if (act === 'reject' && !text) errors.note = 'Say why the request is rejected.';
      if (text.length > TEXT_MAX) errors.note = `Use at most ${TEXT_MAX} characters.`;
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const res = await Storage.action('leaveRequests', r.id, act, { expectedUpdatedAt: r.updatedAt, ...(text ? { note: text } : {}) });
      if (!res.ok && (res.errorReason === 'already_decided' || res.errorReason === 'concurrent_modification' || res.code === 'not_found')) {
        // Someone else decided or changed it meanwhile: show what is there now, never overwrite it.
        Utils.Modal.close();
        Utils.toast(res.message || 'This request was changed meanwhile. The latest requests are shown.', 'warning');
        await load({ staffToo: false });
        return;
      }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      Utils.toast(`Leave request ${res.record.id} of ${res.record.staffName} ${res.record.status.toLowerCase()}.`, 'success');
      render();
    });
    ov.querySelector('[data-decide="approve"]').addEventListener('click', decide('approve'));
    ov.querySelector('[data-decide="reject"]').addEventListener('click', decide('reject'));
  }

  /* ---------- events ---------- */

  function clearFilters() {
    clearTimeout(debounce);
    Object.assign(state, { search: '', type: 'all', status: 'all', page: 1 });
    for (const [id, value] of [['lvSearch', ''], ['lvType', 'all'], ['lvStatus', 'all']]) { const el = $(id); if (el) el.value = value; }
    render();
  }

  function bindEvents() {
    const search = $('lvSearch'), body = $('lvBody');
    if (search) search.addEventListener('input', e => {
      const value = String(e.target.value || '').slice(0, 100);
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; state.page = 1; render(); }, 200);
    });
    for (const [id, key, allowed] of [['lvType', 'type', TYPES], ['lvStatus', 'status', STATUSES]]) {
      const el = $(id);
      if (el) el.addEventListener('change', e => { const v = String(e.target.value || 'all'); state[key] = allowed.includes(v) ? v : 'all'; state.page = 1; render(); });
    }
    const clear = $('lvClear'), add = $('lvNew'), prev = $('lvPrev'), next = $('lvNext');
    if (clear) clear.addEventListener('click', clearFilters);
    if (add) add.addEventListener('click', openNew);
    if (prev) prev.addEventListener('click', () => { state.page -= 1; render(); });
    if (next) next.addEventListener('click', () => { state.page += 1; render(); });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'signin': window.location.reload(); break;
        case 'clear': clearFilters(); break;
        case 'new': openNew(); break;
        case 'review': { const r = Storage.getById('leaveRequests', id); if (r) (r.status === 'Pending' ? openReview : openView)(r); break; }
        case 'view': { const r = Storage.getById('leaveRequests', id); if (r) openView(r); break; }
        default: break;
      }
    });
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    state.today = Utils.todayStr();
    bindEvents();
    load();
  }

  Storage.ready(start);

  return {
    TYPES, STATUSES,
    leaveDays, summary, filterRequests, sortRequests, paginate, validateRequest, rowHtml, donutHtml,
    load, render, clearFilters, state,
  };
})();
