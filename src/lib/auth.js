/* ============================================================
   auth.js — the bearer-token gate in front of every mutation
   ------------------------------------------------------------
   One rule, in one place: a request that changes data must carry
   `Authorization: Bearer <token>`, and the token must equal the
   Worker's own API_TOKEN secret.

   ---- what this deliberately is not ----

   No JWT, no sessions, no cookies, no OAuth, no roles, no token
   table. Rotating the secret is what invalidates the old token, so
   there is no state to revoke and nothing about a token is stored
   anywhere -- not in D1, not in localStorage, not in a log.

   ---- fail closed ----

   An unconfigured Worker refuses to write. `if (!env.API_TOKEN)
   allow everything` is the shape of bug that ships an open API the
   first time a secret is forgotten, so a missing secret is a
   SERVER configuration error (503) and never a pass. The only way
   a mutation succeeds is with a token that matches a secret that
   exists.

   Local tests supply that secret explicitly -- tests/integration/
   run.sh passes `--var API_TOKEN:...` with a value that is openly
   a test value -- so the tests authenticate the same way any other
   caller does, through the same code, rather than around it.

   ---- configuring the secret ----

   Nothing in this repository holds a real token, and nothing should.
   A deployment sets its own:

       wrangler secret put API_TOKEN          # deployed Worker
       echo 'API_TOKEN=<value>' > .dev.vars   # local dev, gitignored

   Rotating it is `wrangler secret put` again; the old token stops
   working on the next request.

   ---- what the client is told ----

   Missing header, malformed header and wrong token are all one
   answer: 401, the same message every time. A caller learns
   whether it is authenticated and nothing else -- not whether a
   token exists, not how long one should be, not what the secret is
   called. The token is never logged, never echoed and never put in
   a response.
   ============================================================ */

import { fail } from './http.js';

/** The methods that can change data. Everything else passes untouched. */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The scheme is case-insensitive per RFC 7235 and may be followed by more
// than one space; the TOKEN after it is matched exactly, and nothing about it
// is trimmed or normalised.
const BEARER = /^Bearer +(.+)$/i;

/**
 * Compare two tokens without leaking, through timing, how much of one matched.
 *
 * crypto.subtle.timingSafeEqual is a Workers extension and is present in this
 * runtime -- verified inside workerd, where it also THROWS on inputs of
 * different byte lengths ("Input buffers must have the same byte length"),
 * which is why the lengths are settled first. A length mismatch is decided
 * without it and without returning early on the first differing byte.
 *
 * The fallback loop exists so this module does not depend on a runtime
 * extension being present; it is the same accumulate-then-compare shape.
 */
function tokensMatch(supplied, expected) {
  const encoder = new TextEncoder();
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);

  if (a.length !== b.length) return false;
  if (a.length === 0) return false;

  if (typeof crypto?.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 401 — the one answer to every authentication failure.
 *
 * Deliberately identical whether the header was absent, the scheme was wrong
 * or the token simply did not match: telling those apart would tell a caller
 * something about the secret. `WWW-Authenticate` names the scheme, which is
 * what the header is for and reveals nothing.
 */
function unauthorized() {
  const res = fail('unauthorized', 'Authentication required.', 401);
  const headers = new Headers(res.headers);
  headers.set('www-authenticate', 'Bearer');
  return new Response(res.body, { status: 401, headers });
}

/**
 * Check a request's credentials.
 *
 * Returns a Response to REFUSE the request, or null to let it through. A
 * caller that gets null has been authenticated; a caller that gets a Response
 * must return it without touching the database.
 *
 * Non-mutating methods are not checked at all: reads and OPTIONS are public in
 * this phase, and OPTIONS in particular is a preflight rather than a business
 * operation.
 */
export function checkAuth(request, env) {
  if (!MUTATING_METHODS.has(request.method)) return null;

  const expected = env && typeof env.API_TOKEN === 'string' ? env.API_TOKEN.trim() : '';
  if (expected === '') {
    // Fail closed. The log names the binding so an operator can fix it; the
    // response says only that writes are unavailable.
    console.error('Refusing a write: no API_TOKEN is configured for this Worker.');
    return fail(
      'auth_not_configured',
      'Write access is not configured on this server.',
      503
    );
  }

  const header = request.headers.get('authorization');
  if (!header) return unauthorized();

  const match = BEARER.exec(header);
  if (!match) return unauthorized();

  return tokensMatch(match[1], expected) ? null : unauthorized();
}
