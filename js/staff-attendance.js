/* ============================================================
   staff-attendance.js — Staff Management › Attendance
   ------------------------------------------------------------
   Who was in, who was late and who was away, day by day.

   Source of truth: the workshop database, and nothing else.
     - The people come from the staff roster (Storage.load('staff'),
       GET /api/staff): the same ids the Staff List shows -- a mechanic
       (MEC-0001) or any other employee (STF-0001). No person is copied.
     - The records of the chosen month come from
       Storage.load('attendance', { from, to }) (GET /api/attendance), ONLY
       in 'api' mode. In every other mode this page shows nothing and changes
       nothing.
     - Record and Edit go through Storage.create / update (POST
       /api/attendance, PUT /api/attendance/:id). The Worker re-checks every
       field, allows one record per staff member per day (a second is refused,
       naming the first), never a future day, and refuses an edit made from an
       out-of-date copy (expectedUpdatedAt) -- so nothing is silently
       overwritten. The checks here only spare a round trip.

   A day with no record is "Not recorded": it is never counted as absent,
   and nothing is calculated from attendance (no pay, overtime or leave).
   ============================================================ */

const StaffAttendance = (() => {

  const { esc } = Utils;

  // The Worker's rules (src/routes/attendance.js), repeated only to spare a round trip.
  const STATUSES = ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday'];
  const WORKED = ['Present', 'Late', 'Half-day'];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const NOTES_MAX = 500;
  const NOT_RECORDED = 'none';
  const COLS = 7;
  const BADGE = { Present: 'badge--good', Late: 'badge--warn', 'Half-day': 'badge--info', Absent: 'badge--bad', 'On Leave': 'stf-badge--violet', Holiday: 'badge--neutral' };

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    add: svg('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'),
    edit: svg('M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z'),
    people: svg('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const slug = status => status.toLowerCase().replace(/[^a-z]+/g, '-');

  /** The first and last day of the month a 'YYYY-MM-DD' falls in. */
  function monthRange(day) {
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${day.slice(0, 7)}-01`, to: `${day.slice(0, 7)}-${String(last).padStart(2, '0')}` };
  }

  const toMinutes = t => (TIME.test(t || '') ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);

  /** Time between a check-in and a check-out, in minutes, or null. Display only -- no rule is applied. */
  function minutesWorked(rec) {
    const a = toMinutes(rec && rec.checkIn), b = toMinutes(rec && rec.checkOut);
    return a !== null && b !== null && b > a ? b - a : null;
  }
  const fmtHours = mins => (mins === null ? '' : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`);

  /**
   * One row per person for the chosen day: every ACTIVE staff member, plus
   * anyone inactive who nevertheless has a record that day. Sorted by name.
   */
  function dayRows(staff, records, day) {
    const byPerson = new Map(records.filter(r => r.date === day).map(r => [r.staffId, r]));
    const rows = staff.filter(s => s.status === 'Active' || byPerson.has(s.id)).map(s => ({ person: s, record: byPerson.get(s.id) || null }));
    // A record whose person is not on the roster any more is still shown, never hidden.
    for (const [id, r] of byPerson) {
      if (!staff.some(s => s.id === id)) rows.push({ person: { id, name: r.staffName || id, department: r.department, designation: r.designation, status: '' }, record: r });
    }
    return rows.sort((x, y) => String(x.person.name || '').localeCompare(String(y.person.name || ''), undefined, { sensitivity: 'base' })
      || String(x.person.id).localeCompare(String(y.person.id)));
  }

  function filterRows(rows, { search = '', status = 'all', department = 'all' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    return rows.filter(({ person, record }) =>
      (!q || [person.name, person.id, person.employeeCode].some(v => String(v || '').toLowerCase().includes(q)))
      && (status === 'all' || (status === NOT_RECORDED ? !record : (record && record.status === status)))
      && (department === 'all' || (person.department || '') === department));
  }

  /** Records of each status on one day. Only what was recorded is counted. */
  function daySummary(records, day) {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of records) if (r.date === day && out[r.status] !== undefined) out[r.status]++;
    return out;
  }

  /** Per person: recorded days of each status in the loaded month, and in all. */
  function monthSummary(staff, records) {
    const counts = new Map();
    for (const r of records) {
      if (!counts.has(r.staffId)) counts.set(r.staffId, { ...Object.fromEntries(STATUSES.map(s => [s, 0])), total: 0, name: r.staffName });
      const c = counts.get(r.staffId);
      if (c[r.status] !== undefined) { c[r.status]++; c.total++; }
    }
    const people = staff.filter(s => s.status === 'Active' || counts.has(s.id));
    for (const [id, c] of counts) if (!staff.some(s => s.id === id)) people.push({ id, name: c.name || id, status: '' });
    return people.map(p => ({ person: p, counts: counts.get(p.id) || { ...Object.fromEntries(STATUSES.map(s => [s, 0])), total: 0 } }))
      .sort((x, y) => String(x.person.name || '').localeCompare(String(y.person.name || ''), undefined, { sensitivity: 'base' }));
  }

  /** The form's checks, as the Worker makes them. Returns { field: message }. */
  function validateDay(v) {
    const e = {};
    if (!STATUSES.includes(v.status)) e.status = 'Choose a status.';
    const worked = WORKED.includes(v.status);
    if (v.checkIn && !TIME.test(v.checkIn)) e.checkIn = 'Check-in must be a time like 09:30.';
    if (v.checkOut && !TIME.test(v.checkOut)) e.checkOut = 'Check-out must be a time like 09:30.';
    if (!e.status && !worked) {
      if (v.checkIn) e.checkIn = `No check-in time for ${v.status}.`;
      if (v.checkOut) e.checkOut = `No check-out time for ${v.status}.`;
    }
    if (v.checkOut && !e.checkOut && !e.checkIn) {
      if (!v.checkIn) e.checkOut = 'Enter the check-in time first.';
      else if (v.checkOut <= v.checkIn) e.checkOut = 'Check-out must be after check-in.';
    }
    if ((v.notes || '').length > NOTES_MAX) e.notes = `Use at most ${NOTES_MAX} characters.`;
    return e;
  }

  /* ---------- markup ---------- */

  const muted = text => `<span class="att-muted">${esc(text)}</span>`;
  const badge = status => `<span class="badge ${BADGE[status] || 'badge--neutral'}">${esc(status)}</span>`;
  function fmtDay(day) {
    const d = new Date(`${day}T00:00:00Z`);
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}, ${Utils.fmtDate(day)}`;
  }

  function rowHtml({ person, record }, today) {
    const sub = person.designation || (person.isMechanic ? 'Mechanic' : '');
    const inactive = person.status && person.status !== 'Active';
    const action = record
      ? `<button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${esc(record.id)}" aria-label="Edit the attendance of ${esc(person.name)}">${ICON.edit}<span>Edit</span></button>`
      : (inactive ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-action="record" data-id="${esc(person.id)}" aria-label="Record the attendance of ${esc(person.name)}"${today ? '' : ' disabled'}>${ICON.add}<span>Record</span></button>`);
    const mins = minutesWorked(record);
    return `
      <tr data-person="${esc(person.id)}">
        <td data-label="Staff">
          <span class="cell-main">${esc(person.name || person.id)}${inactive ? ' <span class="badge badge--neutral">Inactive</span>' : ''}</span>
          <span class="cell-sub">${esc(person.id)}${sub ? ` · ${esc(sub)}` : ''}</span>
        </td>
        <td data-label="Department">${person.department ? esc(person.department) : muted('—')}</td>
        <td data-label="Status">${record ? badge(record.status) : muted('Not recorded')}${record && record.notes ? `<span class="cell-sub att-notes">${esc(record.notes)}</span>` : ''}</td>
        <td data-label="Check-in" class="stf-nowrap">${record && record.checkIn ? esc(record.checkIn) : muted('—')}</td>
        <td data-label="Check-out" class="stf-nowrap">${record && record.checkOut ? esc(record.checkOut) : muted('—')}</td>
        <td data-label="Hours" class="stf-nowrap">${mins !== null ? esc(fmtHours(mins)) : muted('—')}</td>
        <td data-label="Actions"><div class="row-actions">${action}</div></td>
      </tr>`;
  }

  function monthRowHtml({ person, counts }) {
    const cell = (label, n) => `<td class="num" data-label="${esc(label)}">${n ? n : muted('0')}</td>`;
    return `
      <tr>
        <td data-label="Staff"><span class="cell-main">${esc(person.name || person.id)}</span><span class="cell-sub">${esc(person.id)}</span></td>
        ${STATUSES.map(s => cell(s, counts[s])).join('')}
        <td class="num" data-label="Recorded days"><strong>${counts.total}</strong></td>
      </tr>`;
  }

  function stateRow({ icon = ICON.people, title, text, retry = false, clear = false, signIn = false, tone = 'neutral', cols = COLS }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="att-state-row">
        <td colspan="${cols}">
          <div class="att-state${tone === 'bad' ? ' att-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="att-state__icon">${icon}</span>
            <div class="att-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="att-state__actions">${actions}</p>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  function skeletonRows(n = 4, cols = COLS) {
    const cell = '<td><span class="att-skel"></span></td>';
    return Array.from({ length: n }, () => `<tr class="att-state-row att-skel-row" aria-hidden="true">${cell.repeat(cols)}</tr>`).join('');
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, day: '', month: '', today: '', search: '', status: 'all', department: 'all' };
  const $ = id => document.getElementById(id);
  let debounce = null;
  const staff = () => Storage.getData('staff');
  const records = () => Storage.getData('attendance');

  const CONTROLS = ['attDay', 'attSearch', 'attStatus', 'attDept', 'attClear', 'attRecord'];
  function setControls(enabled) { for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; } }
  function setHtml(id, html, tableId, busy = false) {
    const el = $(id); if (el) el.innerHTML = html;
    const table = $(tableId); if (table && table.setAttribute) table.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  const note = text => { const el = $('attCount'); if (el) el.textContent = text; };
  function setCards(counts) {
    for (const s of STATUSES) { const el = $(`att-${slug(s)}`); if (el) el.textContent = counts ? String(counts[s]) : '—'; }
  }

  function fillFilters() {
    const st = $('attStatus');
    if (st) {
      st.innerHTML = '<option value="all">All statuses</option>' + STATUSES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
        + `<option value="${NOT_RECORDED}">Not recorded</option>`;
      st.value = state.status;
    }
    const dp = $('attDept');
    if (dp) {
      const depts = [...new Set(staff().map(s => s.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (state.department !== 'all' && !depts.includes(state.department)) state.department = 'all';
      dp.innerHTML = '<option value="all">All departments</option>' + depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      dp.value = state.department;
    }
  }

  function render() {
    const all = records();
    const rows = dayRows(staff(), all, state.day);
    const dayCounts = daySummary(all, state.day);
    setCards(dayCounts);
    const label = $('attDayLabel'); if (label) label.textContent = fmtDay(state.day);
    const recorded = rows.filter(r => r.record).length;
    const canRecord = state.day <= state.today;
    if (!rows.length) {
      setHtml('attBody', stateRow({ title: 'No active staff yet', text: 'Add staff in Add Staff first; attendance is recorded for the people on the Staff List.' }), 'attTable');
      note('0 staff');
    } else {
      const shown = filterRows(rows, state);
      setHtml('attBody', shown.length
        ? shown.map(r => rowHtml(r, canRecord)).join('')
        : stateRow({ icon: ICON.search, title: 'No staff match your search or filters', clear: true, text: 'Change or clear the search, status or department filter.' }), 'attTable');
      note(`${shown.length} of ${rows.length} staff · ${recorded} recorded, ${rows.length - recorded} not recorded`);
    }
    const ml = $('attMonthLabel');
    if (ml) ml.textContent = new Date(`${state.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const month = monthSummary(staff(), all);
    setHtml('attMonthBody', month.length ? month.map(monthRowHtml).join('')
      : stateRow({ title: 'No staff to summarise', text: 'Nothing is recorded for this month.', cols: 8 }), 'attMonthTable');
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setControls(false);
    setCards(null);
    note('');
    const label = $('attDayLabel'); if (label) label.textContent = '';
    setHtml('attMonthBody', '', 'attMonthTable');
    let row;
    if (code === 'no_api') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Attendance needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no attendance is shown and none can be recorded.' });
    } else if (code === 'unauthorized') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your session has ended', signIn: true, text: 'Sign in again to see and record attendance. Nothing was changed.' });
    } else if (code === 'forbidden') {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your account cannot see attendance', text: 'Your account is not allowed to see or record attendance.' });
    } else {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Attendance could not be loaded', retry: true,
        text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.' });
    }
    setHtml('attBody', row, 'attTable');
  }

  /** Read the roster (once) and the chosen month's records. */
  async function load({ staffToo = true } = {}) {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    setControls(false);
    note('Loading attendance…');
    setHtml('attBody', skeletonRows(), 'attTable', true);
    setHtml('attMonthBody', skeletonRows(3, 8), 'attMonthTable', true);
    const range = monthRange(state.day);
    const [st, att] = await Promise.all([staffToo ? Storage.load('staff') : Promise.resolve({ ok: true }), Storage.load('attendance', range)]);
    if (!st.ok) { renderUnavailable(st.code); return false; }
    if (!att.ok) { renderUnavailable(att.code); return false; }
    state.month = state.day.slice(0, 7);
    state.loaded = true;
    setControls(true);
    const day = $('attDay'); if (day) { day.value = state.day; day.max = state.today; }
    fillFilters();
    render();
    return true;
  }

  /* ---------- the dialog ---------- */

  function field({ id, label, required = false, html, err, hint = '' }) {
    return `
      <div class="field">
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="att-hint" id="${id}-hint">${esc(hint)}</p>` : ''}
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

  /** Record a day (record = null) or correct an existing record. */
  function openDialog({ person = null, record = null }) {
    if (!state.loaded) return;
    const editing = Boolean(record);
    if (!editing && state.day > state.today) { Utils.toast('Attendance cannot be recorded for a future day.', 'info'); return; }
    let choices = [];
    if (!editing && !person) {
      choices = dayRows(staff(), records(), state.day).filter(r => !r.record && r.person.status === 'Active').map(r => r.person);
      if (!choices.length) {
        Utils.Modal.open({
          title: 'Record Attendance',
          body: `<p>Every active staff member already has a record for ${esc(fmtDay(state.day))}. Use <strong>Edit</strong> on a row to correct one.</p>`,
          footer: '<button type="button" class="btn btn--primary" data-modal-close>OK</button>',
        });
        return;
      }
    }
    const who = editing ? { id: record.staffId, name: record.staffName } : person;
    const v = editing ? record : { status: 'Present', checkIn: '', checkOut: '', notes: '' };
    const staffField = who
      ? `<div class="detail-item"><span>Staff member</span><strong>${esc(who.name || who.id)} (${esc(who.id)})</strong></div>`
      : field({ id: 'att-staff', label: 'Staff member', required: true, err: 'staffId',
        html: `<select class="select" id="att-staff" required aria-required="true" aria-describedby="att-staff-err"><option value="">Choose a staff member</option>${choices.map(s => `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.id)}</option>`).join('')}</select>` });
    const ov = Utils.Modal.open({
      title: editing ? `Edit attendance — ${record.staffName || record.staffId}` : 'Record Attendance',
      size: 'lg',
      body: `
        <form id="attForm" novalidate>
          <p class="att-hint">${esc(fmtDay(editing ? record.date : state.day))}. ${editing
            ? 'The staff member and the day of a record cannot be changed.'
            : 'One record per staff member per day.'}</p>
          <div class="form-grid">
            ${staffField}
            ${field({ id: 'att-status', label: 'Status', required: true, err: 'status',
              html: `<select class="select" id="att-status" required aria-required="true" aria-describedby="att-status-err">${STATUSES.map(s => `<option value="${esc(s)}"${s === v.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>` })}
            ${field({ id: 'att-in', label: 'Check-in', err: 'checkIn', hint: 'Workshop time. Present, Late or Half-day only.',
              html: `<input class="input" type="time" id="att-in" value="${esc(v.checkIn || '')}" aria-describedby="att-in-hint att-in-err">` })}
            ${field({ id: 'att-out', label: 'Check-out', err: 'checkOut', hint: 'After the check-in, the same day.',
              html: `<input class="input" type="time" id="att-out" value="${esc(v.checkOut || '')}" aria-describedby="att-out-hint att-out-err">` })}
            ${field({ id: 'att-notes', label: 'Notes', err: 'notes', hint: `Optional, at most ${NOTES_MAX} characters.`,
              html: `<textarea class="input" id="att-notes" rows="2" maxlength="${NOTES_MAX}" aria-describedby="att-notes-hint att-notes-err">${esc(v.notes || '')}</textarea>` })}
          </div>
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>${editing ? 'Save Changes' : 'Record'}</button>`,
    });
    const form = ov.querySelector('#attForm');
    const status = form.querySelector('#att-status');
    const tin = form.querySelector('#att-in'), tout = form.querySelector('#att-out');
    // Times belong only to a worked day: switch them off (and clear them) for the other statuses.
    const syncTimes = () => {
      const worked = WORKED.includes(status.value);
      for (const t of [tin, tout]) { t.disabled = !worked; if (!worked) t.value = ''; }
    };
    status.addEventListener('change', syncTimes);
    syncTimes();
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const pick = form.querySelector('#att-staff');
      const values = { status: status.value, checkIn: tin.value.trim(), checkOut: tout.value.trim(), notes: form.querySelector('#att-notes').value.trim() };
      const errors = validateDay(values);
      const staffId = who ? who.id : (pick ? pick.value : '');
      if (!editing && !staffId) errors.staffId = 'Choose a staff member.';
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const res = editing
        ? await Storage.update('attendance', record.id, { ...values, expectedUpdatedAt: record.updatedAt })
        : await Storage.create('attendance', { staffId, date: state.day, ...values });
      if (!res.ok && (res.errorReason === 'already_recorded' || res.errorReason === 'concurrent_modification' || res.code === 'not_found')) {
        // Someone else recorded or changed this day meanwhile: show what is there now, never overwrite it.
        Utils.Modal.close();
        Utils.toast(res.message || 'This day was changed meanwhile. The latest records are shown.', 'warning');
        await load({ staffToo: false });
        return;
      }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      Utils.toast(editing ? `The attendance of ${res.record.staffName} was updated.` : `${res.record.staffName}: ${res.record.status} recorded for ${Utils.fmtDate(res.record.date)}.`, 'success');
      render();
    }));
  }

  /* ---------- events ---------- */

  function clearFilters() {
    clearTimeout(debounce);
    Object.assign(state, { search: '', status: 'all', department: 'all' });
    for (const [id, value] of [['attSearch', ''], ['attStatus', 'all'], ['attDept', 'all']]) { const el = $(id); if (el) el.value = value; }
    render();
  }

  function setDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return;
    const sameMonth = value.slice(0, 7) === state.month;
    state.day = value;
    if (sameMonth) render(); else load({ staffToo: false });
  }

  function bindEvents() {
    const search = $('attSearch'), body = $('attBody'), day = $('attDay');
    if (search) search.addEventListener('input', e => {
      const value = String(e.target.value || '').slice(0, 100);
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; render(); }, 200);
    });
    if (day) day.addEventListener('change', e => setDay(String(e.target.value || '')));
    for (const [id, key, ok] of [['attStatus', 'status', v => v === 'all' || v === NOT_RECORDED || STATUSES.includes(v)], ['attDept', 'department', () => true]]) {
      const el = $(id);
      if (el) el.addEventListener('change', e => { const v = String(e.target.value || 'all'); state[key] = ok(v) ? v : 'all'; render(); });
    }
    const clear = $('attClear'), rec = $('attRecord');
    if (clear) clear.addEventListener('click', clearFilters);
    if (rec) rec.addEventListener('click', () => openDialog({}));
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'signin': window.location.reload(); break;
        case 'clear': clearFilters(); break;
        case 'record': { const p = staff().find(s => s.id === id); if (p) openDialog({ person: p }); break; }
        case 'edit': { const r = Storage.getById('attendance', id); if (r) openDialog({ record: r }); break; }
        default: break;
      }
    });
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    state.today = Utils.todayStr();
    state.day = state.today;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return {
    STATUSES, WORKED, NOT_RECORDED,
    monthRange, minutesWorked, fmtHours, dayRows, filterRows, daySummary, monthSummary, validateDay, rowHtml, monthRowHtml,
    load, render, clearFilters, setDay, state,
  };
})();
