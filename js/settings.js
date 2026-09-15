/* ============================================================
   settings.js — Settings module
   Reuses the existing Storage.getSettings()/saveSettings() and
   Storage.getTheme()/saveTheme() API exactly as-is -- no new
   settings storage mechanism. Theme applies immediately (same
   live-apply UX as the topbar toggle); all other fields are saved
   together via one "Save Settings" action.

   Scope decisions (see task discussion):
   - No Invoice/Job Card ID *prefix* setting: the ID generator's
     prefixes are hard-coded in storage.js's generateId(), and a
     field that LOOKED like it controlled numbering without
     actually doing so would be misleading. Not added.
   - Workshop Defaults (appointment duration/hours/working days)
     are stored as workshop-profile reference info only. They are
     NOT read by appointments.js or job-cards.js -- those modules
     are intentionally left untouched, per the instruction not to
     modify their logic for Settings' sake. The UI says so plainly.
   - Import is intentionally NOT implemented: safely validating an
     arbitrary uploaded JSON file against 11 collections' shapes
     and cross-references before overwriting live business data
     would need a real validation layer, not a shallow check. A
     shallow check risks silently corrupting the store. Export is
     implemented (pure read, no such risk).
   - Reset to Seed Data uses the new Storage.resetToSeedData()
     (additive-only in storage.js, symmetric to the existing
     seedIfEmpty()) and requires typing RESET to confirm.

   Storage: uses Storage.getSettings/saveSettings/getTheme/saveTheme/
   resetToSeedData/getData exclusively -- no direct localStorage access.
   ============================================================ */

