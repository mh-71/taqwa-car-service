/* ============================================================
   expenses.js — Expense Management module
   A standalone financial ledger for workshop operating costs
   (rent, utilities, wages, tools, parts purchases, etc.) --
   separate from the Invoice/Payment revenue side, but built with
   the exact same historical-protection philosophy already proven
   there: once created, financial fields are locked; only `notes`
   stays editable; Void replaces destructive editing; delete is
   only allowed once already Void.

   Field naming intentionally matches the existing Payment module
   (`method`, not `paymentMethod`) rather than introducing a second,
   incompatible vocabulary for the same concept.

   Storage: uses Storage.getData/getById/addData/updateData/deleteData
   exclusively -- no direct localStorage access.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  // Practical category list for an automobile workshop: the suggested set
  // plus 'Parts Purchase', which the existing seed data already used.
  const CATEGORIES = [
    'Rent', 'Electricity', 'Water', 'Internet', 'Salary', 'Mechanic Wages',
    'Tools', 'Equipment', 'Equipment Maintenance', 'Vehicle Maintenance',
    'Parts Purchase', 'Office', 'Cleaning', 'Transport', 'Marketing', 'Other'
  ];
  // Same fixed list Payments already uses -- one shared vocabulary for "how money moved".
  const METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];

  let searchTerm = '';
  let fStatus = 'all', fCategory = 'all', fMethod = 'all', fDate = '';
  let sortBy = 'date-desc';

  /* ---------- validation ---------- */

  /**
   * Validates a proposed expense before it's written. Returns
   * { ok: true } or { ok: false, errors: { field: message } }.
   * Never trusts raw form values -- every field is re-checked here
   * regardless of what the form's own inline validation already showed.
   */
  function validateExpense({ date, category, description, amount, method }) {
    const errors = {};
    if (!date) errors.date = 'Date is required.';
    if (!category) errors.category = 'Category is required.';
    if (!description || !description.trim()) errors.description = 'Description is required.';

    const amt = Number(amount);
    if (amount === '' || amount === null || amount === undefined || Number.isNaN(amt)) {
      errors.amount = 'Amount must be a valid number.';
    } else if (amt <= 0) {
      errors.amount = 'Amount must be greater than 0.';
    }

    if (!method) errors.method = 'Payment method is required.';

    return { ok: Object.keys(errors).length === 0, errors };
  }

  /* ---------- create / edit ---------- */

  /** Records a new expense. Validates fully before writing anything. */
  async function createExpense({ date, category, description, amount, method, payee, reference, notes }) {
    const check = validateExpense({ date, category, description, amount, method });
    if (!check.ok) return check;

    const res = await Storage.create('expenses', {
      date,
      category,
      description: description.trim(),
      amount: Number(amount),
      method,
      payee: (payee || '').trim(),
      reference: (reference || '').trim(),
      notes: (notes || '').trim(),
      status: 'Active'
    });
    if (!res.ok) return res;
    return { ok: true, expense: res.record };
  }

  /** Void an expense (soft-cancel). Financial totals exclude it from this point on; the record itself is preserved. */
  async function voidExpense(id) {
    const expense = Storage.getById('expenses', id);
    if (!expense) return { ok: false, reason: 'Expense not found.' };
    if (expense.status === 'Void') return { ok: false, reason: 'Expense is already void.' };
    const res = await Storage.update('expenses', id, { status: 'Void' });
    if (!res.ok) return { ok: false, reason: res.message };
    return { ok: true };
  }

  /* ---------- lookups for stats/filters ---------- */

  const activeExpenses = () => Storage.getData('expenses').filter(e => e.status !== 'Void');

  function isThisMonth(dateStr) {
    if (!dateStr) return false;
    const today = new Date();
    const d = new Date(dateStr);
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const all = Storage.getData('expenses');
    const active = activeExpenses();
    const today = Utils.todayStr();

    const totalExpenses = active.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const todayTotal = active.filter(e => (e.date || '').slice(0, 10) === today).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const monthTotal = active.filter(e => isThisMonth(e.date)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const voidCount = all.filter(e => e.status === 'Void').length;

    const stats = [
      { label: 'Total Expenses', value: money(totalExpenses), tone: 'bad', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: "Today's Expenses", value: money(todayTotal), tone: 'warn', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z' },
      { label: "This Month's Expenses", value: money(monthTotal), tone: 'amber', icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z' },
      { label: 'Active Expenses', value: active.length, tone: 'info', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Void Expenses', value: voidCount, tone: 'neutral', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' }
    ];

    document.getElementById('expStats').innerHTML = stats.map(s => `
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

  function filteredExpenses() {
    const term = searchTerm.trim().toLowerCase();
    let rows = Storage.getData('expenses').filter(e => {
      if (fStatus !== 'all' && e.status !== fStatus) return false;
      if (fCategory !== 'all' && e.category !== fCategory) return false;
      if (fMethod !== 'all' && e.method !== fMethod) return false;
      if (fDate && e.date !== fDate) return false;
      if (term) {
        const hay = [e.id, e.description, e.category, e.payee, e.reference].join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      switch (sortBy) {
        case 'date-asc': return (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id);
        case 'id': return a.id.localeCompare(b.id);
        case 'amount-desc': return (Number(b.amount) || 0) - (Number(a.amount) || 0);
        case 'amount-asc': return (Number(a.amount) || 0) - (Number(b.amount) || 0);
        case 'category': return (a.category || '').localeCompare(b.category || '');
        default: return (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id); // date-desc
      }
    });
    return rows;
  }

  function populateCategoryFilter() {
    const sel = document.getElementById('expCategory');
    const current = sel.value;
    sel.innerHTML = '<option value="all">All categories</option>' +
      CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = current || 'all';
  }

  function renderList() {
    const rows = filteredExpenses();
    const total = Storage.getData('expenses').length;
    const tbody = document.getElementById('expTableBody');
    const isFiltered = searchTerm || fStatus !== 'all' || fCategory !== 'all' || fMethod !== 'all' || fDate;

    document.getElementById('expCount').textContent =
      isFiltered ? `${rows.length} of ${total} expenses` : `${total} expenses`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="9">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z"/></svg>
            <h3>${isFiltered ? 'No expenses match your search or filter.' : 'No expenses recorded yet.'}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Record your first workshop expense to see it here.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">Add Expense</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(e => `
      <tr data-id="${esc(e.id)}">
        <td class="cell-main">${esc(e.id)}</td>
        <td>${fmtDate(e.date)}</td>
        <td>${esc(e.category)}</td>
        <td class="cell-desc">${esc(e.description)}</td>
        <td>${e.payee ? esc(e.payee) : '—'}</td>
        <td>${esc(e.method)}</td>
        <td class="num">${money(e.amount)}</td>
        <td>${badge(e.status)}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View" aria-label="View ${esc(e.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="print" title="Print" aria-label="Print ${esc(e.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 8H5c-1.7 0-3 1.3-3 3v6h4v4h12v-4h4v-6c0-1.7-1.3-3-3-3zm-3 11H8v-5h8v5zm3-7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>
            ${e.status !== 'Void' ? `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="void" title="Void" aria-label="Void ${esc(e.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z"/></svg>
            </button>` : `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(e.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>`}
          </div>
        </td>
      </tr>`).join('');
  }

  /* ---------- add expense modal ---------- */

  function categoryOptions(selected) {
    return `<option value="">— Select category —</option>` +
      CATEGORIES.map(c => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
  }
  function methodOptions(selected) {
    return `<option value="">— Select method —</option>` +
      METHODS.map(m => `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(m)}</option>`).join('');
  }

  function showErrors(ov, errors) {
    ov.querySelectorAll('.field__error').forEach(e => e.textContent = '');
    Object.entries(errors).forEach(([field, msg]) => {
      const el = ov.querySelector(`[data-err="${field}"]`);
      if (el) el.textContent = msg;
    });
  }

  function openAddModal() {
    const ov = Modal.open({
      title: 'Add Expense', size: 'lg',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="ef-date">Date</label>
            <input class="input" id="ef-date" type="date" value="${esc(Utils.todayStr())}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label for="ef-category">Category</label>
            <select class="select" id="ef-category">${categoryOptions('')}</select>
            <div class="field__error" data-err="category"></div>
          </div>
          <div class="field span-2">
            <label for="ef-description">Description</label>
            <input class="input" id="ef-description" placeholder="What was this expense for?">
            <div class="field__error" data-err="description"></div>
          </div>
          <div class="field">
            <label for="ef-amount">Amount</label>
            <input class="input" id="ef-amount" type="number" min="0" step="50">
            <div class="field__error" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="ef-method">Payment Method</label>
            <select class="select" id="ef-method">${methodOptions('')}</select>
            <div class="field__error" data-err="method"></div>
          </div>
          <div class="field">
            <label for="ef-payee">Payee / Vendor (optional)</label>
            <input class="input" id="ef-payee" placeholder="e.g. Dhaka Auto Parts">
          </div>
          <div class="field">
            <label for="ef-reference">Reference (optional)</label>
            <input class="input" id="ef-reference" placeholder="Receipt / invoice no.">
          </div>
          <div class="field span-2">
            <label for="ef-notes">Notes (optional)</label>
            <textarea class="input" id="ef-notes" rows="2"></textarea>
          </div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Add Expense</button>`
    });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const values = {
        date: ov.querySelector('#ef-date').value,
        category: ov.querySelector('#ef-category').value,
        description: ov.querySelector('#ef-description').value,
        amount: ov.querySelector('#ef-amount').value,
        method: ov.querySelector('#ef-method').value,
        payee: ov.querySelector('#ef-payee').value,
        reference: ov.querySelector('#ef-reference').value,
        notes: ov.querySelector('#ef-notes').value
      };
      const result = await createExpense(values);
      if (!result.ok) {
        // Either the form's own validation (errors) or the server's refusal.
        if (result.errors) { showErrors(ov, result.errors); toast('Please fix the highlighted fields.', 'error'); }
        else Utils.wrote(result, ov);
        return;
      }
      Modal.close();
      refresh();
      toast(`Expense ${result.expense.id} recorded.`);
      openDetailModal(result.expense.id);
    }));
  }

  /* ---------- notes edit (the only editable field on an existing expense) ---------- */

  function openNotesModal(id) {
    const expense = Storage.getById('expenses', id);
    if (!expense) return;
    const ov = Modal.open({
      title: `Edit Notes — ${expense.id}`,
      body: `<div class="field"><label for="ef-notes-edit">Notes</label>
             <textarea class="input" id="ef-notes-edit" rows="3">${esc(expense.notes || '')}</textarea></div>
             <p class="muted-note" style="margin-top:8px">Only notes can be edited on a recorded expense. Use Void if the expense itself was wrong.</p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Notes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const res = await Storage.update('expenses', id, { notes: ov.querySelector('#ef-notes-edit').value });
      if (!Utils.wrote(res, ov)) return;
      Modal.close();
      refresh();
      toast(`Expense ${id} notes updated.`);
    }));
  }

  /* ---------- void / delete ---------- */

  function openVoidModal(id) {
    const expense = Storage.getById('expenses', id);
    if (!expense) return;
    Modal.confirm({
      title: 'Void expense?',
      message: `Are you sure you want to void <strong>${esc(expense.id)}</strong> (${money(expense.amount)})?
                The record is kept for history but excluded from all financial totals. This cannot be undone.`,
      confirmText: 'Void Expense',
      onConfirm: async () => {
        const res = await voidExpense(id);
        if (!res.ok) { toast(res.reason, 'error'); return; }
        refresh();
        toast(`Expense ${id} voided.`, 'warning');
      }
    });
  }

  function openDeleteModal(id) {
    const expense = Storage.getById('expenses', id);
    if (!expense) return;
    if (expense.status !== 'Void') {
      Modal.open({
        title: 'Cannot delete expense',
        body: `<p style="margin:0"><strong>${esc(expense.id)}</strong> is an active financial record. Void it first if it needs to be removed from the books.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    Modal.confirm({
      title: 'Delete expense?',
      message: `Permanently delete voided expense <strong>${esc(expense.id)}</strong>? This cannot be undone.`,
      confirmText: 'Delete Expense',
      onConfirm: async () => {
        const res = await Storage.remove('expenses', id);
        if (!Utils.wrote(res)) return;
        refresh();
        toast(`Expense ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- detail view ---------- */

  function openDetailModal(id) {
    const e = Storage.getById('expenses', id);
    if (!e) return;
    const ov = Modal.open({
      title: `Expense ${e.id}`,
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Status</span><strong>${badge(e.status)}</strong></div>
          <div class="detail-item"><span>Date</span><strong>${fmtDate(e.date)}</strong></div>
          <div class="detail-item"><span>Category</span><strong>${esc(e.category)}</strong></div>
        </div>

        <h3 class="detail-section-title">Details</h3>
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Description</span><strong>${esc(e.description)}</strong></div>
          <div class="detail-item"><span>Payee / Vendor</span><strong>${e.payee ? esc(e.payee) : '—'}</strong></div>
          <div class="detail-item"><span>Reference</span><strong>${e.reference ? esc(e.reference) : '—'}</strong></div>
          <div class="detail-item"><span>Payment Method</span><strong>${esc(e.method)}</strong></div>
          <div class="detail-item"><span>Created</span><strong>${e.createdAt ? fmtDate(e.createdAt) : 'N/A'}</strong></div>
          <div class="detail-item"><span>Last Updated</span><strong>${e.updatedAt ? fmtDate(e.updatedAt) : '—'}</strong></div>
        </div>

        <h3 class="detail-section-title">Amount</h3>
        <div class="totals-panel totals-panel--view">
          <div class="totals-grand"><span>Amount</span><strong>${money(e.amount)}</strong></div>
        </div>

        ${e.notes ? `<h3 class="detail-section-title">Notes</h3><p class="detail-text">${esc(e.notes)}</p>` : ''}`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${e.status !== 'Void' ? '<button class="btn btn--ghost" data-edit-notes>Edit Notes</button>' : ''}
        ${e.status !== 'Void' ? '<button class="btn btn--primary" data-void>Void Expense</button>' : ''}`
    });
    document.querySelector('[data-print-view]').addEventListener('click', () => printExpense(id));
    const editBtn = document.querySelector('[data-edit-notes]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openNotesModal(id); });
    const voidBtn = document.querySelector('[data-void]');
    if (voidBtn) voidBtn.addEventListener('click', () => { Modal.close(); openVoidModal(id); });
  }

  /* ---------- print ---------- */

  function printExpense(id) {
    const e = Storage.getById('expenses', id);
    if (!e) return;
    const settings = Storage.getSettings();

    document.getElementById('printArea').innerHTML = `
      <div class="pr-head">
        <div>
          <h1>${esc(settings.businessName)}</h1>
          <p>${esc(settings.address)} \u00b7 ${esc(settings.phone)}</p>
          ${(settings.email || settings.website) ? `<p>${[settings.email, settings.website].filter(Boolean).map(x => esc(x)).join(' \u00b7 ')}</p>` : ''}
          ${settings.taxId ? `<p>Tax/VAT: ${esc(settings.taxId)}</p>` : ''}
        </div>
        <div class="pr-meta">
          <h2>EXPENSE RECORD</h2>
          <p><strong>${esc(e.id)}</strong></p>
          <p>${fmtDate(e.date)}</p>
        </div>
      </div>

      <div class="pr-cols">
        <div>
          <h3>Category</h3>
          <p>${esc(e.category)}</p>
        </div>
        <div>
          <h3>Payee / Vendor</h3>
          <p>${e.payee ? esc(e.payee) : '—'}</p>
        </div>
      </div>

      <table class="pr-totals">
        <tr><td>Description</td><td class="pr-num">${esc(e.description)}</td></tr>
        <tr><td>Payment Method</td><td class="pr-num">${esc(e.method)}</td></tr>
        ${e.reference ? `<tr><td>Reference</td><td class="pr-num">${esc(e.reference)}</td></tr>` : ''}
        <tr class="pr-grand"><td>Amount</td><td class="pr-num">${money(e.amount)}</td></tr>
      </table>

      ${e.notes ? `<h3>Notes</h3><p>${esc(e.notes)}</p>` : ''}
      ${e.status === 'Void' ? `<p style="font-weight:700;letter-spacing:2px;margin-top:16px">VOID</p>` : ''}

      <p class="pr-foot">${esc(settings.invoiceFooter)}</p>`;

    document.body.classList.add('printing-expense');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-expense'), 300);
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateCategoryFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addExpenseBtn').addEventListener('click', openAddModal);
    document.getElementById('expSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('expStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('expCategory').addEventListener('change', e => { fCategory = e.target.value; renderList(); });
    document.getElementById('expMethod').addEventListener('change', e => { fMethod = e.target.value; renderList(); });
    document.getElementById('expDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('expSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('expTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'print') printExpense(id);
      if (action === 'void') openVoidModal(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    if (viewId && Storage.getById('expenses', viewId)) openDetailModal(viewId);
  });

})();
