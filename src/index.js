/* ============================================================
   Taqwa Automobile Service Center — Worker API
   ------------------------------------------------------------
   Phase B: health plus read-only routes. The frontend still runs
   entirely on localStorage and calls none of this.

   The rule this file exists to establish: the browser never touches
   D1. Every database operation goes through a Worker route, which
   validates its input server-side and binds every SQL parameter.
   ============================================================ */

import { ok, fail, notFound, methodNotAllowed, noDatabase } from './lib/http.js';
import { listCustomers, getCustomer } from './routes/customers.js';
import { listVehicles, getVehicle } from './routes/vehicles.js';
import { listServices, getService } from './routes/services.js';
import { listMechanics, getMechanic } from './routes/mechanics.js';
import { listParts, getPart } from './routes/parts.js';

/**
 * Every collection exposes the same two shapes: a list at
 * /api/<name> and a detail at /api/<name>/<id>. Registering them
 * here keeps the path parsing in one place — adding a collection is
 * one line plus its route module, not another branch in the router.
 */
const COLLECTIONS = {
  customers: { list: listCustomers, detail: getCustomer },
  vehicles: { list: listVehicles, detail: getVehicle },
  services: { list: listServices, detail: getService },
  mechanics: { list: listMechanics, detail: getMechanic },
  parts: { list: listParts, detail: getPart },
};

const ROUTES = [
  'GET /api/health',
  ...Object.keys(COLLECTIONS).flatMap((name) => [
    `GET /api/${name}`,
    `GET /api/${name}/:id`,
  ]),
];

// Captures the collection name and, optionally, everything after the next
// slash. The id group is allowed to be empty so that /api/customers/ reaches
// the id validator (400) rather than falling through to a confusing 404.
const API_PATH = /^\/api\/([a-z-]+)(?:\/(.*))?$/;

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

    const match = API_PATH.exec(url.pathname);
    if (match) {
      const [, name, rawId] = match;
      const collection = COLLECTIONS[name];

      if (collection) {
        // No trailing segment at all -> the list route.
        if (rawId === undefined) return collection.list(request, env, url);

        let id;
        try {
          // A malformed escape (%zz) throws rather than returning garbage.
          id = decodeURIComponent(rawId);
        } catch {
          return fail('invalid_id', 'Record id is not valid URL encoding.', 400);
        }
        return collection.detail(request, env, id);
      }
    }

    return notFound(ROUTES);
  },
};