(() => {

  const { esc, toast, Modal } = Utils;

  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /* ---------- validation ---------- */

  function isValidEmail(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function isValidUrl(v) { return !v || /^https?:\/\/.+/i.test(v) || /^[\w.-]+\.[a-z]{2,}.*$/i.test(v); }
  function isValidTime(v) { return !v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }

  /**
   * Validates the proposed settings before saving. Returns
   * { ok: true } or { ok: false, errors: { field: message } }.
   * Never trusts raw form values.
   */
  function validateSettings(v) {
    const errors = {};
    if (!v.businessName || !v.businessName.trim()) errors.businessName = 'Business name is required.';
    if (!v.address || !v.address.trim()) errors.address = 'Address is required.';
    if (!v.phone || !v.phone.trim()) errors.phone = 'Phone is required.';
    if (!isValidEmail(v.email)) errors.email = 'Enter a valid email address, or leave it blank.';
    if (!isValidUrl(v.website)) errors.website = 'Enter a valid website (e.g. https://example.com), or leave it blank.';
    if (!v.currency || !v.currency.trim()) errors.currency = 'Currency symbol is required.';
    else if (v.currency.trim().length > 5) errors.currency = 'Currency symbol should be short (max 5 characters).';

    const taxRate = Number(v.taxRate);
    if (v.taxRate === '' || Number.isNaN(taxRate)) errors.taxRate = 'Tax rate must be a number.';
    else if (taxRate < 0 || taxRate > 100) errors.taxRate = 'Tax rate must be between 0 and 100.';

    if (v.defaultAppointmentDuration !== '') {
      const dur = Number(v.defaultAppointmentDuration);
      if (Number.isNaN(dur) || dur <= 0) errors.defaultAppointmentDuration = 'Duration must be a positive number of minutes.';
    }
    if (!isValidTime(v.openingTime)) errors.openingTime = 'Enter a valid time (HH:MM).';
    if (!isValidTime(v.closingTime)) errors.closingTime = 'Enter a valid time (HH:MM).';
    if (v.openingTime && v.closingTime && isValidTime(v.openingTime) && isValidTime(v.closingTime) && v.closingTime <= v.openingTime) {
      errors.closingTime = 'Closing time should be after opening time.';
    }

    return { ok: Object.keys(errors).length === 0, errors };
  }

  /**
   * Saves settings via the existing Storage API. Only ever writes
   * presentation/default fields -- never touches any historical
   * business record (Job Cards, Invoices, Payments, Expenses,
   * Inventory are untouched by this function; see the module-level
   * comment for why).
   */
  function saveSettingsForm(v) {
    const check = validateSettings(v);
    if (!check.ok) return check;
    Storage.saveSettings({
      businessName: v.businessName.trim(),
      address: v.address.trim(),
      phone: v.phone.trim(),
      email: (v.email || '').trim(),
      website: (v.website || '').trim(),
      taxId: (v.taxId || '').trim(),
      businessDescription: (v.businessDescription || '').trim(),
      invoiceFooter: (v.invoiceFooter || '').trim(),
      paymentTerms: (v.paymentTerms || '').trim(),
      taxRate: Number(v.taxRate),
      currency: v.currency.trim(),
      defaultAppointmentDuration: v.defaultAppointmentDuration === '' ? '' : Number(v.defaultAppointmentDuration),
      openingTime: v.openingTime || '',
      closingTime: v.closingTime || '',
      workingDays: v.workingDays || []
    });
    return { ok: true };
  }

  /* ---------- form rendering ---------- */

  function showErrors(errors) {
    document.querySelectorAll('.field__error').forEach(e => e.textContent = '');
    Object.entries(errors).forEach(([field, msg]) => {
      const el = document.querySelector(`[data-err="${field}"]`);
      if (el) el.textContent = msg;
    });
  }

  function readForm() {
    const workingDays = WEEKDAYS.filter(d => document.getElementById(`wd-${d}`).checked);
    return {
      businessName: document.getElementById('st-name').value,
      address: document.getElementById('st-address').value,
      phone: document.getElementById('st-phone').value,
      email: document.getElementById('st-email').value,
      website: document.getElementById('st-website').value,
      taxId: document.getElementById('st-taxid').value,
      businessDescription: document.getElementById('st-desc').value,
      invoiceFooter: document.getElementById('st-footer').value,
      paymentTerms: document.getElementById('st-terms').value,
      taxRate: document.getElementById('st-taxrate').value,
      currency: document.getElementById('st-currency').value,
      defaultAppointmentDuration: document.getElementById('st-duration').value,
      openingTime: document.getElementById('st-open').value,
      closingTime: document.getElementById('st-close').value,
      workingDays
    };
  }

  function populateForm(s) {
    document.getElementById('st-name').value = s.businessName || '';
    document.getElementById('st-address').value = s.address || '';
    document.getElementById('st-phone').value = s.phone || '';
    document.getElementById('st-email').value = s.email || '';
    document.getElementById('st-website').value = s.website || '';
    document.getElementById('st-taxid').value = s.taxId || '';
    document.getElementById('st-desc').value = s.businessDescription || '';
    document.getElementById('st-footer').value = s.invoiceFooter || '';
    document.getElementById('st-terms').value = s.paymentTerms || '';
    document.getElementById('st-taxrate').value = s.taxRate ?? '';
    document.getElementById('st-currency').value = s.currency || '';
    document.getElementById('st-duration').value = s.defaultAppointmentDuration ?? '';
    document.getElementById('st-open').value = s.openingTime || '';
    document.getElementById('st-close').value = s.closingTime || '';
    const workingDays = s.workingDays || [];
    WEEKDAYS.forEach(d => { document.getElementById(`wd-${d}`).checked = workingDays.includes(d); });
    showErrors({});
  }

  function loadForm() {
    populateForm(Storage.getSettings());
  }

  /* ---------- theme (applies immediately, same as the topbar toggle) ---------- */

  function syncThemeRadios() {
    const current = Storage.getTheme();
    document.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = r.value === current; });
  }

  function bindThemeEvents() {
    document.querySelectorAll('input[name="theme"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) App.applyTheme(r.value);
      });
    });
  }

  /* ---------- data management ---------- */

  function exportData() {
    const data = {};
    Storage.COLLECTIONS.forEach(c => { data[c] = Storage.getData(c); });
    data.settings = Storage.getSettings();
    data.theme = Storage.getTheme();
    data.exportedAt = new Date().toISOString();

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `taqwa-export-${Utils.todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Data exported.');
  }

  function openResetModal() {
    const ov = Modal.open({
      title: 'Reset to Seed Data',
      body: `
        <p style="margin:0 0 10px">This will <strong>permanently delete</strong> every Customer, Vehicle, Appointment,
        Job Card, Service, Mechanic, Part, Invoice, Payment, and Expense record currently in the app, and replace
        them with the original demo dataset. Your Settings (business info, tax rate, etc.) and theme are kept.</p>
        <p style="margin:0 0 10px;color:var(--bad);font-weight:600">This cannot be undone. Consider using Export Data first.</p>
        <div class="field">
          <label for="st-reset-confirm">Type RESET to confirm</label>
          <input class="input" id="st-reset-confirm" autocomplete="off">
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--danger" data-confirm-reset disabled>Reset to Seed Data</button>`
    });
    const input = ov.querySelector('#st-reset-confirm');
    const btn = ov.querySelector('[data-confirm-reset]');
    input.addEventListener('input', () => { btn.disabled = input.value.trim() !== 'RESET'; });
    btn.addEventListener('click', () => {
      if (input.value.trim() !== 'RESET') return;
      Storage.resetToSeedData();
      Modal.close();
      toast('Demo data has been reset.', 'warning');
      loadForm();
    });
  }

  /* ---------- events + init ---------- */

  function bindEvents() {
    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      const result = saveSettingsForm(readForm());
      if (!result.ok) { showErrors(result.errors); toast('Please fix the highlighted fields.', 'error'); return; }
      toast('Settings saved.');
    });
    document.getElementById('cancelSettingsBtn').addEventListener('click', () => {
      loadForm();
      toast('Changes discarded.', 'info');
    });
    document.getElementById('exportDataBtn').addEventListener('click', exportData);
    document.getElementById('resetDataBtn').addEventListener('click', openResetModal);
    bindThemeEvents();
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadForm();
    syncThemeRadios();
    bindEvents();
  });

})();
