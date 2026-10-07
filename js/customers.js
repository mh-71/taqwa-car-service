/* ============================================================
   customers.js — Customer Management module
   All data access goes through the Storage layer.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  let searchTerm = '';
  let filter = 'all';

  /* ============================================================
     Derived customer stats (from real related records only)
     ============================================================ */

  function customerStats(customerId) {
    const vehicles = Storage.getData('vehicles').filter(v => v.customerId === customerId);
    const jobs = Storage.getData('jobCards').filter(j => j.customerId === customerId);
    return {
      vehicles,
      jobs,
      vehicleCount: vehicles.length,
      serviceCount: jobs.length,
      // Live balances (Utils.sumJobs*) rather than the Job Cards' frozen
      // pre-invoice snapshot, so a settled invoice clears the customer's due.
      totalPaid: Utils.sumJobsPaid(jobs),
      totalDue: Utils.sumJobsDue(jobs)
    };
  }

  /* ============================================================
     List rendering
     ============================================================ */

  function filteredCustomers() {
    const term = searchTerm.trim().toLowerCase();
    return Storage.getData('customers')
      .filter(c => {
        if (term) {
          const hay = `${c.name} ${c.phone} ${c.altPhone || ''} ${c.id} ${c.email || ''}`.toLowerCase();
          if (!hay.includes(term)) return false;
        }
        if (filter === 'all') return true;
        const st = customerStats(c.id);
        if (filter === 'with-due') return st.totalDue > 0;
        if (filter === 'with-vehicles') return st.vehicleCount > 0;
        if (filter === 'no-vehicles') return st.vehicleCount === 0;
        return true;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function renderList() {
    const customers = filteredCustomers();
    const totalCount = Storage.getData('customers').length;
    const tbody = document.getElementById('custTableBody');
    const countEl = document.getElementById('custCount');

    countEl.textContent = searchTerm || filter !== 'all'
      ? `${customers.length} of ${totalCount} customers`
      : `${totalCount} customers`;

    if (!customers.length) {
      const filtered = totalCount > 0;
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
            <h3>No customers found</h3>
            <p>${filtered ? 'Try a different search or filter.' : 'Add your first customer to get started.'}</p>
            ${filtered ? '' : '<button class="btn btn--primary" data-action="add">Add Customer</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = customers.map(c => {
      const st = customerStats(c.id);
      const status = c.status || 'Active';
      return `
      <tr data-id="${esc(c.id)}">
        <td class="cell-main">${esc(c.id)}</td>
        <td class="cell-main">${esc(c.name)}${c.notes ? `<span class="cell-sub">${esc(c.notes)}</span>` : ''}</td>
        <td>${esc(c.phone)}${c.altPhone ? `<span class="cell-sub">${esc(c.altPhone)}</span>` : ''}</td>
        <td>${c.email ? esc(c.email) : '<span class="muted">—</span>'}</td>
        <td class="num">${st.vehicleCount}</td>
        <td class="num">${st.serviceCount}</td>
        <td class="num">${st.totalDue > 0 ? `<strong class="due">${money(st.totalDue)}</strong>` : money(0)}</td>
        <td>${fmtDate(c.createdAt)}</td>
        <td>${badge(status)}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(c.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(c.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(c.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ============================================================
     Add / Edit form
     ============================================================ */

  /* Section headings for the Add Customer form. The fields keep the same ids,
     names and order as Edit; icons reuse the sidebar's paths. */
  const ICON_PERSON = 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z';
  const ADD_SECTIONS = [
    { key: 'basic', title: 'Basic Information', desc: "Enter the customer's name and contact details",
      icon: ICON_PERSON, fields: ['name', 'phone', 'altPhone', 'email'] },
    { key: 'address', title: 'Address Information', desc: "Enter the customer's address",
      icon: 'M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5z',
      fields: ['address'] },
    { key: 'notes', title: 'Additional Information', desc: 'Add any important notes about this customer',
      icon: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
      fields: ['notes'] }
  ];
  const EDIT_SECTIONS = [
    { key: 'info', title: 'Customer Information', desc: 'Update the basic details of this customer',
      icon: ICON_PERSON, fields: ['name', 'phone', 'altPhone', 'email', 'address', 'notes'] }
  ];

  /* With `sections` the same fields are grouped into titled sections (Add and
     Edit); without them the plain grid is used. `hints` adds Add's placeholder
     and example text. */
  function formHtml(c = {}, { sections = null, hints = false } = {}) {
    const ph = text => hints ? ` placeholder="${text}"` : '';
    const hint = text => hints ? `<p class="muted-note">${text}</p>` : '';
    const f = {
      name: `
          <div class="field span-2">
            <label for="cf-name">Full Name <span class="req">*</span></label>
            <input class="input" id="cf-name" name="name" value="${esc(c.name || '')}"${ph('e.g. Md. Rahim Uddin')} autocomplete="off">
            <div class="field__error" data-err="name"></div>
          </div>`,
      phone: `
          <div class="field">
            <label for="cf-phone">Phone <span class="req">*</span></label>
            <input class="input" id="cf-phone" name="phone" value="${esc(c.phone || '')}" placeholder="01XXX-XXXXXX" autocomplete="off">
            ${hint('Example: 01712-345678')}
            <div class="field__error" data-err="phone"></div>
          </div>`,
      altPhone: `
          <div class="field">
            <label for="cf-alt">Alternate Phone</label>
            <input class="input" id="cf-alt" name="altPhone" value="${esc(c.altPhone || '')}"${ph('01XXX-XXXXXX')} autocomplete="off">
            ${hint('Example: 01612-345678')}
            <div class="field__error" data-err="altPhone"></div>
          </div>`,
      email: `
          <div class="field span-2">
            <label for="cf-email">Email</label>
            <input class="input" id="cf-email" name="email" value="${esc(c.email || '')}"${ph('e.g. rahim@example.com')} autocomplete="off">
            <div class="field__error" data-err="email"></div>
          </div>`,
      address: `
          <div class="field span-2">
            <label for="cf-address">Address</label>
            <input class="input" id="cf-address" name="address" value="${esc(c.address || '')}"${ph('e.g. House 40, Road 3/A, Sector 15, Uttara, Dhaka')} autocomplete="off">
          </div>`,
      notes: `
          <div class="field span-2">
            <label for="cf-notes">Notes</label>
            <textarea class="textarea" id="cf-notes" name="notes" rows="2"${ph('e.g. Preferred contact time, vehicle preferences, special instructions')}>${esc(c.notes || '')}</textarea>
          </div>`
    };
    if (!sections) {
      return `
      <form id="custForm" novalidate>
        <div class="form-grid">${Object.values(f).join('')}
        </div>
      </form>`;
    }
    return `
      <form id="custForm" class="veh-form" novalidate>
        ${sections.map(s => `
        <div class="form-section form-section--${s.key}" role="group" aria-labelledby="cfs-${s.key}">
          <div class="form-section__head">
            <span class="form-section__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="${s.icon}"/></svg></span>
            <div>
              <h3 class="form-section__title" id="cfs-${s.key}">${s.title}</h3>
              <p class="form-section__desc">${s.desc}</p>
            </div>
          </div>
          <div class="form-grid form-section__body">${s.fields.map(k => f[k]).join('')}
          </div>
        </div>`).join('')}
      </form>`;
  }

  /** Validate form values. Returns { valid, errors } */
  function validate(values, editingId = null) {
    const errors = {};
    const phoneRe = /^[0-9+\-\s()]{6,20}$/;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!values.name.trim()) errors.name = 'Customer name is required.';
    if (!values.phone.trim()) {
      errors.phone = 'Phone number is required.';
    } else if (!phoneRe.test(values.phone.trim())) {
      errors.phone = 'Enter a valid phone number (digits, +, -, spaces).';
    } else {
      const dup = Storage.getData('customers').find(c =>
        c.id !== editingId &&
        c.phone.replace(/\D/g, '') === values.phone.replace(/\D/g, '')
      );
      if (dup) errors.phone = `This phone number already belongs to ${dup.name} (${dup.id}).`;
    }
    if (values.altPhone.trim() && !phoneRe.test(values.altPhone.trim()))
      errors.altPhone = 'Enter a valid phone number.';
    if (values.email.trim() && !emailRe.test(values.email.trim()))
      errors.email = 'Enter a valid email address.';

    return { valid: Object.keys(errors).length === 0, errors };
  }

  function readForm(form) {
    return {
      name: form.name.value, phone: form.phone.value, altPhone: form.altPhone.value,
      email: form.email.value, address: form.address.value, notes: form.notes.value
    };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const errEl = form.querySelector(`[data-err="${key}"]`);
      if (errEl) {
        errEl.textContent = msg;
        errEl.closest('.field').classList.add('field--error');
      }
    });
  }

  /* Add and Edit Customer presentation: an icon and a one-line description in
     the shared modal header. .veh-add is the sectioned form-modal styling the
     vehicle forms use; these modals reuse it unchanged. */
  function decorateFormHead(ov, subtitle) {
    const modal = ov.querySelector('.modal');
    modal.classList.add('veh-add');
    const title = modal.querySelector('.modal__head h2');
    title.insertAdjacentHTML('beforebegin', `<span class="veh-add__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${ICON_PERSON}"/></svg></span>`);
    const titles = document.createElement('div');
    titles.className = 'veh-add__titles';
    title.replaceWith(titles);
    titles.append(title);
    titles.insertAdjacentHTML('beforeend', `<p class="veh-add__sub" id="cust-add-sub">${subtitle}</p>`);
    modal.setAttribute('aria-describedby', 'cust-add-sub');
    return title;
  }

  function openAddModal() {
    const ov = Modal.open({
      title: 'Add Customer',
      body: formHtml({}, { sections: ADD_SECTIONS, hints: true }),
      footer: `
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--primary" data-save>Save Customer</button>`
    });
    decorateFormHead(ov, 'Create a new customer profile');
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#custForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const res = await Storage.create('customers', {
        name: values.name.trim(),
        phone: values.phone.trim(),
        altPhone: values.altPhone.trim(),
        email: values.email.trim(),
        address: values.address.trim(),
        notes: values.notes.trim(),
        status: 'Active'
      });
      if (!Utils.wrote(res, form)) return;

      // The id is the server's, not ours, so it is read off the saved record.
      const record = res.record;
      Modal.close();
      renderList();
      toast(`Customer ${record.name} added (${record.id}).`);
    }));
  }

  function openEditModal(id) {
    const c = Storage.getById('customers', id);
    if (!c) return;
    const ov = Modal.open({
      title: `Edit Customer — ${c.id}`,
      body: formHtml(c, { sections: EDIT_SECTIONS }),
      footer: `
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    // keep the customer ID on one line in the title (the dialog's aria-label is unchanged)
    decorateFormHead(ov, 'Update customer information').innerHTML = `Edit Customer — <span class="cd-id">${esc(c.id)}</span>`;
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#custForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const res = await Storage.update('customers', id, {
        name: values.name.trim(),
        phone: values.phone.trim(),
        altPhone: values.altPhone.trim(),
        email: values.email.trim(),
        address: values.address.trim(),
        notes: values.notes.trim()
      });
      if (!Utils.wrote(res, form)) return;

      Modal.close();
      renderList();
      toast(`Customer ${values.name.trim()} updated.`);
    }));
  }

  /* ============================================================
     Delete (with related-records guard)
     ============================================================ */

  function openDeleteModal(id) {
    const c = Storage.getById('customers', id);
    if (!c) return;
    const st = customerStats(id);

    if (st.vehicleCount > 0 || st.serviceCount > 0) {
      const parts = [];
      if (st.vehicleCount) parts.push(`${st.vehicleCount} vehicle${st.vehicleCount > 1 ? 's' : ''}`);
      if (st.serviceCount) parts.push(`${st.serviceCount} service record${st.serviceCount > 1 ? 's' : ''}`);
      Modal.open({
        title: 'Cannot delete customer',
        body: `<p style="margin:0"><strong>${esc(c.name)}</strong> has ${parts.join(' and ')} linked to their account.
               Deleting the customer would orphan those records.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Remove or reassign the customer's vehicles and service records first, or mark the customer inactive instead.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }

    Modal.confirm({
      title: 'Delete customer?',
      message: `This will permanently delete <strong>${esc(c.name)}</strong> (${esc(c.id)}). This cannot be undone.`,
      confirmText: 'Delete Customer',
      onConfirm: async () => {
        // The related-records guard above is the UI's; the server has its
        // own, backed by the schema's foreign keys, and gets the last word.
        const res = await Storage.remove('customers', id);
        if (!Utils.wrote(res)) return;
        renderList();
        toast(`Customer ${c.name} deleted.`, 'warning');
      }
    });
  }

  /* ============================================================
     Details view
     ============================================================ */

  /* Details view presentation helpers (the layout and tile styles are the
     Vehicle Details ones, reused). */
  const svg = (d, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    vehicle: 'M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z',
    wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z',
    card: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    invoice: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z',
    edit: 'M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z'
  };
  function detailSection(key, icon, title, desc, content, flush = false) {
    return `
          <section class="form-section vd-section cd-section--${key}" aria-labelledby="cd-${key}">
            <div class="form-section__head">
              <span class="form-section__icon" aria-hidden="true">${svg(icon, 18)}</span>
              <div>
                <h3 class="form-section__title" id="cd-${key}">${title}</h3>
                <p class="form-section__desc">${desc}</p>
              </div>
            </div>
            <div class="vd-section__body${flush ? ' vd-section__body--flush' : ''}">${content}</div>
          </section>`;
  }
  const emptyState = (icon, title, hint) => `<div class="vd-empty">${svg(icon, 26)}<p>${title}</p><span>${hint}</span></div>`;

  function openDetailModal(id) {
    const c = Storage.getById('customers', id);
    if (!c) return;
    const st = customerStats(id);

    const item = (label, value, cls = '') => `<div class="vd-item${cls}"><span class="vd-item__label">${label}</span><strong class="vd-item__value">${value}</strong></div>`;
    const stat = (icon, iconTone, value, label, tone = '') =>
      `<div class="vd-stat${tone ? ' vd-stat--' + tone : ''}"><span class="vd-stat__icon${iconTone ? ' vd-stat__icon--' + iconTone : ''}" aria-hidden="true">${svg(icon, 18)}</span>` +
      `<div><strong>${value}</strong><span>${label}</span></div></div>`;

    const vehiclesHtml = st.vehicles.length
      ? `<div class="table-wrap"><table class="table table--compact">
           <thead><tr><th class="num">#</th><th>Registration</th><th>Brand</th><th>Model</th><th>Status</th></tr></thead>
           <tbody>${st.vehicles.map((v, i) => `
             <tr><td class="num">${i + 1}</td><td class="cell-main">${esc(v.regNo)}</td><td>${esc(v.brand)}</td><td>${esc(v.model)}</td><td>${badge(v.status || 'Active')}</td></tr>`).join('')}
           </tbody></table></div>`
      : emptyState(ICONS.vehicle, 'No vehicles registered for this customer.', 'Vehicles added for this customer will appear here.');

    const jobs = st.jobs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const historyHtml = jobs.length
      ? `<div class="table-wrap"><table class="table table--compact">
           <thead><tr><th>Job Card</th><th>Vehicle</th><th>Service</th><th>Date</th><th class="num">Amount</th><th>Status</th></tr></thead>
           <tbody>${jobs.map(j => `
             <tr>
               <td class="cell-main">${esc(j.id)}</td>
               <td>${esc(Utils.vehicleLabel(j.vehicleId))}</td>
               <td>${esc((j.services || []).map(s => s.name).join(', ') || '—')}</td>
               <td>${fmtDate(j.date)}</td>
               <td class="num">${money(j.total)}</td>
               <td>${badge(j.status)}</td>
             </tr>`).join('')}
           </tbody></table></div>`
      : emptyState(ICONS.calendar, 'No service history yet.', 'Service records will appear here after the first service.');

    const ov = Modal.open({
      title: `${c.name} — ${c.id}`,
      size: 'lg',
      body: `
        <div class="vd">
          <div class="cd-top">
            ${detailSection('contact', ICON_PERSON, 'Contact Information', 'Basic details of this customer', `
              <div class="vd-grid vd-grid--2">
                ${item('Full Name', esc(c.name))}
                ${item('Customer ID', esc(c.id))}
                ${item('Phone', `${esc(c.phone)}${c.altPhone ? ` / ${esc(c.altPhone)}` : ''}`)}
                ${item('Email', c.email ? esc(c.email) : '—')}
                ${item('Address', c.address ? esc(c.address) : '—', ' cd-span-2')}
                ${c.notes ? item('Notes', esc(c.notes), ' cd-span-2') : ''}
              </div>`)}
            <div class="vd-stats">
              ${stat(ICONS.vehicle, 'info', st.vehicleCount, 'Vehicles')}
              ${stat(ICONS.wrench, 'good', st.serviceCount, 'Services')}
              ${stat(ICONS.card, '', money(st.totalPaid), 'Total Paid', 'good')}
              ${stat(ICONS.invoice, 'bad', money(st.totalDue), 'Total Due', st.totalDue > 0 ? 'bad' : '')}
            </div>
          </div>
          ${detailSection('vehicles', ICONS.vehicle, 'Vehicles', 'Vehicles registered under this customer', vehiclesHtml, st.vehicles.length > 0)}
          ${detailSection('history', ICONS.wrench, 'Service History', 'Past and recent services for this customer', historyHtml, jobs.length > 0)}
        </div>`,
      footer: `
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-edit-from-view>${svg(ICONS.edit, 16)}Edit Customer</button>`
    });
    // Details-only presentation: icon, the name with the ID kept on one line,
    // status and a one-line description. The dialog keeps its full aria-label.
    // (Skipped when Modal.open hands back no real element, as in the unit tests' stub.)
    const modal = ov.querySelector('.modal');
    if (modal && modal.classList) {
      modal.classList.add('veh-view');
      const title = modal.querySelector('.modal__head h2');
      title.innerHTML = `${esc(c.name)} — <span class="cd-id">${esc(c.id)}</span>`;
      title.insertAdjacentHTML('beforebegin', `<span class="veh-view__icon" aria-hidden="true">${svg(ICON_PERSON, 26)}</span>`);
      const titles = document.createElement('div');
      titles.className = 'veh-view__titles';
      title.replaceWith(titles);
      const row = document.createElement('div');
      row.className = 'cd-head-row';
      row.append(title);
      row.insertAdjacentHTML('beforeend', badge(c.status || 'Active'));
      titles.append(row);
      titles.insertAdjacentHTML('beforeend', `<p class="veh-add__sub">Customer details and activity overview</p>`);
    }
    ov.querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* ============================================================
     Events + init
     ============================================================ */

  function bindEvents() {
    document.getElementById('addCustomerBtn').addEventListener('click', openAddModal);

    document.getElementById('custSearch').addEventListener('input', e => {
      searchTerm = e.target.value;
      renderList();
    });

    document.getElementById('custFilter').addEventListener('change', e => {
      filter = e.target.value;
      renderList();
    });

    // Delegated actions for table rows (survives re-render)
    document.getElementById('custTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    renderList();
    // Deep link: customers.html?view=CUS-0001 opens details directly
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('customers', viewId)) openDetailModal(viewId);
  });

})();
