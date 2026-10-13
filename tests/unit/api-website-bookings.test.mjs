/* GET /api/website-bookings — unit tests against the REAL Worker.

   The route relays the public website's booking list, which carries customer
   names, emails and phone numbers. It used to be dispatched in front of the
   auth gate and answered anyone (audit finding F-01). It now goes through
   run() like every other business read.

   It is not in the advertised ROUTES registry, so the registry-driven sweep in
   api-auth.test.mjs cannot see it; this file covers it by hand.

   The upstream is NEVER contacted: globalThis.fetch is replaced by a stub that
   counts calls, so "the gate stopped it before the upstream was asked" is
   provable, and every booking below is synthetic. */
import worker from '../../src/index.js';
import { issueSessionCookie, SESSION_COOKIE } from '../../src/lib/auth.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const TOKEN = 'the-configured-secret';
const ENV = { DB: {}, API_TOKEN: TOKEN, AUTH_PASSPHRASE: 'workshop-passphrase', AUTH_SECRET: 'cookie-signing-secret' };
const UPSTREAM = 'https://taqwa.blinto.workers.dev/api/bookings/list';
const SYNTHETIC = { bookings: [{ id: 7, customer_name: 'Synthetic Person', customer_email: 'nobody@example.invalid',
  customer_phone: '00000-000000', vehicle_type: 'Sedan', service_type: 'Oil change', preferred_date: '2026-10-20' }] };

/* ---- the upstream stub ---- */
const realFetch = globalThis.fetch;
let upstreamCalls = [];
let upstreamReply = () => new Response(JSON.stringify(SYNTHETIC), { status: 200 });
globalThis.fetch = async (input, init) => {
  upstreamCalls.push({ url: String(input), init });
  return upstreamReply();
};
const reset = (reply) => {
  upstreamCalls = [];
  upstreamReply = reply ?? (() => new Response(JSON.stringify(SYNTHETIC), { status: 200 }));
};

const call = (headers = {}, { method = 'GET', env = ENV } = {}) =>
  worker.fetch(new Request('http://worker.local/api/website-bookings', { method, headers }), env);
const cookieHeader = async (env = ENV, now) => ({ cookie: (await issueSessionCookie(env, now)).split(';')[0] });

console.log('\n=== GET /api/website-bookings ===');

/* ============================================================
   1. Without a valid credential: 401, and the upstream is never asked
   ============================================================ */
console.log('\n-- 1. refused before the upstream is contacted --');
{
  const good = (await cookieHeader()).cookie;
  const value = good.slice(SESSION_COOKIE.length + 1);
  const tampered = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
  const otherSecret = (await cookieHeader({ ...ENV, AUTH_SECRET: 'a-different-secret' })).cookie;
  const expired = (await cookieHeader(ENV, Date.now() - 13 * 3600 * 1000)).cookie;
  const REFUSALS = [
    ['no credential at all', {}],
    ['a wrong bearer token', { authorization: 'Bearer not-the-secret' }],
    ['a malformed authorization header', { authorization: TOKEN }],
    ['a tampered session cookie', { cookie: `${SESSION_COOKIE}=${tampered}` }],
    ['a cookie signed with another secret', { cookie: otherSecret }],
    ['an expired session cookie', { cookie: expired }],
    ['an empty session cookie', { cookie: `${SESSION_COOKIE}=` }],
  ];
  for (const [why, headers] of REFUSALS) {
    reset();
    const res = await call(headers);
    const body = await res.json();
    check(`${why} -> 401`, res.status, 401);
    check('   ...with the standard refusal', body.error && body.error.code, 'unauthorized');
    check('   ...and the upstream was not contacted', upstreamCalls.length, 0);
    ok_('   ...and no booking data in the body', !JSON.stringify(body).includes('Synthetic Person'), JSON.stringify(body));
  }
}

/* ============================================================
   2. A Worker with no credential configured fails closed
   ============================================================ */
console.log('\n-- 2. fails closed when no credential is configured --');
{
  reset();
  const res = await call({}, { env: { DB: {} } });
  check('no secrets configured -> 503', res.status, 503);
  check('   ...auth_not_configured', (await res.json()).error.code, 'auth_not_configured');
  check('   ...and the upstream was not contacted', upstreamCalls.length, 0);
}

