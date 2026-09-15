/* ============================================================
   invoices.js — Invoice Management module
   Invoices are historical financial records generated FROM a Job
   Card. Job Cards are already snapshot-based (services/parts keep
   their name+unitPrice at the time they were added, and totals are
   computed once and stored flat) — an Invoice simply copies those
   already-correct, already-frozen numbers. No calculation logic is
   duplicated here.

   Eligibility to CREATE an invoice from a Job Card:
   - Job Card exists, and its customer + vehicle references resolve
   - Job Card status is Completed or Delivered (by then its financial
     fields are already locked by job-cards.js's own edit-lock, so an
     Invoice snapshot taken at this point can never drift)
   - Job Card has a billable total > 0
   - Job Card does not already have an invoice (checked both via
     jobCard.invoiceId and a reverse lookup, mirroring the same
     dual-check job-cards.js uses for its own delete guard)

   Status model: Unpaid | Partial | Paid | Void. Derived from
   paid/due at creation time and stored (matching the existing
   Paid/Partial/Unpaid tones already defined in Utils' STATUS_TONE
   map). Void is an explicit action, never auto-derived afterward.
   There is no separate Draft/Issued phase — nothing else in this
   app has a draft-then-issue workflow (Job Cards are created
   directly), so an Invoice is a finished, billable record the
   moment it's created.

   Historical protection: once created, an Invoice's financial
   fields (services, parts, labour, discount, tax, totals) are never
   editable. Only `notes` can be edited, and `Void` (soft-cancel) is
   available in place of destructive edits. Delete is only permitted
   for a Void invoice with paid = 0.

   Storage: uses Storage.getData/getById/addData/updateData/deleteData
   exclusively — no direct localStorage access.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  const ELIGIBLE_JOB_STATUSES = ['Completed', 'Delivered'];
  const STATUSES = ['Unpaid', 'Partial', 'Paid', 'Void'];

  let searchTerm = '';
  let fStatus = 'all', fDate = '';
  let sortBy = 'date-desc';

  /* ---------- safe lookups ---------- */

  const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
  const custPhone = id => (Storage.getById('customers', id) || {}).phone || 'N/A';
  const custAddress = id => (Storage.getById('customers', id) || {}).address || '';
  const veh = id => Storage.getById('vehicles', id);
  const vehText = id => { const v = veh(id); return v ? `${v.brand} ${v.model}` : 'Unknown Vehicle'; };
  const vehReg = id => { const v = veh(id); return v ? v.regNo : 'N/A'; };

  /* ---------- status derivation ---------- */

  /** Derive Unpaid/Partial/Paid from paid+total. Void is never derived — only set explicitly. */
  function deriveStatus(total, paid) {
    const t = Number(total) || 0;
    const p = Math.max(0, Number(paid) || 0);
    if (t > 0 && p >= t) return 'Paid';
    if (p > 0) return 'Partial';
    return 'Unpaid';
  }

  /* ---------- eligibility ---------- */

  /** Find an existing invoice for a job card, if any (defensive dual lookup). */
  function existingInvoiceFor(jobCard) {
    if (jobCard.invoiceId) {
      const byId = Storage.getById('invoices', jobCard.invoiceId);
      if (byId) return byId;
    }
    // Exclude Void invoices from the reverse lookup: a voided invoice keeps
    // its jobCardId for history, but should not block a corrected invoice
    // from being created for the same Job Card (jobCard.invoiceId is
    // already cleared on void, so only this fallback path needs the guard).
    return Storage.getData('invoices').find(i => i.jobCardId === jobCard.id && i.status !== 'Void') || null;
  }

  /**
   * Checks whether a Job Card can have a new invoice created from it.
   * Returns { ok: true } or { ok: false, reason, existingInvoice? }.
   */
  function checkEligibility(jobCardId) {
    const job = Storage.getById('jobCards', jobCardId);
    if (!job) return { ok: false, reason: 'Job Card not found.' };

    const existing = existingInvoiceFor(job);
    if (existing) return { ok: false, reason: 'This Job Card already has an invoice.', existingInvoice: existing };

    const customer = Storage.getById('customers', job.customerId);
    if (!customer) return { ok: false, reason: 'This Job Card\u2019s customer record no longer exists.' };

    const vehicle = Storage.getById('vehicles', job.vehicleId);
    if (!vehicle) return { ok: false, reason: 'This Job Card\u2019s vehicle record no longer exists.' };

    if (!ELIGIBLE_JOB_STATUSES.includes(job.status)) {
      return { ok: false, reason: `Job Card must be Completed or Delivered before invoicing (currently ${job.status}).` };
    }

    if (!(Number(job.total) > 0)) {
      return { ok: false, reason: 'This Job Card has no billable amount.' };
    }

    return { ok: true, job, customer, vehicle };
  }

  /**
   * Creates an invoice from an eligible Job Card. Deep-copies line
   * items so the Invoice never shares a live reference with the Job
   * Card record. Does NOT touch inventory — that was already
   * resolved when the Job Card's parts were issued.
   */
  function createInvoiceFromJobCard(jobCardId, { date, notes } = {}) {
    const check = checkEligibility(jobCardId);
    if (!check.ok) return check;
    const { job } = check;

    const services = (job.services || []).map(l => ({ ...l }));
    const partsUsed = (job.partsUsed || []).map(l => ({ ...l }));
    // Defensive floors/ceiling: job-cards.js already validates these at the
    // source (paid cannot exceed total, discount cannot be negative, etc.),
    // so this never changes a legitimately-created invoice's numbers -- it
    // only guards the financial record itself against ever storing an
    // invalid combination (negative total, or paid > total).
    const total = Math.max(0, Number(job.total) || 0);
    const paid = Math.min(total, Math.max(0, Number(job.paid) || 0));
    const due = Math.max(total - paid, 0);

    const invoice = Storage.addData('invoices', {
      jobCardId: job.id,
      customerId: job.customerId,
      vehicleId: job.vehicleId,
      date: date || job.actualDelivery || (job.completedAt ? job.completedAt.slice(0, 10) : Utils.todayStr()),
      services, partsUsed,
      labourCost: Number(job.labourCost) || 0,
      discount: Number(job.discount) || 0,
      taxRate: Number(job.taxRate) || 0,
      subtotal: Number(job.subtotal) || 0,
      tax: Number(job.tax) || 0,
      total, paid, due,
      status: deriveStatus(total, paid),
      notes: (notes || '').trim()
    });

    Storage.updateData('jobCards', job.id, { invoiceId: invoice.id });
    return { ok: true, invoice };
  }

  /** Void an invoice (soft-cancel). Clears the Job Card's invoiceId if it still points here. */
  function voidInvoice(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return { ok: false, reason: 'Invoice not found.' };
    if (inv.status === 'Void') return { ok: false, reason: 'Invoice is already void.' };

    Storage.updateData('invoices', id, { status: 'Void' });
    if (inv.jobCardId) {
      const job = Storage.getById('jobCards', inv.jobCardId);
      if (job && job.invoiceId === id) {
        Storage.updateData('jobCards', inv.jobCardId, { invoiceId: null });
      }
    }
    return { ok: true };
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const invoices = Storage.getData('invoices');
    const live = invoices.filter(i => i.status !== 'Void');
    const totalBilled = live.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const totalCollected = live.reduce((s, i) => s + (Number(i.paid) || 0), 0);
    const totalDue = live.reduce((s, i) => s + (Number(i.due) || 0), 0);
    const unpaidCount = live.filter(i => i.status === 'Unpaid' || i.status === 'Partial').length;

    const stats = [
      { label: 'Total Invoices', value: invoices.length, tone: 'info', icon: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z' },
      { label: 'Total Billed', value: money(totalBilled), tone: 'info', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: 'Total Collected', value: money(totalCollected), tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Total Due', value: money(totalDue), tone: 'bad', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z' },
      { label: 'Unpaid / Partial', value: unpaidCount, tone: 'warn', icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z' }
    ];

    document.getElementById('invcStats').innerHTML = stats.map(s => `
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

  function filteredInvoices() {
    const term = searchTerm.trim().toLowerCase();
    let rows = Storage.getData('invoices').filter(i => {
      if (fStatus !== 'all' && i.status !== fStatus) return false;
      if (fDate && i.date !== fDate) return false;
      if (term) {
        const hay = [i.id, i.jobCardId, custName(i.customerId), vehReg(i.vehicleId), vehText(i.vehicleId)]
          .join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      switch (sortBy) {
        case 'date-asc': return (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id);
        case 'id': return a.id.localeCompare(b.id);
        case 'customer': return custName(a.customerId).localeCompare(custName(b.customerId));
        case 'total-desc': return (Number(b.total) || 0) - (Number(a.total) || 0);
        case 'due-desc': return (Number(b.due) || 0) - (Number(a.due) || 0);
        default: return (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id); // date-desc
      }
    });
    return rows;
  }

  function renderList() {
    const rows = filteredInvoices();
    const total = Storage.getData('invoices').length;
    const tbody = document.getElementById('invcTableBody');
    const isFiltered = searchTerm || fStatus !== 'all' || fDate;

    document.getElementById('invcCount').textContent =
      isFiltered ? `${rows.length} of ${total} invoices` : `${total} invoices`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            <h3>${isFiltered ? 'No invoices match your search or filter.' : 'No invoices yet.'}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Invoices are created from a Completed or Delivered Job Card — open one and use "Create Invoice".'}</p>
            ${isFiltered ? '' : '<a class="btn btn--primary" href="job-cards.html">Go to Job Cards</a>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(i => `
      <tr data-id="${esc(i.id)}">
        <td class="cell-main">${esc(i.id)}</td>
        <td>${fmtDate(i.date)}</td>
        <td class="cell-main">${esc(custName(i.customerId))}</td>
        <td>${esc(vehText(i.vehicleId))}<span class="cell-sub">${esc(vehReg(i.vehicleId))}</span></td>
        <td>${i.jobCardId ? `<a href="job-cards.html?view=${encodeURIComponent(i.jobCardId)}">${esc(i.jobCardId)}</a>` : '—'}</td>
        <td class="num">${money(i.total)}</td>
        <td class="num">${money(i.paid)}</td>
        <td class="num">${money(i.due)}</td>
        <td>${badge(i.status)}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View" aria-label="View ${esc(i.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="print" title="Print" aria-label="Print ${esc(i.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 8H5c-1.7 0-3 1.3-3 3v6h4v4h12v-4h4v-6c0-1.7-1.3-3-3-3zm-3 11H8v-5h8v5zm3-7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>
            ${i.status !== 'Void' ? `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="void" title="Void" aria-label="Void ${esc(i.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z"/></svg>
            </button>` : `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(i.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>`}
          </div>
        </td>
      </tr>`).join('');
  }

  /* ---------- create invoice modal (from an eligible Job Card) ---------- */

  function openCreateModal(jobCardId) {
    const check = checkEligibility(jobCardId);
    if (!check.ok) {
      if (check.existingInvoice) {
        toast('This Job Card already has an invoice.', 'info');
        openDetailModal(check.existingInvoice.id);
      } else {
        Modal.open({
          title: 'Cannot create invoice',
          body: `<p style="margin:0">${esc(check.reason)}</p>`,
          footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                   <a class="btn btn--primary" href="job-cards.html?view=${encodeURIComponent(jobCardId)}">Go to Job Card</a>`
        });
      }
      return;
    }
    const { job, customer, vehicle } = check;
    const defaultDate = job.actualDelivery || (job.completedAt ? job.completedAt.slice(0, 10) : Utils.todayStr());

    const ov = Modal.open({
      title: `Create Invoice — ${job.id}`,
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Customer</span><strong>${esc(customer.name)}</strong></div>
          <div class="detail-item"><span>Vehicle</span><strong>${esc(vehicle.brand)} ${esc(vehicle.model)} (${esc(vehicle.regNo)})</strong></div>
          <div class="detail-item"><span>Job Card Total</span><strong>${money(job.total)}</strong></div>
        </div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field">
            <label for="invc-date">Invoice Date</label>
            <input class="input" id="invc-date" type="date" value="${esc(defaultDate)}">
          </div>
          <div class="field">
            <label for="invc-notes">Notes (optional)</label>
            <textarea class="input" id="invc-notes" rows="2" placeholder="Optional note for this invoice"></textarea>
          </div>
        </div>
        <p class="muted-note" style="margin-top:10px">
          Services, parts, labour, discount, tax and totals are copied from ${esc(job.id)} exactly as they
          stand now and will not change if the service or part catalog changes later.
        </p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Create Invoice</button>`
    });

    ov.querySelector('[data-save]').addEventListener('click', () => {
      const date = ov.querySelector('#invc-date').value || defaultDate;
      const notes = ov.querySelector('#invc-notes').value;
      const result = createInvoiceFromJobCard(jobCardId, { date, notes });
      if (!result.ok) {
        toast(result.reason || 'Could not create invoice.', 'error');
        Modal.close();
        return;
      }
      Modal.close();
      refresh();
      toast(`Invoice ${result.invoice.id} created for ${custName(result.invoice.customerId)}.`);
      openDetailModal(result.invoice.id);
    });
  }

  /* ---------- notes edit (the only editable field on an existing invoice) ---------- */

  function openNotesModal(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return;
    const ov = Modal.open({
      title: `Edit Notes — ${inv.id}`,
      body: `<div class="field"><label for="invc-notes-edit">Notes</label>
             <textarea class="input" id="invc-notes-edit" rows="3">${esc(inv.notes || '')}</textarea></div>
             <p class="muted-note" style="margin-top:8px">Only notes can be edited on an existing invoice. Financial figures are historical and locked; use Void if the invoice is wrong.</p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Notes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', () => {
      Storage.updateData('invoices', id, { notes: ov.querySelector('#invc-notes-edit').value });
      Modal.close();
      refresh();
      toast(`Invoice ${id} notes updated.`);
    });
  }

  /* ---------- void / delete ---------- */

  function openVoidModal(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return;
    Modal.confirm({
      title: 'Void invoice?',
      message: `Void <strong>${esc(inv.id)}</strong> for ${esc(custName(inv.customerId))}? The invoice record is kept for
                history but marked Void, and its Job Card becomes eligible for a corrected invoice. This cannot be undone.`,
      confirmText: 'Void Invoice',
      onConfirm: () => {
        const res = voidInvoice(id);
        if (!res.ok) { toast(res.reason || 'Could not void invoice.', 'error'); return; }
        refresh();
        toast(`Invoice ${id} voided.`, 'warning');
      }
    });
  }

  function openDeleteModal(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return;
    if (inv.status !== 'Void') {
      Modal.open({
        title: 'Cannot delete invoice',
        body: `<p style="margin:0"><strong>${esc(inv.id)}</strong> is an active financial record. Void it first if it needs to be removed from the books.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (Number(inv.paid) > 0) {
      Modal.open({
        title: 'Cannot delete invoice',
        body: `<p style="margin:0"><strong>${esc(inv.id)}</strong> has recorded payments against it and must be kept for the audit trail.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    Modal.confirm({
      title: 'Delete invoice?',
      message: `Permanently delete voided invoice <strong>${esc(inv.id)}</strong>? This cannot be undone.`,
      confirmText: 'Delete Invoice',
      onConfirm: () => {
        if (inv.jobCardId) {
          const job = Storage.getById('jobCards', inv.jobCardId);
          if (job && job.invoiceId === id) Storage.updateData('jobCards', inv.jobCardId, { invoiceId: null });
        }
        Storage.deleteData('invoices', id);
        refresh();
        toast(`Invoice ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- detail view ---------- */

  function lineRows(lines, isService) {
    if (!lines || !lines.length) return `<p class="muted-note">${isService ? 'No services.' : 'No parts.'}</p>`;
    return `<div class="table-wrap"><table class="table table--compact">
      <thead><tr>
        <th>${isService ? 'Service' : 'Part'}</th>${isService ? '' : '<th>Part No.</th>'}
        <th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Total</th>
      </tr></thead>
      <tbody>${lines.map(l => `<tr>
        <td>${esc(l.name)}</td>${isService ? '' : `<td>${esc(l.partNo || '—')}</td>`}
        <td class="num">${l.qty}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.total)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function openDetailModal(id) {
    const i = Storage.getById('invoices', id);
    if (!i) return;
    const vehicle = veh(i.vehicleId);

    const ov = Modal.open({
      title: `Invoice ${i.id}`, size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Status</span><strong>${badge(i.status)}</strong></div>
          <div class="detail-item"><span>Date</span><strong>${fmtDate(i.date)}</strong></div>
          <div class="detail-item"><span>Job Card</span><strong>${i.jobCardId ? esc(i.jobCardId) : '—'}</strong></div>
        </div>

        <h3 class="detail-section-title">Customer &amp; Vehicle</h3>
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Customer</span><strong>${esc(custName(i.customerId))}</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${esc(custPhone(i.customerId))}</strong></div>
          <div class="detail-item"><span>Registration</span><strong>${esc(vehReg(i.vehicleId))}</strong></div>
          <div class="detail-item"><span>Vehicle</span><strong>${esc(vehText(i.vehicleId))}</strong></div>
          <div class="detail-item"><span>Year</span><strong>${vehicle && vehicle.year ? vehicle.year : 'N/A'}</strong></div>
          <div class="detail-item"><span>VIN</span><strong>${vehicle && vehicle.vin ? esc(vehicle.vin) : 'N/A'}</strong></div>
        </div>

        <h3 class="detail-section-title">Services</h3>
        ${lineRows(i.services, true)}

        <h3 class="detail-section-title">Parts</h3>
        ${lineRows(i.partsUsed, false)}

        <h3 class="detail-section-title">Totals</h3>
        <div class="totals-panel totals-panel--view">
          <div><span>Labour</span><strong>${money(i.labourCost)}</strong></div>
          <div><span>Subtotal</span><strong>${money(i.subtotal)}</strong></div>
          <div><span>Discount</span><strong>\u2212 ${money(i.discount)}</strong></div>
          <div><span>Tax (${i.taxRate || 0}%)</span><strong>+ ${money(i.tax)}</strong></div>
          <div class="totals-grand"><span>Grand Total</span><strong>${money(i.total)}</strong></div>
          <div><span>Paid</span><strong>${money(i.paid)}</strong></div>
          <div class="${Number(i.due) > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(i.due)}</strong></div>
        </div>

        ${i.notes ? `<h3 class="detail-section-title">Notes</h3><p class="detail-text">${esc(i.notes)}</p>` : ''}`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${i.jobCardId ? `<a class="btn btn--ghost" href="job-cards.html?view=${encodeURIComponent(i.jobCardId)}">View Job Card</a>` : ''}
        ${i.status !== 'Void' && Number(i.due) > 0
          ? `<a class="btn btn--ghost" href="payments.html?forInvoice=${encodeURIComponent(i.id)}">Record Payment</a>`
          : `<a class="btn btn--ghost" href="payments.html?invoice=${encodeURIComponent(i.id)}">View Payments</a>`}
        ${i.status !== 'Void' ? '<button class="btn btn--ghost" data-edit-notes>Edit Notes</button>' : ''}
        ${i.status !== 'Void' ? '<button class="btn btn--primary" data-void>Void Invoice</button>' : ''}`
    });
    document.querySelector('[data-print-view]').addEventListener('click', () => printInvoice(id));
    const editBtn = document.querySelector('[data-edit-notes]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openNotesModal(id); });
    const voidBtn = document.querySelector('[data-void]');
    if (voidBtn) voidBtn.addEventListener('click', () => { Modal.close(); openVoidModal(id); });
  }

  /* ---------- print ---------- */

  function printInvoice(id) {
    const i = Storage.getById('invoices', id);
    if (!i) return;
    const settings = Storage.getSettings();
    const vehicle = veh(i.vehicleId);
    const customer = Storage.getById('customers', i.customerId);

    const printRows = (lines, isService) => (lines || []).map(l =>
      `<tr><td>${esc(l.name)}${!isService && l.partNo ? ` (${esc(l.partNo)})` : ''}</td>
       <td class="pr-num">${l.qty}</td><td class="pr-num">${money(l.unitPrice)}</td><td class="pr-num">${money(l.total)}</td></tr>`).join('');

    document.getElementById('printArea').innerHTML = `
      <div class="pr-head">
        <div>
          <h1>${esc(settings.businessName)}</h1>
          <p>${esc(settings.address)} \u00b7 ${esc(settings.phone)}</p>
          ${(settings.email || settings.website) ? `<p>${[settings.email, settings.website].filter(Boolean).map(x => esc(x)).join(' \u00b7 ')}</p>` : ''}
          ${settings.taxId ? `<p>Tax/VAT: ${esc(settings.taxId)}</p>` : ''}
        </div>
        <div class="pr-meta">
          <h2>INVOICE</h2>
          <p><strong>${esc(i.id)}</strong></p>
          <p>${fmtDate(i.date)}</p>
          ${i.jobCardId ? `<p>Job Card: ${esc(i.jobCardId)}</p>` : ''}
        </div>
      </div>

      <div class="pr-cols">
        <div>
          <h3>Customer</h3>
          <p>${customer ? esc(customer.name) : 'Unknown Customer'}<br>${customer ? esc(customer.phone) : ''}
             ${customer && customer.address ? `<br>${esc(customer.address)}` : ''}</p>
        </div>
        <div>
          <h3>Vehicle</h3>
          <p>${vehicle ? esc(`${vehicle.brand} ${vehicle.model}`) : 'Unknown Vehicle'}<br>
             ${esc(vehReg(i.vehicleId))}
             ${vehicle && vehicle.year ? `<br>Year: ${vehicle.year}` : ''}
             ${vehicle && vehicle.vin ? `<br>VIN: ${esc(vehicle.vin)}` : ''}</p>
        </div>
      </div>

      ${(i.services || []).length ? `<h3>Services</h3>
      <table class="pr-table"><thead><tr><th>Service</th><th class="pr-num">Qty</th><th class="pr-num">Unit</th><th class="pr-num">Total</th></tr></thead>
      <tbody>${printRows(i.services, true)}</tbody></table>` : ''}

      ${(i.partsUsed || []).length ? `<h3>Parts</h3>
      <table class="pr-table"><thead><tr><th>Part</th><th class="pr-num">Qty</th><th class="pr-num">Unit</th><th class="pr-num">Total</th></tr></thead>
      <tbody>${printRows(i.partsUsed, false)}</tbody></table>` : ''}

      <table class="pr-totals">
        <tr><td>Subtotal (services + parts + labour ${money(i.labourCost || 0)})</td><td class="pr-num">${money(i.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="pr-num">\u2212 ${money(i.discount)}</td></tr>
        <tr><td>Tax (${i.taxRate || 0}%)</td><td class="pr-num">+ ${money(i.tax)}</td></tr>
        <tr class="pr-grand"><td>Grand Total</td><td class="pr-num">${money(i.total)}</td></tr>
        <tr><td>Paid</td><td class="pr-num">${money(i.paid)}</td></tr>
        <tr><td>Due</td><td class="pr-num">${money(i.due)}</td></tr>
      </table>

      ${i.notes ? `<h3>Notes</h3><p>${esc(i.notes)}</p>` : ''}
      ${i.status === 'Void' ? `<p style="font-weight:700;letter-spacing:2px;margin-top:16px">VOID</p>` : ''}

      <p class="pr-foot">${esc(settings.invoiceFooter)}</p>`;

    document.body.classList.add('printing-invoice');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-invoice'), 300);
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    renderList();
  }

  function bindEvents() {
    document.getElementById('invcSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('invcStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('invcDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('invcSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('invcTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'print') printInvoice(id);
      if (action === 'void') openVoidModal(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const fromJobCard = params.get('fromJobCard');
    if (viewId && Storage.getById('invoices', viewId)) openDetailModal(viewId);
    else if (fromJobCard) openCreateModal(fromJobCard);
  });

})();
