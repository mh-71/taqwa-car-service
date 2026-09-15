/* ============================================================
   vehicles.js — Vehicle Management module
   Vehicles link to customers via customerId (never by name).
   All persistence goes through the Storage layer.
   Field conventions follow existing data: regNo, vin, engineNo,
   mileage, fuelType — plus chassisNo, transmission, status,
   nextServiceDate added by this module (defaults handled).
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  let searchTerm = '';
  let fBrand = 'all', fFuel = 'all', fService = 'all', fStatus = 'all';
  let sortBy = 'added-desc';

  const FUEL_TYPES = ['Petrol', 'Octane', 'Diesel', 'CNG', 'CNG + Octane', 'Hybrid', 'Electric'];
  const TRANSMISSIONS = ['Manual', 'Automatic', 'CVT', 'AMT', 'Other'];

  /* ============================================================
     Derived vehicle stats (from real job cards / invoices only)
     ============================================================ */

  function vehicleStats(vehicleId) {
    const jobs = Storage.getData('jobCards').filter(j => j.vehicleId === vehicleId);
    const invoices = Storage.getData('invoices').filter(i => i.vehicleId === vehicleId);
    const serviced = jobs
      .filter(j => !['Cancelled'].includes(j.status))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return {
      jobs, invoices,
      serviceCount: jobs.length,
      totalSpent: jobs.reduce((s, j) => s + (Number(j.total) || 0), 0),
      totalPaid: jobs.reduce((s, j) => s + (Number(j.paid) || 0), 0),
      totalDue: jobs.reduce((s, j) => s + (Number(j.due) || 0), 0),
      lastServiceDate: serviced.length ? serviced[0].date : null
    };
  }

  function serviceStatus(v, st) {
    const today = Utils.todayStr();
    if (v.nextServiceDate) {
      return v.nextServiceDate < today ? 'due' : 'upcoming';
    }
    return st.serviceCount ? 'upcoming' : 'none';
  }

  /* ============================================================
     List: filter, sort, render
     ============================================================ */

  function filteredVehicles() {
    const term = searchTerm.trim().toLowerCase();

    let list = Storage.getData('vehicles').map(v => {
      const st = vehicleStats(v.id);
      return { v, st, custName: Utils.customerName(v.customerId) };
    });

    list = list.filter(({ v, st, custName }) => {
      if (term) {
        const hay = `${v.regNo} ${v.id} ${custName} ${v.brand} ${v.model} ${v.vin || ''} ${v.chassisNo || ''} ${v.engineNo || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fBrand !== 'all' && v.brand !== fBrand) return false;
      if (fFuel !== 'all' && v.fuelType !== fFuel) return false;
      if (fStatus !== 'all' && (v.status || 'Active') !== fStatus) return false;
      if (fService !== 'all' && serviceStatus(v, st) !== fService) return false;
      return true;
    });

    const cmp = {
      'added-desc':  (a, b) => (b.v.createdAt || '').localeCompare(a.v.createdAt || ''),
      'added-asc':   (a, b) => (a.v.createdAt || '').localeCompare(b.v.createdAt || ''),
      'reg':         (a, b) => a.v.regNo.localeCompare(b.v.regNo),
      'customer':    (a, b) => a.custName.localeCompare(b.custName),
      'mileage-desc':(a, b) => (Number(b.v.mileage) || 0) - (Number(a.v.mileage) || 0),
      'last-service':(a, b) => (b.st.lastServiceDate || '').localeCompare(a.st.lastServiceDate || ''),
      'next-service':(a, b) => (a.v.nextServiceDate || '9999').localeCompare(b.v.nextServiceDate || '9999')
    }[sortBy];
    list.sort(cmp);
    return list;
  }

  function populateBrandFilter() {
    const brands = [...new Set(Storage.getData('vehicles').map(v => v.brand).filter(Boolean))].sort();
    const sel = document.getElementById('vehBrand');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All brands</option>` +
      brands.map(b => `<option${b === current ? ' selected' : ''}>${esc(b)}</option>`).join('');
  }

  function renderList() {
    const rows = filteredVehicles();
    const total = Storage.getData('vehicles').length;
    const tbody = document.getElementById('vehTableBody');
    const isFiltered = searchTerm || fBrand !== 'all' || fFuel !== 'all' || fService !== 'all' || fStatus !== 'all';

    document.getElementById('vehCount').textContent =
      isFiltered ? `${rows.length} of ${total} vehicles` : `${total} vehicles`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z"/></svg>
            <h3>${isFiltered ? 'No vehicles match your search/filter.' : 'No vehicles found'}</h3>
            <p>${isFiltered ? 'Try different keywords or reset the filters.' : 'Add your first vehicle to get started.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">Add Vehicle</button>'}
          </div>
        </td></tr>`;
      return;
    }

    const today = Utils.todayStr();
    tbody.innerHTML = rows.map(({ v, st }) => {
      const nextTxt = v.nextServiceDate
        ? `<span class="${v.nextServiceDate < today ? 'due' : ''}">${fmtDate(v.nextServiceDate)}</span>`
        : '<span class="muted">—</span>';
      return `
      <tr data-id="${esc(v.id)}">
        <td class="cell-main">${esc(v.id)}</td>
        <td class="cell-main">${esc(v.regNo)}</td>
        <td>${esc(Utils.customerName(v.customerId))}</td>
        <td>${esc(v.brand)} ${esc(v.model)}${v.color ? `<span class="cell-sub">${esc(v.color)} · ${esc(v.fuelType || '')}</span>` : ''}</td>
        <td class="num">${v.year || '—'}</td>
        <td class="num">${v.mileage ? Number(v.mileage).toLocaleString('en-IN') + ' km' : '—'}</td>
        <td>${st.lastServiceDate ? fmtDate(st.lastServiceDate) : '<span class="muted">No service yet</span>'}</td>
        <td>${nextTxt}</td>
        <td>${badge(v.status || 'Active')}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(v.regNo)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(v.regNo)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(v.regNo)}">
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

  function customerOptions(selectedId = '') {
    const customers = Storage.getData('customers')
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    return `<option value="">— Select customer —</option>` + customers.map(c =>
      `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)} — ${esc(c.phone)}</option>`
    ).join('');
  }

  function selectOptions(list, selected) {
    return `<option value="">— Select —</option>` +
      list.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  function formHtml(v = {}) {
    return `
      <form id="vehForm" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            <label for="vf-customer">Customer <span class="req">*</span></label>
            <select class="select" id="vf-customer" name="customerId">${customerOptions(v.customerId)}</select>
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field">
            <label for="vf-reg">Registration Number <span class="req">*</span></label>
            <input class="input" id="vf-reg" name="regNo" value="${esc(v.regNo || '')}" placeholder="DHAKA-METRO-GA-1234" autocomplete="off">
            <div class="field__error" data-err="regNo"></div>
          </div>
          <div class="field">
            <label for="vf-year">Year</label>
            <input class="input" id="vf-year" name="year" type="number" min="1950" value="${esc(v.year || '')}">
            <div class="field__error" data-err="year"></div>
          </div>
          <div class="field">
            <label for="vf-brand">Brand <span class="req">*</span></label>
            <input class="input" id="vf-brand" name="brand" value="${esc(v.brand || '')}" placeholder="Toyota" autocomplete="off">
            <div class="field__error" data-err="brand"></div>
          </div>
          <div class="field">
            <label for="vf-model">Model <span class="req">*</span></label>
            <input class="input" id="vf-model" name="model" value="${esc(v.model || '')}" placeholder="Corolla" autocomplete="off">
            <div class="field__error" data-err="model"></div>
          </div>
          <div class="field">
            <label for="vf-color">Color</label>
            <input class="input" id="vf-color" name="color" value="${esc(v.color || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-mileage">Mileage (km)</label>
            <input class="input" id="vf-mileage" name="mileage" type="number" min="0" value="${esc(v.mileage || '')}">
            <div class="field__error" data-err="mileage"></div>
          </div>
          <div class="field">
            <label for="vf-fuel">Fuel Type</label>
            <select class="select" id="vf-fuel" name="fuelType">${selectOptions(FUEL_TYPES, v.fuelType)}</select>
          </div>
          <div class="field">
            <label for="vf-trans">Transmission</label>
            <select class="select" id="vf-trans" name="transmission">${selectOptions(TRANSMISSIONS, v.transmission)}</select>
          </div>
          <div class="field">
            <label for="vf-vin">VIN</label>
            <input class="input" id="vf-vin" name="vin" value="${esc(v.vin || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-chassis">Chassis Number</label>
            <input class="input" id="vf-chassis" name="chassisNo" value="${esc(v.chassisNo || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-engine">Engine Number</label>
            <input class="input" id="vf-engine" name="engineNo" value="${esc(v.engineNo || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-next">Next Service Date</label>
            <input class="input" id="vf-next" name="nextServiceDate" type="date" value="${esc(v.nextServiceDate || '')}">
          </div>
          <div class="field">
            <label for="vf-status">Status</label>
            <select class="select" id="vf-status" name="status">
              <option${(v.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${v.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field span-2">
            <label for="vf-notes">Notes</label>
            <textarea class="textarea" id="vf-notes" name="notes" rows="2">${esc(v.notes || '')}</textarea>
          </div>
        </div>
      </form>`;
  }

  function readForm(form) {
    const val = n => form[n].value.trim();
    return {
      customerId: val('customerId'), regNo: val('regNo').toUpperCase(),
      brand: val('brand'), model: val('model'),
      year: val('year') ? Number(val('year')) : '',
      color: val('color'),
      mileage: val('mileage') ? Number(val('mileage')) : '',
      fuelType: val('fuelType'), transmission: val('transmission'),
      vin: val('vin'), chassisNo: val('chassisNo'), engineNo: val('engineNo'),
      nextServiceDate: val('nextServiceDate'),
      status: val('status') || 'Active',
      notes: val('notes')
    };
  }

  function validate(values, editingId = null) {
    const errors = {};
    const thisYear = new Date().getFullYear();

    if (!values.customerId) {
      errors.customerId = 'Select the customer who owns this vehicle.';
    } else if (!Storage.getById('customers', values.customerId)) {
      errors.customerId = 'Selected customer no longer exists.';
    }
    if (!values.regNo) {
      errors.regNo = 'Registration number is required.';
    } else {
      const norm = values.regNo.replace(/[\s-]/g, '').toLowerCase();
      const dup = Storage.getData('vehicles').find(v =>
        v.id !== editingId && (v.regNo || '').replace(/[\s-]/g, '').toLowerCase() === norm);
      if (dup) errors.regNo = 'A vehicle with this registration number already exists.';
    }
    if (!values.brand) errors.brand = 'Brand is required.';
    if (!values.model) errors.model = 'Model is required.';
    if (values.year !== '' && (values.year < 1950 || values.year > thisYear + 1))
      errors.year = `Year must be between 1950 and ${thisYear + 1}.`;
    if (values.mileage !== '' && values.mileage < 0)
      errors.mileage = 'Mileage cannot be negative.';

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

  function openAddModal(prefillCustomerId = '') {
    if (!Storage.getData('customers').length) {
      Modal.open({
        title: 'No customers yet',
        body: `<p style="margin:0">Every vehicle must belong to a customer. Add a customer first, then register their vehicle.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <a class="btn btn--primary" href="customers.html">Go to Customers</a>`
      });
      return;
    }
    const ov = Modal.open({
      title: 'Add Vehicle', size: 'lg',
      body: formHtml({ customerId: prefillCustomerId }),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Vehicle</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', () => {
      const form = ov.querySelector('#vehForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) {
        showErrors(form, errors);
        toast(errors.regNo === 'A vehicle with this registration number already exists.'
          ? errors.regNo : 'Please fix the highlighted fields.', 'error');
        return;
      }
      const rec = Storage.addData('vehicles', values);
      Modal.close();
      refresh();
      toast(`Vehicle ${rec.regNo} added (${rec.id}).`);
    });
  }

  function openEditModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const ov = Modal.open({
      title: `Edit Vehicle — ${v.id}`, size: 'lg',
      body: formHtml(v),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', () => {
      const form = ov.querySelector('#vehForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      Storage.updateData('vehicles', id, values);
      Modal.close();
      refresh();
      toast(`Vehicle ${values.regNo} updated.`);
    });
  }

  /* ============================================================
     Delete (protect historical records)
     ============================================================ */

  function openDeleteModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const jobs = Storage.getData('jobCards').filter(j => j.vehicleId === id);
    const invoices = Storage.getData('invoices').filter(i => i.vehicleId === id);
    const appts = Storage.getData('appointments').filter(a => a.vehicleId === id);

    if (jobs.length || invoices.length || appts.length) {
      const parts = [];
      if (jobs.length) parts.push(`${jobs.length} job card${jobs.length > 1 ? 's' : ''}`);
      if (invoices.length) parts.push(`${invoices.length} invoice${invoices.length > 1 ? 's' : ''}`);
      if (appts.length) parts.push(`${appts.length} appointment${appts.length > 1 ? 's' : ''}`);
      Modal.open({
        title: 'Cannot delete vehicle',
        body: `<p style="margin:0"><strong>${esc(v.regNo)}</strong> has ${parts.join(', ')} on record.
               Deleting the vehicle would destroy historical business data.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Mark the vehicle inactive instead to hide it from day-to-day use while keeping its history.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <button class="btn btn--primary" data-mark-inactive>Mark Inactive</button>`
      }).querySelector('[data-mark-inactive]').addEventListener('click', () => {
        Storage.updateData('vehicles', id, { status: 'Inactive' });
        Modal.close();
        refresh();
        toast(`Vehicle ${v.regNo} marked inactive.`, 'info');
      });
      return;
    }

    Modal.confirm({
      title: 'Delete vehicle?',
      message: `Are you sure you want to delete <strong>${esc(v.regNo)}</strong> (${esc(v.brand)} ${esc(v.model)})? This cannot be undone.`,
      confirmText: 'Delete Vehicle',
      onConfirm: () => {
        Storage.deleteData('vehicles', id);
        refresh();
        toast(`Vehicle ${v.regNo} deleted.`, 'warning');
      }
    });
  }

  /* ============================================================
     Details view
     ============================================================ */

  function openDetailModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const st = vehicleStats(id);
    const owner = Storage.getById('customers', v.customerId);

    const info = [
      ['Vehicle ID', v.id], ['Registration', v.regNo],
      ['Brand', v.brand], ['Model', v.model],
      ['Year', v.year || '—'], ['Color', v.color || '—'],
      ['VIN', v.vin || '—'], ['Chassis No', v.chassisNo || '—'],
      ['Engine No', v.engineNo || '—'],
      ['Mileage', v.mileage ? `${Number(v.mileage).toLocaleString('en-IN')} km` : '—'],
      ['Fuel Type', v.fuelType || '—'], ['Transmission', v.transmission || '—']
    ];

    const jobs = st.jobs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const historyHtml = jobs.length
      ? `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Job Card</th><th>Date</th><th>Service</th><th>Mechanic</th><th class="num">Mileage</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>${jobs.map(j => `
            <tr>
              <td class="cell-main">${esc(j.id)}</td>
              <td>${fmtDate(j.date)}</td>
              <td>${esc((j.services || []).map(s => s.name).join(', ') || '—')}</td>
              <td>${esc(Utils.mechanicName(j.mechanicId))}</td>
              <td class="num">${j.mileage ? Number(j.mileage).toLocaleString('en-IN') : '—'}</td>
              <td class="num">${money(j.total)}</td>
              <td>${badge(j.status)}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : `<p class="muted-note">No service history yet.</p>`;

    const invs = st.invoices.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const invoiceHtml = invs.length
      ? `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Invoice</th><th>Date</th><th>Job Card</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th></tr></thead>
          <tbody>${invs.map(i => `
            <tr>
              <td class="cell-main">${esc(i.id)}</td>
              <td>${fmtDate(i.date)}</td>
              <td>${esc(i.jobCardId || '—')}</td>
              <td class="num">${money(i.total)}</td>
              <td class="num">${money(i.paid)}</td>
              <td class="num">${i.due > 0 ? `<span class="due">${money(i.due)}</span>` : money(0)}</td>
              <td>${badge(i.status)}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : `<p class="muted-note">No invoice history yet.</p>`;

    Modal.open({
      title: `${v.brand} ${v.model} — ${v.regNo}`,
      size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          ${info.map(([k, val]) => `<div class="detail-item"><span>${k}</span><strong>${esc(String(val))}</strong></div>`).join('')}
          <div class="detail-item"><span>Status</span><strong>${badge(v.status || 'Active')}</strong></div>
        </div>

        <h3 class="detail-section-title">Owner</h3>
        ${owner ? `
        <div class="detail-grid">
          <div class="detail-item"><span>Name</span><strong>${esc(owner.name)} (${esc(owner.id)})</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${esc(owner.phone)}</strong></div>
          <div class="detail-item"><span>Email</span><strong>${owner.email ? esc(owner.email) : '—'}</strong></div>
          <div class="detail-item"><span>Address</span><strong>${owner.address ? esc(owner.address) : '—'}</strong></div>
        </div>` : `<p class="muted-note">Owner record not found (${esc(v.customerId || 'none')}).</p>`}

        <div class="summary-row summary-row--6">
          <div class="summary-tile"><strong>${st.serviceCount}</strong><span>Total Services</span></div>
          <div class="summary-tile"><strong>${money(st.totalSpent)}</strong><span>Total Spent</span></div>
          <div class="summary-tile summary-tile--good"><strong>${money(st.totalPaid)}</strong><span>Total Paid</span></div>
          <div class="summary-tile ${st.totalDue > 0 ? 'summary-tile--bad' : ''}"><strong>${money(st.totalDue)}</strong><span>Total Due</span></div>
          <div class="summary-tile"><strong>${st.lastServiceDate ? fmtDate(st.lastServiceDate) : 'No service yet'}</strong><span>Last Service</span></div>
          <div class="summary-tile"><strong>${v.nextServiceDate ? fmtDate(v.nextServiceDate) : '—'}</strong><span>Next Service</span></div>
        </div>

        <h3 class="detail-section-title">Service History</h3>
        ${historyHtml}

        <h3 class="detail-section-title">Invoice History</h3>
        ${invoiceHtml}`,
      footer: `
        ${owner ? `<a class="btn btn--ghost" href="customers.html?view=${encodeURIComponent(owner.id)}">View Customer</a>` : ''}
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-edit-from-view>Edit Vehicle</button>`
    }).querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* ============================================================
     Events + init
     ============================================================ */

  function refresh() {
    populateBrandFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addVehicleBtn').addEventListener('click', () => openAddModal());

    document.getElementById('vehSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('vehBrand').addEventListener('change', e => { fBrand = e.target.value; renderList(); });
    document.getElementById('vehFuel').addEventListener('change', e => { fFuel = e.target.value; renderList(); });
    document.getElementById('vehService').addEventListener('change', e => { fService = e.target.value; renderList(); });
    document.getElementById('vehStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('vehSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('vehTableBody').addEventListener('click', e => {
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
    refresh();
    // Deep link: vehicles.html?view=VEH-0001 opens details directly
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('vehicles', viewId)) openDetailModal(viewId);
  });

})();
