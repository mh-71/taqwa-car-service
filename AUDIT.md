# Taqwa Car Service — A-to-Z Audit

*Audit date: 17 September 2026 · Repository: mh-71/taqwa-car-service @ commit 68bdab4*

## Scope, method and verdict

This audit covers the **Taqwa Automobile Service Center** car service management system — the `mh-71/taqwa-car-service` repository at commit `68bdab4`. The app is a fully static, client-side build, so the repository *is* the website; there is no server tier to audit separately.

What was examined:

| Layer | Extent |
| --- | --- |
| Pages | 13 HTML files (1 dashboard + 12 modules) |
| Stylesheets | 4 files, ~25 KB |
| JavaScript | 17 modules, ~10,600 lines |
| Data model | 11 localStorage collections, plus settings and counters |
| Assets | 1 logo (57 KB) |

Every JavaScript module was read in full. Colour contrast was measured numerically rather than eyeballed, and the two most serious findings were reproduced in runnable scripts rather than inferred from reading.

**One gap worth stating plainly:** the live deployment at `mh-71.github.io/taqwa-car-service/` could not be fetched — this audit environment's network proxy blocks that domain. Everything below comes from source. Since the site is static and served straight from the repo, source and live site should be identical, but I could not confirm the deploy is actually up, nor inspect live response headers or caching.

### Verdict

This is a **well-built application with a serious accounting bug at its centre.**

The engineering quality is genuinely above average for a vanilla-JS project of this size. The storage layer is a clean seam with an honest backend-migration path, HTML escaping is applied with real discipline, and the historical-record protections around invoices and payments are carefully thought through. Someone took care here, and it shows in the comments as much as the code.

But the money does not reconcile. The Dashboard's "Total Due" and every customer's outstanding balance read from a field that stops being updated the moment an invoice exists — so a customer who pays in full still shows as owing money, permanently. For a workshop using this to decide who to chase for payment, that is the finding that matters most.

### Scorecard

| Area | Grade | Summary |
| --- | --- | --- |
| Architecture | **A−** | Clean storage seam, honest migration path, consistent module pattern |
| Financial correctness | **D** | Stale due balances; timezone-dependent "today" |
| Data integrity | **C+** | Strong referential guards, but silent write failures |
| Security (XSS) | **A−** | Escaping is disciplined and near-complete |
| Accessibility | **C−** | Fails WCAG AA on most text colours; no focus trap; no skip link |
| SEO / metadata | **F** | No descriptions, favicon, manifest, robots or social tags at all |
| Performance | **B+** | Small payload; some avoidable repeated lookups |
| Maintainability | **B** | Readable and well-commented, but heavy duplication and zero tests |

**14 findings** follow: 1 critical, 3 high, 6 medium, 4 low.

## How the app is built

No build step, no framework, no dependencies. Each page is a plain HTML document that declares itself via `<body data-page="..." data-root="...">`, loads four stylesheets and four shared scripts, then one page module. `app.js` injects the sidebar and header into every page at runtime, so the layout exists in exactly one place rather than being copy-pasted across 13 files. That is the right call and it was executed cleanly.

### The storage seam

`js/storage.js` is the best idea in the codebase. Every module reaches data through six functions — `getData`, `getById`, `addData`, `updateData`, `deleteData`, `saveData` — and nothing else touches `localStorage` directly. The file says so, and I verified it: across all 17 modules there is exactly **one** violation, in `seed-data.js:239`, which writes `taqwa_counters` with a raw `localStorage.setItem` instead of going through the layer.

The stated payoff is real: replacing those six function bodies with `fetch()` calls would move this to a backend without touching UI code. Few projects that claim this actually hold the line. This one nearly does.

### Data model

Eleven collections, each an array of records with human-readable sequential IDs (`JOB-0007`, `INV-0003`) generated from a persisted counter map:

| Collection | Role |
| --- | --- |
| `customers`, `vehicles`, `mechanics` | Parties and assets |
| `services`, `parts` | Catalogues |
| `appointments` | Bookings, with overlap detection |
| `jobCards` | The central operational record |
| `invoices`, `payments`, `expenses` | The financial ledger |
| `inventoryTransactions` | Stock movement audit trail |

### The intended money flow

The modules agree on a deliberate design, documented in the file headers:

1. A **Job Card** accumulates services, parts, labour and totals while work happens.
2. On Completed/Delivered, an **Invoice** snapshots those frozen numbers. Financial fields become immutable; only notes are editable; Void replaces deletion.
3. **Payments** are the source of truth for what has actually been collected. Every payment change recomputes its invoice's `paid`/`due`/`status` from scratch — never trusting a stored field.

