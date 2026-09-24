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
import { checkAuth } from './lib/auth.js';
import { session } from './routes/session.js';
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from './routes/customers.js';
import {
  listVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
} from './routes/vehicles.js';
import {
  listServices, getService, createService, updateService, deleteService,
} from './routes/services.js';
import {
  listMechanics, getMechanic, createMechanic, updateMechanic, deleteMechanic,
} from './routes/mechanics.js';
import {
  listParts, getPart, createPart, updatePart, deletePart,
} from './routes/parts.js';
import {
  listAppointments, getAppointment,
  createAppointment, updateAppointment, deleteAppointment,
} from './routes/appointments.js';
// Job cards have child line tables, so they do not go through collectionRoutes();
// the module exports the same handler shapes regardless. Their writes are
// bespoke too: one operation moves the card, both line tables, stock, the
// ledger and an appointment link together.
import {
  listJobCards, getJobCard, createJobCard, updateJobCard, deleteJobCard,
  setJobCardStatus,
} from './routes/job-cards.js';
// Invoices have child line tables too, and their writes are copies rather
// than compositions: an invoice takes its figures and both line sets from a
// job card. Voiding is an action, not a field change -- it releases the
// invoice's payments as advances, which is audit Finding 7.
import {
  listInvoices, getInvoice,
  createInvoice, updateInvoice, deleteInvoice, voidInvoice,
} from './routes/invoices.js';
// Payments are the source of truth for an invoice's balance, so every write
// here recomputes that balance in the same batch. Linking an advance and
// voiding a payment are actions rather than field changes: each carries a
// rule -- overpayment, and what the invoice may then count -- that a PUT
// would let a caller bypass.
import {
  listPayments, getPayment,
  createPayment, updatePayment, deletePayment, voidPayment, linkPayment,
} from './routes/payments.js';
import {
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
} from './routes/expenses.js';
import {
  listInventoryTransactions, getInventoryTransaction, createInventoryTransaction,
} from './routes/inventory-transactions.js';
// Settings is a singleton the schema enforces (id INTEGER PRIMARY KEY
// CHECK (id = 1)), so it has no list and no addressable detail. It is
// dispatched directly below, beside /api/health, rather than joining
// COLLECTIONS — see routes/settings.js for why.
import { getSettings, updateSettings } from './routes/settings.js';
import { getWebsiteBookings } from './routes/website-bookings.js';

/**
 * Every collection exposes the same two shapes: a list at
 * /api/<name> and a detail at /api/<name>/<id>. Registering them
 * here keeps the path parsing in one place — adding a collection is
 * one line plus its route module, not another branch in the router.
 *
 * `create`/`update`/`remove` are optional. A collection that has them
 * accepts POST on its list path and PUT/DELETE on its detail path; one
 * that does not answers 405 there, with an Allow header naming only what
 * it really takes. The six simple entities have writes as of C-2,
 * appointments as of C-3, job cards as of C-5, invoices as of C-7 and
 * payments as of C-8. Every collection the app writes now has a write
 * path; settings is the one that does not, and C-9 owns it.
 *
 * `actions` is the one exception to "a collection is a list and a detail":
 * a named POST under a record, for a business operation that is not a
 * field change. C-6 added the first, because a job card's status is a
 * transition with its own rules, its own inventory effects and its own
 * appointment sync; C-7 added voiding an invoice, which cancels a
 * document while releasing its payments as advances; C-8 added voiding
 * and linking a payment, each of which moves an invoice's balance. All
 * are refused through PUT deliberately, so no rule has two homes.
 */
const COLLECTIONS = {
  customers: {
    list: listCustomers, detail: getCustomer,
    create: createCustomer, update: updateCustomer, remove: deleteCustomer,
  },
  vehicles: {
    list: listVehicles, detail: getVehicle,
    create: createVehicle, update: updateVehicle, remove: deleteVehicle,
  },
  services: {
    list: listServices, detail: getService,
    create: createService, update: updateService, remove: deleteService,
  },
  mechanics: {
    list: listMechanics, detail: getMechanic,
    create: createMechanic, update: updateMechanic, remove: deleteMechanic,
  },
  parts: {
    list: listParts, detail: getPart,
    create: createPart, update: updatePart, remove: deletePart,
  },
  appointments: {
    list: listAppointments, detail: getAppointment,
    create: createAppointment, update: updateAppointment, remove: deleteAppointment,
  },
  'job-cards': {
    list: listJobCards, detail: getJobCard,
    create: createJobCard, update: updateJobCard, remove: deleteJobCard,
    actions: { status: setJobCardStatus },
  },
  invoices: {
    list: listInvoices, detail: getInvoice,
    create: createInvoice, update: updateInvoice, remove: deleteInvoice,
    actions: { void: voidInvoice },
  },
  payments: {
    list: listPayments, detail: getPayment,
    create: createPayment, update: updatePayment, remove: deletePayment,
    actions: { void: voidPayment, link: linkPayment },
  },
  expenses: {
    list: listExpenses, detail: getExpense,
    create: createExpense, update: updateExpense, remove: deleteExpense,
  },
  // The ledger is append-only: a movement is recorded (POST) and never edited
  // or removed, so there is no update or remove here and none is advertised.
  'inventory-transactions': {
    list: listInventoryTransactions,
    detail: getInventoryTransaction,
    create: createInventoryTransaction,
  },
};

