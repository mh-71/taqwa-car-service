/* config — the configuration assumptions the deployment rests on.

   tools/config-check.mjs is the operator-facing version of this, meant to be
   run by hand before deploying. This is the same guarantees as a test, so
   they cannot quietly stop being true between deployments. It runs the real
   checker and asserts the properties that would be dangerous to lose:

     - a real database id must never appear in the DEVELOPMENT binding
     - the two environments must stay distinguishable
     - no secret VALUE may appear in any committed file
     - nothing but the app may be publishable
     - no script may deploy

   Offline, read-only, touches no Cloudflare resource. */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const rawWrangler = read('wrangler.jsonc');
const config = JSON.parse(rawWrangler.replace(/^\s*\/\/.*$/gm, ''));
const pkg = JSON.parse(read('package.json'));

console.log('=== config: what the deployment rests on ===\n');

/* ============================================================
   1. The checker itself
   ============================================================ */
console.log('-- 1. tools/config-check.mjs --');
{
  let out = '', code = 0;
  try {
    out = execFileSync('node', [join(ROOT, 'tools/config-check.mjs')], { encoding: 'utf8' });
  } catch (e) { out = String(e.stdout || ''); code = e.status ?? 1; }
  check('the configuration checker passes', code, 0);
  ok_('   ...and reported real checks rather than doing nothing',
    (out.match(/^PASS/gm) || []).length >= 30, String((out.match(/^PASS/gm) || []).length));
  ok_('   ...and it cannot deploy: it never calls wrangler',
    !/wrangler\s+(deploy|publish|d1)/.test(read('tools/config-check.mjs')), 'it shells out');
}

/* ============================================================
   2. The two environments cannot be confused
   ============================================================ */
console.log('\n-- 2. environment separation --');
{
  const dev = config;
  const prod = config.env.production;
  ok_('the default environment is development', /dev/i.test(dev.name), dev.name);
  ok_('   ...and production has its own Worker name, so a bare deploy cannot overwrite it',
    prod.name !== dev.name && !/dev/i.test(prod.name), `${dev.name} / ${prod.name}`);

  const devId = dev.d1_databases[0].database_id;
  // The one that would actually hurt: a real id pasted into the DEVELOPMENT
  // binding means `wrangler deploy` with no --env reaches a real database.
  ok_('THE DEVELOPMENT BINDING HOLDS NO REAL DATABASE ID',
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(devId), devId);
  check('   ...it is the local placeholder', devId, 'local-development-only');
  check('   ...and names the local database', dev.d1_databases[0].database_name, 'taqwa-local');
  check('production names its own database', prod.d1_databases[0].database_name, 'taqwa-prod');
  check('both bind it as DB, so no route needs to branch on environment',
    [dev.d1_databases[0].binding, prod.d1_databases[0].binding], ['DB', 'DB']);
}
{
  const prod = config.env.production;
  // Both are legitimate states; the checker reports which one this is.
  const id = prod.d1_databases[0].database_id;
  const placeholder = /REPLACE_WITH/.test(id);
  const provisioned = /^[0-9a-f-]{36}$/i.test(id);
  ok_('the production id is either a clear placeholder or a real id, never a guess',
    placeholder || provisioned, id);
  if (placeholder) {
    ok_('   ...and while it is a placeholder, a production deploy cannot resolve a database',
      !/^[0-9a-f-]{36}$/i.test(id), id);
  }
}

/* ============================================================
   3. Same origin, because the cookie depends on it
   ============================================================ */
console.log('\n-- 3. same-origin hosting --');
{
  const dev = config.assets, prod = config.env.production.assets;
  ok_('the default environment serves the app and the API together', !!dev?.directory);
  ok_('   ...and so does production', !!prod?.directory);
  check('   ...with identical URL handling, or links would differ between them',
    [dev.html_handling, prod.html_handling, dev.not_found_handling, prod.not_found_handling],
    ['none', 'none', 'none', 'none']);
  ok_('no CORS header is configured anywhere, because nothing is cross-origin',
    !/access-control-allow/i.test(rawWrangler + read('src/lib/http.js') + read('_headers')),
    'CORS crept in');
}

/* ============================================================
   4. No secret is committable
   ============================================================ */
