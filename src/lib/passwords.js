/* ============================================================
   passwords.js — hashing and checking account passwords
   ------------------------------------------------------------
   PBKDF2-HMAC-SHA256 through the runtime's WebCrypto (crypto.subtle),
   the standard key-derivation function Workers provide natively. No
   library and no home-made scheme: a random 16-byte salt per password,
   100,000 iterations (the most the Workers runtime accepts for PBKDF2),
   a 32-byte derived key, compared in constant time.

   Stored as:  pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url>

   The iteration count is IN the stored value, so it can be raised later
   without invalidating existing passwords: verify() reads it from the
   hash it is checking.

   Nothing here logs, returns or keeps a password.
   ============================================================ */

const ALGORITHM = 'pbkdf2_sha256';
export const ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function base64url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS));
}

function equalBytes(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  if (typeof crypto?.subtle?.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Hash a password for storage. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

/**
 * Does `password` match `stored`? A malformed stored value is simply "no".
 * The work done is the same whether or not it matches.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM || !/^\d{1,7}$/.test(parts[1])) return false;
  const iterations = Number(parts[1]);
  if (iterations < 1 || iterations > ITERATIONS) return false;
  let salt, expected;
  try { salt = fromBase64url(parts[2]); expected = fromBase64url(parts[3]); } catch { return false; }
  return equalBytes(await derive(password, salt, iterations), expected);
}

/**
 * A hash of nothing in particular, verified when a sign-in names an unknown
 * username, so that "no such user" takes as long as "wrong password".
 */
export const DECOY_HASH = `${ALGORITHM}$${ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
