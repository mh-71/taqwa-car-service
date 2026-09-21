/* ============================================================
   job-cards.js — Job Cards Management module
   The central workshop transaction record.

   Conventions (matching existing data consumed by Customers,
   Vehicles, Mechanics, Dashboard):
   - statuses: Received → Inspection → (Waiting for Approval) →
     In Progress → (Waiting for Parts) → Completed → Delivered,
     with Cancelled branches. "Waiting for Approval" plays the
     spec's "Waiting for Customer" role.
   - flat money fields: subtotal, tax, total, paid, due,
     labourCost, discount, taxRate (existing modules read these)
   - services[]: { serviceId, name, qty, unitPrice, total } —
     name + unitPrice are SNAPSHOTS; catalog changes never
     rewrite history.
   - partsUsed[]: { partId|null, name, partNo, qty, unitPrice,
     total } — manual entry until the Inventory module lands;
     partId is the future integration point.
   - mileage = mileage-in (existing field name), mileageOut new.
   - appointmentId / invoiceId are the integration hooks.
   All totals are recalculated in JS before saving — client
   totals are never trusted.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, fmtTime, todayStr, badge, toast, Modal } = Utils;

  /* ---------- status model (existing project statuses) ---------- */

  const ACTIVE = Utils.ACTIVE_JOB_STATUSES;   // Received..Waiting for Parts
  const DONE = Utils.DONE_JOB_STATUSES;       // Completed, Delivered
  const WAITING = ['Waiting for Approval', 'Waiting for Parts'];
  // Edit-lock: statuses treated as read-only historical records. Completed
  // is included alongside Delivered/Cancelled so inventory-impacting edits
  // can't slip in after work is done (Completed can still move → Delivered
  // via statusButtons(), which reads TRANSITIONS separately from this list).
  const TERMINAL = ['Completed', 'Delivered', 'Cancelled'];
  // Statuses where inventory has already started moving for this job, so an
  // edit to partsUsed must reconcile stock rather than just overwrite the
  // record. Waiting for Parts is included because it's only ever reached
  // from In Progress — by then, whatever was on the job at that point has
  // already been deducted.
  const INVENTORY_TRACKED_STATUSES = ['In Progress', 'Waiting for Parts'];

  const TRANSITIONS = {
    'Received':             ['Inspection', 'Cancelled'],
    'Inspection':           ['In Progress', 'Waiting for Approval', 'Cancelled'],
    'Waiting for Approval': ['In Progress', 'Cancelled'],
    'In Progress':          ['Waiting for Parts', 'Waiting for Approval', 'Completed', 'Cancelled'],
    'Waiting for Parts':    ['In Progress'],
    'Completed':            ['Delivered'],
    'Delivered':            [],
    'Cancelled':            []
  };

  const TRANSITION_LABELS = {
    'Inspection': 'Start Inspection', 'In Progress': 'Start Work',
    'Waiting for Approval': 'Wait: Customer', 'Waiting for Parts': 'Wait: Parts',
    'Completed': 'Complete', 'Delivered': 'Deliver', 'Cancelled': 'Cancel'
  };

  const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  const PRIORITY_TONE = { low: 'neutral', normal: 'info', high: 'warn', urgent: 'bad' };
  const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three-quarter', 'full'];
  const FUEL_LABELS = { empty: 'Empty', quarter: '1/4', half: '1/2', 'three-quarter': '3/4', full: 'Full' };

  const INSPECTION_ITEMS = ['Engine', 'Brakes', 'Tyres', 'Battery', 'Suspension', 'Lights', 'AC', 'Electrical', 'Fluids', 'Overall'];
  const INSPECTION_STATES = ['', 'OK', 'Attention', 'Critical', 'N/A'];

  const priorityBadge = p => {
    const key = p || 'normal';
    return `<span class="badge badge--${PRIORITY_TONE[key] || 'info'}">${PRIORITIES[key] || 'Normal'}</span>`;
  };

  /* ---------- state ---------- */

  let searchTerm = '';
  let fQuick = 'all', fStatus = 'all', fPriority = 'all', fMechanic = 'all', fDate = '';
  let sortBy = 'date-desc';

  /* ---------- safe lookups ---------- */

  const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
  const custPhone = id => (Storage.getById('customers', id) || {}).phone || 'N/A';
  const veh = id => Storage.getById('vehicles', id);
  const vehText = id => { const v = veh(id); return v ? `${v.brand} ${v.model}` : 'Unknown Vehicle'; };
  const vehReg = id => { const v = veh(id); return v ? v.regNo : 'N/A'; };
  const mec = id => Storage.getById('mechanics', id);
  const mecName = id => id ? ((mec(id) || {}).name || 'Unknown Mechanic') : '—';
  const svc = id => Storage.getById('services', id);

  /* ---------- totals: single source of truth ---------- */

  function computeTotals(job) {
    const serviceTotal = (job.services || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const partsTotal = (job.partsUsed || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const hours = Number(job.labourHours) || 0;
    const rate = Number(job.labourRate) || 0;
    // hours×rate wins when provided; otherwise a directly entered labourCost stands (legacy support)
    const labourCost = (hours > 0 && rate > 0) ? hours * rate : (Number(job.labourCost) || 0);
    const subtotal = serviceTotal + partsTotal + labourCost;
    const discount = Math.min(Number(job.discount) || 0, subtotal);
    const taxRate = Number(job.taxRate) || 0;
    const tax = Math.round((subtotal - discount) * taxRate / 100);
    const total = subtotal - discount + tax;
    const paid = Number(job.paid) || 0;
    return { serviceTotal, partsTotal, labourCost, subtotal, discount, taxRate, tax, total, paid, due: Math.max(total - paid, 0) };
  }

  /** Normalize line items with recalculated totals (never trust the UI). */
  function normalizeLines(lines, isService) {
    return (lines || [])
      .filter(l => (isService ? l.serviceId : (l.name || '').trim()))
      .map(l => ({
        ...(isService
          ? { serviceId: l.serviceId, name: l.name }
          : { partId: l.partId || null, name: (l.name || '').trim(), partNo: (l.partNo || '').trim() }),
        qty: Number(l.qty) || 1,
        unitPrice: Number(l.unitPrice) || 0,
        total: (Number(l.qty) || 1) * (Number(l.unitPrice) || 0)
      }));
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const jobs = Storage.getData('jobCards');
    const today = todayStr();
    const count = f => jobs.filter(f).length;
    const workshopValue = jobs.filter(j => ACTIVE.includes(j.status))
      .reduce((s, j) => s + (Number(j.total) || 0), 0);

    const stats = [
      { label: 'Total Job Cards', value: jobs.length, tone: 'info', icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z' },
      { label: 'Active', value: count(j => ACTIVE.includes(j.status)), tone: 'amber', icon: 'M13 2.05v2.02c3.95.49 7 3.85 7 7.93 0 4.42-3.58 8-8 8s-8-3.58-8-8c0-1.95.7-3.73 1.86-5.12L12 12V2.05h1z' },
      { label: 'In Progress', value: count(j => j.status === 'In Progress'), tone: 'info', icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z' },
      { label: 'Waiting', value: count(j => WAITING.includes(j.status)), tone: 'warn', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z' },
      { label: 'Completed / Delivered', value: count(j => DONE.includes(j.status)), tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Workshop Value (Active)', value: money(workshopValue), tone: 'good', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' }
    ];

    document.getElementById('jobStats').innerHTML = stats.map(s => `
      <div class="stat">
        <div class="stat__icon stat__icon--${s.tone}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${s.icon}"/></svg>
        </div>
        <div>
          <div class="stat__value">${s.value}</div>
          <div class="stat__label">${s.label}</div>
        </div>
      </div>`).join('');
  }

  /* ---------- list ---------- */

  function filteredJobs() {
    const term = searchTerm.trim().toLowerCase();
    const today = todayStr();
    const prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };

    let list = Storage.getData('jobCards').filter(j => {
      if (term) {
        const hay = `${j.id} ${j.appointmentId || ''} ${custName(j.customerId)} ${custPhone(j.customerId)} ${vehReg(j.vehicleId)} ${vehText(j.vehicleId)} ${mecName(j.mechanicId)} ${(j.services || []).map(s => s.name).join(' ')}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fStatus !== 'all' && j.status !== fStatus) return false;
      if (fPriority !== 'all' && (j.priority || 'normal') !== fPriority) return false;
      if (fMechanic !== 'all' && j.mechanicId !== fMechanic) return false;
      if (fDate && j.date !== fDate) return false;
      if (fQuick === 'today' && j.date !== today) return false;
      if (fQuick === 'active' && !ACTIVE.includes(j.status)) return false;
      if (fQuick === 'waiting' && !WAITING.includes(j.status)) return false;
      if (fQuick === 'done' && !DONE.includes(j.status)) return false;
      if (fQuick === 'cancelled' && j.status !== 'Cancelled') return false;
      return true;
    });

    const cmp = {
      'date-desc':  (a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id),
      'date-asc':   (a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id),
      'id':         (a, b) => a.id.localeCompare(b.id),
      'customer':   (a, b) => custName(a.customerId).localeCompare(custName(b.customerId)),
      'status':     (a, b) => (a.status || '').localeCompare(b.status || ''),
      'priority':   (a, b) => (prioRank[a.priority || 'normal'] - prioRank[b.priority || 'normal']) || (b.date || '').localeCompare(a.date || ''),
      'total-desc': (a, b) => (Number(b.total) || 0) - (Number(a.total) || 0)
    }[sortBy];
    return list.sort(cmp);
  }

  function populateMechanicFilter() {
    const sel = document.getElementById('jobMechanic');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All mechanics</option>` +
      Storage.getData('mechanics').map(m =>
        `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  }

  function statusButtons(j) {
    const nexts = TRANSITIONS[j.status] || [];
    return nexts.map((n, i) =>
      `<button class="btn btn--sm ${i === 0 && n !== 'Cancelled' ? 'btn--primary' : 'btn--ghost'}" data-action="status" data-next="${n}">${TRANSITION_LABELS[n] || n}</button>`
    ).join('');
  }

  function renderList() {
    const rows = filteredJobs();
    const total = Storage.getData('jobCards').length;
    const tbody = document.getElementById('jobTableBody');
    const isFiltered = searchTerm || fQuick !== 'all' || fStatus !== 'all' || fPriority !== 'all' || fMechanic !== 'all' || fDate;

    document.getElementById('jobCount').textContent =
      isFiltered ? `${rows.length} of ${total} job cards` : `${total} job cards`;

    if (!rows.length) {
      let msg = 'No Job Cards found.';
      if (fQuick === 'active') msg = 'No active Job Cards.';
      else if (isFiltered) msg = 'No Job Cards match your search or filter.';
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z"/></svg>
            <h3>${msg}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Open your first job card to start tracking workshop work.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">New Job Card</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(j => `
      <tr data-id="${esc(j.id)}">
        <td class="cell-main">${esc(j.id)}${j.appointmentId ? `<span class="cell-sub">${esc(j.appointmentId)}</span>` : ''}</td>
        <td>${fmtDate(j.date)}</td>
        <td class="cell-main">${esc(custName(j.customerId))}</td>
        <td>${esc(vehText(j.vehicleId))}<span class="cell-sub">${esc(vehReg(j.vehicleId))}</span></td>
        <td>${esc(mecName(j.mechanicId))}</td>
        <td class="cell-desc">${esc((j.services || []).map(s => s.name).join(', ') || '—')}</td>
        <td>${badge(j.status)}</td>
        <td>${priorityBadge(j.priority)}</td>
        <td class="num">${money(j.total)}${Number(j.due) > 0 ? `<span class="cell-sub due">Due ${money(j.due)}</span>` : ''}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            ${statusButtons(j)}
            <button class="icon-btn icon-btn--sm" data-action="view" title="View" aria-label="View ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            ${!TERMINAL.includes(j.status) ? `
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>` : ''}
            <button class="icon-btn icon-btn--sm" data-action="print" title="Print" aria-label="Print ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 8H5c-1.7 0-3 1.3-3 3v6h4v4h12v-4h4v-6c0-1.7-1.3-3-3-3zm-3 11H8v-5h8v5zm3-7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`).join('');
  }

  /* ============================================================
     FORM (create / edit) — multi-section with live totals
     ============================================================ */

  function customerOptions(selected) {
    return `<option value="">— Select customer —</option>` +
      Storage.getData('customers').slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)} — ${esc(c.phone)}</option>`).join('');
  }

  function vehicleOptions(customerId, selected) {
    if (!customerId) return `<option value="">— Select customer first —</option>`;
    const vs = Storage.getData('vehicles').filter(v => v.customerId === customerId);
    if (!vs.length) return `<option value="">— No vehicles for this customer —</option>`;
    return `<option value="">— Select vehicle —</option>` +
      vs.map(v => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} — ${esc(v.brand)} ${esc(v.model)}</option>`).join('');
  }

  function mechanicOptions(selected) {
    const all = Storage.getData('mechanics');
    const active = all.filter(m => (m.status || 'Active') === 'Active');
    const current = selected && all.find(m => m.id === selected);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">— Select mechanic —</option>` +
      list.map(m => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)} — ${esc(m.specialization || 'General')}${(m.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  function serviceSelectOptions(selectedId) {
    const all = Storage.getData('services');
    const active = all.filter(s => (s.status || 'Active') === 'Active');
    const current = selectedId && all.find(s => s.id === selectedId);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">— Select service —</option>` +
      list.sort((a, b) => a.name.localeCompare(b.name))
        .map(s => `<option value="${esc(s.id)}" data-price="${Number(s.price) || 0}" data-name="${esc(s.name)}"${s.id === selectedId ? ' selected' : ''}>${esc(s.name)}${(s.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  // Appointments eligible as a job source: active statuses, no job card yet
  function sourceAppointments(includeId = null) {
    const BLOCKING = ['Scheduled', 'Confirmed', 'In Progress', 'Pending', 'In Service'];
    return Storage.getData('appointments').filter(a =>
      (a.id === includeId) || (BLOCKING.includes(a.status) && !a.jobCardId));
  }

  function appointmentOptions(selected) {
    const appts = sourceAppointments(selected);
    if (!appts.length) return `<option value="">— No open appointments —</option>`;
    return `<option value="">— Select appointment —</option>` +
      appts.map(a => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.id)} — ${esc(custName(a.customerId))}, ${fmtDate(a.date)} ${fmtTime(a.time)}</option>`).join('');
  }

  function serviceLineHtml(line = {}) {
    return `
      <div class="line-row" data-line="service">
        <select class="select line-service" aria-label="Service">${serviceSelectOptions(line.serviceId)}</select>
        <input class="input line-qty" type="number" min="1" step="1" value="${Number(line.qty) || 1}" aria-label="Quantity">
        <input class="input line-price" type="number" min="0" step="50" value="${Number(line.unitPrice) || 0}" aria-label="Unit price">
        <span class="line-total num" aria-label="Line total">${money((Number(line.qty) || 1) * (Number(line.unitPrice) || 0))}</span>
        <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-remove-line aria-label="Remove line">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      </div>`;
  }

  function partSelectOptions(selectedId, manualName = '') {
    const all = Storage.getData('parts');
    const active = all.filter(p => (p.status || 'Active') === 'Active');
    const current = selectedId && all.find(p => p.id === selectedId);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">${manualName ? `${esc(manualName)} (manual entry)` : '— Select part —'}</option>` +
      list.sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${esc(p.id)}" data-price="${Number(p.sellingPrice) || 0}" data-partno="${esc(p.partNo || '')}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)} — stock: ${Number(p.stock) || 0} ${esc(p.unit || '')}${(p.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  function partLineHtml(line = {}) {
    return `
      <div class="line-row line-row--part" data-line="part" data-manual-name="${esc(line.partId ? '' : (line.name || ''))}">
        <select class="select line-part" aria-label="Part">${partSelectOptions(line.partId, line.partId ? '' : (line.name || ''))}</select>
        <input class="input line-partno" value="${esc(line.partNo || '')}" placeholder="Part no." aria-label="Part number">
        <input class="input line-qty" type="number" min="1" step="1" value="${Number(line.qty) || 1}" aria-label="Quantity">
        <input class="input line-price" type="number" min="0" step="50" value="${Number(line.unitPrice) || 0}" aria-label="Unit price">
        <span class="line-total num">${money((Number(line.qty) || 1) * (Number(line.unitPrice) || 0))}</span>
        <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-remove-line aria-label="Remove line">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      </div>`;
  }

  function inspectionRowsHtml(checklist = {}) {
    return INSPECTION_ITEMS.map(item => {
      const entry = checklist[item] || {};
      return `
      <div class="insp-row" data-insp="${esc(item)}">
        <span class="insp-label">${item}</span>
        <select class="select insp-state" aria-label="${item} condition">
          ${INSPECTION_STATES.map(s => `<option value="${s}"${s === (entry.state || '') ? ' selected' : ''}>${s || '—'}</option>`).join('')}
        </select>
        <input class="input insp-note" value="${esc(entry.note || '')}" placeholder="Note (optional)" aria-label="${item} note">
      </div>`;
    }).join('');
  }

  function formHtml(j = {}, fromAppointmentId = '') {
    const isEdit = !!j.id;
    const settings = Storage.getSettings();
    const services = (j.services && j.services.length) ? j.services : [{}];
    const parts = j.partsUsed || [];
    const isCompleted = j.status === 'Completed';
    return `
      ${isCompleted ? `<div class="warn-banner">Completed Job Cards are historical records. Changes may affect future invoicing.</div>` : ''}
      <form id="jobForm" novalidate>
        ${!isEdit ? `
        <h3 class="detail-section-title">Source</h3>
        <div class="form-grid">
          <div class="field">
            <label for="jf-source">Job Source</label>
            <select class="select" id="jf-source" name="source">
              <option value="walkin"${!fromAppointmentId ? ' selected' : ''}>Walk-in</option>
              <option value="appointment"${fromAppointmentId ? ' selected' : ''}>From Appointment</option>
            </select>
          </div>
          <div class="field" id="jf-apt-wrap" ${fromAppointmentId ? '' : 'hidden'}>
            <label for="jf-appointment">Appointment</label>
            <select class="select" id="jf-appointment" name="appointmentId">${appointmentOptions(fromAppointmentId)}</select>
            <div class="field__error" data-err="appointmentId"></div>
          </div>
        </div>` : (j.appointmentId ? `<p class="muted-note" style="margin-bottom:12px">Linked appointment: <strong>${esc(j.appointmentId)}</strong></p>` : '')}

        <h3 class="detail-section-title">Customer &amp; Vehicle</h3>
        <div class="form-grid">
          <div class="field">
            <label for="jf-customer">Customer <span class="req">*</span></label>
            <select class="select" id="jf-customer" name="customerId">${customerOptions(j.customerId)}</select>
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field">
            <label for="jf-vehicle">Vehicle <span class="req">*</span></label>
            <select class="select" id="jf-vehicle" name="vehicleId">${vehicleOptions(j.customerId, j.vehicleId)}</select>
            <div class="field__error" data-err="vehicleId"></div>
          </div>
          <div class="field">
            <label for="jf-mechanic">Mechanic <span class="req">*</span></label>
            <select class="select" id="jf-mechanic" name="mechanicId">${mechanicOptions(j.mechanicId)}</select>
            <div class="field__error" data-err="mechanicId"></div>
          </div>
          <div class="field">
            <label for="jf-priority">Priority</label>
            <select class="select" id="jf-priority" name="priority">
              ${Object.entries(PRIORITIES).map(([v, l]) => `<option value="${v}"${(j.priority || 'normal') === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="jf-date">Date <span class="req">*</span></label>
            <input class="input" id="jf-date" name="date" type="date" value="${esc(j.date || todayStr())}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label for="jf-est">Estimated Delivery</label>
            <input class="input" id="jf-est" name="estDelivery" type="date" value="${esc(j.estDelivery || '')}">
            <div class="field__error" data-err="estDelivery"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Vehicle Check-in</h3>
        <div class="form-grid">
          <div class="field">
            <label for="jf-mileage">Mileage In (km)</label>
            <input class="input" id="jf-mileage" name="mileage" type="number" min="0" value="${esc(j.mileage ?? '')}">
            <div class="field__error" data-err="mileage"></div>
          </div>
          <div class="field">
            <label for="jf-mileage-out">Mileage Out (km)</label>
            <input class="input" id="jf-mileage-out" name="mileageOut" type="number" min="0" value="${esc(j.mileageOut ?? '')}">
            <div class="field__error" data-err="mileageOut"></div>
          </div>
          <div class="field">
            <label for="jf-fuel">Fuel Level</label>
            <select class="select" id="jf-fuel" name="fuelLevel">
              <option value="">— Not recorded —</option>
              ${FUEL_LEVELS.map(f => `<option value="${f}"${j.fuelLevel === f ? ' selected' : ''}>${FUEL_LABELS[f]}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="jf-condition">Vehicle Condition / Belongings</label>
            <input class="input" id="jf-condition" name="conditionNotes" value="${esc(j.conditionNotes || '')}" placeholder="Existing damage, valuables, etc.">
          </div>
          <div class="field span-2">
            <label for="jf-complaint">Customer Complaint / Requested Work <span class="req">*</span></label>
            <textarea class="textarea" id="jf-complaint" name="complaint" rows="2">${esc(j.complaint || '')}</textarea>
            <div class="field__error" data-err="complaint"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Workshop Findings</h3>
        <div class="form-grid">
          <div class="field span-2">
            <label for="jf-inspection">Initial Inspection Summary</label>
            <textarea class="textarea" id="jf-inspection" name="inspection" rows="2">${esc(j.inspection || '')}</textarea>
          </div>
          <div class="field span-2">
            <label for="jf-diagnosis">Diagnosis</label>
            <textarea class="textarea" id="jf-diagnosis" name="diagnosis" rows="2">${esc(j.diagnosis || '')}</textarea>
          </div>
          <div class="field">
            <label for="jf-technotes">Technician Notes</label>
            <textarea class="textarea" id="jf-technotes" name="technicianNotes" rows="2">${esc(j.technicianNotes || '')}</textarea>
          </div>
          <div class="field">
            <label for="jf-recommend">Recommendations</label>
            <textarea class="textarea" id="jf-recommend" name="recommendations" rows="2">${esc(j.recommendations || '')}</textarea>
          </div>
        </div>

        <h3 class="detail-section-title">Services</h3>
        <div class="line-head"><span>Service</span><span>Qty</span><span>Unit Price</span><span>Total</span><span></span></div>
        <div id="serviceLines">${services.map(serviceLineHtml).join('')}</div>
        <button type="button" class="btn btn--ghost btn--sm" id="addServiceLine">+ Add Service</button>
        <div class="field__error" data-err="services"></div>

        <h3 class="detail-section-title">Parts Used <span class="muted-note-inline">(manual entry until Inventory module)</span></h3>
        <div class="line-head line-head--part"><span>Part</span><span>Part No.</span><span>Qty</span><span>Unit Price</span><span>Total</span><span></span></div>
        <div id="partLines">${parts.map(partLineHtml).join('')}</div>
        <button type="button" class="btn btn--ghost btn--sm" id="addPartLine">+ Add Part</button>

        <h3 class="detail-section-title">Labour</h3>
        <div class="form-grid form-grid--3">
          <div class="field">
            <label for="jf-lhours">Hours</label>
            <input class="input" id="jf-lhours" name="labourHours" type="number" min="0" step="0.5" value="${esc(j.labourHours ?? '')}">
            <div class="field__error" data-err="labourHours"></div>
          </div>
          <div class="field">
            <label for="jf-lrate">Rate (BDT/hr)</label>
            <input class="input" id="jf-lrate" name="labourRate" type="number" min="0" step="50" value="${esc(j.labourRate ?? '')}">
            <div class="field__error" data-err="labourRate"></div>
          </div>
          <div class="field">
            <label for="jf-lcost">Labour Total (or direct amount)</label>
            <input class="input" id="jf-lcost" name="labourCost" type="number" min="0" step="50" value="${esc(j.labourCost ?? 0)}">
            <div class="field__error" data-err="labourCost"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Inspection Checklist</h3>
        <div class="insp-grid">${inspectionRowsHtml(j.inspectionChecklist)}</div>

        <h3 class="detail-section-title">Billing</h3>
        <div class="form-grid form-grid--3">
          <div class="field">
            <label for="jf-discount">Discount (BDT)</label>
            <input class="input" id="jf-discount" name="discount" type="number" min="0" step="50" value="${esc(j.discount ?? 0)}">
            <div class="field__error" data-err="discount"></div>
          </div>
          <div class="field">
            <label for="jf-taxrate">Tax Rate (%)</label>
            <input class="input" id="jf-taxrate" name="taxRate" type="number" min="0" max="100" step="0.5" value="${esc(j.taxRate ?? settings.taxRate ?? 0)}">
            <div class="field__error" data-err="taxRate"></div>
          </div>
          <div class="field">
            <label for="jf-paid">Paid / Advance (BDT)</label>
            <input class="input" id="jf-paid" name="paid" type="number" min="0" step="50" value="${esc(j.paid ?? 0)}">
            <div class="field__error" data-err="paid"></div>
          </div>
        </div>

        <div class="totals-panel" id="totalsPanel"></div>

        <div class="field" style="margin-top:14px">
          <label for="jf-notes">General Notes</label>
          <textarea class="textarea" id="jf-notes" name="notes" rows="2">${esc(j.notes || '')}</textarea>
        </div>
      </form>`;
  }

  /* ---------- form interactions: cascade, lines, live totals ---------- */

  function readLines(ov) {
    const services = [...ov.querySelectorAll('[data-line="service"]')].map(row => {
      const sel = row.querySelector('.line-service');
      const opt = sel.selectedOptions[0];
      return {
        serviceId: sel.value,
        name: opt ? (opt.dataset.name || opt.textContent.replace(/ \(inactive\)$/, '')) : '',
        qty: Number(row.querySelector('.line-qty').value) || 0,
        unitPrice: Number(row.querySelector('.line-price').value) || 0
      };
    });
    const parts = [...ov.querySelectorAll('[data-line="part"]')].map(row => {
      const sel = row.querySelector('.line-part');
      const opt = sel.selectedOptions[0];
      const manualName = row.dataset.manualName || '';
      return {
        partId: sel.value || null,
        name: sel.value
          ? (opt ? opt.textContent.split(' — stock:')[0].replace(/ \(inactive\)$/, '') : '')
          : manualName,
        partNo: row.querySelector('.line-partno').value,
        qty: Number(row.querySelector('.line-qty').value) || 0,
        unitPrice: Number(row.querySelector('.line-price').value) || 0
      };
    });
    return { services, parts };
  }

  function readInspection(ov) {
    const checklist = {};
    ov.querySelectorAll('.insp-row').forEach(row => {
      const state = row.querySelector('.insp-state').value;
      const note = row.querySelector('.insp-note').value.trim();
      if (state || note) checklist[row.dataset.insp] = { state, note };
    });
    return checklist;
  }

  function updateLiveTotals(ov) {
    const form = ov.querySelector('#jobForm');
    const { services, parts } = readLines(ov);
    const t = computeTotals({
      services, partsUsed: parts,
      labourHours: form.labourHours.value, labourRate: form.labourRate.value,
      labourCost: form.labourCost.value,
      discount: form.discount.value, taxRate: form.taxRate.value, paid: form.paid.value
    });
    // keep labour total field in sync when hours×rate are supplied
    const h = Number(form.labourHours.value) || 0, r = Number(form.labourRate.value) || 0;
    if (h > 0 && r > 0) form.labourCost.value = h * r;

    // per-line totals
    ov.querySelectorAll('.line-row').forEach(row => {
      const qty = Number(row.querySelector('.line-qty').value) || 0;
      const price = Number(row.querySelector('.line-price').value) || 0;
      row.querySelector('.line-total').textContent = money(qty * price);
    });

    ov.querySelector('#totalsPanel').innerHTML = `
      <div><span>Services</span><strong>${money(t.serviceTotal)}</strong></div>
      <div><span>Parts</span><strong>${money(t.partsTotal)}</strong></div>
      <div><span>Labour</span><strong>${money(t.labourCost)}</strong></div>
      <div><span>Subtotal</span><strong>${money(t.subtotal)}</strong></div>
      <div><span>Discount</span><strong>− ${money(t.discount)}</strong></div>
      <div><span>Tax (${t.taxRate}%)</span><strong>+ ${money(t.tax)}</strong></div>
      <div class="totals-grand"><span>Grand Total</span><strong>${money(t.total)}</strong></div>
      <div><span>Paid</span><strong>${money(t.paid)}</strong></div>
      <div class="${t.due > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(t.due)}</strong></div>`;
  }

  function bindFormEvents(ov, isEdit) {
    const form = ov.querySelector('#jobForm');

    // customer → vehicle cascade
    form.customerId.addEventListener('change', () => {
      form.vehicleId.innerHTML = vehicleOptions(form.customerId.value, '');
    });

    // appointment source (create only)
    const srcSel = ov.querySelector('#jf-source');
    if (srcSel) {
      const aptWrap = ov.querySelector('#jf-apt-wrap');
      const aptSel = ov.querySelector('#jf-appointment');
      srcSel.addEventListener('change', () => {
        aptWrap.hidden = srcSel.value !== 'appointment';
        if (srcSel.value !== 'appointment') aptSel.value = '';
      });
      aptSel.addEventListener('change', () => {
        const a = Storage.getById('appointments', aptSel.value);
        if (!a) return;
        // Prefill customer/vehicle/mechanic + the appointment's service
        form.customerId.value = a.customerId;
        form.vehicleId.innerHTML = vehicleOptions(a.customerId, a.vehicleId);
        if (a.mechanicId) form.mechanicId.value = a.mechanicId;
        if (a.complaint && !form.complaint.value.trim()) form.complaint.value = a.complaint;
        if (a.serviceId) {
          const host = ov.querySelector('#serviceLines');
          const svcRec = Storage.getById('services', a.serviceId);
          host.innerHTML = serviceLineHtml(svcRec
            ? { serviceId: a.serviceId, name: svcRec.name, qty: 1, unitPrice: Number(svcRec.price) || 0 }
            : {});
        }
        updateLiveTotals(ov);
      });
      // If opened with a preselected appointment, apply it now
      if (aptSel.value) aptSel.dispatchEvent(new Event('change'));
    }

    // line add/remove + price snapshot on service pick
    ov.querySelector('#addServiceLine').addEventListener('click', () => {
      ov.querySelector('#serviceLines').insertAdjacentHTML('beforeend', serviceLineHtml());
      updateLiveTotals(ov);
    });
    ov.querySelector('#addPartLine').addEventListener('click', () => {
      ov.querySelector('#partLines').insertAdjacentHTML('beforeend', partLineHtml());
      updateLiveTotals(ov);
    });
    ov.querySelector('.modal__body').addEventListener('click', e => {
      const rm = e.target.closest('[data-remove-line]');
      if (rm) { rm.closest('.line-row').remove(); updateLiveTotals(ov); }
    });
    ov.querySelector('.modal__body').addEventListener('change', e => {
      // when the user picks a service, snapshot the current catalog price
      if (e.target.classList.contains('line-service')) {
        const opt = e.target.selectedOptions[0];
        const priceInput = e.target.closest('.line-row').querySelector('.line-price');
        if (opt && opt.dataset.price != null && opt.value) priceInput.value = opt.dataset.price;
      }
      // when the user picks an inventory part, snapshot selling price + part no.
      if (e.target.classList.contains('line-part')) {
        const opt = e.target.selectedOptions[0];
        const row = e.target.closest('.line-row');
        if (opt && opt.value) {
          if (opt.dataset.price != null) row.querySelector('.line-price').value = opt.dataset.price;
          if (opt.dataset.partno != null) row.querySelector('.line-partno').value = opt.dataset.partno;
        }
      }
      updateLiveTotals(ov);
    });
    ov.querySelector('.modal__body').addEventListener('input', e => {
      if (e.target.matches('.line-qty, .line-price, #jf-lhours, #jf-lrate, #jf-lcost, #jf-discount, #jf-taxrate, #jf-paid')) {
        // typing hours/rate recomputes labour; typing labourCost directly clears hours×rate precedence
        if (e.target.id === 'jf-lcost') { form.labourHours.value = ''; form.labourRate.value = ''; }
        updateLiveTotals(ov);
      }
    });

    updateLiveTotals(ov);
  }

  /* ---------- validation ---------- */

  function readForm(ov) {
    const form = ov.querySelector('#jobForm');
    const val = n => form[n] ? form[n].value.trim() : '';
    const num = n => form[n] && form[n].value !== '' ? Number(form[n].value) : '';
    const { services, parts } = readLines(ov);
    const srcSel = ov.querySelector('#jf-source');
    return {
      appointmentId: srcSel
        ? (srcSel.value === 'appointment' ? val('appointmentId') : null)
        : undefined, // edit: appointmentId untouched
      customerId: val('customerId'), vehicleId: val('vehicleId'), mechanicId: val('mechanicId'),
      priority: val('priority') || 'normal',
      date: val('date'), estDelivery: val('estDelivery'),
      mileage: num('mileage'), mileageOut: num('mileageOut'),
      fuelLevel: val('fuelLevel'), conditionNotes: val('conditionNotes'),
      complaint: val('complaint'), inspection: val('inspection'),
      diagnosis: val('diagnosis'), technicianNotes: val('technicianNotes'),
      recommendations: val('recommendations'), notes: val('notes'),
      services, parts,
      inspectionChecklist: readInspection(ov),
      labourHours: num('labourHours'), labourRate: num('labourRate'), labourCost: num('labourCost') || 0,
      discount: num('discount') || 0, taxRate: num('taxRate') || 0, paid: num('paid') || 0
    };
  }

  function validate(v, editingJob = null) {
    const errors = {};

    if (!v.customerId) errors.customerId = 'Select a customer.';
    else if (!Storage.getById('customers', v.customerId)) errors.customerId = 'Selected customer no longer exists.';

    if (!v.vehicleId) errors.vehicleId = 'Select a vehicle.';
    else {
      const vehicle = Storage.getById('vehicles', v.vehicleId);
      if (!vehicle) errors.vehicleId = 'Selected vehicle no longer exists.';
      else if (vehicle.customerId !== v.customerId) errors.vehicleId = 'Selected vehicle does not belong to this customer.';
    }

    if (!v.mechanicId) errors.mechanicId = 'Select a mechanic.';
    else if (!Storage.getById('mechanics', v.mechanicId)) errors.mechanicId = 'Selected mechanic no longer exists.';

    if (!v.date) errors.date = 'Job date is required.';
    else if (isNaN(new Date(v.date))) errors.date = 'Enter a valid date.';

    if (!v.complaint) errors.complaint = 'Record the customer complaint / requested work.';

    // appointment integrity (create-from-appointment only)
    if (v.appointmentId) {
      const a = Storage.getById('appointments', v.appointmentId);
      if (!a) errors.appointmentId = 'Selected appointment no longer exists.';
      else {
        if (a.customerId !== v.customerId) errors.appointmentId = 'Appointment belongs to a different customer.';
        else if (a.vehicleId !== v.vehicleId) errors.appointmentId = 'Appointment is for a different vehicle.';
        else if (a.jobCardId && (!editingJob || a.jobCardId !== editingJob.id)) {
          errors.appointmentId = `Job Card already exists for this appointment (${a.jobCardId}).`;
        }
      }
    }

    // valid service lines: id must exist; qty>0; price>=0
    const badService = v.services.find(l => l.serviceId && !Storage.getById('services', l.serviceId));
    if (badService) errors.services = 'A selected service no longer exists in the catalog.';
    else if (v.services.some(l => l.serviceId && (l.qty <= 0 || l.unitPrice < 0)))
      errors.services = 'Service quantity must be > 0 and price cannot be negative.';
    else if (!v.services.some(l => l.serviceId) && !v.parts.some(p => p.name.trim()) && !(Number(v.labourCost) > 0 || (Number(v.labourHours) > 0 && Number(v.labourRate) > 0)))
      errors.services = 'Add at least one service, part, or labour entry.';

    if (v.parts.some(p => p.name.trim() && (p.qty <= 0 || p.unitPrice < 0)))
      errors.services = errors.services || 'Part quantity must be > 0 and price cannot be negative.';
    if (v.parts.some(p => p.partId && !Storage.getById('parts', p.partId)))
      errors.services = errors.services || 'A selected part no longer exists in inventory.';

    if (v.mileage !== '' && v.mileage < 0) errors.mileage = 'Mileage cannot be negative.';
    if (v.mileageOut !== '') {
      if (v.mileageOut < 0) errors.mileageOut = 'Mileage cannot be negative.';
      else if (v.mileage !== '' && v.mileageOut < v.mileage) errors.mileageOut = 'Mileage Out cannot be lower than Mileage In.';
    }

    if (v.labourHours !== '' && v.labourHours < 0) errors.labourHours = 'Hours cannot be negative.';
    if (v.labourRate !== '' && v.labourRate < 0) errors.labourRate = 'Rate cannot be negative.';
    if (v.labourCost < 0) errors.labourCost = 'Labour cannot be negative.';
    if (v.discount < 0) errors.discount = 'Discount cannot be negative.';
    if (v.taxRate < 0 || v.taxRate > 100) errors.taxRate = 'Tax rate must be between 0 and 100.';
    if (v.paid < 0) errors.paid = 'Paid amount cannot be negative.';

    if (v.estDelivery && v.date && v.estDelivery < v.date)
      errors.estDelivery = 'Estimated Delivery cannot be earlier than the Job Date.';

    // discount must not exceed subtotal; paid must not exceed grand total
    const t = computeTotals({ services: v.services, partsUsed: v.parts, labourHours: v.labourHours, labourRate: v.labourRate, labourCost: v.labourCost, discount: v.discount, taxRate: v.taxRate, paid: 0 });
    if (v.discount > t.subtotal) errors.discount = 'Discount cannot exceed the subtotal.';
    if (v.paid > t.total) errors.paid = 'Paid amount cannot exceed the grand total.';

    return { valid: Object.keys(errors).length === 0, errors };
  }

  function showErrors(ov, errors) {
    const form = ov.querySelector('#jobForm');
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    ov.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const el = ov.querySelector(`[data-err="${key}"]`);
      if (el) {
        el.textContent = msg;
        const field = el.closest('.field');
        if (field) field.classList.add('field--error');
      }
    });
  }

  /** Build the final record from validated values with recalculated totals. */
  function buildRecord(v) {
    const services = normalizeLines(v.services, true);
    const partsUsed = normalizeLines(v.parts, false);
    const draft = { ...v, services, partsUsed };
    const t = computeTotals(draft);
    return {
      customerId: v.customerId, vehicleId: v.vehicleId, mechanicId: v.mechanicId,
      priority: v.priority, date: v.date, estDelivery: v.estDelivery,
      mileage: v.mileage === '' ? '' : v.mileage,
      mileageOut: v.mileageOut === '' ? null : v.mileageOut,
      fuelLevel: v.fuelLevel, conditionNotes: v.conditionNotes,
      complaint: v.complaint, inspection: v.inspection,
      diagnosis: v.diagnosis, technicianNotes: v.technicianNotes,
      recommendations: v.recommendations, notes: v.notes,
      services, partsUsed, inspectionChecklist: v.inspectionChecklist,
      labourHours: v.labourHours === '' ? '' : v.labourHours,
      labourRate: v.labourRate === '' ? '' : v.labourRate,
      labourCost: t.labourCost,
      discount: t.discount, taxRate: t.taxRate,
      subtotal: t.subtotal, tax: t.tax, total: t.total, paid: t.paid, due: t.due
    };
  }

  /**
   * The same record, minus the four figures the server derives from the lines
   * and refuses by name (routes/job-cards.js SERVER_OWNED). Sending any of
   * them -- even a value that matches what the server would compute -- is a
   * 422, because a client must not be able to assert a total the lines do not
   * support.
   *
   * `paid` is deliberately NOT stripped: it is a real input on this form and
   * the server stores it as sent, which is what makes it the frozen snapshot
   * audit Finding 1 depends on. `labourCost` stays too -- it is an input the
   * server only overrides when hours x rate is higher.
   *
   * buildRecord() keeps all four because 'local' mode has no server to compute
   * them: there, the record is what gets stored and read back.
   */
  function forApi(record) {
    const { subtotal, tax, total, due, ...rest } = record;
    return rest;
  }

  /* ---------- create / edit ---------- */

  function openCreateModal(fromAppointmentId = '') {
    if (!Storage.getData('customers').length) {
      Modal.open({
        title: 'No customers yet',
        body: `<p style="margin:0">A job card needs a customer and their vehicle. Add a customer first.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <a class="btn btn--primary" href="customers.html">Go to Customers</a>`
      });
      return;
    }
    // duplicate guard when arriving from a specific appointment
    if (fromAppointmentId) {
      const a = Storage.getById('appointments', fromAppointmentId);
      if (!a) { toast('That appointment no longer exists.', 'error'); fromAppointmentId = ''; }
      else if (a.jobCardId) {
        Modal.open({
          title: 'Job Card already exists',
          body: `<p style="margin:0">Job Card already exists for this appointment: <strong>${esc(a.jobCardId)}</strong>.</p>`,
          footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                   <button class="btn btn--primary" data-open-existing>Open ${esc(a.jobCardId)}</button>`
        }).querySelector('[data-open-existing]').addEventListener('click', () => {
          Modal.close();
          openDetailModal(a.jobCardId);
        });
        return;
      }
    }

    const ov = Modal.open({
      title: 'New Job Card', size: 'lg',
      body: formHtml({}, fromAppointmentId),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Open Job Card</button>`
    });
    bindFormEvents(ov, false);

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = readForm(ov);
      if (ov.querySelector('#jf-source').value === 'appointment' && !v.appointmentId) {
        showErrors(ov, { appointmentId: 'Select the appointment, or switch to Walk-in.' });
        toast('Please fix the highlighted fields.', 'error');
        return;
      }
      const { valid, errors } = validate(v);
      if (!valid) { showErrors(ov, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      // Totals are recomputed from the lines on the server, so what is sent
      // is the lines -- not a subtotal it would have to take on trust. Local
      // mode has no server, so there the computed record is stored as built.
      const record = buildRecord(v);
      const created = await Storage.create('jobCards', {
        ...(Storage.isApi() ? forApi(record) : record),
        appointmentId: v.appointmentId || null,
        invoiceId: null,
        completedAt: null,
        actualDelivery: '',
        status: 'Received'
      });
      if (!Utils.wrote(created, ov)) return;
      const rec = created.record;

      // Appointment sync: link only. The appointment keeps its status
      // (Scheduled/Confirmed) until workshop work actually starts —
      // see changeStatus(): Job Card → In Progress moves it.
      if (v.appointmentId) {
        const a = Storage.getById('appointments', v.appointmentId);
        if (a && !a.jobCardId) {
          // The same transaction stamped the appointment's jobCardId server
          // side; re-reading is how this copy learns about it.
          if (Storage.isApi()) await Storage.refreshAll('appointments');
          else Storage.updateData('appointments', v.appointmentId, { jobCardId: rec.id });
        }
      }

      Modal.close();
      refresh();
      toast(`Job Card ${rec.id} opened for ${custName(rec.customerId)}.`);
    }));
  }

  function openEditModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    if (TERMINAL.includes(j.status)) {
      toast(`${j.status} job cards are read-only.`, 'info');
      return;
    }
    const ov = Modal.open({
      title: `Edit Job Card — ${j.id}`, size: 'lg',
      body: formHtml(j),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    bindFormEvents(ov, true);

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = readForm(ov);
      const { valid, errors } = validate(v, j);
      if (!valid) { showErrors(ov, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const proposed = buildRecord(v);

      // With a backend the whole edit -- the job card, both line tables, the
      // stock reconciliation against the LEDGER and the movements it implies
      // -- is one transaction on the server, guarded so a plan made against a
      // stale issued balance rolls the batch back rather than deducting the
      // same units twice. Reconciling here as well would deduct them twice.
      if (Storage.isApi()) {
        const res = await Storage.update('jobCards', id, forApi(proposed));
        if (!res.ok) {
          if (res.status === 409) {
            // A shortage, in the server's own words, in the dialog this
            // screen has always used for one.
            Modal.open({
              title: 'Insufficient stock for this change',
              body: `<p style="margin:0">${esc(res.message)}</p>
                     <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                     Receive stock in Inventory first, then save your changes again. This Job Card was not modified.</p>`,
              footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                       <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
            });
            return;
          }
          Utils.wrote(res, ov);
          return;
        }
        const stale = await Storage.refreshAll('parts', 'inventoryTransactions');
        Modal.close();
        refresh();
        if (stale.length) Utils.wrote({ ok: true, stale });
        else toast(`Job Card ${id} updated.`);
        return;
      }

      // INVENTORY: once a job has started issuing stock (In Progress /
      // Waiting for Parts), an edit to partsUsed must reconcile against
      // what's actually been deducted — not just overwrite the record.
      // reconcileJobInventory validates every deduction against live
      // stock BEFORE writing anything; on a shortage nothing is moved
      // and the Job Card edit itself is not saved.
      let reconciled = null;
      if (INVENTORY_TRACKED_STATUSES.includes(j.status)) {
        reconciled = await Utils.Inventory.reconcileJobInventory(j, proposed);
        if (!reconciled.ok) {
          const s = reconciled.shortages[0];
          Modal.open({
            title: 'Insufficient stock for this change',
            body: `<p style="margin:0">Insufficient stock for <strong>${esc(s.name)}</strong>.
                   Available: ${s.available}, Additional required: ${s.required}.</p>
                   ${reconciled.shortages.length > 1 ? `<p style="margin:8px 0 0;font-size:.84rem;color:var(--text-2)">${reconciled.shortages.length - 1} more part${reconciled.shortages.length > 2 ? 's are' : ' is'} also short.</p>` : ''}
                   <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                   Receive stock in Inventory first, then save your changes again. This Job Card was not modified.</p>`,
            footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                     <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
          });
          return; // Job Card changes are NOT saved — nothing was touched.
        }
      }

      // id, createdAt, appointmentId, invoiceId, status, completedAt preserved;
      // updatedAt set by Storage.updateData
      Storage.updateData('jobCards', id, proposed);
      Modal.close();
      refresh();
      if (reconciled && reconciled.applied.length) {
        const parts = reconciled.applied.map(a => `${a.name} (${a.delta > 0 ? '+' : ''}${a.delta})`).join(', ');
        toast(`Job Card ${id} updated. Stock adjusted: ${parts}.`, 'info');
      } else {
        toast(`Job Card ${id} updated.`);
      }
    }));
  }

  /* ---------- status lifecycle ---------- */

  async function changeStatus(id, next) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    if (!(TRANSITIONS[j.status] || []).includes(next)) {
      toast(`Cannot change ${j.status} job card to ${next}.`, 'error');
      return;
    }

    // INVENTORY: entering In Progress issues the job's inventory parts.
    // Utils.Inventory.deductForJob is idempotent (per part+job transaction
    // check), so In Progress ⇄ Waiting ping-pong never double-deducts.
    if (next === 'In Progress') {
      const shortages = Utils.Inventory.checkJobStock(j);
      if (shortages.length) {
        const s = shortages[0];
        Modal.open({
          title: 'Insufficient stock',
          body: `<p style="margin:0">Insufficient stock for <strong>${esc(s.name)}</strong>.
                 Available: ${s.available}, Required: ${s.required}.</p>
                 ${shortages.length > 1 ? `<p style="margin:8px 0 0;font-size:.84rem;color:var(--text-2)">${shortages.length - 1} more part${shortages.length > 2 ? 's are' : ' is'} also short.</p>` : ''}
                 <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                 Receive stock in Inventory first, or move the job to Waiting for Parts.</p>`,
          footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                   <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
        });
        return;
      }
    }

    const apply = async () => {
      // A status change is ONE transaction on the server: the gate (which
      // refuses a move the table does not list), the stock it implies --
      // issued entering In Progress, returned on Cancelled -- completedAt,
      // actualDelivery and the appointment sync all move together, or none
      // of them does. Repeating any of it here would apply it twice, and
      // the deduction's own NOT EXISTS would then refuse the second.
      if (Storage.isApi()) {
        const res = await Storage.action('jobCards', id, 'status', { status: next },
          ['parts', 'inventoryTransactions', 'appointments']);
        if (!res.ok) {
          if (res.status === 409) {
            Modal.open({
              title: next === 'In Progress' ? 'Insufficient stock' : 'Cannot change status',
              body: `<p style="margin:0">${esc(res.message)}</p>`,
              footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                       ${next === 'In Progress' ? '<a class="btn btn--primary" href="inventory.html">Go to Inventory</a>' : ''}`
            });
            return;
          }
          Utils.wrote(res);
          return;
        }
        refresh();
        toast(`Job Card ${id} → ${next}.`, next === 'Cancelled' ? 'warning' : 'success');
        return;
      }

      const changes = { status: next };
      if (next === 'Completed' && !j.completedAt) changes.completedAt = new Date().toISOString();
      if (next === 'Delivered' && !j.actualDelivery) changes.actualDelivery = todayStr();
      Storage.updateData('jobCards', id, changes);

      if (next === 'In Progress') {
        const res = await Utils.Inventory.deductForJob(Storage.getById('jobCards', id));
        if (res.deducted > 0) toast(`Stock issued for ${res.deducted} part line${res.deducted > 1 ? 's' : ''}.`, 'info');
      }
      if (next === 'Cancelled') {
        const returned = await Utils.Inventory.returnForJob(j);
        if (returned > 0) toast(`Stock returned for ${returned} part line${returned > 1 ? 's' : ''}.`, 'info');
      }

      // Appointment sync (one-way, no circular updates):
      // work actually starting moves the appointment to In Progress;
      // job completion completes it. Terminal appointments never change.
      if (j.appointmentId) {
        const a = Storage.getById('appointments', j.appointmentId);
        const aptTerminal = ['Completed', 'Cancelled', 'No Show'];
        if (a && !aptTerminal.includes(a.status)) {
          if (next === 'In Progress' && a.status !== 'In Progress') {
            Storage.updateData('appointments', j.appointmentId, { status: 'In Progress' });
          } else if (next === 'Completed') {
            Storage.updateData('appointments', j.appointmentId, { status: 'Completed' });
          }
        }
      }
      refresh();
      toast(`Job Card ${id} → ${next}.`, next === 'Cancelled' ? 'warning' : 'success');
    };

    if (next === 'Cancelled') {
      Modal.confirm({
        title: 'Cancel job card?',
        message: `Cancel <strong>${esc(id)}</strong>? All recorded work, findings, and amounts are preserved for history.`,
        confirmText: 'Cancel Job Card',
        onConfirm: apply
      });
    } else {
      await apply();
    }
  }

  /* ---------- delete policy ---------- */

  function openDeleteModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;

    const invoice = j.invoiceId ? Storage.getById('invoices', j.invoiceId) :
      Storage.getData('invoices').find(i => i.jobCardId === id);

    if (invoice) {
      Modal.open({
        title: 'Cannot delete job card',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> is linked to invoice
               <strong>${esc(invoice.id)}</strong>. Invoiced job cards are permanent business records.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (DONE.includes(j.status)) {
      Modal.open({
        title: 'Keep completed job cards',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> contains completed work — it's part of the
               vehicle's service history and shouldn't be deleted.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (!['Received', 'Cancelled'].includes(j.status)) {
      Modal.open({
        title: 'Work has started',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> is ${esc(j.status)}. Cancel the job card
               instead of deleting it, so the recorded work is preserved.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }

    Modal.confirm({
      title: 'Delete job card?',
      message: `Permanently delete <strong>${esc(j.id)}</strong> (${esc(custName(j.customerId))}, ${fmtDate(j.date)})? This cannot be undone.`,
      confirmText: 'Delete Job Card',
      onConfirm: async () => {
        if (Storage.isApi()) {
          // The appointment's link is cleared by the same delete on the
          // server -- job_cards and appointments reference each other, which
          // is why those two foreign keys are DEFERRABLE INITIALLY DEFERRED.
          const res = await Storage.remove('jobCards', id);
          if (!Utils.wrote(res)) return;
          const stale = j.appointmentId ? await Storage.refreshAll('appointments') : [];
          refresh();
          if (stale.length) Utils.wrote({ ok: true, stale });
          else toast(`Job Card ${id} deleted.`, 'warning');
          return;
        }
        // unlink from appointment if this was its job card
        if (j.appointmentId) {
          const a = Storage.getById('appointments', j.appointmentId);
          if (a && a.jobCardId === id) Storage.updateData('appointments', j.appointmentId, { jobCardId: null });
        }
        Storage.deleteData('jobCards', id);
        refresh();
        toast(`Job Card ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- details view ---------- */

  function linesTable(lines, isService) {
    if (!lines || !lines.length) return `<p class="muted-note">${isService ? 'No services added.' : 'No parts recorded.'}</p>`;
    return `<div class="table-wrap"><table class="table table--compact">
      <thead><tr>
        <th>${isService ? 'Service' : 'Part'}</th>${isService ? '' : '<th>Part No.</th>'}
        <th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Total</th>
      </tr></thead>
      <tbody>${lines.map(l => {
        const inactive = isService && l.serviceId && (() => { const s = svc(l.serviceId); return s && (s.status || 'Active') !== 'Active'; })();
        return `<tr>
          <td class="cell-main">${esc(l.name)}${inactive ? ' <span class="badge badge--neutral">Inactive</span>' : ''}</td>
          ${isService ? '' : `<td>${esc(l.partNo || '—')}</td>`}
          <td class="num">${l.qty}</td>
          <td class="num">${money(l.unitPrice)}</td>
          <td class="num">${money(l.total)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function inspectionTable(checklist) {
    const entries = Object.entries(checklist || {}).filter(([, v]) => v.state || v.note);
    if (!entries.length) return `<p class="muted-note">No inspection information recorded.</p>`;
    return `<div class="insp-view">${entries.map(([item, v]) => `
      <div class="insp-view__row">
        <span class="insp-label">${esc(item)}</span>
        ${v.state ? `<span class="badge badge--${{ OK: 'good', Attention: 'warn', Critical: 'bad' }[v.state] || 'neutral'}">${esc(v.state)}</span>` : ''}
        ${v.note ? `<span class="insp-note-text">${esc(v.note)}</span>` : ''}
      </div>`).join('')}</div>`;
  }

  function textBlock(title, value) {
    return value ? `<h3 class="detail-section-title">${title}</h3><p class="detail-text">${esc(value)}</p>` : '';
  }

  function openDetailModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    const vehicle = veh(j.vehicleId);
    const mechanic = mec(j.mechanicId);
    const t = computeTotals(j);
    // Defensive: only trust invoiceId if that invoice record still actually
    // exists (guards against a stale reference; mirrors the delete-guard
    // lookup used elsewhere).
    const linkedInvoice = j.invoiceId ? Storage.getById('invoices', j.invoiceId) : null;

    Modal.open({
      title: `Job Card ${j.id}`, size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Status</span><strong>${badge(j.status)}</strong></div>
          <div class="detail-item"><span>Priority</span><strong>${priorityBadge(j.priority)}</strong></div>
          <div class="detail-item"><span>Date</span><strong>${fmtDate(j.date)}</strong></div>
          <div class="detail-item"><span>Appointment</span><strong>${j.appointmentId ? esc(j.appointmentId) : '—'}</strong></div>
          <div class="detail-item"><span>Est. Delivery</span><strong>${j.estDelivery ? fmtDate(j.estDelivery) : '—'}</strong></div>
          <div class="detail-item"><span>Completed</span><strong>${j.completedAt ? fmtDate(j.completedAt) : '—'}</strong></div>
        </div>

        <h3 class="detail-section-title">Customer &amp; Vehicle</h3>
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Customer</span><strong>${esc(custName(j.customerId))}</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${esc(custPhone(j.customerId))}</strong></div>
          <div class="detail-item"><span>Registration</span><strong>${esc(vehReg(j.vehicleId))}</strong></div>
          <div class="detail-item"><span>Vehicle</span><strong>${esc(vehText(j.vehicleId))}</strong></div>
          <div class="detail-item"><span>VIN</span><strong>${vehicle && vehicle.vin ? esc(vehicle.vin) : 'N/A'}</strong></div>
          <div class="detail-item"><span>Mileage In / Out</span><strong>${j.mileage ? Number(j.mileage).toLocaleString('en-IN') : '—'} / ${j.mileageOut ? Number(j.mileageOut).toLocaleString('en-IN') : '—'} km</strong></div>
          <div class="detail-item"><span>Fuel Level</span><strong>${j.fuelLevel ? FUEL_LABELS[j.fuelLevel] || esc(j.fuelLevel) : '—'}</strong></div>
          <div class="detail-item"><span>Mechanic</span><strong>${esc(mecName(j.mechanicId))}${mechanic && (mechanic.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</strong></div>
          <div class="detail-item"><span>Specialization</span><strong>${mechanic ? esc(mechanic.specialization || 'General') : 'N/A'}</strong></div>
        </div>

        ${textBlock('Customer Complaint', j.complaint)}
        ${textBlock('Initial Inspection', j.inspection)}
        ${textBlock('Diagnosis', j.diagnosis)}
        ${textBlock('Technician Notes', j.technicianNotes)}
        ${textBlock('Recommendations', j.recommendations)}
        ${textBlock('Vehicle Condition / Belongings', j.conditionNotes)}

        <h3 class="detail-section-title">Services</h3>
        ${linesTable(j.services, true)}

        <h3 class="detail-section-title">Parts Used</h3>
        ${linesTable(j.partsUsed, false)}

        <h3 class="detail-section-title">Inspection Checklist</h3>
        ${inspectionTable(j.inspectionChecklist)}

        <h3 class="detail-section-title">Totals</h3>
        <div class="totals-panel totals-panel--view">
          <div><span>Services</span><strong>${money(t.serviceTotal)}</strong></div>
          <div><span>Parts</span><strong>${money(t.partsTotal)}</strong></div>
          <div><span>Labour${j.labourHours && j.labourRate ? ` (${j.labourHours} hr × ${money(j.labourRate)})` : ''}</span><strong>${money(t.labourCost)}</strong></div>
          <div><span>Subtotal</span><strong>${money(j.subtotal)}</strong></div>
          <div><span>Discount</span><strong>− ${money(j.discount)}</strong></div>
          <div><span>Tax (${j.taxRate || 0}%)</span><strong>+ ${money(j.tax)}</strong></div>
          <div class="totals-grand"><span>Grand Total</span><strong>${money(j.total)}</strong></div>
          <div><span>Paid</span><strong>${money(j.paid)}</strong></div>
          <div class="${Number(j.due) > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(j.due)}</strong></div>
        </div>

        ${textBlock('General Notes', j.notes)}`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${linkedInvoice ? `<a class="btn btn--ghost" href="invoices.html?view=${encodeURIComponent(linkedInvoice.id)}">View Invoice</a>` :
          (['Completed', 'Delivered'].includes(j.status) && Number(j.total) > 0 ? `<a class="btn btn--ghost" href="invoices.html?fromJobCard=${encodeURIComponent(j.id)}">Create Invoice</a>` : '')}
        ${!TERMINAL.includes(j.status) ? '<button class="btn btn--primary" data-edit-from-view>Edit Job Card</button>' : ''}`
    });
    const editBtn = document.querySelector('[data-edit-from-view]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openEditModal(id); });
    document.querySelector('[data-print-view]').addEventListener('click', () => printJobCard(id));
  }

  /* ---------- print ---------- */

  function printJobCard(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    const settings = Storage.getSettings();
    const vehicle = veh(j.vehicleId);
    const customer = Storage.getById('customers', j.customerId);

    const lineRows = (lines, isService) => (lines || []).map(l =>
      `<tr><td>${esc(l.name)}${!isService && l.partNo ? ` (${esc(l.partNo)})` : ''}</td>
       <td class="pr-num">${l.qty}</td><td class="pr-num">${money(l.unitPrice)}</td><td class="pr-num">${money(l.total)}</td></tr>`).join('');

    const inspRows = Object.entries(j.inspectionChecklist || {})
      .filter(([, v]) => v.state || v.note)
      .map(([item, v]) => `<tr><td>${esc(item)}</td><td>${esc(v.state || '—')}</td><td>${esc(v.note || '')}</td></tr>`).join('');

    document.getElementById('printArea').innerHTML = `
      <div class="pr-head">
        <div>
          <h1>${esc(settings.businessName)}</h1>
          <p>${esc(settings.address)} · ${esc(settings.phone)}</p>
        </div>
        <div class="pr-meta">
          <h2>JOB CARD</h2>
          <p><strong>${esc(j.id)}</strong></p>
          <p>${fmtDate(j.date)}</p>
        </div>
      </div>

      <div class="pr-cols">
        <div>
          <h3>Customer</h3>
          <p>${customer ? esc(customer.name) : 'Unknown Customer'}<br>${customer ? esc(customer.phone) : ''}</p>
        </div>
        <div>
          <h3>Vehicle</h3>
          <p>${vehicle ? esc(`${vehicle.brand} ${vehicle.model}`) : 'Unknown Vehicle'}<br>
             ${esc(vehReg(j.vehicleId))}<br>
             Mileage In: ${j.mileage ? Number(j.mileage).toLocaleString('en-IN') + ' km' : '—'}
             ${j.mileageOut ? `· Out: ${Number(j.mileageOut).toLocaleString('en-IN')} km` : ''}</p>
        </div>
        <div>
          <h3>Mechanic</h3>
          <p>${esc(mecName(j.mechanicId))}<br>Status: ${esc(j.status)} · Priority: ${PRIORITIES[j.priority || 'normal']}</p>
        </div>
      </div>

      ${j.complaint ? `<h3>Customer Complaint</h3><p>${esc(j.complaint)}</p>` : ''}
      ${j.diagnosis ? `<h3>Diagnosis</h3><p>${esc(j.diagnosis)}</p>` : ''}

      ${(j.services || []).length ? `<h3>Services</h3>
      <table class="pr-table"><thead><tr><th>Service</th><th class="pr-num">Qty</th><th class="pr-num">Unit</th><th class="pr-num">Total</th></tr></thead>
      <tbody>${lineRows(j.services, true)}</tbody></table>` : ''}

      ${(j.partsUsed || []).length ? `<h3>Parts</h3>
      <table class="pr-table"><thead><tr><th>Part</th><th class="pr-num">Qty</th><th class="pr-num">Unit</th><th class="pr-num">Total</th></tr></thead>
      <tbody>${lineRows(j.partsUsed, false)}</tbody></table>` : ''}

      ${inspRows ? `<h3>Inspection</h3>
      <table class="pr-table"><thead><tr><th>Item</th><th>Condition</th><th>Note</th></tr></thead>
      <tbody>${inspRows}</tbody></table>` : ''}

      <table class="pr-totals">
        <tr><td>Subtotal (services + parts + labour ${money(j.labourCost || 0)})</td><td class="pr-num">${money(j.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="pr-num">− ${money(j.discount)}</td></tr>
        <tr><td>Tax (${j.taxRate || 0}%)</td><td class="pr-num">+ ${money(j.tax)}</td></tr>
        <tr class="pr-grand"><td>Grand Total</td><td class="pr-num">${money(j.total)}</td></tr>
        <tr><td>Paid</td><td class="pr-num">${money(j.paid)}</td></tr>
        <tr><td>Due</td><td class="pr-num">${money(j.due)}</td></tr>
      </table>

      ${j.notes ? `<h3>Notes</h3><p>${esc(j.notes)}</p>` : ''}

      <div class="pr-sign">
        <div><span></span>Customer Signature</div>
        <div><span></span>Service Advisor</div>
      </div>
      <p class="pr-foot">${esc(settings.invoiceFooter)}</p>`;

    document.body.classList.add('printing-job');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-job'), 300);
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateMechanicFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addJobBtn').addEventListener('click', () => openCreateModal());
    document.getElementById('jobSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('jobQuick').addEventListener('change', e => { fQuick = e.target.value; renderList(); });
    document.getElementById('jobStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('jobPriority').addEventListener('change', e => { fPriority = e.target.value; renderList(); });
    document.getElementById('jobMechanic').addEventListener('change', e => { fMechanic = e.target.value; renderList(); });
    document.getElementById('jobDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('jobSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('jobTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openCreateModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      // A status change writes (and on a job card moves stock), so the row's
      // own button is held until the server answers. Delegated, so the button
      // is this row's rather than the one the listener sits on.
      if (action === 'status') { Utils.guard(btn, () => changeStatus(id, btn.dataset.next)); return; }
      if (action === 'print') printJobCard(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const fromApt = params.get('fromAppointment');
    if (viewId && Storage.getById('jobCards', viewId)) openDetailModal(viewId);
    else if (fromApt) openCreateModal(fromApt);
  });

})();
