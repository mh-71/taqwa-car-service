# Deploying

**Nothing in this repository has been deployed.** The production Worker does
not exist and no production secret has been set. One resource does exist: the
production D1 database `taqwa-prod` has been created and migrated, and
`wrangler.jsonc` carries its id — so for this account steps 1 and 2 are already
done. The file stays a complete checklist for any account; every step is a
command a person runs deliberately, not something the repository does on its
own.

Read it in order. Step 3 is the first one that makes the app reachable, and the
secrets deliberately come **after** it rather than before — the note in step 3
explains why, and why the Worker answers 503 in between.

---

## What production looks like

```
browser ──► one Worker ──► static app (assets)  +  /api (routes) ──► D1
```

One origin, by design. The browser's credential is a `taqwa_session` cookie,
and a browser never attaches a cookie to a CORS preflight — so a split
frontend/API deployment would fail every write before sending it. Same-origin
is also why this project has no CORS headers and no origin allow-list.

**GitHub Pages is not this.** It cannot serve an authenticated app for exactly
that reason. It stays as the public `localStorage`-only demo it already is, and
nothing here changes or removes it.

---

## Environments

`wrangler.jsonc` has two, and they are deliberately not interchangeable:

| | Default (no `--env`) | `--env production` |
|---|---|---|
| Worker name | `taqwa-api-dev` | `taqwa-api` |
| D1 | `taqwa-local` / `local-development-only` | `taqwa-prod` / the real id, in `wrangler.jsonc` |
| Used by | `wrangler dev`, the integration suite | deployment only |

Two consequences worth stating plainly:

- A **bare `wrangler deploy` cannot touch production.** It carries the
  development database id, which does not resolve, and it publishes under a
  different Worker name. Both have to be wrong for an accident to reach
  `taqwa-api`.
- `--env production` **resolves a real database now that step 1 is done.** The
  flag is live: it binds `taqwa-prod` and would publish `taqwa-api`. That makes
  `npm run deploy:check:prod` worth running before every use of it.

Check what either would bind, without uploading anything:

```bash
npm run deploy:check         # default environment
npm run deploy:check:prod    # production environment
```

---

## 1. Create the production database

```bash
npx wrangler d1 create taqwa-prod
```

Paste the id it prints over `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` in
`wrangler.jsonc` under `env.production`. A D1 database id is not a secret — it
identifies a database that only your account's Workers can bind — so it is fine
in the repository. Nothing else from this step is.

## 2. Apply the schema

```bash
npx wrangler d1 migrations apply taqwa-prod --remote
```

This is the **first and only** `--remote` command in this checklist. Everything
else in the project refuses `--remote` on purpose.

Take a backup plan seriously before there is data worth losing:

```bash
npx wrangler d1 export taqwa-prod --remote --output backup-$(date +%F).sql
```

`.gitignore` already keeps `backup*.sql` out of the repository — those files
contain real customer names, phone numbers, addresses and the full ledger.

## 3. Deploy

```bash
npm run deploy:check:prod    # confirm the bindings first
npx wrangler deploy --env production
```

The Worker serves the app and the API together. `.assetsignore` decides what is
published: `src/`, `tests/`, `migrations/`, `tools/`, `node_modules/` and the
config files are all excluded — verify with `npm run config:check`.

**Deploying comes before the secrets, and the order is not a preference.**
Secrets live on the Worker, so until this step has run there is nothing to
attach them to. `wrangler secret put` against a Worker that does not exist
answers with:

```
There doesn't seem to be a Worker called …
Do you want to create a new Worker with that name and add secrets to it?
```

Answering yes publishes an empty stub under the production name. Answer no,
deploy first, then set the secrets in step 4.

**Between this step and the next, the Worker refuses every request with HTTP
503.** That is `checkAuth` finding no credential configured and failing closed —
it refuses everyone rather than admitting anyone, and it reaches no database.
Expect it. It is not a broken deployment, and step 4 clears it.

## 4. Set the secrets

```bash
npx wrangler secret put AUTH_PASSPHRASE --env production
npx wrangler secret put AUTH_SECRET     --env production
npx wrangler secret put API_TOKEN       --env production   # optional
```

| Secret | Required? | What it is |
|---|---|---|
| `AUTH_PASSPHRASE` | **Yes** | What staff type on the sign-in screen. |
| `AUTH_SECRET` | **Yes** | Signs the session cookie. Long and random. **Rotating it signs everyone out** — that is the only revocation this model has. |
| `API_TOKEN` | Optional | The machine credential, for CI or scripts. Skip it if nothing non-browser calls the API. |

The passphrase and the secret only work as a pair: one without the other can
neither mint nor verify a session. With **neither** pair nor token configured,
the Worker refuses every request but `/api/health` and `/api/session` — it
fails closed rather than opening up.

**Never let a secret value be printed, echoed, logged, or written to a file.**
Run each command on its own and type or paste the value at the prompt it gives
you. Do not pipe one in: `echo <value> | wrangler secret put …` writes the
value into your shell history in cleartext. To check afterwards, use `wrangler
secret list --env production`, which returns names only — Cloudflare's API
cannot hand back a secret's value, to wrangler or to anyone else.

No value for any of these belongs in this repository, in `wrangler.jsonc`, in a
test, or in a log. `wrangler secret put` stores them in Cloudflare.

## 5. Rate-limit the sign-in route

**This is the one security control that cannot live in the code.** A Worker has
no shared counter without D1, KV or Durable Objects, and a limiter that resets
with every isolate would be worse than none, because it would look like
protection. So it is configured at the edge instead.

In the Cloudflare dashboard → **Security → WAF → Rate limiting rules**:

| Field | Value |
|---|---|
| When incoming requests match | `http.request.uri.path eq "/api/session"` and `http.request.method eq "POST"` |
| Characteristics | IP |
| Rate | a handful of requests per minute — low enough to stop guessing, high enough that a mistyped passphrase is not a lockout |
| Action | Block, or Managed Challenge |

**Why it matters here:** one shared passphrase protects the whole workshop's
data, the comparison is constant-time and the refusal is generic, but nothing
stops an attacker simply trying. Until this rule exists, that is the weakest
point in the deployment.

## 6. Verify, before telling anyone the URL

```bash
# Reads must be refused without a credential.
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-url>/api/customers   # expect 401

# Health is public, and says the schema is applied.
curl -s https://<worker-url>/api/health

# The security headers are really there.
curl -sD- -o /dev/null https://<worker-url>/api/health | grep -i -E 'cache-control|x-content-type|referrer-policy|x-frame'
curl -sD- -o /dev/null https://<worker-url>/index.html  | grep -i 'content-security-policy'
```

Then in a browser: the sign-in screen appears, a wrong passphrase is refused, a
right one signs in, and the session cookie shows `HttpOnly`, `Secure` and
`SameSite=Strict` in devtools.

---

## What this deployment still does not give you

None of these is fixed by deploying, and none should be described as solved:

- **One shared identity.** The log cannot say who voided the invoice.
- **No individual revocation.** The cookie is signed, not stored, so a single
  person's session cannot be ended. Rotating `AUTH_SECRET` ends everyone's.
- **No roles.** Every signed-in person can reach every record.
- **No `localStorage` → D1 migration.** A browser used offline keeps its own
  data; nothing moves it, and nothing deletes it.

Moving past the first three means per-user identity — an edge SSO in front of
the Worker, or a real `users` table — which is a schema and architecture
decision, not a configuration one.
