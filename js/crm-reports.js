/* ============================================================
   crm-reports.js — Customer CRM › CRM Reports
   ------------------------------------------------------------
   Four summary figures, a customer activity chart and two detail
   lists (service visits, follow-ups) for a reporting period, with a
   CSV export of the list on screen.

   Source of truth: the workshop database, and nothing else.
     - Vehicles, customers, job cards and staff come from the
       collections the app already loaded through Storage (GET
       /api/vehicles, /customers, /job-cards, /mechanics). Follow-ups
       are read on demand with Storage.load('followUps') (GET
       /api/follow-ups). No endpoint, column or record is added here.
     - Records are shown ONLY when Storage is in 'api' mode. In every
       other mode -- no backend, a backend that failed, a signed-out
       browser -- this page reads nothing, shows nothing and exports
       nothing, so demo data in this browser is never reported.
     - If the follow-ups cannot be read, only the figures that need
       them say so; the reminders, returning customers and service
       visits still come from the data that did load.
     - Nothing is written. The CSV is built in the browser from the
       rows on screen; nothing is stored or sent.

   Rules (also asserted in tests/unit/crm-reports.test.cjs):
     - Reporting timezone: Asia/Dhaka. Date-only columns (job card
       date, due date, next service date) are compared as validated
       YYYY-MM-DD text and never pass through a Date; timestamps
       (createdAt, closedAt) are turned into their Dhaka day first.
       A malformed date is left out and counted, never guessed.
     - Periods are inclusive: Last 7 days = today and the six days
       before; Last 30 days = today and the 29 before; This month = the
       1st of the Dhaka month to today; Custom = From to To, at most
       366 days, From not after To.
     - Service Reminders Due: a CURRENT snapshot (active vehicles whose
       next service date is today or earlier), whatever the period; the
       database keeps only the current next service date, so no past
       period's reminders are reported or charted.
     - Open Follow-ups: every follow-up whose status is Open now,
       whatever the period.
     - Completed Follow-ups: status Completed and closedAt (in Dhaka
       time) inside the period. Cancelled is never counted.
     - Returning Customers: distinct customers with a Completed or
       Delivered job card dated inside the period AND one dated before
       the period began. A visit keeps the customer on its own job
       card. One job card is one visit.
     - Chart: daily buckets up to 31 days, weekly beyond. Series:
       follow-ups open at the end of each bucket (created on or before
       it and not yet completed or cancelled by then -- a follow-up
       counts as open from its creation day until the Dhaka day it was
       closed, either way), follow-ups completed in it, returning
       customers in it. Days after today are not drawn.
     - Lists: Service Visits = job cards dated in the period; Follow-ups
       = follow-ups created, due or closed in the period. Search, status
       filter and pages never change the cards or the chart.
   ============================================================ */