This is a sound double-entry-ish design, and payments.js implements its half correctly. The problem is what happens to the Job Card's own `paid`/`due` fields once that handoff occurs — covered in the next section.

### Inventory engine

The stock logic in `utils.js` deserves specific credit. `Inventory.move()` validates before writing and never lets stock go negative; `deductForJob()` is idempotent so status ping-pong between *In Progress* and *Waiting for Parts* cannot double-deduct; and `reconcileJobInventory()` computes a full delta plan and validates **every** deduction against live stock before moving anything, so a shortage aborts the whole edit rather than half-applying it. That is careful transactional thinking in an environment that gives you no transactions.

## CRITICAL — Outstanding balances never go down

**Finding 1.** Once a Job Card has been invoiced, its `paid` and `due` fields are frozen — by design. But the Dashboard and the Customers and Vehicles pages all compute "Total Due" by summing those frozen fields. Payments never write back to Job Cards. The result: **a customer who settles their invoice in full continues to show an outstanding balance forever.**

### Where it breaks

`payments.js` states the rule in its own header, and honours it:

> Job Card's own paid/due fields are a frozen historical snapshot from before invoicing and are never read or written here.

That is a defensible design — *provided nothing else reads those fields as if they were live.* Three places do:

| File | Line | What it does |
| --- | --- | --- |
| `js/dashboard.js` | 38 | `totalDue` stat = sum of every Job Card's `due` |
| `js/customers.js` | 25–26 | Customer `totalPaid` / `totalDue` = sum of their Job Cards' `paid` / `due` |
| `js/vehicles.js` | 35–36 | Same, per vehicle |

Those figures surface in the Dashboard's "Total Due" card, the **Total Due** column of the customer table, and the Total Paid / Total Due tiles in each customer and vehicle detail view.

I confirmed by tracing every write: `updateData('jobCards', ...)` is called in exactly five places — twice in `invoices.js` (setting and clearing `invoiceId`) and three times in `job-cards.js` (edit, status change, unlink). **None of them touches `paid` or `due` after creation.**

### Reproduction

Using the shipped seed data — `JOB-0002` / `INV-0002`, total ৳ 4,935, ৳ 3,000 already paid — the customer pays the remaining ৳ 1,935 through the Payments module:

```
after seed                    JobCard.due= 1935  Invoice.due= 1935  Dashboard shows 1935
after customer pays in full   JobCard.due= 1935  Invoice.due=    0  Dashboard shows 1935
```

The invoice correctly flips to **Paid** with zero due. The Dashboard and the Customers table still report ৳ 1,935 outstanding for Karim Hossain — and always will.

### Why this is the top finding

The "Total Due" figure is what a workshop owner looks at to decide who owes money. This makes it monotonically increasing: it only ever grows, never falls, regardless of collections. Within a few months of real use the number is pure noise, and any customer who has ever had a balance is permanently flagged as a debtor. The **With due** filter on the Customers page has the same defect.

### Recommended fix

Don't sync the two copies — that reintroduces the drift the snapshot design was built to avoid. Instead, **derive the live balance where it is displayed.** Add one helper to `utils.js`:

```js
/** Live outstanding balance for a job: the invoice's due once invoiced,
    otherwise the job's own pre-invoice snapshot. */
function liveJobDue(job) {
  const inv = job.invoiceId ? Storage.getById('invoices', job.invoiceId) : null;
  if (inv && inv.status !== 'Void') return Number(inv.due) || 0;
  if (job.status === 'Cancelled') return 0;   // see Finding 6
  return Number(job.due) || 0;
}
```

Then replace the three `reduce` calls above with `sum(jobs.map(liveJobDue))`. A matching `liveJobPaid()` fixes Total Paid. This keeps the snapshot intact for history while making every displayed balance reflect reality.

**Effort:** roughly one hour, including checking each call site.

## HIGH — "Today" is computed in UTC, not local time

**Finding 2.** `Utils.todayStr()` — the definition of *today* used across the entire app — is built on `toISOString()`, which converts to UTC first:

```js
// js/utils.js:35
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
```

For any workshop not sitting on the UTC meridian, this returns the wrong calendar date for part of every day.

### Reproduction — Dhaka (UTC+6), the shop's actual timezone

```
local wall-clock       todayStr()    correct       agree?
2026-09-17 00:00       2026-09-16    2026-09-17    NO  <-- off by one day
2026-09-17 02:00       2026-09-16    2026-09-17    NO  <-- off by one day
2026-09-17 05:54       2026-09-16    2026-09-17    NO  <-- off by one day
2026-09-17 06:00       2026-09-17    2026-09-17    yes
2026-09-17 14:00       2026-09-17    2026-09-17    yes
```

