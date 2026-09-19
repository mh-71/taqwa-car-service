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
| `api-inventory-transactions.test.mjs` | `GET /api/inventory-transactions[/:id]`, including that the ledger is history rather than a balance, no aggregate or per-part rollup is invented, snapshots are returned as stored, and `unitCost` keeps null apart from zero |
| `api-appointments-write.test.mjs` | `POST`/`PUT`/`DELETE /api/appointments` — overlap scoped to the same mechanic **or** the same vehicle on the half-open interval, duplicate bookings, status transitions out of a terminal status, and the three delete blockers, none of which is a foreign key |
| `api-inventory-transactions-write.test.mjs` | `POST /api/inventory-transactions` — that no SELECT of the stock precedes the write, that both batch statements carry the same `stock + delta >= 0` guard, that direction is derived from the type server-side, and that `prevStock`/`newStock` are computed in SQL rather than bound |
| `api-job-cards-write.test.mjs` | `POST`/`PUT`/`DELETE /api/job-cards` — that totals are recomputed from the lines rather than taken from the body, that a create moves no stock because a new job card is `Received`, that an edit reconciles against the **ledger** and only for the two statuses where stock has already moved, that `prevStock`/`newStock` are read from the live row in SQL, and that status, appointment, invoice, `completedAt` and `actualDelivery` are immutable here |
| `api-job-cards-status.test.mjs` | `POST /api/job-cards/:id/status` — every transition the source's table lists and every one it does not, same-status and terminal protection, that entering In Progress issues a part line in full but skips one the job has ever been issued, that Waiting for Parts moves nothing, that cancelling returns only what the ledger still shows outstanding, the server-set `completedAt`/`actualDelivery`, and the one-way appointment sync |
| `api-invoices-write.test.mjs` | `POST`/`PUT`/`DELETE /api/invoices` and `POST /api/invoices/:id/void` — that an invoice is **copied** from a job card rather than composed (every figure refused by name), that eligibility follows the client's own order and wording, that voiding writes only the status so `paid`/`due` stay frozen, that it releases each linked **Active** payment to an advance inheriting the invoice's job card while leaving a **Void** one untouched — audit Finding 7 — and that nothing in the module reads or writes stock |
| `api-payments-write.test.mjs` | `POST`/`PUT`/`DELETE /api/payments` and `POST /api/payments/:id/{void,link}` — that the overpayment rule **is** the INSERT's `WHERE` rather than a JavaScript check, that the balance is recomputed by one UPDATE whose arithmetic is `recomputeInvoiceBalance()`'s and which never touches a Void invoice, that an advance touches no invoice at all, that only `notes` is editable, and that no statement anywhere names `job_cards` |
| `write-crud.test.mjs` | `POST`/`PUT`/`DELETE` for the six simple entities — that PUT merges rather than replaces, that `stock` is writable nowhere on parts, that an active expense must be voided before it can be deleted, and that a referenced row's 409 comes from the schema's own foreign key |
| `write-foundation.test.mjs` | `src/lib/write.js` and the two new `http.js` helpers — body parsing, the four field primitives, id formatting, the 409/422 responses, the constraint→status mapping, and the Asia/Dhaka date rule that audit Finding 2 turns on |
| `api-settings.test.mjs` | `GET /api/settings`, the one singleton: an object rather than a one-element array, no paging metadata, a missing row reported rather than defaulted, falsy values surviving, and a trailing segment staying a clean 404 |
| `api-settings-write.test.mjs` | `PUT /api/settings` — that a body is **merged** into the stored row so an omitted key keeps its value, that the three server-owned fields (`id`, `updatedAt`, `theme`) are refused by name because theme stays browser state, that every validation message is the client's own wording, that a first save creates row 1 rather than 404ing, and that the merge path is a plain `UPDATE` because an UPSERT would trip the `NOT NULL` columns |
| `api-auth.test.mjs` | `src/lib/auth.js` and the gate in `src/index.js` — that every refusal is byte-identical whatever went wrong, that a missing `API_TOKEN` fails **closed** with 503 rather than opening the Worker, and a route-registry-derived enumeration proving every advertised mutation is 401 without a token and reaches no database statement, while every `GET`, `/api/health` included, stays public |
| `api-session.test.mjs` | The signed session cookie against the real Worker — that the right passphrase is the only thing that mints one and a wrong one is answered exactly like every other refusal, that the value carries no identity and no secret, that `HttpOnly`/`Secure`/`SameSite=Strict`/`Max-Age` are all set, that eight ways of forging or stretching a cookie are each a 401 that never reaches the database, that an expired one is refused, that signing out is unconditional so it cannot be used to detect a session, and that an unconfigured Worker refuses reads as well as writes |
| `api-client.test.cjs` | `js/api.js` — where the base URL comes from (override, meta tag, same origin, and `null` on `file://`), that the bearer token goes on mutations and **never** on a read, that a write with no token is refused before anything is sent, the mapping of every status the API returns onto a stable code, and that neither a stack trace, a request URL nor the token itself can reach the caller |
| `storage-adapter.test.cjs` | `js/storage.js` — choosing between D1 and `localStorage` and never flipping after, that one collection failing to load keeps the whole app in local mode rather than half-hydrated, paging past the 1000-row cap, that the cache is updated from the **response** so the server's id and totals win, that the synchronous writers refuse rather than write where nothing is reading, settings merge semantics, and that theme, seeding and reset stay browser-local |
| `d1-writes.test.cjs` | The five multi-table transactions driven against a backend — that recording a payment is one `POST` which never sends `paid`/`due` and never writes the invoice, that invoicing a job card sends only the date and the note because every figure is refused by name, that voiding either uses its named action and releases payments server-side (Finding 7), and that a stock movement never sends `prevStock`/`newStock` nor writes `parts.stock` |
| `write-safety.test.cjs` | The three failure modes a write only acquired once it crossed a network — that a second click while the first request is in flight is swallowed by the disabled control rather than sent, that an unexpected throw still re-enables the control and is reported rather than eaten, and that a write which succeeds while the re-read after it fails is reported as a **success carrying `stale`** rather than as either a failure or a silently out-of-date screen |
| `app-shell.test.cjs` | What the shell says about where the data is — that a page with no server to call stays quiet, that a server which *was* addressable and did not answer produces a warning naming no URL or internal detail, that a hydration failing part-way falls back rather than showing half a database, and that the footer names the live source either way |
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
  From C-10 the harness also loads `js/api.js` and accepts a `fetch` stub and an
  `origin`; a suite that passes neither gets no origin, so `Storage` settles in
  `local` mode and behaves exactly as it did before there was an API.
  `tests/lib/fake-api.cjs` is the in-memory stand-in for the Worker that the
  three frontend suites talk to — it answers with the API's envelopes and
  allocates ids the way the server does, but it is not a second implementation
  of the API's rules: what each route may REFUSE is tested against the real
  Worker in `tests/integration/`.
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
4. **`id_counters` must total 0 both before and after.** From C-2 the suite
   POSTs real records, whose ids are allocated rather than chosen and so fall
   outside the `9%` range. The preflight therefore also requires every counter
   to start at 0; that is what makes `cleanup.sql` safe to reset them, and to
   sweep any real-id row an interrupted write test left behind. Both are
   restoring the state the run found, never rewinding a real sequence.

