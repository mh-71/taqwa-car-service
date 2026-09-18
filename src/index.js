/* ============================================================
   Taqwa Automobile Service Center — Worker API
   ------------------------------------------------------------
   Phase B: health plus the first read-only route. The frontend
   still runs entirely on localStorage and calls none of this.

   The rule this file exists to establish: the browser never touches
   D1. Every database operation goes through a Worker route, which
   validates its input server-side and binds every SQL parameter.
   ============================================================ */

import { ok, fail, notFound, methodNotAllowed, noDatabase } from './lib/http.js';
import { listCustomers, getCustomer } from './routes/customers.js';

const ROUTES = [
  'GET /api/health',
  'GET /api/customers',
  'GET /api/customers/:id',
];

// Matches /api/customers/<anything>, including an empty segment so that
// /api/customers/ is answered by the id validator (400) rather than falling
// through to a confusing 404.
const CUSTOMER_DETAIL = /^\/api\/customers\/(.*)$/;

/**
 * GET /api/health
 *
 * Reports whether the Worker is up and whether its D1 binding actually
 * answers. Deliberately reads only schema metadata — it touches no
 * business data and writes nothing, so it is safe to call anywhere.
 */
async function health(env) {
  const started = Date.now();

  if (!env.DB) return noDatabase();

  try {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`
    ).all();

    const indexes = await env.DB.prepare(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`
    ).first();

    const migrated = tables.results.some((t) => t.name === 'customers');

    const body = {
      service: 'taqwa-api',
      phase: 'B — read-only API',
      timestamp: new Date().toISOString(),
      routes: ROUTES,
      database: {
        bound: true,
        reachable: true,
        tableCount: tables.results.length,
        indexCount: indexes ? indexes.n : 0,
        tables: tables.results.map((t) => t.name),
        migrated,
        latencyMs: Date.now() - started,
        ...(migrated ? {} : { hint: 'Schema not applied. Run: npm run db:migrate:local' }),
      },
    };

    return migrated
      ? ok(body, { ok: true })
      : fail('not_migrated', 'Schema has not been applied to this database.', 503, body);
  } catch (err) {
    console.error('GET /api/health failed:', err);
    return fail('database_error', 'D1 binding is present but did not answer.', 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      return health(env);
    }

    if (url.pathname === '/api/customers') {
      return listCustomers(request, env, url);
    }

    const detail = CUSTOMER_DETAIL.exec(url.pathname);
    if (detail) {
      let id;
      try {
        // A malformed escape (%zz) throws rather than returning garbage.
        id = decodeURIComponent(detail[1]);
      } catch {
        return fail('invalid_id', 'Record id is not valid URL encoding.', 400);
      }
      return getCustomer(request, env, id);
    }

    return notFound(ROUTES);
  },
};
