# Taqwa Automobile Service Center — Car Service Management System

Management software for a car service centre: customers, vehicles, appointments,
job cards, invoices, payments, inventory, expenses and reports.

The **running application** is a static frontend — HTML5 + CSS3 + Vanilla
JavaScript (ES6+) — storing all of its data in the browser's `localStorage`.
A Cloudflare Worker + D1 backend is being built alongside it and is **not yet
wired into the UI**. See [Development Progress](#development-progress) for
exactly what exists today.

Live demo: https://mh-71.github.io/taqwa-car-service/

## Run it
No build step, no server required. Just open `index.html` in a browser.
(For best results, serve the folder, e.g. VS Code "Live Server", since some
browsers restrict localStorage on file:// URLs.)

## Structure
- `index.html` — Dashboard
- `pages/` — one HTML file per module (12 pages)
- `css/style.css` — design tokens, base, app shell (sidebar/header)
- `css/components.css` — cards, tables, badges, buttons, forms, modals, toasts
- `css/dashboard.css` — dashboard stats + pure-CSS revenue chart
- `css/responsive.css` — tablet/mobile + print
- `js/storage.js` — THE data layer. All persistence goes through here.
- `js/seed-data.js` — realistic demo data (loaded once on first run)
- `js/utils.js` — formatting, badges, toasts, lookups
- `js/app.js` — injects sidebar/header on every page, theme, mobile nav
- `js/dashboard.js` — dashboard page logic
- `js/<module>.js` — page logic, one module per page (customers, vehicles,
  appointments, job-cards, invoices, payments, inventory, expenses, mechanics,
  services, reports, settings)

Backend work, not loaded by the browser:

- `migrations/` — D1 schema
- `src/` — Cloudflare Worker API
- `tests/` — unit and integration suites

## Reset demo data
Run in the browser console:

    localStorage.clear(); location.reload();

## Backend migration path
UI code calls `Storage.getData / addData / updateData / deleteData` only.
Replace those function bodies with `fetch()` calls later — UI stays unchanged.
That swap has **not** happened yet; the frontend still makes no network calls.

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

## Phase B — Read-only API 🟡 In progress

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

- **Read-only.** Every route is a `GET`. Any other method returns `405`; no
  route in `src/` issues an `INSERT`, `UPDATE` or `DELETE`.
- **Not yet used by the UI.** The frontend still reads and writes
  `localStorage` exclusively.
- Eight flat collections are built from one shared factory
  (`src/lib/collection.js`); **Job Cards** and **Invoices** are written out by
  hand because they have child line tables.
- Every SQL parameter is bound — the browser never touches D1 directly.
- List endpoints take `limit` and `offset` (default 500, max 1000) and return a
  total count; an invalid value is a `400`, never a silent clamp.
- Query counts are bounded: a list costs 2 or 4 queries regardless of page size
  (child rows are fetched with chunked `IN (…)` batches that stay under
  SQLite's variable limit), a detail 1 or 3, a miss 1.
- Status codes in use: `200`, `400`, `404`, `405`, `503` (no database binding).

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
| Unit — 16 suites (`npm test`) | 2,079 | 0 |
| Integration — live Worker + local D1 (`npm run test:integration`) | 782 | 0 |
| **Total** | **2,861** | **0** |

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

See `tests/README.md` for the per-suite breakdown and how to add one.

## Git Workflow

- All backend work lives on the feature branch `claude/awesome-lamport-wbjyo7`
  — **13 commits**, one reviewed phase each.
- `main` is untouched by this work; nothing has been merged into it.
- No deployment has been made. `wrangler.jsonc` configures a local database
  only; the production binding stays commented out until a real database exists
  and a backup plan is in place.
- `--remote` is never used against D1.

## Next Steps

Planned, **not** yet implemented:

1. **Phase C — write endpoints.** `POST` / `PUT` / `DELETE` per collection,
   with server-side validation and the id-counter allocation the schema already
   provides.
2. **Authentication and authorisation** on the API before any write path is
   exposed.
3. **Swap the data layer.** Replace the bodies of
   `Storage.getData / addData / updateData / deleteData` with `fetch()` calls,
   leaving the UI unchanged.
4. **Production D1 + deployment,** once a database and a backup plan exist.

Known open item, carried forward deliberately: the existing frontend reads an
invoice's paid amount two different ways — `js/utils.js` trusts the stored value
while `js/reports.js` re-derives it from payments. The API reports the stored
row; reconciling the two readings is a frontend decision and is out of scope
until the write phase.
