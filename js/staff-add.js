/* ============================================================
   staff-add.js — Staff Management › Add Staff
   ------------------------------------------------------------
   One new employee, saved to the workshop database and nowhere else.

     - The form is enabled ONLY when Storage is in 'api' mode. With no
       backend it stays disabled and says so; signed out, the sign-in
       screen covers the page. Nothing typed here is kept in browser
       storage, and there is no pretend success.
     - Save sends POST /api/staff through Storage.create. The Worker
       re-checks every field, refuses anything that is not a staff field
       (an id, pay, ...), gives the id itself and refuses a second active
       employee with the same phone number or a reused employee code.
       The browser's checks (js/staff-form.js) only spare a round trip.
     - A mechanic is created as the Mechanics page's own record
       (MEC-0001) with its staff profile, in one write -- one record, not
       a copy. Anyone else is a staff record (STF-0001). Pay stays on the
       Mechanics page.
     - When the save fails, everything typed stays in the form and the
       reason is shown next to the field or at the top. On success the
       browser goes to the Staff List, which confirms the new record.
   ============================================================ */

const StaffAdd = (() => {

  const { esc } = Utils;
  const OTHER = '__other';
  const LIST_PAGE = 'staff-list.html';

  // Each field the Worker can name, and the control that shows its message.
  const CONTROLS = {
    name: 'saName', designation: 'saDesignation', department: 'saDepartment', joiningDate: 'saJoined',
    status: 'saStatus', employeeCode: 'saCode', specialization: 'saSpec', phone: 'saPhone', email: 'saEmail',
    address: 'saAddress', notes: 'saNotes',
  };
  const ORDER = Object.keys(CONTROLS);   // page order: the first error in it gets the focus
  const LABELS = {
    name: 'Full name', designation: 'Designation', department: 'Department', joiningDate: 'Joining date', status: 'Status',
    employeeCode: 'Employee code', specialization: 'Specialization', phone: 'Phone', email: 'Email', address: 'Address', notes: 'Notes',
  };

  // Filled in for a designation until the department is chosen by hand.
  const SUGGESTED_DEPARTMENT = {
    Mechanic: 'Workshop', 'Senior Mechanic': 'Workshop', Technician: 'Workshop', Electrician: 'Workshop', Helper: 'Workshop',
    'Service Advisor': 'Front Desk', Receptionist: 'Front Desk', Accountant: 'Accounts', Storekeeper: 'Stores',
    'Office Assistant': 'Administration', Administrator: 'Administration', 'Workshop Manager': 'Management', Manager: 'Management',
  };

  const state = { available: false, saving: false, done: false, autoDepartment: '', autoDesignation: '' };
  const $ = id => document.getElementById(id);
  const val = id => { const el = $(id); return el ? String(el.value || '').trim() : ''; };

  /* ---------- the form ---------- */

  const isMechanic = () => !!($('saTypeMechanic') && $('saTypeMechanic').checked);

  function optionsHtml(values, placeholder) {
    return `<option value="">${esc(placeholder)}</option>`
      + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      + `<option value="${OTHER}">Other (type it)</option>`;
  }

  function fillChoices() {
    const d = $('saDesignation'), p = $('saDepartment'), specs = $('saSpecs'), joined = $('saJoined');
    if (d) d.innerHTML = optionsHtml(StaffForm.DESIGNATIONS, 'Select a designation');
    if (p) p.innerHTML = optionsHtml(StaffForm.DEPARTMENTS, 'Select a department');
    if (specs) {
      const used = Storage.getData('mechanics').map(m => m && m.specialization).filter(Boolean);
      specs.innerHTML = [...new Set(used)].sort().map(v => `<option value="${esc(v)}"></option>`).join('');
    }
    if (joined && joined.setAttribute) {
      joined.setAttribute('min', StaffForm.EARLIEST_JOINING);
      joined.setAttribute('max', Utils.todayStr());
    }
  }

  /** A designation or department: the chosen option, or what was typed under "Other". */
  function choice(key) {
    const select = $(CONTROLS[key]);
    return select && select.value === OTHER ? val(`${CONTROLS[key]}Other`) : val(CONTROLS[key]);
  }

  function readValues() {
    return {
      name: val('saName').replace(/\s+/g, ' '), phone: val('saPhone'), email: val('saEmail'),
      designation: choice('designation'), department: choice('department'), joiningDate: val('saJoined'),
      status: val('saStatus') || 'Active', employeeCode: val('saCode'), specialization: val('saSpec'),
      address: val('saAddress'), notes: val('saNotes'),
    };
  }

  function setRequired(id, required) {
    const el = $(id), wrap = $(`${id}-field`);
    const mark = wrap && wrap.querySelector ? wrap.querySelector('.req') : null;
    if (mark) mark.hidden = !required;
    if (!el || !el.setAttribute) return;
    if (required) { el.setAttribute('required', ''); el.setAttribute('aria-required', 'true'); } else { el.removeAttribute('required'); el.removeAttribute('aria-required'); }
  }

  /**
   * Mechanic or not: a mechanic needs a specialization, and the Worker lets
   * a mechanic's designation and department stay blank (the designation then
   * reads "Mechanic"). Everyone else needs both.
   */
  function applyType() {
    const mech = isMechanic();
    const spec = $('saSpec-field');
    if (spec) spec.hidden = !mech;
    setRequired('saSpec', mech);
    setRequired('saDesignation', !mech);
    setRequired('saDepartment', !mech);
    const d = $('saDesignation');
    if (d) {
      if (mech && !d.value) { d.value = 'Mechanic'; state.autoDesignation = 'Mechanic'; onDesignation(); }
      else if (!mech && state.autoDesignation && d.value === state.autoDesignation) { d.value = ''; state.autoDesignation = ''; onDesignation(); }
    }
    clearError('specialization');
  }

  /** Show the "Other" box under a select only while Other is chosen. */
  function toggleOther(key, focus) {
    const select = $(CONTROLS[key]), wrap = $(`${CONTROLS[key]}Other-field`);
    if (!select || !wrap) return;
    const other = select.value === OTHER;
    wrap.hidden = !other;
    setRequired(`${CONTROLS[key]}Other`, other && !isMechanic());
    clearError(key);
    if (other && focus) { const box = $(`${CONTROLS[key]}Other`); if (box && box.focus) box.focus(); }
  }

  function onDesignation(focus = false) {
    toggleOther('designation', focus);
    const d = $('saDesignation'), p = $('saDepartment');
    if (!d || !p) return;
    if (d.value !== state.autoDesignation) state.autoDesignation = '';
    // Suggest a department until one is picked by hand.
    if (p.value === '' || p.value === state.autoDepartment) {
      const next = SUGGESTED_DEPARTMENT[d.value] || '';
      p.value = next;
      state.autoDepartment = next;
      toggleOther('department', false);
    }
  }

  /* ---------- messages ---------- */

  /** The control a field's message belongs on: its "Other" box when Other is chosen. */
  function controlFor(key) {
    const id = CONTROLS[key];
    if (!id) return null;
    if ((key === 'designation' || key === 'department') && $(id) && $(id).value === OTHER) return `${id}Other`;
    return id;
  }

  function clearError(key) {
    for (const id of [CONTROLS[key], `${CONTROLS[key]}Other`]) {
      const err = $(`${id}-err`), wrap = $(`${id}-field`), ctl = $(id);
      if (err) err.textContent = '';
      if (wrap && wrap.classList) wrap.classList.remove('field--error');
      if (ctl && ctl.removeAttribute) ctl.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() { ORDER.forEach(clearError); }

  /**
   * Put each message on its field and mark it invalid. Returns the first
   * invalid control and the messages that have no visible field (a refused
   * property, say), which go in the summary at the top instead.
   */
  function placeErrors(errors) {
    clearErrors();
    let first = null;
    const unplaced = [];
    const keys = [...ORDER.filter(k => errors[k]), ...Object.keys(errors).filter(k => !ORDER.includes(k))];
    for (const key of keys) {
      const id = controlFor(key);
      const wrap = id && $(`${id}-field`), err = id && $(`${id}-err`), ctl = id && $(id);
      if (!ctl || !err || (wrap && wrap.hidden)) { unplaced.push(`${LABELS[key] || key}: ${errors[key]}`); continue; }
      err.textContent = errors[key];
      if (wrap && wrap.classList) wrap.classList.add('field--error');
      if (ctl.setAttribute) ctl.setAttribute('aria-invalid', 'true');
      if (!first) first = ctl;
    }
    return { first, unplaced, count: keys.length };
  }

  function showAlert(title, lines = [], tone = 'bad') {
    const el = $('saAlert');
    if (!el) return;
    el.className = `sa-alert sa-alert--${tone}`;
    el.innerHTML = `<strong>${esc(title)}</strong>${lines.length ? `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`;
    el.hidden = false;
  }

  function hideAlert() { const el = $('saAlert'); if (el) { el.hidden = true; el.innerHTML = ''; } }

  function focusAlert() { const el = $('saAlert'); if (el && el.focus) el.focus(); }

  function say(text) { const el = $('saStatus'); if (el) el.textContent = text; }

  /** Field messages in place, a summary on top, focus on the first field to fix. */
  function report(errors, title) {
    const placed = placeErrors(errors);
    const n = placed.count;
    showAlert(title || (n === 1 ? 'Please correct 1 field.' : `Please correct ${n} fields.`),
      placed.unplaced.length ? placed.unplaced : ['Nothing was saved. What you typed is still here.']);
    if (placed.first && placed.first.focus) placed.first.focus(); else focusAlert();
  }

  /** Why a save did not happen, in words; the form keeps every value. */
  function failed(res) {
    const status = Number(res.status) || 0;
    say('');
    if (res.code === 'unauthorized' || status === 401) {
      showAlert('Your session has ended, so nothing was saved.', [
        'Everything you typed is still here.',
        'Sign in again in another tab, then come back and press Save Staff.',
      ]);
      focusAlert();
      return;
    }
    if (res.code === 'no_api') { showUnavailable(); return; }
    if (status === 409 || res.code === 'conflict') {
      const placed = placeErrors(res.fields || {});
      showAlert(`${res.message || 'This staff member already exists.'}${res.conflictsWith ? ` (${res.conflictsWith})` : ''}`, [
        'Nothing was saved. Look the existing record up in the Staff List, or correct the highlighted field.',
      ]);
      if (placed.first && placed.first.focus) placed.first.focus(); else focusAlert();
      return;
    }
    if (status === 422 || res.code === 'validation_failed' || res.fields) {
      report(res.fields || {}, res.message || 'Some fields are not valid.');
      return;
    }
    if (res.code === 'timeout') {
      showAlert('The server took too long to answer.', [
        'The staff member may or may not have been saved. Check the Staff List before saving again.',
        'If the first save did go through, saving again with the same phone number is refused, not duplicated.',
      ]);
      focusAlert();
      return;
    }
    if (res.code === 'network_error') {
      showAlert('Could not reach the workshop database, so nothing was saved.', [
        'What you typed is still here. Check the connection and press Save Staff again.',
      ]);
      focusAlert();
      return;
    }
    showAlert(res.message || 'The staff member could not be saved.', ['Nothing was saved. What you typed is still here. Try again in a moment.']);
    focusAlert();
  }

  /* ---------- saving ---------- */

  function setSaving(on) {
    state.saving = on;
    const save = $('saSave'), form = $('saForm');
    if (save) { save.disabled = on; save.textContent = on ? 'Saving…' : 'Save Staff'; }
    if (form && form.setAttribute) form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /** Leave for another page. One place, so the tests can watch where it goes. */
  function go(url) { location.href = url; }

  async function submit(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    // A second press while the first is in flight, or after it landed, sends nothing.
    if (!state.available || state.saving || state.done) return;
    hideAlert();
    const mech = isMechanic();
    const values = readValues();
    const errors = StaffForm.validate(values, { isMechanic: mech, mode: 'create' });
    if (Object.keys(errors).length) { report(errors); return; }
    clearErrors();
    setSaving(true);
    say('Saving…');
    let res;
    try {
      res = await Storage.create('staff', StaffForm.payload(values, { isMechanic: mech, mode: 'create' }));
    } catch (e) {
      console.error('Add Staff failed:', e);
      res = { ok: false, code: 'unexpected', message: 'Something went wrong, so the staff member was not saved.' };
    }
    if (res && res.ok && res.record && res.record.id) {
      state.done = true;
      const fields = $('saFields');
      if (fields) fields.disabled = true;
      const save = $('saSave');
      if (save) save.textContent = 'Saved';
      say(`Saved ${res.record.name} as ${res.record.id}. Opening the Staff List…`);
      go(`${LIST_PAGE}?added=${encodeURIComponent(res.record.id)}`);
      return;
    }
    setSaving(false);
    failed(res || {});
  }

  /* ---------- the page ---------- */

  function showUnavailable() {
    state.available = false;
    const fields = $('saFields'), save = $('saSave');
    if (fields) fields.disabled = true;
    if (save) save.disabled = true;
    showAlert('Add Staff needs the workshop database.', [
      'This copy of the app is not connected to the workshop database, so no one can be added here.',
      'Nothing is saved in this browser instead.',
    ]);
  }

  function bindEvents() {
    const form = $('saForm');
    if (form) form.addEventListener('submit', submit);
    for (const id of ['saTypeStaff', 'saTypeMechanic']) {
      const el = $(id);
      if (el) el.addEventListener('change', applyType);
    }
    const d = $('saDesignation'), p = $('saDepartment');
    if (d) d.addEventListener('change', () => { state.autoDesignation = ''; onDesignation(true); });
    if (p) p.addEventListener('change', () => { state.autoDepartment = ''; toggleOther('department', true); });
    // A field the user is fixing loses its message as soon as it changes.
    for (const key of ORDER) {
      for (const id of [CONTROLS[key], `${CONTROLS[key]}Other`]) {
        const el = $(id);
        if (el && id !== 'saDesignation' && id !== 'saDepartment') el.addEventListener('input', () => clearError(key));
      }
    }
    // Leaving mid-save could hide whether it landed; wait for the answer.
    const cancel = $('saCancel');
    if (cancel) cancel.addEventListener('click', e => { if (state.saving && e && e.preventDefault) e.preventDefault(); });
  }

  function start(outcome) {
    bindEvents();
    // Signed out: the sign-in screen covers the window and the app reloads
    // after signing in. The form stays disabled underneath.
    if (outcome && outcome.mode === 'locked') return;
    if (!Storage.isApi()) { showUnavailable(); return; }
    state.available = true;
    fillChoices();
    const fields = $('saFields'), save = $('saSave');
    if (fields) fields.disabled = false;
    if (save) save.disabled = false;
    applyType();
    // app.js reveals the content area in a zero timeout queued before this
    // one; a hidden input cannot take the focus, so wait for that first.
    setTimeout(() => {
      const name = $('saName');
      if (name && name.focus && !state.saving && !state.done) name.focus();
    }, 0);
  }

  Storage.ready(start);

  return { OTHER, SUGGESTED_DEPARTMENT, state, readValues, applyType, submit };
})();