East of UTC the app is wrong from midnight until 06:00 local — tolerable for a workshop that opens at nine, though an early shift or a late-night stocktake would land on the wrong day.

### Reproduction — New York (UTC−4), if this is ever deployed westward

```
local 2026-09-17 18:00 -> todayStr()=2026-09-17  ok
local 2026-09-17 20:00 -> todayStr()=2026-09-18  NO  <-- reports TOMORROW
local 2026-09-17 23:00 -> todayStr()=2026-09-18  NO  <-- reports TOMORROW
```

West of UTC it breaks during *working hours*. Every evening from 20:00, revenue is booked to tomorrow and "Today's Appointments" shows the wrong day.

### What it affects

- Dashboard: Today's Revenue, Today's Expenses, Today's Appointments, and the 7-day revenue chart (`dashboard.js:75` has the same `toISOString()` pattern in its bucket keys)
- Payments: Today's Collections
- Job Cards: the **Today** quick filter, and the default date on a new job card
- Appointments: default date, and the "tomorrow" helper at `appointments.js:71–72`
- Reports: **every** range — Today, Yesterday, This Week, This Month, Last Month all anchor on `Utils.todayStr()`

The Reports module is worth calling out. Its header states:

> Date range helpers — all local-time based, never `toISOString()`, to avoid the classic UTC-shift-by-one-day bug on computed boundaries.

Its *own* helpers (`parseLocalDate`, `toDateStr`, `addDays`) are indeed correct local-time code. But they all take their starting point from `Utils.todayStr()`, so the bug walks in through the front door anyway. The author clearly knew about this class of bug and fixed it one layer too high.

### Recommended fix

One function, and everything downstream inherits the correction:

