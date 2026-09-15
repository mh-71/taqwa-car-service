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
      totalPaid: jobs.reduce((s, j) => s + (Number(j.paid) || 0), 0),
      totalDue: jobs.reduce((s, j) => s + (Number(j.due) || 0), 0)
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

  function formHtml(c = {}) {
    return `
      <form id="custForm" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            <label for="cf-name">Full Name <span class="req">*</span></label>
            <input class="input" id="cf-name" name="name" value="${esc(c.name || '')}" autocomplete="off">
            <div class="field__error" data-err="name"></div>
          </div>
          <div class="field">
            <label for="cf-phone">Phone <span class="req">*</span></label>
            <input class="input" id="cf-phone" name="phone" value="${esc(c.phone || '')}" placeholder="01XXX-XXXXXX" autocomplete="off">
            <div class="field__error" data-err="phone"></div>
          </div>
          <div class="field">
            <label for="cf-alt">Alternate Phone</label>
            <input class="input" id="cf-alt" name="altPhone" value="${esc(c.altPhone || '')}" autocomplete="off">
            <div class="field__error" data-err="altPhone"></div>
          </div>
          <div class="field span-2">
            <label for="cf-email">Email</label>
            <input class="input" id="cf-email" name="email" value="${esc(c.email || '')}" autocomplete="off">
            <div class="field__error" data-err="email"></div>
          </div>
          <div class="field span-2">
            <label for="cf-address">Address</label>
            <input class="input" id="cf-address" name="address" value="${esc(c.address || '')}" autocomplete="off">
          </div>
          <div class="field span-2">
            <label for="cf-notes">Notes</label>
            <textarea class="textarea" id="cf-notes" name="notes" rows="2">${esc(c.notes || '')}</textarea>
          </div>
        </div>
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

  function openAddModal() {
    const ov = Modal.open({
      title: 'Add Customer',
      body: formHtml(),
      footer: `
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--primary" data-save>Save Customer</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', () => {
      const form = ov.querySelector('#custForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const record = Storage.addData('customers', {
        name: values.name.trim(),
        phone: values.phone.trim(),
        altPhone: values.altPhone.trim(),
        email: values.email.trim(),
        address: values.address.trim(),
        notes: values.notes.trim(),
        status: 'Active'
      });
      Modal.close();
      renderList();
      toast(`Customer ${record.name} added (${record.id}).`);
    });
  }

  function openEditModal(id) {
    const c = Storage.getById('customers', id);
    if (!c) return;
    const ov = Modal.open({
      title: `Edit Customer — ${c.id}`,
      body: formHtml(c),
      footer: `
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', () => {
      const form = ov.querySelector('#custForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      Storage.updateData('customers', id, {
        name: values.name.trim(),
        phone: values.phone.trim(),
        altPhone: values.altPhone.trim(),
        email: values.email.trim(),
        address: values.address.trim(),
        notes: values.notes.trim()
      });
      Modal.close();
      renderList();
      toast(`Customer ${values.name.trim()} updated.`);
    });
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
      onConfirm: () => {
        Storage.deleteData('customers', id);
        renderList();
        toast(`Customer ${c.name} deleted.`, 'warning');
      }
    });
  }

  /* ============================================================
     Details view
     ============================================================ */

  function openDetailModal(id) {
    const c = Storage.getById('customers', id);
    if (!c) return;
    const st = customerStats(id);

    const vehiclesHtml = st.vehicles.length
      ? `<div class="table-wrap"><table class="table table--compact">
           <thead><tr><th>Registration</th><th>Brand</th><th>Model</th></tr></thead>
           <tbody>${st.vehicles.map(v => `
             <tr><td class="cell-main">${esc(v.regNo)}</td><td>${esc(v.brand)}</td><td>${esc(v.model)}</td></tr>`).join('')}
           </tbody></table></div>`
      : `<p class="muted-note">No vehicles registered for this customer.</p>`;

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
      : `<p class="muted-note">No service history yet.</p>`;

    Modal.open({
      title: `${c.name} — ${c.id}`,
      size: 'lg',
      body: `
        <div class="detail-grid">
          <div class="detail-item"><span>Phone</span><strong>${esc(c.phone)}${c.altPhone ? ` / ${esc(c.altPhone)}` : ''}</strong></div>
          <div class="detail-item"><span>Email</span><strong>${c.email ? esc(c.email) : '—'}</strong></div>
          <div class="detail-item span-2"><span>Address</span><strong>${c.address ? esc(c.address) : '—'}</strong></div>
          ${c.notes ? `<div class="detail-item span-2"><span>Notes</span><strong>${esc(c.notes)}</strong></div>` : ''}
        </div>

        <div class="summary-row">
          <div class="summary-tile"><strong>${st.vehicleCount}</strong><span>Vehicles</span></div>
          <div class="summary-tile"><strong>${st.serviceCount}</strong><span>Services</span></div>
          <div class="summary-tile summary-tile--good"><strong>${money(st.totalPaid)}</strong><span>Total Paid</span></div>
          <div class="summary-tile ${st.totalDue > 0 ? 'summary-tile--bad' : ''}"><strong>${money(st.totalDue)}</strong><span>Total Due</span></div>
        </div>

        <h3 class="detail-section-title">Vehicles</h3>
        ${vehiclesHtml}

        <h3 class="detail-section-title">Service History</h3>
        ${historyHtml}`,
      footer: `
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-edit-from-view>Edit Customer</button>`
    }).querySelector('[data-edit-from-view]').addEventListener('click', () => {
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

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    renderList();
    // Deep link: customers.html?view=CUS-0001 opens details directly
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('customers', viewId)) openDetailModal(viewId);
  });

})();
