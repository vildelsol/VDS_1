/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner. Each module boots its own server on a fresh temp data directory,
 * so nothing here touches the real db.json. Exits non-zero if anything fails.
 *
 *   npm test
 *
 * Requires a build first (npm test does this for you): the tests run the compiled
 * dist/server.cjs, the same artifact that runs in production.
 */

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

if (!fs.existsSync(path.join(projectRoot, 'dist', 'server.cjs'))) {
  console.error('dist/server.cjs is missing. Run `npm run build` first (or just `npm test`, which builds).');
  process.exit(1);
}

const modules = ['auth', 'money-math', 'xlsx-export', 'account-recovery', 'backup-target', 'backup-drives', 'restore', 'ledger', 'billing-state', 'due-dates', 'tenancy', 'first-and-last-rent', 'corrections', 'one-off-charges', 'lease-expiry', 'work-orders', 'deposits', 'damage-deposit', 'owner-statements', 'operations-statement', 'operating-statement', 'shortfall-report', 'occupancy-truth', 'entitlement', 'annual-return', 'owners-annual-report', 'health', 'version', 'management-charts', 'components', 'printed-records', 'time-assumptions', 'double-record', 'recurring-expenses', 'refunds', 'reconciliation', 'permissions', 'staff-accounts', 'input-hardening', 'integrity', 'self-check', 'ssrf', 'calendar-sync', 'ical-parsing', 'scenarios', 'scenarios-full', 'scenarios-400', 'redteam-3000', 'redteam-5000', 'expert-property-manager', 'expert-architect', 'expert-security'];
let port = 3971;
let totalPass = 0;
let totalFail = 0;
const allFailures = [];

for (const name of modules) {
  const mod = await import(`./${name}.test.mjs`);
  console.log(`\n== ${mod.title} ==`);
  try {
    const res = await mod.default({ port: port++, projectRoot });
    totalPass += res.pass;
    totalFail += res.fail;
    for (const f of res.failures) allFailures.push(`[${res.name}] ${f}`);
  } catch (err) {
    totalFail++;
    allFailures.push(`[${name}] harness error — ${err.message}`);
    console.log(`  FAIL harness error — ${err.message}`);
  }
}

console.log(`\n==== ${totalPass} passed, ${totalFail} failed ====`);
if (allFailures.length) {
  console.log('\nFailures:');
  for (const f of allFailures) console.log(`  - ${f}`);
  process.exit(1);
}
