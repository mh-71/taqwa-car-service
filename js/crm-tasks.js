/* ============================================================
   crm-tasks.js — Customer CRM › Follow-up Tasks
   ------------------------------------------------------------
   Workshop tasks: a title, an optional customer / vehicle / job card
   they are about, an optional staff member (mechanic) they are
   assigned to, a priority and a due date; started, completed or
   cancelled through the Worker's own actions.

   Source of truth: the workshop database, and nothing else.
     - Tasks are read on demand through Storage.load('followUpTasks')
       (GET /api/follow-up-tasks), ONLY when Storage is in 'api' mode.
       They are not part of the app-wide hydration, so if they cannot
       be read this page says so and every other page is unaffected.
     - In every other mode -- no backend, a backend that failed, a
       signed-out browser -- this page reads nothing and writes nothing.
     - Customer, vehicle, job card and staff names come from the
       collections the app already loaded. A task whose reference is
       missing shows its id and "Unknown", never an invented name.
     - The Worker re-checks every field, every reference and every
       status change; the checks here only spare a round trip.

   Rules (also asserted in tests/unit/crm-tasks.test.cjs):
     - "Today" is the Asia/Dhaka calendar day, as in the Worker.
     - Open = Pending or In Progress. Due Today / Overdue apply to open
       tasks only; a Completed or Cancelled task is never overdue.
     - Cards: Total = every task except Cancelled; Due Today and Overdue
       = open tasks; Completed = Completed. They always count the whole
       list, never the filtered or paged one.
     - A create carries an idempotency key made when its dialog opens;
       after an answer that does not say whether the server saved it,
       the form freezes and Retry resends the SAME key and payload. An
       edit carries the version it was made from (expectedUpdatedAt).
   ============================================================ */

