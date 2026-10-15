/* ============================================================
   crm-history.js — Customer CRM › Service History
   ------------------------------------------------------------
   Every service visit (one job card each), with the customer and
   vehicle it was for, the work done, the mileage, what it cost and
   what is still owed -- plus a per-vehicle timeline.

   Source of truth: the workshop database, and nothing else.
     - Rows come from the job cards, customers, vehicles, invoices and
       payments the app already loaded through Storage (GET
       /api/job-cards, /customers, /vehicles, /invoices, /payments). No
       endpoint, column or record is added here.
     - Records are shown ONLY when Storage is in 'api' mode. In every
       other mode -- a backend that failed, no backend at all, or a
       signed-out browser -- this page reads nothing and says so, so demo
       data in this browser is never shown as the workshop's history.
     - Nothing is written. Every action is a link to an existing view.

   Rules (also asserted in tests/unit/crm-history.test.cjs):
     - One job card is one service visit. Service lines, payments and
       invoices are never counted as visits, so a voided invoice and its
       replacement, or a card with five service lines, is still one.
     - Groups: Completed = Completed + Delivered; Pending = the five
       statuses where work is still open; Cancelled on its own. Total
       Service Visits = Completed + Pending; Cancelled is never counted.
     - Service date = the job card's own `date` (the day the vehicle came
       in, a workshop calendar day). The completion date is shown apart
       from it: completedAt in Asia/Dhaka time, else actualDelivery.
     - Total Service Cost = the job card totals of the Completed group
       only. Pending estimates and Cancelled cards are never added in.
     - Paid / Due come from Utils.liveJobBalance(), the app's one rule
       for a job's live balance (invoice, then advances, then the card's
       own snapshot; Cancelled owes nothing). Waived is the live
       invoice's writtenOff; a Void invoice is never the live one.
     - Services are the job card's own line snapshots; invoice lines,
       which are copies of them, are never read.
     - A visit keeps the customer it was recorded for (the job card's
       customerId), even if the vehicle has since changed owner. The
       timeline is built from the job cards' vehicleId.
   ============================================================ */

