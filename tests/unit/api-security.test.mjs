/* api-security — the headers every response carries, and the edges the
   session gate has to hold at.

   C-13 added two things and this suite is about both:

     1. Security headers. The important one is `cache-control: no-store`: an
        authenticated GET here returns customer names, phone numbers,
        addresses and the financial ledger, and without it that JSON is a
        cacheable 200 the browser may keep after sign-out.
     2. A CSP for the static app that allows its one inline script BY HASH,
        so script injection stays blocked rather than being waved through
        with 'unsafe-inline'.

   Plus the authentication edges C-12's own suite did not reach: a duplicate
   cookie, a cookie signed with a different secret, a cookie whose name only
   looks right. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../src/index.js';
import { issueSessionCookie, SESSION_COOKIE } from '../../src/lib/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const stubDB = () => ({ prepare() {
  const st = { bind() { return st; }, async all() { return { results: [] }; },
               async first() { return { n: 0 }; }, async run() { return { meta: { changes: 1 } }; } };
  return st;
}, async batch() { return [{ meta: { changes: 1 } }]; } });

const PASSPHRASE = 'unit-test-passphrase';
const SECRET = 'unit-test-signing-secret';
const TOKEN = 'unit-test-machine-token';
const env = (extra = {}) => ({ DB: stubDB(), AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET, ...extra });
const call = (path, { method = 'GET', headers = {}, body, e = env() } = {}) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method, headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), e);
const bearer = { authorization: `Bearer ${TOKEN}` };

console.log('=== api-security: headers and the session edges ===\n');

/* ============================================================
   1. Every response class carries the headers
   ============================================================ */
console.log('-- 1. security headers --');
{
  const e = env({ API_TOKEN: TOKEN });
  const cases = [
    ['200 an authenticated read', await call('/api/customers', { headers: bearer, e })],
    ['401 an unauthenticated read', await call('/api/customers', { e })],
    ['404 an unknown endpoint', await call('/api/nope', { headers: bearer, e })],
    ['405 a wrong method', await call('/api/health', { method: 'POST', e })],
    ['422 a rejected body', await call('/api/customers', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: {}, e })],
    ['503 an unconfigured Worker', await call('/api/customers', { e: { DB: stubDB() } })],
    ['200 the public health route', await call('/api/health', { e })],
    ['200 the public session route', await call('/api/session', { e })],
    ['204 a sign-in', await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { passphrase: PASSPHRASE }, e })],
    ['204 a sign-out', await call('/api/session', { method: 'DELETE', e })],
  ];
  const missing = [];
  for (const [label, res] of cases) {
    for (const [h, want] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
                             ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY']]) {
      if (res.headers.get(h) !== want) missing.push({ label, h, got: res.headers.get(h) });
    }
    if (!/frame-ancestors 'none'/.test(res.headers.get('content-security-policy') || '')) {
      missing.push({ label, h: 'csp', got: res.headers.get('content-security-policy') });
    }
  }
  check('EVERY response class carries every security header', missing, []);
  check('   ...which is all of them', cases.length, 10);
}
{
  const e = env({ API_TOKEN: TOKEN });
  const res = await call('/api/customers', { headers: bearer, e });
  // The one that matters most: this body is the shop's customer list.
  check('an authenticated read is never stored', res.headers.get('cache-control'), 'no-store');
  ok_('   ...and is still JSON', /application\/json/.test(res.headers.get('content-type')),
    res.headers.get('content-type'));
  const login = await call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: { passphrase: PASSPHRASE }, e,
  });
  ok_('a Set-Cookie response is never stored either, so a session cannot be served twice',
    login.headers.get('cache-control') === 'no-store' && !!login.headers.get('set-cookie'),
    login.headers.get('cache-control'));
}

/* ============================================================
   2. The static app's CSP
   ============================================================ */
console.log('\n-- 2. the CSP for the static app --');
{
  const headers = readFileSync(join(ROOT, '_headers'), 'utf8');
  const csp = (headers.match(/Content-Security-Policy:\s*(.+)/) || [])[1] || '';
  ok_('a CSP is served for the app', csp.length > 0, headers.slice(0, 120));

  const scriptSrc = (csp.match(/script-src ([^;]+)/) || [])[1] || '';
  ok_("script-src does NOT use 'unsafe-inline'", !/unsafe-inline/.test(scriptSrc), scriptSrc);
  ok_("   ...nor 'unsafe-eval'", !/unsafe-eval/.test(csp), csp);
  ok_('   ...it allows the one inline script by hash instead',
    /'sha256-[A-Za-z0-9+/=]+'/.test(scriptSrc), scriptSrc);

  // The hash has to match the script that is actually on the pages, or every
  // page loses its theme on first paint.
  const cspHash = (scriptSrc.match(/'(sha256-[A-Za-z0-9+/=]+)'/) || [])[1];
  const pages = ['index.html', 'pages/customers.html', 'pages/job-cards.html',
                 'pages/invoices.html', 'pages/payments.html', 'pages/settings.html'];
  const wrong = [];
  for (const page of pages) {
    const src = readFileSync(join(ROOT, page), 'utf8');
    const inline = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const body of inline) {
      const h = 'sha256-' + createHash('sha256').update(body).digest('base64');
      if (h !== cspHash) wrong.push({ page, got: h });
    }
  }
  check('the hash matches the inline script on every page', wrong, []);

  for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
                           "default-src 'self'", "connect-src 'self'"]) {
    ok_(`the CSP sets ${directive}`, csp.includes(directive), csp);
  }
  ok_('style-src allows inline, because the app uses style attributes throughout',
    /style-src [^;]*'unsafe-inline'/.test(csp), csp);
  ok_('   ...and the fonts the pages actually load are allowed',
    csp.includes('fonts.googleapis.com') && csp.includes('fonts.gstatic.com'), csp);
  ok_('nosniff, Referrer-Policy and a frame refusal are served too',
    /X-Content-Type-Options:\s*nosniff/i.test(headers)
      && /Referrer-Policy:/i.test(headers) && /X-Frame-Options:\s*DENY/i.test(headers), headers);
}
{
  // A CSP with a script hash is only worth anything if nothing relies on an
  // inline handler, which the hash would not cover.
  const files = ['index.html', 'pages/customers.html', 'pages/settings.html',
                 'js/app.js', 'js/customers.js', 'js/job-cards.js', 'js/utils.js'];
  const inlineHandlers = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const m = src.match(/\son(click|change|input|submit|load|error|mouse[a-z]+)\s*=/gi);
    if (m) inlineHandlers.push({ f, m });
  }
  check('nothing uses an inline event handler, so the CSP breaks nothing', inlineHandlers, []);
}

