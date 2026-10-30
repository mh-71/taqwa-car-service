/* ============================================================
   inbox-conversations.js — Social Inbox › All Conversations
   ------------------------------------------------------------
   Loaded only by pages/inbox-conversations.html. One list of customer
   conversations across channels, each row tagged with its platform.

   Connected today:   Facebook  -- GET /api/messenger/conversations
   Not connected:     WhatsApp, Website -- the page says so and lists
                      nothing for them. No sample conversation is ever
                      shown as if it were real.

   A Facebook row opens the Facebook Messenger inbox on that conversation
   (pages/inbox-facebook.html?c=FBC-0001), where it can be read and
   answered. When the database cannot be read the page says so and offers
   Retry. Everything from the data is escaped (Utils.esc).
   ============================================================ */

const InboxConversations = (() => {

  const PAGE_SIZE = 50;

  /** Every channel this page knows, and whether it is connected to real data. */
  const CHANNELS = [
    { key: 'Facebook', connected: true, href: 'inbox-facebook.html' },
    { key: 'WhatsApp', connected: false, href: 'inbox-whatsapp.html' },
    { key: 'Website', connected: false, href: 'inbox-website-forms.html' },
  ];

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** A Messenger conversation as an All Conversations row. */
  function fromMessenger(c) {
    return {
      platform: 'Facebook', id: c.id, name: c.customerName, preview: c.lastMessage, outbound: c.lastDirection === 'out',
      at: c.lastMessageAt || c.createdAt, unread: c.unreadCount || 0, status: c.status,
      href: `inbox-facebook.html?c=${encodeURIComponent(c.id)}`,
    };
  }

  /** Newest first, whatever channel each row came from. */
  function mergeRows(...lists) {
    return lists.flat().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || String(b.id).localeCompare(String(a.id)));
  }

  /** Query parameters for the Messenger list. */
  function messengerQuery({ q = '', status = '', offset = 0, limit = PAGE_SIZE } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (status === 'unread') out.unread = '1';
    else if (status) out.status = status;
    return out;
  }

  function timeLabel(iso, now = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (day(d) === day(now)) return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
  }

  function rowHtml(r) {
    const esc = Utils.esc;
    return `<li><a class="inb-row${r.unread ? ' is-unread' : ''}" href="${esc(r.href)}">
        <span class="inb-plat inb-plat--${esc(r.platform.toLowerCase())}" title="${esc(r.platform)}">${esc(r.platform)}</span>
        <span class="inb-row__body">
          <span class="inb-row__top"><span class="inb-row__name">${esc(r.name)}</span><time class="inb-row__time">${esc(timeLabel(r.at))}</time></span>
          <span class="inb-row__bottom"><span class="inb-row__preview">${r.outbound ? 'You: ' : ''}${esc(r.preview)}</span>
            ${r.unread ? `<span class="inb-badge" aria-label="${r.unread} unread">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}
            <span class="inb-status inb-status--${esc(String(r.status).toLowerCase())}">${esc(r.status)}</span></span>
        </span>
      </a></li>`;
  }

  /* ---------- page ---------- */

  const state = { channel: 'all', q: '', status: '', rows: [], total: 0, error: null, loading: false };
  let seq = 0, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  function renderNotes() {
    const off = CHANNELS.filter((c) => !c.connected && (state.channel === 'all' || state.channel === c.key));
    $('inbNotes').innerHTML = off.map((c) => `<p class="inb-note" role="note"><strong>${esc(c.key)} is not connected yet.</strong>
        No ${esc(c.key)} conversations are shown here. <a href="${esc(c.href)}">Open the ${esc(c.key)} page</a> (demo only).</p>`).join('');
  }

  function render() {
    renderNotes();
    const box = $('inbState');
    const showFacebook = state.channel === 'all' || state.channel === 'Facebook';
    if (!showFacebook) { box.innerHTML = ''; $('inbList').hidden = true; $('inbFoot').hidden = true; return; }
    if (state.loading && !state.rows.length) {
      box.innerHTML = '<div class="inb-skel"><span></span><span></span><span></span></div>';
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    if (state.error) {
      const local = state.error.code === 'no_api' || state.error.code === 'locked';
      box.innerHTML = `<div class="inb-box inb-box--bad"><strong>${local ? 'The workshop database is not connected' : 'The conversations could not be loaded'}</strong>
          <p>${local ? 'Conversations are kept only in the workshop database. Nothing stored in this browser is shown in their place.' : 'The workshop database did not answer, so no conversations are shown.'}</p>
          ${local ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>'}</div>`;
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    if (!state.rows.length) {
      box.innerHTML = `<div class="inb-box"><strong>${state.q || state.status ? 'No conversations match' : 'No conversations yet'}</strong>
          <p>${state.q || state.status ? 'Try a different search or status.' : 'When a customer messages the Facebook Page, the conversation appears here.'}</p></div>`;
      $('inbList').hidden = true; $('inbFoot').hidden = true; return;
    }
    box.innerHTML = '';
    $('inbList').innerHTML = state.rows.map(rowHtml).join('');
    $('inbList').hidden = false;
    $('inbFoot').hidden = false;
    $('inbCount').textContent = `${state.rows.length} of ${state.total} conversation${state.total === 1 ? '' : 's'}`;
    $('inbMore').hidden = state.rows.length >= state.total;
  }

  async function load({ append = false } = {}) {
    if (!Storage.isApi()) { state.error = { code: Storage.isLocked() ? 'locked' : 'no_api' }; state.loading = false; render(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!append) render();
    const qs = new URLSearchParams(messengerQuery({ q: state.q, status: state.status, offset: append ? state.rows.length : 0 })).toString();
    const res = await Api.get(`/messenger/conversations?${qs}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.error = res; state.rows = []; render(); return false; }
    const rows = (Array.isArray(res.data) ? res.data : []).map(fromMessenger);
    state.rows = append ? mergeRows(state.rows, rows) : mergeRows(rows);
    state.total = res.meta.total || 0;
    const unread = res.meta.summary ? res.meta.summary.unreadConversations : 0;
    $('inbCountFacebook').textContent = unread ? String(unread) : '';
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
      render();
    }));
    $('inbSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('inbSearch').value; load(); }, 300);
    });
    $('inbStatus').addEventListener('change', () => { state.status = $('inbStatus').value; load(); });
    $('inbMore').addEventListener('click', () => load({ append: true }));
    $('inbState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry]')) load(); });
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-conversations') return;
    bind();
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return { CHANNELS, fromMessenger, mergeRows, messengerQuery, rowHtml, init, _state: state, load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxConversations };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxConversations.init();
