/* ============================================================
   staff-performance.js — Staff Management › Performance
   ------------------------------------------------------------
   How the workshop's job cards are getting done, by mechanic.

   Source of truth: the workshop database, and nothing else. In 'api' mode
   every page already holds the job cards and mechanics the app loaded from
   GET /api/job-cards and GET /api/mechanics (Storage.getData); this page
   makes NO request of its own and counts in the browser. In every other
   mode it shows nothing.

   What is counted, and by which timestamp (never mixed):
     Assigned           job cards whose JOB DATE (job_cards.date, a workshop
                        day) is in the period, by job_cards.mechanic_id; each
                        is split by its CURRENT status:
                          Completed / Delivered  Utils.DONE_JOB_STATUSES
                          Open                   Utils.ACTIVE_JOB_STATUSES
                          Cancelled
     Completion rate    Completed / Delivered out of Assigned minus Cancelled
                        ("—" when nothing is left to rate)
     Completed in period  job cards whose COMPLETION TIME (completed_at,
                        stamped by the server on entering Completed) falls in
                        the period, as a workshop day, whatever the job date
     On time            of those, the ones that have an estimated delivery
                        date: completed on or before it ("—" when none has one)

   Rules kept here: every job card is counted once (by id); days are
   Asia/Dhaka; only mechanics are assigned job cards; attendance, pay and
   feedback are not used; no score, weighting or ranking is made. The page
   only READS -- it creates, edits, assigns or deletes nothing, and writes
   nothing to browser storage.
   ============================================================ */