/** Methods a collection accepts on /api/<name> and on /api/<name>/:id. */
const listMethods = (c) => (c.create ? ['GET', 'POST'] : ['GET']);
const detailMethods = (c) => [
  'GET',
  ...(c.update ? ['PUT'] : []),
  ...(c.remove ? ['DELETE'] : []),
];

const ROUTES = [
  'GET /api/health',
  ...Object.entries(COLLECTIONS).flatMap(([name, c]) => [
    ...listMethods(c).map((m) => `${m} /api/${name}`),
    ...detailMethods(c).map((m) => `${m} /api/${name}/:id`),
    // An action is always a POST: it performs something, rather than
    // reading or replacing a field.
    ...Object.keys(c.actions ?? {}).map((a) => `POST /api/${name}/:id/${a}`),
  ]),
  // Two entries, not four: a singleton has nothing to address, and there is
  // no create or delete for a row that is permanently id 1. Listed last so
  // the advertised order stays the order the routes shipped in.
  'GET /api/settings',
  'PUT /api/settings',
  // Signing in and out. Public, necessarily: a browser with no credential
  // cannot ask for one through a gate that requires one.
  'GET /api/session',
  'POST /api/session',
  'DELETE /api/session',
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

// Helper to remove CSP header from response
function stripCSPHeaders(response) {
  if (!response.headers) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-security-policy');
  headers.delete('x-content-security-policy');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /**
     * Run a route handler, but only once the request has been authenticated.
     *
     * EVERY handler in this file is invoked through here, which is what makes
     * "is this route protected?" a property of the router rather than of each
     * route: no handler can be reached without passing checkAuth(), and a
     * route added later is protected the moment it is dispatched through this
     * function.
     *
     * C-12 made that apply to reads as well. The only routes that do not pass
     * through here are /api/health and /api/session, both dispatched below and
     * both public by necessity rather than by omission.
     *
     * The gate runs BEFORE the handler, so an unauthenticated caller cannot
     * cause a database read or a write, and cannot learn from a 404 whether a
     * record exists.
     */
    const run = async (handler, ...args) => {
      const denied = await checkAuth(request, env);
      if (denied) return denied;
      return handler(request, env, ...args);
    };

    // The Worker now shares its origin with the static app (see the assets
    // binding in wrangler.jsonc). Asset paths are served before this runs;
    // the bare root is the one path that matches no file, because
    // html_handling is "none" so that every other URL is served exactly as
    // the app asked for it.
    if (url.pathname === '/') {
      return Response.redirect(new URL('/index.html', url).toString(), 302);
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      // Health is a GET and stays public: it reads schema metadata, writes
      // nothing, and is what tells an operator the Worker is up.
      return health(env);
    }

    // Public, and dispatched before the gate: this is where a browser GETS
    // a credential, so requiring one here would be a closed loop. Each of the
    // three answers is written to give nothing away -- see routes/session.js.
    if (url.pathname === '/api/session') return session(request, env);

    // The exact path only. Anything below it (/api/settings/1, and there is
    // no other id a singleton could have) is left to fall through to the
    // 404 below rather than being handed to a detail handler that does not
    // exist — which is what keeps a trailing segment a clean 404 instead of
    // a TypeError.
    if (url.pathname === '/api/settings') {
      if (request.method === 'GET') return run(getSettings);
      if (request.method === 'PUT') return run(updateSettings);
      return methodNotAllowed(['GET', 'PUT']);
    }

    // PUBLIC proxy endpoint for website bookings (NO AUTH REQUIRED)
    if (url.pathname === '/api/website-bookings') {
      if (request.method === 'GET') {
        try {
          const websiteApiUrl = 'https://taqwa.blinto.workers.dev/api/bookings/list';
          const res = await fetch(websiteApiUrl);
          const data = await res.json();

          if (!res.ok) {
            return new Response(JSON.stringify({ error: 'Website API error', status: res.status }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          return stripCSPHeaders(new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        } catch (err) {
          console.error('Website bookings proxy error:', err.message);
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      return methodNotAllowed(['GET']);
    }

    const match = API_PATH.exec(url.pathname);
    if (match) {
      const [, name, rawId] = match;
      const collection = COLLECTIONS[name];

      if (collection) {
        // No trailing segment at all -> the list path.
        if (rawId === undefined) {
          if (request.method === 'GET') return run(collection.list, url);
          if (request.method === 'POST' && collection.create) {
            return run(collection.create);
          }
          return methodNotAllowed(listMethods(collection));
        }

        let id;
        try {
          // A malformed escape (%zz) throws rather than returning garbage.
          id = decodeURIComponent(rawId);
        } catch {
          return fail('invalid_id', 'Record id is not valid URL encoding.', 400);
        }

        // A named action under a record, e.g. /api/job-cards/JOB-0007/status.
        // Only an action the collection declares is routed; any other deep
        // path falls through to the id validator exactly as it did before,
        // so an unknown one stays a 400 rather than becoming a 404.
        const slash = id.indexOf('/');
        if (slash !== -1) {
          const action = collection.actions?.[id.slice(slash + 1)];
          if (action) {
            if (request.method !== 'POST') return methodNotAllowed(['POST']);
            return run(action, id.slice(0, slash));
          }
        }

        if (request.method === 'GET') return run(collection.detail, id);
        if (request.method === 'PUT' && collection.update) {
          return run(collection.update, id);
        }
        if (request.method === 'DELETE' && collection.remove) {
          return run(collection.remove, id);
        }
        return methodNotAllowed(detailMethods(collection));
      }
    }

    const response = notFound(ROUTES);
    return stripCSPHeaders(response);
  },
};