```js
// js/utils.js
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

Also fix the chart bucket keys in `dashboard.js:75` and the tomorrow helper in `appointments.js:72` to use the same local formatting. `seed-data.js` uses `toISOString()` too, but only to generate demo timestamps, which is harmless.

**Effort:** under 30 minutes. This is the highest value-per-line fix in the audit.

## Correctness and data integrity — findings 3 to 9

### Finding 3 (HIGH) — Storage write failures are silent

`storage.js` does the right thing at the bottom: `write()` wraps `localStorage.setItem` in try/catch, logs the error and returns `false`. But **no caller anywhere in the codebase checks that return value.** `addData`, `updateData`, `saveData` and `deleteData` all discard it, and every module proceeds to close the modal, re-render the list and show a success toast.

So when `localStorage` hits its quota — roughly 5–10 MB, reachable after a year or two of job cards with inspection checklists — the workshop sees *"Customer Rahim Ahmed added (CUS-0009)."* while nothing was saved. The record vanishes on the next render.

There is a sharper edge inside `addData`: it calls `generateId()`, which writes the counter map *first*, then writes the records. If the second write fails the counter has already advanced, so the ID is burned and the sequence develops a permanent gap.

**Fix:** propagate the boolean. Have `addData`/`updateData`/`deleteData` return `null`/`false` on write failure, and have each module show an error toast instead of a success one. A `Storage.estimateUsage()` helper plus a warning banner past ~80% capacity would be a sensible companion.

### Finding 4 (HIGH) — "System" theme flashes the wrong colours on every page load

Every page carries an inline pre-paint script to avoid a flash of the wrong theme:

```js
var t = JSON.parse(localStorage.getItem('taqwa_theme'));
if (t) document.documentElement.dataset.theme = t;
```

But Settings offers three choices — Light, Dark and **System** (`settings.html:142`) — and `App.applyTheme()` deliberately persists the literal string `'system'` so the preference survives. The pre-paint script doesn't know that. It sets `data-theme="system"`, and since the CSS only defines `:root[data-theme="dark"]`, the page renders **light** until `app.js` runs on `DOMContentLoaded` and resolves `system` → `dark`.

A user on System + dark OS gets a white flash on all 13 pages, every navigation — precisely the bug the script exists to prevent.

**Fix:** resolve `system` inside the inline script:

```js
var t = JSON.parse(localStorage.getItem('taqwa_theme'));
if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
if (t) document.documentElement.dataset.theme = t;
```

This is duplicated across 13 files, which is itself worth noting — see Finding 13.

### Finding 5 (MEDIUM) — Manual part entry is unreachable

The Job Card form headlines its parts section *"Parts Used (manual entry until Inventory module)"* (`job-cards.js:485`). Two problems:

1. The Inventory module **shipped** — the label is stale copy.
2. Manual entry does not work. A part line row contains a part `<select>`, a part-number input, quantity and unit price — **but no free-text field for the part's name.** I checked every input in `partLineHtml()`; there are four, and none is a name.

The reader logic expects one: `readLines()` falls back to `row.dataset.manualName` when no part is selected, but a newly added row is created with `data-manual-name=""`. So a line with no catalogue part selected gets an empty name, and `normalizeLines()` silently filters it out. The user fills in a quantity and price, saves, and the line disappears without a word.

**Fix:** either add a name input that writes back to `data-manual-name`, or drop the manual-entry pretence and require a catalogue part — and update the heading either way.

### Finding 6 (MEDIUM) — Cancelled job cards still count as money owed

`dashboard.js:38` sums `due` across **all** job cards with no status filter. A cancelled job keeps its recorded amounts "preserved for history" (correct), so its `due` keeps inflating Total Due. The same applies to customer and vehicle balances.

The `liveJobDue()` helper proposed in Finding 1 handles this with its `status === 'Cancelled'` guard.

### Finding 7 (MEDIUM) — Voiding an invoice leaves its payments active

`voidInvoice()` marks the invoice Void and clears the Job Card's `invoiceId`, but the payments recorded against it stay `Active`. Consequences:

- Payments' "Total Collected" and the Dashboard's "Today's Revenue" still count money against a cancelled invoice.
- Those payments are now orphaned — their `invoiceId` points at a Void record, and `recomputeInvoiceBalance()` explicitly skips Void invoices, so they can never be reconciled or re-linked.
- The Job Card becomes eligible for a corrected invoice, which will be created with `paid` copied from the Job Card's frozen snapshot — while the original payments still hang off the voided one.

**Fix:** when voiding an invoice, either void its linked payments too (with a confirmation naming them) or unlink them back to advances so they can be re-applied. Voiding an invoice that has payments should at minimum warn.

### Finding 8 (LOW) — Today's appointment list and count disagree

`dashboard.js:36` excludes Cancelled from the "Today's Appointments" *stat*, but `renderTodaysAppointments()` lists every appointment for today including Cancelled ones. The card says 3; the list below shows 4.

### Finding 9 (LOW) — Part names are recovered by parsing display text

`readLines()` recovers a part's name with `opt.textContent.split(' — stock:')[0]`, reverse-engineering it from the option label. Services do this properly, via a `data-name` attribute. Any part whose name happens to contain that separator would be silently truncated. Low likelihood, trivial fix: add `data-name` to part options as services already do.

## Accessibility — findings 10 and 11

The app gets the easy things right: `aria-label` on every icon button, `aria-hidden` on decorative SVGs, real `<label for>` on form fields, `:focus-visible` styling, and a `prefers-reduced-motion` block. That is more than most projects manage. The problems are in colour and in the modal.

### Finding 10 (HIGH) — The palette fails WCAG AA almost everywhere

I computed contrast ratios for every significant foreground/background pair in the design tokens. WCAG AA requires **4.5:1** for normal text and **3:1** for UI components and focus indicators.

| Pair | Ratio | AA text | Where it shows |
| --- | --- | --- | --- |
| `--text-3` `#8a97a6` on white | **2.98:1** | FAIL | `.cell-sub` (registration numbers), detail labels, `.muted-note` |
| `--text-3` on paper `#f2f4f7` | **2.70:1** | FAIL | Same, over the workspace background |
| `--amber` `#e59a17` on white | **2.34:1** | FAIL | Focus ring — also fails the 3:1 UI minimum |
| `--warn` on `--warn-soft` | **2.80:1** | FAIL | *Partial*, *Waiting for Parts* badges |
| `--amber-deep` on `--amber-soft` | **2.99:1** | FAIL | Avatar initials |
| `--good` on `--good-soft` | **3.06:1** | FAIL | *Paid*, *Completed*, *Delivered* badges |
| `--info` on `--info-soft` | **3.57:1** | FAIL | *In Progress*, *Confirmed* badges |
| `--bad` on `--bad-soft` | **3.75:1** | FAIL | *Unpaid*, *Cancelled* badges |
| `--info` link on white | **4.11:1** | FAIL | Every in-app link |
| `--text-2` on white | 5.47:1 | pass | Body secondary text |
| Sidebar text on `--ink-900` | 10.54:1 | pass | Navigation |

Dark mode is better but still short: `--text-3` reaches 3.54:1 and the soft badges land between 3.5 and 4.0.

Two things make this worse than the numbers suggest. First, badges render at `.72rem` (~11.5px), which is squarely "normal text" — the relaxed 3:1 large-text threshold does not apply. Status is the primary signal in this app, and it is the least legible thing on screen. Second, `.cell-sub` at 2.98:1 carries vehicle registration numbers under the vehicle name — real content, not decoration.

