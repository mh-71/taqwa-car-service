/* ============================================================
   config-check.mjs — does this repository still configure what
   it claims to?
   ------------------------------------------------------------
   Read-only, offline, and safe to run at any time. It touches no
   Cloudflare resource, needs no credential, and cannot deploy.

   It exists because the dangerous configuration mistakes here are
   quiet ones: a real database id pasted into the development
   binding, a secret committed to wrangler.jsonc, or .assetsignore
   losing an entry and publishing src/ to the world. None of those
   breaks a test; each is found by looking.
   ============================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass += 1 : fail += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

/* wrangler.jsonc is JSONC; strip line comments before parsing. */
const rawWrangler = read('wrangler.jsonc');
const config = JSON.parse(rawWrangler.replace(/^\s*\/\/.*$/gm, ''));

console.log('=== config-check: wrangler, secrets, assets ===\n');

/* ---------- environments are separate, and stay that way ---------- */
console.log('-- environments --');
const dev = config;
const prod = config.env?.production;
ok('a production environment is defined', !!prod);
ok('the default environment is named as development',
  /dev/i.test(dev.name || ''), dev.name);
ok('   ...and production is named differently, so a bare deploy cannot overwrite it',
  prod && prod.name && prod.name !== dev.name, `${dev.name} / ${prod?.name}`);

const devDb = dev.d1_databases?.[0] ?? {};
const prodDb = prod?.d1_databases?.[0] ?? {};
ok('the development binding points at the local database',
  devDb.database_name === 'taqwa-local' && devDb.database_id === 'local-development-only',
  JSON.stringify(devDb));
ok('   ...and its id is NOT a real one, so a bare deploy fails rather than binding something',
  !/^[0-9a-f-]{32,}$/i.test(devDb.database_id || ''), devDb.database_id);
ok('production names its own database', prodDb.database_name === 'taqwa-prod', prodDb.database_name);

/* The production id is a placeholder until someone provisions the database.
   Both states are legitimate; what must never happen is a UUID sitting in the
   DEVELOPMENT binding, which the check above covers. */
const provisioned = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  .test(prodDb.database_id || '');
ok(provisioned
  ? 'the production database id looks provisioned (a real deployment is possible)'
  : 'the production database id is still the placeholder, so `--env production` fails safely',
  provisioned || /REPLACE_WITH/.test(prodDb.database_id || ''), prodDb.database_id);

ok('both environments bind D1 as DB, so the routes need no branching',
  devDb.binding === 'DB' && prodDb.binding === 'DB', `${devDb.binding}/${prodDb.binding}`);
ok('both run migrations from the same directory',
  devDb.migrations_dir === 'migrations' && prodDb.migrations_dir === 'migrations', '');

/* ---------- same origin, which is what makes the cookie work ---------- */
console.log('\n-- same-origin hosting --');
ok('the default environment serves the app as well as the API', !!dev.assets?.directory);
ok('   ...and so does production', !!prod?.assets?.directory);
ok('   ...with the same html_handling, or URLs would differ between them',
  dev.assets?.html_handling === prod?.assets?.html_handling,
  `${dev.assets?.html_handling} / ${prod?.assets?.html_handling}`);
ok('no CORS configuration exists anywhere, because nothing is cross-origin',
  !/access-control-allow-origin/i.test(rawWrangler + read('src/lib/http.js')), 'CORS crept in');

/* ---------- nothing secret is in the repository ---------- */
console.log('\n-- secrets --');
const SECRET_NAMES = ['AUTH_SECRET', 'AUTH_PASSPHRASE', 'API_TOKEN'];
for (const name of SECRET_NAMES) {
  ok(`wrangler.jsonc holds no ${name} value`,
    !new RegExp(`"?${name}"?\\s*:\\s*"[^"]+"`).test(rawWrangler), 'a secret is committed');
}
ok('wrangler.jsonc declares no plaintext vars block at all',
  !('vars' in dev) && !(prod && 'vars' in prod), 'vars would be committed in plaintext');
ok('an example env file documents the names', existsSync(join(ROOT, '.dev.vars.example')));
if (existsSync(join(ROOT, '.dev.vars.example'))) {
  const example = read('.dev.vars.example');
  ok('   ...naming every secret the Worker reads',
    SECRET_NAMES.every((n) => example.includes(n)), example.slice(0, 120));
  ok('   ...and giving a value to none of them',
    // [^\S\n]* rather than \s*: \s spans newlines, so a trailing `NAME=` would
    // otherwise match the first character of the following line.
    !/^[^\S\n]*(AUTH_SECRET|AUTH_PASSPHRASE|API_TOKEN)[^\S\n]*=[^\S\n]*\S/m.test(example),
    'a value is filled in');
}
const ignore = read('.gitignore');
for (const pattern of ['.dev.vars', '.env']) {
  ok(`.gitignore keeps ${pattern} out`, ignore.includes(`\n${pattern}\n`), 'not ignored');
}
ok('   ...while still allowing the example', ignore.includes('!.dev.vars.example'), '');

/* ---------- the published surface ---------- */
console.log('\n-- what gets published --');
const assetsIgnore = read('.assetsignore').split('\n').map((l) => l.trim());
for (const dir of ['src', 'tests', 'migrations', 'tools', 'node_modules', 'wrangler.jsonc']) {
  ok(`.assetsignore excludes ${dir}`, assetsIgnore.includes(dir), 'would be published');
}
// Any of these patterns covers it; what matters is that no .dev.vars file --
// the example or a developer's real one -- can be served as a static asset.
const COVERS_DEV_VARS = ['.dev.vars', '.dev.vars.*', '.dev.vars*', '.dev.vars.example'];
ok('   ...and no .dev.vars file can be published',
  COVERS_DEV_VARS.some((p2) => assetsIgnore.includes(p2)), assetsIgnore.join(','));
ok('   ...nor any .env file',
  ['.env', '.env.*', '.env*'].some((p2) => assetsIgnore.includes(p2)), assetsIgnore.join(','));
ok('   ...nor the deployment checklist', assetsIgnore.includes('DEPLOYMENT.md'), '');

/* ---------- the headers the static app is served with ---------- */
console.log('\n-- static app headers --');
const headers = read('_headers');
ok('a CSP is configured for the app', /Content-Security-Policy:/i.test(headers));
ok("   ...without 'unsafe-inline' for scripts",
  !/script-src[^;]*unsafe-inline/i.test(headers), 'script-src is unsafe');
for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) {
  ok(`   ...and ${h} is set`, new RegExp(`${h}:`, 'i').test(headers));
}

/* ---------- the toolchain can actually do this ---------- */
console.log('\n-- toolchain --');
const pkg = JSON.parse(read('package.json'));
const floor = (pkg.devDependencies?.wrangler || '').replace(/[^0-9.]/g, '');
const [maj, min] = floor.split('.').map(Number);
ok('the wrangler floor supports the assets binding (>= 3.91)',
  maj > 3 || (maj === 3 && min >= 91), pkg.devDependencies?.wrangler);
ok('no script deploys anything',
  !Object.values(pkg.scripts || {}).some((s) => /wrangler (deploy|publish)(?!.*--dry-run)/.test(s)),
  JSON.stringify(pkg.scripts));
ok('every database script is explicitly --local',
  Object.entries(pkg.scripts || {}).filter(([k]) => k.startsWith('db:'))
    .every(([, s]) => s.includes('--local')), JSON.stringify(pkg.scripts));
ok('a deployment checklist exists', existsSync(join(ROOT, 'DEPLOYMENT.md')));

console.log(`\nconfig-check: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
