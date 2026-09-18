# Tests

Two kinds, deliberately separated by what they need to run.

| | needs | command |
|---|---|---|
| `tests/unit/` | nothing — no network, no Worker, no database | `npm test` |
| `tests/integration/` | `wrangler dev` + the **local** D1 file | `npm run test:integration` |

`npm test` is safe to run anywhere, including CI with no Cloudflare account.

## Unit suites — `tests/unit/`

| Suite | Covers |
|---|---|
| `api-customers.test.mjs` | `GET /api/customers[/:id]` |
| `api-vehicles.test.mjs` | `GET /api/vehicles[/:id]` |
| `api-services.test.mjs` | `GET /api/services[/:id]`, plus the one exact check of the full route list |
| `api-mechanics.test.mjs` | `GET /api/mechanics[/:id]`, including the null-versus-zero rule for salary and commission |
| `api-parts.test.mjs` | `GET /api/parts[/:id]`, including that stock is read from the column and never derived from the ledger |
| `api-appointments.test.mjs` | `GET /api/appointments[/:id]`, including that references stay as ids, all five sources and six statuses round-trip verbatim, and date/time are never converted |
| `api-job-cards.test.mjs` | `GET /api/job-cards[/:id]`, including child line tables, historical snapshots, `paid`/`due` staying snapshots, checklist JSON handling and the bounded-query/variable-limit rules |
| `api-invoices.test.mjs` | `GET /api/invoices[/:id]`, including billed snapshots, stored money reported without consulting payments, and Void invoices keeping their frozen figures |
| `api-payments.test.mjs` | `GET /api/payments[/:id]`, including the four reference combinations, advance vs voided vs released-advance, and that a GET never reaches into invoices |
| `api-expenses.test.mjs` | `GET /api/expenses[/:id]`, including that Void rows are returned rather than filtered, no aggregate is invented, and an unconstrained category round-trips |
| `api-settings.test.mjs` | `GET /api/settings`, the one singleton: an object rather than a one-element array, no paging metadata, a missing row reported rather than defaulted, falsy values surviving, and a trailing segment staying a clean 404 |
| `finding1.test.cjs` | Audit Finding 1 — outstanding balances follow payments |
| `finding2.test.cjs` | Audit Finding 2 — `todayStr()` uses the local calendar, not UTC |
| `finding7.test.cjs` | Audit Finding 7 — voiding an invoice releases its payments |
| `finding7-ui.test.cjs` | Finding 7's two void dialogs |
| `appointment-source.test.cjs` | The five canonical appointment sources, end to end |
| `regression.test.cjs` | Seed data and totals are unchanged by any of the above |

Two styles, for two different things:

- **`.test.mjs`** import the real Worker from `src/` and call it with a stubbed
  D1 binding that records every `prepare()`/`bind()`. They assert on the SQL
  that would be sent, so they catch an unparameterised query without a database.
- **`.test.cjs`** boot the real shipped `js/` modules inside a Node VM with the
  minimum `localStorage` and DOM they touch (`tests/lib/harness.cjs`). Nothing
  is copied or re-implemented: a change to `js/utils.js` is felt here directly.
  They are CommonJS because the harness predates this package's `"type":
  "module"`; the `.cjs` extension is what keeps `require()` working.

Each suite prints its own `PASS`/`FAIL` lines, ends with
`<label>: N passed, M failed`, and exits non-zero if anything failed.
`tests/run-unit.mjs` spawns each one in its own process — the `.cjs` suites set
`process.env.TZ`, which would leak between suites otherwise — and adds up the
totals. Use `node tests/run-unit.mjs --verbose` to see every assertion.

### Adding a suite

Drop a file in `tests/unit/` named `<name>.test.mjs` or `<name>.test.cjs`.
The runner discovers it — there is no list to update. Print a final
`<label>: N passed, M failed` line and `process.exit(fail ? 1 : 0)`.

For a new collection's API suite, copy `api-appointments.test.mjs`: it is the
newest one built on the shared factory in `src/lib/collection.js` and exercises
it most fully. For a collection with child line tables, copy
`api-job-cards.test.mjs` instead — that route is written out by hand and its
suite has a stub that dispatches by table.
Assert only your own collection's routes. The single exact full-route-list
check is kept in `api-services.test.mjs` — one designated suite, so adding a
collection means editing two lines in one file rather than every suite.

## Integration suite — `tests/integration/`

`run.sh` starts the Worker, seeds fixtures, runs `api.test.mjs` over real
HTTP against the real local D1, then removes the fixtures and stops the Worker.

**Local only, by construction.** Every `wrangler` call passes `--local`;
`--remote` is rejected outright; the binding is `taqwa-local`, whose
`database_id` is the `local-development-only` placeholder; nothing deploys.

Three safeguards worth knowing about:

1. **It refuses to run** unless `services`, `customers` and `vehicles` are all
   empty. The suite asserts exact row counts, and this also means it can never
   delete a row it did not insert.
2. **Cleanup runs from an `EXIT` trap**, so fixtures are removed even when a
   test fails or the run is interrupted — then it verifies none are left.
3. **A 5xx from the Worker fails the run**, even if every assertion passed.

Fixture ids live in the `9xxx` range (`SRV-9001`, `CUS-9001`, `VEH-9001`, …),
which `id_counters` will not reach until a collection passes 9000 records.

First run needs the schema:

```bash
npm run db:migrate:local     # once
npm run test:integration
PORT=8788 npm run test:integration   # if 8787 is busy
```