The focus ring at 2.34:1 is its own problem: it fails WCAG 2.2 SC 1.4.11, so keyboard users cannot reliably see where they are.

**Fix:** darken three tokens and the badge foregrounds. Rough targets: `--text-3` → about `#6b7888` (4.5:1 on white), focus ring → `--amber-deep` `#c47f06` or darker, and give badges a darker text variant rather than the same hue used for fills. This is a tokens-only change in `style.css` — no markup churn.

### Finding 11 (MEDIUM) — The modal is not a proper dialog

`Utils.Modal` sets `role="dialog"` and `aria-modal="true"`, focuses the first field on open, and restores focus on close. All good. But:

- **No focus trap.** Tab moves focus straight out of the modal and into the page behind it. A keyboard or screen-reader user can wander into the form underneath while a dialog is nominally modal. The whole app's data entry happens in these modals, so this affects every create, edit, view and delete flow.
- **The background is not inert.** `aria-modal="true"` tells some assistive tech to ignore the background, but nothing sets `inert` or `aria-hidden` on the app shell, so behaviour varies by AT.
- **Scroll-lock ownership is shared.** Both `app.js:130` (mobile drawer) and `utils.js:377/395` (modal) toggle `body.no-scroll`. Open the mobile menu, open a modal, close the modal — the lock is released while the drawer is still open, and the page scrolls behind it.

**Fix:** add a keydown handler that cycles Tab within the overlay, set `inert` on `.shell` while a modal is open, and make the scroll lock a counter rather than a boolean.

### Smaller accessibility gaps (LOW)

- **No skip link.** Every page injects a 13-item sidebar before the content; keyboard users tab through all of it on every page.
- **No `scope` attributes** on any `<th>` in any table. With 10-column tables of financial data this matters for screen-reader navigation.
- **No `aria-live` region.** Toasts carry `role="status"`, but they are appended to a host created on the fly — a region that appears at the same moment its content does is unreliably announced. Create the `.toast-host` up front with `aria-live="polite"`.
- **Table re-render is silent.** Typing in a search box rewrites the table body with no announcement of how many results matched, even though the count is displayed visually.

## Security

**This section is short because the code is good.** The app has no server, no authentication, no network calls and no third-party JavaScript. The attack surface is genuinely small, and the one real risk — cross-site scripting through user-entered data — has been handled with more discipline than most codebases show.

### XSS: audited and clean

Every module builds its DOM with `innerHTML` and template literals — 62 `innerHTML` assignments across 15 files. That pattern is usually where stored XSS lives. Here it doesn't, because `Utils.esc()` is applied consistently to every interpolation of user-controlled data.

I swept every template interpolation in every module and checked the unescaped ones by hand. The ones that came back unescaped fall into three safe categories:

- **Fixed internal constants** — icon paths, stat labels, status-transition labels, priority names, fuel-level labels. Developer-authored, never user-editable.
- **Search haystacks** — strings like `${c.name} ${c.phone}` built for `.toLowerCase().includes()`, never inserted into the DOM.
- **Values escaped one level up** — modal titles look unescaped at the call site but `Modal.open()` runs `esc(title)` on both the heading and the `aria-label`.

One case deserved a closer look and turned out fine: validation messages embed other records' names, e.g. `This phone number already belongs to ${dup.name}`. If those were injected as HTML that would be a stored-XSS vector. They are not — `showErrors()` assigns via `textContent`. Correct by construction.

The `esc()` implementation itself covers `& < > " '`, which is the right set for both text nodes and quoted attributes.

**No XSS findings.** That is a real result, not a skipped section.

### Finding 12 (MEDIUM, by context) — Business data sits unencrypted with no access control

All customer names, phone numbers, addresses, emails, vehicle VINs, mechanic salaries and the complete financial ledger live in plaintext `localStorage` on whatever machine runs the app. There is no login, no user accounts, no audit of *who* did anything — only *what* changed and when.

Whether that matters depends entirely on deployment:

| Deployment | Risk |
| --- | --- |
| One office PC, one trusted operator | Acceptable. This is a desktop tool that happens to run in a browser. |
| Shared or public machine | Anyone who opens the browser has full read/write access to customer PII and payroll. |
| Currently: public GitHub Pages URL | The *code* is public, not the data — each visitor gets their own empty localStorage seeded with demo records. No real data is exposed today. |

The important thing to be clear about: **hosting on GitHub Pages does not leak business data.** Each browser holds its own copy. But it also means there is no shared state — two staff on two computers have two entirely separate, silently diverging databases. That is a functional limit as much as a security one.

**Recommendations, proportional to use:**

