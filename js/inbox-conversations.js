/* ============================================================
   inbox-conversations.js — Social Inbox › All Conversations
   ------------------------------------------------------------
   Loaded only by pages/inbox-conversations.html. One list of customer
   conversations across every channel, newest first, each row tagged with
   its platform. Every row comes from the workshop database through the
   channel's own existing route -- nothing here is invented:

     Facebook   GET /api/messenger/conversations   (FBC-…)
     WhatsApp   GET /api/whatsapp/conversations    (WAC-…)
     Website    GET /api/website-forms             (WEB-…, enquiries)
     Bookings   GET /api/bookings                  (BKG-…, booking requests;
                read only with the bookings.view permission)

   A row opens the conversation in its own inbox, where it is read and
   answered with that channel's existing reply system:
     inbox-facebook.html?c=FBC-…   inbox-whatsapp.html?c=WAC-…
     inbox-website-forms.html?id=WEB-…   inbox-bookings.html?id=BKG-…

   ---- merging three lists ----
   Each route already returns its own rows newest first. They are read as
   separate "feeds" (Website's Resolved is two feeds: Confirmed and
   Rejected, because its route takes one status at a time; a Bookings
   status filter likewise becomes one feed per booking status). A row is
   shown only when it is newer than the oldest loaded row of every feed
   that still has more to load -- so "Load more" can never slip an older
   conversation above one already shown. Ids are unique per channel and
   rows are de-duplicated by channel + id when a page is appended. The
   same customer on two channels stays two conversations.

   ---- what is not invented ----
   Website enquiries and bookings have no unread count: none is shown (a
   New one is labelled New instead). A row without a time sorts last and
   shows none. The status filter is mapped onto each one's own statuses,
   and each row still shows its real status:
                 Website enquiry           Booking
     Unread      New                       New
     Open        New                       New, Pending, Confirmed, Rescheduled
     Pending     Contacted                 Pending, Rescheduled
     Resolved    Confirmed, Rejected       Completed, Cancelled, Rejected
   (A Confirmed booking is not Resolved: the service may not be done yet.)
   A website enquiry (WEB-) and a booking (BKG-) are different records, kept
   apart even for the same customer; nothing is merged.

   ---- failures ----
   One channel failing never hides the others: it gets its own note with
   Retry. Only when every channel failed is the whole list an error.
   Online only, like the rest of the Social Inbox: offline or without the
   workshop database it says so and lists nothing. Everything from the
   data is escaped (Utils.esc).
   ============================================================ */