const CrmReports = (() => {

  const { esc } = Utils;

  const DONE = Utils.DONE_JOB_STATUSES;          // Completed, Delivered
  const ACTIVE = Utils.ACTIVE_JOB_STATUSES;      // Received ... Waiting for Parts
  const PAGE_SIZE = 25;
  const MAX_DAYS = 366;
  const DAILY_MAX = 31;
  const PERIODS = ['last7', 'last30', 'month', 'custom'];
  const OUTCOMES = { reached: 'Reached', unreachable: 'Unreachable', callback_requested: 'Callback requested', other: 'Other' };
  const FU_TONE = { 'Open': 'info', 'Completed': 'good', 'Cancelled': 'neutral' };

  /* ---------- dates (the Worker's convention) ---------- */

  let dhakaFormat = null;
  try {
    dhakaFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch (e) { dhakaFormat = null; }

  /** The Dhaka calendar day of an instant, as YYYY-MM-DD ('' if invalid). */
  function dhakaDateOf(value) {
    if (value === null || value === undefined || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d)) return '';
    if (dhakaFormat) return dhakaFormat.format(d);
    // Bangladesh has kept UTC+6 without daylight saving since 2009.
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

  /** Calendar arithmetic on YYYY-MM-DD text, through UTC only (no local timezone). */
  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function daysBetween(from, to) {
    const ms = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((ms(to) - ms(from)) / 86400000);
  }

  /** "14 Oct 2026" for a YYYY-MM-DD date; '—' for anything else. */
  function formatDay(value) {
    if (!isDateOnly(value)) return '—';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function shortDay(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  }

  /**
   * The reporting period. Returns { ok, from, to, days, kind } or
   * { ok: false, error } -- a custom range is checked, never repaired.
   */
  function resolvePeriod(kind, today, from = '', to = '') {
    if (!isDateOnly(today)) return { ok: false, error: 'Today could not be determined.' };
    if (kind === 'last7') return { ok: true, kind, from: addDays(today, -6), to: today, days: 7 };
    if (kind === 'last30') return { ok: true, kind, from: addDays(today, -29), to: today, days: 30 };
    if (kind === 'month') {
      const first = `${today.slice(0, 8)}01`;
      return { ok: true, kind, from: first, to: today, days: daysBetween(first, today) + 1 };
    }
    if (kind !== 'custom') return { ok: false, error: 'Choose a report period.' };
    if (!from || !to) return { ok: false, error: 'Choose both a From and a To date.' };
    if (!isDateOnly(from) || !isDateOnly(to)) return { ok: false, error: 'Enter real calendar dates (YYYY-MM-DD).' };
    if (from > to) return { ok: false, error: 'The From date must be on or before the To date.' };
    const days = daysBetween(from, to) + 1;
    if (days > MAX_DAYS) return { ok: false, error: `Choose a range of at most ${MAX_DAYS} days (this one has ${days}).` };
    return { ok: true, kind, from, to, days };
  }

  const inRange = (day, p) => !!day && day >= p.from && day <= p.to;

  /* ---------- figures ---------- */

  /** Current snapshot of active vehicles' next service dates (never historical). */
  function reminderSnapshot(vehicles, today) {
    const out = { overdue: 0, dueToday: 0, upcoming: 0, due: 0, unreadable: 0 };
    const seen = new Set();
    for (const v of vehicles || []) {
      if (!v || !v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      if (v.status !== 'Active' || !v.nextServiceDate) continue;
      if (!isDateOnly(v.nextServiceDate)) { out.unreadable++; continue; }
      if (v.nextServiceDate < today) out.overdue++;
      else if (v.nextServiceDate === today) out.dueToday++;
      else out.upcoming++;
    }
    out.due = out.overdue + out.dueToday;
    return out;
  }

  /** One normalised record per follow-up (duplicates by id dropped). */
  function normaliseFollowUps(followUps) {
    const seen = new Set();
    const out = [];
    for (const f of followUps || []) {
      if (!f || !f.id || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        f,
        id: String(f.id),
        status: String(f.status || ''),
        createdDay: dhakaDateOf(f.createdAt),
        closedDay: f.closedAt ? dhakaDateOf(f.closedAt) : '',
        dueDate: isDateOnly(f.dueDate) ? f.dueDate : '',
      });
    }
    return out;
  }

  /** Open now (any period) and Completed inside the period (by closedAt in Dhaka). */
  function followUpFigures(followUps, p) {
    const out = { open: 0, completed: 0, unreadable: 0 };
    for (const r of normaliseFollowUps(followUps)) {
      if (r.status === 'Open') out.open++;
      else if (r.status === 'Completed') {
        if (!r.closedDay) out.unreadable++;
        else if (inRange(r.closedDay, p)) out.completed++;
      }
    }
    return out;
  }

  /** Completed / Delivered job cards with a readable date and a customer, once each. */
  function eligibleVisits(jobCards) {
    const seen = new Set();
    const visits = [];
    let unreadable = 0;
    for (const j of jobCards || []) {
      if (!j || !j.id || seen.has(j.id)) continue;
      seen.add(j.id);
      if (!DONE.includes(j.status) || !j.customerId) continue;
      if (!isDateOnly(j.date)) { unreadable++; continue; }
      visits.push({ customerId: String(j.customerId), date: j.date });
    }
    return { visits, unreadable };
  }

  /** Distinct customers with an eligible visit in [from, to] AND one before `from`. */
  function returningIn(visits, from, to) {
    const inside = new Set();
    const before = new Set();
    for (const v of visits) {
      if (v.date < from) before.add(v.customerId);
      else if (v.date <= to) inside.add(v.customerId);
    }
    let returning = 0;
    for (const c of inside) if (before.has(c)) returning++;
    return { returning, withVisit: inside.size };
  }

  function returningCustomers(jobCards, p) {
    const { visits, unreadable } = eligibleVisits(jobCards);
    return { ...returningIn(visits, p.from, p.to), unreadable };
  }

  /* ---------- chart ---------- */

  /** Daily buckets up to 31 days, else 7-day buckets from the start (the last may be shorter). */
  function buckets(p) {
    const size = p.days <= DAILY_MAX ? 1 : 7;
    const out = [];
    for (let start = p.from; start <= p.to; start = addDays(start, size)) {
      const end = addDays(start, size - 1) > p.to ? p.to : addDays(start, size - 1);
      out.push({ from: start, to: end, label: size === 1 ? shortDay(start) : `${shortDay(start)} – ${shortDay(end)}` });
    }
    return { size, list: out };
  }

  /**
   * One point per bucket. A bucket that starts after today has no data
   * (null), and "open at the end" is measured no later than today.
   * A follow-up is open at day `at` if it was created on or before it and
   * is still Open, or was completed / cancelled on a later day. One that is
   * closed but whose close date cannot be read is never counted as open.
   * Follow-up series are null when the follow-ups could not be read.
   */
  function chartSeries({ followUps, jobCards, p, today, followUpsOk = true }) {
    const b = buckets(p);
    const fus = followUpsOk ? normaliseFollowUps(followUps) : [];
    const { visits } = eligibleVisits(jobCards);
    const points = b.list.map(k => {
      if (k.from > today) return { ...k, future: true, open: null, completed: null, returning: null };
      const at = k.to > today ? today : k.to;
      let open = null, completed = null;
      if (followUpsOk) {
        open = 0; completed = 0;
        for (const r of fus) {
          if (!r.createdDay) continue;
          if (r.status === 'Completed' && inRange(r.closedDay, k)) completed++;
          const stillOpen = r.status === 'Open' || (!!r.closedDay && r.closedDay > at);
          if (r.createdDay <= at && stillOpen) open++;
        }
      }
      return { ...k, future: false, open, completed, returning: returningIn(visits, k.from, k.to).returning };
    });
    return { size: b.size, points };
  }

  /* ---------- detail rows ---------- */

  const digitsOf = s => String(s ?? '').replace(/\D/g, '');
  const compactReg = s => String(s ?? '').toLowerCase().replace(/[\s-]/g, '');
  const groupOf = status => DONE.includes(status) ? 'completed' : ACTIVE.includes(status) ? 'pending' : status === 'Cancelled' ? 'cancelled' : 'unknown';

  function lookups({ customers, vehicles, mechanics }) {
    return {
      people: new Map((customers || []).map(c => [c.id, c])),
      cars: new Map((vehicles || []).map(v => [v.id, v])),
      staff: new Map((mechanics || []).map(m => [m.id, m])),
    };
  }
  function vehicleParts(cars, id) {
    const v = id ? cars.get(id) || null : null;
    return { vehicleId: id || '', vehicleKnown: !id || !!v, regNo: v ? String(v.regNo || '') : '',
      vehicleLabel: v ? [v.brand, v.model].filter(Boolean).map(String).join(' ') : '' };
  }

  /** Service Visits: one row per job card dated in the period (any status). */
  function visitRows({ jobCards, customers, vehicles, mechanics, p }) {
    const { people, cars, staff } = lookups({ customers, vehicles, mechanics });
    const seen = new Set();
    const rows = [];
    let unreadable = 0;
    for (const j of jobCards || []) {
      if (!j || !j.id || seen.has(j.id)) continue;
      seen.add(j.id);
      if (!isDateOnly(j.date)) { unreadable++; continue; }
      if (!inRange(j.date, p)) continue;
      const c = people.get(j.customerId) || null;
      const m = j.mechanicId ? staff.get(j.mechanicId) || null : null;
      rows.push({
        id: String(j.id), date: j.date, status: String(j.status || ''), group: groupOf(j.status),
        customerId: j.customerId || '', customerName: c ? String(c.name || '') : '', phoneDigits: c ? digitsOf(c.phone) : '',
        ...vehicleParts(cars, j.vehicleId),
        mechanicId: j.mechanicId || '', mechanicName: m ? String(m.name || '') : '',
      });
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id, 'en', { numeric: true }));
    return { rows, unreadable };
  }

  /** Follow-ups: one row per follow-up created, due or closed in the period. */
  function followUpRows({ followUps, customers, vehicles, p }) {
    const { people, cars } = lookups({ customers, vehicles });
    const rows = [];
    for (const r of normaliseFollowUps(followUps)) {
      if (!(inRange(r.createdDay, p) || inRange(r.dueDate, p) || inRange(r.closedDay, p))) continue;
      const f = r.f;
      const c = people.get(f.customerId) || null;
      rows.push({
        id: r.id, status: r.status, dueDate: r.dueDate, createdDay: r.createdDay, closedDay: r.closedDay,
        reason: String(f.reason || ''), outcome: OUTCOMES[f.lastOutcome] || '',
        customerId: f.customerId || '', customerName: c ? String(c.name || '') : '', phoneDigits: c ? digitsOf(c.phone) : '',
        ...vehicleParts(cars, f.vehicleId),
      });
    }
    rows.sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || '') || b.id.localeCompare(a.id, 'en', { numeric: true }));
    return rows;
  }

  function matchesSearch(r, search) {
    const term = String(search || '').trim().toLowerCase();
    if (!term) return true;
    const hay = [r.id, r.customerName, r.regNo, r.vehicleLabel, r.mechanicName, r.reason, r.status, r.outcome]
      .filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(term)) return true;
    const reg = compactReg(term);
    if (reg && compactReg(r.regNo).includes(reg)) return true;
    if (/^[\d\s+().-]+$/.test(term)) {
      const d = digitsOf(term);
      if (d.length >= 3 && r.phoneDigits.includes(d)) return true;
      if (d.length > 3 && d[0] === '0' && r.phoneDigits.includes(d.slice(1))) return true;
    }
    return false;
  }

  /** Visits: status = all | completed | pending | cancelled. Follow-ups: all | Open | Completed | Cancelled. */
  function filterRows(rows, tab, { search = '', status = 'all' } = {}) {
    return rows.filter(r => {
      if (status !== 'all') {
        if (tab === 'visits' && r.group !== status) return false;
        if (tab === 'followUps' && r.status !== status) return false;
      }
      return matchesSearch(r, search);
    });
  }

  function paginate(list, page = 1, size = PAGE_SIZE) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
    const start = total ? (current - 1) * size : 0;
    const items = list.slice(start, start + size);
    return { page: current, pages, total, items, from: total ? start + 1 : 0, to: start + items.length };
  }

  /* ---------- CSV ---------- */

  const unknownName = (id, what) => (id ? `Unknown ${what} (${id})` : '');
  const CSV_COLUMNS = {
    visits: [
      ['Service Date', r => r.date], ['Job Card', r => r.id], ['Status', r => r.status],
      ['Customer', r => r.customerName || unknownName(r.customerId, 'customer')],
      ['Registration', r => r.regNo || (r.vehicleKnown ? '' : unknownName(r.vehicleId, 'vehicle'))], ['Vehicle', r => r.vehicleLabel],
      ['Mechanic', r => r.mechanicName || unknownName(r.mechanicId, 'staff')],
    ],
    followUps: [
      ['Follow-up', r => r.id], ['Customer', r => r.customerName || unknownName(r.customerId, 'customer')],
      ['Registration', r => r.regNo || (r.vehicleKnown ? '' : unknownName(r.vehicleId, 'vehicle'))], ['Vehicle', r => r.vehicleLabel],
      ['Reason', r => r.reason], ['Due Date', r => r.dueDate], ['Status', r => r.status], ['Last Outcome', r => r.outcome],
      ['Created', r => r.createdDay], ['Closed', r => r.closedDay],
    ],
  };

  /** One CSV cell: formula-like text is neutralised, then the cell is quoted. */
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    // A spreadsheet treats a cell starting with = + - @ (after any leading
    // whitespace or control characters), or with a tab / carriage return, as
    // a formula; a leading apostrophe makes it plain text.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  /** The whole file (UTF-8 BOM, CRLF), or null when there is nothing to export. */
  function buildCsv(tab, rows) {
    const cols = CSV_COLUMNS[tab];
    if (!cols || !rows || !rows.length) return null;
    const lines = [cols.map(c => csvCell(c[0])).join(',')];
    for (const r of rows) lines.push(cols.map(c => csvCell(c[1](r))).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function csvFilename(tab, p) {
    return `crm-report-${tab === 'visits' ? 'service-visits' : 'follow-ups'}-${p.from}_to_${p.to}.csv`;
  }

  /* ---------- rendering ---------- */

  const ICON = {
    list: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M7.5 21H2V9h5.5v12zm7.25-18h-5.5v18h5.5V3zM22 11h-5.5v10H22V11z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>',
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>',
  };
  const badge = (tone, text) => `<span class="badge badge--${tone}">${esc(text)}</span>`;
  const JOB_TONE = { completed: 'good', pending: 'neutral', cancelled: 'bad', unknown: 'neutral' };

  const COLUMNS = {
    visits: ['Customer', 'Vehicle', 'Service Date', 'Job Card / Status', 'Mechanic', 'Actions'],
    followUps: ['Customer', 'Vehicle', 'Reason', 'Due Date', 'Status', 'Last Outcome', 'Created'],
  };
  const STATUS_OPTIONS = {
    visits: [['all', 'All Statuses'], ['completed', 'Completed'], ['pending', 'Pending'], ['cancelled', 'Cancelled']],
    followUps: [['all', 'All Statuses'], ['Open', 'Open'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']],
  };

  function customerCell(r) {
    if (r.customerName) return esc(r.customerName);
    return r.customerId ? `<span class="crp-unknown">Unknown customer (${esc(r.customerId)})</span>` : '<span class="crp-muted">—</span>';
  }
  function vehicleCell(r) {
    if (!r.vehicleId) return '<span class="crp-muted">—</span>';
    if (!r.vehicleKnown) return `<span class="crp-unknown">Unknown vehicle (${esc(r.vehicleId)})</span>`;
    return `${esc(r.regNo || '—')}${r.vehicleLabel ? `<span class="cell-sub">${esc(r.vehicleLabel)}</span>` : ''}`;
  }

  function visitRowHtml(r) {
    return `
      <tr data-id="${esc(r.id)}">
        <td data-label="Customer" class="cell-main">${customerCell(r)}</td>
        <td data-label="Vehicle">${vehicleCell(r)}</td>
        <td data-label="Service Date">${esc(formatDay(r.date))}</td>
        <td data-label="Job Card / Status" class="crp-nowrap">${esc(r.id)}<span class="cell-sub">${badge(JOB_TONE[r.group], r.status || 'Unknown')}</span></td>
        <td data-label="Mechanic">${r.mechanicName ? esc(r.mechanicName) : r.mechanicId ? `<span class="crp-unknown">Unknown staff (${esc(r.mechanicId)})</span>` : '<span class="crp-muted">—</span>'}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a class="icon-btn icon-btn--sm" href="job-cards.html?view=${encodeURIComponent(r.id)}" title="Open job card" aria-label="Open job card ${esc(r.id)}">${ICON.view}</a>
          </div>
        </td>
      </tr>`;
  }

  function followUpRowHtml(r) {
    return `
      <tr data-id="${esc(r.id)}">
        <td data-label="Customer" class="cell-main">${customerCell(r)}<span class="cell-sub">${esc(r.id)}</span></td>
        <td data-label="Vehicle">${vehicleCell(r)}</td>
        <td data-label="Reason" class="crp-reason">${esc(r.reason)}</td>
        <td data-label="Due Date">${esc(formatDay(r.dueDate))}</td>
        <td data-label="Status">${badge(FU_TONE[r.status] || 'neutral', r.status || 'Unknown')}</td>
        <td data-label="Last Outcome">${r.outcome ? esc(r.outcome) : '<span class="crp-muted">None</span>'}</td>
        <td data-label="Created">${esc(formatDay(r.createdDay))}</td>
      </tr>`;
  }

  function stateRow(cols, { icon = ICON.list, title, text, retry = false, clear = false, tone = 'neutral', label = '' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="crp-empty-row">
        <td colspan="${cols}">
          <div class="crp-empty${tone === 'bad' ? ' crp-empty--bad' : ''}">
            <span class="crp-empty__icon">${icon}</span>
            <div class="crp-empty__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="crp-actions">${actions}</p>` : ''}
            </div>
            ${label ? `<span class="badge badge--${tone === 'bad' ? 'bad' : 'neutral'} crp-empty__status">${esc(label)}</span>` : ''}
          </div>
        </td>
      </tr>`;
  }

  const SERIES = [['open', 'info', 'Open follow-ups'], ['completed', 'good', 'Completed follow-ups'], ['returning', 'navy', 'Returning customers']];

  function chartHtml(series) {
    const values = [];
    for (const pt of series.points) for (const [k] of SERIES) if (typeof pt[k] === 'number') values.push(pt[k]);
    const max = Math.max(1, ...values);
    return `<div class="crp-bars crp-bars--${series.points.length > 16 ? 'dense' : 'wide'}">${series.points.map(pt => `
      <div class="crp-bars__group${pt.future ? ' crp-bars__group--future' : ''}">
        <div class="crp-bars__plot">${SERIES.map(([k, tone, name]) => {
          const v = pt[k];
          if (typeof v !== 'number') return `<span class="crp-bar crp-bar--none" role="img" aria-label="${esc(`${pt.label}: ${name} not available`)}"></span>`;
          // A zero draws nothing (no stub bar that could be read as a value); the label still says 0.
          const style = v > 0 ? ` style="height:${Math.round(v / max * 100)}%"` : '';
          return `<span class="crp-bar crp-bar--${v > 0 ? tone : 'zero'}"${style} role="img" aria-label="${esc(`${pt.label}: ${name} ${v}`)}" title="${esc(`${name}: ${v}`)}"></span>`;
        }).join('')}</div>
        <span class="crp-bars__label">${esc(pt.label)}</span>
      </div>`).join('')}</div>`;
  }

  function chartTableHtml(series) {
    const cell = v => (typeof v === 'number' ? String(v) : 'n/a');
    return `<table class="table crp-chart-table">
      <thead><tr><th scope="col">${series.size === 1 ? 'Day' : 'Week'}</th>${SERIES.map(s => `<th scope="col">${esc(s[2])}</th>`).join('')}</tr></thead>
      <tbody>${series.points.map(pt => `<tr><th scope="row">${esc(pt.label)}</th>${pt.future ? '<td colspan="3">No data yet (after today)</td>' : SERIES.map(([k]) => `<td>${cell(pt[k])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  /* ---------- the page ---------- */

  const state = {
    ready: false, followUpsOk: false, followUpsLoading: false,
    kind: 'last30', from: '', to: '', period: null,
    tab: 'visits', search: '', status: 'all', page: 1,
    rows: { visits: [], followUps: [] }, unreadable: { visits: 0 },
  };
  const $ = id => document.getElementById(id);
  let debounce = null;

  const CONTROLS = ['crpPeriodKind', 'crpTabVisits', 'crpTabFollowUps', 'crpSearch', 'crpStatus', 'crpClear'];
  function setControls(enabled) {
    for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; }
    const custom = enabled && state.kind === 'custom';
    for (const id of ['crpFrom', 'crpTo']) { const el = $(id); if (el) el.disabled = !custom; }
    if (!enabled) { const ex = $('crpExport'); if (ex) ex.disabled = true; }
  }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
  function setHtml(id, html) { const el = $(id); if (el) el.innerHTML = html; }
  const DASH = '<span aria-hidden="true">&#8212;</span>';
  function setCard(id, value, sub) {
    setHtml(id, value === null ? DASH : esc(String(value)));
    setText(`${id}Sub`, sub);
  }

  function setRangeError(message) {
    const el = $('crpRangeError');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function periodText(p, today) {
    const span = p.from === p.to ? formatDay(p.from) : `${formatDay(p.from)} – ${formatDay(p.to)}`;
    return `${span} · ${p.days} day${p.days === 1 ? '' : 's'} · Asia/Dhaka${p.to > today ? ' · includes days after today' : ''}`;
  }

  /** Cards, chart and rows for the current period (cards ignore the list's search, filter and page). */
  function recompute() {
    const today = dhakaToday();
    const p = state.period;
    const jobCards = Storage.getData('jobCards');
    const followUps = state.followUpsOk ? Storage.getData('followUps') : [];

    const rem = reminderSnapshot(Storage.getData('vehicles'), today);
    setCard('crpReminders', rem.due,
      `Current snapshot as of ${formatDay(today)}: ${rem.overdue} overdue, ${rem.dueToday} due today, ${rem.upcoming} upcoming` +
      `${p.to < today ? ' (not a figure for the selected period)' : ''}${rem.unreadable ? `; ${rem.unreadable} unreadable date${rem.unreadable === 1 ? '' : 's'} left out` : ''}`);

    if (state.followUpsOk) {
      const fu = followUpFigures(followUps, p);
      setCard('crpOpen', fu.open, 'All follow-ups open now, whatever the period');
      setCard('crpCompleted', fu.completed, `Completed within the period (by completion date)${fu.unreadable ? `; ${fu.unreadable} without a readable completion date left out` : ''}`);
    } else {
      const why = state.followUpsLoading ? 'Loading…' : 'Unavailable: follow-ups could not be loaded';
      setCard('crpOpen', null, why);
      setCard('crpCompleted', null, why);
    }

    const ret = returningCustomers(jobCards, p);
    setCard('crpReturning', ret.returning,
      `Of ${ret.withVisit} customer${ret.withVisit === 1 ? '' : 's'} with a completed visit in the period, also served before it` +
      `${ret.unreadable ? `; ${ret.unreadable} unreadable date${ret.unreadable === 1 ? '' : 's'} left out` : ''}`);

    const series = chartSeries({ followUps, jobCards, p, today, followUpsOk: state.followUpsOk });
    const anyValue = series.points.some(pt => SERIES.some(([k]) => typeof pt[k] === 'number' && pt[k] > 0));
    setText('crpChartCaption', `${series.size === 1 ? 'Daily' : 'Weekly'} · ${periodText(p, today)}` +
      `${state.followUpsOk ? '' : ' · follow-up series unavailable'} · Service reminders are a current snapshot and are not charted.`);
    setHtml('crpChart', anyValue ? chartHtml(series) : `
      <div class="crp-chart__empty">
        <span class="crp-chart__icon">${ICON.chart}</span>
        <h3>No activity in this period</h3>
        <p>${state.followUpsOk
          ? 'No follow-up was open or completed and no returning customer was served in the selected period.'
          : 'No returning customer was served in the selected period. The follow-up series are unavailable because the follow-ups could not be loaded.'}</p>
      </div>`);
    setHtml('crpChartTable', chartTableHtml(series));
    const data = $('crpChartData'); if (data) data.hidden = false;

    const v = visitRows({ jobCards, customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'), mechanics: Storage.getData('mechanics'), p });
    state.rows.visits = v.rows;
    state.unreadable.visits = v.unreadable;
    state.rows.followUps = state.followUpsOk
      ? followUpRows({ followUps, customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'), p }) : [];
    renderList();
  }

  function setHead() {
    setHtml('crpHeadRow', `<tr>${COLUMNS[state.tab].map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`);
    const status = $('crpStatus');
    if (status) {
      status.innerHTML = STATUS_OPTIONS[state.tab].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      status.value = state.status;
    }
    for (const [id, tab] of [['crpTabVisits', 'visits'], ['crpTabFollowUps', 'followUps']]) {
      const el = $(id);
      if (!el) continue;
      const on = state.tab === tab;
      if (el.classList) el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.setAttribute('tabindex', on ? '0' : '-1');
    }
    const panel = $('crpPanel'); if (panel) panel.setAttribute('aria-labelledby', state.tab === 'visits' ? 'crpTabVisits' : 'crpTabFollowUps');
    const search = $('crpSearch');
    if (search) search.setAttribute('placeholder', state.tab === 'visits' ? 'Search customer, vehicle, job card or mechanic…' : 'Search customer, vehicle or reason…');
  }

  function setPager(pg) {
    const pager = $('crpPager');
    if (pager) pager.hidden = !pg || pg.total === 0;
    if (!pg || !pg.total) return;
    setText('crpPageRange', `${pg.from}–${pg.to} of ${pg.total}`);
    const prev = $('crpPrev'), next = $('crpNext');
    if (prev) prev.disabled = pg.page <= 1;
    if (next) next.disabled = pg.page >= pg.pages;
  }

  function currentRows() { return filterRows(state.rows[state.tab], state.tab, state); }

  function renderList() {
    setHead();
    const cols = COLUMNS[state.tab].length;
    const body = $('crpBody');
    const exportBtn = $('crpExport');
    const done = (html, pg, note) => {
      if (body) body.innerHTML = html;
      setPager(pg);
      setText('crpListNote', note);
      if (exportBtn) exportBtn.disabled = !(pg && pg.total);
    };
    const noun = state.tab === 'visits' ? 'service visit' : 'follow-up';
    if (state.tab === 'followUps' && !state.followUpsOk) {
      done(stateRow(cols, state.followUpsLoading
        ? { title: 'Loading follow-ups…', text: 'Reading follow-ups from the workshop database.' }
        : { icon: ICON.alert, tone: 'bad', label: 'Unavailable', retry: true, title: 'Follow-ups could not be loaded',
            text: 'The workshop database did not answer for follow-ups, so none are listed or exported. The other figures on this page are unaffected.' }),
      null, state.followUpsLoading ? 'Loading follow-ups…' : 'Follow-ups unavailable');
      return;
    }
    const all = state.rows[state.tab];
    const skipped = state.tab === 'visits' && state.unreadable.visits
      ? ` · ${state.unreadable.visits} job card${state.unreadable.visits === 1 ? '' : 's'} with an unreadable date left out` : '';
    if (!all.length) {
      done(stateRow(cols, { title: `No ${noun}s in this period`,
        text: state.tab === 'visits'
          ? 'No job card is dated within the selected period. Choose another period to see more.'
          : 'No follow-up was created, due or closed within the selected period. Choose another period to see more.' }),
      null, `0 ${noun}s${skipped}`);
      return;
    }
    const shown = currentRows();
    if (!shown.length) {
      done(stateRow(cols, { icon: ICON.search, clear: true, title: `No ${noun}s match your search or filter`,
        text: 'Change or clear the search and status filter to see more.' }),
      null, `No matches among ${all.length} ${noun}${all.length === 1 ? '' : 's'}${skipped}`);
      return;
    }
    const pg = paginate(shown, state.page);
    state.page = pg.page;
    const rowHtml = state.tab === 'visits' ? visitRowHtml : followUpRowHtml;
    done(pg.items.map(rowHtml).join(''), pg,
      `Showing ${pg.from}–${pg.to} of ${pg.total} ${noun}${pg.total === 1 ? '' : 's'}${shown.length === all.length ? '' : ` · filtered from ${all.length}`}${skipped}`);
  }

  function renderUnavailable(outcome) {
    const noBackend = outcome && outcome.reason === 'no_api';
    state.ready = false;
    setControls(false);
    for (const id of ['crpReminders', 'crpOpen', 'crpCompleted', 'crpReturning']) setCard(id, null, 'Unavailable');
    setText('crpPeriod', 'The report period is unavailable until the workshop data loads.');
    setText('crpChartCaption', 'Unavailable');
    setHtml('crpChart', `
      <div class="crp-chart__empty">
        <span class="crp-chart__icon">${ICON.chart}</span>
        <h3>No chart without the workshop database</h3>
        <p>Nothing stored in this browser is charted in its place.</p>
      </div>`);
    const data = $('crpChartData'); if (data) data.hidden = true;
    setPager(null);
    setText('crpListNote', 'Search, filters and export are unavailable until the report loads.');
    setHtml('crpBody', stateRow(COLUMNS[state.tab].length, {
      icon: ICON.alert, tone: 'bad', label: 'Unavailable', retry: !noBackend,
      title: noBackend ? 'CRM Reports need the workshop database' : 'CRM Reports could not be loaded',
      text: noBackend
        ? 'This copy of the app is not connected to the workshop database, so nothing is reported or exported.'
        : 'The workshop database did not answer, so nothing is reported or exported. Nothing stored in this browser is used in its place.',
    }));
  }

  /** Apply the period controls; an invalid custom range keeps the last valid report. */
  function applyPeriod() {
    const today = dhakaToday();
    const p = resolvePeriod(state.kind, today, state.from, state.to);
    if (!p.ok) {
      setRangeError(p.error);
      return false;
    }
    setRangeError('');
    state.period = p;
    state.page = 1;
    setText('crpPeriod', periodText(p, today));
    if (state.kind !== 'custom') {
      state.from = p.from; state.to = p.to;
      const f = $('crpFrom'), t = $('crpTo');
      if (f) f.value = p.from;
      if (t) t.value = p.to;
    }
    recompute();
    return true;
  }

  async function loadFollowUps() {
    state.followUpsLoading = true;
    state.followUpsOk = false;
    if (state.period) recompute();
    const res = await Storage.load('followUps');
    state.followUpsLoading = false;
    state.followUpsOk = !!(res && res.ok);
    if (state.period) recompute();
    return state.followUpsOk;
  }

  async function load(outcome) {
    if (!Storage.isApi()) { renderUnavailable(outcome || { reason: 'no_api' }); return false; }
    state.ready = true;
    setControls(true);
    applyPeriod();
    await loadFollowUps();
    return true;
  }

  /** Download the filtered rows of the open tab. Returns the file name, or null (nothing created). */
  function exportCsv() {
    if (!state.ready || !state.period) return null;
    if (state.tab === 'followUps' && !state.followUpsOk) return null;
    const csv = buildCsv(state.tab, currentRows());
    if (!csv) { Utils.toast('There are no rows to export.', 'info'); return null; }
    const name = csvFilename(state.tab, state.period);
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      Utils.toast('The CSV file could not be created.', 'error');
      return null;
    }
    return name;
  }

  /* ---------- events ---------- */

  function clearFilters() {
    clearTimeout(debounce);
    state.search = ''; state.status = 'all'; state.page = 1;
    const s = $('crpSearch'); if (s) s.value = '';
    renderList();
  }

  function setTab(tab) {
    if (tab !== 'visits' && tab !== 'followUps') return;
    if (state.tab === tab) return;
    clearTimeout(debounce);
    state.tab = tab; state.status = 'all'; state.page = 1;
    renderList();
  }

  function bindEvents() {
    const kind = $('crpPeriodKind'), from = $('crpFrom'), to = $('crpTo');
    if (kind) kind.addEventListener('change', e => {
      state.kind = PERIODS.includes(e.target.value) ? e.target.value : 'last30';
      setControls(state.ready);
      applyPeriod();
    });
    const onRange = () => {
      state.from = String((from && from.value) || '');
      state.to = String((to && to.value) || '');
      applyPeriod();
    };
    if (from) from.addEventListener('change', onRange);
    if (to) to.addEventListener('change', onRange);
    const search = $('crpSearch'), status = $('crpStatus');
    if (search) search.addEventListener('input', e => {
      const value = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; state.page = 1; renderList(); }, 200);
    });
    if (status) status.addEventListener('change', e => {
      const allowed = STATUS_OPTIONS[state.tab].map(o => o[0]);
      state.status = allowed.includes(e.target.value) ? e.target.value : 'all';
      state.page = 1;
      renderList();
    });
    const clear = $('crpClear'); if (clear) clear.addEventListener('click', clearFilters);
    const exp = $('crpExport'); if (exp) exp.addEventListener('click', () => exportCsv());
    const prev = $('crpPrev'), next = $('crpNext');
    if (prev) prev.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderList(); });
    if (next) next.addEventListener('click', () => { state.page += 1; renderList(); });
    for (const id of ['crpTabVisits', 'crpTabFollowUps']) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('click', () => setTab(id === 'crpTabVisits' ? 'visits' : 'followUps'));
      el.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        if (e.preventDefault) e.preventDefault();
        const next = state.tab === 'visits' ? 'followUps' : 'visits';
        const target = e.key === 'Home' ? 'visits' : e.key === 'End' ? 'followUps' : next;
        setTab(target);
        const focus = $(target === 'visits' ? 'crpTabVisits' : 'crpTabFollowUps');
        if (focus && focus.focus) focus.focus();
      });
    }
    const body = $('crpBody');
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      if (action === 'clear') clearFilters();
      else if (action === 'retry') { if (state.ready) loadFollowUps(); else location.reload(); }
    });
  }

  function start(outcome) {
    // Signed out: the sign-in screen covers the window and the app reloads
    // after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    bindEvents();
    load(outcome);
  }

  Storage.ready(start);

  return {
    PAGE_SIZE, MAX_DAYS,
    dhakaToday, dhakaDateOf, isDateOnly, addDays, resolvePeriod,
    reminderSnapshot, followUpFigures, returningCustomers, buckets, chartSeries,
    visitRows, followUpRows, matchesSearch, filterRows, paginate,
    csvCell, buildCsv, csvFilename, exportCsv,
    load, loadFollowUps, applyPeriod, renderList, setTab, clearFilters, state,
  };
})();
