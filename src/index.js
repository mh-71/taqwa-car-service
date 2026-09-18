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
// the module exports the same two handler shapes regardless.
import { listJobCards, getJobCard } from './routes/job-cards.js';
import { listInvoices, getInvoice } from './routes/invoices.js';
import { listPayments, getPayment } from './routes/payments.js';
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
import { getSettings } from './routes/settings.js';

/**
 * Every collection exposes the same two shapes: a list at
 * /api/<name> and a detail at /api/<name>/<id>. Registering them
 * here keeps the path parsing in one place — adding a collection is
 * one line plus its route module, not another branch in the router.
 *
 * `create`/`update`/`remove` are optional. A collection that has them
 * accepts POST on its list path and PUT/DELETE on its detail path; one
 * that does not answers 405 there, with an Allow header naming only what
 * it really takes. The six simple entities have writes as of C-2;
 * appointments, job cards, invoices, payments and the ledger are still
 * read-only because their writes carry business logic that belongs in
 * their own phases.
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
  'job-cards': { list: listJobCards, detail: getJobCard },
  invoices: { list: listInvoices, detail: getInvoice },
  payments: { list: listPayments, detail: getPayment },
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
  ]),
  // One entry, not two: a singleton has nothing to address. Listed last so
  // the advertised order stays the order the routes shipped in.
  'GET /api/settings',
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

    // The exact path only. Anything below it (/api/settings/1, and there is
    // no other id a singleton could have) is left to fall through to the
    // 404 below rather than being handed to a detail handler that does not
    // exist — which is what keeps a trailing segment a clean 404 instead of
    // a TypeError.
    if (url.pathname === '/api/settings') {
      return getSettings(request, env);
    }

    const match = API_PATH.exec(url.pathname);
    if (match) {
      const [, name, rawId] = match;
      const collection = COLLECTIONS[name];

      if (collection) {
        // No trailing segment at all -> the list path.
        if (rawId === undefined) {
          if (request.method === 'GET') return collection.list(request, env, url);
          if (request.method === 'POST' && collection.create) {
            return collection.create(request, env);
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

        if (request.method === 'GET') return collection.detail(request, env, id);
        if (request.method === 'PUT' && collection.update) {
          return collection.update(request, env, id);
        }
        if (request.method === 'DELETE' && collection.remove) {
          return collection.remove(request, env, id);
        }
        return methodNotAllowed(detailMethods(collection));
      }
    }

    return notFound(ROUTES);
  },
};