const StaffPerformance = (() => {

  const { esc } = Utils;

  const DONE = Utils.DONE_JOB_STATUSES;                      // Completed, Delivered
  const OPEN = Utils.ACTIVE_JOB_STATUSES;                    // Received ... Waiting for Parts
  const CANCELLED = 'Cancelled';
  const STATUSES = [...OPEN, ...DONE, CANCELLED];            // the job card order
  const PERIODS = ['today', 'last7', 'month', 'lastMonth', 'custom'];
  const PAGE = 25;
  const COLS = 9;
  const JOB_COLS = 6;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    list: svg('M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** A job date or an ISO instant as a workshop day (Asia/Dhaka), 'YYYY-MM-DD'; '' when unreadable. */
  function dhakaDay(value) {
    const s = String(value || '');
    if (DATE.test(s)) return s;
    const d = new Date(s);
    if (!s || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  }

  /** 'YYYY-MM-DD' moved by n days (calendar arithmetic, no time zone involved). */
  function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** The days a period covers, both ends included; { invalid: true } for a custom range that is not one. */
  function periodRange(kind, today, from = '', to = '') {
    switch (kind) {
      case 'today': return { from: today, to: today };
      case 'last7': return { from: addDays(today, -6), to: today };
      case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
      case 'lastMonth': {
        const end = addDays(`${today.slice(0, 8)}01`, -1);
        return { from: `${end.slice(0, 8)}01`, to: end };
      }
      default:
        return DATE.test(from) && DATE.test(to) && from <= to ? { from, to } : { invalid: true };
    }
  }

  const inRange = (day, r) => Boolean(day) && day >= r.from && day <= r.to;
  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
  const groupOf = status => (DONE.includes(status) ? 'done' : OPEN.includes(status) ? 'open' : status === CANCELLED ? 'cancelled' : 'other');

  const blank = () => ({ assigned: 0, open: 0, done: 0, cancelled: 0, completedIn: 0, onTimeEligible: 0, onTime: 0 });

  /**
   * The report for one period. `mechanicId` ('all' or an id) narrows it to one
   * mechanic. Every job card is counted once, by id.
   */
  function summarize(jobs, mechanics, range, { mechanicId = 'all' } = {}) {
    const unique = new Map();
    for (const j of jobs) if (j && j.id && !unique.has(j.id)) unique.set(j.id, j);
    const all = [...unique.values()].filter(j => mechanicId === 'all' || j.mechanicId === mechanicId);

    const byMechanic = new Map();
    const stat = id => { if (!byMechanic.has(id)) byMechanic.set(id, blank()); return byMechanic.get(id); };
    const totals = blank();
    const assignedJobs = [];

    for (const j of all) {
      if (inRange(dhakaDay(j.date), range)) {
        const g = groupOf(j.status);
        for (const s of [stat(j.mechanicId), totals]) { s.assigned += 1; if (g !== 'other') s[g] += 1; }
        assignedJobs.push(j);
      }
      const doneDay = dhakaDay(j.completedAt);
      if (inRange(doneDay, range)) {
        const est = DATE.test(String(j.estDelivery || '')) ? j.estDelivery : '';
        for (const s of [stat(j.mechanicId), totals]) {
          s.completedIn += 1;
          if (est) { s.onTimeEligible += 1; if (doneDay <= est) s.onTime += 1; }
        }
      }
    }

    const known = new Map(mechanics.map(m => [m.id, m]));
    const ids = new Set([
      ...mechanics.filter(m => (mechanicId === 'all' ? m.status === 'Active' : m.id === mechanicId)).map(m => m.id),
      ...byMechanic.keys(),
    ]);
    const rows = [...ids].map(id => {
      const m = known.get(id);
      const s = byMechanic.get(id) || blank();
      return {
        id, name: m ? m.name : 'Unknown mechanic', specialization: m ? m.specialization || '' : '', status: m ? m.status : '',
        ...s, completionRate: rate(s.done, s.assigned - s.cancelled), onTimeRate: rate(s.onTime, s.onTimeEligible),
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    totals.completionRate = rate(totals.done, totals.assigned - totals.cancelled);
    totals.onTimeRate = rate(totals.onTime, totals.onTimeEligible);
    totals.mechanicsWithWork = rows.filter(r => r.assigned || r.completedIn).length;
    totals.activeMechanics = mechanics.filter(m => m.status === 'Active').length;
    assignedJobs.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    return { rows, totals, assignedJobs };
  }

  /** Rows whose name or id holds the search text. */
  function searchRows(rows, q) {
    const needle = String(q || '').trim().toLowerCase();
    return needle ? rows.filter(r => `${r.name} ${r.id}`.toLowerCase().includes(needle)) : rows;
  }

  function pageInfo(total, page) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const p = Math.min(Math.max(1, page), pages);
    return { page: p, pages, from: total ? (p - 1) * PAGE + 1 : 0, to: Math.min(total, p * PAGE) };
  }

  /* ---------- markup ---------- */

  const pct = v => (v === null ? '—' : `${v}%`);
  const fmtDay = day => (day ? Utils.fmtDate(day) : '—');

  function rowHtml(r) {
    return `
      <tr data-id="${esc(r.id)}">
        <td data-label="Mechanic"><span class="cell-main">${esc(r.name)}${r.status === 'Inactive' ? ' <span class="badge badge--neutral">Inactive</span>' : ''}</span><span class="cell-sub">${esc(r.id)}</span></td>
        <td data-label="Specialization">${esc(r.specialization || '—')}</td>
        <td data-label="Assigned" class="num">${r.assigned}</td>
        <td data-label="Open" class="num">${r.open}</td>
        <td data-label="Completed / Delivered" class="num">${r.done}</td>
        <td data-label="Cancelled" class="num">${r.cancelled}</td>
        <td data-label="Completion rate" class="num">${pct(r.completionRate)}</td>
        <td data-label="Completed in period" class="num">${r.completedIn}</td>
        <td data-label="On time" class="num">${r.onTimeEligible ? `${pct(r.onTimeRate)} <span class="cell-sub">${r.onTime} of ${r.onTimeEligible}</span>` : '—'}</td>
      </tr>`;
  }

  function jobRowHtml(j, names) {
    return `
      <tr>
        <td data-label="Job Card"><a href="job-cards.html?view=${encodeURIComponent(j.id)}">${esc(j.id)}</a></td>
        <td data-label="Job Date" class="stf-nowrap">${esc(fmtDay(dhakaDay(j.date)))}</td>
        <td data-label="Mechanic">${esc(names.get(j.mechanicId) || j.mechanicId || '—')}</td>
        <td data-label="Status">${Utils.badge(j.status)}</td>
        <td data-label="Est. Delivery" class="stf-nowrap">${esc(fmtDay(DATE.test(String(j.estDelivery || '')) ? j.estDelivery : ''))}</td>
        <td data-label="Completed" class="stf-nowrap">${esc(fmtDay(dhakaDay(j.completedAt)))}</td>
      </tr>`;
  }

  function stateRow(cols, { icon = ICON.list, title, text, tone = 'neutral', reset = false }) {
    return `
      <tr class="prf-state-row">
        <td colspan="${cols}">
          <div class="prf-state${tone === 'bad' ? ' prf-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="prf-state__icon">${icon}</span>
            <div class="prf-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${reset ? '<p class="prf-state__actions"><button type="button" class="btn btn--ghost btn--sm" data-action="reset">Reset filters</button></p>' : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  /* ---------- the page ---------- */

  const state = { today: '', period: 'month', from: '', to: '', mechanic: 'all', q: '', status: 'all', page: 1, ready: false };
  const $ = id => document.getElementById(id);
  const CONTROLS = ['prfPeriod', 'prfFrom', 'prfTo', 'prfMechanic', 'prfSearch', 'prfClear', 'prfStatus'];
  const setControls = on => { for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !on; } };
  const setBusy = busy => { for (const id of ['prfStats', 'prfTable', 'prfJobsTable']) { const el = $(id); if (el && el.setAttribute) el.setAttribute('aria-busy', busy ? 'true' : 'false'); } };
  const put = (key, value, sub) => { const v = $(`prf-${key}`), s = $(`prf-${key}-sub`); if (v) v.textContent = value; if (s) s.textContent = sub; };
  const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

  function clearCards(sub) { for (const k of ['mechanics', 'assigned', 'done', 'open', 'cancelled', 'ontime']) put(k, '—', sub); }

  function renderUnavailable() {
    setControls(false);
    setBusy(false);
    clearCards('Needs the workshop database');
    const row = cols => stateRow(cols, { icon: ICON.alert, tone: 'bad', title: 'Performance needs the workshop database',
      text: 'This copy of the app is not connected to the workshop database, so no performance is shown.' });
    setHtml('prfBody', row(COLS));
    setHtml('prfJobsBody', row(JOB_COLS));
    setText('prfCount', ''); setText('prfPeriodLabel', ''); setText('prfJobsRange', '');
  }

  function drawCards(t) {
    const one = state.mechanic !== 'all';
    put('mechanics', String(t.mechanicsWithWork), one ? 'The selected mechanic' : `With job cards in the period, of ${t.activeMechanics} active`);
    put('assigned', String(t.assigned), 'Job date in the period');
    put('done', String(t.done), t.completionRate === null ? 'Nothing to rate in the period' : `${t.completionRate}% completion rate (cancelled excluded)`);
    put('open', String(t.open), 'Of the assigned job cards, still open');
    put('cancelled', String(t.cancelled), 'Not counted in the completion rate');
    if (t.onTimeEligible) put('ontime', `${t.onTimeRate}%`, `${t.onTime} of ${t.onTimeEligible} completed in the period with an estimated delivery date`);
    else put('ontime', '—', t.completedIn ? 'No job card completed in the period has an estimated delivery date' : 'No job card was completed in the period');
  }

  /** Recount and redraw everything from the loaded job cards. */
  function draw() {
    const range = periodRange(state.period, state.today, state.from, state.to);
    const err = $('prfRangeError');
    if (err) err.hidden = !range.invalid;
    if (range.invalid) {
      clearCards('The date range is not valid');
      const bad = cols => stateRow(cols, { icon: ICON.search, title: 'The date range is not valid', text: 'Choose a "From" day on or before the "To" day.', reset: true });
      setHtml('prfBody', bad(COLS)); setHtml('prfJobsBody', bad(JOB_COLS));
      setText('prfCount', ''); setText('prfPeriodLabel', ''); setText('prfJobsRange', '');
      for (const id of ['prfJobsPrev', 'prfJobsNext']) { const b = $(id); if (b) b.disabled = true; }
      return null;
    }
    const mechanics = Storage.getData('mechanics');
    const report = summarize(Storage.getData('jobCards'), mechanics, range, { mechanicId: state.mechanic });
    drawCards(report.totals);
    setText('prfPeriodLabel', range.from === range.to ? Utils.fmtDate(range.from) : `${Utils.fmtDate(range.from)} – ${Utils.fmtDate(range.to)}`);

    const rows = searchRows(report.rows, state.q);
    if (!mechanics.length) setHtml('prfBody', stateRow(COLS, { title: 'No mechanics yet', text: 'Job cards are assigned to mechanics. Once mechanics are added on the Mechanics page they appear here.' }));
    else if (!rows.length) setHtml('prfBody', stateRow(COLS, { icon: ICON.search, title: 'No mechanic matches', text: 'Change or clear the search, or choose all mechanics.', reset: true }));
    else setHtml('prfBody', rows.map(rowHtml).join(''));
    setText('prfCount', report.totals.assigned ? `${report.totals.assigned} job card${report.totals.assigned === 1 ? '' : 's'} in the period` : 'No job cards in the period');

    const names = new Map(mechanics.map(m => [m.id, m.name]));
    const jobs = report.assignedJobs.filter(j => state.status === 'all' || j.status === state.status);
    const info = pageInfo(jobs.length, state.page);
    state.page = info.page;
    if (!report.assignedJobs.length) setHtml('prfJobsBody', stateRow(JOB_COLS, { title: 'No job cards in this period', text: 'Job cards whose job date falls in the period appear here.' }));
    else if (!jobs.length) setHtml('prfJobsBody', stateRow(JOB_COLS, { icon: ICON.search, title: 'No job card has this status', text: 'Choose another status, or all statuses.', reset: true }));
    else setHtml('prfJobsBody', jobs.slice(info.from - 1, info.to).map(j => jobRowHtml(j, names)).join(''));
    setText('prfJobsRange', jobs.length ? `Showing ${info.from}–${info.to} of ${jobs.length}` : '');
    const prev = $('prfJobsPrev'), next = $('prfJobsNext');
    if (prev) prev.disabled = info.page <= 1;
    if (next) next.disabled = info.page >= info.pages;
    return report;
  }

  /** Show the period's days in the date inputs (a preset fills them in). */
  function syncDates() {
    const r = periodRange(state.period, state.today, state.from, state.to);
    if (state.period !== 'custom' && !r.invalid) { state.from = r.from; state.to = r.to; }
    const f = $('prfFrom'), t = $('prfTo');
    if (f) f.value = state.from;
    if (t) t.value = state.to;
  }

  function fillFilters() {
    const m = $('prfMechanic');
    if (m) {
      const list = Storage.getData('mechanics').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      m.innerHTML = '<option value="all">All mechanics</option>' + list.map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.id)})${x.status === 'Inactive' ? ' — inactive' : ''}</option>`).join('');
    }
    const s = $('prfStatus');
    if (s) s.innerHTML = '<option value="all">All statuses</option>' + STATUSES.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  }

  function reset() {
    Object.assign(state, { period: 'month', from: '', to: '', mechanic: 'all', q: '', status: 'all', page: 1 });
    for (const [id, v] of [['prfPeriod', 'month'], ['prfMechanic', 'all'], ['prfSearch', ''], ['prfStatus', 'all']]) { const el = $(id); if (el) el.value = v; }
    syncDates();
    return draw();
  }

  /* ---------- events ---------- */

  function bindEvents() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('prfPeriod', 'change', e => { const v = String(e.target.value || ''); state.period = PERIODS.includes(v) ? v : 'month'; state.page = 1; syncDates(); draw(); });
    for (const [id, key] of [['prfFrom', 'from'], ['prfTo', 'to']]) {
      on(id, 'change', e => {
        const v = String(e.target.value || '');
        state[key] = DATE.test(v) ? v : '';
        state.period = 'custom'; state.page = 1;
        const p = $('prfPeriod'); if (p) p.value = 'custom';
        draw();
      });
    }
    on('prfMechanic', 'change', e => { const v = String(e.target.value || 'all'); state.mechanic = v === 'all' || Storage.getById('mechanics', v) ? v : 'all'; state.page = 1; draw(); });
    on('prfStatus', 'change', e => { const v = String(e.target.value || 'all'); state.status = STATUSES.includes(v) ? v : 'all'; state.page = 1; draw(); });
    on('prfSearch', 'input', e => { state.q = String(e.target.value || '').slice(0, 100); draw(); });
    on('prfClear', 'click', reset);
    on('prfJobsPrev', 'click', () => { state.page -= 1; draw(); });
    on('prfJobsNext', 'click', () => { state.page += 1; draw(); });
    const onState = e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      const action = btn ? (btn.dataset ? btn.dataset.action : btn.action) : null;
      if (action === 'reset') reset();
    };
    on('prfBody', 'click', onState);
    on('prfJobsBody', 'click', onState);
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    if (!Storage.isApi()) { renderUnavailable(); return; }
    state.today = dhakaDay(new Date().toISOString());
    fillFilters();
    syncDates();
    bindEvents();
    setControls(true);
    draw();
    setBusy(false);
    state.ready = true;
  }

  Storage.ready(start);

  return { STATUSES, PAGE, dhakaDay, addDays, periodRange, summarize, searchRows, pageInfo, rowHtml, jobRowHtml, draw, reset, state };
})();
