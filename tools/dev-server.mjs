/* ============================================================
   dev-server.mjs — serve the app and the API on ONE origin
   ------------------------------------------------------------
   A development convenience, and nothing else. It is not
   deployed, not imported by the Worker, and not part of the
   shipped application.

   It exists because of a browser rule rather than a design
   choice. `wrangler dev` serves the Worker on :8787 and answers
   only /api/*; the static app is just files on disk. Opening the
   app from a second port would make every request cross-origin,
   which would need CORS on the Worker -- an allow-list to
   maintain and a security surface to get wrong, in exchange for
   nothing.

   So this serves the repository's own files AND forwards /api/*
   to the Worker, from one port. The browser sees a single origin,
   js/api.js resolves the base URL to `location.origin + /api`
   with no configuration at all, and the Worker keeps no CORS
   headers.

   Usage:
     npm run dev            # terminal 1 -- the Worker on :8787
     npm run dev:app        # terminal 2 -- this, on :3000

   The Worker still owns authentication. This proxy passes the
   Authorization header through untouched; it neither holds a
   token nor adds one.
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API = process.env.TAQWA_API_ORIGIN || 'http://127.0.0.1:8787';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/** Resolve a URL path to a file inside the repo, or null if it escapes it. */
function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(clean).replace(/^([/\\.]+)/, '');
  const full = join(ROOT, rel || 'index.html');
  // normalize() collapses ".." before this check, so a traversal cannot
  // survive it -- but the check is what makes that a guarantee rather than
  // a property of the previous line.
  if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null;
  return full;
}

async function serveStatic(req, res) {
  let file = resolve(req.url);
  if (!file) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',      // always serve the file on disk
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function proxyApi(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  // Forwarded verbatim, Authorization included. This proxy holds no
  // credential of its own and adds none.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;

  let upstream;
  try {
    upstream = await fetch(API + req.url, {
      method: req.method,
      headers,
      ...(body && body.length ? { body } : {}),
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'worker_unreachable',
      message: `No Worker answering on ${API}. Start it with: npm run dev` } }, null, 2));
    return;
  }

  const out = {};
  upstream.headers.forEach((v, k) => { if (k !== 'content-encoding') out[k] = v; });
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

createServer((req, res) => {
  const handler = req.url.startsWith('/api') ? proxyApi : serveStatic;
  handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  });
}).listen(PORT, () => {
  console.log(`  App     http://localhost:${PORT}`);
  console.log(`  API     http://localhost:${PORT}/api  ->  ${API}`);
  console.log(`\n  The Worker must be running separately:  npm run dev`);
  console.log(`  Writes need a token, set once in the browser console:`);
  console.log(`    Api.configure({ token: '<the API_TOKEN the Worker was started with>' })\n`);
});