const CrmHistory = (() => {

  const { esc } = Utils;

  const COMPLETED = Utils.DONE_JOB_STATUSES;      // Completed, Delivered
  const PENDING = Utils.ACTIVE_JOB_STATUSES;      // Received ... Waiting for Parts
  const CANCELLED = 'Cancelled';
  const GROUPS = ['completed', 'pending', 'cancelled'];
  const GROUP_LABEL = { completed: 'Completed', pending: 'Pending', cancelled: 'Cancelled' };
  const GROUP_TONE = { completed: 'good', pending: 'neutral', cancelled: 'bad' };
  const PAGE_SIZE = 25;
  // The server's id shape: prefix, hyphen, a zero-padded number that grows
  // past four digits (src/lib/write.js). Anything else is not a vehicle id.
  const VEHICLE_ID = /^VEH-\d{1,12}$/;

  /* ---------- dates (the same helpers as crm-reminders.js) ---------- */

  let dhakaFormat = null;
  try {
    dhakaFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch (e) { dhakaFormat = null; }

  /** The Dhaka calendar day of an instant, as YYYY-MM-DD ('' if invalid). */
  function dhakaDateOf(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (value === null || value === undefined || value === '' || isNaN(d)) return '';
    if (dhakaFormat) return dhakaFormat.format(d);
    // Bangladesh has kept UTC+6 without daylight saving since 2009.
    return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
  function isDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  /** "14 Oct 2026" for a YYYY-MM-DD date; anything else shows '—'. */
  function formatDay(value) {
    if (!isDateOnly(value)) return '—';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------- records ---------- */

  /** 'completed' | 'pending' | 'cancelled', or '' for a status the app does not know. */
  function groupOf(status) {
    if (COMPLETED.includes(status)) return 'completed';
    if (PENDING.includes(status)) return 'pending';
    if (status === CANCELLED) return 'cancelled';
    return '';
  }

  /** The day the work was finished: completedAt in Dhaka time, else actualDelivery. */
  function completionDate(job) {
    const completed = dhakaDateOf(job.completedAt);
    if (completed) return completed;
    return isDateOnly(job.actualDelivery) ? job.actualDelivery : '';
  }

  /**
   * The invoice that currently bills this job, or null. The same test
   * Utils.liveJobBalance() applies before trusting an invoice's figures: the
   * job card's own link, and never a Void invoice.
   */
  function liveInvoice(job, invoiceById) {
    const inv = job.invoiceId ? invoiceById.get(job.invoiceId) || null : null;
    return inv && inv.status !== 'Void' ? inv : null;
  }

  const digitsOf = v => String(v ?? '').replace(/\D/g, '');
  const compactReg = v => String(v ?? '').toLowerCase().replace(/[\s-]/g, '');
  const amount = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const roundMoney = n => Math.round(n * 100) / 100;
  const byIdDesc = (a, b) => String(b.id).localeCompare(String(a.id), 'en', { numeric: true });

  /**
   * One record per job card. Pure apart from Utils.liveJobBalance(), which
   * reads the job's advances from the payments Storage holds. Newest service
   * date first; a card without a readable date goes last.
   */
  function buildRecords({ jobCards, customers, vehicles, invoices }) {
    const people = new Map((customers || []).map(c => [c.id, c]));
    const cars = new Map((vehicles || []).map(v => [v.id, v]));
    const invoiceById = new Map((invoices || []).map(i => [i.id, i]));
    const seen = new Set();
    const records = [];
    for (const job of jobCards || []) {
      if (!job || !job.id || seen.has(job.id)) continue;   // one record per job card, always
      seen.add(job.id);
      const customer = people.get(job.customerId) || null;
      const vehicle = cars.get(job.vehicleId) || null;
      const balance = Utils.liveJobBalance(job, invoiceById);
      const invoice = liveInvoice(job, invoiceById);
      const services = (Array.isArray(job.services) ? job.services : [])
        .map(s => String((s && s.name) || '').trim()).filter(Boolean);
      const mileage = job.mileage === null || job.mileage === undefined || job.mileage === ''
        || !Number.isFinite(Number(job.mileage)) ? null : Number(job.mileage);
      const mileageOut = job.mileageOut === null || job.mileageOut === undefined || job.mileageOut === ''
        || !Number.isFinite(Number(job.mileageOut)) ? null : Number(job.mileageOut);
      records.push({
        id: String(job.id),
        date: isDateOnly(job.date) ? job.date : '',
        completed: completionDate(job),
        status: String(job.status || ''),
        group: groupOf(job.status),
        customerId: customer ? customer.id : '',
        customerName: customer ? String(customer.name || '') : '',
        phoneDigits: customer ? digitsOf(customer.phone) : '',
        vehicleId: job.vehicleId ? String(job.vehicleId) : '',
        vehicleKnown: !!vehicle,
        regNo: vehicle ? String(vehicle.regNo || '') : '',
        brand: vehicle ? String(vehicle.brand || '') : '',
        model: vehicle ? String(vehicle.model || '') : '',
        services,
        mileage,
        mileageOut,
        total: amount(job.total),
        paid: amount(balance.paid),
        due: amount(balance.due),
        waived: invoice ? amount(invoice.writtenOff) : 0,
        invoiceId: invoice ? String(invoice.id) : '',
      });
    }
    records.sort((a, b) => (a.date === b.date ? byIdDesc(a, b)
      : !a.date ? 1 : !b.date ? -1 : b.date.localeCompare(a.date)));
    return records;
  }

  /* ---------- filters ---------- */

  /** '' when the From / To pair can be applied, otherwise what is wrong with it. */
  function rangeError(from, to) {
    if (from && !isDateOnly(from)) return 'The From date is not a valid date.';
    if (to && !isDateOnly(to)) return 'The To date is not a valid date.';
    if (from && to && from > to) return 'The From date is after the To date.';
    return '';
  }

  /**
   * Does a record match the search? Customer name, brand, model and job card
   * id as text; the registration with spaces and hyphens ignored; the phone
   * number by its digits alone (and without a leading 0, so 01712... finds a
   * number stored as +880 1712...). Phone matching only runs for a term that
   * looks like a phone number, so "JOB-0001" never matches a phone.
   */
  function matchesSearch(r, search) {
    const term = String(search || '').trim().toLowerCase();
    if (!term) return true;
    const text = [r.customerName, r.brand, r.model, `${r.brand} ${r.model}`, r.regNo, r.id].join(' ').toLowerCase();
    if (text.includes(term)) return true;
    const reg = compactReg(term);
    if (reg && compactReg(r.regNo).includes(reg)) return true;
    if (/^[\d\s+().-]+$/.test(term)) {
      const digits = digitsOf(term);
      if (digits.length >= 3 && r.phoneDigits) {
        if (r.phoneDigits.includes(digits)) return true;
        if (digits.length > 3 && digits[0] === '0' && r.phoneDigits.includes(digits.slice(1))) return true;
      }
    }
    return false;
  }

  /**
   * The records that match the search, the status group and the inclusive
   * service-date range (on the job card's own date). The range must already
   * be valid (rangeError); an unreadable bound is ignored, never guessed.
   */
  function filterRecords(records, { search = '', status = 'all', from = '', to = '', vehicleId = '' } = {}) {
    const lo = isDateOnly(from) ? from : '';
    const hi = isDateOnly(to) ? to : '';
    return records.filter(r => {
      if (vehicleId && r.vehicleId !== vehicleId) return false;
      if (status !== 'all' && r.group !== status) return false;
      if ((lo || hi) && !r.date) return false;
      if (lo && r.date < lo) return false;
      if (hi && r.date > hi) return false;
      return matchesSearch(r, search);
    });
  }

  /**
   * The four cards and the cost breakdown, from whatever set is passed --
   * always the whole filtered set, never one page of it. Money is the
   * Completed group's only.
   */
  function summarize(records) {
    const out = { visits: 0, completed: 0, pending: 0, cancelled: 0, cost: 0, paid: 0, due: 0, waived: 0 };
    for (const r of records) {
      if (r.group === 'completed') {
        out.completed++;
        out.cost += r.total; out.paid += r.paid; out.due += r.due; out.waived += r.waived;
      } else if (r.group === 'pending') out.pending++;
      else if (r.group === 'cancelled') out.cancelled++;
    }
    out.visits = out.completed + out.pending;
    for (const k of ['cost', 'paid', 'due', 'waived']) out[k] = roundMoney(out[k]);
    return out;
  }

  /** One page of `list`: the page number is clamped into range. */
  function paginate(list, page = 1, size = PAGE_SIZE) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
    const start = total ? (current - 1) * size : 0;
    const items = list.slice(start, start + size);
    return { page: current, pages, total, items, from: total ? start + 1 : 0, to: start + items.length };
  }

  /**
   * One vehicle's whole history, oldest visit first, from the records alone
   * (job cards' vehicleId). `vehicle` is the current vehicle record or null;
   * each visit keeps its own customer. First / last visit and the mileage
   * progression ignore Cancelled cards, which were never service visits.
   */
  function buildTimeline(records, vehicleId, vehicle) {
    const visits = records.filter(r => r.vehicleId === vehicleId)
      .sort((a, b) => (a.date === b.date ? -byIdDesc(a, b)
        : !a.date ? 1 : !b.date ? -1 : a.date.localeCompare(b.date)));
    const counted = visits.filter(r => r.group === 'completed' || r.group === 'pending');
    const dated = counted.filter(r => r.date);
    const readings = counted.filter(r => r.mileage !== null).map(r => ({ date: r.date, id: r.id, mileage: r.mileage }));
    return {
      vehicleId,
      known: !!vehicle || visits.length > 0,
      visits,
      summary: summarize(visits),
      first: dated.length ? dated[0].date : '',
      last: dated.length ? dated[dated.length - 1].date : '',
      readings,
    };
  }

  /* ---------- rendering ---------- */

  const ICON = {
    job: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>',
    invoice: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>',
    car: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  const COLS = 10;
  const DASH = '<span aria-hidden="true">&#8212;</span>';
  const money = n => Utils.money(n);
  const km = n => `${Number(n).toLocaleString('en-IN')} km`;
  const vehicleText = r => [r.brand, r.model].filter(Boolean).join(' ');
  const timelineHref = id => `crm-history.html?vehicle=${encodeURIComponent(id)}`;

  /** Up to two service names, then "+N more"; the full list in a tooltip. */
  function servicesHtml(names) {
    if (!names.length) return '<span class="crh-muted" title="No service line on this job card">—</span>';
    const shown = names.slice(0, 2).map(esc).join(', ');
    const more = names.length > 2 ? ` <span class="crh-more">+${names.length - 2} more</span>` : '';
    return `<span title="${esc(names.join(', '))}">${shown}</span>${more}`;
  }

  /** The cost cell: the job card total, and what the live balance says about it. */
  function costHtml(r) {
    const total = esc(money(r.total));
    if (r.group === 'cancelled') {
      return `<span class="crh-struck">${total}</span><span class="cell-sub">Cancelled · not counted${r.paid > 0 ? ` · Paid ${esc(money(r.paid))}` : ''}</span>`;
    }
    if (r.group === 'pending') {
      return `${total}<span class="cell-sub">In progress · Paid ${esc(money(r.paid))}</span>`;
    }
    const waived = r.waived > 0 ? `<span class="cell-sub">Waived ${esc(money(r.waived))}</span>` : '';
    return `${total}<span class="cell-sub">Paid ${esc(money(r.paid))} · Due ${esc(money(r.due))}</span>${waived}`;
  }

  function badgeHtml(r) {
    const tone = GROUP_TONE[r.group] || 'neutral';
    const group = GROUP_LABEL[r.group] || 'Unknown status';
    return `<span class="badge badge--${tone}" title="${esc(group)}">${esc(r.status || 'Unknown')}</span>`;
  }

  function dateHtml(r) {
    let sub = '';
    if (r.group === 'completed') {
      sub = r.completed
        ? `<span class="cell-sub">Completed ${esc(formatDay(r.completed))}</span>`
        : '<span class="cell-sub">Completion date not recorded</span>';
    }
    return `${r.date ? esc(formatDay(r.date)) : '<span class="crh-muted">Date not recorded</span>'}${sub}`;
  }

  function rowHtml(r) {
    const name = r.customerName || 'Unknown customer';
    const vehicle = vehicleText(r) || '—';
    const reg = r.regNo || (r.vehicleKnown ? '—' : 'Unknown vehicle');
    const regCell = r.vehicleId && r.vehicleKnown
      ? `<a class="crh-reg" href="${esc(timelineHref(r.vehicleId))}" title="Open this vehicle's service timeline">${esc(reg)}</a>`
      : `<span class="crh-muted">${esc(reg)}</span>`;
    const invoice = r.invoiceId
      ? `<a class="icon-btn icon-btn--sm" href="invoices.html?view=${encodeURIComponent(r.invoiceId)}" title="View invoice ${esc(r.invoiceId)}" aria-label="View invoice ${esc(r.invoiceId)}">${ICON.invoice}</a>`
      : '';
    const timeline = r.vehicleId && r.vehicleKnown
      ? `<a class="icon-btn icon-btn--sm" href="${esc(timelineHref(r.vehicleId))}" title="Vehicle service timeline" aria-label="Service timeline for ${esc(r.regNo || vehicle)}">${ICON.history}</a>`
      : '';
    return `
      <tr data-id="${esc(r.id)}">
        <td data-label="Service Date">${dateHtml(r)}</td>
        <td data-label="Customer" class="cell-main${r.customerName ? '' : ' crh-unknown'}">${esc(name)}</td>
        <td data-label="Vehicle">${esc(vehicle)}</td>
        <td data-label="Registration Number">${regCell}</td>
        <td data-label="Job Card"><a href="job-cards.html?view=${encodeURIComponent(r.id)}">${esc(r.id)}</a></td>
        <td data-label="Services Performed">${servicesHtml(r.services)}</td>
        <td data-label="Mileage">${r.mileage === null ? '<span class="crh-muted">—</span>' : esc(km(r.mileage))}</td>
        <td data-label="Total Cost">${costHtml(r)}</td>
        <td data-label="Status">${badgeHtml(r)}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a class="icon-btn icon-btn--sm" href="job-cards.html?view=${encodeURIComponent(r.id)}" title="View job card ${esc(r.id)}" aria-label="View job card ${esc(r.id)}">${ICON.job}</a>
            ${invoice}
            ${timeline}
          </div>
        </td>
      </tr>`;
  }

  /** One full-width message row: loading, empty, no matches, invalid range or unavailable. */
  function stateRow({ icon = ICON.car, title, text, retry = false, clear = false, all = false, tone = 'neutral', badge = '' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
      all ? '<a class="btn btn--ghost btn--sm" href="crm-history.html">Show all service records</a>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="crh-empty-row">
        <td colspan="${COLS}">
          <div class="crh-empty${tone === 'bad' ? ' crh-empty--bad' : ''}">
            <span class="crh-empty__icon">${icon}</span>
            <div class="crh-empty__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="crh-actions">${actions}</p>` : ''}
            </div>
            ${badge ? `<span class="badge badge--${tone === 'bad' ? 'bad' : 'neutral'} crh-empty__status">${esc(badge)}</span>` : ''}
          </div>
        </td>
      </tr>`;
  }

  /** The timeline panel for one vehicle (all of its visits, whatever the filters). */
  function timelineHtml(t, vehicle, owner) {
    if (!t.known) {
      return `
        <div class="crh-empty crh-empty--bad">
          <span class="crh-empty__icon">${ICON.alert}</span>
          <div class="crh-empty__text">
            <h3>Vehicle not found</h3>
            <p>No vehicle in the workshop database matches this link, so there is no service timeline to show.</p>
            <p class="crh-actions"><a class="btn btn--ghost btn--sm" href="crm-history.html">Show all service records</a></p>
          </div>
        </div>`;
    }
    const reg = vehicle ? String(vehicle.regNo || '') : (t.visits[0] && t.visits[0].regNo) || '';
    const name = vehicle ? [vehicle.brand, vehicle.model].filter(Boolean).join(' ') : '';
    const s = t.summary;
    const first = t.readings[0], last = t.readings[t.readings.length - 1];
    let mileage = 'No mileage recorded';
    if (first && last && first !== last) {
      const delta = last.mileage - first.mileage;
      mileage = `${km(first.mileage)} → ${km(last.mileage)}${delta >= 0 ? ` (+${km(delta)})` : ''}`;
    } else if (first) {
      mileage = km(first.mileage);
    }
    const items = t.visits.map(r => `
          <li class="crh-tl__item crh-tl__item--${esc(r.group || 'unknown')}">
            <span class="crh-tl__dot" aria-hidden="true"></span>
            <div class="crh-tl__body">
              <div class="crh-tl__top">
                <strong>${r.date ? esc(formatDay(r.date)) : 'Date not recorded'}</strong>
                ${badgeHtml(r)}
                <a href="job-cards.html?view=${encodeURIComponent(r.id)}">${esc(r.id)}</a>
              </div>
              <div class="crh-tl__meta">
                <span>${esc(r.customerName || 'Unknown customer')}</span>
                <span>${r.mileage === null ? 'Mileage —' : esc(km(r.mileage))}</span>
                <span>${esc(money(r.total))}${r.group === 'cancelled' ? ' · not counted' : ''}</span>
                ${r.group === 'completed' && r.completed ? `<span>Completed ${esc(formatDay(r.completed))}</span>` : ''}
              </div>
              <div class="crh-tl__services">${r.services.length ? esc(r.services.join(', ')) : 'No service line recorded'}</div>
            </div>
          </li>`).join('');
    return `
      <div class="card__head crh-tl__head">
        <h2 id="crhTimelineTitle">Vehicle service timeline</h2>
        <span class="spacer"></span>
        <a class="btn btn--ghost btn--sm" href="crm-history.html">All service records</a>
      </div>
      <div class="crh-tl__intro">
        <div class="crh-tl__vehicle">
          <strong>${esc(reg || 'Unknown registration')}</strong>
          ${name ? `<span>${esc(name)}</span>` : ''}
          <span class="crh-muted">Current owner: ${esc(owner ? owner.name || 'Unknown customer' : 'Unknown customer')}</span>
        </div>
        <dl class="crh-tl__facts">
          <div><dt>Visits</dt><dd>${esc(String(s.visits))}${s.cancelled ? ` <span class="crh-muted">(+${esc(String(s.cancelled))} cancelled)</span>` : ''}</dd></div>
          <div><dt>First visit</dt><dd>${esc(formatDay(t.first))}</dd></div>
          <div><dt>Last visit</dt><dd>${esc(formatDay(t.last))}</dd></div>
          <div><dt>Mileage</dt><dd>${esc(mileage)}</dd></div>
          <div><dt>Completed service cost</dt><dd>${esc(money(s.cost))}</dd></div>
          <div><dt>Paid · Due · Waived</dt><dd>${esc(money(s.paid))} · ${esc(money(s.due))} · ${esc(money(s.waived))}</dd></div>
        </dl>
      </div>
      ${t.visits.length
        ? `<ol class="crh-tl" aria-label="Service visits, oldest first">${items}</ol>`
        : '<p class="crh-tl__none">No service visits are recorded for this vehicle yet.</p>'}`;
  }

  /* ---------- the page ---------- */

  const state = {
    records: [], search: '', status: 'all', from: '', to: '', page: 1,
    vehicleId: '', vehicleValid: true, vehicle: null, owner: null,
  };
  const $ = id => document.getElementById(id);
  let debounce = null;

  function setControls(enabled) {
    for (const id of ['crhSearch', 'crhStatus', 'crhFrom', 'crhTo', 'crhClear']) {
      const el = $(id);
      if (el) el.disabled = !enabled;
    }
  }

  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
  function setHtml(id, html) { const el = $(id); if (el) el.innerHTML = html; }

  /** The four cards; `s` null shows dashes with `why` underneath. */
  function setCards(s, why = 'Unavailable') {
    if (!s) {
      for (const id of ['crhVisits', 'crhCompleted', 'crhPending', 'crhCost']) setHtml(id, DASH);
      for (const id of ['crhVisitsSub', 'crhCompletedSub', 'crhPendingSub', 'crhCostSub']) setText(id, why);
      return;
    }
    setHtml('crhVisits', esc(String(s.visits)));
    setHtml('crhCompleted', esc(String(s.completed)));
    setHtml('crhPending', esc(String(s.pending)));
    setHtml('crhCost', esc(money(s.cost)));
    setText('crhVisitsSub', s.cancelled
      ? `Completed + pending · ${s.cancelled} cancelled not counted` : 'Completed + pending');
    setText('crhCompletedSub', 'Completed or delivered');
    setText('crhPendingSub', 'Work still in progress');
    setText('crhCostSub', `Paid ${money(s.paid)} · Due ${money(s.due)} · Waived ${money(s.waived)}`);
  }

  function setTable(html, hasRows) {
    setHtml('crhBody', html);
    const table = $('crhTable');
    if (table && table.classList) table.classList.toggle('crh-table--rows', !!hasRows);
  }

  function setPager(p) {
    const pager = $('crhPager');
    if (pager) pager.hidden = !p || p.total === 0;
    if (!p || !p.total) return;
    setText('crhRange', `${p.from}–${p.to} of ${p.total}`);
    const prev = $('crhPrev'), next = $('crhNext');
    if (prev) prev.disabled = p.page <= 1;
    if (next) next.disabled = p.page >= p.pages;
  }

  function setRangeError(message) {
    const el = $('crhRangeError');
    if (el) { el.textContent = message; el.hidden = !message; }
    for (const id of ['crhFrom', 'crhTo']) {
      const input = $(id);
      if (input && input.setAttribute) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
  }

  function note(text) { setText('crhToolbarNote', text); }

  /** The vehicle in the URL, if any: '' for none, or the raw value. */
  function vehicleParam() {
    try {
      return String(new URLSearchParams(location.search || '').get('vehicle') || '').trim();
    } catch (e) { return ''; }
  }

  /** Re-render cards, table, pager and note from the current filters. */
  function renderList() {
    const error = rangeError(state.from, state.to);
    setRangeError(error);
    if (state.vehicleId && !state.vehicleValid) {
      setCards(null, 'Unknown vehicle');
      setPager(null);
      setTable(stateRow({ icon: ICON.alert, title: 'No vehicle matches this link',
        text: 'The vehicle in the address is not in the workshop database, so no service records are shown.', all: true }), false);
      note('No vehicle matches this link.');
      return;
    }
    if (error) {
      setCards(null, 'Invalid date range');
      setPager(null);
      setTable(stateRow({ icon: ICON.alert, title: 'Fix the date range',
        text: `${error} Change the From or To date to see service records.`, clear: true }), false);
      note(error);
      return;
    }
    const scope = state.vehicleId ? state.records.filter(r => r.vehicleId === state.vehicleId) : state.records;
    const shown = filterRecords(scope, state);
    setCards(summarize(shown));
    if (!state.records.length) {
      setPager(null);
      setTable(stateRow({ title: 'No service records yet',
        text: 'No job card has been recorded in the workshop database. Service visits appear here as soon as job cards are created.' }), false);
      note('0 service records');
      return;
    }
    if (!scope.length) {
      setPager(null);
      setTable(stateRow({ title: 'No service visits for this vehicle',
        text: 'This vehicle has no job card in the workshop database yet.', all: true }), false);
      note('0 service records for this vehicle');
      return;
    }
    if (!shown.length) {
      setPager(null);
      setTable(stateRow({ icon: ICON.search, title: 'No service records match your search or filters',
        text: 'Change or clear the search, status or date range to see more service records.', clear: true }), false);
      note(`No matches among ${scope.length} service record${scope.length === 1 ? '' : 's'}`);
      return;
    }
    const p = paginate(shown, state.page);
    state.page = p.page;
    setTable(p.items.map(rowHtml).join(''), true);
    setPager(p);
    const of = shown.length === scope.length ? '' : ` · filtered from ${scope.length}`;
    note(`Showing ${p.from}–${p.to} of ${p.total} service record${p.total === 1 ? '' : 's'}${of}`);
  }

  function renderTimeline() {
    const panel = $('crhTimeline');
    if (!panel) return;
    if (!state.vehicleId) { panel.hidden = true; panel.innerHTML = ''; return; }
    const t = state.vehicleValid
      ? buildTimeline(state.records, state.vehicleId, state.vehicle)
      : { known: false };
    panel.innerHTML = timelineHtml(t, state.vehicle, state.owner);
    panel.hidden = false;
  }

  /** The page cannot show service history: say why, and offer a retry where useful. */
  function renderUnavailable(outcome) {
    const noBackend = outcome && outcome.reason === 'no_api';
    setControls(false);
    setCards(null);
    setPager(null);
    setRangeError('');
    const panel = $('crhTimeline');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    note('Search and filters are unavailable until the service history loads.');
    setTable(stateRow({
      icon: ICON.alert, tone: 'bad', badge: 'Unavailable', retry: !noBackend,
      title: noBackend ? 'Service history needs the workshop database'
                       : 'Service history could not be loaded',
      text: noBackend
        ? 'This copy of the app is not connected to the workshop database, so no service records are shown.'
        : 'The workshop database did not answer, so no service records are shown. Nothing stored in this browser is used in their place.',
    }), false);
  }

  function render(outcome) {
    // Signed out: the app covers the window with its sign-in screen and
    // reloads after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    if (!Storage.isApi()) { renderUnavailable(outcome); return; }

    const vehicles = Storage.getData('vehicles');
    const customers = Storage.getData('customers');
    state.records = buildRecords({
      jobCards: Storage.getData('jobCards'),
      customers,
      vehicles,
      invoices: Storage.getData('invoices'),
    });

    const raw = vehicleParam();
    state.vehicleId = raw;
    state.vehicle = null;
    state.owner = null;
    state.vehicleValid = true;
    if (raw) {
      state.vehicle = VEHICLE_ID.test(raw) ? vehicles.find(v => v.id === raw) || null : null;
      state.vehicleValid = !!state.vehicle || (VEHICLE_ID.test(raw) && state.records.some(r => r.vehicleId === raw));
      state.owner = state.vehicle ? customers.find(c => c.id === state.vehicle.customerId) || null : null;
    }
    setControls(!(raw && !state.vehicleValid));
    renderTimeline();
    renderList();
  }

  /* ---------- events ---------- */

  function resetPage() { state.page = 1; }

  function clearFilters() {
    state.search = ''; state.status = 'all'; state.from = ''; state.to = '';
    resetPage();
    for (const [id, value] of [['crhSearch', ''], ['crhStatus', 'all'], ['crhFrom', ''], ['crhTo', '']]) {
      const el = $(id);
      if (el) el.value = value;
    }
    renderList();
  }

  /** A fresh page load re-runs hydration, the same way signing in does. */
  function retry() { location.reload(); }

  function bindEvents() {
    const search = $('crhSearch'), status = $('crhStatus'), from = $('crhFrom'), to = $('crhTo');
    const clear = $('crhClear'), prev = $('crhPrev'), next = $('crhNext'), body = $('crhBody');
    if (search) search.addEventListener('input', e => {
      const value = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; resetPage(); renderList(); }, 200);
    });
    if (status) status.addEventListener('change', e => {
      state.status = GROUPS.includes(e.target.value) ? e.target.value : 'all';
      resetPage(); renderList();
    });
    if (from) from.addEventListener('change', e => { state.from = String(e.target.value || ''); resetPage(); renderList(); });
    if (to) to.addEventListener('change', e => { state.to = String(e.target.value || ''); resetPage(); renderList(); });
    if (clear) clear.addEventListener('click', () => { clearTimeout(debounce); clearFilters(); });
    if (prev) prev.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderList(); });
    if (next) next.addEventListener('click', () => { state.page += 1; renderList(); });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      const action = btn && btn.getAttribute ? btn.getAttribute('data-action') : (btn && btn.action);
      if (action === 'retry') retry();
      else if (action === 'clear') { clearTimeout(debounce); clearFilters(); }
    });
  }

  Storage.ready(outcome => { bindEvents(); render(outcome); });

  return {
    dhakaDateOf, isDateOnly, formatDay, groupOf, completionDate,
    buildRecords, rangeError, matchesSearch, filterRecords, summarize, paginate, buildTimeline,
    render, renderList, state, PAGE_SIZE,
  };
})();