console.log('\n-- 4. secrets --');
{
  const NAMES = ['AUTH_SECRET', 'AUTH_PASSPHRASE', 'API_TOKEN'];
  for (const n of NAMES) {
    ok_(`wrangler.jsonc holds no ${n} value`,
      !new RegExp(`"?${n}"?\\s*:\\s*"[^"]+"`).test(rawWrangler), 'a secret is committed');
  }
  ok_('   ...and declares no plaintext vars block in either environment',
    !('vars' in config) && !('vars' in config.env.production), 'vars would be plaintext');

  ok_('an example env file exists', existsSync(join(ROOT, '.dev.vars.example')));
  const example = read('.dev.vars.example');
  ok_('   ...naming every secret the Worker reads', NAMES.every((n) => example.includes(n)), '');
  ok_('   ...with a value for none of them',
    !/^[^\S\n]*(AUTH_SECRET|AUTH_PASSPHRASE|API_TOKEN)[^\S\n]*=[^\S\n]*\S/m.test(example),
    'a value is filled in');

  const ignore = read('.gitignore');
  for (const p of ['.dev.vars', '.env']) {
    ok_(`.gitignore keeps ${p} out of the repository`, ignore.includes(`\n${p}\n`), 'not ignored');
  }
  ok_('   ...while still allowing the example to be tracked',
    ignore.includes('!.dev.vars.example'), '');

  // The Worker must read them from the binding, never from a file or a table.
  const auth = read('src/lib/auth.js');
  ok_('the Worker reads its secrets from env only',
    /env\.AUTH_SECRET/.test(auth) && !/readFile|process\.env/.test(auth), '');
}

/* ============================================================
   5. Only the app is publishable
   ============================================================ */
console.log('\n-- 5. the published surface --');
{
  const lines = read('.assetsignore').split('\n').map((l) => l.trim());
  for (const entry of ['src', 'tests', 'migrations', 'tools', 'node_modules',
                       'wrangler.jsonc', 'package.json', 'README.md', 'DEPLOYMENT.md']) {
    ok_(`.assetsignore excludes ${entry}`, lines.includes(entry), 'would be published');
  }
  // assets.directory is the repository root, so a secret file dropped there
  // would be a served file. Keeping it out of git is a different guarantee.
  ok_('no .dev.vars file can be published',
    ['.dev.vars', '.dev.vars.*', '.dev.vars*'].some((p) => lines.includes(p)), lines.join(','));
  ok_('   ...nor any .env file',
    ['.env', '.env.*', '.env*'].some((p) => lines.includes(p)), lines.join(','));
}

/* ============================================================
   6. Nothing in the repository can deploy
   ============================================================ */
console.log('\n-- 6. deployment safety --');
{
  const scripts = pkg.scripts || {};
  const deploying = Object.entries(scripts)
    .filter(([, s]) => /wrangler\s+(deploy|publish)/.test(s) && !/--dry-run/.test(s));
  check('no npm script deploys', deploying, []);
  const remote = Object.entries(scripts).filter(([, s]) => /--remote/.test(s));
  check('   ...and none uses --remote', remote, []);
  const dbScripts = Object.entries(scripts).filter(([k]) => k.startsWith('db:'));
  ok_('   ...while every database script is explicitly --local',
    dbScripts.length > 0 && dbScripts.every(([, s]) => s.includes('--local')), JSON.stringify(dbScripts));
  ok_('the dry-run checks really are dry runs',
    (scripts['deploy:check'] || '').includes('--dry-run')
      && (scripts['deploy:check:prod'] || '').includes('--dry-run'), JSON.stringify(scripts));
  ok_('   ...and the production one names the production environment',
    (scripts['deploy:check:prod'] || '').includes('--env production'), '');

  const floor = (pkg.devDependencies?.wrangler || '').replace(/[^0-9.]/g, '').split('.').map(Number);
  ok_('the wrangler floor supports the assets binding (>= 3.91)',
    floor[0] > 3 || (floor[0] === 3 && floor[1] >= 91), pkg.devDependencies?.wrangler);
}

/* ============================================================
   7. The checklist says what is still not done
   ============================================================ */
console.log('\n-- 7. the deployment checklist --');
{
  ok_('DEPLOYMENT.md exists', existsSync(join(ROOT, 'DEPLOYMENT.md')));
  const doc = read('DEPLOYMENT.md');
  ok_('it says nothing has been deployed', /nothing in this repository has been deployed/i.test(doc), '');
  for (const step of ['wrangler d1 create', 'migrations apply', 'wrangler secret put',
                      'rate limiting', 'wrangler deploy --env production']) {
    ok_(`   ...and covers: ${step}`, doc.toLowerCase().includes(step.toLowerCase()), '');
  }
  ok_('it names the route the rate-limiting rule protects',
    /\/api\/session/.test(doc) && /POST/.test(doc), '');
  ok_('it does NOT claim the C-12 limitations are solved',
    /shared identity/i.test(doc) && /no individual revocation/i.test(doc), '');
  ok_('   ...and contains no secret value of its own',
    !/(AUTH_SECRET|AUTH_PASSPHRASE|API_TOKEN)\s*=\s*\S/.test(doc), 'a value appears');
}

console.log(`\nConfig unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
