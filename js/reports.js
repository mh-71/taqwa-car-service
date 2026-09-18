/* ============================================================
   reports.js — Reports module
   READ-ONLY. Never calls Storage.addData/updateData/deleteData on
   anything -- every function here only reads via Storage.getData/
   getById and renders. No other module is modified by this file.

   Revenue = non-Void Payments (never Job Card/Invoice totals).
   Expense = Active Expenses only.
   Invoice paid/due shown here are recomputed LIVE from non-Void
   Payments (not trusted from the stored, potentially stale field) --
   except for a Void invoice, whose numbers are shown as the frozen
   historical record they are.
   Mechanic report shows BOTH:
     - Billed Value   = sum of job.total for jobs assigned in range
                        (unchanged concept, same basis Utils.getMechanicRevenue
                        uses elsewhere -- that helper and the Mechanics
                        page are untouched by this file)
     - Collected Revenue = actual non-Void Payments traced
                        Payment -> Invoice -> Job Card -> Mechanic
   These are deliberately different numbers and are labeled as such.

   Performance: every report function fetches each collection exactly
   once (via buildLookups() or a single Storage.getData call) and
   never calls Storage.getById inside a loop.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge } = Utils;

  let repType = 'revenue';
  let quickRange = 'month';
  let customFrom = '';
  let customTo = '';

  /* ============================================================
     Date range helpers -- all local-time based, never toISOString(),
     to avoid the classic UTC-shift-by-one-day bug on computed
     boundaries. "Today"/"Yesterday" build on Utils.todayStr() so
     Reports' definition of "today" never disagrees with the rest
     of the app.
     ============================================================ */

  function parseLocalDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function addDays(dateStr, delta) {
    const d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + delta);
    return toDateStr(d);
  }

  function getRange(quick, from, to) {
    const today = Utils.todayStr();
    switch (quick) {
      case 'today': return { from: today, to: today, label: 'Today' };
      case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y, label: 'Yesterday' }; }
      case 'week': {
        const d = parseLocalDate(today);
        const daysSinceMonday = (d.getDay() + 6) % 7; // Mon=0..Sun=6
        const monday = addDays(today, -daysSinceMonday);
        return { from: monday, to: today, label: 'This Week' };
      }
      case 'month': {
        const d = parseLocalDate(today);
        const first = toDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
        return { from: first, to: today, label: 'This Month' };
      }
      case 'lastmonth': {
        const d = parseLocalDate(today);
        const lastOfPrev = new Date(d.getFullYear(), d.getMonth(), 0); // day 0 = last day of previous month
        const firstOfPrev = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
        return { from: toDateStr(firstOfPrev), to: toDateStr(lastOfPrev), label: 'Last Month' };
      }
      case 'custom': {
        let f = from || today, t = to || today;
        if (f > t) { const tmp = f; f = t; t = tmp; } // defensive swap if reversed
        return { from: f, to: t, label: `${fmtDate(f)} \u2013 ${fmtDate(t)}` };
      }
      default: return { from: today, to: today, label: 'Today' };
    }
  }

  /** Inclusive range check against a stored YYYY-MM-DD (or ISO timestamp) string. */
  function inRange(dateStr, range) {
    const d = (dateStr || '').slice(0, 10);
    return !!d && d >= range.from && d <= range.to;
  }

  /* ============================================================
     Shared lookups -- each collection fetched exactly once per
     report render, reused via Map instead of repeated Storage.getById
     calls inside loops.
     ============================================================ */

  function buildLookups() {
    return {
      customersById: new Map(Storage.getData('customers').map(c => [c.id, c])),
      vehiclesById: new Map(Storage.getData('vehicles').map(v => [v.id, v])),
      jobCardsById: new Map(Storage.getData('jobCards').map(j => [j.id, j])),
      mechanicsById: new Map(Storage.getData('mechanics').map(m => [m.id, m])),
      partsById: new Map(Storage.getData('parts').map(p => [p.id, p])),
      invoicesById: new Map(Storage.getData('invoices').map(i => [i.id, i]))
    };
  }

  /* ============================================================
     Report computations -- pure, read-only, one Storage.getData
     per collection.
     ============================================================ */

  function computeRevenueReport(range) {
    const payments = Storage.getData('payments').filter(p => p.status !== 'Void' && inRange(p.date, range));
    const total = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const byMethod = {};
    payments.forEach(p => { byMethod[p.method] = (byMethod[p.method] || 0) + (Number(p.amount) || 0); });
    const byDay = {};
    payments.forEach(p => { const d = (p.date || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + (Number(p.amount) || 0); });
    return { total, count: payments.length, byMethod, byDay, payments };
  }

  function computeExpenseReport(range) {
    const expenses = Storage.getData('expenses').filter(e => e.status !== 'Void' && inRange(e.date, range));
    const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCategory = {};
    expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + (Number(e.amount) || 0); });
    const byMethod = {};
    expenses.forEach(e => { byMethod[e.method] = (byMethod[e.method] || 0) + (Number(e.amount) || 0); });
    const byDay = {};
    expenses.forEach(e => { const d = (e.date || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + (Number(e.amount) || 0); });
    return { total, count: expenses.length, byCategory, byMethod, byDay, expenses };
  }

  function computeNetResultReport(range) {
    const revenue = computeRevenueReport(range);
    const expense = computeExpenseReport(range);
    return { revenue, expense, net: revenue.total - expense.total };
  }

  function computePaymentReport(range) {
    const all = Storage.getData('payments').filter(p => inRange(p.date, range));
    const active = all.filter(p => p.status !== 'Void');
    const collected = active.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return {
      payments: all,
      collected,
      voidCount: all.length - active.length,
      advanceCount: all.filter(p => !p.invoiceId).length
    };
  }

  /**
   * Invoice paid/due recomputed live from non-Void Payments -- never trusted
   * from the stored field, per spec, for a Void invoice as much as a live one.
   *
   * Voiding an invoice releases its payments back to advances (invoices.js),
   * so a Void invoice normally has nothing linked and its live collected
   * figure is 0, while the money itself stays in the Revenue report and in
   * Payments' Outstanding Advances. Reading its FROZEN `paid` here instead
   * would count the same cash twice -- once against the cancelled invoice and
   * again against the advance, or the replacement invoice it is re-applied to.
   * That frozen figure stays on the invoice record as history; it is simply
   * not a live collection. A Void invoice is never owed, so liveDue stays 0.
   */
  function computeInvoiceReport(range) {
    const invoices = Storage.getData('invoices').filter(i => inRange(i.date, range));
    const allPayments = Storage.getData('payments');
    const rows = invoices.map(inv => {
      const total = Number(inv.total) || 0;
      const paid = Math.min(total, allPayments
        .filter(p => p.invoiceId === inv.id && p.status !== 'Void')
        .reduce((s, p) => s + (Number(p.amount) || 0), 0));
      return { ...inv, livePaid: paid, liveDue: inv.status === 'Void' ? 0 : Math.max(total - paid, 0) };
    });
    return {
      rows,
      totalBilled: rows.reduce((s, r) => s + (Number(r.total) || 0), 0),
      totalCollected: rows.reduce((s, r) => s + (Number(r.livePaid) || 0), 0),
      totalDue: rows.reduce((s, r) => s + (Number(r.liveDue) || 0), 0)
    };
  }

  function computeJobCardReport(range) {
    const jobs = Storage.getData('jobCards').filter(j => inRange(j.date, range));
    const byStatus = {};
    jobs.forEach(j => { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
    return {
      jobs, total: jobs.length, byStatus,
      totalValue: jobs.reduce((s, j) => s + (Number(j.total) || 0), 0),
      activeCount: jobs.filter(j => Utils.ACTIVE_JOB_STATUSES.includes(j.status)).length,
      completedCount: jobs.filter(j => j.status === 'Completed').length,
      deliveredCount: jobs.filter(j => j.status === 'Delivered').length,
      cancelledCount: jobs.filter(j => j.status === 'Cancelled').length
    };
  }

  /** Stock levels are point-in-time (current, not date-ranged -- a live quantity isn't a period flow). Movement/usage respect the selected range. */
  function computeInventoryReport(range) {
    const parts = Storage.getData('parts');
    const active = parts.filter(p => (p.status || 'Active') === 'Active');
    const stockValue = parts.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.purchasePrice) || 0), 0);
    const potentialSales = parts.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.sellingPrice) || 0), 0);
    const lowStock = active.filter(p => Utils.Inventory.stockStatus(p) === 'Low Stock').length;
    const outOfStock = active.filter(p => Utils.Inventory.stockStatus(p) === 'Out of Stock').length;

    const IN_TYPES = ['purchase', 'adjustment-in', 'return', 'initial-stock'];
    const OUT_TYPES = ['sale', 'job-card-use', 'adjustment-out', 'damaged'];
    const txns = Storage.getData('inventoryTransactions').filter(t => inRange(t.createdAt, range));
    const movementIn = txns.filter(t => IN_TYPES.includes(t.type)).reduce((s, t) => s + (Number(t.quantity) || 0), 0);
    const movementOut = txns.filter(t => OUT_TYPES.includes(t.type)).reduce((s, t) => s + (Number(t.quantity) || 0), 0);
    const usageByPart = {};
    txns.filter(t => t.type === 'job-card-use').forEach(t => {
      usageByPart[t.partId] = (usageByPart[t.partId] || 0) + (Number(t.quantity) || 0);
    });

    return { totalParts: parts.length, stockValue, potentialSales, lowStock, outOfStock, movementIn, movementOut, usageByPart, txnCount: txns.length };
  }

  /** "New customers" uses createdAt within range; job/payment counts are flow metrics for the same range. Total customer count and vehicle ownership are point-in-time. */
  function computeCustomerReport(range) {
    const customers = Storage.getData('customers');
    const vehicles = Storage.getData('vehicles');
    const payments = Storage.getData('payments').filter(p => p.status !== 'Void' && inRange(p.date, range));
    const jobs = Storage.getData('jobCards').filter(j => inRange(j.date, range));

    const newCustomers = customers.filter(c => inRange(c.createdAt, range));
    const customersWithVehicles = new Set(vehicles.map(v => v.customerId)).size;

    const rows = customers.map(c => ({
      id: c.id,
      name: c.name,
      jobsInRange: jobs.filter(j => j.customerId === c.id).length,
      paymentsInRange: payments.filter(p => p.customerId === c.id).reduce((s, p) => s + (Number(p.amount) || 0), 0)
    })).filter(r => r.jobsInRange > 0 || r.paymentsInRange > 0)
      .sort((a, b) => b.paymentsInRange - a.paymentsInRange);

    return { totalCustomers: customers.length, newCustomersCount: newCustomers.length, customersWithVehicles, rows };
  }

  /**
   * Billed Value = sum of job.total for jobs assigned to the mechanic in
   * range (same basis Utils.getMechanicRevenue uses -- that helper and the
   * Mechanics page are NOT modified by this file).
   * Collected Revenue = actual non-Void Payments traced
   * Payment -> Invoice -> Job Card -> Mechanic. A payment with a direct
   * jobCardId (e.g. an advance) resolves straight to that job's mechanic;
   * otherwise it resolves via its invoice's jobCardId. Payments that can't
   * be traced to any job card (e.g. an unlinked advance) are counted as
   * "unattributed" rather than silently dropped or guessed at.
   */
  function computeMechanicReport(range, lookups) {
    const mechanics = Storage.getData('mechanics');
    const jobs = Storage.getData('jobCards').filter(j => inRange(j.date, range));
    const payments = Storage.getData('payments').filter(p => p.status !== 'Void' && inRange(p.date, range));

    function resolveMechanicId(payment) {
      let jobCardId = payment.jobCardId;
      if (!jobCardId && payment.invoiceId) {
        const inv = lookups.invoicesById.get(payment.invoiceId);
        jobCardId = inv ? inv.jobCardId : null;
      }
      if (!jobCardId) return null;
      const job = lookups.jobCardsById.get(jobCardId);
      return job ? job.mechanicId : null;
    }

    const collectedByMechanic = {};
    let unattributed = 0;
    payments.forEach(p => {
      const mechId = resolveMechanicId(p);
      if (mechId) collectedByMechanic[mechId] = (collectedByMechanic[mechId] || 0) + (Number(p.amount) || 0);
      else unattributed += (Number(p.amount) || 0);
    });

    const rows = mechanics.map(m => {
      const mJobs = jobs.filter(j => j.mechanicId === m.id);
      return {
        id: m.id, name: m.name,
        jobsAssigned: mJobs.length,
        active: mJobs.filter(j => Utils.ACTIVE_JOB_STATUSES.includes(j.status)).length,
        completed: mJobs.filter(j => Utils.DONE_JOB_STATUSES.includes(j.status)).length,
        billedValue: mJobs.reduce((s, j) => s + (Number(j.total) || 0), 0),
        collectedRevenue: collectedByMechanic[m.id] || 0
      };
    });

    return { rows, unattributed };
  }

  /** Uses the frozen service-line snapshot already stored on each Job Card -- never the current catalog price, per spec. */
  function computeServiceReport(range) {
    const jobs = Storage.getData('jobCards').filter(j => inRange(j.date, range));
    const byService = {};
    jobs.forEach(j => {
      (j.services || []).forEach(line => {
        const key = line.serviceId || line.name;
        if (!byService[key]) byService[key] = { name: line.name, count: 0, revenue: 0 };
        byService[key].count += Number(line.qty) || 0;
        byService[key].revenue += Number(line.total) || 0;
      });
    });
    return { rows: Object.values(byService).sort((a, b) => b.revenue - a.revenue) };
  }

  /* ============================================================
     Shared render helpers
     ============================================================ */

  function statCardsHtml(stats) {
    return `<section class="stats-grid" aria-label="Report summary">${stats.map(s => `
      <div class="stat">
        <div class="stat__icon stat__icon--${s.tone}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${s.icon}"/></svg>
        </div>
        <div>
          <div class="stat__value">${s.value}</div>
          <div class="stat__label">${s.label}</div>
        </div>
      </div>`).join('')}</section>`;
  }

  const ICONS = {
    money: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z',
    check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    box: 'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    people: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
    wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z',
    doc: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    card: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z'
  };

  /** Bars for a per-day amount series across the range. Capped at 62 days to stay readable; totals shown separately always cover the full range regardless. */
  function dailyBarChartHtml(byDay, range) {
    const days = [];
    let cur = range.from;
    while (cur <= range.to && days.length < 62) { days.push(cur); cur = addDays(cur, 1); }
    if (range.to !== days[days.length - 1]) {
      return `<p class="muted-note">Daily chart is only shown for ranges up to 62 days; the totals above cover the full selected range.</p>`;
    }
    const max = Math.max(...days.map(d => byDay[d] || 0), 1);
    const today = Utils.todayStr();
    const cols = days.map(d => `
      <div class="rev-col${d === today ? ' rev-col--today' : ''}">
        <div class="rev-col__bar-wrap">
          <div class="rev-col__bar" style="height:${Math.round((byDay[d] || 0) / max * 100)}%"
               data-amount="${money(byDay[d] || 0)}" role="img" aria-label="${d}: ${money(byDay[d] || 0)}"></div>
        </div>
        <span class="rev-col__label">${d.slice(5)}</span>
      </div>`).join('');
    return `<div class="rev-chart">${cols}</div>`;
  }

  /** Ranked horizontal bars, e.g. expenses by category, popular services. */
  function barListHtml(rows) {
    if (!rows.length) return `<p class="muted-note">No data for this range.</p>`;
    const max = Math.max(...rows.map(r => r.value), 1);
    return `<div class="bar-list">${rows.map(r => `
      <div class="bar-list__row">
        <span class="bar-list__label">${esc(r.label)}</span>
        <div class="bar-list__track"><div class="bar-list__fill" style="width:${Math.round(r.value / max * 100)}%"></div></div>
        <span class="bar-list__value">${r.display || money(r.value)}</span>
      </div>`).join('')}</div>`;
  }

  function tableHtml(headers, rows, emptyMessage) {
    if (!rows.length) return `<p class="muted-note">${emptyMessage || 'No records for this range.'}</p>`;
    return `<div class="table-wrap"><table class="table table--compact">
      <thead><tr>${headers.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  /* ============================================================
     Per-report render functions
     ============================================================ */

  function renderRevenueReport(range) {
    const r = computeRevenueReport(range);
    const stats = statCardsHtml([
      { label: 'Collected Revenue', value: money(r.total), tone: 'good', icon: ICONS.money },
      { label: 'Payments Counted', value: r.count, tone: 'info', icon: ICONS.card }
    ]);
    const byMethodRows = Object.entries(r.byMethod).sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }));
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Revenue by Day</h3>
        ${dailyBarChartHtml(r.byDay, range)}
      </div></section>
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Revenue by Method</h3>
        ${barListHtml(byMethodRows)}
      </div></section>
      <p class="muted-note">Based on ${r.count} non-Void payment${r.count === 1 ? '' : 's'} in the selected range. Excludes Job Card and Invoice totals -- only money actually collected counts as revenue.</p>`;
  }

  function renderExpenseReport(range) {
    const r = computeExpenseReport(range);
    const stats = statCardsHtml([
      { label: 'Total Expenses', value: money(r.total), tone: 'bad', icon: ICONS.money },
      { label: 'Expenses Counted', value: r.count, tone: 'info', icon: ICONS.doc }
    ]);
    const byCategoryRows = Object.entries(r.byCategory).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    const byMethodRows = Object.entries(r.byMethod).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Expenses by Day</h3>
        ${dailyBarChartHtml(r.byDay, range)}
      </div></section>
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Expenses by Category</h3>
        ${barListHtml(byCategoryRows)}
      </div></section>
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Expenses by Method</h3>
        ${barListHtml(byMethodRows)}
      </div></section>
      <p class="muted-note">Active expenses only -- ${r.count} record${r.count === 1 ? '' : 's'} in the selected range. Void expenses are excluded.</p>`;
  }

  function renderNetResultReport(range) {
    const r = computeNetResultReport(range);
    const stats = statCardsHtml([
      { label: 'Collected Revenue', value: money(r.revenue.total), tone: 'good', icon: ICONS.money },
      { label: 'Total Expenses', value: money(r.expense.total), tone: 'bad', icon: ICONS.money },
      { label: 'Net Result', value: money(r.net), tone: r.net >= 0 ? 'good' : 'bad', icon: ICONS.check }
    ]);
    return `${stats}
      <div class="warn-banner">Net Result = Collected Revenue \u2212 Active Expenses. This is a management-level indicator, not a full accounting profit figure (it does not account for accruals, depreciation, inventory valuation changes, or taxes).</div>`;
  }

  function renderPaymentReport(range) {
    const r = computePaymentReport(range);
    const stats = statCardsHtml([
      { label: 'Collected (non-Void)', value: money(r.collected), tone: 'good', icon: ICONS.money },
      { label: 'Advance Payments', value: r.advanceCount, tone: 'warn', icon: ICONS.wrench },
      { label: 'Void Payments', value: r.voidCount, tone: 'neutral', icon: ICONS.warn }
    ]);
    const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
    const rows = r.payments
      .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(p => `<tr>
        <td class="cell-main">${esc(p.id)}</td>
        <td>${fmtDate(p.date)}</td>
        <td>${esc(custName(p.customerId))}</td>
        <td>${p.invoiceId ? esc(p.invoiceId) : `<span class="badge badge--warn">Advance</span>`}</td>
        <td>${p.jobCardId ? esc(p.jobCardId) : '—'}</td>
        <td>${esc(p.method)}</td>
        <td class="num">${money(p.amount)}</td>
        <td>${badge(p.status)}</td>
      </tr>`).join('');
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Payments in Range</h3>
        ${tableHtml([{ label: 'Payment #' }, { label: 'Date' }, { label: 'Customer' }, { label: 'Invoice' }, { label: 'Job Card' }, { label: 'Method' }, { label: 'Amount', num: true }, { label: 'Status' }], rows, 'No payments in this range.')}
      </div></section>`;
  }

  function renderInvoiceReport(range) {
    const r = computeInvoiceReport(range);
    const stats = statCardsHtml([
      { label: 'Total Billed', value: money(r.totalBilled), tone: 'info', icon: ICONS.doc },
      { label: 'Collected (live)', value: money(r.totalCollected), tone: 'good', icon: ICONS.money },
      { label: 'Outstanding Due', value: money(r.totalDue), tone: 'bad', icon: ICONS.warn }
    ]);
    const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
    const rows = r.rows
      .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(i => `<tr>
        <td class="cell-main">${esc(i.id)}</td>
        <td>${fmtDate(i.date)}</td>
        <td>${esc(custName(i.customerId))}</td>
        <td>${i.jobCardId ? esc(i.jobCardId) : '—'}</td>
        <td class="num">${money(i.total)}</td>
        <td class="num">${money(i.livePaid)}</td>
        <td class="num">${money(i.liveDue)}</td>
        <td>${badge(i.status)}</td>
      </tr>`).join('');
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Invoices in Range</h3>
        ${tableHtml([{ label: 'Invoice #' }, { label: 'Date' }, { label: 'Customer' }, { label: 'Job Card' }, { label: 'Total', num: true }, { label: 'Paid', num: true }, { label: 'Due', num: true }, { label: 'Status' }], rows, 'No invoices in this range.')}
      </div></section>
      <p class="muted-note">Paid/Due are recomputed live from non-Void Payments for active invoices; a Void invoice shows its frozen historical figures instead.</p>`;
  }

  function renderJobCardReport(range) {
    const r = computeJobCardReport(range);
    const stats = statCardsHtml([
      { label: 'Total Job Cards', value: r.total, tone: 'info', icon: ICONS.doc },
      { label: 'Active', value: r.activeCount, tone: 'warn', icon: ICONS.wrench },
      { label: 'Completed', value: r.completedCount, tone: 'good', icon: ICONS.check },
      { label: 'Delivered', value: r.deliveredCount, tone: 'good', icon: ICONS.check },
      { label: 'Cancelled', value: r.cancelledCount, tone: 'bad', icon: ICONS.warn },
      { label: 'Total Job Value', value: money(r.totalValue), tone: 'info', icon: ICONS.money }
    ]);
    const byStatusRows = Object.entries(r.byStatus).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Jobs by Status</h3>
        ${barListHtml(byStatusRows)}
      </div></section>`;
  }

  function renderInventoryReport(range) {
    const r = computeInventoryReport(range);
    const lookups = buildLookups();
    const stats = statCardsHtml([
      { label: 'Total Parts', value: r.totalParts, tone: 'info', icon: ICONS.box },
      { label: 'Stock Value', value: money(r.stockValue), tone: 'amber', icon: ICONS.money },
      { label: 'Potential Sales Value', value: money(r.potentialSales), tone: 'good', icon: ICONS.money },
      { label: 'Low Stock', value: r.lowStock, tone: 'warn', icon: ICONS.warn },
      { label: 'Out of Stock', value: r.outOfStock, tone: 'bad', icon: ICONS.warn }
    ]);
    const usageRows = Object.entries(r.usageByPart).sort((a, b) => b[1] - a[1])
      .map(([partId, qty]) => ({ label: (lookups.partsById.get(partId) || {}).name || partId, value: qty, display: String(qty) }));
    return `${stats}
      <p class="muted-note">Stock levels above are current (as of now). Movement below respects the selected date range: ${r.movementIn} units in, ${r.movementOut} units out, across ${r.txnCount} transaction${r.txnCount === 1 ? '' : 's'}.</p>
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Parts Used on Job Cards (in range)</h3>
        ${barListHtml(usageRows)}
      </div></section>`;
  }

  function renderCustomerReport(range) {
    const r = computeCustomerReport(range);
    const stats = statCardsHtml([
      { label: 'Total Customers', value: r.totalCustomers, tone: 'info', icon: ICONS.people },
      { label: 'New Customers (range)', value: r.newCustomersCount, tone: 'good', icon: ICONS.people },
      { label: 'Customers with Vehicles', value: r.customersWithVehicles, tone: 'info', icon: ICONS.box }
    ]);
    const rows = r.rows.map(c => `<tr>
      <td class="cell-main">${esc(c.name)}</td>
      <td class="num">${c.jobsInRange}</td>
      <td class="num">${money(c.paymentsInRange)}</td>
    </tr>`).join('');
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Customer Activity (in range)</h3>
        ${tableHtml([{ label: 'Customer' }, { label: 'Jobs', num: true }, { label: 'Payments', num: true }], rows, 'No customer activity in this range.')}
      </div></section>`;
  }

  function renderMechanicReport(range) {
    const lookups = buildLookups();
    const r = computeMechanicReport(range, lookups);
    const totalBilled = r.rows.reduce((s, m) => s + m.billedValue, 0);
    const totalCollected = r.rows.reduce((s, m) => s + m.collectedRevenue, 0);
    const stats = statCardsHtml([
      { label: 'Total Billed Value', value: money(totalBilled), tone: 'info', icon: ICONS.doc },
      { label: 'Total Collected Revenue', value: money(totalCollected), tone: 'good', icon: ICONS.money },
      { label: 'Unattributed Payments', value: money(r.unattributed), tone: 'neutral', icon: ICONS.warn }
    ]);
    const rows = r.rows.slice().sort((a, b) => b.collectedRevenue - a.collectedRevenue).map(m => `<tr>
      <td class="cell-main">${esc(m.name)}</td>
      <td class="num">${m.jobsAssigned}</td>
      <td class="num">${m.active}</td>
      <td class="num">${m.completed}</td>
      <td class="num">${money(m.billedValue)}</td>
      <td class="num">${money(m.collectedRevenue)}</td>
    </tr>`).join('');
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Mechanic Performance (in range)</h3>
        ${tableHtml([{ label: 'Mechanic' }, { label: 'Assigned', num: true }, { label: 'Active', num: true }, { label: 'Completed', num: true }, { label: 'Billed Value', num: true }, { label: 'Collected Revenue', num: true }], rows, 'No jobs assigned in this range.')}
      </div></section>
      <p class="muted-note">Billed Value is the total of jobs assigned in range (same basis as the Mechanics page). Collected Revenue is actual non-Void payments traced back to each mechanic through Payment \u2192 Invoice \u2192 Job Card \u2014 these are two different, complementary figures and won't necessarily match.
      ${r.unattributed > 0 ? ` ${money(r.unattributed)} in payments this range could not be traced to any mechanic (e.g. an advance with no linked Job Card).` : ''}</p>`;
  }

  function renderServiceReport(range) {
    const r = computeServiceReport(range);
    const totalRevenue = r.rows.reduce((s, x) => s + x.revenue, 0);
    const totalCount = r.rows.reduce((s, x) => s + x.count, 0);
    const stats = statCardsHtml([
      { label: 'Billed Service Value', value: money(totalRevenue), tone: 'info', icon: ICONS.money },
      { label: 'Services Performed', value: totalCount, tone: 'good', icon: ICONS.wrench }
    ]);
    const popularRows = r.rows.slice().sort((a, b) => b.count - a.count).map(s => ({ label: s.name, value: s.count, display: String(s.count) }));
    const revenueRows = r.rows.map(s => ({ label: s.name, value: s.revenue }));
    return `${stats}
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Most Popular Services (by count)</h3>
        ${barListHtml(popularRows)}
      </div></section>
      <section class="card"><div class="card__body">
        <h3 class="detail-section-title">Billed Value by Service</h3>
        ${barListHtml(revenueRows)}
      </div></section>
      <p class="muted-note">Uses each Job Card's frozen service snapshot at the time it was billed -- not the current service catalog price. This is billed value, not collected revenue (Payments are recorded per invoice, not itemized per service line), so it won't match the Revenue Report.</p>`;
  }

  const RENDERERS = {
    revenue: renderRevenueReport, expense: renderExpenseReport, net: renderNetResultReport,
    payment: renderPaymentReport, invoice: renderInvoiceReport, jobcard: renderJobCardReport,
    inventory: renderInventoryReport, customer: renderCustomerReport, mechanic: renderMechanicReport,
    service: renderServiceReport
  };
  const REPORT_TITLES = {
    revenue: 'Revenue Report', expense: 'Expense Report', net: 'Net Result',
    payment: 'Payment Report', invoice: 'Invoice Report', jobcard: 'Job Card Report',
    inventory: 'Inventory / Parts Report', customer: 'Customer Report', mechanic: 'Mechanic Report',
    service: 'Service Performance Report'
  };

  /* ============================================================
     Events + init
     ============================================================ */

  function currentRange() {
    return getRange(quickRange, customFrom, customTo);
  }

  function refresh() {
    const range = currentRange();
    document.getElementById('repRangeLabel').textContent = `${range.label} \u00b7 ${fmtDate(range.from)} \u2013 ${fmtDate(range.to)}`;
    document.getElementById('reportContent').innerHTML = RENDERERS[repType](range);
  }

  function printReport() {
    const range = currentRange();
    const settings = Storage.getSettings();
    // The print view reuses the exact same section markup the on-screen report uses.
    const bodyHtml = RENDERERS[repType](range);
    document.getElementById('printArea').innerHTML = `
      <div class="pr-head">
        <div>
          <h1>${esc(settings.businessName)}</h1>
          <p>${esc(settings.address)} \u00b7 ${esc(settings.phone)}</p>
          ${(settings.email || settings.website) ? `<p>${[settings.email, settings.website].filter(Boolean).map(x => esc(x)).join(' \u00b7 ')}</p>` : ''}
          ${settings.taxId ? `<p>Tax/VAT: ${esc(settings.taxId)}</p>` : ''}
        </div>
        <div class="pr-meta">
          <h2>${esc(REPORT_TITLES[repType].toUpperCase())}</h2>
          <p>${esc(range.label)}</p>
          <p>${fmtDate(range.from)} \u2013 ${fmtDate(range.to)}</p>
        </div>
      </div>
      ${bodyHtml}
      <p class="pr-foot">${esc(settings.invoiceFooter)}</p>`;

    document.body.classList.add('printing-report');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-report'), 300);
  }

  function syncCustomVisibility() {
    const isCustom = quickRange === 'custom';
    document.getElementById('repCustomWrap').hidden = !isCustom;
    document.getElementById('repCustomWrapTo').hidden = !isCustom;
  }

  function bindEvents() {
    document.getElementById('repType').addEventListener('change', e => { repType = e.target.value; refresh(); });
    document.getElementById('repRange').addEventListener('change', e => {
      quickRange = e.target.value;
      syncCustomVisibility();
      refresh();
    });
    document.getElementById('repFrom').addEventListener('change', e => { customFrom = e.target.value; if (quickRange === 'custom') refresh(); });
    document.getElementById('repTo').addEventListener('change', e => { customTo = e.target.value; if (quickRange === 'custom') refresh(); });
    document.getElementById('printReportBtn').addEventListener('click', printReport);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const today = Utils.todayStr();
    document.getElementById('repFrom').value = today;
    document.getElementById('repTo').value = today;
    customFrom = today;
    customTo = today;
    bindEvents();
    syncCustomVisibility();
    refresh();
  });

})();
