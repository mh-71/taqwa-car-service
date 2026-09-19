/* ============================================================
   mechanics.js — Mechanics Management module
   Job cards reference mechanics via mechanicId; names are always
   resolved dynamically. Job statistics are computed from real
   job card data via the shared helpers in Utils.
   Status (Active/Inactive: employment) is separate from
   availability (Available/Busy/Off Duty/On Leave: current state).
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  const SPECIALIZATIONS = [
    'Engine', 'Transmission', 'Brake', 'AC', 'Electrical', 'Suspension',
    'Wheel & Tire', 'Diagnostics', 'Body Work', 'General', 'Other'
  ];
  const EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Temporary'];
  const SALARY_TYPES = ['Monthly', 'Daily', 'Hourly', 'Commission', 'Other'];
  const AVAILABILITIES = ['Available', 'Busy', 'Off Duty', 'On Leave'];

  let searchTerm = '';
  let fSpec = 'all', fEmployment = 'all', fStatus = 'all';
  let sortBy = 'name-asc';

  const isActive = m => (m.status || 'Active') === 'Active';
  // An inactive mechanic is never available, regardless of stored availability
  const isAvailable = m => isActive(m) && (m.availability || 'Available') === 'Available';

  /* ---------- summary cards ---------- */

  function renderStats() {
    const mechanics = Storage.getData('mechanics');
    const active = mechanics.filter(isActive).length;
    const available = mechanics.filter(isAvailable).length;

    const stats = [
      { label: 'Total Mechanics',    value: mechanics.length,          tone: 'info',  icon: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z' },
      { label: 'Active Mechanics',   value: active,                    tone: 'good',  icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Available Now',      value: available,                 tone: 'amber', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z' },
      { label: 'Inactive Mechanics', value: mechanics.length - active, tone: 'warn',  icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' }
    ];

    document.getElementById('mecStats').innerHTML = stats.map(s => `
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

  function filteredMechanics() {
    const term = searchTerm.trim().toLowerCase();
    let list = Storage.getData('mechanics').filter(m => {
      if (term) {
        const hay = `${m.id} ${m.name} ${m.phone} ${m.altPhone || ''} ${m.specialization || ''} ${m.email || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fSpec !== 'all' && m.specialization !== fSpec) return false;
      if (fEmployment !== 'all' && (m.employmentType || '') !== fEmployment) return false;
      if (fStatus !== 'all' && (m.status || 'Active') !== fStatus) return false;
      return true;
    });

    const cmp = {
      'name-asc':    (a, b) => a.name.localeCompare(b.name),
      'name-desc':   (a, b) => b.name.localeCompare(a.name),
      'spec-asc':    (a, b) => (a.specialization || '').localeCompare(b.specialization || '') || a.name.localeCompare(b.name),
      'exp-desc':    (a, b) => (Number(b.experience) || 0) - (Number(a.experience) || 0),
      'exp-asc':     (a, b) => (Number(a.experience) || 0) - (Number(b.experience) || 0),
      'joined-desc': (a, b) => (b.joiningDate || '').localeCompare(a.joiningDate || ''),
      'joined-asc':  (a, b) => (a.joiningDate || '').localeCompare(b.joiningDate || ''),
      'salary-desc': (a, b) => (Number(b.salary) || 0) - (Number(a.salary) || 0),
      'salary-asc':  (a, b) => (Number(a.salary) || 0) - (Number(b.salary) || 0)
    }[sortBy];
    return list.sort(cmp);
  }

  function populateSpecFilter() {
    const used = Storage.getData('mechanics').map(m => m.specialization).filter(Boolean);
    const specs = [...new Set([...SPECIALIZATIONS, ...used])].sort();
    const sel = document.getElementById('mecSpec');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All specializations</option>` +
      specs.map(s => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
  }

  function renderList() {
    const rows = filteredMechanics();
    const total = Storage.getData('mechanics').length;
    const tbody = document.getElementById('mecTableBody');
    const isFiltered = searchTerm || fSpec !== 'all' || fEmployment !== 'all' || fStatus !== 'all';

    document.getElementById('mecCount').textContent =
      isFiltered ? `${rows.length} of ${total} mechanics` : `${total} mechanics`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M12 2L4 6v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-4z"/></svg>
            <h3>${isFiltered ? 'No mechanics match your search or filter.' : 'No mechanics found'}</h3>
            <p>${isFiltered ? 'Try different keywords or reset the filters.' : 'Add your first mechanic to get started.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">+ Add Mechanic</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(m => {
      const status = m.status || 'Active';
      const activeJobs = Utils.getMechanicActiveJobs(m.id).length;
      const doneJobs = Utils.getMechanicCompletedJobs(m.id).length;
      return `
      <tr data-id="${esc(m.id)}">
        <td class="cell-main">${esc(m.id)}</td>
        <td class="cell-main">${esc(m.name)}${isActive(m) && m.availability && m.availability !== 'Available'
          ? `<span class="cell-sub">${esc(m.availability)}</span>` : ''}</td>
        <td>${esc(m.phone)}</td>
        <td><span class="badge badge--neutral">${esc(m.specialization || '—')}</span></td>
        <td class="num">${m.experience != null && m.experience !== '' ? `${m.experience} yr${m.experience == 1 ? '' : 's'}` : '—'}</td>
        <td>${esc(m.employmentType || '—')}</td>
        <td>${badge(status)}</td>
        <td class="num">${activeJobs}</td>
        <td class="num">${doneJobs}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(m.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(m.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="toggle" title="${status === 'Active' ? 'Deactivate' : 'Activate'}" aria-label="${status === 'Active' ? 'Deactivate' : 'Activate'} ${esc(m.name)}">
              ${status === 'Active'
                ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.9L16.9 18.3C15.5 19.4 13.8 20 12 20zm6.3-3.1L7.1 5.7C8.5 4.6 10.2 4 12 4c4.4 0 8 3.6 8 8 0 1.8-.6 3.5-1.7 4.9z"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>'}
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(m.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------- add / edit ---------- */

  function optList(options, selected) {
    return options.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  function formHtml(m = {}) {
    // Preserve legacy specializations (e.g. "Engine & Transmission") when editing
    const specs = m.specialization && !SPECIALIZATIONS.includes(m.specialization)
      ? [m.specialization, ...SPECIALIZATIONS] : SPECIALIZATIONS;
    return `
      <form id="mecForm" novalidate>
        <h3 class="detail-section-title">Personal Information</h3>
        <div class="form-grid">
          <div class="field span-2">
            <label for="mf-name">Full Name <span class="req">*</span></label>
            <input class="input" id="mf-name" name="name" value="${esc(m.name || '')}" autocomplete="off">
            <div class="field__error" data-err="name"></div>
          </div>
          <div class="field">
            <label for="mf-phone">Phone <span class="req">*</span></label>
            <input class="input" id="mf-phone" name="phone" value="${esc(m.phone || '')}" placeholder="01XXX-XXXXXX" autocomplete="off">
            <div class="field__error" data-err="phone"></div>
          </div>
          <div class="field">
            <label for="mf-alt">Alternate Phone</label>
            <input class="input" id="mf-alt" name="altPhone" value="${esc(m.altPhone || '')}" autocomplete="off">
            <div class="field__error" data-err="altPhone"></div>
          </div>
          <div class="field">
            <label for="mf-email">Email</label>
            <input class="input" id="mf-email" name="email" value="${esc(m.email || '')}" autocomplete="off">
            <div class="field__error" data-err="email"></div>
          </div>
          <div class="field">
            <label for="mf-address">Address</label>
            <input class="input" id="mf-address" name="address" value="${esc(m.address || '')}" autocomplete="off">
          </div>
        </div>

        <h3 class="detail-section-title">Professional Information</h3>
        <div class="form-grid">
          <div class="field">
            <label for="mf-spec">Specialization <span class="req">*</span></label>
            <select class="select" id="mf-spec" name="specialization">
              <option value="">— Select —</option>${optList(specs, m.specialization)}
            </select>
            <div class="field__error" data-err="specialization"></div>
          </div>
          <div class="field">
            <label for="mf-exp">Experience (years)</label>
            <input class="input" id="mf-exp" name="experience" type="number" min="0" step="1" value="${esc(m.experience ?? '')}">
            <div class="field__error" data-err="experience"></div>
          </div>
          <div class="field">
            <label for="mf-join">Joining Date</label>
            <input class="input" id="mf-join" name="joiningDate" type="date" value="${esc(m.joiningDate || '')}">
            <div class="field__error" data-err="joiningDate"></div>
          </div>
          <div class="field">
            <label for="mf-emp">Employment Type</label>
            <select class="select" id="mf-emp" name="employmentType">${optList(EMPLOYMENT_TYPES, m.employmentType || 'Full Time')}</select>
          </div>
          <div class="field">
            <label for="mf-saltype">Salary Type</label>
            <select class="select" id="mf-saltype" name="salaryType">${optList(SALARY_TYPES, m.salaryType || 'Monthly')}</select>
          </div>
          <div class="field">
            <label for="mf-salary">Salary (BDT)</label>
            <input class="input" id="mf-salary" name="salary" type="number" min="0" step="500" value="${esc(m.salary ?? '')}">
            <div class="field__error" data-err="salary"></div>
          </div>
          <div class="field">
            <label for="mf-comm">Commission Rate (%)</label>
            <input class="input" id="mf-comm" name="commissionRate" type="number" min="0" max="100" step="0.5" value="${esc(m.commissionRate ?? '')}">
            <div class="field__error" data-err="commissionRate"></div>
          </div>
          <div class="field">
            <label for="mf-avail">Availability</label>
            <select class="select" id="mf-avail" name="availability">${optList(AVAILABILITIES, m.availability || 'Available')}</select>
          </div>
          <div class="field">
            <label for="mf-status">Status</label>
            <select class="select" id="mf-status" name="status">
              <option${(m.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${m.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field span-2">
            <label for="mf-notes">Notes</label>
            <textarea class="textarea" id="mf-notes" name="notes" rows="2">${esc(m.notes || '')}</textarea>
          </div>
        </div>
      </form>`;
  }

  function readForm(form) {
    const val = n => form[n].value.trim();
    return {
      name: val('name').replace(/\s+/g, ' '),
      phone: val('phone'),                        // stored as string, never numeric
      altPhone: val('altPhone'),
      email: val('email'),
      address: val('address'),
      specialization: val('specialization'),
      experience: val('experience') === '' ? '' : Number(val('experience')),
      joiningDate: val('joiningDate'),
      employmentType: val('employmentType'),
      salaryType: val('salaryType'),
      salary: val('salary') === '' ? '' : Number(val('salary')),
      commissionRate: val('commissionRate') === '' ? '' : Number(val('commissionRate')),
      availability: val('availability'),
      status: val('status'),
      notes: val('notes')
    };
  }

  function validate(values, editingId = null) {
    const errors = {};
    const phoneRe = /^[0-9+\-\s()]{6,20}$/;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const today = Utils.todayStr();

    if (!values.name) errors.name = 'Mechanic name is required.';
    if (!values.phone) {
      errors.phone = 'Phone number is required.';
    } else if (!phoneRe.test(values.phone)) {
      errors.phone = 'Enter a valid phone number (digits, +, -, spaces).';
    } else {
      const dup = Storage.getData('mechanics').find(m =>
        m.id !== editingId &&
        (m.status || 'Active') === 'Active' &&
        (m.phone || '').replace(/\D/g, '') === values.phone.replace(/\D/g, ''));
      if (dup) errors.phone = 'A mechanic with this phone number already exists.';
    }
    if (values.altPhone && !phoneRe.test(values.altPhone)) errors.altPhone = 'Enter a valid phone number.';
    if (values.email && !emailRe.test(values.email)) errors.email = 'Enter a valid email address.';
    if (!values.specialization) errors.specialization = 'Select a specialization.';
    if (values.experience !== '' && values.experience < 0) errors.experience = 'Experience cannot be negative.';
    if (values.salary !== '' && values.salary < 0) errors.salary = 'Salary cannot be negative.';
    if (values.commissionRate !== '') {
      if (values.commissionRate < 0) errors.commissionRate = 'Commission cannot be negative.';
      else if (values.commissionRate > 100) errors.commissionRate = 'Commission cannot exceed 100%.';
    }
    if (values.joiningDate) {
      if (isNaN(new Date(values.joiningDate))) errors.joiningDate = 'Enter a valid date.';
      else if (values.joiningDate < '1980-01-01') errors.joiningDate = 'Joining date looks too old.';
      else if (values.joiningDate > today) errors.joiningDate = 'Joining date cannot be in the future.';
    }
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

  function openAddModal() {
    const ov = Modal.open({
      title: 'Add Mechanic', size: 'lg',
      body: formHtml(),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Mechanic</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#mecForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) {
        showErrors(form, errors);
        toast(errors.phone === 'A mechanic with this phone number already exists.'
          ? errors.phone : 'Please fix the highlighted fields.', 'error');
        return;
      }
      const res = await Storage.create('mechanics', values);
      if (!Utils.wrote(res, form)) return;
      const rec = res.record;
      Modal.close();
      refresh();
      toast(`Mechanic ${rec.name} added (${rec.id}).`);
    }));
  }

  function openEditModal(id) {
    const m = Storage.getById('mechanics', id);
    if (!m) return;
    const ov = Modal.open({
      title: `Edit Mechanic — ${m.id}`, size: 'lg',
      body: formHtml(m),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#mecForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      const res = await Storage.update('mechanics', id, values);
      if (!Utils.wrote(res, form)) return;
      Modal.close();
      refresh();
      toast(`Mechanic ${values.name} updated.`);
    }));
  }

  /* ---------- activate / deactivate ---------- */

  async function toggleStatus(id) {
    const m = Storage.getById('mechanics', id);
    if (!m) return;
    const next = (m.status || 'Active') === 'Active' ? 'Inactive' : 'Active';
    const res = await Storage.update('mechanics', id, { status: next });
    if (!Utils.wrote(res)) return;
    refresh();
    toast(`Mechanic ${m.name} ${next === 'Active' ? 'activated' : 'deactivated'}.`,
      next === 'Active' ? 'success' : 'info');
  }

  /* ---------- delete (protect historical references) ---------- */

  function isReferenced(id) {
    return Storage.getData('jobCards').some(j => j.mechanicId === id) ||
           Storage.getData('appointments').some(a => a.mechanicId === id);
  }

  function openDeleteModal(id) {
    const m = Storage.getById('mechanics', id);
    if (!m) return;

    if (isReferenced(id)) {
      Modal.open({
        title: 'Cannot delete mechanic',
        body: `<p style="margin:0"><strong>${esc(m.name)}</strong> is associated with historical work
               records (job cards or appointments). Deleting them would corrupt that history.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Deactivate the mechanic instead — they stay in past records but won't be assignable to new work.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 ${(m.status || 'Active') === 'Active'
                   ? '<button class="btn btn--primary" data-deactivate>Deactivate Mechanic</button>' : ''}`
      });
      const btn = document.querySelector('[data-deactivate]');
      if (btn) btn.addEventListener('click', () => { Modal.close(); toggleStatus(id); });
      return;
    }

    Modal.confirm({
      title: 'Delete mechanic?',
      message: `Are you sure you want to delete <strong>${esc(m.name)}</strong> (${esc(m.id)})? This cannot be undone.`,
      confirmText: 'Delete Mechanic',
      onConfirm: async () => {
        const res = await Storage.remove('mechanics', id);
        if (!Utils.wrote(res)) return;
        refresh();
        toast(`Mechanic ${m.name} deleted.`, 'warning');
      }
    });
  }

  /* ---------- details ---------- */

  function openDetailModal(id) {
    const m = Storage.getById('mechanics', id);
    if (!m) return;

    const jobs = Utils.getMechanicJobs(id);
    const activeJobs = Utils.getMechanicActiveJobs(id);
    const doneJobs = Utils.getMechanicCompletedJobs(id);
    const cancelled = jobs.filter(j => j.status === 'Cancelled');
    const revenue = Utils.getMechanicRevenue(id);
    const avgJob = doneJobs.length ? Math.round(revenue / doneJobs.length) : 0;

    const perfHtml = jobs.length
      ? `<div class="summary-row summary-row--6">
           <div class="summary-tile"><strong>${jobs.length}</strong><span>Total Jobs</span></div>
           <div class="summary-tile"><strong>${activeJobs.length}</strong><span>Active Jobs</span></div>
           <div class="summary-tile summary-tile--good"><strong>${doneJobs.length}</strong><span>Completed</span></div>
           <div class="summary-tile ${cancelled.length ? 'summary-tile--bad' : ''}"><strong>${cancelled.length}</strong><span>Cancelled</span></div>
           <div class="summary-tile summary-tile--good"><strong>${money(revenue)}</strong><span>Service Revenue</span></div>
           <div class="summary-tile"><strong>${money(avgJob)}</strong><span>Avg. Job Value</span></div>
         </div>`
      : `<p class="muted-note">No job history yet.</p>`;

    const recentJobs = jobs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);
    const jobsHtml = recentJobs.length
      ? `<div class="table-wrap"><table class="table table--compact">
           <thead><tr><th>Job Card</th><th>Date</th><th>Vehicle</th><th class="num">Amount</th><th>Status</th></tr></thead>
           <tbody>${recentJobs.map(j => `
             <tr>
               <td class="cell-main">${esc(j.id)}</td>
               <td>${fmtDate(j.date)}</td>
               <td>${esc(Utils.vehicleLabel(j.vehicleId))}</td>
               <td class="num">${money(j.total)}</td>
               <td>${badge(j.status)}</td>
             </tr>`).join('')}
           </tbody></table></div>`
      : '';

    Modal.open({
      title: `${m.name} — ${m.id}`, size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Phone</span><strong>${esc(m.phone)}${m.altPhone ? ` / ${esc(m.altPhone)}` : ''}</strong></div>
          <div class="detail-item"><span>Email</span><strong>${m.email ? esc(m.email) : '—'}</strong></div>
          <div class="detail-item"><span>Address</span><strong>${m.address ? esc(m.address) : '—'}</strong></div>
          <div class="detail-item"><span>Specialization</span><strong>${esc(m.specialization || '—')}</strong></div>
          <div class="detail-item"><span>Experience</span><strong>${m.experience !== '' && m.experience != null ? `${m.experience} year${m.experience == 1 ? '' : 's'}` : '—'}</strong></div>
          <div class="detail-item"><span>Joining Date</span><strong>${m.joiningDate ? fmtDate(m.joiningDate) : '—'}</strong></div>
          <div class="detail-item"><span>Employment</span><strong>${esc(m.employmentType || '—')}</strong></div>
          <div class="detail-item"><span>Salary</span><strong>${m.salary !== '' && m.salary != null ? `${money(m.salary)} (${esc(m.salaryType || 'Monthly')})` : '—'}</strong></div>
          <div class="detail-item"><span>Commission</span><strong>${m.commissionRate !== '' && m.commissionRate != null ? `${m.commissionRate}%` : '—'}</strong></div>
          <div class="detail-item"><span>Status</span><strong>${badge(m.status || 'Active')}</strong></div>
          <div class="detail-item"><span>Availability</span><strong>${isActive(m) ? esc(m.availability || 'Available') : '— (inactive)'}</strong></div>
          <div class="detail-item"><span>Added</span><strong>${m.createdAt ? fmtDate(m.createdAt) : '—'}</strong></div>
          ${m.notes ? `<div class="detail-item span-2"><span>Notes</span><strong>${esc(m.notes)}</strong></div>` : ''}
        </div>

        <h3 class="detail-section-title">Performance Summary</h3>
        ${perfHtml}
        ${jobsHtml ? `<h3 class="detail-section-title">Recent Jobs</h3>${jobsHtml}` : ''}`,
      footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
               <button class="btn btn--primary" data-edit-from-view>Edit Mechanic</button>`
    }).querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateSpecFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addMechanicBtn').addEventListener('click', openAddModal);
    document.getElementById('mecSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('mecSpec').addEventListener('change', e => { fSpec = e.target.value; renderList(); });
    document.getElementById('mecEmployment').addEventListener('change', e => { fEmployment = e.target.value; renderList(); });
    document.getElementById('mecStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('mecSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('mecTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      if (action === 'toggle') toggleStatus(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('mechanics', viewId)) openDetailModal(viewId);
  });

})();
