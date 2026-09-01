/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The owners' monthly operations statement.
 *
 * What the sixteen proprietors are shown each month: the maintenance actually
 * collected, every common cost it paid for, itemised, and what is left. Asked
 * for by Ro on 2026-09-01, with three decisions taken at the same time and
 * asserted here so they cannot drift:
 *
 *   - **common costs only.** Fuel, grounds staff, pool chemicals — the costs of
 *     running the place. Work on one villa is recharged to that owner and
 *     appears on their own statement; itemising it here would show all sixteen
 *     proprietors what was done to each other's villas.
 *   - **one identical statement**, not sixteen personalised ones. It is the
 *     fund's position, which is genuinely the same for everyone.
 *   - **cash in, cash out.** Costs count when they are paid, matching
 *     "maintenance collected" pound for pound, so the surplus reconciles to the
 *     bank. Bills raised and unsettled are carried as a memo instead, because a
 *     month with a large unpaid bill would otherwise read as a good month.
 *
 * This bundles the real `src/lib/finance.ts` rather than restating its rules: a
 * copy of the logic would agree with itself while the application was wrong.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Owners monthly operations statement';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ops-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const FROM = '2026-05-01';
const TO = '2026-05-31';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Ops-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const { operationsStatement } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Ops-1234!', 'OpsNew-9876!');

    const s = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...s, booksBeginOn: '2026-01-01' });

    /* ---------------- two proprietors who pay maintenance ---------------- */

    await c.put('/api/units/unit-1', {
      number: '1', ownerName: 'Owner One', status: 'owner-occupied',
      monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1
    });
    await c.put('/api/units/unit-2', {
      number: '2', ownerName: 'Owner Two', status: 'owner-occupied',
      monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1
    });

    await c.post('/api/charges/post-month', { monthString: '2026-05' });

    // One pays, one does not — so "collected" is genuinely collections and not
    // a restatement of what was billed.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1', category: 'Maintenance', amount: 20000, currency: 'JMD',
      payerName: 'Owner One', method: 'Bank Transfer', date: '2026-05-05'
    });

    /* ---------------- the costs of running the place ---------------- */

    const expense = over => ({
      vendor: 'Vendor', currency: 'JMD', status: 'paid',
      date: '2026-05-10', datePaid: '2026-05-10', ...over
    });

    // Common costs: no villa, allocated to the general property or the office.
    await c.post('/api/expenses', expense({ category: 'Supplies', unitNumber: 'General', amount: 4000, description: 'Fuel for the generator', vendor: 'Fuel Co' }));
    await c.post('/api/expenses', expense({ category: 'Payroll', unitNumber: 'General', amount: 9000, description: 'Grounds staff', vendor: 'Payroll' }));
    await c.post('/api/expenses', expense({ category: 'Supplies', unitNumber: 'General', amount: 2500, description: 'Pool chemicals', vendor: 'Pool Co' }));
    await c.post('/api/expenses', expense({ category: 'Security', unitNumber: 'Office', amount: 1500, description: 'Office alarm' }));

    // Work on one villa: recharged to that owner, never on the communal page.
    await c.post('/api/expenses', expense({ category: 'Maintenance', unitId: 'unit-2', amount: 7777, description: 'Replace a tap in villa 2' }));

    // Raised, due in the month, not paid: a memo, never in the surplus.
    await c.post('/api/expenses', expense({ category: 'Contractors', unitNumber: 'General', amount: 12000, status: 'pending', dueDate: '2026-05-20', description: 'Gate motor repair' }));

    // Outside the period, and in the other currency — neither belongs.
    await c.post('/api/expenses', expense({ category: 'Payroll', unitNumber: 'General', amount: 5000, date: '2026-04-10', datePaid: '2026-04-10', description: 'April payroll' }));
    await c.post('/api/expenses', expense({ category: 'Supplies', unitNumber: 'General', amount: 300, currency: 'USD', description: 'Imported part' }));

    const db = (await c.get('/api/db')).body;
    const st = operationsStatement(db.expenses, db.payments, 'JMD', FROM, TO);

    /* ---------------- money in ---------------- */

    T.check('maintenance collected is what was received, not what was billed', st.maintenanceCollected === 20000, `${st.maintenanceCollected} (40,000 was billed)`);

    /* ---------------- money out ---------------- */

    T.check('common costs paid in the month are totalled', st.costsPaid === 17000, `${st.costsPaid} (4000 + 9000 + 2500 + 1500)`);
    T.check(
      'and the personal villa work is not among them',
      !st.groups.some(g => g.lines.some(l => /tap in villa 2/i.test(l.description))),
      'a villa recharge reached the communal statement'
    );
    T.check(
      'but it is disclosed as an excluded total, not silently dropped',
      st.villaRecharged === 7777 && st.villaRechargedCount === 1,
      `${st.villaRecharged} over ${st.villaRechargedCount} item(s)`
    );

    /* ---------------- itemised, which is the whole point ---------------- */

    T.check('costs are grouped by category', st.groups.length === 3, st.groups.map(g => g.category).join(', '));
    T.check('largest category first', st.groups[0].category === 'Payroll', st.groups[0].category);
    const supplies = st.groups.find(g => g.category === 'Supplies');
    T.check('each category carries its own lines', supplies?.lines.length === 2, `${supplies?.lines.length}`);
    T.check('and the lines add up to the category total', supplies?.total === 6500, `${supplies?.total}`);
    T.check(
      'every line names the supplier and what it was for, so an owner can query it',
      st.groups.every(g => g.lines.every(l => l.vendor.length > 0 && l.description.length > 0)),
      'a line could not be explained'
    );
    T.check(
      'the categories add up to the total paid',
      st.groups.reduce((a, g) => a + g.total, 0) === st.costsPaid,
      'the itemisation disagrees with its own total'
    );

    /* ---------------- the surplus reconciles to the bank ---------------- */

    T.check('surplus is money in less money out', st.surplus === 3000, `${st.surplus} (20000 - 17000)`);
    T.check(
      'an unpaid bill is a memo and never touches the surplus',
      st.costsUnpaid === 12000 && st.unpaidLines.length === 1,
      `${st.costsUnpaid} over ${st.unpaidLines.length} line(s)`
    );
    T.check(
      'so a month with a large unpaid bill still shows what actually moved',
      st.surplus === 3000,
      'the unpaid bill leaked into the cash position'
    );

    /* ---------------- boundaries ---------------- */

    T.check('a cost paid before the period is excluded', !st.groups.some(g => g.lines.some(l => l.date < FROM)), 'an earlier month leaked in');
    const usd = operationsStatement(db.expenses, db.payments, 'USD', FROM, TO);
    T.check('the other currency is reported entirely separately', usd.costsPaid === 300, `${usd.costsPaid}`);
    T.check('and never sees the JMD collections', usd.maintenanceCollected === 0, `${usd.maintenanceCollected}`);
    T.check(
      'neither currency total is the sum of both',
      st.costsPaid + usd.costsPaid === 17300 && st.costsPaid !== 17300,
      'the currencies were combined'
    );

    const quiet = operationsStatement(db.expenses, db.payments, 'JMD', '2026-01-01', '2026-01-31');
    T.check('a month where nothing happened says so', quiet.empty === true && quiet.costsPaid === 0, JSON.stringify([quiet.empty, quiet.costsPaid]));

    /* ---------------- the safeguard against a miscategorised cost ---------------- */

    /*
     * A cost keyed against a villa by mistake would otherwise vanish from both
     * sides — off the communal statement because it looks personal, and off that
     * owner's statement only if they never look. It is counted and shown as an
     * exclusion so the total is always reconcilable to the expense register.
     */
    const allPaidJmd = db.expenses
      .filter(e => e.status === 'paid' && e.currency === 'JMD' && (e.datePaid || e.date) >= FROM && (e.datePaid || e.date) <= TO)
      .reduce((a, e) => a + e.amount, 0);
    T.check(
      'every paid cost in the period is either on the statement or declared as excluded',
      st.costsPaid + st.villaRecharged === allPaidJmd,
      `${st.costsPaid} + ${st.villaRecharged} vs ${allPaidJmd} in the register`
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