const CrmTasks = (() => {

  const { esc } = Utils;

  /* Field limits: the Worker's (src/routes/follow-up-tasks.js LIMITS) and the
     schema's CHECKs (0006) use the same numbers. */
  const LIMITS = { title: 150, description: 2000, note: 500, reason: 500, name: 100 };

  const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
  const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
  const PRIORITY_TONE = { low: 'neutral', medium: 'info', high: 'warn', urgent: 'bad' };
  const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
  const STATUS_TONE = { 'Pending': 'neutral', 'In Progress': 'info', 'Completed': 'good', 'Cancelled': 'neutral' };
  const OPEN = ['Pending', 'In Progress'];
  const STATUS_FILTERS = ['all', 'Pending', 'In Progress', 'Completed', 'overdue', 'Cancelled'];
  const PAGE_SIZE = 25;

  /* ---------- dates (the Worker's convention) ---------- */

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

  /* ---------- the task list ---------- */

  const isOpen = t => !!t && OPEN.includes(t.status);
  /** 'overdue' | 'today' | '' for an open task; '' for any closed one. */
  function dueState(t, today) {
    if (!isOpen(t) || !isDateOnly(t.dueDate)) return '';
    if (t.dueDate < today) return 'overdue';
    if (t.dueDate === today) return 'today';
    return '';
  }

  /** The four cards, over the WHOLE list (never the filtered or paged one). */
  function kpis(tasks, today) {
    const out = { total: 0, dueToday: 0, overdue: 0, completed: 0 };
    for (const t of tasks || []) {
      if (!t || t.status === 'Cancelled') continue;
      out.total++;
      if (t.status === 'Completed') out.completed++;
      const d = dueState(t, today);
      if (d === 'today') out.dueToday++;
      if (d === 'overdue') out.overdue++;
    }
    return out;
  }

  const digitsOf = s => String(s ?? '').replace(/\D/g, '');
  const compactReg = s => String(s ?? '').toLowerCase().replace(/[\s-]/g, '');

  /** One row per task, with the names it refers to. Pure. */
  function buildRows({ tasks, customers, vehicles, jobCards, mechanics, today }) {
    const people = new Map((customers || []).map(c => [c.id, c]));
    const cars = new Map((vehicles || []).map(v => [v.id, v]));
    const jobs = new Map((jobCards || []).map(j => [j.id, j]));
    const staff = new Map((mechanics || []).map(m => [m.id, m]));
    const seen = new Set();
    const rows = [];
    for (const t of tasks || []) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      const c = t.customerId ? people.get(t.customerId) || null : null;
      const v = t.vehicleId ? cars.get(t.vehicleId) || null : null;
      const m = t.assignedTo ? staff.get(t.assignedTo) || null : null;
      rows.push({
        id: String(t.id),
        task: t,
        title: String(t.title || ''),
        description: String(t.description || ''),
        customerId: t.customerId || '',
        customerName: c ? String(c.name || '') : '',
        phoneDigits: c ? digitsOf(c.phone) : '',
        vehicleId: t.vehicleId || '',
        vehicleKnown: !t.vehicleId || !!v,
        vehicleLabel: v ? [v.brand, v.model].filter(Boolean).map(String).join(' ') : '',
        regNo: v ? String(v.regNo || '') : '',
        jobCardId: t.jobCardId || '',
        jobKnown: !t.jobCardId || jobs.has(t.jobCardId),
        assignedTo: t.assignedTo || '',
        staffName: m ? String(m.name || '') : '',
        priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
        dueDate: t.dueDate,
        status: String(t.status || ''),
        open: isOpen(t),
        due: dueState(t, today),
        closedAt: t.completedAt || t.cancelledAt || '',
      });
    }
    return rows;
  }

  /**
   * Deterministic order: open tasks first, soonest due first (so overdue ones
   * lead), the more urgent first on the same day, then id; closed tasks after,
   * most recently closed first, then id.
   */
  function sortRows(rows) {
    const byId = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true });
    return rows.slice().sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      if (a.open) {
        const d = String(a.dueDate).localeCompare(String(b.dueDate));
        if (d) return d;
        const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        return p || byId(a, b);
      }
      const c = String(b.closedAt).localeCompare(String(a.closedAt));
      return c || byId(a, b);
    });
  }

  /** Does a row match the search? Task, customer, phone digits, registration, vehicle, job card, staff. */
  function matchesSearch(r, search) {
    const term = String(search || '').trim().toLowerCase();
    if (!term) return true;
    const hay = [r.title, r.description, r.id, r.customerName, r.regNo, r.vehicleLabel, r.jobCardId, r.staffName]
      .join(' ').toLowerCase();
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

  /**
   * Status ('all' = everything except Cancelled; 'overdue' = open and past due;
   * otherwise the exact status), priority, staff ('all' | 'none' | a mechanic
   * id), due by (on or before a real date; an unreadable one is ignored) and
   * search.
   */
  function filterRows(rows, { search = '', status = 'all', priority = 'all', staff = 'all', dueBy = '' } = {}) {
    const by = isDateOnly(dueBy) ? dueBy : '';
    return rows.filter(r => {
      if (status === 'all' && r.status === 'Cancelled') return false;
      if (status === 'overdue' && r.due !== 'overdue') return false;
      if (status !== 'all' && status !== 'overdue' && r.status !== status) return false;
      if (priority !== 'all' && r.priority !== priority) return false;
      if (staff === 'none' && r.assignedTo) return false;
      if (staff !== 'all' && staff !== 'none' && r.assignedTo !== staff) return false;
      if (by && !(isDateOnly(r.dueDate) && r.dueDate <= by)) return false;
      return matchesSearch(r, search);
    });
  }

  /** One page of `list`; the page number is clamped into range. */
  function paginate(list, page = 1, size = PAGE_SIZE) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
    const start = total ? (current - 1) * size : 0;
    const items = list.slice(start, start + size);
    return { page: current, pages, total, items, from: total ? start + 1 : 0, to: start + items.length };
  }

  /* ---------- validation (the Worker re-checks everything) ---------- */

  const blank = v => String(v ?? '').trim() === '';
  const tooLong = (v, max) => String(v ?? '').trim().length > max;

  function validateTask(v) {
    const e = {};
    if (blank(v.title)) e.title = 'Enter a short title for the task.';
    else if (tooLong(v.title, LIMITS.title)) e.title = `Keep the title to ${LIMITS.title} characters or fewer.`;
    if (tooLong(v.description, LIMITS.description)) e.description = `Keep the description to ${LIMITS.description} characters or fewer.`;
    if (!blank(v.vehicleId) && blank(v.customerId)) e.vehicleId = 'Choose the customer before choosing a vehicle.';
    if (!blank(v.jobCardId) && blank(v.customerId)) e.jobCardId = 'Choose the customer before choosing a job card.';
    if (!PRIORITIES.includes(v.priority)) e.priority = 'Choose Low, Medium, High or Urgent.';
    if (blank(v.dueDate)) e.dueDate = 'Choose a due date.';
    else if (!isDateOnly(v.dueDate)) e.dueDate = 'Enter a real calendar date.';
    if (tooLong(v.by, LIMITS.name)) e.by = `Keep the name to ${LIMITS.name} characters or fewer.`;
    return e;
  }

  /* ---------- idempotent submissions (as on Customer Follow-up) ---------- */

  /** A key from the browser's cryptographic RNG; null (refuse to submit) without one. */
  function newKey(cryptoObj = (typeof crypto !== 'undefined' ? crypto : null)) {
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  /** An answer that does not say whether the server saved the request. */
  function isAmbiguous(res) {
    if (!res || res.ok) return false;
    if (['timeout', 'network_error', 'malformed_response'].includes(res.code)) return true;
    return typeof res.status === 'number' && (res.status === 0 || res.status >= 500);
  }

  /** One intentional submission: the key is made once; after an ambiguous answer the payload is frozen. */
  function createSubmission(cryptoObj) {
    const key = newKey(cryptoObj);
    let payload = null;
    let frozen = false;
    return {
      get key() { return key; },
      get frozen() { return frozen; },
      get payload() { return payload; },
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
    edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    start: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  const COLS = 7;
  const badge = (tone, text, extra = '') => `<span class="badge badge--${tone}"${extra}>${esc(text)}</span>`;
  const priorityBadge = p => badge(PRIORITY_TONE[p] || 'neutral', PRIORITY_LABEL[p] || p);

  function dueText(r, today) {
    if (!r.open || !isDateOnly(r.dueDate)) return '';
    const ms = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    const days = Math.round((ms(r.dueDate) - ms(today)) / 86400000);
    if (days === 0) return 'Due today';
    if (days > 0) return days === 1 ? 'In 1 day' : `In ${days} days`;
    return -days === 1 ? '1 day overdue' : `${-days} days overdue`;
  }

  function partyCell(r) {
    if (!r.customerId) return '<span class="ctk-muted">No customer</span>';
    const name = r.customerName
      ? esc(r.customerName) : `<span class="ctk-unknown">Unknown customer</span>`;
    let vehicle = '';
    if (r.vehicleId) {
      vehicle = r.vehicleKnown
        ? `<span class="cell-sub">${esc([r.regNo, r.vehicleLabel].filter(Boolean).join(' · ') || '—')}</span>`
        : `<span class="cell-sub ctk-unknown">Unknown vehicle (${esc(r.vehicleId)})</span>`;
    }
    const job = r.jobCardId
      ? `<span class="cell-sub">${r.jobKnown ? `<a href="job-cards.html?view=${encodeURIComponent(r.jobCardId)}">${esc(r.jobCardId)}</a>` : `${esc(r.jobCardId)} (not found)`}</span>` : '';
    return `${name}${vehicle}${job}`;
  }

  function statusCell(r) {
    const main = badge(STATUS_TONE[r.status] || 'neutral', r.status || 'Unknown');
    return r.due === 'overdue' ? `${main} ${badge('bad', 'Overdue')}` : main;
  }

  function rowHtml(r, today) {
    const label = esc(r.title);
    const openOnly = r.open ? `
            <button type="button" class="icon-btn icon-btn--sm" data-action="edit" data-id="${esc(r.id)}" title="Edit task" aria-label="Edit task ${label}">${ICON.edit}</button>
            ${r.status === 'Pending' ? `<button type="button" class="icon-btn icon-btn--sm" data-action="start" data-id="${esc(r.id)}" title="Start task" aria-label="Start task ${label}">${ICON.start}</button>` : ''}
            <button type="button" class="icon-btn icon-btn--sm" data-action="complete" data-id="${esc(r.id)}" title="Mark completed" aria-label="Mark task ${label} completed">${ICON.done}</button>` : '';
    return `
      <tr data-id="${esc(r.id)}"${r.status === 'Cancelled' ? ' class="ctk-row--cancelled"' : ''}>
        <td data-label="Task" class="cell-main ctk-title">${label}<span class="cell-sub">${esc(r.id)}</span></td>
        <td data-label="Customer / Vehicle">${partyCell(r)}</td>
        <td data-label="Assigned To">${r.assignedTo
          ? (r.staffName ? esc(r.staffName) : `<span class="ctk-unknown">Unknown staff (${esc(r.assignedTo)})</span>`)
          : '<span class="ctk-muted">Unassigned</span>'}</td>
        <td data-label="Priority">${priorityBadge(r.priority)}</td>
        <td data-label="Due Date">${esc(formatDay(r.dueDate))}${r.open ? `<span class="cell-sub${r.due === 'overdue' ? ' ctk-late' : ''}">${esc(dueText(r, today))}</span>` : ''}</td>
        <td data-label="Status">${statusCell(r)}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <button type="button" class="icon-btn icon-btn--sm" data-action="view" data-id="${esc(r.id)}" title="View details" aria-label="View task ${label}">${ICON.view}</button>
            ${openOnly}
          </div>
        </td>
      </tr>`;
  }

  function stateRow({ icon = ICON.list, title, text, retry = false, clear = false, tone = 'neutral', badge: label = '' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="ctk-empty-row">
        <td colspan="${COLS}">
          <div class="ctk-empty${tone === 'bad' ? ' ctk-empty--bad' : ''}">
            <span class="ctk-empty__icon">${icon}</span>
            <div class="ctk-empty__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="ctk-actions">${actions}</p>` : ''}
            </div>
            ${label ? `<span class="badge badge--${tone === 'bad' ? 'bad' : 'neutral'} ctk-empty__status">${esc(label)}</span>` : ''}
          </div>
        </td>
      </tr>`;
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, rows: [], search: '', status: 'all', priority: 'all', staff: 'all', dueBy: '', page: 1 };
  const $ = id => document.getElementById(id);
  const today = () => dhakaToday();
  let debounce = null;

  const CONTROLS = ['ctkSearch', 'ctkStatus', 'ctkPriority', 'ctkStaff', 'ctkDue', 'ctkClear', 'ctkNew'];
  function setControls(enabled) {
    for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; }
  }

  function setCards(counts, why = 'Unavailable') {
    const cards = [['ctkTotal', 'total', 'All tasks except cancelled'],
                   ['ctkDueToday', 'dueToday', 'Open, due today'],
                   ['ctkOverdue', 'overdue', 'Open, past the due date'],
                   ['ctkCompleted', 'completed', 'Marked completed']];
    for (const [id, key, sub] of cards) {
      const value = $(id), note = $(`${id}Sub`);
      if (value) value.innerHTML = counts ? esc(String(counts[key])) : '<span aria-hidden="true">&#8212;</span>';
      if (note) note.textContent = counts ? sub : why;
    }
  }

  function setTable(html, hasRows) {
    const body = $('ctkBody');
    if (body) body.innerHTML = html;
    const table = $('ctkTable');
    if (table && table.classList) table.classList.toggle('ctk-table--rows', !!hasRows);
  }

  function setPager(p) {
    const pager = $('ctkPager');
    if (pager) pager.hidden = !p || p.total === 0;
    if (!p || !p.total) return;
    const range = $('ctkRange'); if (range) range.textContent = `${p.from}–${p.to} of ${p.total}`;
    const prev = $('ctkPrev'), next = $('ctkNext');
    if (prev) prev.disabled = p.page <= 1;
    if (next) next.disabled = p.page >= p.pages;
  }

  function note(text) { const el = $('ctkToolbarNote'); if (el) el.textContent = text; }

  /** The staff filter: everyone active, plus anyone a task is still assigned to. */
  function staffOptions(selected) {
    const tasks = Storage.getData('followUpTasks');
    const used = new Set(tasks.map(t => t && t.assignedTo).filter(Boolean));
    const people = Storage.getData('mechanics').filter(m => m && (m.status !== 'Inactive' || used.has(m.id)))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return '<option value="all">All Staff</option><option value="none">Unassigned</option>' + people.map(m =>
      `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}${m.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('');
  }

  /** Rebuild rows and cards from what Storage holds now. */
  function refreshView() {
    const t = today();
    const tasks = Storage.getData('followUpTasks');
    state.rows = sortRows(buildRows({
      tasks, customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'),
      jobCards: Storage.getData('jobCards'), mechanics: Storage.getData('mechanics'), today: t,
    }));
    setCards(kpis(tasks, t));
    const staff = $('ctkStaff');
    if (staff) {
      staff.innerHTML = staffOptions(state.staff);
      if (state.staff !== 'all' && state.staff !== 'none' && !Storage.getById('mechanics', state.staff)) state.staff = 'all';
      staff.value = state.staff;
    }
    renderList();
  }

  function renderList() {
    const t = today();
    const total = state.rows.length;
    if (!total) {
      setPager(null);
      setTable(stateRow({ title: 'No tasks yet',
        text: 'Use “New Task” to plan workshop work: a call back, a part to order, a check after a service. Tasks, their staff, priorities and due dates will be listed here.' }), false);
      note('0 tasks');
      return;
    }
    const shown = filterRows(state.rows, state);
    if (!shown.length) {
      setPager(null);
      setTable(stateRow({ icon: ICON.search, title: 'No tasks match your search or filters',
        text: 'Change or clear the search, status, priority, staff or due-by filter to see more tasks.', clear: true }), false);
      note(`No matches among ${total} task${total === 1 ? '' : 's'}`);
      return;
    }
    const p = paginate(shown, state.page);
    state.page = p.page;
    setTable(p.items.map(r => rowHtml(r, t)).join(''), true);
    setPager(p);
    note(`Showing ${p.from}–${p.to} of ${p.total} task${p.total === 1 ? '' : 's'}${shown.length === total ? '' : ` · filtered from ${total}`}`);
  }

  function renderUnavailable(reason) {
    const noBackend = reason === 'no_api';
    state.loaded = false;
    setControls(false);
    setCards(null);
    setPager(null);
    note('Search and filters are unavailable until the tasks load.');
    setTable(stateRow({
      icon: ICON.alert, tone: 'bad', badge: 'Unavailable', retry: !noBackend,
      title: noBackend ? 'Follow-up tasks need the workshop database' : 'Follow-up tasks could not be loaded',
      text: noBackend
        ? 'This copy of the app is not connected to the workshop database, so no tasks are shown and none can be created.'
        : 'The workshop database did not answer, so no tasks are shown. Nothing stored in this browser is used in their place.',
    }), false);
  }

  function renderLoading() {
    setControls(false);
    setCards(null, 'Loading…');
    setPager(null);
    note('Loading tasks…');
    setTable(stateRow({ title: 'Loading tasks…', text: 'Reading follow-up tasks from the workshop database.' }), false);
  }

  async function load() {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    renderLoading();
    const res = await Storage.load('followUpTasks');
    if (!res.ok) { renderUnavailable(res.code); return false; }
    state.loaded = true;
    setControls(true);
    refreshView();
    return true;
  }

  /* ---------- dialogs ---------- */

  function field({ id, label, required = false, html, err, span = false, hint = '' }) {
    return `
      <div class="field${span ? ' span-2' : ''}">
        <label for="${id}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="muted-note">${esc(hint)}</p>` : ''}
        <div class="field__error" data-err="${err}"></div>
      </div>`;
  }

  function setNotice(root, text, tone = 'bad') {
    const box = root.querySelector('[data-notice]');
    if (!box) return;
    box.hidden = !text;
    box.className = `ctk-notice ctk-notice--${tone}`;
    box.textContent = text || '';
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

  /** Someone (or an earlier click) already changed the task: say so, and show the truth. */
  async function changedElsewhere(res) {
    Utils.Modal.close();
    await Storage.load('followUpTasks');
    refreshView();
    const reason = res && res.errorReason;
    if (reason === 'task_closed') Utils.toast(`This task is already ${String(res.currentStatus || 'closed').toLowerCase()}.`, 'info');
    else if (reason === 'invalid_transition') Utils.toast(`This task is already ${String(res.currentStatus || '').toLowerCase()}.`, 'info');
    else Utils.toast('This task was changed by someone else. The list has been reloaded; open it again to edit.', 'info');
  }
  const isElsewhere = res => !res.ok && ['task_closed', 'invalid_transition', 'concurrent_modification'].includes(res.errorReason);

  const PICKER_LIMIT = 50;

  function matchCustomers(query) {
    const all = Storage.getData('customers').filter(c => c && c.status !== 'Inactive')
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const q = String(query).trim().toLowerCase();
    if (!q) return all;
    const qd = digitsOf(q);
    return all.filter(c => String(c.name || '').toLowerCase().includes(q) || (qd.length >= 3 && digitsOf(c.phone).includes(qd)));
  }

  function vehicleOptions(customerId, selected = '') {
    if (!customerId) return '<option value="">Select a customer first</option>';
    const cars = Storage.getData('vehicles')
      .filter(v => v && v.customerId === customerId && (v.status !== 'Inactive' || v.id === selected))
      .slice().sort((a, b) => String(a.regNo).localeCompare(String(b.regNo)));
    return '<option value="">No vehicle</option>' + cars.map(v =>
      `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} — ${esc([v.brand, v.model].filter(Boolean).join(' '))}${v.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('');
  }

  function jobOptions(customerId, vehicleId, selected = '') {
    if (!customerId) return '<option value="">Select a customer first</option>';
    const jobs = Storage.getData('jobCards')
      .filter(j => j && j.customerId === customerId && (!vehicleId || j.vehicleId === vehicleId || j.id === selected))
      .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    return '<option value="">No job card</option>' + jobs.map(j =>
      `<option value="${esc(j.id)}"${j.id === selected ? ' selected' : ''}>${esc(j.id)} — ${esc(formatDay(j.date))} (${esc(j.status || '')})</option>`).join('');
  }

  function staffSelect(selected = '') {
    const people = Storage.getData('mechanics').filter(m => m && (m.status !== 'Inactive' || m.id === selected))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return '<option value="">Unassigned</option>' + people.map(m =>
      `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}${m.specialization ? ` — ${esc(m.specialization)}` : ''}${m.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('');
  }

  function customerText(id) {
    const c = id ? Storage.getById('customers', id) : null;
    return c ? `${c.name} — ${c.phone || ''}` : (id ? `Unknown customer (${id})` : '');
  }

  function bindCustomerPicker(root, onChange) {
    const hidden = root.querySelector('#ft-customer');
    const input = root.querySelector('#ft-customer-search');
    const list = root.querySelector('#ft-customer-list');
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
            <li role="option" id="ft-cust-opt-${i}" data-index="${i}" aria-selected="${c.id === hidden.value}">
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

  function taskFields(t, { creating }) {
    const customerId = t.customerId || '';
    return `
      <div class="ctk-notice" data-notice hidden></div>
      <div class="form-grid">
        ${field({ id: 'ft-title', label: 'Title', required: true, err: 'title', span: true, html: `
          <input class="input" id="ft-title" name="title" maxlength="${LIMITS.title}" value="${esc(t.title || '')}" placeholder="e.g. Call the customer about the brake check">` })}
        ${field({ id: 'ft-description', label: 'Description', err: 'description', span: true, html: `
          <textarea class="textarea" id="ft-description" name="description" rows="3" maxlength="${LIMITS.description}">${esc(t.description || '')}</textarea>` })}
        ${field({ id: 'ft-customer-search', label: 'Customer', err: 'customerId', span: true, hint: 'Optional. Active customers only.', html: `
          <div class="cust-picker">
            <div class="cust-picker__box">
              <input class="input" id="ft-customer-search" type="text" autocomplete="off" value="${esc(customerText(customerId))}"
                     placeholder="Search customers by name or phone"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ft-customer-list">
              <button type="button" class="cust-picker__clear" aria-label="Clear selected customer"${customerId ? '' : ' hidden'}>&times;</button>
            </div>
            <input type="hidden" id="ft-customer" name="customerId" value="${esc(customerId)}">
            <ul class="cust-picker__list" id="ft-customer-list" role="listbox" aria-label="Matching customers" hidden></ul>
          </div>` })}
        ${field({ id: 'ft-vehicle', label: 'Vehicle', err: 'vehicleId', html: `
          <select class="select" id="ft-vehicle" name="vehicleId"${customerId ? '' : ' disabled'}>${vehicleOptions(customerId, t.vehicleId || '')}</select>` })}
        ${field({ id: 'ft-job', label: 'Job card', err: 'jobCardId', html: `
          <select class="select" id="ft-job" name="jobCardId"${customerId ? '' : ' disabled'}>${jobOptions(customerId, t.vehicleId || '', t.jobCardId || '')}</select>` })}
        ${field({ id: 'ft-staff', label: 'Assigned to', err: 'assignedTo', html: `
          <select class="select" id="ft-staff" name="assignedTo">${staffSelect(t.assignedTo || '')}</select>` })}
        ${field({ id: 'ft-priority', label: 'Priority', required: true, err: 'priority', html: `
          <select class="select" id="ft-priority" name="priority">${PRIORITIES.map(p =>
            `<option value="${p}"${(t.priority || 'medium') === p ? ' selected' : ''}>${PRIORITY_LABEL[p]}</option>`).join('')}</select>` })}
        ${field({ id: 'ft-due', label: 'Due date', required: true, err: 'dueDate', html: `
          <input class="input" id="ft-due" name="dueDate" type="date" value="${esc(t.dueDate || today())}">` })}
        ${field({ id: 'ft-by', label: creating ? 'Created by' : 'Updated by', err: creating ? 'createdBy' : 'updatedBy', html: `
          <input class="input" id="ft-by" name="by" maxlength="${LIMITS.name}" placeholder="Your name (optional)">`,
          hint: 'The workshop shares one login, so this names a person but does not prove who acted.' })}
      </div>`;
  }

  function readTaskForm(form) {
    const val = n => (form.querySelector(`[name="${n}"]`) || { value: '' }).value;
    return {
      title: val('title').trim(), description: val('description').trim(), customerId: val('customerId').trim(),
      vehicleId: val('vehicleId'), jobCardId: val('jobCardId'), assignedTo: val('assignedTo'),
      priority: val('priority'), dueDate: val('dueDate'), by: val('by').trim(),
    };
  }

  /** Wire the customer -> vehicle -> job card cascade of a task form. */
  function bindTaskForm(form) {
    const vehicle = form.querySelector('#ft-vehicle');
    const job = form.querySelector('#ft-job');
    const customer = form.querySelector('#ft-customer');
    bindCustomerPicker(form, id => {
      vehicle.innerHTML = vehicleOptions(id);
      job.innerHTML = jobOptions(id, '');
      vehicle.disabled = !id;
      job.disabled = !id;
    });
    vehicle.addEventListener('change', () => { job.innerHTML = jobOptions(customer.value, vehicle.value, job.value); });
  }

  function freeze(form) {
    form.querySelectorAll('input, select, textarea, .cust-picker__clear').forEach(el => { el.disabled = true; });
  }

  function openCreate() {
    if (!state.loaded) return;
    const sub = createSubmission();
    const ov = Utils.Modal.open({
      title: 'New Task',
      body: `<form id="ctkForm" novalidate>${taskFields({}, { creating: true })}</form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
               <button type="button" class="btn btn--primary" data-submit>Create Task</button>`,
    });
    const form = ov.querySelector('#ctkForm');
    bindTaskForm(form);
    if (!sub.key) setNotice(ov, 'This browser cannot create a secure submission key, so tasks cannot be created here. Use an up-to-date browser over https.');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const v = readTaskForm(form);
      const errors = validateTask(v);
      if (errors.by) { errors.createdBy = errors.by; delete errors.by; }
      if (!sub.frozen && !showErrors(form, errors)) return;
      const body = sub.body({
        title: v.title, description: v.description, customerId: v.customerId || null, vehicleId: v.vehicleId || null,
        jobCardId: v.jobCardId || null, assignedTo: v.assignedTo || null, priority: v.priority, dueDate: v.dueDate,
        createdBy: v.by,
      });
      if (!body) { setNotice(ov, 'This browser cannot create a secure submission key, so nothing was sent.'); return; }
      const res = sub.settle(await Storage.create('followUpTasks', body));
      if (sub.frozen && !res.ok) {
        freeze(form);
        const btn = ov.querySelector('[data-submit]');
        if (btn) setTimeout(() => { btn.textContent = 'Retry'; }, 0);
        setNotice(ov, 'The workshop database did not confirm this. It may or may not have been saved. Retry sends exactly the same request again and can never save it twice.', 'warn');
        Storage.load('followUpTasks').then(refreshView, () => {});
        return;
      }
      if (!res.ok && res.errorReason === 'idempotency_key_reused') { setNotice(ov, 'This submission could not be matched. Close the dialog and start again.'); return; }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast(res.meta && res.meta.replayed ? 'This task was already saved.' : 'Task created.', 'success');
    }));
  }

  function openEdit(id) {
    const t = Storage.getById('followUpTasks', id);
    if (!isOpen(t)) { Utils.toast('Only a pending or in-progress task can be edited.', 'info'); return; }
    const ov = Utils.Modal.open({
      title: 'Edit Task',
      body: `<form id="ctkForm" novalidate>${taskFields(t, { creating: false })}</form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
               <button type="button" class="btn btn--primary" data-submit>Save Changes</button>`,
    });
    const form = ov.querySelector('#ctkForm');
    bindTaskForm(form);
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const v = readTaskForm(form);
      const errors = validateTask(v);
      if (errors.by) { errors.updatedBy = errors.by; delete errors.by; }
      if (!showErrors(form, errors)) return;
      // A merge PUT made from a known version: if someone saved in between,
      // the Worker refuses it instead of silently overwriting their change.
      const res = await Storage.update('followUpTasks', id, {
        title: v.title, description: v.description, customerId: v.customerId || null, vehicleId: v.vehicleId || null,
        jobCardId: v.jobCardId || null, assignedTo: v.assignedTo || null, priority: v.priority, dueDate: v.dueDate,
        updatedBy: v.by, expectedUpdatedAt: t.updatedAt,
      });
      if (isElsewhere(res)) { changedElsewhere(res); return; }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast('Task updated.', 'success');
    }));
  }

  async function startTask(id) {
    const t = Storage.getById('followUpTasks', id);
    if (!t || t.status !== 'Pending') { Utils.toast('Only a pending task can be started.', 'info'); return; }
    const res = await Storage.action('followUpTasks', id, 'start', {});
    if (isElsewhere(res)) { changedElsewhere(res); return; }
    if (!Utils.wrote(res)) return;
    refreshView();
    Utils.toast('Task started.', 'success');
  }

  function openClose(id, kind) {
    const t = Storage.getById('followUpTasks', id);
    if (!isOpen(t)) { Utils.toast('This task is already closed.', 'info'); return; }
    const cancel = kind === 'cancel';
    const ov = Utils.Modal.open({
      title: cancel ? 'Cancel Task' : 'Complete Task',
      body: `<form id="ctkForm" novalidate>
        <p class="ctk-fixed">${esc(t.title)}<span class="cell-sub">${esc(t.id)}</span></p>
        <p class="muted-note">${cancel
          ? 'A cancelled task is kept with your reason and cannot be reopened. Create a new task if the work is needed again.'
          : 'A completed task cannot be reopened. Create a new task if more work is needed.'}</p>
        <div class="form-grid">
          ${field({ id: 'fx-note', label: cancel ? 'Reason for cancelling' : 'Completion note', required: cancel,
            err: cancel ? 'reason' : 'note', span: true, html: `
            <textarea class="textarea" id="fx-note" name="note" rows="3" maxlength="${cancel ? LIMITS.reason : LIMITS.note}"></textarea>` })}
          ${field({ id: 'fx-by', label: cancel ? 'Cancelled by' : 'Completed by', err: 'by', html: `
            <input class="input" id="fx-by" name="by" maxlength="${LIMITS.name}" placeholder="Your name (optional)">` })}
        </div></form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Back</button>
               <button type="button" class="btn ${cancel ? 'btn--danger' : 'btn--primary'}" data-submit>${cancel ? 'Cancel Task' : 'Mark Completed'}</button>`,
    });
    const form = ov.querySelector('#ctkForm');
    ov.querySelector('[data-submit]').addEventListener('click', Utils.saving(async () => {
      const text = form.querySelector('[name="note"]').value.trim();
      const by = form.querySelector('[name="by"]').value.trim();
      const errors = {};
      if (cancel && blank(text)) errors.reason = 'Enter the reason for cancelling this task.';
      else if (tooLong(text, LIMITS.note)) errors[cancel ? 'reason' : 'note'] = `Keep it to ${LIMITS.note} characters or fewer.`;
      if (tooLong(by, LIMITS.name)) errors.by = `Keep the name to ${LIMITS.name} characters or fewer.`;
      if (!showErrors(form, errors)) return;
      const res = await Storage.action('followUpTasks', id, cancel ? 'cancel' : 'complete', cancel ? { reason: text, by } : { note: text, by });
      if (isElsewhere(res)) { changedElsewhere(res); return; }
      if (!Utils.wrote(res, form)) return;
      Utils.Modal.close();
      refreshView();
      Utils.toast(cancel ? 'Task cancelled.' : 'Task completed.', 'success');
    }));
  }

  function openDetail(id) {
    const t = Storage.getById('followUpTasks', id);
    if (!t) { Utils.toast('That task is no longer available.', 'info'); return; }
    const td = today();
    const r = buildRows({ tasks: [t], customers: Storage.getData('customers'), vehicles: Storage.getData('vehicles'),
      jobCards: Storage.getData('jobCards'), mechanics: Storage.getData('mechanics'), today: td })[0];
    const fact = (label, value, wide = false) => `<div class="ctk-fact${wide ? ' ctk-fact--wide' : ''}"><span class="ctk-fact__label">${esc(label)}</span><span class="ctk-fact__value">${value}</span></div>`;
    const who = (at, by) => `${esc(formatMoment(at))}${by ? `<span class="cell-sub">by ${esc(by)}</span>` : ''}`;
    const ov = Utils.Modal.open({
      title: 'Task Details',
      size: 'lg',
      body: `
        <div class="ctk-facts">
          ${fact('Task', `${esc(t.title)}<span class="cell-sub">${esc(t.id)}</span>`, true)}
          ${t.description ? fact('Description', `<span class="ctk-text">${esc(t.description)}</span>`, true) : ''}
          ${fact('Customer / Vehicle / Job card', partyCell(r))}
          ${fact('Assigned to', r.assignedTo ? (r.staffName ? esc(r.staffName) : `Unknown staff (${esc(r.assignedTo)})`) : '<span class="ctk-muted">Unassigned</span>')}
          ${fact('Priority', priorityBadge(r.priority))}
          ${fact('Status', statusCell(r))}
          ${fact('Due date', `${esc(formatDay(t.dueDate))}${r.open ? `<span class="cell-sub">${esc(dueText(r, td))}</span>` : ''}`)}
          ${fact('Created', who(t.createdAt, t.createdBy))}
          ${fact('Last updated', who(t.updatedAt, t.updatedBy))}
          ${t.startedAt ? fact('Started', esc(formatMoment(t.startedAt))) : ''}
          ${t.completedAt ? fact('Completed', `${esc(formatMoment(t.completedAt))}${t.completionNote ? `<span class="cell-sub ctk-text">${esc(t.completionNote)}</span>` : ''}`, true) : ''}
          ${t.cancelledAt ? fact('Cancelled', `${esc(formatMoment(t.cancelledAt))}<span class="cell-sub ctk-text">Reason: ${esc(t.cancelReason)}</span>`, true) : ''}
        </div>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${r.open ? `
        <button type="button" class="btn btn--ghost" data-do="cancel">Cancel Task</button>
        <button type="button" class="btn btn--ghost" data-do="edit">Edit</button>
        ${t.status === 'Pending' ? '<button type="button" class="btn btn--ghost" data-do="start">Start</button>' : ''}
        <button type="button" class="btn btn--primary" data-do="complete">Mark Completed</button>` : ''}`,
    });
    ov.addEventListener('click', e => {
      const d = e.target.closest && e.target.closest('[data-do]');
      if (!d) return;
      const act = d.dataset.do;
      if (act === 'edit') openEdit(id);
      else if (act === 'start') { Utils.Modal.close(); startTask(id); }
      else if (act === 'complete') openClose(id, 'complete');
      else if (act === 'cancel') openClose(id, 'cancel');
    });
  }

  /* ---------- events ---------- */

  function resetPage() { state.page = 1; }

  function clearFilters() {
    Object.assign(state, { search: '', status: 'all', priority: 'all', staff: 'all', dueBy: '', page: 1 });
    for (const [id, value] of [['ctkSearch', ''], ['ctkStatus', 'all'], ['ctkPriority', 'all'], ['ctkStaff', 'all'], ['ctkDue', '']]) {
      const el = $(id); if (el) el.value = value;
    }
    renderList();
  }

  function bindEvents() {
    const search = $('ctkSearch'), status = $('ctkStatus'), priority = $('ctkPriority'), staff = $('ctkStaff');
    const due = $('ctkDue'), clear = $('ctkClear'), add = $('ctkNew'), prev = $('ctkPrev'), next = $('ctkNext'), body = $('ctkBody');
    if (search) search.addEventListener('input', e => {
      const value = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; resetPage(); renderList(); }, 200);
    });
    if (status) status.addEventListener('change', e => { state.status = STATUS_FILTERS.includes(e.target.value) ? e.target.value : 'all'; resetPage(); renderList(); });
    if (priority) priority.addEventListener('change', e => { state.priority = PRIORITIES.includes(e.target.value) ? e.target.value : 'all'; resetPage(); renderList(); });
    if (staff) staff.addEventListener('change', e => { state.staff = String(e.target.value || 'all'); resetPage(); renderList(); });
    if (due) due.addEventListener('change', e => { state.dueBy = String(e.target.value || ''); resetPage(); renderList(); });
    if (clear) clear.addEventListener('click', () => { clearTimeout(debounce); clearFilters(); });
    if (add) add.addEventListener('click', () => openCreate());
    if (prev) prev.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderList(); });
    if (next) next.addEventListener('click', () => { state.page += 1; renderList(); });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'clear': clearTimeout(debounce); clearFilters(); break;
        case 'view': openDetail(id); break;
        case 'edit': openEdit(id); break;
        case 'start': startTask(id); break;
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
    LIMITS, PRIORITIES, PAGE_SIZE,
    dhakaToday, dhakaDateOf, isDateOnly, formatDay,
    dueState, kpis, buildRows, sortRows, matchesSearch, filterRows, paginate,
    validateTask, newKey, isAmbiguous, createSubmission,
    load, refreshView, renderList, startTask, state,
  };
})();
