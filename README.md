# Taqwa Automobile Service Center — Car Service Management System

Management software for a car service centre: customers, vehicles, appointments,
job cards, invoices, payments, inventory, expenses and reports.

The **running application** is a static frontend — HTML5 + CSS3 + Vanilla
JavaScript (ES6+). It reads and writes through one data layer, `js/storage.js`,
which now has two sources: a **Cloudflare Worker + D1** backend when one is
reachable, and the browser's `localStorage` when there is not. See
[Development Progress](#development-progress) for exactly what exists today.

Live demo: https://mh-71.github.io/taqwa-car-service/ — a static host with no
Worker behind it, so it runs on `localStorage`, as it always has.

## Run it

**Without a backend** — no build step, no server. Open `index.html` in a
browser. (For best results serve the folder, e.g. VS Code "Live Server", since
some browsers restrict localStorage on `file://` URLs.) The app seeds demo data
on first run and keeps everything in that browser.

**With the local backend** — two terminals:

```bash
npm run dev          # 1. the Worker + local D1 on :8787
npm run dev:app      # 2. the app on :3000, proxying /api to the Worker
```

Then open <http://localhost:3000>. The app asks `GET /api/health` once at
startup; if it answers, D1 is the source of truth for this session.

`npm run dev:app` (`tools/dev-server.mjs`) exists so the app and the API share
one origin. That is what lets the browser reach `/api` with no CORS headers on
the Worker and no origin allow-list to keep in step. It is a development tool:
it is not deployed and the Worker does not know about it.

**Writes need a token.** Reads are public; every mutation needs the Worker's
`API_TOKEN`. Nothing in this repository holds one and nothing stores one in the
browser — supply it at runtime, once per page, from the console:

```js
Api.configure({ token: '<the API_TOKEN the Worker was started with>' })
```

See [Authentication boundary](#authentication-boundary) for why it works this
way and what a real deployment would need instead.

## Structure
- `index.html` — Dashboard
- `pages/` — one HTML file per module (12 pages)
- `css/style.css` — design tokens, base, app shell (sidebar/header)
- `css/components.css` — cards, tables, badges, buttons, forms, modals, toasts
- `css/dashboard.css` — dashboard stats + pure-CSS revenue chart
- `css/responsive.css` — tablet/mobile + print
- `js/storage.js` — THE data layer. All persistence goes through here.
- `js/api.js` — the only file that speaks HTTP: base URL, bearer token, errors
- `js/seed-data.js` — realistic demo data (loaded once on first run, no backend)
- `js/utils.js` — formatting, badges, toasts, lookups
- `js/app.js` — injects sidebar/header on every page, theme, mobile nav
- `js/dashboard.js` — dashboard page logic
- `js/<module>.js` — page logic, one module per page (customers, vehicles,
  appointments, job-cards, invoices, payments, inventory, expenses, mechanics,
  services, reports, settings)

Backend work, not loaded by the browser:

- `migrations/` — D1 schema
- `src/` — Cloudflare Worker API
- `tools/dev-server.mjs` — development only: serves the app and proxies `/api`
- `tests/` — unit and integration suites

## Reset demo data
Run in the browser console:

    localStorage.clear(); location.reload();

This resets the **browser's** demo data. It does nothing to D1: there is no
seed or reset endpoint, and Settings' "Reset to Seed Data" refuses when the app
is running against a database.

## Frontend data architecture

```
UI modules  (unchanged: still call getData / getById / create / update / remove)
    |
js/storage.js ── reads ──> in-memory cache, filled once at startup
    |          ── writes ─> js/api.js ──> Worker ──> D1
    |
    └── no backend? ──────> localStorage, exactly as before
```

**Which source is authoritative, per kind of data:**

| Data | Source of truth |
|---|---|
| The eleven business collections and settings | **D1**, whenever a Worker answers |
| The same, with no Worker reachable | `localStorage` |
| Theme (`taqwa_theme`) | **Always the browser.** Per device, never in D1 |
| `taqwa_seeded`, `taqwa_counters` | The browser's own no-backend bookkeeping |
| The API token | **Memory only.** Never localStorage, sessionStorage or git |

The mode is decided once, at startup, and does not flip under a running page.
The two never write to each other, so they cannot silently diverge.

**Reads are synchronous; writes are not.** 256 call sites read through
`getData`/`getById`, many per table row, so hydration pulls each collection
once into memory and the readers keep their signatures — the network is crossed
at startup, not per row. Writes return promises (`create`/`update`/`remove`),
because only the server knows whether a write was accepted and what the record
became; the cache is updated from the response, never from what was sent. The
old synchronous `addData`/`updateData`/`deleteData` still work without a
backend and refuse against one rather than write where nothing is reading.

**Business transactions are one request, not several.** Recording a payment,
invoicing a job card, voiding either, and changing a job card's status each
move two or three tables. The Worker does each in a single transaction, so the
frontend makes one call and re-reads what it touched. It does not also perform
the second half: an invoice's `paid`/`due` and a part's `stock` are refused by
the API by name, because both are caches of a ledger rather than fields.

## Authentication boundary

The Worker protects every mutation with one shared bearer token (`API_TOKEN`);
`GET` is public. That token authorises **every write on every record**, and the
schema has no users, sessions or roles — it is a machine credential.

This frontend is a static site. It has no server-side component, so it has
nowhere to keep a secret: anything it can send, a visitor can read. The token
is therefore never committed, never written to `localStorage` or
`sessionStorage`, and never logged; it is supplied at runtime with
`Api.configure({ token })` and lives in memory for that page only. A reload
clears it.

**That is a development posture, not a production one.** It is fine for a
developer driving a local Worker. It is not an authentication design for a
deployed multi-user install, which needs an identity the browser is allowed to
have — edge SSO in front of the Worker (no application changes, and it would
also close the public-read exposure), or real sessions with the app served from
the Worker itself. That is a deployment decision and has not been made.

---

## Development Progress

Migration of the data layer from `localStorage` to **Cloudflare D1**, behind a
**Cloudflare Worker** API. The work is done in small reviewed phases, each one
verified and committed separately.

Everything below runs against a **local** database only (`wrangler dev`
/ `--local`). No production D1 database exists, nothing has been deployed, and
the live demo above is unaffected.

## Phase A — Schema and infrastructure ✅ Complete

| Item | Status |
|---|---|
| D1 schema — 17 tables, 42 indexes (`migrations/0001_initial_schema.sql`, 556 lines) | ✅ |
| Worker project + local-only `wrangler.jsonc` (production binding deliberately left unconfigured) | ✅ |
| `GET /api/health` — reports Worker status and whether the D1 binding answers | ✅ |
| Shared HTTP layer (`src/lib/http.js`) — uniform success/error envelopes, id and integer validation | ✅ |

Schema notes: snake_case columns mapped to camelCase in the API, partial unique
indexes for the business rules that need them, `DEFERRABLE INITIALLY DEFERRED`
foreign keys where two tables reference each other (job cards ↔ appointments,
job cards ↔ invoices), and a generated `customers.phone_digits` column for
phone lookups.

## Phase B — Read-only API ✅ Complete

Ten collections are exposed, delivered in eleven reviewed steps (B-1 … B-11).
With `GET /api/health` that is **21 routes**, all of them `GET`.

| # | Collection | Routes | Status |
|---|---|---|---|
| B-1 · B-2 | Customers | `/api/customers`, `/api/customers/:id` | ✅ |
| B-3 | Vehicles | `/api/vehicles`, `/api/vehicles/:id` | ✅ |
| B-4 | Services | `/api/services`, `/api/services/:id` | ✅ |
| B-5 | Mechanics | `/api/mechanics`, `/api/mechanics/:id` | ✅ |
| B-6 | Parts / Inventory | `/api/parts`, `/api/parts/:id` | ✅ |
| B-7 | Appointments | `/api/appointments`, `/api/appointments/:id` | ✅ |
| B-8 | Job Cards | `/api/job-cards`, `/api/job-cards/:id` | ✅ |
| B-9 | Invoices | `/api/invoices`, `/api/invoices/:id` | ✅ |
| B-10 | Payments | `/api/payments`, `/api/payments/:id` | ✅ |
| B-11 | Expenses | `/api/expenses`, `/api/expenses/:id` | ✅ |

What these routes do and do not do:

- **Read-only when they shipped.** Every route in Phase B was a `GET`; the
  writes arrived in Phase C, below.
- **Used by the UI as of C-10.** `js/storage.js` hydrates from these routes at
  startup when a Worker answers, and falls back to `localStorage` when none
  does.
- Eight flat collections are built from one shared factory
  (`src/lib/collection.js`); **Job Cards** and **Invoices** are written out by
  hand because they have child line tables.
- Every SQL parameter is bound — the browser never touches D1 directly.
- List endpoints take `limit` and `offset` (default 500, max 1000) and return a
  total count; an invalid value is a `400`, never a silent clamp.
- Query counts are bounded: a list costs 2 or 4 queries regardless of page size
  (child rows are fetched with chunked `IN (…)` batches that stay under
  SQLite's variable limit), a detail 1 or 3, a miss 1.
- Status codes in use at this point: `200`, `400`, `404`, `405`, `503` (no
  database binding). Phase C added `201`, `401`, `409` and `422`.

## Phase C — Write API and the frontend swap ✅ Complete

Writes were added collection by collection (C-1 … C-9), then the frontend was
moved onto them (C-10). **60 routes**: 24 `GET`, 15 `POST`, 11 `PUT`,
10 `DELETE`.

| Entity | `GET` | `POST` | `PUT` | `DELETE` | Actions |
|---|:-:|:-:|:-:|:-:|---|
| Customers, Vehicles, Services, Mechanics, Parts, Expenses | ✅ | ✅ | ✅ | ✅ | |
| Appointments | ✅ | ✅ | ✅ | ✅ | |
| Job Cards | ✅ | ✅ | ✅ | ✅ | `:id/status` |
| Invoices | ✅ | ✅ | ✅ | ✅ | `:id/void` |
| Payments | ✅ | ✅ | ✅ | ✅ | `:id/void`, `:id/link` |
| Inventory transactions | ✅ | ✅ | — | — | *ledger is append-only* |
| Settings | ✅ | — | ✅ | — | *singleton, merge semantics* |

Every mutation needs `Authorization: Bearer <API_TOKEN>`, and a Worker with no
token configured refuses all of them with a 503 rather than becoming an open
API. `GET` is public.

**C-10** wired the frontend to all of it: `js/api.js`, hydration and an
in-memory cache inside `js/storage.js`, and the write paths of all thirteen UI
modules moved onto the API. No visual change, no schema change, no deployment.

## Business Logic Already Covered

The API preserves the existing application's semantics rather than inventing
new ones. Behaviour deliberately encoded and tested:

- **Snapshot vs. live money.** A job card's `paid` / `due` are frozen at the
  moment of invoicing and are reported as stored. An invoice's balance is
  maintained from its payments.
- **Void keeps its figures.** A voided invoice retains its frozen totals and
  releases its payments; a released advance still carries its original invoice
  id. All three lookalike payment states (linked, advance, released) round-trip
  distinctly.
- **Stock is stored, not derived.** `parts.stock` is the authoritative balance.
  The API reads the column and never re-sums the inventory ledger, so no second
  source of truth is introduced.
- **Historical snapshots stay historical.** Job card and invoice lines report
  the price captured at the time of service, not today's catalogue price.
- **Appointment sources and statuses round-trip verbatim** — no normalising,
  inferring or suffixing of the five canonical sources or six statuses.
- **Dates use the local calendar, not UTC** (a previously fixed audit finding,
  covered by a regression test so it cannot silently return).
- **Nothing is filtered behind the caller's back.** Void expenses are returned,
  not hidden; references stay as ids rather than being pre-joined.
- **`null` and `0` stay distinct** (e.g. a mechanic's salary and commission).

## Testing

A permanent suite lives in `tests/`. Latest full run:

| Suite | Assertions | Failures |
|---|---|---|
| Unit — 31 suites (`npm test`) | 5,382 | 0 |
| Integration — live Worker + local D1 (`npm run test:integration`) | 2,008 | 0 |
| **Total** | **7,390** | **0** |

```bash
npm test                  # no network, no Worker, no database — safe anywhere
npm run test:integration  # boots `wrangler dev` against the LOCAL D1 file
```

- **Unit `.test.mjs`** import the real Worker and call it with a stubbed D1
  binding that records every `prepare()` / `bind()`, so they assert on the SQL
  that would be sent — an unparameterised query fails without a database.
- **Unit `.test.cjs`** boot the real shipped `js/` modules inside a Node VM with
  the minimum `localStorage` and DOM they touch. Nothing is re-implemented, so a
  change to `js/utils.js` is felt directly.
- **Integration** seeds fixture rows, exercises the routes over HTTP, and
  removes them again. It refuses `--remote`, refuses to start unless the fixture
  tables are empty, never deletes pre-existing rows, and verifies cleanup on
  exit.
- **The frontend's own suites** (`api-client`, `storage-adapter`, `d1-writes`)
  drive the real `js/api.js` and `js/storage.js` with `fetch` faked, and assert
  what would have gone over the wire — which is how "a read carries no
  credential" and "the balance is never computed in the browser" are checked
  rather than assumed.

See `tests/README.md` for the per-suite breakdown and how to add one.

## Git Workflow

- Each phase is one reviewed commit. C-1 … C-9 were developed on
  `claude/awesome-lamport-wbjyo7` and merged to `main`; C-10 is on
  `claude/c10-frontend-storage-d1`.
- No deployment has been made. `wrangler.jsonc` configures a local database
  only; the production binding stays commented out until a real database exists
  and a backup plan is in place.
- `--remote` is never used against D1.

## Next Steps

Planned, **not** yet implemented:

1. **An authentication design that suits a deployment.** The current shared
   token is a machine credential a static frontend cannot hold safely; see
   [Authentication boundary](#authentication-boundary). Until that is settled,
   the frontend integration is a local-development posture.
2. **Read protection.** All 24 `GET` routes are public by design. That is
   harmless while nothing is deployed; a reachable Worker holding real records
   would expose customer names, phones, addresses and the financial ledger to
   anyone with the URL.
3. **Production D1 + deployment,** once a database and a backup plan exist.
4. **A migration path for existing browser data.** Nothing moves `localStorage`
   records into D1 today, and nothing deletes them: a browser that has been
   used offline keeps its data untouched, and a database is populated through
   the API. Importing one into the other is unimplemented on purpose — matching
   records without duplicating or overwriting them needs rules nobody has
   specified.

Known open item, carried forward deliberately: the frontend reads an invoice's
paid amount two different ways — `js/utils.js` trusts the stored value while
`js/reports.js` re-derives it from payments. The API reports the stored row,
which the payment write keeps in step with the payments; reconciling the two
readings in the UI remains a frontend decision and is still out of scope.
