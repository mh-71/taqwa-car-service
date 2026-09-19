/* fake-api.cjs — an in-memory stand-in for the Worker, for the suites that
   need js/api.js to have something to talk to.

   It is deliberately NOT a second implementation of the API's rules: it
   answers with the API's envelopes ({data,count} / {error:{code,message}}),
   allocates ids the way the server does (the client must not), and lets a
   suite force any failure it wants. What each route is allowed to REFUSE is
   the Worker's business and is tested against the real Worker in
   tests/integration/. */
/* ---- a small in-memory API, close enough to the Worker's contract ---- */
function fakeApi({ rows = {}, settings = null, fail = null, health = true } = {}) {
  const calls = [];
  const db = JSON.parse(JSON.stringify(rows));
  const seq = {};
  const PREFIX = { customers: 'CUS', 'job-cards': 'JOB', payments: 'PAY', invoices: 'INV',
                   parts: 'PRT', vehicles: 'VEH', appointments: 'APT', services: 'SRV',
                   mechanics: 'MEC', expenses: 'EXP', 'inventory-transactions': 'STK' };
  let stored = settings ? { ...settings } : null;

  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, auth: (init.headers || {}).authorization });

    const forced = fail && fail({ method, path, body, n: calls.length - 1 });
    if (forced) return res(forced.status, { error: forced.error });

    if (path === '/health') {
      return health ? res(200, { data: { status: 'ok' } }) : res(503, { error: { code: 'no_database', message: 'no db' } });
    }

    const [, name, id, action] = path.split('?')[0].split('/');

    if (name === 'settings') {
      if (method === 'GET') {
        return stored ? res(200, { data: stored })
                      : res(404, { error: { code: 'not_found', message: 'No settings row.' } });
      }
      stored = { ...(stored || {}), ...body, id: 1, updatedAt: '2026-09-19T00:00:00Z' };
      return res(200, { data: stored });
    }

    const list = db[name] || (db[name] = []);

    if (!id) {
      if (method === 'GET') {
        const q = new URLSearchParams(String(url).split('?')[1] || '');
        const limit = Number(q.get('limit') || 500), offset = Number(q.get('offset') || 0);
        return res(200, { data: list.slice(offset, offset + limit), count: list.length,
                          limit, offset });
      }
      seq[name] = (seq[name] || 0) + 1;
      const record = { ...body, id: `${PREFIX[name]}-${String(seq[name] + 900).padStart(4, '0')}`,
                       createdAt: '2026-09-19T00:00:00Z' };
      list.push(record);
      return res(201, { data: record });
    }

    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return res(404, { error: { code: 'not_found', message: 'No such record.' } });

    if (action) {                      // POST /api/<name>/:id/<action>
      list[idx] = { ...list[idx], ...(body || {}), acted: action };
      return res(200, { data: list[idx] });
    }
    if (method === 'GET') return res(200, { data: list[idx] });
    if (method === 'PUT') { list[idx] = { ...list[idx], ...body, updatedAt: 'later' }; return res(200, { data: list[idx] }); }
    if (method === 'DELETE') { list.splice(idx, 1); return res(200, { data: { id } }); }
    return res(405, { error: { code: 'method_not_allowed', message: 'Allowed: GET' } });
  };
  fn.calls = calls;
  fn.db = db;
  fn.settings = () => stored;
  return fn;
}


module.exports = { fakeApi };