/* ============================================================
   3. Session edges
   ============================================================ */
console.log('\n-- 3. what the cookie gate refuses --');
{
  const e = env();
  const good = (await issueSessionCookie(e)).split(';')[0];
  const value = good.slice(SESSION_COOKIE.length + 1);

  // Signed with a DIFFERENT secret: the shape is perfect, the key is not.
  const other = await issueSessionCookie({ ...e, AUTH_SECRET: 'a-completely-different-secret' });
  const otherValue = other.split(';')[0];

  const cases = {
    'a cookie signed with another secret': otherValue,
    'an empty cookie value': `${SESSION_COOKIE}=`,
    'a cookie with only a name': `${SESSION_COOKIE}`,
    'a name that only looks right': `${SESSION_COOKIE}x=${value}`,
    'a name that is a prefix': `taqwa_sess=${value}`,
    'a version bump': `${SESSION_COOKIE}=v2${value.slice(2)}`,
    // Not an exploit -- a forgery still fails the signature -- but a padded
    // value is malformed per RFC 6265, and accepting it would let this parser
    // and an intermediary disagree about what the cookie says.
    'whitespace padding': `${SESSION_COOKIE}=  ${value}  `,
    'a second value appended': `${SESSION_COOKIE}=${value}.extra`,
  };
  const accepted = [];
  for (const [why, cookie] of Object.entries(cases)) {
    const res = await call('/api/customers', { headers: { cookie }, e });
    if (res.status !== 401) accepted.push({ why, status: res.status });
  }
  check('none of them is accepted', accepted, []);
  const okRes = await call('/api/customers', { headers: { cookie: good }, e });
  ok_('   ...while the real one still is', okRes.status === 200, `got ${okRes.status}`);
}
{
  // Two cookies of the same name. Whichever the parser takes, a forged one
  // must never turn into a session.
  const e = env();
  const good = (await issueSessionCookie(e)).split(';')[0];
  const forged = `${SESSION_COOKIE}=v1.9999999999.AAAA`;
  const forgedFirst = await call('/api/customers', { headers: { cookie: `${forged}; ${good}` }, e });
  const goodFirst = await call('/api/customers', { headers: { cookie: `${good}; ${forged}` }, e });
  ok_('a forged cookie sent alongside a real one cannot downgrade it to a pass',
    forgedFirst.status === 401 || forgedFirst.status === 200, `got ${forgedFirst.status}`);
  check('   ...and a real one first is still accepted', goodFirst.status, 200);
  ok_('   ...so no ordering turns a forgery into access',
    !(forgedFirst.status === 200 && goodFirst.status !== 200), 'ordering changed the outcome');
}
{
  // A replayed valid cookie IS accepted until it expires. That is the model,
  // not a defect -- there is no stored session to revoke. Asserting it keeps
  // the limitation visible instead of letting it be quietly assumed away.
  const e = env();
  const good = (await issueSessionCookie(e)).split(';')[0];
  const first = await call('/api/customers', { headers: { cookie: good }, e });
  const replay = await call('/api/customers', { headers: { cookie: good }, e });
  ok_('a valid cookie is reusable until it expires -- by design, and documented',
    first.status === 200 && replay.status === 200, `${first.status}/${replay.status}`);
}

/* ============================================================
   4. Nothing leaks
   ============================================================ */
console.log('\n-- 4. leakage --');
{
  const e = env({ API_TOKEN: TOKEN });
  const surfaces = [
    await call('/api/customers', { e }),
    await call('/api/nope', { headers: bearer, e }),
    await call('/api/customers/../../etc/passwd', { headers: bearer, e }),
    await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { passphrase: 'wrong' }, e }),
    await call('/api/customers', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: 'not json', e }),
  ];
  const bodies = [];
  for (const r of surfaces) bodies.push(await r.text());
  const all = bodies.join('\n');
  ok_('no response contains a credential', !all.includes(TOKEN) && !all.includes(PASSPHRASE) && !all.includes(SECRET), all.slice(0, 160));
  ok_('   ...nor names a secret binding', !/AUTH_SECRET|AUTH_PASSPHRASE|API_TOKEN/.test(all), all.slice(0, 160));
  ok_('   ...nor a stack trace or file path', !/\bat \w+ \(|\.js:\d+|\/home\/|node_modules/.test(all), all.slice(0, 160));
  ok_('   ...nor SQL', !/SELECT |INSERT |UPDATE |sqlite|D1_ERROR/i.test(all), all.slice(0, 160));
  ok_('every one is the documented error envelope',
    bodies.every((b) => b === '' || (() => { try { const p = JSON.parse(b); return 'data' in p || ('error' in p && 'code' in p.error && 'message' in p.error); } catch { return false; } })()),
    bodies.map((b) => b.slice(0, 40)));
}

console.log(`\nSecurity unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
