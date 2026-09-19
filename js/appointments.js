/* ============================================================
   appointments.js — Appointments Management module
   Relationships are ID-based (customerId, vehicleId, serviceId,
   mechanicId); names are resolved at render time with safe
   fallbacks. Vehicle options cascade from the selected customer.
   Conflict detection uses real time-range overlap for both the
   mechanic and the vehicle. jobCardId is reserved for the future
   Job Card module; appointments with a jobCardId cannot be
   deleted.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, fmtTime, todayStr, toDateStr, badge, toast, Modal } = Utils;

  /* ---------- status model ---------- */

  const STATUSES = ['Scheduled', 'Confirmed', 'In Progress', 'Completed', 'Cancelled', 'No Show'];
  // legacy stored values from earlier seed versions
  const STATUS_ALIASES = { 'Pending': 'Scheduled', 'In Service': 'In Progress' };
  const TERMINAL = ['Completed', 'Cancelled', 'No Show'];
  // statuses that occupy the schedule (block conflicting bookings)
  const BLOCKING = ['Scheduled', 'Confirmed', 'In Progress'];

  // Allowed transitions: current → next[]
  const TRANSITIONS = {
    'Scheduled':   ['Confirmed', 'Cancelled', 'No Show'],
    'Confirmed':   ['In Progress', 'Cancelled', 'No Show'],
    'In Progress': ['Completed'],
    'Completed':   [],
    'Cancelled':   [],
    'No Show':     []
  };

  const normStatus = s => STATUS_ALIASES[s] || s || 'Scheduled';

  /* ---------- source model ---------- */

  // Where an appointment came from. These four strings are canonical: they are
  // stored verbatim and are the exact set a future backend/D1 column will
  // carry, so no separate display label is kept alongside them.
  //
  // All five are selectable in the management UI and accepted by validation.
  // 'Website' is also what the public site's API will send once bookings come
  // in that way, and 'Facebook' is reserved for the Facebook/messenger contact
  // workflow -- both are ordinary values here, so a booking that arrives by
  // either route and one recorded by hand end up in the same column.
  const SOURCES = ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website'];
  const DEFAULT_SOURCE = 'Admin';

  /**
   * Effective source for display and filtering. Appointments predating this
   * field (source undefined / null / '') read as 'Admin', resolved at READ
   * time exactly like normStatus() handles legacy status values -- no stored
   * record is rewritten. An unrecognised stored value falls back the same way
   * rather than breaking the UI; writes are rejected by validate() instead.
   */
  const normSource = s => (SOURCES.includes(s) ? s : DEFAULT_SOURCE);

  /* ---------- state ---------- */

  let searchTerm = '';
  let fQuick = 'all', fDate = '', fStatus = 'all', fMechanic = 'all', fSource = 'all';
  let sortBy = 'smart';

  /* ---------- safe lookups (never crash on missing refs) ---------- */

  const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
  const custPhone = id => (Storage.getById('customers', id) || {}).phone || '';
  const vehInfo = id => Storage.getById('vehicles', id);
  const vehText = id => { const v = vehInfo(id); return v ? `${v.brand} ${v.model}` : 'Unknown Vehicle'; };
  const vehReg = id => { const v = vehInfo(id); return v ? v.regNo : '—'; };
  const svcRec = id => Storage.getById('services', id);
  const svcName = id => (svcRec(id) || {}).name || 'Unknown Service';
  const mecRec = id => Storage.getById('mechanics', id);
  const mecName = id => id ? ((mecRec(id) || {}).name || 'Unknown Mechanic') : '—';

  /* ---------- time helpers ---------- */

  const toMinutes = hhmm => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const aptStart = a => toMinutes(a.time);
  const aptEnd = a => aptStart(a) + (Number(a.duration) || 60);
  const fmtDuration = mins => {
    const n = Number(mins) || 0;
    const h = Math.floor(n / 60), m = n % 60;
    if (h && m) return `${h} hr ${m} min`;
    if (h) return `${h} hr`;
    return `${m} min`;
  };
  const tomorrowStr = () => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return toDateStr(d);   // local calendar, never UTC
  };

  /* ---------- conflict detection ---------- */

  /**
   * Find active appointments overlapping the proposed slot.
   * Overlap rule: existingStart < newEnd AND existingEnd > newStart.
   * Cancelled / No Show / Completed appointments never block.
   */
  function findConflicts({ date, time, duration, mechanicId, vehicleId }, excludeId = null) {
    const newStart = toMinutes(time);
    const newEnd = newStart + (Number(duration) || 60);
    return Storage.getData('appointments').filter(a => {
      if (a.id === excludeId) return false;
      if (a.date !== date) return false;
      if (!BLOCKING.includes(normStatus(a.status))) return false;
      const overlap = aptStart(a) < newEnd && aptEnd(a) > newStart;
      if (!overlap) return false;
      const sameMechanic = mechanicId && a.mechanicId === mechanicId;
      const sameVehicle = vehicleId && a.vehicleId === vehicleId;
      return sameMechanic || sameVehicle;
    }).map(a => ({
      apt: a,
      reason: (mechanicId && a.mechanicId === mechanicId) ? 'mechanic' : 'vehicle'
    }));
  }

  function findDuplicate(values, excludeId = null) {
    return Storage.getData('appointments').find(a =>
      a.id !== excludeId &&
      a.customerId === values.customerId &&
      a.vehicleId === values.vehicleId &&
      a.serviceId === values.serviceId &&
      a.date === values.date &&
      a.time === values.time &&
      !['Cancelled'].includes(normStatus(a.status)));
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const appts = Storage.getData('appointments');
    const today = todayStr();
    const todayCount = appts.filter(a => a.date === today && normStatus(a.status) !== 'Cancelled').length;
    const upcoming = appts.filter(a =>
      (a.date > today || (a.date === today && BLOCKING.includes(normStatus(a.status)))) &&
      !TERMINAL.includes(normStatus(a.status))).length;
    const completed = appts.filter(a => normStatus(a.status) === 'Completed').length;
    const cancelled = appts.filter(a => ['Cancelled', 'No Show'].includes(normStatus(a.status))).length;

    const stats = [
      { label: 'Total Appointments', value: appts.length, tone: 'info',  icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z' },
      { label: "Today's Appointments", value: todayCount, tone: 'amber', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z' },
      { label: 'Upcoming', value: upcoming, tone: 'info',  icon: 'M10 6L8.6 7.4 13.2 12l-4.6 4.6L10 18l6-6-6-6z' },
      { label: 'Completed', value: completed, tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Cancelled / No Show', value: cancelled, tone: 'bad', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' }
    ];

    document.getElementById('aptStats').innerHTML = stats.map(s => `
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

  function filteredAppointments() {
    const term = searchTerm.trim().toLowerCase();
    const today = todayStr();

    let list = Storage.getData('appointments').filter(a => {
      const status = normStatus(a.status);
      if (term) {
        const hay = `${a.id} ${custName(a.customerId)} ${custPhone(a.customerId)} ${vehReg(a.vehicleId)} ${vehText(a.vehicleId)} ${svcName(a.serviceId)} ${mecName(a.mechanicId)}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fStatus !== 'all' && status !== fStatus) return false;
      if (fMechanic !== 'all' && a.mechanicId !== fMechanic) return false;
      // filters on the stored field (normalized), never on rendered text
      if (fSource !== 'all' && normSource(a.source) !== fSource) return false;
      if (fDate && a.date !== fDate) return false;
      if (fQuick === 'today' && a.date !== today) return false;
      if (fQuick === 'tomorrow' && a.date !== tomorrowStr()) return false;
      if (fQuick === 'upcoming' && (a.date < today || TERMINAL.includes(status))) return false;
      if (fQuick === 'past' && a.date >= today) return false;
      return true;
    });

    const key = a => `${a.date} ${a.time}`;
    const cmp = {
      // upcoming (active, future/today) ascending first; past/terminal after, most recent first
      'smart': (a, b) => {
        const rank = x => (x.date >= today && !TERMINAL.includes(normStatus(x.status))) ? 0 : 1;
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        return ra === 0 ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a));
      },
      'date-asc':     (a, b) => key(a).localeCompare(key(b)),
      'date-desc':    (a, b) => key(b).localeCompare(key(a)),
      'customer':     (a, b) => custName(a.customerId).localeCompare(custName(b.customerId)),
      'status':       (a, b) => normStatus(a.status).localeCompare(normStatus(b.status)) || key(a).localeCompare(key(b)),
      'created-desc': (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')
    }[sortBy];
    return list.sort(cmp);
  }

  function populateMechanicFilter() {
    const mechanics = Storage.getData('mechanics');
    const sel = document.getElementById('aptMechanic');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All mechanics</option>` +
      mechanics.map(m => `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  }

  function statusActionButtons(a) {
    const status = normStatus(a.status);
    const actions = {
      'Confirmed_next': null
    };
    const btn = (next, label, primary = false) =>
      `<button class="btn btn--sm ${primary ? 'btn--primary' : 'btn--ghost'}" data-action="status" data-next="${next}">${label}</button>`;
    const map = {
      'Scheduled':   btn('Confirmed', 'Confirm', true) + btn('Cancelled', 'Cancel') + btn('No Show', 'No Show'),
      'Confirmed':   btn('In Progress', 'Start', true) + btn('Cancelled', 'Cancel') + btn('No Show', 'No Show'),
      'In Progress': btn('Completed', 'Complete', true)
    };
    return map[status] || '';
  }

  function renderList() {
    const rows = filteredAppointments();
    const total = Storage.getData('appointments').length;
    const tbody = document.getElementById('aptTableBody');
    const isFiltered = searchTerm || fQuick !== 'all' || fDate || fStatus !== 'all' || fMechanic !== 'all' || fSource !== 'all';

    document.getElementById('aptCount').textContent =
      isFiltered ? `${rows.length} of ${total} appointments` : `${total} appointments`;

    if (!rows.length) {
      let msg = 'No appointments found.';
      if (fQuick === 'today') msg = 'No appointments scheduled for today.';
      else if (fQuick === 'upcoming') msg = 'No upcoming appointments.';
      else if (isFiltered) msg = 'No appointments match your search or filter.';
      tbody.innerHTML = `
        <tr><td colspan="11">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/></svg>
            <h3>${msg}</h3>
            <p>${isFiltered ? 'Try a different filter or date.' : 'Create your first appointment to get started.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">New Appointment</button>'}
          </div>
        </td></tr>`;
      return;
    }

    const today = todayStr();
    tbody.innerHTML = rows.map(a => {
      const status = normStatus(a.status);
      const svc = svcRec(a.serviceId);
      const svcInactive = svc && (svc.status || 'Active') !== 'Active';
      return `
      <tr data-id="${esc(a.id)}">
        <td class="cell-main">${esc(a.id)}</td>
        <td>${fmtDate(a.date)}${a.date === today ? '<span class="cell-sub">Today</span>' : ''}</td>
        <td>${fmtTime(a.time)}</td>
        <td class="cell-main">${esc(custName(a.customerId))}</td>
        <td>${esc(vehText(a.vehicleId))}<span class="cell-sub">${esc(vehReg(a.vehicleId))}</span></td>
        <td>${esc(svcName(a.serviceId))}${svcInactive ? '<span class="cell-sub">Service now inactive</span>' : ''}</td>
        <td>${esc(mecName(a.mechanicId))}</td>
        <td class="num">${fmtDuration(a.duration || 60)}</td>
        <td>${badge(status)}</td>
        <td>${badge(normSource(a.source))}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            ${statusActionButtons(a)}
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(a.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            ${!TERMINAL.includes(status) ? `
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(a.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>` : ''}
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(a.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------- add / edit form ---------- */

  function customerOptions(selected) {
    return `<option value="">— Select customer —</option>` +
      Storage.getData('customers').slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)} — ${esc(c.phone)}</option>`).join('');
  }

  function vehicleOptions(customerId, selected) {
    if (!customerId) return `<option value="">— Select customer first —</option>`;
    const vehicles = Storage.getData('vehicles').filter(v => v.customerId === customerId);
    if (!vehicles.length) return `<option value="">— No vehicles for this customer —</option>`;
    return `<option value="">— Select vehicle —</option>` +
      vehicles.map(v => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} — ${esc(v.brand)} ${esc(v.model)}</option>`).join('');
  }

  function serviceOptions(selected) {
    const services = Storage.getData('services');
    const active = services.filter(s => (s.status || 'Active') === 'Active');
    // keep an inactive service selectable only if it's the one already on this appointment
    const current = selected && services.find(s => s.id === selected);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    if (!list.length) return `<option value="">— No services available —</option>`;
    return `<option value="">— Select service —</option>` +
      list.sort((a, b) => a.name.localeCompare(b.name))
        .map(s => `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.name)} (${money(s.price)})${(s.status || 'Active') !== 'Active' ? ' — inactive' : ''}</option>`).join('');
  }

  function mechanicOptions(selected) {
    const mechanics = Storage.getData('mechanics');
    const active = mechanics.filter(m => (m.status || 'Active') === 'Active');
    const current = selected && mechanics.find(m => m.id === selected);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">— No mechanic assigned —</option>` +
      list.map(m => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)} — ${esc(m.specialization || 'General')}${(m.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  /**
   * Source options for the create and edit forms -- all five canonical values,
   * in the same order everywhere. A record's own source is always among them,
   * so editing an appointment never relabels where it came from; a legacy or
   * unrecognised value resolves to the default through normSource().
   */
  function sourceOptions(selected) {
    const current = normSource(selected);
    return SOURCES.map(sc =>
      `<option value="${esc(sc)}"${sc === current ? ' selected' : ''}>${esc(sc)}</option>`
    ).join('');
  }

  function formHtml(a = {}) {
    return `
      <form id="aptForm" novalidate>
        <div class="form-grid">
          <div class="field">
            <label for="af-customer">Customer <span class="req">*</span></label>
            <select class="select" id="af-customer" name="customerId">${customerOptions(a.customerId)}</select>
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field">
            <label for="af-vehicle">Vehicle <span class="req">*</span></label>
            <select class="select" id="af-vehicle" name="vehicleId">${vehicleOptions(a.customerId, a.vehicleId)}</select>
            <div class="field__error" data-err="vehicleId"></div>
          </div>
          <div class="field">
            <label for="af-service">Service <span class="req">*</span></label>
            <select class="select" id="af-service" name="serviceId">${serviceOptions(a.serviceId)}</select>
            <div class="field__error" data-err="serviceId"></div>
          </div>
          <div class="field">
            <label for="af-mechanic">Mechanic (optional)</label>
            <select class="select" id="af-mechanic" name="mechanicId">${mechanicOptions(a.mechanicId)}</select>
            <div class="field__error" data-err="mechanicId"></div>
          </div>
          <div class="field">
            <label for="af-date">Date <span class="req">*</span></label>
            <input class="input" id="af-date" name="date" type="date" value="${esc(a.date || todayStr())}" min="${a.id ? '' : todayStr()}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label for="af-time">Time <span class="req">*</span></label>
            <input class="input" id="af-time" name="time" type="time" value="${esc(a.time || '')}">
            <div class="field__error" data-err="time"></div>
          </div>
          <div class="field">
            <label for="af-duration">Duration (minutes) <span class="req">*</span></label>
            <select class="select" id="af-duration" name="duration">
              ${[30, 45, 60, 90, 120, 150, 180, 240].map(d =>
                `<option value="${d}"${(Number(a.duration) || 60) === d ? ' selected' : ''}>${fmtDuration(d)}</option>`).join('')}
            </select>
            <div class="field__error" data-err="duration"></div>
          </div>
          <div class="field">
            <label for="af-status">Status</label>
            <select class="select" id="af-status" name="status">
              ${(a.id
                ? [normStatus(a.status), ...(TRANSITIONS[normStatus(a.status)] || [])]
                : ['Scheduled', 'Confirmed'])
                .map(s => `<option${s === normStatus(a.status || 'Scheduled') ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="af-source">Source</label>
            <select class="select" id="af-source" name="source">${sourceOptions(a.source)}</select>
            <div class="field__error" data-err="source"></div>
          </div>
          <div class="field span-2">
            <label for="af-complaint">Customer Request / Complaint</label>
            <textarea class="textarea" id="af-complaint" name="complaint" rows="2">${esc(a.complaint || '')}</textarea>
          </div>
          <div class="field span-2">
            <label for="af-notes">Notes</label>
            <textarea class="textarea" id="af-notes" name="notes" rows="2">${esc(a.notes || '')}</textarea>
          </div>
        </div>
      </form>`;
  }

  function bindCascade(ov) {
    const custSel = ov.querySelector('#af-customer');
    const vehSel = ov.querySelector('#af-vehicle');
    custSel.addEventListener('change', () => {
      // Reset and reload vehicle options for the chosen customer
      vehSel.innerHTML = vehicleOptions(custSel.value, '');
    });
  }

  function readForm(form) {
    const val = n => form[n].value.trim();
    return {
      customerId: val('customerId'), vehicleId: val('vehicleId'),
      serviceId: val('serviceId'), mechanicId: val('mechanicId'),
      date: val('date'), time: val('time'),
      duration: Number(val('duration')) || 0,
      status: val('status'), source: val('source'),
      complaint: val('complaint'), notes: val('notes')
    };
  }

  function validate(values, editing = null) {
    const errors = {};
    const today = todayStr();

    // foreign keys revalidated — never trust dropdown values blindly
    if (!values.customerId) errors.customerId = 'Select a customer.';
    else if (!Storage.getById('customers', values.customerId)) errors.customerId = 'Selected customer no longer exists.';

    if (!values.vehicleId) errors.vehicleId = 'Select a vehicle.';
    else {
      const v = Storage.getById('vehicles', values.vehicleId);
      if (!v) errors.vehicleId = 'Selected vehicle no longer exists.';
      else if (v.customerId !== values.customerId) errors.vehicleId = 'This vehicle does not belong to the selected customer.';
    }

    if (!values.serviceId) errors.serviceId = 'Select a service.';
    else if (!Storage.getById('services', values.serviceId)) errors.serviceId = 'Selected service no longer exists.';

    if (values.mechanicId && !Storage.getById('mechanics', values.mechanicId))
      errors.mechanicId = 'Selected mechanic no longer exists.';

    if (!values.date) errors.date = 'Appointment date is required.';
    else if (isNaN(new Date(values.date))) errors.date = 'Enter a valid date.';
    else if (!editing && values.date < today) errors.date = 'New appointments cannot be in the past.';

    // Source must be one of the canonical values -- an arbitrary string is
    // never accepted, including one arriving from a future API path.
    if (!values.source) errors.source = 'Select an appointment source.';
    else if (!SOURCES.includes(values.source)) errors.source = 'Invalid appointment source.';

    if (!values.time) errors.time = 'Appointment time is required.';
    if (!values.duration || values.duration <= 0) errors.duration = 'Duration must be greater than 0.';
    else if (values.duration > 600) errors.duration = 'Duration looks unreasonably long.';

    return { valid: Object.keys(errors).length === 0, errors };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const el = form.querySelector(`[data-err="${key}"]`);
      if (el) { el.textContent = msg; el.closest('.field').classList.add('field--error'); }
    });
  }

  /** Conflict + duplicate checks. Returns true if save should stop. */
  function scheduleProblems(values, excludeId, ov) {
    const conflicts = findConflicts(values, excludeId);
    if (conflicts.length) {
      const c = conflicts[0];
      const who = c.reason === 'mechanic'
        ? `mechanic ${esc(mecName(c.apt.mechanicId))}`
        : `vehicle ${esc(vehReg(c.apt.vehicleId))}`;
      Modal.open({
        title: 'Appointment conflict detected',
        body: `<p style="margin:0">This slot overlaps <strong>${esc(c.apt.id)}</strong> on
               ${fmtDate(c.apt.date)} at ${fmtTime(c.apt.time)} (${fmtDuration(c.apt.duration || 60)})
               for ${who}.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Change the time, duration, or mechanic, then save again.</p>`,
        footer: `<button class="btn btn--primary" data-modal-close>OK, I'll adjust</button>`
      });
      return true;
    }
    const dup = findDuplicate(values, excludeId);
    if (dup) {
      Modal.open({
        title: 'Possible duplicate appointment',
        body: `<p style="margin:0">An identical appointment already exists:
               <strong>${esc(dup.id)}</strong> — same customer, vehicle, service, date and time.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Change the time or review the existing appointment before booking again.</p>`,
        footer: `<button class="btn btn--primary" data-modal-close>OK</button>`
      });
      return true;
    }
    return false;
  }

  function openAddModal() {
    if (!Storage.getData('customers').length) {
      Modal.open({
        title: 'No customers yet',
        body: `<p style="margin:0">An appointment needs a customer and their vehicle. Add a customer first.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <a class="btn btn--primary" href="customers.html">Go to Customers</a>`
      });
      return;
    }
    const ov = Modal.open({
      title: 'New Appointment', size: 'lg',
      body: formHtml(),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Book Appointment</button>`
    });
    bindCascade(ov);
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#aptForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      // The overlap check below is the UI's, run against the hydrated copy.
      // The server runs the same rule over the live table and gets the last
      // word -- which is what catches a booking someone else made meanwhile.
      if (scheduleProblems(values, null, ov)) return;

      const res = await Storage.create('appointments', {
        ...values,
        reminderSent: false,
        jobCardId: null
      });
      if (!Utils.wrote(res, form)) return;
      const rec = res.record;
      Modal.close();
      refresh();
      toast(`Appointment ${rec.id} booked for ${custName(rec.customerId)}.`);
    }));
  }

  function openEditModal(id) {
    const a = Storage.getById('appointments', id);
    if (!a) return;
    if (TERMINAL.includes(normStatus(a.status))) {
      toast(`${normStatus(a.status)} appointments cannot be edited.`, 'info');
      return;
    }
    const ov = Modal.open({
      title: `Edit Appointment — ${a.id}`, size: 'lg',
      body: formHtml(a),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    bindCascade(ov);
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#aptForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, a);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      // status can only move along allowed transitions (or stay)
      const allowed = [normStatus(a.status), ...(TRANSITIONS[normStatus(a.status)] || [])];
      if (!allowed.includes(values.status)) values.status = normStatus(a.status);
      if (scheduleProblems(values, id, ov)) return;

      const res = await Storage.update('appointments', id, values); // a merge: id and createdAt are untouched
      if (!Utils.wrote(res, form)) return;
      Modal.close();
      refresh();
      toast(`Appointment ${id} updated.`);
    }));
  }

  /* ---------- status changes ---------- */

  async function changeStatus(id, next) {
    const a = Storage.getById('appointments', id);
    if (!a) return;
    const current = normStatus(a.status);
    if (!(TRANSITIONS[current] || []).includes(next)) {
      toast(`Cannot change ${current} appointment to ${next}.`, 'error');
      return;
    }
    const apply = async () => {
      const res = await Storage.update('appointments', id, { status: next });
      if (!Utils.wrote(res)) return;
      refresh();
      const verbs = { 'Confirmed': 'confirmed', 'In Progress': 'started', 'Completed': 'completed', 'Cancelled': 'cancelled', 'No Show': 'marked as no-show' };
      toast(`Appointment ${id} ${verbs[next] || 'updated'}.`,
        next === 'Cancelled' || next === 'No Show' ? 'warning' : 'success');
    };
    if (next === 'Cancelled') {
      Modal.confirm({
        title: 'Cancel appointment?',
        message: `Cancel <strong>${esc(id)}</strong> for ${esc(custName(a.customerId))} on ${fmtDate(a.date)} at ${fmtTime(a.time)}? The record is kept for history.`,
        confirmText: 'Cancel Appointment',
        onConfirm: apply
      });
    } else {
      await apply();
    }
  }

  /* ---------- delete policy ---------- */

  function openDeleteModal(id) {
    const a = Storage.getById('appointments', id);
    if (!a) return;
    const status = normStatus(a.status);

    if (a.jobCardId) {
      Modal.open({
        title: 'Cannot delete appointment',
        body: `<p style="margin:0"><strong>${esc(a.id)}</strong> is linked to job card
               <strong>${esc(a.jobCardId)}</strong>. Appointments connected to work records are kept permanently.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (status === 'Completed') {
      Modal.open({
        title: 'Keep completed appointments',
        body: `<p style="margin:0"><strong>${esc(a.id)}</strong> is a completed appointment — it's part of
               your service history and shouldn't be deleted.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (status === 'In Progress') {
      toast('Finish or cancel the appointment before deleting it.', 'error');
      return;
    }

    Modal.confirm({
      title: 'Delete appointment?',
      message: `Permanently delete <strong>${esc(a.id)}</strong> (${esc(custName(a.customerId))}, ${fmtDate(a.date)} ${fmtTime(a.time)})? If the customer may return, cancelling keeps better history.`,
      confirmText: 'Delete Appointment',
      onConfirm: async () => {
        // The status guards above are the UI's. The server has its own three
        // delete blockers, none of them a foreign key, and gets the last word.
        const res = await Storage.remove('appointments', id);
        if (!Utils.wrote(res)) return;
        refresh();
        toast(`Appointment ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- details ---------- */

  function openDetailModal(id) {
    const a = Storage.getById('appointments', id);
    if (!a) return;
    const status = normStatus(a.status);
    const cust = Storage.getById('customers', a.customerId);
    const veh = vehInfo(a.vehicleId);
    const svc = svcRec(a.serviceId);
    const mec = a.mechanicId ? mecRec(a.mechanicId) : null;

    Modal.open({
      title: `Appointment ${a.id}`, size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Status</span><strong>${badge(status)}</strong></div>
          <div class="detail-item"><span>Date</span><strong>${fmtDate(a.date)}</strong></div>
          <div class="detail-item"><span>Time</span><strong>${fmtTime(a.time)} · ${fmtDuration(a.duration || 60)}</strong></div>
          <div class="detail-item"><span>Source</span><strong>${badge(normSource(a.source))}</strong></div>
        </div>

        <h3 class="detail-section-title">Customer</h3>
        <div class="detail-grid">
          <div class="detail-item"><span>Name</span><strong>${cust ? esc(cust.name) : 'Unknown Customer'}</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${cust ? esc(cust.phone) : 'N/A'}</strong></div>
        </div>

        <h3 class="detail-section-title">Vehicle</h3>
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Registration</span><strong>${veh ? esc(veh.regNo) : 'Unknown Vehicle'}</strong></div>
          <div class="detail-item"><span>Brand / Model</span><strong>${veh ? esc(`${veh.brand} ${veh.model}`) : 'N/A'}</strong></div>
          <div class="detail-item"><span>Year</span><strong>${veh && veh.year ? veh.year : 'N/A'}</strong></div>
        </div>

        <h3 class="detail-section-title">Service</h3>
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Service</span><strong>${svc ? esc(svc.name) : 'Unknown Service'}${svc && (svc.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</strong></div>
          <div class="detail-item"><span>Category</span><strong>${svc ? esc(svc.category) : 'N/A'}</strong></div>
          <div class="detail-item"><span>Current Price</span><strong>${svc ? money(svc.price) : 'N/A'}</strong></div>
        </div>

        ${mec || a.mechanicId ? `
        <h3 class="detail-section-title">Mechanic</h3>
        <div class="detail-grid">
          <div class="detail-item"><span>Name</span><strong>${mec ? esc(mec.name) : 'Unknown Mechanic'}${mec && (mec.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</strong></div>
          <div class="detail-item"><span>Specialization</span><strong>${mec ? esc(mec.specialization || 'General') : 'N/A'}</strong></div>
        </div>` : ''}

        ${a.complaint ? `<h3 class="detail-section-title">Customer Request / Complaint</h3><p style="margin:0;font-size:.87rem">${esc(a.complaint)}</p>` : ''}
        ${a.notes ? `<h3 class="detail-section-title">Notes</h3><p style="margin:0;font-size:.87rem">${esc(a.notes)}</p>` : ''}

        <div class="detail-grid" style="margin-top:18px">
          <div class="detail-item"><span>Created</span><strong>${a.createdAt ? fmtDate(a.createdAt) : 'N/A'}</strong></div>
          <div class="detail-item"><span>Last Updated</span><strong>${a.updatedAt ? fmtDate(a.updatedAt) : '—'}</strong></div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
               ${!TERMINAL.includes(status) && !a.jobCardId ? `<a class="btn btn--ghost" href="job-cards.html?fromAppointment=${encodeURIComponent(a.id)}">Create Job Card</a>` : ''}
               ${a.jobCardId ? `<a class="btn btn--ghost" href="job-cards.html?view=${encodeURIComponent(a.jobCardId)}">View Job Card</a>` : ''}
               ${!TERMINAL.includes(status) ? '<button class="btn btn--primary" data-edit-from-view>Edit Appointment</button>' : ''}`
    });
    const editBtn = document.querySelector('[data-edit-from-view]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openEditModal(id); });
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateMechanicFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addAptBtn').addEventListener('click', openAddModal);
    document.getElementById('aptSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('aptQuick').addEventListener('change', e => { fQuick = e.target.value; renderList(); });
    document.getElementById('aptDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('aptStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('aptMechanic').addEventListener('change', e => { fMechanic = e.target.value; renderList(); });
    document.getElementById('aptSource').addEventListener('change', e => { fSource = e.target.value; renderList(); });
    document.getElementById('aptSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('aptTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      // A status change writes (and on a job card moves stock), so the row's
      // own button is held until the server answers. Delegated, so the button
      // is this row's rather than the one the listener sits on.
      if (action === 'status') { Utils.guard(btn, () => changeStatus(id, btn.dataset.next)); return; }
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('appointments', viewId)) openDetailModal(viewId);
  });

})();
