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
import { takeUnknownRoutes } from './harness.mjs';

const projectRoot = process.cwd();

if (!fs.existsSync(path.join(projectRoot, 'dist', 'server.cjs'))) {
  console.error('dist/server.cjs is missing. Run `npm run build` first (or just `npm test`, which builds).');
  process.exit(1);
}

const modules = ['auth', 'money-math', 'xlsx-export', 'account-recovery', 'backup-target', 'backup-drives', 'restore', 'restore-records', 'ledger', 'billing-state', 'due-dates', 'tenancy', 'first-and-last-rent', 'tenant-total', 'restate-rent', 'restate-receipts', 'redteam-receipt-move', 'office-5000', 'villa-lifecycle', 'tenant-total-5000', 'redteam-tenant-total', 'combined-view', 'settled-from-rent', 'contribution-from-rent', 'corrections', 'one-off-charges', 'lease-expiry', 'work-orders', 'deposits', 'damage-deposit', 'short-stay-deposits', 'owner-statements', 'operations-statement', 'operating-statement', 'shortfall-report', 'occupancy-truth', 'entitlement', 'annual-return', 'owners-annual-report', 'monthly-owners-report', 'health', 'version', 'management-charts', 'components', 'printed-records', 'ledger-print', 'time-assumptions', 'local-dates', 'double-record', 'recurring-expenses', 'supplier-credits', 'invoice-dates', 'taking-a-cost-back', 'two-books', 'books-ecosystem', 'redteam-ecosystem', 'report-books', 'books-5000', 'reports-2000', 'refunds', 'reconciliation', 'permissions', 'backup-permission', 'backup-auto-detect', 'unit-validation', 'windows-drives', 'advance-payments', 'collection-rate', 'period-boundaries', 'recovery-restore', 'recovery-restore-controls', 'recovery-corruption', 'recovery-disk', 'recovery-crash', 'recovery-persistence', 'storage-durability', 'concurrency-payments', 'concurrency-charges', 'concurrency-abort', 'concurrency-crash', 'security-matrix', 'security-money', 'security-session', 'security-input', 'security-audit-backup', 'security-amounts', 'security-dos', 'security-auth-hardening', 'redteam-second-pass', 'restate-dryrun-verify', 'workflow-tenancy', 'workflow-records', 'workflow-billing', 'auto-billing', 'workflow-fixes', 'rent-on-owner-villa', 'staff-accounts', 'staying-signed-in', 'input-hardening', 'integrity', 'ecosystem-guards', 'ecosystem-wiring', 'former-tenant-arrears', 'self-check', 'ssrf', 'calendar-sync', 'ical-parsing', 'scenarios', 'scenarios-full', 'scenarios-400', 'redteam-3000', 'redteam-5000', 'robustness-5000', 'expert-property-manager', 'expert-architect', 'expert-security'];
let port = 3971;
// Ports the fetch standard refuses to connect to (lockd, SIP, X11, IRC...). A test
// server on one of them comes up fine and is then unreachable, so a module that
// happens to be numbered onto one fails with "server did not come up". Adding or
// removing a module shifts every later number, so skip them rather than hope.
const BLOCKED_PORTS = new Set([4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const nextPort = () => {
  while (BLOCKED_PORTS.has(port)) port++;
  return port++;
};
let totalPass = 0;
let totalFail = 0;
const allFailures = [];

for (const name of modules) {
  const mod = await import(`./${name}.test.mjs`);
  console.log(`\n== ${mod.title} ==`);
  takeUnknownRoutes(); // start each module with an empty record
  try {
    const res = await mod.default({ port: nextPort(), projectRoot });
    /*
     * A request no server route answers can never succeed, so a suite that makes
     * one is not testing what it thinks it is (PUT /api/settings, a POST-only
     * route, was called by seven suites for months and 404'd in silence). A suite
     * that probes missing routes on purpose exports `allowUnknownRoutes = true`.
     */
    const unknown = takeUnknownRoutes();
    if (unknown.length && !mod.allowUnknownRoutes) {
      const distinct = [...new Set(unknown)];
      res.fail += 1;
      res.failures.push(`called ${distinct.length} route(s) the server does not have, so those calls could never succeed: ${distinct.slice(0, 5).join(' | ')}`);
      console.log(`  FAIL called routes the server does not have: ${distinct.slice(0, 5).join(' | ')}`);
    }
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