- If it stays single-machine: document that the browser profile *is* the database, and make Export Data a scheduled habit. Clearing site data destroys everything.
- If more than one person needs it: this needs the backend the storage layer was already designed for. The seam is there; use it.
- Either way: mechanic salary and commission data is the most sensitive field set in the app and currently sits alongside everything else with no distinction.

### Finding 13 (LOW) — No backup safety net

Export Data works and produces a complete JSON dump. But **import is deliberately not implemented** — `settings.js` explains the reasoning honestly: validating an arbitrary JSON file across 11 collections and their cross-references needs a real validation layer, and a shallow check risks silent corruption.

That reasoning is sound. The consequence is not: the app has a backup button and no restore button. An export you cannot import is a comfort blanket, not a backup. Worth either building the validating importer or saying plainly in the UI that exports are for archival and external analysis only.

## SEO, metadata and deployment

### Finding 14 (MEDIUM) — The metadata layer is entirely absent

I checked all 13 pages. Between them they contain `<meta charset>`, `<meta name="viewport">`, `<title>` and `<html lang="en">`. That is the complete list. Missing everywhere:

| Tag | Status | Consequence |
| --- | --- | --- |
| `<meta name="description">` | absent on all 13 | Search engines and link previews invent their own snippet |
| Favicon | no file, no `<link rel="icon">` | 404 on every page load; generic tab icon |
| `<link rel="canonical">` | absent | — |
| Open Graph / Twitter cards | absent | Sharing the URL in WhatsApp or Messenger produces a bare link — relevant if this is ever shown to clients |
| `<meta name="theme-color">` | absent | No browser-chrome tinting on mobile |
| `robots.txt` | no file | — |
| `sitemap.xml` | no file | — |
| Web app manifest | no file | Cannot be installed to a phone home screen |

**How much this matters depends on intent**, and the two readings point in different directions:

- **As an internal workshop tool**, SEO is close to irrelevant — nobody is searching for it. But a favicon, a theme colour and a manifest are still worth having: they are what make it feel like an application rather than a web page, and a manifest with `display: standalone` would let staff pin it to a phone home screen and run it without browser chrome. For a shop-floor tool on a tablet, that is a genuine usability win for about twenty minutes of work.
- **As a portfolio piece or a public demo** — which the GitHub Pages URL in the README suggests — the missing description and Open Graph tags are a real loss. Anyone sharing the link gets no preview, and search engines have nothing to work with.

The titles themselves are good: `Dashboard — Taqwa Automobile Service Center` follows the right page-then-site pattern already.

**Fix:** a description per page, one favicon (the existing logo cropped), a `site.webmanifest`, and one set of Open Graph tags on `index.html`. Under an hour total.

### Deployment notes

The README points to `https://mh-71.github.io/taqwa-car-service/`. I could not reach it — this audit environment's proxy blocks that domain — so I could not verify the deploy is live or inspect live headers. Worth confirming yourself.

A few things I can say from the repo:

- **No `.github/` directory**, so there is no Actions workflow. Deployment is presumably GitHub Pages' built-in branch publishing, which is fine for a static site.
- **No `.gitignore`.** Nothing in this project generates artefacts today, so nothing is currently at risk of being committed by accident — but the moment anyone runs `npm init` for a linter or a test runner, `node_modules/` will land in the repo. Worth adding pre-emptively.
- **The README's "open `index.html` in a browser" advice is slightly wrong.** It says some browsers restrict localStorage on `file://` URLs. The stronger reason to serve the folder is that `file://` origins vary by browser, and the app's entire state is origin-scoped — a shop that opens the file directly on two different browsers gets two different databases with no warning. The recommendation to use a local server is right; the reason given undersells it.
- **Cache headers** are GitHub Pages' defaults. Since the CSS and JS filenames are unversioned, a returning user can be served stale JavaScript after a deploy. For a tool where a bug fix needs to actually reach the workshop, a cache-busting query string on the script tags (`?v=2`) is a cheap insurance policy.

## Performance and code quality

### Performance: fine today, with one structural risk

Payload per page load:

| Resource | Size |
| --- | --- |
| 4 stylesheets (all loaded on every page) | ~25 KB |
| 4 shared scripts (`seed-data`, `storage`, `utils`, `app`) | ~57 KB |
| Page module | 9–71 KB (`job-cards.js` is the largest) |
| Logo PNG | 57 KB |
| Google Fonts (IBM Plex Sans, 4 weights) | external, render-blocking |

Total is roughly 150–200 KB uncompressed, which is a non-issue. Two small observations: `seed-data.js` (~11 KB) loads on every page but is only ever used on first run, and the 57 KB PNG logo displays at 132px wide — a properly sized WebP would be under 5 KB. The Google Fonts stylesheet is the only render-blocking external request; the `preconnect` hints are already correctly in place.

