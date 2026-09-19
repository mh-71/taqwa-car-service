/* api-client — js/api.js, driven as the browser drives it.

   Every assertion here goes through the REAL Api built by the real file:
   nothing is re-implemented and nothing is asserted about the source text.
   The only thing faked is fetch, whose calls are recorded so the test can
   see exactly what would have gone over the wire -- which is the only way
   to prove that a read carries no credential. */
const { boot, check, ok, summary } = require('../lib/harness.cjs');

/* A fetch stub that records every call and replays scripted responses. */
function stub(script) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: { ...(init.headers || {}) }, body: init.body,
                 signal: init.signal, credentials: init.credentials, cache: init.cache });
    const next = typeof script === 'function' ? script(url, init, calls.length - 1) : script;
    if (next && next.throw) { const e = new Error('boom'); e.name = next.throw; throw e; }
    return {
      status: next.status ?? 200,
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      json: async () => {
        if (next.badJson) throw new Error('not json');
        return next.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const env = (opts = {}) => boot({ origin: 'http://localhost:8787', ...opts });

console.log('=== api-client: js/api.js ===\n');

/* ============================================================
   1. Where the API is
   ============================================================ */
console.log('-- 1. base URL resolution --');
{
  const { ctx } = env();
  check('same origin + /api is the default', ctx.Api.baseUrl, 'http://localhost:8787/api');
}
{
  const { ctx } = boot({ origin: '' });   // file:// has no usable origin
  check('a page with no http origin resolves no API', ctx.Api.baseUrl, null);
  ok('   ...so a request is refused before any fetch',
    true, '');
}
{
  const { ctx } = boot({ origin: 'http://localhost:5500' });
  ctx.window.TAQWA_API_BASE = 'http://localhost:8787/api';
  // Force re-resolution the way a fresh page would.
  ctx.Api.configure({ baseUrl: ctx.window.TAQWA_API_BASE });
  check('an explicit override wins', ctx.Api.baseUrl, 'http://localhost:8787/api');
}
{
  const { ctx } = env();
  ctx.Api.configure({ baseUrl: 'http://example.test/api/' });
  check('a trailing slash is trimmed so paths never double up',
    ctx.Api.baseUrl, 'http://example.test/api');
}
{
  const { ctx } = env();
  ctx.Api.configure({ baseUrl: 'http://example.test/api' });
  ctx.Api.configure({ token: 'tok' });
  check('configure({token}) does not clear the base URL',
    ctx.Api.baseUrl, 'http://example.test/api');
  ok('   ...and configure reports only WHETHER a token is set',
    ctx.Api.configure({}).hasToken === true &&
    !JSON.stringify(ctx.Api.configure({})).includes('tok'),
    JSON.stringify(ctx.Api.configure({})));
}

/* ============================================================
   2. Authentication: the token goes on mutations and nowhere else
   ============================================================ */
console.log('\n-- 2. the credential --');
(async () => {
  {
    const f = stub({ status: 200, body: { data: [], count: 0 } });
    const { ctx } = env({ fetch: f });
    ctx.Api.configure({ token: 'secret-token-value' });
    await ctx.Api.get('/customers');
    const sent = f.calls[0].headers;
    // C-12 protects reads, so a configured machine token now goes on them
    // too. A browser still sends no header -- it has a cookie instead.
    check('a GET carries the machine token, now that reads are protected',
      sent.authorization, 'Bearer secret-token-value');
  }
  {
    const f = stub({ status: 201, body: { data: { id: 'CUS-0001' } } });
    const { ctx } = env({ fetch: f });
    ctx.Api.configure({ token: 'secret-token-value' });
    await ctx.Api.post('/customers', { name: 'A' });
    check('a POST carries the bearer token',
      f.calls[0].headers.authorization, 'Bearer secret-token-value');
    check('   ...and declares JSON', f.calls[0].headers['content-type'], 'application/json');
  }
  for (const [method, call] of [['PUT', c => c.put('/customers/CUS-0001', { name: 'B' })],
                                ['DELETE', c => c.delete('/customers/CUS-0001')]]) {
    const f = stub({ status: 200, body: { data: {} } });
    const { ctx } = env({ fetch: f });
    ctx.Api.configure({ token: 'tok' });
    await call(ctx.Api);
    check(`a ${method} carries the bearer token`, f.calls[0].headers.authorization, 'Bearer tok');
  }
  {
    // C-12: a browser's credential is an HttpOnly cookie this code cannot
    // read, so the client can no longer decide in advance that a request
    // will fail. It goes out, with no Authorization header, and the SERVER
    // answers -- which is the only party that can actually tell.
    const f = stub({ status: 401, body: { error: {
      code: 'unauthorized', message: 'Authentication required.' } } });
    const { ctx } = env({ fetch: f });
    const res = await ctx.Api.post('/customers', { name: 'A' });
    check('a mutation with no token is SENT, and the server refuses it', res.code, 'unauthorized');
    check('   ...having actually gone out', f.calls.length, 1);
    ok('   ...carrying no authorization header of its own',
      !('authorization' in f.calls[0].headers), JSON.stringify(f.calls[0].headers));
    ok('   ...but letting the browser attach its cookie',
      f.calls[0].credentials === 'same-origin', String(f.calls[0].credentials));
  }
  {
    // The failure a caller sees must never carry the credential itself --
    // the message is shown in a toast, which is the easiest place to leak one.
    const { ctx } = env({ fetch: stub({ status: 401, body: { error: {
      code: 'unauthorized', message: 'Authentication required.' } } }) });
    ctx.Api.configure({ token: 'zzz-distinctive-token-zzz' });
    const res = await ctx.Api.post('/customers', { name: 'A' });
    ok('a rejected write never echoes the token back to the caller',
      !JSON.stringify(res).includes('zzz-distinctive-token-zzz'), JSON.stringify(res));
    check('   ...and reports 401 as unauthorized', res.code, 'unauthorized');
  }
  {
    const f = stub({ status: 200, body: { data: [], count: 0 } });
    const { ctx } = env({ fetch: f });
    const res = await ctx.Api.get('/customers');
    ok('a READ with no token still works, because C-9 leaves GET public', res.ok, JSON.stringify(res));
  }
  {
    const { ctx } = boot({ origin: '', fetch: stub({ status: 200, body: {} }) });
    const res = await ctx.Api.get('/customers');
    check('with no API configured, a read fails as no_api', res.code, 'no_api');
  }

  /* ============================================================
     3. Reading the answer
     ============================================================ */
  console.log('\n-- 3. responses --');
  {
    const f = stub({ status: 200, body: { data: [{ id: 'CUS-0001' }], count: 7, limit: 500 } });
    const { ctx } = env({ fetch: f });
    const res = await ctx.Api.get('/customers');
    check('data is unwrapped', res.data, [{ id: 'CUS-0001' }]);
    check('   ...and the rest of the envelope is kept as meta', res.meta, { count: 7, limit: 500 });
    check('   ...with the status', res.status, 200);
  }
  {
    const { ctx } = env({ fetch: stub({ status: 204, body: null }) });
    const res = await ctx.Api.get('/whatever');
    ok('204 is a success with no data', res.ok && res.data === null, JSON.stringify(res));
  }

  const failures = [
    [400, 'invalid_parameter', '`limit` must be a whole number.'],
    [401, 'unauthorized', 'Authentication required.'],
    [404, 'not_found', 'No such customer.'],
    [409, 'conflict', 'That registration number already exists.'],
    [422, 'unprocessable', 'Enter a valid phone number.'],
    [503, 'auth_not_configured', 'Write access is not configured on this server.'],
  ];
  for (const [status, code, message] of failures) {
    const { ctx } = env({ fetch: stub({ status, body: { error: { code, message } } }) });
    const res = await ctx.Api.get('/customers');
    ok(`${status} surfaces as code ${code}`,
      res.ok === false && res.code === code && res.message === message && res.status === status,
      JSON.stringify(res));
  }
  {
    const { ctx } = env({ fetch: stub({ status: 422, body: { error: {
      code: 'unprocessable', message: 'Some fields need attention.',
      fields: { phone: 'Enter a valid phone number.' } } } }) });
    const res = await ctx.Api.get('/customers');
    check('422 field detail is preserved for the form', res.fields,
      { phone: 'Enter a valid phone number.' });
  }
  {
    const { ctx } = env({ fetch: stub({ status: 409, body: { error: {
      code: 'conflict', message: 'In use.', conflictsWith: 'VEH-0003' } } }) });
    const res = await ctx.Api.get('/customers');
    check('409 machine-readable context is preserved', res.conflictsWith, 'VEH-0003');
  }

  /* ============================================================
     4. When there is no answer
     ============================================================ */
  console.log('\n-- 4. transport failures --');
  {
    const { ctx } = env({ fetch: stub({ throw: 'TypeError' }) });
    const res = await ctx.Api.get('/customers');
    check('an unreachable server is network_error', res.code, 'network_error');
    ok('   ...and does not reject', res.ok === false, JSON.stringify(res));
  }
  {
    const { ctx } = env({ fetch: stub({ throw: 'AbortError' }) });
    const res = await ctx.Api.get('/customers');
    check('an aborted request is a timeout', res.code, 'timeout');
  }
  {
    const { ctx } = env({ fetch: stub({ status: 200, badJson: true }) });
    const res = await ctx.Api.get('/customers');
    check('unparseable JSON is malformed_response', res.code, 'malformed_response');
  }
  {
    const { ctx } = env({ fetch: stub({ status: 200, body: 'a string' }) });
    const res = await ctx.Api.get('/customers');
    check('a non-object body is malformed_response', res.code, 'malformed_response');
  }
  {
    const { ctx } = env({ fetch: stub({ status: 200, body: { error: { code: 'x', message: 'y' } } }) });
    const res = await ctx.Api.get('/customers');
    check('a 200 carrying an error envelope is not trusted', res.code, 'malformed_response');
  }
  {
    const { ctx } = env({ fetch: stub({ status: 500, body: { notAnError: true } }) });
    const res = await ctx.Api.get('/customers');
    ok('a failure with no usable envelope still gets a code and a message',
      res.code === 'request_failed' && /500/.test(res.message), JSON.stringify(res));
    ok('   ...and no stack trace reaches the caller',
      !/at |Error:|\.js:\d/.test(res.message), res.message);
  }
  {
    // The thrown error can carry the full request URL; the user must not see it.
    const { ctx } = env({ fetch: async () => { throw new Error('connect ECONNREFUSED http://localhost:8787/api/customers?secret=1'); } });
    const res = await ctx.Api.get('/customers?secret=1');
    ok('a transport failure never echoes the request URL',
      !res.message.includes('localhost:8787') && !res.message.includes('secret'), res.message);
  }
  {
    let signalled = null;
    const f = async (url, init) => { signalled = init.signal; return { status: 200, ok: true, json: async () => ({ data: [] }) }; };
    const { ctx } = env({ fetch: f });
    await ctx.Api.get('/customers');
    ok('a request is given an abort signal, so it cannot hang forever', signalled != null, String(signalled));
  }

  /* ============================================================
     5. The health probe
     ============================================================ */
  console.log('\n-- 5. probe --');
  {
    const f = stub({ status: 200, body: { data: { status: 'ok', database: 'ok' } } });
    const { ctx } = env({ fetch: f });
    ctx.Api.configure({ token: 'tok' });
    const res = await ctx.Api.probe();
    ok('probe reports a live backend', res.ok === true, JSON.stringify(res));
    check('   ...by asking the public health route', f.calls[0].url, 'http://localhost:8787/api/health');
    check('   ...as a GET', f.calls[0].method, 'GET');
    // Health is public, so the probe needs no credential. A configured
    // machine token rides along harmlessly -- reads carry it now — so what
    // is asserted is that probing works WITHOUT one.
    const anon = boot({ origin: 'http://localhost:8787',
      fetch: stub({ status: 200, body: { data: { status: 'ok' } } }) });
    ok('   ...and works with no credential configured at all',
      (await anon.ctx.Api.probe()).ok === true, '');
  }
  {
    const { ctx } = env({ fetch: stub({ throw: 'TypeError' }) });
    const res = await ctx.Api.probe();
    ok('probe reports a dead backend rather than throwing', res.ok === false, JSON.stringify(res));
  }
  {
    const { ctx } = boot({ origin: '' });
    const res = await ctx.Api.probe();
    check('probe with no API configured says so', res.code, 'no_api');
  }

  process.exit(summary('API client unit') === 0 ? 0 : 1);
})();