const InboxConversations = (() => {

  const PAGE_SIZE = 50;

  /** Every channel this page reads, its route and its own inbox page. */
  const CHANNELS = [
    { key: 'Facebook', connected: true, path: '/messenger/conversations', href: 'inbox-facebook.html' },
    { key: 'WhatsApp', connected: true, path: '/whatsapp/conversations', href: 'inbox-whatsapp.html' },
    { key: 'Website', connected: true, path: '/website-forms', href: 'inbox-website-forms.html' },
    { key: 'Bookings', connected: true, path: '/bookings', href: 'inbox-bookings.html', permission: 'bookings.view' },
  ];

  /** The unified status filter -> Website's own statuses (null = no status filter). */
  const WEBSITE_STATUS = { '': [null], unread: ['New'], Open: ['New'], Pending: ['Contacted'], Resolved: ['Confirmed', 'Rejected'] };
  /** The unified status filter -> the booking statuses (the owner's decision). */
  const BOOKING_STATUS = {
    '': [null], unread: ['New'], Open: ['New', 'Pending', 'Confirmed', 'Rescheduled'],
    Pending: ['Pending', 'Rescheduled'], Resolved: ['Completed', 'Cancelled', 'Rejected'],
  };
  const WEBSITE_TYPE = { booking: 'Booking request', quote: 'Quote request', contact: 'Contact message' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** A Messenger conversation as an All Conversations row. */
  function fromMessenger(c) {
    return {
      platform: 'Facebook', id: c.id, name: c.customerName, phone: '', preview: c.lastMessage, outbound: c.lastDirection === 'out',
      at: c.lastMessageAt || c.createdAt, unread: c.unreadCount || 0, status: c.status,
      href: `inbox-facebook.html?c=${encodeURIComponent(c.id)}`,
    };
  }

  /** A WhatsApp conversation as a row (the route's shape is the Messenger one, plus a phone). */
  function fromWhatsApp(c) {
    return {
      platform: 'WhatsApp', id: c.id, name: c.customerName, phone: c.customerPhone || '', preview: c.lastMessage,
      outbound: c.lastDirection === 'out', at: c.lastMessageAt || c.createdAt, unread: c.unreadCount || 0, status: c.status,
      href: `inbox-whatsapp.html?c=${encodeURIComponent(c.id)}`,
    };
  }

  /** A website enquiry as a row. No unread count exists for one, so none is given. */
  function fromWebsite(f) {
    const kind = WEBSITE_TYPE[f.formType] || 'Website enquiry';
    return {
      platform: 'Website', id: f.id, name: f.name, phone: f.phone || '',
      preview: f.message || [kind, f.service, f.vehicle].filter(Boolean).join(' · '),
      outbound: false, at: f.submittedAt || f.createdAt, unread: 0, isNew: f.status === 'New', status: f.status,
      href: `inbox-website-forms.html?id=${encodeURIComponent(f.id)}`,
    };
  }

  /** "12 Nov, 10:00" for a booking's requested day and time ('' if unreadable). */
  function bookingWhen(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
    const [y, m, d] = date.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    return /^\d{2}:\d{2}$/.test(time || '') ? `${day}, ${time}` : day;
  }

  /** A booking request as a row: when it is for, what, and where it came from. No unread count exists. */
  function fromBooking(b) {
    const vehicle = [b.vehicleMake, b.vehicleModel].filter(Boolean).join(' ');
    const when = bookingWhen(b.preferredDate, b.preferredTime);
    return {
      platform: 'Bookings', id: b.id, name: b.customerName, phone: b.phone || '',
      preview: [when ? `For ${when}` : '', b.serviceLabel, vehicle, b.source ? `via ${b.source}` : ''].filter(Boolean).join(' · '),
      outbound: false, at: b.createdAt, unread: 0, isNew: b.status === 'New', status: b.status,
      href: `inbox-bookings.html?id=${encodeURIComponent(b.id)}`,
    };
  }

  /** Milliseconds for sorting; a missing or unreadable time is the oldest, never "now". */
  const timeOf = (r) => { const t = Date.parse(r && r.at); return Number.isFinite(t) ? t : -Infinity; };

  /** Newest first, whatever channel each row came from; one row per channel + id. */
  function mergeRows(...lists) {
    const seen = new Set();
    return lists.flat().filter((r) => {
      const key = `${r.platform || ''}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (timeOf(b) - timeOf(a)) || String(b.id).localeCompare(String(a.id)));
  }

  /** Query parameters for the Messenger and WhatsApp lists (the same parameters). */
  function messengerQuery({ q = '', status = '', offset = 0, limit = PAGE_SIZE } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (status === 'unread') out.unread = '1';
    else if (status) out.status = status;
    return out;
  }

  /** Query parameters for one Website feed (`formStatus` is one of its own statuses, or null). */
  function websiteQuery({ q = '', formStatus = null, offset = 0, limit = PAGE_SIZE } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (formStatus) out.status = formStatus;
    return out;
  }

  /**
   * The feeds to read for a channel filter and a status filter. `allowed`
   * says whether the caller may read a permission-gated channel (Bookings):
   * one it may not is not asked for at all.
   */
  function feedsFor(channel, status, allowed = () => true) {
    const feeds = [];
    for (const c of CHANNELS) {
      if (channel !== 'all' && channel !== c.key) continue;
      if (c.permission && !allowed(c.permission)) continue;
      const own = c.key === 'Website' ? WEBSITE_STATUS : c.key === 'Bookings' ? BOOKING_STATUS : null;
      if (own) {
        for (const formStatus of own[status] || [null]) feeds.push({ channel: c.key, path: c.path, formStatus });
      } else {
        feeds.push({ channel: c.key, path: c.path, formStatus: null });
      }
    }
    return feeds;
  }

  /**
   * What may be shown now: every loaded row newer than (or as new as) the
   * oldest loaded row of each feed that still has more to load. Feeds that
   * failed or are finished set no limit.
   */
  function visibleRows(feeds) {
    const all = mergeRows(...feeds.map((f) => f.rows || []));
    let limit = -Infinity;
    for (const f of feeds) {
      if (f.error || !f.rows || !f.rows.length || f.rows.length >= f.total) continue;
      const oldest = Math.min(...f.rows.map(timeOf));
      if (oldest > limit) limit = oldest;
    }
    return all.filter((r) => timeOf(r) >= limit);
  }

  function timeLabel(iso, now = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (day(d) === day(now)) return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
  }

  function rowHtml(r) {
    const esc = Utils.esc;
    const flag = r.unread
      ? `<span class="inb-badge" aria-label="${r.unread} unread">${r.unread > 99 ? '99+' : r.unread}</span>`
      : (r.isNew ? '<span class="inb-badge inb-badge--new" aria-label="New enquiry">New</span>' : '');
    return `<li><a class="inb-row${r.unread || r.isNew ? ' is-unread' : ''}" href="${esc(r.href)}">
        <span class="inb-plat inb-plat--${esc(r.platform.toLowerCase())}" title="${esc(r.platform)}">${esc(r.platform)}</span>
        <span class="inb-row__body">
          <span class="inb-row__top"><span class="inb-row__name">${esc(r.name)}${r.phone && r.phone !== r.name ? `<span class="inb-row__phone">${esc(r.phone)}</span>` : ''}</span><time class="inb-row__time">${esc(timeLabel(r.at))}</time></span>
          <span class="inb-row__bottom"><span class="inb-row__preview">${r.outbound ? 'You: ' : ''}${esc(r.preview)}</span>
            ${flag}
            <span class="inb-status inb-status--${esc(String(r.status).toLowerCase())}">${esc(r.status)}</span></span>
        </span>
      </a></li>`;
  }

  /* ---------- page ---------- */

  const MAP = { Facebook: fromMessenger, WhatsApp: fromWhatsApp, Website: fromWebsite, Bookings: fromBooking };
  /** May the signed-in caller read this? (The server checks again; this only avoids asking.) */
  const allowed = (perm) => typeof Storage.can !== 'function' || Storage.can(perm);
  const state = { channel: 'all', q: '', status: '', feeds: [], rows: [], total: 0, error: null, loading: false };
  let seq = 0, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  /** One feed's next page, through the existing route. */
  async function fetchFeed(feed, offset) {
    const query = feed.channel === 'Website' || feed.channel === 'Bookings'
      ? websiteQuery({ q: state.q, formStatus: feed.formStatus, offset })
      : messengerQuery({ q: state.q, status: state.status, offset });
    return Api.get(`${feed.path}?${new URLSearchParams(query).toString()}`);
  }

  /** The per-channel notes: a channel that failed, or one not set up to receive messages. */
  function renderNotes() {
    const notes = [];
    for (const c of CHANNELS) {
      const feeds = state.feeds.filter((f) => f.channel === c.key);
      if (!feeds.length) continue;
      const failed = feeds.find((f) => f.error);
      if (failed) {
        // Only reached when some other channel answered (all failing is the page's own error).
        const denied = failed.error.status === 403;
        const what = c.key === 'Bookings' ? 'Booking requests' : `${c.key} conversations`;
        notes.push(`<p class="inb-note inb-note--bad" role="note"><strong>${esc(what)} could not be loaded.</strong>
          ${denied ? 'Your role does not include them.' : 'The other channels are still shown.'}
          ${denied ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>'}</p>`);
      } else if ((c.key === 'Facebook' || c.key === 'WhatsApp') && feeds[0].connection && feeds[0].connection.webhook === false) {
        notes.push(`<p class="inb-note" role="note"><strong>${esc(c.key)} is not set up to receive new messages yet.</strong>
          Conversations already received are shown. <a href="${esc(c.href)}">Open the ${esc(c.key)} inbox</a>.</p>`);
      }
    }
    $('inbNotes').innerHTML = notes.join('');
  }

  function renderCounts() {
    for (const c of CHANNELS) {
      const el = $(`inbCount${c.key}`);
      if (!el) continue;
      const feed = state.feeds.find((f) => f.channel === c.key && f.summary);
      if (!feed) continue;   // keep the last known count while that channel is filtered out
      const fresh = c.key === 'Website' || c.key === 'Bookings';
      const n = fresh ? feed.summary.new : feed.summary.unreadConversations;
      el.textContent = n ? String(n) : '';
      el.title = !n ? '' : c.key === 'Website' ? `${n} new enquir${n === 1 ? 'y' : 'ies'}`
        : c.key === 'Bookings' ? `${n} new booking${n === 1 ? '' : 's'}` : `${n} unread conversation${n === 1 ? '' : 's'}`;
    }
  }

  function render() {
    const box = $('inbState');
    if (state.loading && !state.rows.length) {
      $('inbNotes').innerHTML = '';
      box.innerHTML = '<div class="inb-skel"><span></span><span></span><span></span></div>';
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    renderNotes();
    renderCounts();
    if (state.error) {
      $('inbNotes').innerHTML = '';   // the page-level error below says it all
      const local = state.error.code === 'no_api' || state.error.code === 'locked';
      const offline = state.error.code === 'offline';
      box.innerHTML = `<div class="inb-box inb-box--bad"><strong>${offline ? 'Conversations need the internet' : local ? 'The workshop database is not connected' : 'The conversations could not be loaded'}</strong>
          <p>${offline ? 'Messages are kept only in the workshop database. Connect to the internet to see them; nothing stored on this computer is shown in their place.'
            : local ? 'Conversations are kept only in the workshop database. Nothing stored in this browser is shown in their place.'
            : 'None of the channels answered, so no conversations are shown.'}</p>
          ${local || offline ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>'}</div>`;
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    if (!state.rows.length) {
      const filtered = state.q || state.status || state.channel !== 'all';
      box.innerHTML = `<div class="inb-box"><strong>${filtered ? 'No conversations match' : 'No conversations yet'}</strong>
          <p>${filtered ? 'Try a different channel, search or status.' : 'When a customer messages the Facebook Page or WhatsApp, sends a website enquiry or makes a booking request, it appears here.'}</p></div>`;
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    box.innerHTML = '';
    $('inbList').innerHTML = state.rows.map(rowHtml).join('');
    $('inbList').hidden = false;
    $('inbFoot').hidden = false;
    $('inbCount').textContent = `${state.rows.length} of ${state.total} conversation${state.total === 1 ? '' : 's'}`;
    $('inbMore').hidden = !state.feeds.some((f) => !f.error && f.rows.length < f.total);
  }

  function settle() {
    state.rows = visibleRows(state.feeds);
    state.total = state.feeds.reduce((n, f) => n + (f.error ? 0 : (f.total || 0)), 0);
  }

  /** Read every feed for the current filters; `append` reads the next page of those with more. */
  async function load({ append = false } = {}) {
    if (!Storage.isApi()) {
      const code = Storage.isOffline && Storage.isOffline() ? 'offline' : (Storage.isLocked() ? 'locked' : 'no_api');
      state.error = { code }; state.loading = false; state.feeds = []; state.rows = []; render(); return false;
    }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!append) { state.feeds = feedsFor(state.channel, state.status, allowed).map((f) => ({ ...f, rows: [], total: 0, error: null })); state.rows = []; render(); }
    const work = state.feeds.filter((f) => !append || (!f.error && f.rows.length < f.total));
    const results = await Promise.all(work.map((f) => fetchFeed(f, append ? f.rows.length : 0)));
    if (my !== seq) return false;
    work.forEach((f, i) => {
      const res = results[i];
      if (!res || !res.ok) { f.error = res || { code: 'network' }; return; }
      const mapped = (Array.isArray(res.data) ? res.data : []).map(MAP[f.channel]);
      f.rows = append ? mergeRows(f.rows, mapped) : mergeRows(mapped);
      f.total = (res.meta && res.meta.total) || 0;
      f.summary = (res.meta && res.meta.summary) || null;
      f.connection = (res.meta && res.meta.connection) || null;
      f.error = null;
    });
    state.loading = false;
    if (state.feeds.length && state.feeds.every((f) => f.error)) {
      state.error = state.feeds[0].error; state.rows = []; render(); return false;
    }
    settle();
    render();
    return true;
  }

  function bind() {
    document.querySelectorAll('.inb-chip').forEach((chip) => chip.addEventListener('click', () => {
      state.channel = chip.dataset.channel;
      document.querySelectorAll('.inb-chip').forEach((c) => {
        c.classList.toggle('is-active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      });
      load();
    }));
    $('inbSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('inbSearch').value; load(); }, 300);
    });
    $('inbStatus').addEventListener('change', () => { state.status = $('inbStatus').value; load(); });
    $('inbMore').addEventListener('click', () => load({ append: true }));
    for (const id of ['inbState', 'inbNotes']) {
      $(id).addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('[data-retry]')) load(); });
    }
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-conversations') return;
    bind();
    // A channel the role may not read has no chip (the server would refuse it anyway).
    Storage.ready(() => {
      for (const c of CHANNELS) {
        if (!c.permission || allowed(c.permission)) continue;
        const chip = document.querySelector && document.querySelector(`.inb-chip[data-channel="${c.key}"]`);
        if (chip) chip.hidden = true;
      }
    });
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return {
    CHANNELS, fromMessenger, fromWhatsApp, fromWebsite, fromBooking, bookingWhen, mergeRows, messengerQuery, websiteQuery, feedsFor, visibleRows,
    rowHtml, init, _state: state, load,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxConversations };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxConversations.init();
