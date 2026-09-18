/* ============================================================
   Taqwa Automobile Service Center — Worker API
   ------------------------------------------------------------
   Phase A: a health endpoint only. No business routes yet, and the
   frontend still runs entirely on localStorage — nothing calls this.

   The rule this file exists to establish: the browser never touches
   D1. Every database operation goes through a Worker route, which
   validates its input server-side and binds every SQL parameter.
   ============================================================ */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * GET /api/health
 *
 * Reports whether the Worker is up and whether its D1 binding actually
 * answers. Deliberately reads only schema metadata — it touches no
 * business data and writes nothing, so it is safe to call anywhere.
 */
async function health(env) {
  const started = Date.now();
  const result = {
    ok: true,
    service: 'taqwa-api',
    phase: 'A — schema and health only',
    timestamp: new Date().toISOString(),
    database: { bound: false },
  };

  if (!env.DB) {
    result.ok = false;
    result.database.error = 'No D1 binding named DB. Check wrangler.jsonc.';
    return json(result, 503);
  }
  result.database.bound = true;

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

    result.database.reachable = true;
    result.database.tableCount = tables.results.length;
    result.database.indexCount = indexes ? indexes.n : 0;
    result.database.tables = tables.results.map((t) => t.name);
    result.database.migrated = tables.results.some((t) => t.name === 'customers');
    result.database.latencyMs = Date.now() - started;

    if (!result.database.migrated) {
      result.ok = false;
      result.database.hint =
        'Schema not applied. Run: npm run db:migrate:local';
    }
  } catch (err) {
    result.ok = false;
    result.database.reachable = false;
    result.database.error = String(err && err.message ? err.message : err);
  }

  return json(result, result.ok ? 200 : 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'Method not allowed' }, 405);
      }
      return health(env);
    }

    return json(
      {
        ok: false,
        error: 'Not found',
        // Every route added from here on is listed by the health endpoint's
        // sibling documentation, not guessed at by clients.
        available: ['GET /api/health'],
      },
      404
    );
  },
};
