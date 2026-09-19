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

**With the local backend** — one command. The Worker serves the app *and* the
API from one origin:

```bash
npx wrangler dev --local \
  --var AUTH_PASSPHRASE:letmein --var AUTH_SECRET:any-long-random-string
```

Then open <http://localhost:8787> and sign in with that passphrase.

One origin is not a preference. The browser's credential is a session cookie,
and a cross-origin deployment cannot use one — a browser never attaches a
cookie to a CORS preflight, so every write would fail before it was sent.
Same-origin is what lets this Worker carry no CORS headers at all.

`npm run dev:app` (`tools/dev-server.mjs`) remains for the older split setup —
static files on :3000 proxying `/api` to `wrangler dev` on :8787 — which is
still same-origin from the browser's point of view. It is a development tool:
it is not deployed and the Worker does not know about it.

**Everything needs a credential**, reads included. Only `GET /api/health` and
`/api/session` are public. A browser signs in with the workshop passphrase; a
machine (CI, the integration suite) sends `Authorization: Bearer <API_TOKEN>`
instead. Nothing in this repository holds a real value for any of the three.

See [Authentication](#authentication) for the whole model.

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
- `_headers` — security headers and the CSP for the statically served app
- `DEPLOYMENT.md` — the ordered production checklist; nothing here is deployed
- `.dev.vars.example` — the secret NAMES a developer must set, and no values
- `tools/config-check.mjs` — offline validation of all of the above
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

**The sidebar says which one is live** — "Connected to the database", or "This
browser only" with an amber dot. When a Worker *was* addressable and did not
answer, the app also says so once, because that is the case where someone
would otherwise go on entering records that never leave their machine. A page
with no server to call (opened from disk, or the static demo) stays quiet:
that is the app working as designed.

**Reads are synchronous; writes are not.** 256 call sites read through
`getData`/`getById`, many per table row, so hydration pulls each collection
once into memory and the readers keep their signatures — the network is crossed
at startup, not per row. Writes return promises (`create`/`update`/`remove`),
because only the server knows whether a write was accepted and what the record
became; the cache is updated from the response, never from what was sent. The
old synchronous `addData`/`updateData`/`deleteData` still work without a
backend and refuse against one rather than write where nothing is reading.

**A write that succeeds while its re-read fails says so.** Each of those
transactions is followed by re-reading what the server also changed. If that
re-read fails the write still happened, so it is reported as a success
carrying `stale` and the user is told the page could not be refreshed —
rather than leaving a paid invoice displaying its old balance.

**Business transactions are one request, not several.** Recording a payment,
invoicing a job card, voiding either, and changing a job card's status each
move two or three tables. The Worker does each in a single transaction, so the
frontend makes one call and re-reads what it touched. It does not also perform
the second half: an invoice's `paid`/`due` and a part's `stock` are refused by
the API by name, because both are caches of a ledger rather than fields.

## Authentication

Every route requires a credential except two, and there are two kinds of
credential.

| | |
|---|---|
| **Browser** | A signed `taqwa_session` cookie, obtained by POSTing the workshop passphrase to `/api/session`. |
| **Machine** | `Authorization: Bearer <API_TOKEN>` — CI, the integration suite, anything that is not a person at a screen. |

Either satisfies the gate, for any method. **Reads are checked exactly as
writes are**: a customer list is the shop's book of names, phone numbers and
addresses, and there is no version of "public" that is right for it.

Public, by necessity rather than omission: `GET /api/health`, because it is how
an operator sees the Worker is up and it reads no business data; and
`/api/session`, because a browser with no credential cannot ask for one through
a gate that requires one.

**The cookie.** `v1.<expiry>.<HMAC-SHA256>`, signed with `AUTH_SECRET` over the
version and expiry. Nothing is stored anywhere — there is no session table, so
there is nothing to look up and nothing to leak. It carries no identity, because
there is none to carry. Flags: `HttpOnly` (script cannot read it, so an XSS
cannot steal it), `Secure`, `SameSite=Strict` (another site cannot make the
browser send it, which is what makes CSRF a non-event here), `Path=/`,
`Max-Age` of 12 hours.

**Fail closed.** A Worker with no credential configured refuses *everything*
but those two routes, with a 503. `if (!secret) allow` is the shape of bug that
ships an open database the first time a secret is forgotten.

**Refusals say nothing.** Missing, malformed, expired, tampered, and simply
wrong are one answer: 401, the same message every time — including a wrong
passphrase, which is deliberately indistinguishable from a server that has no
passphrase configured.

### What this model does not give you

One shared passphrase means **one shared identity**. There is no per-person
accountability: the log cannot say who voided the invoice. There is no
individual revocation either — because the cookie is signed rather than stored,
the server cannot end one person's session. Rotating `AUTH_SECRET` ends
everyone's at once, and that is the whole of revocation here.

That is a deliberate trade for a single workshop with a handful of staff, not
an oversight. If staff turnover or accountability matters, the model to move to
is per-user identity: either an edge SSO in front of the Worker, or a `users`
table with real sessions. Both were costed before this one was chosen.

### Configuring it

```bash
wrangler secret put AUTH_PASSPHRASE   # what staff type
wrangler secret put AUTH_SECRET       # signs the cookie; rotating it signs everyone out
wrangler secret put API_TOKEN         # optional: for CI and machine callers
```

Nothing in this repository holds a real value for any of them, and none is ever
written to the browser's storage, the page, or a log.

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

## Phase C-11 — Hardening ✅ Complete

No new capability; the C-10 architecture made safer to run. Four things it
did, and the reasons they mattered:

- **Duplicate submission.** Nine write paths still called an async function
  bare — six activate/deactivate row actions, and the status and void paths
  that move stock and release payments. The database refused every duplicate
  (a status gate matches once; a void invoice will not void twice), so
  nothing could be corrupted — but the dialog closed before the server
  answered, the button stayed live, and an unexpected throw was an unhandled
  rejection nobody saw. All nine now hold their own control until the server
  answers, through the same helper the other paths already used.
- **The silent fallback.** A Worker that was down at page load dropped the
  app to browser storage with no signal at all. See the sidebar note above.
- **The swallowed re-read.** Ten call sites ignored whether the re-read after
  a write had actually worked.
- **A blank page while hydrating,** now a brief loading state.

## Phase C-12 — Production authentication ✅ Complete

Reads and writes are now both protected, and a browser can hold a credential
safely. The architecture was chosen deliberately after costing three:
Cloudflare Access at the edge, application sessions with a users table, and
this one — a shared workshop passphrase exchanged for a signed cookie.

What changed:

- **`/api/session`** — sign in, sign out, and ask whether you are signed in.
- **The gate now covers every method.** `checkAuth` no longer waves GET
  through; the public surface is `health` and `session`, and nothing else.
- **No D1 change.** No users, no sessions, no passwords, no migration: the
  cookie is signed, not stored.
- **One origin.** The Worker serves the app as well as the API (the `assets`
  binding in `wrangler.jsonc`), because a session cookie cannot survive a
  cross-origin preflight. **No CORS headers are added, or needed.**
- **The frontend gained a locked state** — backend reachable, not signed in —
  which deliberately does *not* fall back to browser storage.

GitHub Pages cannot serve this app any more: it would be cross-origin to the
Worker, and the browser would never send the cookie. It remains useful as the
public `localStorage`-only demo it has always actually been.

## Phase C-13 — Security hardening ✅ Complete

A full audit across authentication, sessions, cookies, CSRF, CORS, input
validation, SQL, IDOR, mass assignment, error and log leakage, secrets, XSS,
URL handling and cache behaviour. Two things were wrong and are fixed; one
parser was lenient and is now strict; the rest was already sound and is left
alone.

- **API responses carried no `Cache-Control`.** An authenticated
  `GET /api/customers` returns names, phone numbers, addresses and the
  financial ledger, and a cacheable 200 is one the browser may keep after
  sign-out and any intermediary is free to store. Every API response now
  carries `no-store`, along with `nosniff`, `Referrer-Policy: no-referrer`
  and a frame refusal. `js/api.js` already asked for `cache: 'no-store'`, but
  that governs one client; the server has to be the one that says it.
- **The static app had no security headers.** `_headers` now serves a CSP
  that allows the app's one inline script **by hash** rather than with
  `'unsafe-inline'`, so script injection stays blocked. That script is the
  pre-paint theme bootstrap, byte-identical on all 13 pages. Verified in
  Chromium across eight pages, sign-in and a modal: zero CSP violations.
- **The cookie parser trimmed the value.** Not exploitable — a forgery still
  fails the signature — but a padded value is malformed per RFC 6265 and
  accepting it let this parser and an intermediary disagree about what the
  cookie said. It is strict now.

Verified sound and deliberately unchanged: `esc()` escapes all five
characters and every interpolation into `innerHTML` is either escaped or a
literal constant; no `eval`, `Function`, `document.write` or inline event
handler anywhere; URL parameters are id lookups, never HTML; SQL is
parameterised and raw SQLite text is never returned; server-owned fields
(`paid`, `due`, `stock`, `prevStock`, `newStock`, invoice totals, ids) are
refused by name; errors carry no stack, path, SQL or credential; logs are
fixed strings; and there is still no CORS, because the app and API share an
origin.

## Phase C-14 — Production configuration ✅ Complete

Configuration only. **Nothing was provisioned, no secret was created, and
nothing was deployed** — the point of the phase was to make a future
deployment safe and explicit, and to stop an accidental one.

The finding that mattered: a bare `wrangler deploy` would have published a
Worker bound to `taqwa-local (local-development-only)`. There was no
production environment at all — only a commented-out block from Phase A that
predated the assets binding and would not have worked if uncommented.

- **Two environments, deliberately hard to confuse.** The default is
  development and is now named `taqwa-api-dev`; production is `taqwa-api`
  under `--env production`. A deploy that forgets the flag publishes a
  different Worker with an unresolvable database id — two things have to go
  wrong, not one.
- **The production database id is an obvious placeholder**, not a
  UUID-shaped guess, so `--env production` fails loudly until someone runs
  `wrangler d1 create`. That is intended, not a bug.
- **`.env*` was not gitignored.** Wrangler 3 reads `.dev.vars`, but Wrangler 4
  and most tooling read `.env`, and a secret only has to be committable once.
- **`.assetsignore` did not exclude `DEPLOYMENT.md` or any secret file.**
  With `assets.directory` set to the repository root, that decides what the
  public site serves — a different guarantee from what git tracks, and it
  needed stating separately. Verified over HTTP: the app is served and
  nothing else is.
- **The wrangler floor was `^3.90.0`**, below the version that supports the
  assets binding this project now depends on.
- **[`DEPLOYMENT.md`](DEPLOYMENT.md)** is the ordered checklist: create the
  database, apply migrations, set the three secrets, configure the
  rate-limiting rule, deploy, verify. It also states what deploying still
  does not give you.
- **`npm run config:check`** validates all of it offline, and
  `npm run deploy:check[:prod]` shows what a deploy *would* bind without
  uploading anything.

## Production readiness — what is NOT done

Stated plainly so none of it is mistaken for finished:

| Item | Status |
|---|---|
| Authentication | **Implemented** (C-12), with one shared identity and no individual revocation — see [What this model does not give you](#what-this-model-does-not-give-you). |
| Read protection | **Implemented** (C-12). Only `health` and `session` are public. |
| CORS | **Not needed, and not added.** The app and API share an origin, which is what makes the session cookie work. A cross-origin deployment would need CORS *and* would break the cookie; it is not a supported shape. |
| Production D1 | **Does not exist.** The `production` environment is defined but its `database_id` is an explicit placeholder, so `--env production` fails until `wrangler d1 create taqwa-prod` has been run. |
| Production secrets | **Not created.** `AUTH_PASSPHRASE`, `AUTH_SECRET` and `API_TOKEN` must be set with `wrangler secret put --env production`. Names are documented in `.dev.vars.example`; no value is anywhere in this repository. |
| Deployment | **Never performed.** `npm run deploy:check:prod` is a dry run; the real command is in [DEPLOYMENT.md](DEPLOYMENT.md) and is typed deliberately. |
| Rate limiting on sign-in | **Not implemented, and not implementable here.** The passphrase comparison is constant-time and the refusal is generic, but nothing throttles repeated attempts. A Worker has no shared counter without D1, KV or Durable Objects, and an application-level limiter that resets with every isolate would be worse than none because it would look like protection. This belongs in a **Cloudflare rate-limiting rule in front of `POST /api/session`** — a production configuration task, deliberately not faked in code. |
| Security headers | **Implemented** (C-13). API responses carry `no-store`, `nosniff`, `Referrer-Policy` and a frame refusal; `_headers` serves a hash-based CSP for the static app. |
| `localStorage` → D1 migration | **Not implemented, deliberately.** Nothing is deleted or overwritten. |

The ordered steps are in **[DEPLOYMENT.md](DEPLOYMENT.md)**: create the
database, apply migrations, set the secrets, add the rate-limiting rule,
deploy, verify — plus a backup plan before there is data worth losing.

There is still no user or role concept in the schema. Every authenticated
caller can reach every record — that is the access model this workshop chose,
not a gap left in the implementation.

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
| Unit — 36 suites (`npm test`) | 5,633 | 0 |
| Integration — live Worker + local D1 (`npm run test:integration`) | 2,041 | 0 |
| **Total** | **7,674** | **0** |

```bash
npm test                  # no network, no Worker, no database — safe anywhere
npm run test:integration  # boots `wrangler dev` against the LOCAL D1 file
npm run config:check      # validates deployment configuration, offline
npm run deploy:check      # shows what a deploy WOULD bind; uploads nothing
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
- **The frontend's own suites** (`api-client`, `storage-adapter`, `d1-writes`,
  `write-safety`, `app-shell`) drive the real `js/api.js`, `js/storage.js`,
  `js/utils.js` and `js/app.js` with `fetch` faked, and assert what would have
  gone over the wire — which is how "a read carries no credential", "the
  balance is never computed in the browser" and "a double click sends one
  request" are checked rather than assumed.

See `tests/README.md` for the per-suite breakdown and how to add one.

## Git Workflow

- Each phase is one reviewed commit. C-1 … C-13 are merged to `main`; C-14 is
  on `claude/c14-production-configuration`.
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