**The structural risk** is the read pattern. Every `Storage.getById()` call does a full `JSON.parse` of the entire collection followed by a linear `find`. Rendering the Job Cards table calls it repeatedly per row — customer name, phone, vehicle, mechanic — so drawing 50 rows parses and scans the customers array ~100 times, the vehicles array ~100 times, and so on. With demo-scale data this is invisible. With two years of real job cards it will become a noticeable lag on every keystroke in the search box, because `renderList()` runs on every `input` event with no debounce.

`reports.js` already solves this correctly, building `Map` lookups once per render and documenting why. **That pattern should be promoted into `utils.js` and reused by the list renderers.** Adding a ~200ms debounce on the search inputs is a second cheap win.

### Code quality

**The good:** consistent IIFE module pattern, consistent naming, genuinely useful comments that explain *why* rather than *what*, and validation applied before every write with totals always recomputed rather than trusted from the UI. The file headers in `invoices.js`, `payments.js` and `settings.js` document design decisions and the reasoning behind rejected alternatives — that is rare and valuable.

**The duplication** is the main maintainability cost. There is no shared list/table/CRUD abstraction, so each of the nine list modules reimplements the same shape:

- `renderStats()` — 9 near-identical implementations, each with its own inline SVG path strings
- The safe-lookup block (`custName`, `custPhone`, `vehText`, `vehReg`) — copy-pasted verbatim into 5 modules
- Filter/sort/search/empty-state/`bindEvents` scaffolding — repeated in all nine
- The pre-paint theme script — duplicated across all 13 HTML files (and therefore the Finding 4 bug must be fixed in 13 places)
- Print-area rendering — four separate implementations sharing the same layout

A `ListPage` helper taking a config object would likely remove 2,000–3,000 lines. That is a refactor, not a fix, and it should come **after** the correctness work — but it is the difference between this codebase staying pleasant and becoming a chore.

### No tests, no linting, no CI

There is no `package.json`, no test file, no linter config and no `.github/` workflow. For a project that computes tax, discounts, running balances and inventory deltas, the absence of even a handful of unit tests around `computeTotals()`, `deriveStatus()` and `Inventory.reconcileJobInventory()` is the single biggest reason bugs like Finding 1 can live in an otherwise careful codebase.

Those three functions are pure and already isolated — they would be straightforward to test today with no refactoring.

### Dead code and stale comments

- **`reminderSent`** exists on every appointment record and is written as `false` on create. Nothing ever reads or updates it. There is no reminder feature — the field is a promise the app doesn't keep.
- **Mechanic `salary`, `salaryType` and `commissionRate`** are captured, validated and displayed, but never used in any calculation. Commission never appears in Reports, and payroll never reaches Expenses. A mechanic on 5% commission generating ৳ 200,000 of work produces no figure anywhere.
- **`"(manual entry until Inventory module)"`** — the Inventory module shipped (Finding 5).
- **Workshop Defaults** (opening/closing time, working days, default appointment duration) are stored but never enforced by Appointments or Job Cards. To the app's credit, the Settings UI says so plainly rather than pretending otherwise.
- **`seed-data.js:239`** bypasses the storage layer with a direct `localStorage.setItem`.

## What's genuinely good

Audits skew negative by construction. These are the parts worth protecting through any refactor, because they represent real judgement rather than boilerplate.

**The storage seam actually holds.** Plenty of projects claim a data-access layer and then leak `localStorage` calls through the UI. This one has exactly one violation in 10,600 lines. The stated backend-migration path — swap six function bodies for `fetch()` — is real, not aspirational.

**Escaping discipline is near-perfect.** 62 `innerHTML` assignments and no XSS. That does not happen by accident; it happens because someone applied a rule consistently even when it was tedious.

**The inventory engine is properly transactional.** `reconcileJobInventory()` builds a complete delta plan, validates *every* deduction against live stock, and only then writes — so a shortage on the third part aborts the whole edit instead of leaving the first two applied. `deductForJob()` is idempotent against the transaction ledger, so bouncing a job between *In Progress* and *Waiting for Parts* can't double-deduct. `returnForJob()` reads outstanding balances from the ledger rather than the job's current line items, so it stays correct even if the parts list was edited after issuance. This is the kind of reasoning most small apps skip entirely.

**Historical records are protected deliberately.** Invoices freeze their financial fields at creation and expose Void instead of edit. Payments lock amount, date and method and expose Void instead of delete. Deletion is gated behind real guards — you cannot delete a customer with vehicles, a job card with an invoice, a completed job card, or an active invoice. Line items snapshot their name and price so catalogue changes never rewrite history. That is bookkeeping done the way bookkeeping should be done.

