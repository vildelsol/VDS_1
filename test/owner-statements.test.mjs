/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Proprietor statements.
 *
 * The corporation's income is maintenance; rent and short-let booking income
 * belong to the individual proprietor and the costs of their villa are theirs.
 * The statement puts those three on one page — collected on your behalf, less
 * maintenance billed, less expenses on your villa — and it is the document an
 * owner judges the managing agent by, so the arithmetic has to be right in front
 * of someone who will check it line by line.
 *
 * Unlike the other suites, this one does not re-implement the calculation to
 * compare against: it bundles the real `src/lib/finance.ts` and calls the same
 * `ownerStatement()` the screen calls. A mirror of the logic written here would
 * pass happily while the application was wrong.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Proprietor statements';

/** Last completed month, which is the period a statement is actually issued for. */
function lastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const previous = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return {
    month,
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
    midMonth: `${month}-15`,
    beforePeriod: `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-15`
  };
}

/**
 * Compile the real finance module so the test exercises the application's own
 * arithmetic rather than a copy of it.
 */
async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-finance-'));
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

const villa = (over = {}) => ({
  number: '1',
  ownerName: 'Alba Reid',
  status: 'long-term',
  monthlyRent: 50000,
  monthlyMaintenance: 10000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Owner-1234!', projectRoot });
  const T = reporter(title);
  const { mod: finance, cleanup } = await loadFinance(projectRoot);
  const { ownerStatement, ownerStatements, groupStatementsByOwner } = finance;
  const period = lastMonthRange();

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Owner-1234!', 'OwnerNew-9876!');

    /* ---------------- the property ---------------- */

    // Villa 1: a long-term let in JMD. Villa 2: a short-let earning USD but
    // assessed for maintenance in JMD — the case a single combined total would
    // turn into nonsense. Villa 3: a different owner, with nothing happening.
    await c.put('/api/units/unit-1', villa({ tenantName: 'Tina Brown', ownerEmail: 'alba@example.com' }));
    await c.put(
      '/api/units/unit-2',
      villa({
        number: '2',
        status: 'short-term',
        tenantName: '',
        monthlyRent: 0,
        monthlyMaintenance: 12000,
        currency: 'USD',
        maintCurrency: 'JMD'
      })
    );
    await c.put(
      '/api/units/unit-3',
      villa({ number: '3', ownerName: 'Basil Grant', status: 'vacant', tenantName: '', monthlyRent: 0, monthlyMaintenance: 0 })
    );

    const posted = await c.post('/api/charges/post-month', { monthString: period.month });
    T.check('the statement month posts its charges', posted.status === 200, String(posted.body?.error || ''));

    /* ---------------- money and costs ---------------- */

    // Rent collected for the owner.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tina Brown',
      method: 'Cash',
      date: period.midMonth
    });

    // A short-let booking, in the villa's own currency.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Booking',
      amount: 1200,
      currency: 'USD',
      payerName: 'Guest',
      method: 'Credit Card',
      date: period.midMonth
    });

    // The owner settles villa 2's maintenance themselves.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Maintenance',
      amount: 12000,
      currency: 'JMD',
      payerName: 'Alba Reid',
      method: 'Bank Transfer',
      date: period.midMonth
    });

    // Entered but never confirmed. Money that has not arrived counts for nothing.
    await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 20000,
      currency: 'JMD',
      payerName: 'Tina Brown',
      method: 'Cheque',
      date: period.midMonth
    });

    const expense = (over = {}) => ({
      category: 'Maintenance',
      vendor: 'A. Plumber',
      amount: 8000,
      currency: 'JMD',
      status: 'paid',
      date: period.midMonth,
      datePaid: period.midMonth,
      ...over
    });

    await c.post('/api/expenses', expense({ unitId: 'unit-1', description: 'Replace kitchen tap' }));
    // Common property — the corporation's cost, never an owner's.
    await c.post('/api/expenses', expense({ unitNumber: 'General', amount: 30000, description: 'Gate motor' }));
    // Not yet paid, and paid but before the period. Neither belongs in this statement.
    await c.post('/api/expenses', expense({ unitId: 'unit-1', amount: 5000, status: 'pending', dueDate: period.midMonth }));
    await c.post('/api/expenses', expense({ unitId: 'unit-1', amount: 999, date: period.beforePeriod, datePaid: period.beforePeriod }));

    /* ---------------- the statements ---------------- */

    const db = (await c.get('/api/db')).body;
    const statements = ownerStatements(db.units, db.charges, db.payments, db.expenses, period.from, period.to);
    const find = (unitId, currency) => statements.find(s => s.unit.id === unitId && s.currency === currency);

    const villa1 = find('unit-1', 'JMD');
    T.check('the long-term villa produces a statement', !!villa1);
    T.check('rent collected for the owner is stated', villa1?.rentCollected === 50000, `${villa1?.rentCollected}`);
    T.check('the unconfirmed cheque is excluded', villa1?.collected === 50000, `collected ${villa1?.collected}`);
    T.check('maintenance billed is deducted', villa1?.maintenanceBilled === 10000, `${villa1?.maintenanceBilled}`);
    T.check('only the villa\'s own paid expense is charged to it', villa1?.expenses === 8000, `${villa1?.expenses}`);
    T.check(
      'net is collected less maintenance billed less expenses',
      villa1?.net === 32000,
      `net ${villa1?.net} (expected 50000 - 10000 - 8000)`
    );
    T.check(
      'unpaid maintenance is disclosed as still outstanding',
      villa1?.maintenanceOutstanding === 10000,
      `${villa1?.maintenanceOutstanding}`
    );
    T.check(
      'the common-property expense lands on no owner',
      !statements.some(s => s.expenseItems.some(e => e.unitNumber === 'General')),
      'a General expense appeared on a proprietor statement'
    );

    // --- the two currencies stay apart ---
    const villa2Usd = find('unit-2', 'USD');
    const villa2Jmd = find('unit-2', 'JMD');
    T.check('a villa earning USD and assessed in JMD yields two statements', !!villa2Usd && !!villa2Jmd);
    T.check('booking income is collected for the owner', villa2Usd?.bookingCollected === 1200, `${villa2Usd?.bookingCollected}`);
    T.check(
      'the JMD maintenance is not deducted from the USD statement',
      villa2Usd?.maintenanceBilled === 0 && villa2Usd?.net === 1200,
      `billed ${villa2Usd?.maintenanceBilled}, net ${villa2Usd?.net}`
    );
    T.check(
      'the USD income is not credited against the JMD statement',
      villa2Jmd?.collected === 0 && villa2Jmd?.net === -12000,
      `collected ${villa2Jmd?.collected}, net ${villa2Jmd?.net}`
    );

    // --- the double-deduction disclosure ---
    T.check(
      'maintenance the owner paid themselves is disclosed',
      villa2Jmd?.maintenancePaid === 12000,
      `${villa2Jmd?.maintenancePaid}`
    );
    T.check(
      'and that villa then owes nothing at period end',
      villa2Jmd?.maintenanceOutstanding === 0,
      `${villa2Jmd?.maintenanceOutstanding}`
    );

    // --- villas with nothing to say are dropped, not printed empty ---
    T.check('a villa with no activity produces no statement', !statements.some(s => s.unit.id === 'unit-3'));

    /* ---------------- itemisation ---------------- */

    T.check(
      'every figure carries the records behind it',
      villa1?.collectedItems.length === 1 && villa1?.maintenanceCharges.length === 1 && villa1?.expenseItems.length === 1,
      `${villa1?.collectedItems.length}/${villa1?.maintenanceCharges.length}/${villa1?.expenseItems.length}`
    );
    T.check(
      'the itemised lines add up to the totals shown',
      villa1?.collectedItems.reduce((a, p) => a + p.amount, 0) === villa1?.collected &&
        villa1?.expenseItems.reduce((a, e) => a + e.amount, 0) === villa1?.expenses,
      'line items disagree with their total'
    );

    /* ---------------- one owner, one document ---------------- */

    const groups = groupStatementsByOwner(statements);
    T.check('statements are gathered under the proprietor, not the villa', groups.length === 1, `${groups.length} groups`);
    const alba = groups[0];
    T.check('the owner holds both villas', alba?.statements.length === 3, `${alba?.statements.length} statements`);
    T.check(
      'the net position is totalled per currency and never across',
      alba?.netByCurrency.find(r => r.currency === 'JMD')?.net === 20000 &&
        alba?.netByCurrency.find(r => r.currency === 'USD')?.net === 1200,
      JSON.stringify(alba?.netByCurrency)
    );

    /* ---------------- the period is a real boundary ---------------- */

    const earlier = ownerStatement(
      db.units.find(u => u.id === 'unit-1'),
      db.units,
      db.charges,
      db.payments,
      db.expenses,
      'JMD',
      period.beforePeriod,
      period.beforePeriod
    );
    T.check(
      'a period before the activity states nothing collected or billed',
      earlier.collected === 0 && earlier.maintenanceBilled === 0,
      `collected ${earlier.collected}, billed ${earlier.maintenanceBilled}`
    );
    T.check(
      'but the expense paid that day is still charged to the villa',
      earlier.expenses === 999,
      `${earlier.expenses}`
    );

    /* ---------------- reversals and voids remove money ---------------- */

    const rentPayment = db.payments.find(p => p.unitId === 'unit-1' && p.status === 'completed');
    await c.post(`/api/payments/${rentPayment.id}/reverse`, { reversalReason: 'Cheque returned unpaid' });
    const maintCharge = db.charges.find(ch => ch.unitId === 'unit-1' && ch.category === 'Maintenance');
    await c.post(`/api/charges/${maintCharge.id}/void`, { reason: 'Billed in error' });

    const after = (await c.get('/api/db')).body;
    const villa1After = ownerStatements(after.units, after.charges, after.payments, after.expenses, period.from, period.to).find(
      s => s.unit.id === 'unit-1' && s.currency === 'JMD'
    );
    T.check('a reversed receipt is no longer collected for the owner', villa1After?.collected === 0, `${villa1After?.collected}`);
    T.check('a voided charge is no longer billed to them', villa1After?.maintenanceBilled === 0, `${villa1After?.maintenanceBilled}`);
    T.check(
      'and the net becomes what the villa cost them',
      villa1After?.net === -8000,
      `net ${villa1After?.net}`
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