`run.sh` has a second phase after the API suite: `foundation-worker.mjs`
is a **test-only Worker entry**, started on `PORT + 1` against the same
local D1. It exists because `env.DB.batch()` rollback and concurrent
`UPDATE ... RETURNING` allocation are D1's behaviour rather than ours, and
no API route reaches them. It is never registered in `src/index.js` and
never deployed. Its rows use the `SRV-98xx` / `VEH-989x` / `PRT-98xx` /
`STK-98xx` range, which the existing `9%` cleanup already covers. C-4 added a
second reason for it: the inventory movement's two-statement batch has to be
shown rolling back when either half fails, and a route that returns 409
cleanly can never demonstrate that.

C-8 added a sixth: a payment and its invoice's balance move in one batch, and
the probe forces a statement to fail after both have applied, shows an
overpayment guard matching nothing leaving the balance untouched, and shows a
Void invoice refusing to be recomputed at all.

C-7 added a fifth: the create batch and the void batch each have to be shown
failing part-way. The route's own checks stop both before the batch exists, so
the probe forces a child line to break a foreign key mid-create, a statement to
fail *after* the payments have been released, and a second live invoice to hit
`ux_invoices_live_job_card` — then shows a void gate that matches nothing
leaving the payments and the job card alone.

C-6 added a fourth: a status transition's dependent statements are guarded on
the status gate having matched, and a gate that matches nothing has to be shown
leaving the stock, the ledger and the appointment alone — which no API response
can distinguish from a transition that never ran. The probe also forces a
failure *after* the stock has moved, and shows the deduction's own `NOT EXISTS`
refusing a second issue even when the gate would have let it through.

C-5 added a third reason: a job card write moves the parent, both line tables,
`parts.stock` and the ledger in one batch, and the route's own pre-check stops a
shortage *before* the batch is built — so the API can never be made to show what
happens when a statement **after** a stock movement fails. The probe does that
directly, and also proves the reconciliation guard: a movement planned against a
stale issued balance produces a `NULL` quantity, whose `NOT NULL` rolls the whole
batch back. That is what stops a concurrent edit deducting the same units twice.

C-9 added a **third phase**, which needs no probe Worker: `run.sh` starts a
third Worker on `PORT + 2` with no `API_TOKEN` at all, and asserts that reads
still answer while every mutation is refused — with a token and without one —
with a 503 that names a server configuration problem and names no secret, and
that nothing reached the database. The two earlier phases pass `--var
API_TOKEN:...` with a throwaway literal; no real token is in the repository.

Fixture ids live in the `9xxx` range (`SRV-9001`, `CUS-9001`, `VEH-9001`, …),
which `id_counters` will not reach until a collection passes 9000 records.

`JOB-9005` is there for C-5 specifically. Reconciliation only happens for a job
card that has already started issuing stock, and the write API deliberately does
not change status (C-6 owns that) — so a job card the suite creates could never
reach that path, and two of them could never be made to contend for the same
part. Two fixtures already `In Progress` is what makes that test possible.

First run needs the schema:

```bash
npm run db:migrate:local     # once
npm run test:integration
PORT=8788 npm run test:integration   # if 8787 is busy
```