**Payments recompute rather than trust.** Every payment change recalculates the invoice's balance from the sum of non-void payments rather than incrementing a stored field. This is exactly the right instinct — which is what makes Finding 1 so frustrating: the same instinct was not applied to the three places that read job-card balances.

**Status transitions are a real state machine.** `TRANSITIONS` defines legal moves explicitly and `changeStatus()` rejects anything else, rather than letting any status become any other.

**The comments explain decisions, not syntax.** `settings.js` documents why an ID-prefix setting was rejected (it would look like it controlled numbering without doing so) and why import isn't implemented. `invoices.js` explains why Void invoices are excluded from the reverse lookup. Future maintainers — including future you — will be glad of these.

**The seed data is well-judged.** Realistic Bangladeshi names, plausible vehicles and registrations, dates generated relative to today so the dashboard is never empty, and — importantly — structurally identical to what the live code produces, with comments explaining where shapes were normalised to match. Demo data that diverges from real data shape is a classic source of phantom bugs; this avoids it.

## Remediation plan

Ordered by value per hour of work, not by severity alone.

### Ship now — about a day

These are correctness bugs a workshop would actually feel. Nothing here is a refactor.

| # | Fix | Files | Effort |
| --- | --- | --- | --- |
| 2 | Local-time `todayStr()` + chart bucket keys + tomorrow helper | `utils.js`, `dashboard.js`, `appointments.js` | 30 min |
| 1 | `liveJobDue()` / `liveJobPaid()` helpers; use them for all balance displays | `utils.js`, `dashboard.js`, `customers.js`, `vehicles.js` | 1 hr |
| 6 | Exclude Cancelled jobs from balances (folds into Finding 1's helper) | — | included above |
| 4 | Resolve `system` in the pre-paint theme script | 13 HTML files | 30 min |
| 3 | Propagate storage write failures; error toast instead of success | `storage.js` + 9 modules | 2 hr |
| 5 | Fix or remove manual part entry; update the stale heading | `job-cards.js` | 1 hr |
| 8 | Exclude Cancelled from today's appointment list | `dashboard.js` | 5 min |

**Findings 2 and 1 are the two that matter.** If only ninety minutes are available, do those and stop — they are the difference between figures that can be trusted and figures that cannot.

### Next — about two days

| # | Fix | Why |
| --- | --- | --- |
| 10 | Darken `--text-3`, the focus ring, and badge foregrounds to meet WCAG AA | Tokens-only change; status badges are the app's primary signal and currently the least legible thing on screen |
| 11 | Focus trap in `Utils.Modal`; `inert` on the shell; counter-based scroll lock | Every data-entry flow goes through this modal |
| 7 | Decide what voiding an invoice does to its payments — then implement it | Currently leaves orphaned payments counted as revenue |
| 14 | Favicon, per-page descriptions, `site.webmanifest`, Open Graph on `index.html` | ~1 hr; makes it installable on a shop-floor tablet |
| — | Unit tests for `computeTotals`, `deriveStatus`, `reconcileJobInventory` | All three are pure and testable today |
| — | `Map` lookups in list renderers; debounce search inputs | Copy the pattern `reports.js` already uses |
| — | Add `.gitignore`; cache-bust script tags | Cheap insurance |
| 9 | `data-name` on part options | 5 min |

### Later — decisions, not fixes

These need a call from you before any code gets written.

**Is this one machine or several?** It is the question the rest depends on. Today the app is a single-browser database with no shared state, no login and no audit of who did what. If two people need it, the storage layer is already shaped for a backend and that work should start rather than be simulated with exports. If it stays on one machine, say so in the README and make Export Data a weekly habit — clearing site data destroys everything, and there is no import (Finding 13).

**Should the export be importable?** `settings.js` rejected import for a defensible reason — shallow validation risks silent corruption. But a backup button with no restore button is not a backup. Either build the validating importer or relabel the feature honestly.

**Do the payroll fields mean anything?** Mechanic salary, salary type and commission rate are captured and validated but feed no calculation anywhere. Either wire commission into Reports and payroll into Expenses, or drop the fields. Same question for `reminderSent`, which no feature reads.

**Is the duplication worth paying down?** A `ListPage` abstraction would likely remove 2,000–3,000 lines across the nine list modules. That is real value if this keeps growing, and unnecessary churn if it is feature-complete. Worth deciding deliberately rather than by default — but do it *after* the correctness work, never alongside it.

### One thing to do before any of it

Write tests for `computeTotals()` and the balance helpers **first**. Finding 1 survived in an otherwise careful codebase precisely because nothing asserted that a paid invoice produces a zero balance everywhere it is displayed. Fixing the bug without adding that assertion invites it back.
