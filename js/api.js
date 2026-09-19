/* ============================================================
   api.js — the one place the browser talks to the Worker API
   ------------------------------------------------------------
   storage.js calls this; UI modules never do. Everything about
   HTTP lives here: where the API is, how a request is
   authenticated, and how a failure becomes something the UI can
   show.

   ---- where the API is ----

   One base URL, resolved once, in this order:

     1. window.TAQWA_API_BASE            (explicit override)
     2. <meta name="taqwa-api-base">     (per-deployment, no JS)
     3. same origin + /api               (the normal case)
     4. null on file:// -- a page opened from disk has no origin
        to call, so the app stays on localStorage rather than
        firing requests that cannot succeed.

   Same origin is the default on purpose: it needs no CORS on the
   Worker and no origin allow-list to keep in step. `npm run
   dev:app` serves this folder and proxies /api to `wrangler dev`
   for exactly that reason.

   ---- authentication ----

   C-9 protects every mutation with `Authorization: Bearer
   <API_TOKEN>` and leaves GET public. That token is a SERVER
   credential: it authorises every write on every record, and this
   frontend is a static site with nowhere to keep a secret.

   So nothing here ships a token, reads one from the repository, or
   puts one in localStorage or sessionStorage. A token can only
   arrive at runtime, through Api.configure({ token }), and it
   lives in a closure variable for that page's lifetime only -- a
   reload clears it. Reads never carry it. Until one is supplied,
   writes are refused HERE, with a message, rather than sent
   unauthenticated for the server to reject.

   This is a development posture, not a production one. A deployed
   multi-user install needs an identity the browser is allowed to
   have -- an edge SSO in front of the Worker, or a real session --
   which is a deployment decision rather than a frontend one.
   ============================================================ */

const Api = (() => {

  const DEFAULT_TIMEOUT_MS = 15000;

  /** Methods C-9's gate protects. Everything else is public. */
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  let baseUrl;            // undefined = not resolved yet, null = no API reachable
  let token = null;       // runtime only -- never read from or written to storage
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  /* ---------- base URL ---------- */

  function detectBase() {
    if (typeof window !== 'undefined' && typeof window.TAQWA_API_BASE === 'string') {
      return window.TAQWA_API_BASE.replace(/\/+$/, '') || null;
    }
    if (typeof document !== 'undefined' && document.querySelector) {
      const meta = document.querySelector('meta[name="taqwa-api-base"]');
      const content = meta && meta.getAttribute('content');
      if (content) return content.replace(/\/+$/, '');
    }
    // A file:// page has origin "null" as a string; there is nothing to call.
    const origin = typeof location !== 'undefined' ? location.origin : '';
    if (!origin || origin === 'null' || !/^https?:/.test(origin)) return null;
    return `${origin}/api`;
  }

  function base() {
    if (baseUrl === undefined) baseUrl = detectBase();
    return baseUrl;
  }

  /**
   * Set the base URL and/or the write token for this page's lifetime.
   * Passing a key explicitly is what changes it, so configure({ token })
   * cannot accidentally clear a base URL that was already resolved.
   */
  function configure(options = {}) {
    if ('baseUrl' in options) {
      baseUrl = options.baseUrl ? String(options.baseUrl).replace(/\/+$/, '') : null;
    }
    if ('token' in options) {
      const t = options.token == null ? '' : String(options.token).trim();
      token = t === '' ? null : t;
    }
    if ('timeoutMs' in options) {
      const n = Number(options.timeoutMs);
      if (Number.isFinite(n) && n > 0) timeoutMs = n;
    }
    return { baseUrl, hasToken: token !== null, timeoutMs };
  }

  /** Whether a write could be authenticated. Never reveals the token itself. */
  function hasToken() { return token !== null; }

  /* ---------- failures ---------- */

  /**
   * Every failure leaves here in one shape, so callers branch on `code`
   * rather than on a status number or a message string.
   */
  function failure(code, message, extra = {}) {
    return { ok: false, status: extra.status ?? 0, code, message, ...extra };
  }

  /**
   * The message a user should see for a transport-level problem. A server
   * failure carries its own message and is shown verbatim; these are the
   * cases where there is no server answer to quote.
   */
  const TRANSPORT_MESSAGES = {
    no_api: 'No backend is configured, so this is running on browser storage.',
    no_token: 'This change needs an API token. Run Api.configure({ token: … }) first.',
    timeout: 'The server took too long to answer. Check that it is running.',
    network_error: 'Could not reach the server. Check that it is running.',
    malformed_response: 'The server sent a response this app could not read.',
  };

  const transportFailure = (code, extra) =>
    failure(code, TRANSPORT_MESSAGES[code], extra);

  /* ---------- the request ---------- */

  /**
   * Perform one API call.
   *
   * Resolves to { ok: true, status, data, meta } or { ok: false, status,
   * code, message, fields? }. It never throws and never rejects: a caller
   * that has to try/catch around every write would eventually forget one.
   */
  async function request(method, path, body = undefined, options = {}) {
    const root = base();
    if (!root) return transportFailure('no_api');

    const upper = String(method).toUpperCase();
    const headers = {};

    // The token goes on mutations only. A read must never carry a
    // credential it does not need.
    if (MUTATING.has(upper)) {
      if (token === null) return transportFailure('no_token');
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';

    const url = `${root}${path}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const limit = options.timeoutMs ?? timeoutMs;
    const timer = controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), limit)
      : null;

    let response;
    try {
      response = await fetch(url, {
        method: upper,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (e) {
      // An abort is a timeout; anything else is the network. The caught
      // error is deliberately not echoed to the user -- it can carry the
      // full request URL, and a URL can carry a query string.
      const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return transportFailure(aborted ? 'timeout' : 'network_error');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const status = response.status;

    // 204 has no body by definition; treat it as success with no data.
    let payload = null;
    if (status !== 204) {
      try {
        payload = await response.json();
      } catch (e) {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
      if (payload === null || typeof payload !== 'object') {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
    }

    if (response.ok) {
      if (payload && 'error' in payload) {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
      const { data = null, ...meta } = payload || {};
      return { ok: true, status, data, meta };
    }

    const error = (payload && payload.error) || {};
    const code = typeof error.code === 'string' ? error.code : 'request_failed';
    const message = typeof error.message === 'string' && error.message
      ? error.message
      : `The server refused this request (${status}).`;
    return failure(code, message, {
      status,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.conflictsWith ? { conflictsWith: error.conflictsWith } : {}),
    });
  }

  const get = (path, options) => request('GET', path, undefined, options);
  const post = (path, body, options) => request('POST', path, body, options);
  const put = (path, body, options) => request('PUT', path, body, options);
  const del = (path, options) => request('DELETE', path, undefined, options);

  /**
   * Is a backend actually there?
   *
   * GET /api/health is public in C-9, so this needs no token and tells us
   * nothing about whether writes will be allowed -- only whether the API
   * answers at all. storage.js uses it to decide between D1 and
   * localStorage before it fetches anything.
   */
  async function probe(options = {}) {
    if (!base()) return { ok: false, code: 'no_api' };
    const res = await get('/health', { timeoutMs: options.timeoutMs ?? 5000 });
    return res.ok ? { ok: true, health: res.data } : { ok: false, code: res.code };
  }

  return { configure, hasToken, request, get, post, put, delete: del, probe,
           get baseUrl() { return base(); } };
})();

/* Node's test harness loads this file as a script; the browser does not. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Api };