/* ============================================================
   3. Signed in: the bookings come through unchanged
   ============================================================ */
console.log('\n-- 3. an authorised caller still gets the bookings --');
for (const [why, headers] of [['a valid session cookie', await cookieHeader()], ['a valid bearer token', { authorization: `Bearer ${TOKEN}` }]]) {
  reset();
  const res = await call(headers);
  check(`${why} -> 200`, res.status, 200);
  check('   ...the upstream body is relayed unchanged', await res.json(), SYNTHETIC);
  check('   ...after exactly one upstream request', upstreamCalls.length, 1);
  check('   ...to the website booking list', upstreamCalls[0] && upstreamCalls[0].url, UPSTREAM);
  check('   ...JSON content type', res.headers.get('content-type'), 'application/json; charset=utf-8');
  check('   ...with the standard security headers',
    ['cache-control', 'x-content-type-options', 'x-frame-options', 'content-security-policy'].map(h => res.headers.get(h)),
    ['no-store', 'nosniff', 'DENY', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"]);
}

/* ============================================================
   4. Upstream failures: one generic 500, nothing of the upstream leaks
   ============================================================ */
console.log('\n-- 4. upstream failures are generic --');
{
  const auth = { authorization: `Bearer ${TOKEN}` };
  const FAILURES = [
    ['the upstream answers 503 with an error page', () => new Response('<h1>upstream-secret-detail</h1>', { status: 503 })],
    ['the upstream answers 404 with JSON', () => new Response(JSON.stringify({ error: 'upstream-secret-detail' }), { status: 404 })],
    ['the upstream answers 200 with non-JSON', () => new Response('upstream-secret-detail', { status: 200 })],
    ['the upstream cannot be reached', () => { throw new Error('upstream-secret-detail: connect ECONNREFUSED'); }],
  ];
  const quiet = console.error; console.error = () => {};   // the proxy logs the cause server-side
  try {
    for (const [why, reply] of FAILURES) {
      reset(reply);
      const res = await call(auth);
      const text = await res.text();
      check(`${why} -> 500`, res.status, 500);
      check('   ...one generic error', JSON.parse(text).error,
        { code: 'upstream_error', message: 'Website bookings are unavailable right now.' });
      ok_('   ...no upstream status, body or error text in the response',
        !text.includes('upstream-secret-detail') && !text.includes('ECONNREFUSED') && !/\b(503|404)\b/.test(text), text);
      check('   ...JSON with the security headers', [res.headers.get('content-type'), res.headers.get('x-frame-options')],
        ['application/json; charset=utf-8', 'DENY']);
    }
  } finally {
    console.error = quiet;
  }
}

/* ============================================================
   5. Other methods: 405, with or without a credential
   ============================================================ */
console.log('\n-- 5. only GET --');
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  for (const [who, headers] of [['signed out', {}], ['signed in', { authorization: `Bearer ${TOKEN}` }]]) {
    reset();
    const res = await call(headers, { method });
    check(`${method} (${who}) -> 405`, res.status, 405);
    check('   ...Allow: GET', res.headers.get('allow'), 'GET');
    check('   ...and the upstream was not contacted', upstreamCalls.length, 0);
  }
}

/* ============================================================
   6. Nothing else moved
   ============================================================ */
console.log('\n-- 6. neighbouring routes unchanged --');
{
  reset();
  const get = (path, headers = {}) => worker.fetch(new Request('http://worker.local' + path, { headers }), ENV);
  check('GET /api/session stays public', (await get('/api/session')).status, 200);
  check('GET /api/customers without a credential is still 401', (await get('/api/customers')).status, 401);
  const nf = await (await get('/api/no-such-endpoint')).json();
  const routes = (nf.error && nf.error.available) || [];
  ok_('the 404 still advertises the route registry', routes.length > 0, JSON.stringify(nf).slice(0, 200));
  ok_('   ...unchanged: website-bookings is not in it', !routes.some(r => r.includes('website-bookings')), JSON.stringify(routes));
  check('   ...and none of these contacted the upstream', upstreamCalls.length, 0);
}

globalThis.fetch = realFetch;
console.log(`\nWebsite bookings unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
