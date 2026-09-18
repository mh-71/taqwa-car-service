/* ============================================================
   tests/run-unit.mjs — runs every unit suite, reports one total
   ------------------------------------------------------------
   Each suite is a standalone script that prints its own PASS/FAIL
   lines and exits non-zero on failure, so this runner only has to
   spawn them and add up the results. Running each in its own
   process is deliberate: the frontend suites boot the real js/
   modules inside a VM and set process.env.TZ, which would leak
   between suites if they shared one.

   Adding a suite for a future phase: drop the file in tests/unit/
   as <name>.test.mjs (ESM) or <name>.test.cjs (CommonJS). It is
   discovered automatically -- there is no list to update.

   Needs no network, no Worker and no database. For the integration
   suite, which needs all three locally, see tests/integration/run.sh.
   ============================================================ */

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = join(HERE, 'unit');

const suites = readdirSync(UNIT_DIR)
  .filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.cjs'))
  .sort();

if (suites.length === 0) {
  console.error('No suites found in tests/unit.');
  process.exit(1);
}

// "Finding 1: 44 passed, 0 failed" / "GET /api/services unit: 131 passed, 0 failed"
const TALLY = /^(.*?):\s*(\d+)\s+passed,\s*(\d+)\s+failed\s*$/m;

const rows = [];
let passed = 0, failed = 0, broken = 0;
const verbose = process.argv.includes('--verbose');

for (const file of suites) {
  const run = spawnSync(process.execPath, [join(UNIT_DIR, file)], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  const output = (run.stdout || '') + (run.stderr || '');
  if (verbose) process.stdout.write(output);

  const m = output.match(TALLY);
  if (!m) {
    // No tally line: the suite crashed before summarising. Never silently
    // count that as a pass -- show why it died.
    broken++;
    rows.push({ file, label: '(no result)', p: 0, f: 0, exit: run.status });
    console.log(`\n--- ${file} produced no result (exit ${run.status}) ---`);
    console.log(output.trim().split('\n').slice(-12).join('\n'));
    continue;
  }

  const p = Number(m[2]), f = Number(m[3]);
  passed += p; failed += f;
  if (run.status !== 0 && f === 0) broken++;   // non-zero exit with a clean tally
  rows.push({ file, label: m[1].trim(), p, f, exit: run.status });
}

const w = Math.max(...rows.map((r) => r.file.length));
console.log('\n=== Unit suites ===');
for (const r of rows) {
  const mark = r.f === 0 && r.exit === 0 ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${r.file.padEnd(w)}  ${String(r.p).padStart(3)} passed, ${r.f} failed   ${r.label}`);
}
console.log(
  `\n${rows.length} suites: ${passed} assertions passed, ${failed} failed` +
  (broken ? `, ${broken} suite(s) did not complete` : '')
);

process.exit(failed === 0 && broken === 0 ? 0 : 1);
