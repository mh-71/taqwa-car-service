/* ============================================================
   services.js — Service Catalog module
   Job cards snapshot serviceId + name + unitPrice at creation
   time, so catalog price changes never rewrite history. Usage
   stats here are derived from those snapshots.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  // Fixed category list (dropdown-only) prevents spelling variants
  // like Brake/brake/BRAKE. Includes categories used by seed data.
  const CATEGORIES = [
    'Engine', 'Brakes', 'Climate', 'Electrical', 'Suspension',
    'Transmission', 'Wheels', 'Battery', 'Inspection', 'General', 'Other'
  ];

  let searchTerm = '';
  let fCategory = 'all', fStatus = 'all';
  let sortBy = 'name-asc';

  /* ---------- time formatting (stored as minutes, displayed as text) ---------- */

  /**
   * A stored minutes figure -> { hours, minutes }, the exact inverse of the
   * form's (hours * 60) + minutes. 90 -> 1h30, 60 -> 1h0, 25 -> 0h25.
   *
   * The stored value never changes meaning: `estTime` is minutes here, in
   * localStorage, on the wire and in the est_time column. Hours are a way of
   * typing and reading that number, nothing more.
   */
  function splitDuration(totalMinutes) {
    const total = Math.max(0, Math.round(Number(totalMinutes) || 0));
    return { hours: Math.floor(total / 60), minutes: total % 60 };
  }

  /**
   * What a duration display should work from: either the hours/minutes to
   * render, or a ready-made string for the values that are not a duration at
   * all. Both formatters go through here, so a missing or legacy value reads
   * the same wherever it appears.
   */
  function durationParts(estTime) {
    if (estTime === '' || estTime == null) return { text: '—' };
    if (typeof estTime === 'string' && isNaN(Number(estTime))) return { text: estTime }; // legacy string values
    const mins = Number(estTime);
    // A negative estimate is not a length of time, so it reads as no estimate
    // rather than as "-1 hours -30 minutes". The column's CHECK is "> 0", so
    // only a hand-edited local record could get here.
    if (!mins || mins < 0) return { text: '—' };
    return splitDuration(mins);
  }

  /** The long form: the detail modal, where there is room to spell it out. */
  function fmtDuration(estTime) {
    const d = durationParts(estTime);
    if (d.text) return d.text;
    const parts = [];
    if (d.hours) parts.push(`${d.hours} ${d.hours === 1 ? 'hour' : 'hours'}`);
    if (d.minutes) parts.push(`${d.minutes} ${d.minutes === 1 ? 'minute' : 'minutes'}`);
    return parts.join(' ') || '—';
  }

  /**
   * The compact form, used ONLY in the catalog table. That column is narrow
   * -- 95px below a 1280px viewport -- and "1 hour 30 minutes" wraps onto
   * two or three lines there.
   *
   * Whole hours already read short, so they keep their words; it is the
   * two-part value and the minutes-only value that are shortened:
   *
   *    25 -> "25 min"      60 -> "1 hour"
   *    90 -> "1h 30m"     120 -> "2 hours"
   *
   * Nothing else uses this. The stored value, the form and the detail modal
   * are untouched by it -- it is a column width problem, not a data one.
   */
  function fmtDurationCompact(estTime) {
    const d = durationParts(estTime);
    if (d.text) return d.text;
    if (d.hours && d.minutes) return `${d.hours}h ${d.minutes}m`;
    if (d.hours) return `${d.hours} ${d.hours === 1 ? 'hour' : 'hours'}`;
    return d.minutes ? `${d.minutes} min` : '—';
  }

  function estTimeMinutes(estTime) {
    if (typeof estTime === 'number') return estTime;
    const n = Number(estTime);
    return isNaN(n) ? 0 : n;
  }

  /* ---------- usage stats from real job cards only ---------- */

  function serviceUsage(serviceId) {
    const jobs = Storage.getData('jobCards');
    let count = 0, revenue = 0, lastUsed = null;
    jobs.forEach(j => {
      (j.services || []).forEach(item => {
        if (item.serviceId === serviceId) {
          count += Number(item.qty) || 1;
          revenue += Number(item.total) || 0;
          if (!lastUsed || (j.date || '') > lastUsed) lastUsed = j.date;
        }
      });
    });
    return { count, revenue, lastUsed };
  }

  function isReferenced(serviceId) {
    return Storage.getData('jobCards').some(j =>
      (j.services || []).some(item => item.serviceId === serviceId)) ||
      Storage.getData('appointments').some(a => a.serviceId === serviceId);
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const services = Storage.getData('services');
    const active = services.filter(s => (s.status || 'Active') === 'Active').length;
    const avg = services.length
      ? Math.round(services.reduce((sum, s) => sum + (Number(s.price) || 0), 0) / services.length)
      : 0;

    const stats = [
      { label: 'Total Services',   value: services.length,       tone: 'info',  icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z' },
      { label: 'Active Services',  value: active,                tone: 'good',  icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Inactive Services',value: services.length - active, tone: 'warn', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' },
      { label: 'Average Price',    value: money(avg),            tone: 'amber', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' }
    ];

    document.getElementById('svcStats').innerHTML = stats.map(s => `
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

  function filteredServices() {
    const term = searchTerm.trim().toLowerCase();
    let list = Storage.getData('services').filter(s => {
      if (term) {
        const hay = `${s.id} ${s.name} ${s.category} ${s.description || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fCategory !== 'all' && s.category !== fCategory) return false;
      if (fStatus !== 'all' && (s.status || 'Active') !== fStatus) return false;
      return true;
    });

    const cmp = {
      'name-asc':     (a, b) => a.name.localeCompare(b.name),
      'name-desc':    (a, b) => b.name.localeCompare(a.name),
      'category-asc': (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      'price-asc':    (a, b) => (Number(a.price) || 0) - (Number(b.price) || 0),
      'price-desc':   (a, b) => (Number(b.price) || 0) - (Number(a.price) || 0),
      'time-asc':     (a, b) => estTimeMinutes(a.estTime) - estTimeMinutes(b.estTime),
      'time-desc':    (a, b) => estTimeMinutes(b.estTime) - estTimeMinutes(a.estTime),
      'added-desc':   (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
      'added-asc':    (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')
    }[sortBy];
    return list.sort(cmp);
  }

  function populateCategoryFilter() {
    // Union of the fixed list and any categories already in data
    const used = Storage.getData('services').map(s => s.category).filter(Boolean);
    const cats = [...new Set([...CATEGORIES, ...used])].sort();
    const sel = document.getElementById('svcCategory');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All categories</option>` +
      cats.map(c => `<option${c === current ? ' selected' : ''}>${esc(c)}</option>`).join('');
  }

  function renderList() {
    const rows = filteredServices();
    const total = Storage.getData('services').length;
    const tbody = document.getElementById('svcTableBody');
    const isFiltered = searchTerm || fCategory !== 'all' || fStatus !== 'all';

    document.getElementById('svcCount').textContent =
      isFiltered ? `${rows.length} of ${total} services` : `${total} services`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="9">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z"/></svg>
            <h3>${isFiltered ? 'No services match your search or filter.' : 'No services found'}</h3>
            <p>${isFiltered ? 'Try different keywords or reset the filters.' : 'Add your first service to build the catalog.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">+ Add Service</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(s => {
      const status = s.status || 'Active';
      const isActive = status === 'Active';
      return `
      <tr data-id="${esc(s.id)}">
        <td class="cell-main">${esc(s.id)}</td>
        <td class="cell-main">${esc(s.name)}</td>
        <td><span class="badge badge--neutral">${esc(s.category)}</span></td>
        <td class="cell-desc">${s.description ? esc(s.description) : '<span class="muted">—</span>'}</td>
        <td class="num">${fmtDurationCompact(s.estTime)}</td>
        <td class="num">${money(s.price)}</td>
        <td>${badge(status)}</td>
        <td>${s.createdAt ? fmtDate(s.createdAt) : '—'}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(s.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(s.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="toggle" title="${isActive ? 'Deactivate' : 'Activate'}" aria-label="${isActive ? 'Deactivate' : 'Activate'} ${esc(s.name)}">
              ${isActive
                ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.9L16.9 18.3C15.5 19.4 13.8 20 12 20zm6.3-3.1L7.1 5.7C8.5 4.6 10.2 4 12 4c4.4 0 8 3.6 8 8 0 1.8-.6 3.5-1.7 4.9z"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>'}
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(s.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------- add / edit ---------- */

  function formHtml(s = {}) {
    const catOpts = CATEGORIES.map(c =>
      `<option${c === s.category ? ' selected' : ''}>${esc(c)}</option>`).join('');
    // Editing shows the stored minutes back as hours + minutes. Anything that
    // is not a positive number -- absent, null, '', or a legacy string like
    // "1 hr" -- leaves both boxes empty, which is still "no estimate".
    const est = Number(s.estTime) > 0
      ? splitDuration(s.estTime)
      : { hours: '', minutes: '' };
    return `
      <form id="svcForm" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            <label for="sf-name">Service Name <span class="req">*</span></label>
            <input class="input" id="sf-name" name="name" value="${esc(s.name || '')}" placeholder="Engine Oil Change" autocomplete="off">
            <div class="field__error" data-err="name"></div>
          </div>
          <div class="field">
            <label for="sf-category">Category <span class="req">*</span></label>
            <select class="select" id="sf-category" name="category">
              <option value="">— Select category —</option>${catOpts}
            </select>
            <div class="field__error" data-err="category"></div>
          </div>
          <div class="field">
            <label for="sf-status">Status</label>
            <select class="select" id="sf-status" name="status">
              <option${(s.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${s.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field">
            <label for="sf-hours">Estimated Time (hours &amp; minutes)</label>
            <div class="field__pair">
              <input class="input" id="sf-hours" name="estHours" type="number" min="0" step="1"
                     value="${esc(est.hours)}" placeholder="Hours" aria-label="Estimated hours">
              <input class="input" id="sf-minutes" name="estMinutes" type="number" min="0" max="59" step="1"
                     value="${esc(est.minutes)}" placeholder="Minutes" aria-label="Estimated minutes">
            </div>
            <!-- One error slot for the pair, still keyed estTime: that is the
                 name the API answers with, so Utils.wrote() lands a server 422
                 on the same field the browser's own check would have. -->
            <div class="field__error" data-err="estTime"></div>
          </div>
          <div class="field">
            <label for="sf-price">Price (BDT) <span class="req">*</span></label>
            <input class="input" id="sf-price" name="price" type="number" min="0" step="50"
                   value="${esc(s.price ?? '')}" placeholder="2500">
            <div class="field__error" data-err="price"></div>
          </div>
          <div class="field span-2">
            <label for="sf-desc">Description</label>
            <textarea class="textarea" id="sf-desc" name="description" rows="2">${esc(s.description || '')}</textarea>
          </div>
        </div>`;
  }

  /**
   * The two boxes -> the one minutes figure everything downstream stores.
   *
   * `estHours` and `estMinutes` exist only inside this form: the payload
   * readForm() builds carries `estTime` and nothing else, exactly as before,
   * so the API contract, the local records, the job card and appointment
   * pickers and the invoice snapshots all see an unchanged shape.
   *
   * Both boxes empty is still "no estimate": '' is what an empty box has
   * always sent, and src/lib/write.js:166 turns it into a null est_time.
   */
  function readDuration(form) {
    const rawHours = String(form.estHours.value ?? '').trim();
    const rawMinutes = String(form.estMinutes.value ?? '').trim();
    if (rawHours === '' && rawMinutes === '') return { estTime: '', error: null };

    // One box filled means the other is zero, so "30 minutes" and "2 hours"
    // are both typed the way a person would say them.
    const hours = rawHours === '' ? 0 : Number(rawHours);
    const minutes = rawMinutes === '' ? 0 : Number(rawMinutes);

    if (!Number.isInteger(hours) || hours < 0) {
      return { estTime: '', error: 'Hours must be a whole number, 0 or more.' };
    }
    if (!Number.isInteger(minutes) || minutes < 0) {
      return { estTime: '', error: 'Minutes must be a whole number, 0 or more.' };
    }
    // 90 in the minutes box is an hour and a half typed in the wrong place --
    // silently carrying it into the hours would save a figure nobody entered.
    if (minutes > 59) {
      return { estTime: '', error: 'Minutes must be between 0 and 59. Use the hours box for an hour or more.' };
    }

    return { estTime: (hours * 60) + minutes, error: null };
  }

  function readForm(form, duration = readDuration(form)) {
    return {
      name: form.name.value.trim().replace(/\s+/g, ' '),
      category: form.category.value,
      description: form.description.value.trim(),
      estTime: duration.estTime,
      price: form.price.value === '' ? '' : Number(form.price.value),
      status: form.status.value
    };
  }

  function validate(values, editingId = null, duration = null) {
    const errors = {};
    if (!values.name) errors.name = 'Service name is required.';
    if (!values.category) errors.category = 'Select a category.';
    if (values.price === '' || isNaN(values.price)) {
      errors.price = 'Price is required.';
    } else if (values.price < 0) {
      errors.price = 'Price cannot be negative.';
    }
    // A malformed hours/minutes pair is reported as typed; a well-formed one
    // that still adds up to nothing falls through to the rule that was always
    // here, and that the API states as readNumber(estTime, { min: 1 }).
    if (duration && duration.error) errors.estTime = duration.error;
    else if (values.estTime !== '' && values.estTime <= 0)
      errors.estTime = 'Estimated time must be greater than 0.';

    if (values.name && values.category) {
      const dup = Storage.getData('services').find(s =>
        s.id !== editingId &&
        s.category === values.category &&
        s.name.trim().toLowerCase() === values.name.toLowerCase());
      if (dup) errors.name = 'This service already exists in this category.';
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
      title: 'Add Service',
      body: formHtml(),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Service</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#svcForm');
      const duration = readDuration(form);
      const values = readForm(form, duration);
      const { valid, errors } = validate(values, null, duration);
      if (!valid) {
        showErrors(form, errors);
        toast(errors.name === 'This service already exists in this category.'
          ? errors.name : 'Please fix the highlighted fields.', 'error');
        return;
      }
      const res = await Storage.create('services', values);
      if (!Utils.wrote(res, form)) return;
      const rec = res.record;
      Modal.close();
      refresh();
      toast(`Service "${rec.name}" added (${rec.id}).`);
    }));
  }

  function openEditModal(id) {
    const s = Storage.getById('services', id);
    if (!s) return;
    const ov = Modal.open({
      title: `Edit Service — ${s.id}`,
      body: formHtml(s),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#svcForm');
      const duration = readDuration(form);
      const values = readForm(form, duration);
      const { valid, errors } = validate(values, id, duration);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      const res = await Storage.update('services', id, values);
      if (!Utils.wrote(res, form)) return;
      Modal.close();
      refresh();
      toast(`Service "${values.name}" updated.`);
    }));
  }

  /* ---------- activate / deactivate ---------- */

  async function toggleStatus(id) {
    const s = Storage.getById('services', id);
    if (!s) return;
    const next = (s.status || 'Active') === 'Active' ? 'Inactive' : 'Active';
    const res = await Storage.update('services', id, { status: next });
    if (!Utils.wrote(res)) return;
    refresh();
    toast(`Service "${s.name}" ${next === 'Active' ? 'activated' : 'deactivated'}.`,
      next === 'Active' ? 'success' : 'info');
  }

  /* ---------- delete (protect historical references) ---------- */

  function openDeleteModal(id) {
    const s = Storage.getById('services', id);
    if (!s) return;

    if (isReferenced(id)) {
      Modal.open({
        title: 'Cannot delete service',
        body: `<p style="margin:0"><strong>${esc(s.name)}</strong> is already used in historical records
               (job cards or appointments). Deleting it would corrupt that history.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Deactivate it instead — it will stay in past records but won't be offered on new job cards.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 ${(s.status || 'Active') === 'Active'
                   ? '<button class="btn btn--primary" data-deactivate>Deactivate Service</button>' : ''}`
      });
      const btn = document.querySelector('[data-deactivate]');
      // toggleStatus writes, so the click waits for it: closing first would
      // take the dialog away before anyone knew whether it worked, and leave a
      // second click free to send the request twice.
      if (btn) btn.addEventListener('click', Utils.saving(async () => {
        await toggleStatus(id);
        Modal.close();
      }));
      return;
    }

    Modal.confirm({
      title: 'Delete service?',
      message: `Are you sure you want to delete <strong>${esc(s.name)}</strong> (${esc(s.id)})? This cannot be undone.`,
      confirmText: 'Delete Service',
      onConfirm: async () => {
        // The historical-reference guard above is the UI's; the schema's
        // foreign keys are what actually stop it, and they get the last word.
        const res = await Storage.remove('services', id);
        if (!Utils.wrote(res)) return;
        refresh();
        toast(`Service "${s.name}" deleted.`, 'warning');
      }
    });
  }

  /* ---------- details ---------- */

  function openDetailModal(id) {
    const s = Storage.getById('services', id);
    if (!s) return;
    const usage = serviceUsage(id);

    const usageHtml = usage.count > 0
      ? `<div class="summary-row summary-row--3">
           <div class="summary-tile"><strong>${usage.count}</strong><span>Times Used</span></div>
           <div class="summary-tile summary-tile--good"><strong>${money(usage.revenue)}</strong><span>Revenue Generated</span></div>
           <div class="summary-tile"><strong>${fmtDate(usage.lastUsed)}</strong><span>Last Used</span></div>
         </div>`
      : `<p class="muted-note">No usage history yet.</p>`;

    Modal.open({
      title: `${s.name} — ${s.id}`,
      body: `
        <div class="detail-grid">
          <div class="detail-item"><span>Service ID</span><strong>${esc(s.id)}</strong></div>
          <div class="detail-item"><span>Category</span><strong>${esc(s.category)}</strong></div>
          <div class="detail-item"><span>Estimated Time</span><strong>${fmtDuration(s.estTime)}</strong></div>
          <div class="detail-item"><span>Price</span><strong>${money(s.price)}</strong></div>
          <div class="detail-item"><span>Status</span><strong>${badge(s.status || 'Active')}</strong></div>
          <div class="detail-item"><span>Date Added</span><strong>${s.createdAt ? fmtDate(s.createdAt) : '—'}</strong></div>
          <div class="detail-item span-2"><span>Description</span><strong>${s.description ? esc(s.description) : '—'}</strong></div>
        </div>
        <h3 class="detail-section-title">Usage Summary</h3>
        ${usageHtml}`,
      footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
               <button class="btn btn--primary" data-edit-from-view>Edit Service</button>`
    }).querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateCategoryFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addServiceBtn').addEventListener('click', openAddModal);
    document.getElementById('svcSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('svcCategory').addEventListener('change', e => { fCategory = e.target.value; renderList(); });
    document.getElementById('svcStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('svcSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('svcTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      // Delegated: the listener is on the table body, so the button being
      // held is the one in this row, not the one the listener sits on.
      if (action === 'toggle') { Utils.guard(btn, () => toggleStatus(id)); return; }
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('services', viewId)) openDetailModal(viewId);
  });

})();
