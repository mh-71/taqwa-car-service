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

  const { esc, money, fmtDate, badge, invoiceStatusLabel, toast, Modal } = Utils;

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
  /** Custom work: a service line with no catalogue service behind it (the job-cards.js rule). */
  const isCustomWork = l => !!l && l.serviceId === null;

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
   * Payments recorded against a Job Card before it was invoiced: non-Void,
   * linked to no invoice, carrying this jobCardId. These are what invoice
   * creation applies. The Job Card's typed `paid` is NOT one of them -- only
   * a recorded payment is money the workshop holds.
   */
  function jobCardAdvances(jobCardId) {
    return Storage.getData('payments')
      .filter(p => p.jobCardId === jobCardId && !p.invoiceId && p.status !== 'Void')
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
  }

  const sumAmounts = list => list.reduce((s, p) => s + (Number(p.amount) || 0), 0);

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

    // The server's advance refusals, in its order: an advance is applied whole
    // or the invoice is not created -- never partly, never to another customer.
    const advances = jobCardAdvances(job.id);
    if (advances.some(p => p.customerId !== job.customerId)) {
      return { ok: false, reason: 'An advance recorded on this Job Card belongs to a different customer. Resolve it on the Payments page before invoicing.' };
    }
    const advanceTotal = sumAmounts(advances);
    if (advanceTotal > (Number(job.total) || 0) + 0.005) {
      return { ok: false, reason: `The advances recorded on this Job Card (${money(advanceTotal)}) exceed the invoice total (${money(job.total)}). Nothing was created. Review the advances on the Payments page before invoicing.` };
    }

    return { ok: true, job, customer, vehicle, advances, advanceTotal };
  }

  /**
   * Creates an invoice from an eligible Job Card. Deep-copies line
   * items so the Invoice never shares a live reference with the Job
   * Card record. Does NOT touch inventory — that was already
   * resolved when the Job Card's parts were issued.
   */
  /**
   * Returns { ok, invoice } -- or a PROMISE of it when there is a backend.
   * Callers await it either way; without one the answer is immediate, which
   * is what keeps the offline path, and the tests that drive it, unchanged.
   */
  function createInvoiceFromJobCard(jobCardId, { date, notes } = {}) {
    const check = checkEligibility(jobCardId);
    if (!check.ok) return check;
    const { job } = check;

    // With a backend, an invoice is COPIED from its job card by the server,
    // in one transaction that also stamps the job card's invoiceId. Every
    // figure below -- totals, tax, paid, due, the line items -- is refused by
    // name if sent, precisely so a client cannot invent an invoice that does
    // not match the job card it claims to bill. So only the two fields that
    // are genuinely the user's are sent, and the eligibility rules are the
    // server's `ux_invoices_live_job_card` and its status checks.
    if (Storage.serverRules()) {
      return (async () => {
        const res = await Storage.create('invoices', {
          jobCardId: job.id,
          ...(date ? { date } : {}),
          ...(notes && notes.trim() ? { notes: notes.trim() } : {})
        });
        if (!res.ok) return { ok: false, reason: res.message, response: res };
        // Offline: a DRAFT, kept on this computer. No invoice exists and no
        // number is given until an authorized person finalizes it online.
        if (res.draft) return { ok: true, draft: res.record };
        // The server applied the job card's advances in the same transaction,
        // so the payments it linked are stale here as well as the job card.
        const stale = await Storage.refreshAll('jobCards', 'payments');
        const applied = (res.meta && res.meta.appliedAdvances) || [];
        return { ok: true, invoice: res.record, appliedAdvances: applied, ...(stale.length ? { stale } : {}) };
      })();
    }

    const services = (job.services || []).map(l => ({ ...l }));
    const partsUsed = (job.partsUsed || []).map(l => ({ ...l }));
    // Defensive floors/ceiling: job-cards.js already validates these at the
    // source (paid cannot exceed total, discount cannot be negative, etc.),
    // so this never changes a legitimately-created invoice's numbers -- it
    // only guards the financial record itself against ever storing an
    // invalid combination (negative total, or paid > total).
    // A new invoice starts unpaid: the Job Card's typed "Paid / Advance" is not
    // a recorded payment, so it is not copied (the server does the same). Cash
    // reaches an invoice only as a payment, which is what paid follows.
    const total = Math.max(0, Number(job.total) || 0);
    const paid = 0;
    const due = total;
    const { advances } = check;

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

    // Apply the advances checked above, then take paid/due/status from them --
    // the same figures the server's recompute writes for a new invoice.
    if (advances.length) {
      advances.forEach(p => Storage.updateData('payments', p.id, { invoiceId: invoice.id }));
      const applied = Math.min(total, sumAmounts(advances));
      const updated = Storage.updateData('invoices', invoice.id, {
        paid: applied,
        due: Math.max(total - applied, 0),
        status: deriveStatus(total, applied)
      });
      return { ok: true, invoice: updated, appliedAdvances: advances };
    }
    return { ok: true, invoice, appliedAdvances: [] };
  }

  /** Non-Void payments currently linked to an invoice. */
  function linkedActivePayments(invoiceId) {
    return Storage.getData('payments')
      .filter(p => p.invoiceId === invoiceId && p.status !== 'Void')
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
  }

  /**
   * Void an invoice (soft-cancel).
   *
   * Voiding cancels the DOCUMENT, never the money. Money that was actually
   * collected stays collected: each linked payment keeps its amount, date,
   * method and customer, and is RELEASED back to an advance (invoiceId null)
   * so it remains reachable by Payments' "Link to Invoice" flow and can be
   * applied to a corrected invoice. Voiding the payments instead would assert
   * the cash never arrived, which Payments -- the source of truth for what was
   * collected -- would then contradict.
   *
   * The invoice's own paid/due are deliberately NOT erased: they stay frozen
   * as the historical record of what this invoice had collected before it was
   * cancelled, and the delete guard in openDeleteModal() depends on them.
   *
   * Also clears the Job Card's invoiceId if it still points here, returning
   * the job to its un-invoiced state so a corrected invoice can be issued.
   *
   * Payments are reached through the public Storage API only -- the same way
   * this module already updates Job Cards (payments.js and invoices.js never
   * load on the same page, so neither can call into the other).
   *
   * Returns { ok: true, released } where `released` lists the payments that
   * became advances, so the caller can report exactly what moved.
   */
  function voidInvoice(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return { ok: false, reason: 'Invoice not found.' };
    if (inv.status === 'Void') return { ok: false, reason: 'Invoice is already void.' };

    // Read the links before the status flips, while the invoice is still live.
    const released = linkedActivePayments(id);

    // On the server this is one transaction: the status, the release of each
    // linked Active payment to an advance inheriting this invoice's job card
    // (audit Finding 7), and the job card's invoiceId. paid/due are written
    // by none of it -- they stay frozen at what this invoice had collected.
    if (Storage.isApi()) {
      return Storage.action('invoices', id, 'void', {}, ['payments', 'jobCards'])
        .then(res => res.ok ? { ok: true, released }
                            : { ok: false, reason: res.message, response: res });
    }

    Storage.updateData('invoices', id, { status: 'Void' });

    released.forEach(p => {
      Storage.updateData('payments', p.id, {
        invoiceId: null,
        // A payment recorded against an invoice carries no jobCardId of its
        // own, so inherit the invoice's: without it Reports can no longer
        // trace the collection to a Job Card, and therefore to a mechanic.
        jobCardId: p.jobCardId || inv.jobCardId || null
      });
    });

    if (inv.jobCardId) {
      const job = Storage.getById('jobCards', inv.jobCardId);
      if (job && job.invoiceId === id) {
        Storage.updateData('jobCards', inv.jobCardId, { invoiceId: null });
      }
    }
    return { ok: true, released };
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
        <td class="cell-main ivl-id">${esc(i.id)}</td>
        <td class="ivl-date" data-label="Date">${fmtDate(i.date)}</td>
        <td class="cell-main ivl-cust">${esc(custName(i.customerId))}</td>
        <td class="ivl-veh">${esc(vehText(i.vehicleId))}<span class="cell-sub">${esc(vehReg(i.vehicleId))}</span></td>
        <td class="ivl-job" data-label="Job Card">${i.jobCardId ? `<a href="job-cards.html?view=${encodeURIComponent(i.jobCardId)}">${esc(i.jobCardId)}</a>` : '—'}</td>
        <td class="num ivl-total" data-label="Total">${money(i.total)}</td>
        <td class="num ivl-paid" data-label="Paid">${money(i.paid)}</td>
        <td class="num ivl-due${i.status !== 'Void' && Number(i.due) > 0 ? ' ivl-due--open' : ''}" data-label="Due">${money(i.due)}</td>
        <td class="ivl-status">${badge(invoiceStatusLabel(i))}</td>
        <td class="ivl-act">
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
    const { job, customer, vehicle, advances, advanceTotal } = check;
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
        </p>
        ${advances.length ? `
        <div class="invc-create__advances" role="note">
          <strong>${advances.length === 1 ? 'This advance' : `These ${advances.length} advances`} will be applied to the invoice (${money(advanceTotal)}):</strong>
          <ul>${advances.map(p => `<li>${esc(p.id)} &middot; ${fmtDate(p.date)} &middot; ${esc(p.method)} &middot; ${money(p.amount)}</li>`).join('')}</ul>
          <span>Invoice Due after applying: ${money(Math.max((Number(job.total) || 0) - advanceTotal, 0))}</span>
        </div>` : ''}
        ${Number(job.paid) > 0 && !advances.length ? `<p class="invc-create__warn" role="note">This Job Card shows ${money(job.paid)} as Paid/Advance, but no advance payment is recorded for it, so nothing will be applied. If the money was received, use Record Advance on the Job Card first.</p>` : ''}`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Create Invoice</button>`
    });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const date = ov.querySelector('#invc-date').value || defaultDate;
      const notes = ov.querySelector('#invc-notes').value;
      const result = await createInvoiceFromJobCard(jobCardId, { date, notes });
      if (!result.ok) {
        toast(result.reason || 'Could not create invoice.', 'error');
        Modal.close();
        return;
      }
      Modal.close();
      refresh();
      if (result.draft) {
        toast(`Saved offline as invoice DRAFT ${result.draft.id}. It has no invoice number: it becomes an invoice only when finalized online (Offline & Sync).`, 'info');
        return;
      }
      const nApplied = (result.appliedAdvances || []).length;
      if (result.stale && result.stale.length) Utils.wrote(result);
      else if (nApplied) toast(`Invoice ${result.invoice.id} created. ${nApplied} advance${nApplied > 1 ? 's' : ''} (${money(sumAmounts(result.appliedAdvances))}) applied.`);
      else toast(`Invoice ${result.invoice.id} created for ${custName(result.invoice.customerId)}.`);
      openDetailModal(result.invoice.id);
    }));
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
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const res = await Storage.update('invoices', id, { notes: ov.querySelector('#invc-notes-edit').value });
      if (!Utils.wrote(res, ov)) return;
      Modal.close();
      refresh();
      toast(`Invoice ${id} notes updated.`);
    }));
  }

  /* ---------- void / delete ---------- */

  function openVoidModal(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv) return;
    const linked = linkedActivePayments(id);

    const apply = async () => {
      const res = await voidInvoice(id);
      if (!res.ok) { toast(res.reason || 'Could not void invoice.', 'error'); return; }
      refresh();
      const n = (res.released || []).length;
      toast(n
        ? `Invoice ${id} voided. ${n} payment${n > 1 ? 's' : ''} released as advances.`
        : `Invoice ${id} voided.`, 'warning');
    };

    const intro = `Void <strong>${esc(inv.id)}</strong> for ${esc(custName(inv.customerId))}? The invoice record is kept for
                   history but marked Void, and its Job Card becomes eligible for a corrected invoice. This cannot be undone.`;

    // No payments on this invoice -- keep the confirmation simple.
    if (!linked.length) {
      Modal.confirm({ title: 'Void invoice?', message: intro, confirmText: 'Void Invoice', onConfirm: apply });
      return;
    }

    // Payments exist -- say exactly which ones move, and where they go.
    const releasedTotal = linked.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const ov = Modal.open({
      title: 'Void invoice?',
      body: `
        <p style="margin:0">${intro}</p>
        <p style="margin:14px 0 8px">
          ${linked.length === 1 ? 'This payment' : `These ${linked.length} payments`}
          (<strong>${money(releasedTotal)}</strong>) will be kept and released as
          <strong>Advance Payments</strong>:
        </p>
        <div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Payment</th><th>Date</th><th>Method</th><th class="num">Amount</th></tr></thead>
          <tbody>${linked.map(p => `
            <tr>
              <td class="cell-main">${esc(p.id)}</td>
              <td>${fmtDate(p.date)}</td>
              <td>${esc(p.method)}</td>
              <td class="num">${money(p.amount)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
          No money is written off. Each stays on the books as collected revenue and can be
          re-applied to a replacement invoice from Payments &rarr; Link to Invoice.
        </p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--danger" data-confirm-void>Void Invoice</button>`
    });
    // The simple void path goes through Modal.confirm, which already waits.
    // This one is the same operation with a richer dialog, so it waits too:
    // closing first would hide the outcome of releasing the payments listed
    // right above the button, and leave a second click free to send it twice.
    ov.querySelector('[data-confirm-void]').addEventListener('click', Utils.saving(async () => {
      await apply();
      Modal.close();
    }));
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
      onConfirm: async () => {
        if (Storage.isApi()) {
          // The job card's invoiceId is cleared by the same delete on the
          // server; the two tables' mutual foreign keys are deferred for it.
          const res = await Storage.remove('invoices', id);
          if (!Utils.wrote(res)) return;
          const stale = inv.jobCardId ? await Storage.refreshAll('jobCards') : [];
          refresh();
          if (stale.length) Utils.wrote({ ok: true, stale });
          else toast(`Invoice ${id} deleted.`, 'warning');
          return;
        }
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
    return `<div class="table-wrap"><table class="table table--compact inv-view__lines">
      <thead><tr>
        <th class="inv-view__no">#</th><th>${isService ? 'Service / Work' : 'Part'}</th>${isService ? '' : '<th>Part No.</th>'}
        <th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Total</th>
      </tr></thead>
      <tbody>${lines.map((l, n) => `<tr>
        <td class="inv-view__no">${n + 1}</td>
        <td class="inv-view__name">${esc(l.name)}${isService && isCustomWork(l) ? ' <span class="inv-view__tag">Custom</span>' : ''}</td>${isService ? '' : `<td class="inv-view__partno" data-label="Part No.">${esc(l.partNo || '—')}</td>`}
        <td class="num" data-label="Qty">${l.qty}</td><td class="num" data-label="Unit Price">${money(l.unitPrice)}</td><td class="num inv-view__total" data-label="Total">${money(l.total)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  /* Presentation only: how the Details dialog dresses each status. The status
     itself, and every figure, is the stored one. */
  const VIEW_TONE = { Paid: 'good', Partial: 'warn', Unpaid: 'bad', Void: 'neutral', Settled: 'good', 'Written Off': 'neutral' };
  const VIEW_NOTE = {
    Paid: 'Fully settled', Partial: 'Partly paid', Unpaid: 'Awaiting payment', Void: 'Kept for history',
    Settled: 'Balance adjusted', 'Written Off': 'Balance written off'
  };

  function paymentStatusCard(i) {
    const label = invoiceStatusLabel(i);
    const wo = Number(i.writtenOff) || 0;
    // a write-off is named next to the cash, never folded into it
    const woPart = wo > 0 ? ` \u00b7 ${money(wo)} written off` : '';
    const say = {
      Paid: ['This invoice has been fully paid.', `A total of ${money(i.paid)} has been received.`],
      Settled: ['This invoice is settled.', `${money(i.paid)} received${woPart}.`],
      'Written Off': ['This invoice has been written off.', `${money(wo)} written off \u00b7 no payment received.`],
      Partial: ['This invoice is partly paid.', `${money(i.paid)} received${woPart} \u00b7 ${money(i.due)} outstanding.`],
      Unpaid: ['This invoice is unpaid.', wo > 0 ? `${money(wo)} written off \u00b7 ${money(i.due)} outstanding.` : `${money(i.due)} is outstanding.`],
      Void: ['This invoice has been voided.', 'It is kept for history and is no longer billable.']
    }[label];
    if (!say) return '';
    return `<section class="inv-view__pay inv-view__pay--${VIEW_TONE[label]}">
      <span class="inv-view__pay-icon" aria-hidden="true"></span>
      <div class="inv-view__pay-text">
        <h3 class="inv-view__title">Payment Status</h3>
        <p class="inv-view__pay-msg">${say[0]}</p>
        <p class="inv-view__pay-sub">${say[1]}</p>
      </div>
    </section>`;
  }

  const cardHead = (title, extra = '') =>
    `<div class="inv-view__card-head"><span class="inv-view__card-icon" aria-hidden="true"></span><h3 class="detail-section-title inv-view__title">${title}</h3>${extra}</div>`;
  const itemCount = lines => { const n = (lines || []).length; return `<span class="inv-view__count">${n} item${n === 1 ? '' : 's'}</span>`; };

  /** Presentation only: the scope class, a header icon, title, subtitle and the status / date / job card facts. */
  function decorateDetailModal(ov, i) {
    const modal = ov.querySelector('.modal');
    const title = modal && modal.querySelector('.modal__head h2');
    if (!title || typeof modal.setAttribute !== 'function') return;
    modal.classList.add('inv-view');
    if (i.status === 'Void') modal.classList.add('inv-view--void');
    const label = invoiceStatusLabel(i);
    // the heading still reads "Invoice INV-xxxx"; "Invoice" becomes a small kicker above the number
    title.innerHTML = `<span class="inv-view__kicker">Invoice</span> ${esc(i.id)}`;
    title.insertAdjacentHTML('beforebegin', '<span class="inv-view__icon" aria-hidden="true"></span>');
    const titles = document.createElement('div');
    titles.className = 'inv-view__titles';
    title.before(titles);
    titles.append(title);
    titles.insertAdjacentHTML('beforeend', `<p class="inv-view__sub" id="inv-view-sub">${i.jobCardId ? 'Service invoice for a completed job card' : 'Service invoice'}</p>`);
    modal.setAttribute('aria-describedby', 'inv-view-sub');
    titles.insertAdjacentHTML('afterend', `
      <div class="inv-view__facts">
        <div class="detail-item inv-view__fact inv-view__fact--status inv-view__fact--${VIEW_TONE[label] || 'neutral'}"><span>Status</span><strong>${badge(label)}</strong>${VIEW_NOTE[label] ? `<small class="inv-view__note">${VIEW_NOTE[label]}</small>` : ''}</div>
        <div class="detail-item inv-view__fact inv-view__fact--date"><span>Invoice Date</span><strong>${fmtDate(i.date)}</strong></div>
        <div class="detail-item inv-view__fact inv-view__fact--job"><span>Job Card</span><strong>${i.jobCardId ? esc(i.jobCardId) : '—'}</strong></div>
      </div>`);
    // Modal.open already focused the first footer button, scrolling to it before
    // this header grew; open the invoice at its header instead (focus is unchanged)
    modal.scrollTop = 0;
  }

  /* ---------- View Payments (Payment History / no-payments notice) ----------
     Read-only. A payment's details always open in the Payments page's own
     Payment Details modal, through its existing ?view= link. */

  /** Every payment linked to an invoice, Void included, newest first (the Payments list order). */
  function invoicePayments(invoiceId) {
    return Storage.getData('payments')
      .filter(p => p.invoiceId === invoiceId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));
  }

  const paymentDetailsHref = (p, invoiceId) =>
    `payments.html?view=${encodeURIComponent(p.id)}&invoice=${encodeURIComponent(invoiceId)}`;

  function openPaymentHistory(i, payments) {
    const anyVoid = payments.some(p => p.status === 'Void');
    const ov = Modal.open({
      title: `Payment History — ${i.id}`,
      body: `
        <p style="margin:0 0 12px">${payments.length} payments are linked to <strong>${esc(i.id)}</strong>. Select a payment to open its details.</p>
        <div class="table-wrap"><table class="table table--compact">
          <thead><tr><th scope="col">Payment</th><th scope="col" class="num">Amount</th></tr></thead>
          <tbody>${payments.map(p => `
            <tr>
              <td><a class="cell-main" href="${paymentDetailsHref(p, i.id)}">${esc(p.id)}</a>
                <span class="cell-sub">${fmtDate(p.date)} · ${esc(p.method)}</span></td>
              <td class="num"><span${p.status === 'Void' ? ' style="text-decoration:line-through"' : ''}>${money(p.amount)}</span>
                <span class="cell-sub">${badge(p.status)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        ${anyVoid ? '<p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">Voided payments are kept for history and are not counted toward the invoice balance.</p>' : ''}`,
      footer: `<button class="btn btn--ghost" data-back>Back to Invoice</button>
               <button class="btn btn--ghost" data-modal-close>Close</button>`
    });
    ov.querySelector('[data-back]').addEventListener('click', () => openDetailModal(i.id));
  }

  function openNoPayments(i) {
    const isVoid = i.status === 'Void';
    const payable = !isVoid && Number(i.due) > 0;
    // the paid figure on an invoice can come from its Job Card at creation,
    // with no payment record behind it -- say so rather than imply "unpaid"
    const why = isVoid
      ? 'When an invoice is voided, its active payments are released as advance payments, so they are no longer linked to it. They remain on the Payments page.'
      : Number(i.paid) > 0
        ? `The ${money(i.paid)} shown as paid on this invoice was carried over from its Job Card when the invoice was created, so it has no separate payment record.`
        : '';
    const ov = Modal.open({
      title: `Payments — ${i.id}`,
      body: `<p style="margin:0"><strong>No payments are recorded for this invoice.</strong></p>
             ${why ? `<p style="margin:10px 0 0;color:var(--text-2);font-size:.88rem">${why}</p>` : ''}`,
      footer: `<button class="btn btn--ghost" data-back>Back to Invoice</button>
               <button class="btn btn--ghost" data-modal-close>Close</button>
               ${isVoid ? '<a class="btn btn--ghost" href="payments.html">Go to Payments</a>' : ''}
               ${payable ? `<a class="btn btn--primary" href="payments.html?forInvoice=${encodeURIComponent(i.id)}">Record Payment</a>` : ''}`
    });
    ov.querySelector('[data-back]').addEventListener('click', () => openDetailModal(i.id));
  }

  /* ---------- write-offs (0002) ----------
     A write-off waives part of an invoice's outstanding due. It is not a
     payment: paid stays the cash received, and the invoice's written-off
     total, due and status are recomputed by the server from its payments and
     its Active write-offs. Backend only -- offline the feature is hidden, so
     there is no second, browser-side copy of the server's checks. */

  /** An invoice's write-offs, reversed ones included, newest first. */
  function invoiceAdjustments(invoiceId) {
    return Storage.getData('invoiceAdjustments')
      .filter(a => a.invoiceId === invoiceId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
  }

  function adjustmentsSection(i, list, canAdjust) {
    if (!list.length) return '';
    const anyVoid = list.some(a => a.status === 'Void');
    return `<section class="inv-view__card inv-view__card--adj">
      ${cardHead('Adjustments', `<span class="inv-view__count">${list.length} write-off${list.length === 1 ? '' : 's'}</span>`)}
      <div class="inv-view__card-body">
        <div class="table-wrap"><table class="table table--compact inv-view__adj">
          <thead><tr><th scope="col">Write-off</th><th scope="col">Reason</th><th scope="col" class="num">Amount</th>${canAdjust ? '<th scope="col" class="num">Action</th>' : ''}</tr></thead>
          <tbody>${list.map(a => `<tr${a.status === 'Void' ? ' class="inv-view__adj--void"' : ''}>
            <td class="inv-view__adj-id"><span class="cell-main">${esc(a.id)}</span><span class="cell-sub">${fmtDate(a.date)}${a.recordedBy ? ` · ${esc(a.recordedBy)}` : ''}</span></td>
            <td class="inv-view__adj-reason">${esc(a.reason)}${a.status === 'Void' ? `<span class="cell-sub">Reversed: ${esc(a.voidReason || '')}</span>` : ''}</td>
            <td class="num inv-view__adj-sum"><span class="inv-view__adj-amt">− ${money(a.amount)}</span><span class="cell-sub">${badge(a.status === 'Void' ? 'Reversed' : 'Active')}</span></td>
            ${canAdjust ? `<td class="num inv-view__adj-act">${a.status === 'Active' ? `<button class="btn btn--ghost btn--sm" data-reverse-adj="${esc(a.id)}">Reverse</button>` : ''}</td>` : ''}
          </tr>`).join('')}</tbody>
        </table></div>
        ${anyVoid ? '<p class="muted-note" style="margin:10px 0 0">Reversed write-offs are kept for history and no longer reduce the balance.</p>' : ''}
      </div>
    </section>`;
  }

  function openWriteOffModal(id) {
    const inv = Storage.getById('invoices', id);
    if (!inv || inv.status === 'Void' || !(Number(inv.due) > 0) || !Storage.isApi()) return;
    // the due the user is shown; sent as expectedDue so a balance that moved
    // in the meantime is refused by the server instead of written off blind
    let shownDue = Number(inv.due) || 0;
    const ov = Modal.open({
      title: `Write Off Balance — ${inv.id}`,
      body: `
        <p class="muted-note" style="margin:0 0 14px">A write-off waives part of the outstanding balance. It is not a payment:
          the invoice total and the amount paid stay as they are, and the write-off is kept on record with its reason.</p>
        <div class="form-grid">
          <div class="field">
            <label for="wo-amount">Amount (BDT)</label>
            <input class="input" id="wo-amount" type="number" min="0" step="any" inputmode="decimal" max="${shownDue}" value="${shownDue}">
            <div class="field__error" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="wo-date">Date</label>
            <input class="input" id="wo-date" type="date" value="${esc(Utils.todayStr())}" readonly aria-readonly="true" tabindex="-1">
            <small class="wo-hint">Recorded on today’s date.</small>
          </div>
          <div class="field span-2">
            <label for="wo-reason">Reason</label>
            <textarea class="input" id="wo-reason" rows="2" maxlength="500" placeholder="Why is this balance being written off?"></textarea>
            <div class="field__error" data-err="reason"></div>
          </div>
          <div class="field span-2">
            <label for="wo-by">Recorded by (optional)</label>
            <input class="input" id="wo-by" maxlength="100" autocomplete="name">
            <div class="field__error" data-err="recordedBy"></div>
          </div>
        </div>
        <p class="wo-summary" id="wo-summary" aria-live="polite"></p>
        <p class="field__error wo-form-err" data-err="expectedDue" role="alert"></p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Write Off</button>`
    });
    const amountEl = ov.querySelector('#wo-amount');
    const summary = () => {
      const amt = Number(amountEl.value);
      ov.querySelector('#wo-summary').textContent = amt > 0 && amt <= shownDue + 0.005
        ? `Due changes from ${money(shownDue)} to ${money(Math.max(shownDue - amt, 0))}.`
        : `Outstanding due: ${money(shownDue)}.`;
    };
    amountEl.addEventListener('input', summary);
    summary();
    const showErrors = errs => {
      ov.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
      ov.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
      Object.entries(errs).forEach(([k, msg]) => {
        const el = ov.querySelector(`[data-err="${k}"]`);
        if (!el) return;
        el.textContent = msg;
        const field = el.closest('.field');
        if (field) field.classList.add('field--error');
      });
    };
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const amount = Number(amountEl.value);
      const reason = ov.querySelector('#wo-reason').value.trim();
      const recordedBy = ov.querySelector('#wo-by').value.trim();
      const errs = {};
      if (!(amount > 0)) errs.amount = 'Enter an amount greater than 0.';
      else if (amount > shownDue + 0.005) errs.amount = `The write-off cannot exceed the outstanding due of ${money(shownDue)}.`;
      if (!reason) errs.reason = 'A reason is required.';
      showErrors(errs);
      if (Object.keys(errs).length) return;

      const res = await Storage.create('invoiceAdjustments', {
        invoiceId: id, amount, reason, expectedDue: shownDue,
        ...(recordedBy ? { recordedBy } : {})
      });
      if (!res.ok) {
        if (res.status === 409) {
          // the balance (or the invoice) changed since the dialog opened:
          // show the current figures and let the user decide again
          await Storage.refreshAll('invoices', 'invoiceAdjustments');
          const fresh = Storage.getById('invoices', id);
          if (!fresh || fresh.status === 'Void' || !(Number(fresh.due) > 0)) {
            Modal.close(); refresh();
            toast(res.message || 'This invoice changed and has nothing left to write off.', 'error');
            openDetailModal(id);
            return;
          }
          shownDue = Number(fresh.due) || 0;
          amountEl.max = String(shownDue);
          if (Number(amountEl.value) > shownDue) amountEl.value = String(shownDue);
          summary();
          showErrors({ expectedDue: `The balance changed. Outstanding due is now ${money(shownDue)}. Review the amount and try again.` });
          return;
        }
        Utils.wrote(res, ov);
        return;
      }
      const stale = await Storage.refreshAll('invoices');
      Modal.close();
      refresh();
      if (stale.length) Utils.wrote({ ok: true, stale });
      else toast(`${money(amount)} written off on ${id}.`);
      openDetailModal(id);
    }));
  }

  function openReverseModal(adjId, invoiceId) {
    const a = Storage.getById('invoiceAdjustments', adjId);
    if (!a || a.status !== 'Active' || !Storage.isApi()) return;
    const ov = Modal.open({
      title: `Reverse Write-off — ${a.id}`,
      body: `
        <p style="margin:0 0 12px">Reversing removes this ${money(a.amount)} write-off from <strong>${esc(a.invoiceId)}</strong>, so its due goes back up by that amount.
          The write-off stays on record, marked as reversed.</p>
        <div class="field">
          <label for="wo-void-reason">Reason for reversing</label>
          <textarea class="input" id="wo-void-reason" rows="2" maxlength="500"></textarea>
          <div class="field__error" data-err="voidReason"></div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Reverse Write-off</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const voidReason = ov.querySelector('#wo-void-reason').value.trim();
      const errEl = ov.querySelector('[data-err="voidReason"]');
      errEl.textContent = '';
      errEl.closest('.field').classList.remove('field--error');
      if (!voidReason) {
        errEl.textContent = 'A reason is required.';
        errEl.closest('.field').classList.add('field--error');
        return;
      }
      const res = await Storage.action('invoiceAdjustments', adjId, 'void', { voidReason }, ['invoices']);
      if (!res.ok) {
        if (res.status === 409) {
          await Storage.refreshAll('invoices', 'invoiceAdjustments');
          Modal.close(); refresh();
          toast(res.message || 'This write-off changed. Review it and try again.', 'error');
          openDetailModal(invoiceId);
          return;
        }
        Utils.wrote(res, ov);
        return;
      }
      Modal.close();
      refresh();
      if (res.stale && res.stale.length) Utils.wrote(res);
      else toast(`Write-off ${adjId} reversed.`);
      openDetailModal(invoiceId);
    }));
  }

  /* ---------- post-completion discounts & refunds (0026) ----------
     Real records: POST /api/invoice-discounts and /api/invoice-refunds, each
     reversed with POST .../:id/void. The server decides every figure (what is
     refundable, what is still discountable, a percentage's amount, who acted)
     and checks the figure the user was shown (expectedPayable /
     expectedRefundable), so a balance that moved in the meantime -- or the
     same form submitted twice -- is refused instead of applied blind.

     The accounting model, as the invoice record carries it:
       payable    total - postDiscount       what the invoice now asks for
       paid       cash received              (payments; a refund never changes it)
       refunded   cash given back            (never raises due: no new debt)
       retained   paid - refunded
       due        payable - paid - writtenOff, floored at 0
       credit     paid - refunded - payable, floored at 0
                  (a discount after payment; returned only by an explicit refund)

     Online only: offline the buttons are hidden and the offline queue has no
     path for these records. */

  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  /** An invoice's money figures, from the stored (server-computed) record. */
  function moneyFigures(i) {
    const total = Number(i.total) || 0;
    const postDiscount = Number(i.postDiscount) || 0;
    const payable = r2(total - postDiscount);
    const paid = Number(i.paid) || 0;
    const refunded = Number(i.refunded) || 0;
    const writtenOff = Number(i.writtenOff) || 0;
    return {
      total, originalDiscount: Number(i.discount) || 0, postDiscount, payable, paid, refunded, writtenOff,
      retained: r2(paid - refunded),
      refundable: Math.max(r2(paid - refunded), 0),
      discountable: Math.max(r2(payable - writtenOff), 0),
      due: Number(i.due) || 0,
      credit: Math.max(r2(paid - refunded - payable), 0),
    };
  }

  /** An invoice's refunds or discounts, reversed ones included, newest first. */
  const pcaRecords = (collection, invoiceId) => Storage.getData(collection)
    .filter(r => r.invoiceId === invoiceId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || String(b.id).localeCompare(String(a.id)));

  /** Who the server will record as having acted (display only -- the server decides). */
  function actingAs() {
    const a = Storage.account;
    return a ? (a.username || a.name || 'This account') : 'Shared workshop login';
  }

  /** Can this be used here: the backend is reachable and the role allows it. */
  const pcaCan = perm => Storage.isApi() && (typeof Storage.can !== 'function' || Storage.can(perm));

  function pcaPaymentsCard(i, payments, refunds) {
    const rows = [
      ...payments.map(p => ({ kind: 'payment', id: p.id, date: p.date, method: p.method, status: p.status, amount: p.amount, href: paymentDetailsHref(p, i.id) })),
      ...refunds.map(r => ({ kind: 'refund', id: r.id, date: r.date, method: r.method, status: r.status, amount: r.amount })),
    ].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
    return `<section class="inv-view__card inv-view__card--pca-pay">
      ${cardHead('Payments & Refunds', `<span class="inv-view__count">${payments.length} payment${payments.length === 1 ? '' : 's'}${refunds.length ? `, ${refunds.length} refund${refunds.length === 1 ? '' : 's'}` : ''}</span>`)}
      <div class="inv-view__card-body">${rows.length
        ? `<div class="table-wrap"><table class="table table--compact pca-table pca-pay">
            <thead><tr><th scope="col">Record</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead>
            <tbody>${rows.map(r => `<tr${r.status === 'Void' ? ' class="pca-row--void"' : ''}>
              <td class="pca-pay__id">${r.kind === 'payment'
                ? `<a class="cell-main" href="${r.href}">${esc(r.id)}</a>`
                : `<span class="cell-main">${esc(r.id)}</span>`}<span class="cell-sub">${r.kind === 'refund' ? 'Refund · ' : ''}${fmtDate(r.date)}</span></td>
              <td data-label="Method">${esc(r.method || '—')}</td>
              <td data-label="Status">${r.kind === 'refund' ? badge(r.status === 'Void' ? 'Reversed' : 'Refunded') : badge(r.status)}</td>
              <td class="num pca-amt" data-label="Amount">${r.kind === 'refund' ? '− ' : ''}${money(r.amount)}</td>
            </tr>`).join('')}</tbody>
          </table></div>`
        : `<p class="muted-note">${Number(i.paid) > 0 ? `No payment records. The ${money(i.paid)} paid was carried over from the Job Card.` : 'No payments are recorded for this invoice.'}</p>`}
      </div>
    </section>`;
  }

  function pcaBillSummary(i, counts) {
    const f = moneyFigures(i);
    const canDiscount = pcaCan('discounts.create') && f.discountable > 0;
    const canRefund = pcaCan('refunds.create') && f.refundable > 0;
    const offline = !Storage.isApi();
    return `<section class="inv-view__card inv-view__card--pca-bill">
      ${cardHead('Bill Summary')}
      <div class="inv-view__card-body">
        <div class="pca-bill">
          <div><span>Subtotal</span><strong>${money(i.subtotal)}</strong></div>
          <div><span>Original Discount</span><strong>− ${money(f.originalDiscount)}</strong></div>
          <div class="pca-bill__total"><span>Original Invoice Amount</span><strong>${money(f.total)}</strong></div>
          <div><span>Post-completion Discount</span><strong>− ${money(f.postDiscount)}</strong></div>
          <div class="pca-bill__total"><span>Adjusted Invoice Amount</span><strong>${money(f.payable)}</strong></div>
          <div><span>Total Payments</span><strong>${money(f.paid)}</strong></div>
          <div><span>Total Refunds</span><strong>− ${money(f.refunded)}</strong></div>
          <div class="pca-bill__net"><span>Net Amount Retained</span><strong>${money(f.retained)}</strong></div>
          ${f.writtenOff > 0 ? `<div><span>Written Off</span><strong>− ${money(f.writtenOff)}</strong></div>` : ''}
          <div><span>Outstanding Due</span><strong>${money(f.due)}</strong></div>
          ${f.credit > 0 ? `<div class="pca-bill__net"><span>Customer Credit</span><strong>${money(f.credit)}</strong></div>` : ''}
        </div>
        <div class="pca-actions">
          ${pcaCan('discounts.create') ? `<button type="button" class="btn btn--primary" data-pca-discount${canDiscount ? '' : ' disabled title="Nothing is left to discount on this invoice."'}>Add Post-Completion Discount</button>` : ''}
          ${pcaCan('refunds.create') ? `<button type="button" class="btn btn--ghost" data-pca-refund${canRefund ? '' : ' disabled title="No collected money is left to refund on this invoice."'}>Issue Refund</button>` : ''}
          <button type="button" class="btn btn--ghost" data-pca-history>Refund &amp; Discount History${counts ? ` (${counts})` : ''}</button>
        </div>
        ${f.credit > 0 ? `<p class="pca-notice" role="note">The customer has paid ${money(f.credit)} more than the adjusted amount. It is not returned automatically: issue a refund to give it back.</p>` : ''}
        ${offline ? '<p class="pca-notice" role="note">Discounts and refunds need the internet: they are recorded on the server only.</p>' : ''}
      </div>
    </section>`;
  }

  function pcaSection(i, payments) {
    const refunds = pcaRecords('invoiceRefunds', i.id);
    const discounts = pcaRecords('invoiceDiscounts', i.id);
    return `<section class="pca" aria-labelledby="pca-title">
      <div class="pca__head">
        <h3 class="pca__title" id="pca-title">Post-Completion Discount &amp; Refund</h3>
        <p class="pca__sub">A discount reduces what the invoice asks for. A refund returns money already collected. Both are kept on record and can only be reversed, never edited or deleted.</p>
      </div>
      <div class="inv-view__cols inv-view__cols--end pca__cols">
        ${pcaPaymentsCard(i, payments, refunds)}
        ${pcaBillSummary(i, refunds.length + discounts.length)}
      </div>
    </section>`;
  }

  /** Shared field-error display for the dialogs. */
  function pcaShowErrors(ov, errs) {
    ov.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    ov.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    Object.entries(errs || {}).forEach(([k, msg]) => {
      const el = ov.querySelector(`[data-err="${k}"]`);
      if (!el) return;
      el.textContent = msg;
      const field = el.closest('.field');
      if (field) field.classList.add('field--error');
    });
  }

  /** The invoice's identity lines, at the top of every dialog. */
  const pcaWho = i => `
    <div class="pca-context">
      <div><span>Invoice</span><strong>${esc(i.id)}</strong></div>
      <div><span>Customer</span><strong>${esc(custName(i.customerId))}</strong></div>
      <div><span>Vehicle</span><strong>${esc(vehText(i.vehicleId))} · ${esc(vehReg(i.vehicleId))}</strong></div>
    </div>`;

  /** After a refused write (409): re-read the figures and tell the user what changed. */
  async function pcaReloadAfterConflict(id, collection) {
    await Storage.refreshAll('invoices', collection);
    return Storage.getById('invoices', id);
  }

  function openPcaDiscountModal(id) {
    const i = Storage.getById('invoices', id);
    if (!i || i.status === 'Void' || !pcaCan('discounts.create')) return;
    let f = moneyFigures(i);
    const previous = pcaRecords('invoiceDiscounts', id).filter(d => d.status !== 'Void');
    const ov = Modal.open({
      title: `Add Post-Completion Discount — ${i.id}`,
      body: `
        ${pcaWho(i)}
        <div class="pca-context">
          <div><span>Original Invoice Amount</span><strong>${money(f.total)}</strong></div>
          <div><span>Existing (original) Discount</span><strong>${money(f.originalDiscount)}</strong></div>
          <div><span>Previous Post-completion Discounts</span><strong data-pca-prev>${money(f.postDiscount)}${previous.length ? ` (${previous.length})` : ''}</strong></div>
          <div><span>Can still be discounted</span><strong data-pca-eligible>${money(f.discountable)}</strong></div>
        </div>
        <div class="form-grid pca-pair" data-pca-mode="fixed">
          <div class="field">
            <label for="pca-amount">Discount Amount (BDT)</label>
            <input class="input" id="pca-amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0">
            <div class="field__error" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="pca-pct">Or Percentage of Original Amount (%)</label>
            <input class="input" id="pca-pct" type="number" min="0" max="100" step="0.01" inputmode="decimal" placeholder="0">
            <div class="field__error" data-err="rate"></div>
          </div>
          <div class="field">
            <label for="pca-date">Applied Date</label>
            <input class="input" id="pca-date" type="date" value="${esc(Utils.todayStr())}" max="${esc(Utils.todayStr())}" min="${esc(i.date || '')}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label>Approved By</label>
            <input class="input" value="${esc(actingAs())}" readonly aria-readonly="true" tabindex="-1">
          </div>
          <div class="field span-2">
            <label for="pca-reason">Reason</label>
            <textarea class="input" id="pca-reason" rows="2" maxlength="500" placeholder="Why is this discount being given after completion?"></textarea>
            <div class="field__error" data-err="reason"></div>
          </div>
          <div class="field span-2">
            <label for="pca-notes">Notes (optional)</label>
            <textarea class="input" id="pca-notes" rows="2" maxlength="1000"></textarea>
            <div class="field__error" data-err="notes"></div>
          </div>
        </div>
        <p class="pca-hint" id="pca-preview" aria-live="polite"></p>
        <p class="field__error" data-err="expectedPayable" role="alert"></p>`,
      footer: `<button class="btn btn--ghost" data-pca-back>Cancel</button>
               <button class="btn btn--primary" data-pca-save>Add Discount</button>`
    });
    const amountEl = ov.querySelector('#pca-amount');
    const pctEl = ov.querySelector('#pca-pct');
    const pair = ov.querySelector('.pca-pair');
    // The figure a percentage turns into, exactly as the server rounds it.
    const pctAmount = v => r2(f.total * v / 100);
    const preview = () => {
      const percent = pair.dataset.pcaMode === 'percent';
      const amt = percent ? pctAmount(Number(pctEl.value)) : Number(amountEl.value);
      const out = ov.querySelector('#pca-preview');
      if (!(amt > 0) || amt > f.discountable + 0.005) { out.textContent = ''; return; }
      const payable = r2(f.payable - amt);
      const credit = Math.max(r2(f.paid - f.refunded - payable), 0);
      out.textContent = `Adjusted invoice amount: ${money(f.payable)} → ${money(payable)}. Outstanding due becomes ${money(Math.max(r2(payable - f.paid - f.writtenOff), 0))}.`
        + (credit > 0 ? ` The customer will have a credit of ${money(credit)} (refund it separately if it should be returned).` : '');
    };
    // two-way: the box being typed in leads, the other one follows
    const sync = from => {
      pair.dataset.pcaMode = from;
      const fromAmount = from === 'fixed';
      const src = fromAmount ? amountEl : pctEl, dst = fromAmount ? pctEl : amountEl;
      const v = Number(src.value);
      dst.value = src.value === '' || !Number.isFinite(v) || f.total <= 0
        ? ''
        : String(fromAmount ? Math.min(r2(v / f.total * 100), 100) : pctAmount(v));
      src.classList.remove('is-derived');
      dst.classList.add('is-derived');
      preview();
    };
    amountEl.addEventListener('input', () => sync('fixed'));
    pctEl.addEventListener('input', () => sync('percent'));
    ov.querySelector('[data-pca-back]').addEventListener('click', () => openDetailModal(id));
    ov.querySelector('[data-pca-save]').addEventListener('click', Utils.saving(async () => {
      const percent = pair.dataset.pcaMode === 'percent';
      const amount = Number(amountEl.value), rate = Number(pctEl.value);
      const reason = ov.querySelector('#pca-reason').value.trim();
      const notes = ov.querySelector('#pca-notes').value.trim();
      const date = ov.querySelector('#pca-date').value;
      const value = percent ? pctAmount(rate) : amount;
      const errs = {};
      if (percent) {
        if (!(rate > 0 && rate <= 100)) errs.rate = 'Enter a percentage more than 0 and at most 100.';
        else if (!(value > 0)) errs.rate = 'That percentage comes to less than one paisa.';
        else if (value > f.discountable + 0.005) errs.rate = `That is ${money(value)}; the most that can be discounted is ${money(f.discountable)}.`;
      } else if (!(amount > 0)) errs.amount = 'Enter a discount greater than 0.';
      else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) errs.amount = 'Use at most 2 decimal places.';
      else if (amount > f.discountable + 0.005) errs.amount = `The discount cannot exceed ${money(f.discountable)}, what is still payable on this invoice.`;
      if (!reason) errs.reason = 'A reason is required.';
      if (!date) errs.date = 'Enter the date.';
      else if (date > Utils.todayStr()) errs.date = 'The date cannot be in the future.';
      pcaShowErrors(ov, errs);
      if (Object.keys(errs).length) return;

      const res = await Storage.create('invoiceDiscounts', {
        invoiceId: id, reason, date, expectedPayable: f.payable,
        ...(percent ? { discountType: 'percent', rate } : { discountType: 'amount', amount }),
        ...(notes ? { notes } : {}),
      });
      if (!res.ok) {
        if (res.status === 409) {
          const fresh = await pcaReloadAfterConflict(id, 'invoiceDiscounts');
          if (!fresh || fresh.status === 'Void') {
            Modal.close(); refresh();
            toast(res.message || 'This invoice changed and can no longer be discounted.', 'error');
            return;
          }
          f = moneyFigures(fresh);
          ov.querySelector('[data-pca-eligible]').textContent = money(f.discountable);
          ov.querySelector('[data-pca-prev]').textContent = money(f.postDiscount);
          preview();
          pcaShowErrors(ov, { expectedPayable: `${res.message || 'The invoice changed.'} Review the figures and try again.` });
          return;
        }
        if (res.fields) { pcaShowErrors(ov, res.fields); return; }
        Utils.wrote(res, ov);
        return;
      }
      const stale = await Storage.refreshAll('invoices');
      Modal.close();
      refresh();
      if (stale.length) Utils.wrote({ ok: true, stale });
      else toast(`${money(res.record.amount)} post-completion discount added to ${id}.`);
      openDetailModal(id);
    }));
  }

  function openPcaRefundModal(id) {
    const i = Storage.getById('invoices', id);
    if (!i || i.status === 'Void' || !pcaCan('refunds.create')) return;
    let f = moneyFigures(i);
    const methods = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];
    const ov = Modal.open({
      title: `Issue Refund — ${i.id}`,
      body: `
        ${pcaWho(i)}
        <div class="pca-context">
          <div><span>Original Invoice Amount</span><strong>${money(f.total)}</strong></div>
          <div><span>Total Payments Received</span><strong data-pca-paid>${money(f.paid)}</strong></div>
          <div><span>Previous Refunds</span><strong data-pca-refunded>${money(f.refunded)}</strong></div>
          <div><span>Remaining Refundable</span><strong data-pca-max>${money(f.refundable)}</strong></div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="pca-refund">Refund Amount (BDT)</label>
            <input class="input" id="pca-refund" type="number" min="0" step="0.01" max="${f.refundable}" inputmode="decimal" placeholder="0"${f.credit > 0 ? ` value="${f.credit}"` : ''}>
            <div class="field__error" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="pca-method">Refund Method</label>
            <select class="select" id="pca-method">${methods.map(m => `<option>${m}</option>`).join('')}</select>
            <div class="field__error" data-err="method"></div>
          </div>
          <div class="field">
            <label for="pca-refund-date">Refund Date</label>
            <input class="input" id="pca-refund-date" type="date" value="${esc(Utils.todayStr())}" max="${esc(Utils.todayStr())}" min="${esc(i.date || '')}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label>Processed By</label>
            <input class="input" value="${esc(actingAs())}" readonly aria-readonly="true" tabindex="-1">
          </div>
          <div class="field span-2">
            <label for="pca-refund-reason">Refund Reason</label>
            <textarea class="input" id="pca-refund-reason" rows="2" maxlength="500" placeholder="Why is this money being returned?"></textarea>
            <div class="field__error" data-err="reason"></div>
          </div>
          <div class="field span-2">
            <label for="pca-refund-notes">Notes (optional)</label>
            <textarea class="input" id="pca-refund-notes" rows="2" maxlength="1000" placeholder="e.g. the bKash transaction number"></textarea>
            <div class="field__error" data-err="notes"></div>
          </div>
        </div>
        <p class="pca-notice" role="note">A refund returns money already collected. It does not change the invoice amount and does not create a new amount owed.</p>
        <p class="field__error" data-err="expectedRefundable" role="alert"></p>`,
      footer: `<button class="btn btn--ghost" data-pca-back>Cancel</button>
               <button class="btn btn--primary" data-pca-save>Issue Refund</button>`
    });
    ov.querySelector('[data-pca-back]').addEventListener('click', () => openDetailModal(id));
    ov.querySelector('[data-pca-save]').addEventListener('click', Utils.saving(async () => {
      const amount = Number(ov.querySelector('#pca-refund').value);
      const method = ov.querySelector('#pca-method').value;
      const reason = ov.querySelector('#pca-refund-reason').value.trim();
      const notes = ov.querySelector('#pca-refund-notes').value.trim();
      const date = ov.querySelector('#pca-refund-date').value;
      const errs = {};
      if (!(amount > 0)) errs.amount = 'Enter a refund greater than 0.';
      else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) errs.amount = 'Use at most 2 decimal places.';
      else if (amount > f.refundable + 0.005) errs.amount = `The refund cannot exceed the ${money(f.refundable)} still refundable.`;
      if (!reason) errs.reason = 'A reason is required.';
      if (!date) errs.date = 'Enter the date.';
      else if (date > Utils.todayStr()) errs.date = 'The date cannot be in the future.';
      pcaShowErrors(ov, errs);
      if (Object.keys(errs).length) return;

      const res = await Storage.create('invoiceRefunds', {
        invoiceId: id, amount, method, reason, date, expectedRefundable: f.refundable,
        ...(notes ? { notes } : {}),
      });
      if (!res.ok) {
        if (res.status === 409) {
          const fresh = await pcaReloadAfterConflict(id, 'invoiceRefunds');
          if (!fresh || fresh.status === 'Void') {
            Modal.close(); refresh();
            toast(res.message || 'This invoice changed and can no longer be refunded.', 'error');
            return;
          }
          f = moneyFigures(fresh);
          ov.querySelector('[data-pca-paid]').textContent = money(f.paid);
          ov.querySelector('[data-pca-refunded]').textContent = money(f.refunded);
          ov.querySelector('[data-pca-max]').textContent = money(f.refundable);
          ov.querySelector('#pca-refund').max = String(f.refundable);
          pcaShowErrors(ov, { expectedRefundable: `${res.message || 'The invoice changed.'} Review the figures and try again.` });
          return;
        }
        if (res.fields) { pcaShowErrors(ov, res.fields); return; }
        Utils.wrote(res, ov);
        return;
      }
      const stale = await Storage.refreshAll('invoices');
      Modal.close();
      refresh();
      if (stale.length) Utils.wrote({ ok: true, stale });
      else toast(`${money(amount)} refunded on ${id} (${res.record.id}).`);
      openDetailModal(id);
    }));
  }

  function pcaHistoryTable(kind, list, canReverse) {
    const isRefund = kind === 'refund';
    if (!list.length) return `<p class="pca-empty"><strong>No ${isRefund ? 'refunds' : 'post-completion discounts'} recorded.</strong></p>`;
    return `<div class="table-wrap"><table class="table table--compact pca-table pca-hist">
      <thead><tr><th scope="col">${isRefund ? 'Refund' : 'Discount'}</th><th scope="col">${isRefund ? 'Method' : 'Type'}</th><th scope="col" class="num">Amount</th>
        <th scope="col">Reason</th><th scope="col">${isRefund ? 'Processed By' : 'Approved By'}</th><th scope="col">Status</th>${canReverse ? '<th scope="col" class="num">Action</th>' : ''}</tr></thead>
      <tbody>${list.map(r => `<tr${r.status === 'Void' ? ' class="pca-row--void"' : ''}>
        <td class="pca-hist__date" data-label="${isRefund ? 'Refund' : 'Discount'}"><span class="cell-main">${esc(r.id)}</span><span class="cell-sub">${fmtDate(r.date)}</span></td>
        <td data-label="${isRefund ? 'Method' : 'Type'}">${isRefund ? esc(r.method) : (r.discountType === 'percent' ? `${esc(String(r.rate))}% of the original amount` : 'Fixed amount')}</td>
        <td class="num pca-amt" data-label="Amount">− ${money(r.amount)}${isRefund ? '' : `<span class="cell-sub">${money(r.payableBefore)} → ${money(r.payableAfter)}</span>`}</td>
        <td class="pca-hist__reason" data-label="Reason">${esc(r.reason)}${r.notes ? `<span class="cell-sub">${esc(r.notes)}</span>` : ''}${r.status === 'Void' ? `<span class="cell-sub">Reversed by ${esc(r.voidedBy || '—')}: ${esc(r.voidReason || '')}</span>` : ''}</td>
        <td data-label="By">${esc(isRefund ? r.processedBy : r.approvedBy)}</td>
        <td data-label="Status">${badge(r.status === 'Void' ? 'Reversed' : 'Active')}</td>
        ${canReverse ? `<td class="num pca-hist__act" data-label="Action">${r.status === 'Active' ? `<button type="button" class="btn btn--ghost btn--sm" data-pca-reverse="${esc(r.id)}" data-pca-kind="${kind}">Reverse</button>` : ''}</td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function openPcaHistoryModal(id) {
    const i = Storage.getById('invoices', id);
    if (!i) return;
    const live = i.status !== 'Void';
    const refunds = pcaRecords('invoiceRefunds', id);
    const discounts = pcaRecords('invoiceDiscounts', id);
    const deniedNote = c => Storage.isDenied && Storage.isDenied(c)
      ? '<p class="muted-note">Your role does not include this list.</p>' : '';
    const ov = Modal.open({
      title: `Refund & Discount History — ${i.id}`, size: 'lg',
      body: `
        <h3 class="pca__title">Post-completion Discounts</h3>
        ${deniedNote('invoiceDiscounts') || pcaHistoryTable('discount', discounts, live && pcaCan('discounts.manage'))}
        <h3 class="pca__title" style="margin-top:18px">Refunds</h3>
        ${deniedNote('invoiceRefunds') || pcaHistoryTable('refund', refunds, live && pcaCan('refunds.manage'))}
        <p class="pca-notice" role="note">Records are never edited or deleted. A reversed record stays here, marked as reversed, and no longer counts.</p>`,
      footer: `<button class="btn btn--ghost" data-pca-back>Back to Invoice</button>
               <button class="btn btn--ghost" data-modal-close>Close</button>`
    });
    ov.querySelector('[data-pca-back]').addEventListener('click', () => openDetailModal(id));
    ov.querySelectorAll('[data-pca-reverse]').forEach(btn => btn.addEventListener('click', () =>
      openPcaReverseModal(btn.dataset.pcaKind, btn.dataset.pcaReverse, id)));
  }

  function openPcaReverseModal(kind, recordId, invoiceId) {
    const isRefund = kind === 'refund';
    const collection = isRefund ? 'invoiceRefunds' : 'invoiceDiscounts';
    const r = Storage.getById(collection, recordId);
    if (!r || r.status !== 'Active' || !pcaCan(isRefund ? 'refunds.manage' : 'discounts.manage')) return;
    const ov = Modal.open({
      title: `Reverse ${isRefund ? 'Refund' : 'Discount'} — ${r.id}`,
      body: `
        <p style="margin:0 0 12px">${isRefund
          ? `Reversing records that the ${money(r.amount)} refund on <strong>${esc(r.invoiceId)}</strong> did not happen (or the money came back). The invoice's refunded total goes down by that amount.`
          : `Reversing removes this ${money(r.amount)} discount from <strong>${esc(r.invoiceId)}</strong>, so the adjusted invoice amount goes back up by that amount.`}
          The record stays on file, marked as reversed, with your reason and name.</p>
        <div class="field">
          <label for="pca-void-reason">Reason for reversing</label>
          <textarea class="input" id="pca-void-reason" rows="2" maxlength="500"></textarea>
          <div class="field__error" data-err="voidReason"></div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-pca-back>Cancel</button>
               <button class="btn btn--primary" data-save>Reverse ${isRefund ? 'Refund' : 'Discount'}</button>`
    });
    ov.querySelector('[data-pca-back]').addEventListener('click', () => openPcaHistoryModal(invoiceId));
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const voidReason = ov.querySelector('#pca-void-reason').value.trim();
      if (!voidReason) { pcaShowErrors(ov, { voidReason: 'A reason is required.' }); return; }
      pcaShowErrors(ov, {});
      const res = await Storage.action(collection, recordId, 'void', { voidReason }, ['invoices']);
      if (!res.ok) {
        if (res.status === 409) {
          await Storage.refreshAll('invoices', collection);
          Modal.close(); refresh();
          toast(res.message || 'This record changed. Review it and try again.', 'error');
          openPcaHistoryModal(invoiceId);
          return;
        }
        if (res.fields) { pcaShowErrors(ov, res.fields); return; }
        Utils.wrote(res, ov);
        return;
      }
      Modal.close();
      refresh();
      if (res.stale && res.stale.length) Utils.wrote(res);
      else toast(`${isRefund ? 'Refund' : 'Discount'} ${recordId} reversed.`);
      openPcaHistoryModal(invoiceId);
    }));
  }

  function openDetailModal(id) {
    const i = Storage.getById('invoices', id);
    if (!i) return;
    const vehicle = veh(i.vehicleId);
    const payments = invoicePayments(i.id);
    const payable = i.status !== 'Void' && Number(i.due) > 0;
    // Write-offs exist only with the backend: offline the feature is hidden.
    const canAdjust = Storage.isApi() && i.status !== 'Void';
    const adjustments = invoiceAdjustments(i.id);

    const ov = Modal.open({
      title: `Invoice ${i.id}`, size: 'lg',
      body: `
        <div class="inv-view__cols">
          <section class="inv-view__card inv-view__card--customer">
            ${cardHead('Customer Information')}
            <div class="inv-view__list">
              <div class="detail-item inv-view__row"><span>Customer</span><strong>${esc(custName(i.customerId))}</strong></div>
              <div class="detail-item inv-view__row"><span>Phone</span><strong>${esc(custPhone(i.customerId))}</strong></div>
            </div>
          </section>
          <section class="inv-view__card inv-view__card--vehicle">
            ${cardHead('Vehicle Information')}
            <div class="inv-view__list inv-view__list--2">
              <div class="detail-item inv-view__row"><span>Vehicle</span><strong>${esc(vehText(i.vehicleId))}</strong></div>
              <div class="detail-item inv-view__row"><span>Registration</span><strong>${esc(vehReg(i.vehicleId))}</strong></div>
              <div class="detail-item inv-view__row"><span>Year</span><strong>${vehicle && vehicle.year ? vehicle.year : 'N/A'}</strong></div>
              <div class="detail-item inv-view__row"><span>VIN</span><strong>${vehicle && vehicle.vin ? esc(vehicle.vin) : 'N/A'}</strong></div>
            </div>
          </section>
        </div>

        <section class="inv-view__card inv-view__card--services">
          ${cardHead('Services / Work', itemCount(i.services))}
          <div class="inv-view__card-body">${lineRows(i.services, true)}</div>
        </section>

        <section class="inv-view__card inv-view__card--parts">
          ${cardHead('Parts', itemCount(i.partsUsed))}
          <div class="inv-view__card-body">${lineRows(i.partsUsed, false)}</div>
        </section>

        <div class="inv-view__cols inv-view__cols--end">
          <section class="inv-view__card inv-view__card--summary">
            ${cardHead('Financial Summary')}
            <div class="inv-view__card-body">
              <div class="totals-panel totals-panel--view">
                <div><span>Labour</span><strong>${money(i.labourCost)}</strong></div>
                <div><span>Subtotal</span><strong>${money(i.subtotal)}</strong></div>
                <div><span>Discount</span><strong>\u2212 ${money(i.discount)}</strong></div>
                <div><span>Tax (${i.taxRate || 0}%)</span><strong>+ ${money(i.tax)}</strong></div>
                <div class="totals-grand"><span>Grand Total</span><strong>${money(i.total)}</strong></div>
                ${Number(i.postDiscount) > 0 ? `<div class="inv-view__wo"><span>Post-completion discount</span><strong>\u2212 ${money(i.postDiscount)}</strong></div>
                <div><span>Adjusted Total</span><strong>${money((Number(i.total) || 0) - (Number(i.postDiscount) || 0))}</strong></div>` : ''}
                <div class="inv-view__paid"><span>Paid</span><strong>${money(i.paid)}</strong></div>
                ${Number(i.refunded) > 0 ? `<div class="inv-view__wo"><span>Refunded</span><strong>\u2212 ${money(i.refunded)}</strong></div>` : ''}
                ${Number(i.writtenOff) > 0 ? `<div class="inv-view__wo"><span>Written off</span><strong>\u2212 ${money(i.writtenOff)}</strong></div>` : ''}
                <div class="inv-view__due ${Number(i.due) > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(i.due)}</strong></div>
              </div>
            </div>
          </section>
          <div class="inv-view__stack">
            ${paymentStatusCard(i)}
            ${i.notes ? `<section class="inv-view__card inv-view__card--notes">${cardHead('Notes')}<div class="inv-view__card-body"><p class="detail-text">${esc(i.notes)}</p></div></section>` : ''}
          </div>
        </div>
        ${adjustmentsSection(i, adjustments, canAdjust)}
        ${i.status !== 'Void' ? pcaSection(i, payments) : ''}`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${i.jobCardId ? `<a class="btn btn--ghost" href="job-cards.html?view=${encodeURIComponent(i.jobCardId)}">View Job Card</a>` : ''}
        ${payable ? `<a class="btn btn--ghost" href="payments.html?forInvoice=${encodeURIComponent(i.id)}">Record Payment</a>` : ''}
        ${payable && canAdjust ? '<button class="btn btn--ghost" data-write-off>Write Off Balance</button>' : ''}
        ${!payable || payments.length
          ? `<a class="btn btn--ghost" href="${payments.length === 1 ? paymentDetailsHref(payments[0], i.id) : `payments.html?invoice=${encodeURIComponent(i.id)}`}" data-view-payments>View Payments</a>`
          : ''}
        ${i.status !== 'Void' ? '<button class="btn btn--ghost" data-edit-notes>Edit Notes</button>' : ''}
        ${i.status !== 'Void' ? '<button class="btn btn--primary" data-void>Void Invoice</button>' : ''}`
    });
    decorateDetailModal(ov, i);
    document.querySelector('[data-print-view]').addEventListener('click', () => printInvoice(id));
    const editBtn = document.querySelector('[data-edit-notes]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openNotesModal(id); });
    const voidBtn = document.querySelector('[data-void]');
    if (voidBtn) voidBtn.addEventListener('click', () => { Modal.close(); openVoidModal(id); });
    const viewPayments = document.querySelector('[data-view-payments]');
    if (viewPayments && payments.length !== 1) viewPayments.addEventListener('click', e => {
      e.preventDefault();
      if (payments.length) openPaymentHistory(i, payments); else openNoPayments(i);
    });
    const writeOffBtn = document.querySelector('[data-write-off]');
    if (writeOffBtn) writeOffBtn.addEventListener('click', () => { Modal.close(); openWriteOffModal(id); });
    document.querySelectorAll('[data-reverse-adj]').forEach(btn =>
      btn.addEventListener('click', () => { const adj = btn.dataset.reverseAdj; Modal.close(); openReverseModal(adj, id); }));
    // 0026: post-completion discount, refund and their history (each re-checked by the server)
    [['[data-pca-discount]', openPcaDiscountModal], ['[data-pca-refund]', openPcaRefundModal], ['[data-pca-history]', openPcaHistoryModal]]
      .forEach(([sel, open]) => { const btn = ov.querySelector(sel); if (btn) btn.addEventListener('click', () => open(id)); });
  }

  /* ---------- print ---------- */

  // The workshop's own number, as on the Job Card and Payment Receipt prints
  // (the Settings phone is a placeholder).
  const INVOICE_PHONE = '01854226757';

  /* Print-only glyphs (inline, so the document needs no external files). */
  const IVP_ICON = {
    pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z',
    phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
    mail: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
    web: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    car: 'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    box: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
    notes: 'M3 10h11v2H3v-2zm0-2h11V6H3v2zm0 8h7v-2H3v2zm15.01-3.13.71-.71a.996.996 0 0 1 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71-5.3 5.3V21h2.12l5.3-5.3-2.12-2.12z',
    check: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    alert: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    block: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z',
    shield: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z',
    people: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    money: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z',
    handshake: 'M12.22 19.85c-.18.18-.5.21-.71 0a.504.504 0 0 1 0-.71l3.39-3.39-1.41-1.41-3.39 3.39c-.19.2-.51.19-.71 0a.504.504 0 0 1 0-.71l3.39-3.39-1.41-1.41-3.39 3.39c-.18.18-.5.21-.71 0a.513.513 0 0 1 0-.71l3.39-3.39-1.42-1.41-3.39 3.39c-.18.18-.5.21-.71 0a.513.513 0 0 1 0-.71L9.52 8.4l1.87 1.86c.95.95 2.59.94 3.54 0 .98-.98.98-2.56 0-3.54l-1.86-1.86.28-.28c.78-.78 2.05-.78 2.83 0l4.24 4.24c.78.78.78 2.05 0 2.83l-8.2 8.2zm9.61-6.78a4.008 4.008 0 0 0 0-5.66l-4.24-4.24a4.008 4.008 0 0 0-5.66 0l-.28.28-.28-.28a4.008 4.008 0 0 0-5.66 0L2.17 6.71a3.992 3.992 0 0 0-.4 5.19l1.45-1.45a2 2 0 0 1 .37-2.33l3.54-3.54c.78-.78 2.05-.78 2.83 0l3.56 3.56c.18.18.21.5 0 .71-.21.21-.53.18-.71 0L9.52 5.57l-5.8 5.79c-.98.97-.98 2.56 0 3.54.39.39.89.63 1.42.7a2.458 2.458 0 0 0 2.12 2.12 2.458 2.458 0 0 0 2.12 2.12c.07.54.31 1.03.7 1.42.47.47 1.1.73 1.77.73.67 0 1.3-.26 1.77-.73l8.21-8.19z'
  };
  const ivpIcon = name => `<svg class="ivp-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${IVP_ICON[name]}"/></svg>`;
  /* A side-on car, drawn in line, for the header panel and the closing watermark. */
  const IVP_CAR = `<svg class="ivp-car" viewBox="0 0 240 96" aria-hidden="true" focusable="false">
      <path class="ivp-car__body" d="M12 66c0-9 7-13 19-15l40-7c13-15 32-24 61-24 27 0 45 8 61 23l25 4c11 2 14 8 14 15v6c0 3-2 4-5 4h-17a21 21 0 0 0-42 0H80a21 21 0 0 0-42 0H17c-3 0-5-2-5-4z"/>
      <path class="ivp-car__glass" d="M86 44c10-12 24-17 42-17l2 17zm52-17c18 0 32 6 44 17h-42z"/>
      <path class="ivp-car__line" d="M26 58h200"/>
      <circle class="ivp-car__tyre" cx="59" cy="72" r="16"/><circle class="ivp-car__rim" cx="59" cy="72" r="7"/>
      <circle class="ivp-car__tyre" cx="193" cy="72" r="16"/><circle class="ivp-car__rim" cx="193" cy="72" r="7"/>
    </svg>`;
  /* How each stored status reads on the printed document (the status itself is the stored one). */
  const IVP_STATUS = {
    Paid: ['paid', 'check', 'Fully Settled'],
    Partial: ['partial', 'clock', 'Payment Due'],
    Unpaid: ['unpaid', 'alert', 'Payment Required'],
    Void: ['void', 'block', 'Void Invoice']
  };
  /* A write-off that cleared the balance prints as Settled -- never as
     "Written Off" on the customer's copy, and never as plain Paid, which
     would claim the whole total was received in cash. */
  const IVP_SETTLED = ['settled', 'check', 'Balance Adjusted'];

  function printInvoice(id) {
    const i = Storage.getById('invoices', id);
    if (!i) return;
    const settings = Storage.getSettings();
    const vehicle = veh(i.vehicleId);
    const customer = Storage.getById('customers', i.customerId);
    const root = (document.body.dataset && document.body.dataset.root) || '../';
    const isVoid = i.status === 'Void';
    const writtenOff = Number(i.writtenOff) || 0;
    const settledByAdjustment = !isVoid && writtenOff > 0 && Number(i.due) < 0.005;
    const stampLabel = settledByAdjustment ? 'Settled' : i.status;
    const [statusKey, statusIcon, statusNote] = settledByAdjustment
      ? IVP_SETTLED : (IVP_STATUS[i.status] || ['void', 'block', '']);
    const row = (label, value) => `<div class="ivp-row"><dt>${label}</dt><dd>${value}</dd></div>`;
    const secHead = (icon, title) => `<h3 class="ivp-sec__title"><span class="ivp-sec__icon">${ivpIcon(icon)}</span>${title}</h3>`;

    // Thank-you, highlights and contact bar: printed on every page as a fixed
    // footer, and repeated invisibly in the frame's <tfoot> so each page keeps
    // exactly its height free of content.
    const closing = `
        <div class="ivp-thanks">
          <span class="ivp-thanks__icon">${ivpIcon('handshake')}</span>
          <p class="ivp-thanks__text">${esc(settings.invoiceFooter)}</p>
          <p class="ivp-thanks__tag"><span>Your trust keeps us moving</span></p>
        </div>
        <ul class="ivp-trust">
          <li>${ivpIcon('shield')}<span>Quality<br>Service</span></li>
          <li>${ivpIcon('people')}<span>Skilled<br>Technicians</span></li>
          <li>${ivpIcon('gear')}<span>Genuine<br>Parts</span></li>
          <li>${ivpIcon('money')}<span>Fair<br>Pricing</span></li>
          <li>${ivpIcon('car')}<span>Customer<br>Satisfaction</span></li>
        </ul>
        <footer class="ivp-foot">
          <strong>${esc(settings.businessName)}</strong>
          <span>Phone: ${INVOICE_PHONE}</span>
          ${settings.email ? `<span>${esc(settings.email)}</span>` : ''}
          ${settings.website ? `<span>${esc(settings.website)}</span>` : ''}
          ${settings.address ? `<span class="ivp-foot__addr">${esc(settings.address)}</span>` : ''}
        </footer>`;

    const area = document.getElementById('printArea');
    // The frame table's <thead> repeats the header at the top of every printed page.
    area.innerHTML = `
    <div class="ivp">
      <table class="ivp-frame">
      <thead><tr><td>
      <header class="ivp-head">
        <div class="ivp-brand">
          <img class="ivp-logo" src="${root}assets/logo/logo-dark.png" alt="Taqwa Automobile">
          <div class="ivp-org__name">${esc(settings.businessName)}</div>
          <ul class="ivp-contact">
            ${settings.address ? `<li>${ivpIcon('pin')}<span>${esc(settings.address)}</span></li>` : ''}
            <li class="ivp-contact__phone">${ivpIcon('phone')}<span>${INVOICE_PHONE}</span></li>
            ${settings.email ? `<li>${ivpIcon('mail')}<span>${esc(settings.email)}</span></li>` : ''}
            ${settings.website ? `<li>${ivpIcon('web')}<span>${esc(settings.website)}</span></li>` : ''}
            ${settings.taxId ? `<li class="ivp-contact__tax"><span>Tax/VAT: ${esc(settings.taxId)}</span></li>` : ''}
          </ul>
        </div>
        <div class="ivp-panel" aria-hidden="true">${IVP_CAR}</div>
      </header>
      </td></tr></thead>
      <tfoot aria-hidden="true"><tr><td><div class="ivp-close ivp-close--spacer">${closing}</div></td></tr></tfoot>
      <tbody><tr><td>

      <div class="ivp-titlebar">
        <div class="ivp-title">
          <h2 class="ivp-title__main">INVOICE</h2>
          <p class="ivp-title__sub">${i.jobCardId ? 'Service invoice for a completed job card' : 'Service invoice'}</p>
        </div>
        <div class="ivp-stamp ivp-stamp--${statusKey}">
          ${ivpIcon(statusIcon)}
          <div><strong>${esc(stampLabel)}</strong>${statusNote ? `<span>${statusNote}</span>` : ''}</div>
        </div>
        <dl class="ivp-meta">
          ${row('Invoice No', `<strong>${esc(i.id)}</strong>`)}
          ${row('Invoice Date', fmtDate(i.date))}
          ${row('Job Card', i.jobCardId ? esc(i.jobCardId) : '—')}
        </dl>
      </div>

      <div class="ivp-parties">
        <section class="ivp-party ivp-party--customer">
          <h3 class="ivp-party__head">${ivpIcon('person')}Customer Information</h3>
          <dl>
            ${row('Name', customer ? esc(customer.name) : 'Unknown Customer')}
            ${row('Phone', customer && customer.phone ? esc(customer.phone) : '—')}
            ${customer && customer.address ? row('Address', esc(customer.address)) : ''}
          </dl>
        </section>
        <section class="ivp-party ivp-party--vehicle">
          <h3 class="ivp-party__head">${ivpIcon('car')}Vehicle Information</h3>
          <dl>
            ${row('Vehicle', vehicle ? esc(`${vehicle.brand} ${vehicle.model}`) : 'Unknown Vehicle')}
            ${row('Registration', esc(vehReg(i.vehicleId)))}
            ${row('Year', vehicle && vehicle.year ? vehicle.year : '—')}
            ${row('VIN', vehicle && vehicle.vin ? esc(vehicle.vin) : '—')}
          </dl>
        </section>
      </div>

      ${(i.services || []).length ? `<section class="ivp-sec">
        ${secHead('gear', 'Services / Work')}
        <table class="ivp-table">
          <thead><tr><th class="ivp-no">#</th><th>Service / Work</th><th class="pr-num">Qty</th><th class="pr-num">Unit Price</th><th class="pr-num">Total</th></tr></thead>
          <tbody>${i.services.map((l, n) => `<tr>
            <td class="ivp-no">${n + 1}</td>
            <td>${esc(l.name)}</td>
            <td class="pr-num">${l.qty}</td><td class="pr-num">${money(l.unitPrice)}</td><td class="pr-num ivp-strong">${money(l.total)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </section>` : ''}

      ${(i.partsUsed || []).length ? `<section class="ivp-sec">
        ${secHead('box', 'Parts')}
        <table class="ivp-table">
          <thead><tr><th class="ivp-no">#</th><th>Part</th><th>Part No.</th><th class="pr-num">Qty</th><th class="pr-num">Unit Price</th><th class="pr-num">Total</th></tr></thead>
          <tbody>${i.partsUsed.map((l, n) => `<tr>
            <td class="ivp-no">${n + 1}</td>
            <td>${esc(l.name)}</td><td class="ivp-partno">${l.partNo ? esc(l.partNo) : '—'}</td>
            <td class="pr-num">${l.qty}</td><td class="pr-num">${money(l.unitPrice)}</td><td class="pr-num ivp-strong">${money(l.total)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </section>` : ''}

      ${Number(i.labourCost) > 0 ? `<section class="ivp-sec ivp-labour">
        ${secHead('wrench', 'Labour')}
        <div class="ivp-labour__row"><span>Labour charges</span><strong>${money(i.labourCost)}</strong></div>
      </section>` : ''}

      <div class="ivp-end">
        <div class="ivp-end__left">
          ${i.notes ? `<section class="ivp-notes">${secHead('notes', 'Notes')}<p>${esc(i.notes)}</p></section>` : ''}
        </div>
        <table class="ivp-sum${isVoid ? ' ivp-sum--void' : ''}">
          <tr><td>Subtotal</td><td class="pr-num">${money(i.subtotal)}</td></tr>
          <tr><td>Discount</td><td class="pr-num">− ${money(i.discount)}</td></tr>
          <tr><td>Tax (${i.taxRate || 0}%)</td><td class="pr-num">+ ${money(i.tax)}</td></tr>
          <tr class="ivp-sum__grand"><td>Grand Total</td><td class="pr-num">${money(i.total)}</td></tr>${Number(i.postDiscount) > 0 ? `
          <tr class="ivp-sum__adj"><td>Post-completion Discount</td><td class="pr-num">− ${money(i.postDiscount)}</td></tr>
          <tr class="ivp-sum__grand"><td>Adjusted Total</td><td class="pr-num">${money((Number(i.total) || 0) - (Number(i.postDiscount) || 0))}</td></tr>` : ''}
          <tr class="ivp-sum__paid"><td>Paid</td><td class="pr-num">${money(i.paid)}</td></tr>${Number(i.refunded) > 0 ? `
          <tr class="ivp-sum__adj"><td>Refunded</td><td class="pr-num">− ${money(i.refunded)}</td></tr>` : ''}${writtenOff > 0 ? `
          <tr class="ivp-sum__adj"><td>Adjustment</td><td class="pr-num">− ${money(writtenOff)}</td></tr>` : ''}
          <tr class="ivp-sum__due${Number(i.due) > 0 && !isVoid ? ' ivp-sum__due--open' : ''}"><td>Due</td><td class="pr-num">${money(i.due)}</td></tr>
        </table>
      </div>

      </td></tr></tbody>
      </table>
      <div class="ivp-close ivp-close--fixed">${closing}</div>
    </div>`;

    // The A4 page box, only while this invoice prints. It is an unnamed @page
    // because Chrome adds a blank last page when a table with a <tfoot> sits on
    // a named page; nothing else on this page prints, and it is removed after.
    const pageBox = document.createElement('style');
    pageBox.textContent = '@page { size: A4 portrait; margin: 8mm 10mm 11mm; '
      + '@bottom-center { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #777; } }';
    document.head.appendChild(pageBox);

    // Print once the logo has loaded, so it is on the page that gets printed.
    document.body.classList.add('printing-invoice');
    const go = () => {
      window.print();
      setTimeout(() => { document.body.classList.remove('printing-invoice'); pageBox.remove(); }, 300);
    };
    const logo = area.querySelector ? area.querySelector('.ivp-logo') : null;
    if (logo && !logo.complete) {
      logo.addEventListener('load', go, { once: true });
      logo.addEventListener('error', go, { once: true });
    } else {
      go();
    }
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

  Storage.ready(() => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const fromJobCard = params.get('fromJobCard');
    if (viewId && Storage.getById('invoices', viewId)) openDetailModal(viewId);
    else if (fromJobCard) openCreateModal(fromJobCard);
  });

})();
