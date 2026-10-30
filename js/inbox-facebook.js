/* ============================================================
   inbox-facebook.js — Social Inbox › Facebook Messenger
   ------------------------------------------------------------
   Loaded only by pages/inbox-facebook.html. Every conversation and
   message comes from the workshop database through the Worker:

     GET  /api/messenger/conversations                the list (left)
     GET  /api/messenger/conversations/:id/messages   the thread (centre)
     POST /api/messenger/conversations/:id/reply      a reply, sent by the
                                                      Worker through Meta
     POST /api/messenger/conversations/:id/read       opened -> read
     PUT  /api/messenger/conversations/:id/status     details (right)

   The Page token never reaches this page: the Worker holds it. A reply
   shows "Sending…" until the Worker answers, then "Sent" -- or "Not sent"
   with Facebook's reason and a Retry. A reply is never shown as sent when
   Meta refused it. Each attempt carries its own clientRequestId, so a
   request the network retries is not delivered twice.

   New messages arrive through Meta's webhook; this page re-reads the list
   (and the open thread) every POLL_MS while it is visible.

   When the database cannot be read the page says so and offers Retry. It
   never shows sample or browser-stored messages in their place. Everything
   from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const InboxFacebook = (() => {

  const POLL_MS = 15000;
  const PAGE_SIZE = 50;
  const MAX_REPLY = 2000;

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Query string parameters for the list. */
  function buildListQuery({ q = '', filter = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (filter === 'unread') out.unread = '1';
    else if (filter) out.status = filter;
    return out;
  }

  /** A fresh id for one send attempt: letters, digits and hyphens, 8-64 long. */
  function newRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /** "14:05" today, "Yesterday", or "12 Oct" -- in the workshop's zone. */
  function timeLabel(iso, now = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (day(d) === day(now)) return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
    if (day(d) === day(new Date(now.getTime() - 86400000))) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
  }

  function fullTime(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  /** What the reply window says for a conversation. */
  function windowText(conv, now = Date.now()) {
    if (!conv || !conv.replyWindowEndsAt) return 'Closed: the customer has not written yet';
    const left = Date.parse(conv.replyWindowEndsAt) - now;
    if (left <= 0) return 'Closed: more than 24 hours since the customer last wrote';
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    return `Open for ${h ? `${h} h ` : ''}${m} min more`;
  }

  const STATUS_LABEL = { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', read: 'Seen', failed: 'Not sent', received: '' };

  /** One message bubble. `m.localState` marks a reply this page is still sending. */
  function bubbleHtml(m) {
    const esc = Utils.esc;
    const out = m.direction === 'out';
    const atts = (m.attachments || []).map((a) => {
      const label = a.type === 'image' ? 'Photo' : a.type === 'postback' ? `Button: ${a.title || ''}` : a.type ? a.type[0].toUpperCase() + a.type.slice(1) : 'Attachment';
      return a.url
        ? `<a class="fb-att" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(label)} &#8599;</a>`
        : `<span class="fb-att">${esc(label)}</span>`;
    }).join('');
    const who = out ? (m.senderType === 'page' ? 'Facebook Page' : (m.sentBy || 'Staff')) : '';
    const state = out ? `<span class="fb-msg__state fb-msg__state--${esc(m.status)}">${esc(STATUS_LABEL[m.status] || m.status)}</span>` : '';
    const failed = m.status === 'failed'
      ? `<div class="fb-msg__error" role="alert">${esc(m.error || 'Facebook did not accept this message.')}
          ${m.retryText || m.senderType === 'staff' ? `<button type="button" class="fb-retry" data-retry="${esc(m.id)}">Retry</button>` : ''}</div>` : '';
    return `<li class="fb-msg fb-msg--${out ? 'out' : 'in'}${m.status === 'failed' ? ' fb-msg--failed' : ''}" data-id="${esc(m.id)}">
        <div class="fb-msg__bubble">${m.text ? `<p>${esc(m.text)}</p>` : ''}${atts}</div>
        <div class="fb-msg__meta">${who ? `<span>${esc(who)}</span> · ` : ''}<time datetime="${esc(m.createdAt)}" title="${esc(fullTime(m.createdAt))}">${esc(timeLabel(m.createdAt))}</time>${state ? ` · ${state}` : ''}</div>
        ${failed}
      </li>`;
  }

  function rowHtml(c, selectedId) {
    const esc = Utils.esc;
    const unread = c.unreadCount > 0;
    return `<li><button type="button" class="fb-row${c.id === selectedId ? ' is-active' : ''}${unread ? ' is-unread' : ''}" data-id="${esc(c.id)}"${c.id === selectedId ? ' aria-current="true"' : ''}>
        <span class="fb-avatar" aria-hidden="true">${esc(initials(c.customerName))}</span>
        <span class="fb-row__body">
          <span class="fb-row__top"><span class="fb-row__name">${esc(c.customerName)}</span><time class="fb-row__time">${esc(timeLabel(c.lastMessageAt))}</time></span>
          <span class="fb-row__bottom"><span class="fb-row__preview">${c.lastDirection === 'out' ? 'You: ' : ''}${esc(c.lastMessage)}</span>
            ${unread ? `<span class="fb-badge" aria-label="${c.unreadCount} unread">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : ''}
            ${c.status !== 'Open' ? `<span class="fb-st fb-st--${esc(c.status.toLowerCase())}">${esc(c.status)}</span>` : ''}</span>
        </span>
      </button></li>`;
  }

  /* ---------- page state ---------- */

  const state = {
    q: '', filter: '', offset: 0, conversations: [], total: 0, summary: null, connection: null,
    selectedId: null, selected: null, messages: [], hasMore: false, nextBefore: null,
    pending: [], listError: null, loadingList: false, sending: false,
  };
  let listSeq = 0, threadSeq = 0, pollTimer = null, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  const stateBox = (title, text, retry) => `<div class="fb-state__box">
      <strong>${esc(title)}</strong><p>${esc(text)}</p>
      ${retry ? `<button type="button" class="btn btn--ghost btn--sm" data-retry-list>${esc(retry)}</button>` : ''}</div>`;

  function failureText(res) {
    if (res.code === 'no_api') return ['The workshop database is not connected', 'Messenger conversations are kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in their place.', ''];
    if (res.code === 'unauthorized' || res.code === 'locked') return ['Your session has ended', 'Sign in again to see the inbox.', ''];
    return ['The conversations could not be loaded', 'The workshop database did not answer, so no conversations are shown. Try again in a moment.', 'Retry'];
  }

  /* ---------- the connection chip ---------- */

  function renderConnection() {
    const c = state.connection;
    const chip = $('fbConn');
    if (!c) { chip.dataset.state = 'unknown'; $('fbConnText').textContent = 'Connection unknown'; return; }
    const live = c.send && c.webhook;
    chip.dataset.state = live ? 'live' : c.webhook ? 'partial' : 'off';
    $('fbConnText').textContent = live ? 'Connected to the Facebook Page'
      : c.webhook ? 'Receiving only: replies are not set up'
        : 'Facebook Page not connected yet';
  }

  /* ---------- the list ---------- */

  function renderList() {
    const box = $('fbListState');
    if (state.loadingList && !state.conversations.length) {
      box.innerHTML = '<div class="fb-skel"><span></span><span></span><span></span><span></span></div>';
      $('fbList').hidden = true; return;
    }
    if (state.listError) {
      const [t, x, r] = failureText(state.listError);
      box.innerHTML = stateBox(t, x, r);
      $('fbList').hidden = true; $('fbListMore').hidden = true; return;
    }
    if (!state.conversations.length) {
      box.innerHTML = state.q || state.filter
        ? stateBox('No conversations match', 'Try a different search or filter.', '')
        : stateBox('No messages yet', state.connection && state.connection.webhook
          ? 'When a customer messages the Facebook Page, the conversation appears here.'
          : 'The Facebook Page is not connected yet. Once the webhook is set up, customer messages appear here.', '');
      $('fbList').hidden = true; $('fbListMore').hidden = true; return;
    }
    box.innerHTML = '';
    $('fbList').innerHTML = state.conversations.map((c) => rowHtml(c, state.selectedId)).join('');
    $('fbList').hidden = false;
    $('fbListMore').hidden = state.conversations.length >= state.total;
    const unread = state.summary ? state.summary.unreadConversations : 0;
    $('fbUnreadTotal').hidden = !unread;
    $('fbUnreadTotal').textContent = unread ? `${unread} unread` : '';
  }

  async function loadList({ append = false, quiet = false } = {}) {
    if (!Storage.isApi()) {
      state.listError = { code: Storage.isLocked() ? 'locked' : 'no_api' };
      state.loadingList = false;
      renderList(); return false;
    }
    const seq = ++listSeq;
    const offset = append ? state.conversations.length : 0;
    // A quiet refresh re-reads everything shown so far, so polling never shrinks the list.
    const limit = quiet ? Math.max(PAGE_SIZE, state.conversations.length) : PAGE_SIZE;
    if (!quiet) { state.loadingList = true; if (!append) renderList(); }
    const qs = new URLSearchParams(buildListQuery({ q: state.q, filter: state.filter, limit, offset })).toString();
    const res = await Api.get(`/messenger/conversations?${qs}`);
    if (seq !== listSeq) return false;
    state.loadingList = false;
    if (!res.ok) {
      if (quiet) return false;                 // a failed background refresh keeps what is shown
      state.listError = res; state.conversations = [];
      renderList(); return false;
    }
    state.listError = null;
    const rows = Array.isArray(res.data) ? res.data : [];
    state.conversations = append ? [...state.conversations, ...rows] : rows;
    state.total = res.meta.total || 0;
    state.summary = res.meta.summary || null;
    state.connection = res.meta.connection || null;
    renderConnection();
    renderList();
    if (state.selectedId) {
      const fresh = state.conversations.find((c) => c.id === state.selectedId);
      if (fresh) { state.selected = fresh; renderChatHead(); renderWindow(); }
    }
    return true;
  }

  /* ---------- the thread ---------- */

  function renderChatHead() {
    const c = state.selected;
    if (!c) return;
    $('fbChatAvatar').textContent = initials(c.customerName);
    $('fbChatName').textContent = c.customerName;
    $('fbChatMeta').textContent = `Messenger · ${c.status}${c.assignedTo ? ` · ${c.assignedTo}` : ''}`;
  }

  function renderWindow() {
    const c = state.selected;
    const box = $('fbWindow');
    const canSend = Boolean(c && c.canReply && state.connection && state.connection.send);
    $('fbReply').disabled = !canSend;
    $('fbSend').disabled = !canSend || state.sending;
    if (!c) { box.hidden = true; return; }
    if (!(state.connection && state.connection.send)) {
      box.hidden = false; box.textContent = 'Replies are not set up yet: the Facebook Page access token has not been configured.';
    } else if (!c.canReply) {
      box.hidden = false; box.textContent = 'This customer last wrote more than 24 hours ago. Facebook only allows a reply within 24 hours of their last message, so replying is closed until they write again.';
    } else box.hidden = true;
  }

  function renderThread({ keepScroll = false } = {}) {
    const wrap = $('fbThreadWrap');
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    // A placeholder whose attempt the server has saved is shown once: as the server's row.
    const saved = new Set(state.messages.map((m) => m.clientRequestId).filter(Boolean));
    state.pending = state.pending.filter((p) => !saved.has(p.requestId));
    const all = [...state.messages, ...state.pending];
    $('fbThread').innerHTML = all.map(bubbleHtml).join('');
    $('fbOlder').hidden = !state.hasMore;
    $('fbThreadState').innerHTML = !all.length ? stateBox('No messages in this conversation yet', '', '') : '';
    if (!keepScroll || nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function renderDetails() {
    const c = state.selected;
    $('fbDetailsEmpty').hidden = Boolean(c);
    $('fbDetailsBody').hidden = !c;
    if (!c) return;
    $('fbdName').textContent = c.nameKnown ? c.customerName : 'Not shared by Facebook';
    $('fbdPsid').textContent = c.customerPsid;
    $('fbdId').textContent = c.id;
    $('fbdCreated').textContent = fullTime(c.createdAt);
    $('fbdWindow').textContent = windowText(c);
    $('fbdStatus').value = c.status;
    $('fbdAssigned').value = c.assignedTo;
    $('fbdNotes').value = c.notes;
    $('fbDetailsForm').querySelector('[data-err="details"]').textContent = '';
  }

  async function loadThread({ older = false, quiet = false } = {}) {
    const id = state.selectedId;
    if (!id) return false;
    const seq = ++threadSeq;
    if (!quiet && !older) { $('fbThreadState').innerHTML = '<div class="fb-skel fb-skel--thread"><span></span><span></span><span></span></div>'; $('fbThread').innerHTML = ''; }
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), ...(older && state.nextBefore ? { before: String(state.nextBefore) } : {}) }).toString();
    const res = await Api.get(`/messenger/conversations/${encodeURIComponent(id)}/messages?${qs}`);
    if (seq !== threadSeq || id !== state.selectedId) return false;
    if (!res.ok) {
      if (!quiet) $('fbThreadState').innerHTML = `<div class="fb-state__box"><strong>The messages could not be loaded</strong><p>${esc(res.message || '')}</p><button type="button" class="btn btn--ghost btn--sm" data-retry-thread>Retry</button></div>`;
      return false;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    if (older) {
      state.messages = [...rows, ...state.messages];
    } else if (quiet && state.messages.length) {
      // Keep any earlier pages already loaded; replace the newest page.
      const firstNew = rows.length ? rows[0].id : Infinity;
      state.messages = [...state.messages.filter((m) => m.id < firstNew), ...rows];
    } else state.messages = rows;
    if (!quiet || older) { state.hasMore = res.meta.hasMore; state.nextBefore = res.meta.nextBefore; }
    renderThread({ keepScroll: quiet || older });
    return true;
  }

  async function select(id) {
    if (!id) return;
    state.selectedId = id;
    state.selected = state.conversations.find((c) => c.id === id) || null;
    state.messages = []; state.pending = []; state.hasMore = false; state.nextBefore = null;
    $('fbInbox').classList.add('is-chat-open');
    $('fbChatEmpty').hidden = true;
    $('fbChat').hidden = false;
    try { history.replaceState(null, '', `?c=${encodeURIComponent(id)}`); } catch { /* not in a browser */ }
    if (!state.selected) {
      const one = await Api.get(`/messenger/conversations/${encodeURIComponent(id)}`);
      if (!one.ok) { Utils.toast(one.message || 'That conversation could not be opened.', 'error'); return; }
      state.selected = one.data;
    }
    renderChatHead(); renderWindow(); renderDetails(); renderList();
    await loadThread();
    if (state.selected && state.selected.unreadCount > 0) {
      const r = await Api.post(`/messenger/conversations/${encodeURIComponent(id)}/read`, {});
      if (r.ok) {
        state.selected = r.data;
        const row = state.conversations.find((c) => c.id === id);
        if (row) row.unreadCount = 0;
        if (state.summary && state.summary.unreadConversations) state.summary.unreadConversations -= 1;
        renderList();
      }
    }
  }

  /* ---------- sending ---------- */

  async function send(text, retryOf = null) {
    const id = state.selectedId;
    const body = String(text || '').trim();
    if (!id || !body) return;
    if (body.length > MAX_REPLY) { Utils.toast(`A Messenger message can be at most ${MAX_REPLY} characters.`, 'error'); return; }
    const requestId = newRequestId();
    const local = { id: `local-${Date.now()}`, requestId, direction: 'out', senderType: 'staff', sentBy: Storage.account ? Storage.account.username : '',
      text: body, attachments: [], status: 'sending', createdAt: new Date().toISOString(), localState: true };
    if (retryOf) state.pending = state.pending.filter((p) => p.id !== retryOf);
    state.pending.push(local);
    state.sending = true;
    renderThread(); renderWindow();
    const res = await Api.post(`/messenger/conversations/${encodeURIComponent(id)}/reply`, { text: body, clientRequestId: requestId });
    state.sending = false;
    if (id !== state.selectedId) return;
    if (!res.ok) {
      // Not sent: until the server's own copy (saved as failed) replaces it, the
      // placeholder says so, with the reason and a Retry. The text is kept.
      local.status = 'failed';
      local.error = res.message || 'The message was not sent.';
      local.retryText = body;
      if (res.errorReason === 'outside_messaging_window' && state.selected) state.selected.canReply = false;
      Utils.toast(local.error, 'error');
    }
    // Whatever happened, the server's history is the truth: re-read it. A saved
    // attempt replaces its placeholder; one that never reached the server stays.
    await loadThread({ quiet: true });
    if (res.ok) await loadList({ quiet: true });
    renderWindow();
  }

  /* ---------- details ---------- */

  async function saveDetails(btn) {
    const c = state.selected;
    if (!c) return;
    await Utils.guard(btn, async () => {
      const body = { status: $('fbdStatus').value, assignedTo: $('fbdAssigned').value.trim(), notes: $('fbdNotes').value.trim() };
      const res = await Api.put(`/messenger/conversations/${encodeURIComponent(c.id)}/status`, body);
      if (!res.ok) {
        const msg = res.fields ? Object.values(res.fields)[0] : (res.message || 'The details could not be saved.');
        $('fbDetailsForm').querySelector('[data-err="details"]').textContent = msg;
        Utils.toast(msg, 'error'); return;
      }
      state.selected = res.data;
      const i = state.conversations.findIndex((x) => x.id === c.id);
      if (i !== -1) state.conversations[i] = res.data;
      renderChatHead(); renderDetails(); renderList();
      Utils.toast('Conversation details saved.', 'success');
    });
  }

  /* ---------- polling ---------- */

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (state.sending || !Storage.isApi()) return;
      loadList({ quiet: true });
      if (state.selectedId) loadThread({ quiet: true });
    }, POLL_MS);
  }

  /* ---------- events ---------- */

  function bind() {
    $('fbSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('fbSearch').value; loadList(); }, 300);
    });
    $('fbStatus').addEventListener('change', () => { state.filter = $('fbStatus').value; loadList(); });
    $('fbList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-id]'); if (b) select(b.dataset.id); });
    $('fbListMore').addEventListener('click', () => loadList({ append: true }));
    $('fbListState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry-list]')) loadList(); });
    $('fbThreadState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry-thread]')) loadThread(); });
    $('fbOlder').addEventListener('click', () => loadThread({ older: true }));
    $('fbThread').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-retry]');
      if (!b) return;
      // A retry is a new attempt with its own request id; the failed one stays in the history.
      const p = state.pending.find((x) => String(x.id) === b.dataset.retry);
      if (p) { send(p.retryText || p.text, p.id); return; }
      const m = state.messages.find((x) => String(x.id) === b.dataset.retry);
      if (m && m.text) send(m.text);
    });
    $('fbReply').addEventListener('input', () => { $('fbReplyCount').textContent = `${$('fbReply').value.length} / ${MAX_REPLY}`; });
    $('fbReply').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('fbComposer').requestSubmit(); }
    });
    $('fbComposer').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (state.sending) return;
      const text = $('fbReply').value;
      if (!text.trim()) return;
      $('fbReply').value = ''; $('fbReplyCount').textContent = `0 / ${MAX_REPLY}`;
      send(text);
    });
    $('fbBack').addEventListener('click', () => { $('fbInbox').classList.remove('is-chat-open', 'is-details-open'); });
    $('fbInfoBtn').addEventListener('click', () => {
      const open = $('fbInbox').classList.toggle('is-details-open');
      $('fbInfoBtn').setAttribute('aria-expanded', String(open));
    });
    $('fbDetailsForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveDetails($('fbdSave')); });
  }

  async function init() {
    if (document.body.dataset.page !== 'inbox-facebook') return;
    bind();
    state.loadingList = true;
    renderList();
    Storage.ready(async () => {
      const loaded = await loadList();
      const wanted = new URLSearchParams(location.search || '').get('c');
      if (loaded && wanted && /^FBC-\d+$/.test(wanted)) select(wanted);
      if (loaded) startPolling();
    });
  }

  return { buildListQuery, newRequestId, initials, timeLabel, windowText, bubbleHtml, rowHtml, init, _state: state, loadList, select, send };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxFacebook };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxFacebook.init();
