/* ============================================================
   staff-overview.js — Staff Management › Overview
   ------------------------------------------------------------
   A read-only dashboard over the workshop database.

   Source of truth: the database, and nothing else. In 'api' mode the page
   makes four reads at once, through the existing routes, and each section
   draws from its own answer:

     staff roster       Storage.loadPage('staff', { limit })            GET /api/staff
     one day           Storage.loadPage('attendance', { date, limit }) GET /api/attendance
     pending leave      Storage.loadPage('leaveRequests', { status: 'Pending', limit: 5 })
     latest activity    Storage.loadPage('activityLog', { limit: 5 })    (administrators only)

   Choosing another attendance day asks for that day only. A section whose
   read fails says so and offers Retry; the others are unaffected. In every
   other mode the page shows nothing.

   Rules kept here:
     * A day without an attendance record is "Not recorded", never Absent.
     * One attendance record per person per day (the database enforces it),
       so no one is counted twice.
     * No number is shown that the server did not support: a failed or
       incomplete read shows "—", never a guess.
     * This page only READS. It creates, edits, approves or deletes nothing,
       and writes nothing to browser storage.
   ============================================================ */

const StaffOverview = (() => {

  const { esc } = Utils;

  const LIST = 5;                // rows in each list
  const ROSTER_LIMIT = 1000;     // the most /api/staff returns in one page
  const DAY_LIMIT = 1000;        // the most /api/attendance returns in one page
  const STATUSES = ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday'];
  const STATUS_BADGE = { Present: 'badge--good', Late: 'badge--warn', 'Half-day': 'badge--info', Absent: 'badge--bad', 'On Leave': 'stf-badge--violet', Holiday: 'badge--neutral' };
  const MODULE_LABEL = { staff: 'Staff', accounts: 'User Accounts', attendance: 'Attendance', leave: 'Leave' };
  const ACTION_LABEL = { create: 'Create', update: 'Update', password: 'Password', approve: 'Approve', reject: 'Reject' };
  const ACTION_BADGE = { create: 'badge--good', update: 'badge--info', password: 'badge--warn', approve: 'badge--good', reject: 'badge--bad' };
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** Total and active staff. `complete` is false when the roster was cut short (then active is not known). */
  function staffSummary(rows, total) {
    const all = Number.isFinite(Number(total)) ? Number(total) : rows.length;
    const complete = rows.length >= all;
    const active = rows.filter(s => s.status === 'Active').length;
    return { total: all, active: complete ? active : null, inactive: complete ? all - active : null, complete };
  }

  /** One day's records counted by status (each record is one person on that day). */
  function attendanceCounts(records) {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    const people = new Set();
    for (const r of records) {
      if (people.has(r.staffId)) continue;       // never count a person twice
      people.add(r.staffId);
      if (Object.prototype.hasOwnProperty.call(out, r.status)) out[r.status] += 1;
    }
    return { ...out, recorded: people.size, people };
  }

  /**
   * Who has no record on `day`: staff who are active now and had joined by
   * that day (a missing joining date counts as joined). Never "absent".
   */
  function notRecorded(roster, records, day) {
    const seen = new Set(records.map(r => r.staffId));
    const expected = roster.filter(s => s.status === 'Active' && (!s.joiningDate || s.joiningDate <= day));
    return { expected: expected.length, missing: expected.filter(s => !seen.has(s.id)).length };
  }

  /** The most recently added staff, newest first. */
  function recentStaff(rows, n = LIST) {
    return rows.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id))).slice(0, n);
  }

  /** An ISO instant as workshop time (Asia/Dhaka), e.g. "24 Oct 2026, 11:05". */
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dhaka' });
    return `${date}, ${time}`;
  }

  const fmtRange = (start, end) => (start === end ? Utils.fmtDate(start) : `${Utils.fmtDate(start)} – ${Utils.fmtDate(end)}`);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /* ---------- markup ---------- */

  const svg = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    empty: svg('M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 10h10v2H7zm0 4h7v2H7z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
    lock: svg('M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z'),
  };

  function stateBlock({ icon = ICON.empty, title, text, retry = '', tone = 'neutral', link = '' }) {
    const actions = [
      retry ? `<button type="button" class="btn btn--ghost btn--sm" data-action="retry" data-section="${esc(retry)}">Retry</button>` : '',
      link,
    ].filter(Boolean).join(' ');
    return `
      <div class="sov-state${tone === 'bad' ? ' sov-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
        <span class="sov-state__icon">${icon}</span>
        <div class="sov-state__text">
          <h3>${esc(title)}</h3>
          <p>${esc(text)}</p>
          ${actions ? `<p class="sov-state__actions">${actions}</p>` : ''}
        </div>
      </div>`;
  }

  const skeleton = (n = 4) => `<ul class="sov-list" aria-hidden="true">${'<li class="sov-row sov-row--skel"><span class="sov-skel"></span><span class="sov-skel sov-skel--short"></span></li>'.repeat(n)}</ul>`;

  /** The state of a failed read, by its error code. */
  function failure(code, what, section) {
    if (code === 'no_api') return stateBlock({ icon: ICON.alert, tone: 'bad', title: 'Needs the workshop database', text: `This copy of the app is not connected to the workshop database, so no ${what} is shown.` });
    if (code === 'unauthorized') return stateBlock({ icon: ICON.lock, tone: 'bad', title: 'Your session has ended', text: `Sign in again to see ${what}. Nothing was changed.` });
    if (code === 'forbidden') {
      return stateBlock({ icon: ICON.lock, title: what === 'the activity log' ? 'Only an administrator can read the activity log' : 'Not available to your account',
        text: what === 'the activity log' ? 'Your account is not allowed to see recent activity.' : `Your account is not allowed to see ${what}.` });
    }
    return stateBlock({ icon: ICON.alert, tone: 'bad', title: `Could not load ${what}`, retry: section, text: 'The workshop database did not answer, so nothing is shown here. Try again in a moment.' });
  }

  const person = (name, id) => `<span class="cell-main">${esc(name || id)}</span><span class="cell-sub">${esc(id)}</span>`;

  function staffRow(s) {
    return `
      <li class="sov-row">
        <div class="sov-row__main">${person(s.name, s.id)}</div>
        <div class="sov-row__meta"><span class="cell-main">${esc(s.department || '—')}</span><span class="cell-sub">Joined ${esc(s.joiningDate ? Utils.fmtDate(s.joiningDate) : '—')}</span></div>
        <div class="sov-row__end"><span class="badge ${s.status === 'Active' ? 'badge--good' : 'badge--bad'}">${esc(s.status)}</span></div>
      </li>`;
  }

  function leaveRow(r) {
    return `
      <li class="sov-row">
        <div class="sov-row__main">${person(r.staffName, r.staffId)}</div>
        <div class="sov-row__meta"><span class="cell-main">${esc(r.leaveType)} leave</span><span class="cell-sub">${esc(fmtRange(r.startDate, r.endDate))}${Number.isFinite(r.days) ? ` · ${esc(plural(r.days, 'day'))}` : ''}</span></div>
        <div class="sov-row__end"><span class="badge badge--warn">${esc(r.status)}</span></div>
      </li>`;
  }

  function activityRow(e) {
    return `
      <li class="sov-row sov-row--act">
        <div class="sov-row__main"><span class="cell-main">${esc(e.summary)}</span><span class="cell-sub">${esc(e.actorName)} · ${esc(MODULE_LABEL[e.module] || e.module)} · ${esc(fmtWhen(e.occurredAt))}</span></div>
        <div class="sov-row__end"><span class="badge ${ACTION_BADGE[e.action] || 'badge--neutral'}">${esc(ACTION_LABEL[e.action] || e.action)}</span></div>
      </li>`;
  }

  /* ---------- the page ---------- */

  const state = {
    today: '', day: '',
    staff: { status: 'loading' },        // { status, rows, total }
    todayAtt: { status: 'loading' },     // today's records (the cards)
    dayAtt: { status: 'loading' },       // the chosen day's records (the Attendance card)
    leave: { status: 'loading' },        // { status, rows, total }
    activity: { status: 'loading' },     // { status, rows }
  };
  const $ = id => document.getElementById(id);
  let dayTicket = 0;   // only the newest day request may draw the Attendance card

  function put(key, value, sub) {
    const v = $(`sov-${key}`), s = $(`sov-${key}-sub`);
    if (v) v.textContent = value;
    if (s) s.textContent = sub;
  }
  function setBody(key, html, busy = false) {
    const el = $(`sov${key}Body`);
    if (!el) return;
    el.innerHTML = html;
    if (el.setAttribute) el.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  const setNote = (key, text) => { const el = $(`sov${key}Note`); if (el) el.textContent = text; };
  const whyMissing = code => (code === 'no_api' ? 'Needs the workshop database' : code === 'unauthorized' ? 'Session ended' : code === 'forbidden' ? 'Not available to your account' : 'Could not be loaded');

  function drawCards() {
    const st = state.staff, ta = state.todayAtt, lv = state.leave;
    if (st.status === 'ok') {
      const s = staffSummary(st.rows, st.total);
      put('total', String(s.total), s.complete ? `${s.inactive} inactive` : 'All staff on record');
      if (s.complete) put('active', String(s.active), s.total ? `${Math.round((s.active / s.total) * 100)}% of all staff` : 'No staff yet');
      else put('active', '—', 'Too many staff to count here; see the Staff List');
    } else {
      const sub = st.status === 'loading' ? 'Loading…' : whyMissing(st.code);
      put('total', '—', sub); put('active', '—', sub);
    }
    if (ta.status === 'ok') {
      const c = attendanceCounts(ta.rows);
      put('present', String(c.Present), 'Recorded today');
      put('late', String(c.Late), 'Recorded today');
      put('absent', String(c.Absent), 'Recorded absences only');
    } else {
      const sub = ta.status === 'loading' ? 'Loading…' : whyMissing(ta.code);
      put('present', '—', sub); put('late', '—', sub); put('absent', '—', sub);
    }
    if (lv.status === 'ok') put('pending', String(lv.total), lv.total ? 'Awaiting a decision' : 'None awaiting a decision');
    else put('pending', '—', lv.status === 'loading' ? 'Loading…' : whyMissing(lv.code));
    const busy = [st, ta, lv].some(x => x.status === 'loading');
    const grid = $('sovStats'); if (grid && grid.setAttribute) grid.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function drawAttendance() {
    const a = state.dayAtt, st = state.staff;
    const label = state.day === state.today ? 'today' : Utils.fmtDate(state.day);
    if (a.status === 'loading') { setBody('Att', skeleton(3), true); setNote('Att', ''); return; }
    if (a.status !== 'ok') { setBody('Att', failure(a.code, 'attendance', 'att')); setNote('Att', ''); return; }
    const c = attendanceCounts(a.rows);
    const nr = st.status === 'ok' && staffSummary(st.rows, st.total).complete ? notRecorded(st.rows, a.rows, state.day) : null;
    const tile = (name, n, cls) => `
        <li class="sov-tile">
          <span class="badge ${cls}">${esc(name)}</span>
          <strong class="sov-tile__n">${esc(String(n))}</strong>
        </li>`;
    const tiles = STATUSES.map(s => tile(s, c[s], STATUS_BADGE[s])).join('');
    const missing = `
        <li class="sov-tile sov-tile--missing">
          <span class="sov-tile__label">Not recorded</span>
          <strong class="sov-tile__n">${nr ? esc(String(nr.missing)) : '—'}</strong>
        </li>`;
    const lead = nr
      ? `${plural(c.recorded, 'record')} for ${label}; ${nr.missing} of ${plural(nr.expected, 'active staff member', 'active staff members')} not recorded.`
      : `${plural(c.recorded, 'record')} for ${label}.${st.status === 'ok' ? '' : ' Not recorded is unavailable: the staff list could not be loaded.'}`;
    setBody('Att', `
      <p class="sov-lead">${esc(lead)}</p>
      <ul class="sov-tiles" aria-label="Attendance for ${esc(label)}">${tiles}${missing}</ul>
      <p class="sov-hint">A day without a record is shown as <strong>Not recorded</strong>, never as Absent. Nothing here records or changes attendance.</p>`);
    setNote('Att', state.day === state.today ? 'Today' : `Showing ${Utils.fmtDate(state.day)}`);
  }

  function drawLeave() {
    const lv = state.leave;
    if (lv.status === 'loading') { setBody('Leave', skeleton(), true); setNote('Leave', ''); return; }
    if (lv.status !== 'ok') { setBody('Leave', failure(lv.code, 'leave requests', 'leave')); setNote('Leave', ''); return; }
    if (!lv.rows.length) {
      setBody('Leave', stateBlock({ title: 'No pending leave requests', text: 'Requests waiting for an administrator\'s decision appear here.' }));
      setNote('Leave', '');
      return;
    }
    setBody('Leave', `<ul class="sov-list">${lv.rows.map(leaveRow).join('')}</ul>`);
    setNote('Leave', lv.total > lv.rows.length ? `Newest ${lv.rows.length} of ${lv.total} pending` : plural(lv.total, 'pending request'));
  }

  function drawStaff() {
    const st = state.staff;
    if (st.status === 'loading') { setBody('Staff', skeleton(), true); setNote('Staff', ''); return; }
    if (st.status !== 'ok') { setBody('Staff', failure(st.code, 'the staff list', 'staff')); setNote('Staff', ''); return; }
    if (!st.rows.length) {
      setBody('Staff', stateBlock({ title: 'No staff yet', text: 'Staff added in Add Staff, and the workshop\'s mechanics, appear here.',
        link: '<a class="btn btn--primary btn--sm" href="staff-add.html">Add Staff</a>' }));
      setNote('Staff', '');
      return;
    }
    const s = staffSummary(st.rows, st.total);
    if (!s.complete) {
      setBody('Staff', stateBlock({ title: 'Too many staff to list here', text: 'The newest staff cannot be picked out reliably on this page. Open the Staff List instead.' }));
      setNote('Staff', '');
      return;
    }
    setBody('Staff', `<ul class="sov-list">${recentStaff(st.rows).map(staffRow).join('')}</ul>`);
    setNote('Staff', `Newest ${Math.min(LIST, st.rows.length)} of ${st.total}`);
  }

  function drawActivity() {
    const ac = state.activity;
    if (ac.status === 'loading') { setBody('Act', skeleton(), true); setNote('Act', ''); return; }
    if (ac.status !== 'ok') { setBody('Act', failure(ac.code, 'the activity log', 'activity')); setNote('Act', ''); return; }
    if (!ac.rows.length) {
      setBody('Act', stateBlock({ title: 'No activity yet', text: 'An entry appears once a Staff Management change succeeds: staff added or edited, an account changed, attendance recorded, leave submitted or decided.' }));
      setNote('Act', '');
      return;
    }
    setBody('Act', `<ul class="sov-list">${ac.rows.map(activityRow).join('')}</ul>`);
    setNote('Act', `Latest ${ac.rows.length}`);
  }

  function drawAlert() {
    const el = $('sovAlert');
    if (!el) return;
    const all = [state.staff, state.todayAtt, state.dayAtt, state.leave, state.activity];
    let html = '';
    if (all.some(x => x.code === 'unauthorized')) {
      html = '<p><strong>Your session has ended.</strong> Sign in again to see the overview. Nothing was changed.</p><button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>';
    }
    el.innerHTML = html;
    el.hidden = !html;
  }

  const drawAll = () => { drawCards(); drawAttendance(); drawLeave(); drawStaff(); drawActivity(); drawAlert(); };

  /* ---------- reads (GET only) ---------- */

  const asState = (res, extra) => (res.ok ? { status: 'ok', rows: res.rows, ...extra(res) } : { status: 'error', code: res.code });
  const totalOf = res => ({ total: Number(res.meta && res.meta.total) || res.rows.length });

  async function loadStaff() {
    state.staff = { status: 'loading' }; drawCards(); drawStaff();
    state.staff = asState(await Storage.loadPage('staff', { limit: String(ROSTER_LIMIT) }), totalOf);
    drawCards(); drawStaff(); drawAttendance(); drawAlert();
  }

  /** One day's records; today's also feed the cards. */
  async function loadDay(day) {
    const mine = ++dayTicket;
    const isToday = day === state.today;
    state.dayAtt = { status: 'loading' };
    if (isToday) state.todayAtt = { status: 'loading' };
    drawAttendance(); if (isToday) drawCards();
    const next = asState(await Storage.loadPage('attendance', { date: day, limit: String(DAY_LIMIT) }), () => ({}));
    if (isToday) state.todayAtt = next;
    if (mine === dayTicket) state.dayAtt = next;
    drawCards(); drawAttendance(); drawAlert();
  }

  async function loadLeave() {
    state.leave = { status: 'loading' }; drawCards(); drawLeave();
    state.leave = asState(await Storage.loadPage('leaveRequests', { status: 'Pending', limit: String(LIST) }), totalOf);
    drawCards(); drawLeave(); drawAlert();
  }

  async function loadActivity() {
    state.activity = { status: 'loading' }; drawActivity();
    state.activity = asState(await Storage.loadPage('activityLog', { limit: String(LIST) }), () => ({}));
    drawActivity(); drawAlert();
  }

  function renderNoApi() {
    for (const k of ['staff', 'todayAtt', 'dayAtt', 'leave', 'activity']) state[k] = { status: 'error', code: 'no_api' };
    drawAll();
  }

  /** Everything at once; each section draws as its answer arrives. */
  async function load() {
    if (!Storage.isApi()) { renderNoApi(); return false; }
    const day = $('sovDay');
    if (day) { day.disabled = false; day.value = state.day; if (day.setAttribute) day.setAttribute('max', state.today); }
    await Promise.all([loadStaff(), loadDay(state.day), loadLeave(), loadActivity()]);
    return true;
  }

  /* ---------- events ---------- */

  function chooseDay(value) {
    const v = String(value || '');
    if (!DATE.test(v) || v > state.today) { const d = $('sovDay'); if (d) d.value = state.day; return null; }
    if (v === state.day) return null;
    state.day = v;
    // Today's records are already known: no second request for them.
    if (v === state.today && state.todayAtt.status === 'ok') { dayTicket += 1; state.dayAtt = state.todayAtt; drawAttendance(); return null; }
    return loadDay(v);
  }

  function bindEvents() {
    const day = $('sovDay');
    if (day) day.addEventListener('change', e => chooseDay(e.target.value));
    const onClick = e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const section = btn.dataset ? btn.dataset.section : btn.section;
      if (action === 'signin') { window.location.reload(); return; }
      if (action !== 'retry') return;
      if (section === 'staff') loadStaff();
      else if (section === 'att') loadDay(state.day);
      else if (section === 'leave') loadLeave();
      else if (section === 'activity') loadActivity();
    };
    for (const id of ['sovAttBody', 'sovLeaveBody', 'sovStaffBody', 'sovActBody', 'sovAlert']) { const el = $(id); if (el) el.addEventListener('click', onClick); }
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    state.today = Utils.todayStr();
    state.day = state.today;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return { STATUSES, LIST, staffSummary, attendanceCounts, notRecorded, recentStaff, fmtWhen, staffRow, leaveRow, activityRow, load, chooseDay, state };
})();
