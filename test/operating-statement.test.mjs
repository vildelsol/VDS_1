/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Operating Statement carried to the strata corporation.
 *
 * Income and expenditure, and nothing else. Ro asked for this on 2026-09-01: the
 * council meeting wants to see what came in and what went out, not receivables
 * ageing or collection rates, and it has to be a document somebody can carry
 * into a room and answer questions from.
 *
 * Two requirements were stated plainly and are asserted here line by line:
 *
 *   1. **Every expense is itemised with the payee named under its category.**
 *      Ro's example: if Darryl Whyte is paid 20,000, the statement must not read
 *      "Payroll 20,000" — it must class the payment as Payroll *and* show his
 *      name against the figure. A lump sum is not something a council can
 *      approve or question.
 *   2. **The currencies are kept apart.** One statement per currency, computed
 *      independently, with no combined total anywhere.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Operating statement for the strata corporation';

const FROM = '2026-06-01';
const TO = '2026-06-30';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-opstmt-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'OpStmt-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const { operatingStatement } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'OpStmt-1234!', 'OpStmtNew-9876!');
    const s = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...s, booksBeginOn: '2026-01-01' });

    await c.put('/api/units/unit-1', { number: '1', ownerName: 'Owner One', tenantName: 'Tenant One', tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: 60000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'owner-occupied', monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'short-term', monthlyMaintenance: 200, currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 });

    await c.post('/api/charges/post-month', { monthString: '2026-06' });

    /* ---------------- money in ---------------- */

    await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Maintenance', amount: 20000, currency: 'JMD', payerName: 'Owner One', method: 'Bank Transfer', date: '2026-06-03' });
    await recordAndConfirmPayment(c, { unitId: 'unit-2', category: 'Maintenance', amount: 20000, currency: 'JMD', payerName: 'Owner Two', method: 'Cash', date: '2026-06-04' });
    await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Rent', amount: 60000, currency: 'JMD', payerName: 'Tenant One', method: 'Cash', date: '2026-06-05' });
    await recordAndConfirmPayment(c, { unitId: 'unit-3', category: 'Booking', amount: 900, currency: 'USD', payerName: 'A Guest', method: 'Credit Card', date: '2026-06-08' });
    await recordAndConfirmPayment(c, { unitId: 'unit-3', category: 'Maintenance', amount: 200, currency: 'USD', payerName: 'Owner Three', method: 'Bank Transfer', date: '2026-06-09' });

    // Entered but never confirmed: money that has not arrived is not income.
    await c.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 15000, currency: 'JMD', payerName: 'Tenant One', method: 'Cheque', date: '2026-06-20', confirmNoOpenCharge: true });

    /* ---------------- money out ---------------- */

    const spend = over => ({ currency: 'JMD', status: 'paid', date: '2026-06-10', datePaid: '2026-06-10', unitNumber: 'General', ...over });

    // Ro's example, exactly: two people paid under one category.
    await c.post('/api/expenses', spend({ category: 'Payroll', vendor: 'Darryl Whyte', description: 'Grounds — June', amount: 20000 }));
    await c.post('/api/expenses', spend({ category: 'Payroll', vendor: 'Marcia Simpson', description: 'Housekeeping — June', amount: 14500 }));
    await c.post('/api/expenses', spend({ category: 'Security', vendor: 'Guardsman', description: 'Night patrol', amount: 30000 }));
    await c.post('/api/expenses', spend({ category: 'Supplies', vendor: 'AquaChem', description: 'Pool chemicals', amount: 4200 }));
    // Work on one villa: still the corporation's money going out, allocation named.
    await c.post('/api/expenses', spend({ category: 'Maintenance', vendor: 'A. Plumber', description: 'Kitchen tap', amount: 7800, unitId: 'unit-1', unitNumber: '1' }));
    // The other currency.
    await c.post('/api/expenses', spend({ category: 'Supplies', vendor: 'Imports Ltd', description: 'Pump part', amount: 260, currency: 'USD' }));
    // Outside the period, and unpaid: neither is expenditure for June.
    await c.post('/api/expenses', spend({ category: 'Payroll', vendor: 'May Payroll', amount: 9000, date: '2026-05-10', datePaid: '2026-05-10' }));
    await c.post('/api/expenses', spend({ category: 'Contractors', vendor: 'GateTech', amount: 40000, status: 'pending', dueDate: '2026-06-25' }));

    const db = (await c.get('/api/db')).body;
    const jmd = operatingStatement(db.payments, db.expenses, db.units, 'JMD', FROM, TO);
    const usd = operatingStatement(db.payments, db.expenses, db.units, 'USD', FROM, TO);

    /* ================================================================
     * Every expense named, under its category
     * ================================================================ */

    const payroll = jmd.expenditure.find(g => g.label === 'Payroll');
    T.check('expenditure is classed by category', !!payroll, jmd.expenditure.map(g => g.label).join(', '));
    T.check('and Payroll holds both people paid under it', payroll?.lines.length === 2, `${payroll?.lines.length} line(s)`);

    const darryl = payroll?.lines.find(l => l.payee === 'Darryl Whyte');
    T.check(
      'Darryl Whyte appears by name, not folded into a Payroll lump',
      !!darryl && darryl.amount === 20000,
      JSON.stringify(payroll?.lines.map(l => [l.payee, l.amount]))
    );
    T.check('with the date and what it was for beside the figure', darryl?.date === '2026-06-10' && /Grounds/.test(darryl?.description || ''), JSON.stringify(darryl));
    T.check('and the category still totals correctly across its named lines', payroll?.total === 34500, `${payroll?.total} (20000 + 14500)`);

    T.check(
      'every expenditure line names a payee — nothing appears as a bare total',
      jmd.expenditure.every(g => g.lines.length > 0 && g.lines.every(l => l.payee.trim().length > 0)),
      'a line had no payee'
    );
    T.check(
      'and every category total is the sum of its own named lines',
      jmd.expenditure.every(g => Math.round(g.total * 100) === g.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0)),
      'a category total disagrees with its lines'
    );

    T.check(
      'work done on one villa is included and says which villa it was',
      jmd.expenditure.find(g => g.label === 'Maintenance')?.lines[0]?.allocation === 'Villa Unit 1',
      JSON.stringify(jmd.expenditure.find(g => g.label === 'Maintenance')?.lines[0])
    );
    T.check('common costs are allocated to General', payroll?.lines.every(l => l.allocation === 'General'), JSON.stringify(payroll?.lines.map(l => l.allocation)));

    /* ================================================================
     * Income, itemised and named too
     * ================================================================ */

    const contributions = jmd.income.find(g => g.label === 'Maintenance contributions');
    T.check('maintenance contributions are listed as their own class', !!contributions, jmd.income.map(g => g.label).join(', '));
    T.check('with each proprietor named against what they paid', contributions?.lines.map(l => l.payer).sort().join(', ') === 'Owner One, Owner Two', JSON.stringify(contributions?.lines.map(l => l.payer)));
    T.check('and the villa on each line', contributions?.lines.every(l => l.villa.startsWith('Villa Unit')), JSON.stringify(contributions?.lines.map(l => l.villa)));
    T.check('rent is a separate class of income', jmd.income.find(g => g.label === 'Rent')?.total === 60000, JSON.stringify(jmd.income.map(g => [g.label, g.total])));
    T.check('money entered but never confirmed is not income', jmd.totalIncome === 100000, `${jmd.totalIncome} (20000 + 20000 + 60000; the 15,000 cheque is unconfirmed)`);

    /* ================================================================
     * The bottom line
     * ================================================================ */

    T.check('total expenditure is the money actually paid out in the period', jmd.totalExpenditure === 76500, `${jmd.totalExpenditure} (34500 + 30000 + 4200 + 7800)`);
    T.check('a cost paid in an earlier month is not in this period', !jmd.expenditure.some(g => g.lines.some(l => l.payee === 'May Payroll')), 'May payroll leaked in');
    T.check('a bill raised but not paid is not expenditure', !jmd.expenditure.some(g => g.lines.some(l => l.payee === 'GateTech')), 'an unpaid bill was counted as spent');
    T.check('surplus is income less expenditure', jmd.surplus === 23500, `${jmd.surplus} (100000 - 76500)`);

    /* ================================================================
     * The currencies never meet
     * ================================================================ */

    T.check('the USD statement carries only USD income', usd.totalIncome === 1100, `${usd.totalIncome} (900 booking + 200 contribution)`);
    T.check('and only USD expenditure', usd.totalExpenditure === 260, `${usd.totalExpenditure}`);
    T.check('the JMD statement contains no USD figure', jmd.totalIncome === 100000 && jmd.totalExpenditure === 76500, 'a USD figure reached the JMD statement');
    T.check(
      'neither total is the sum of both currencies',
      jmd.totalIncome + usd.totalIncome === 101100 && jmd.totalIncome !== 101100,
      'the currencies were combined'
    );
    T.check('each statement states its own currency', jmd.currency === 'JMD' && usd.currency === 'USD');

    /* ================================================================
     * A refund is shown, not hidden
     * ================================================================ */

    const rentReceipt = db.payments.find(p => p.category === 'Rent' && p.status === 'completed' && p.currency === 'JMD');
    await c.post(`/api/payments/${rentReceipt.id}/refund`, { amount: 10000, reason: 'overpaid', method: 'Cash', refundedOn: '2026-06-25' });
    const afterRefund = operatingStatement((await c.get('/api/db')).body.payments, db.expenses, db.units, 'JMD', FROM, TO);
    const rentGroup = afterRefund.income.find(g => g.label === 'Rent');
    T.check('a refund appears as its own negative line rather than shrinking a receipt', rentGroup?.lines.some(l => l.amount === -10000), JSON.stringify(rentGroup?.lines.map(l => [l.payer, l.amount])));
    T.check('and it says who it went back to and why', rentGroup?.lines.some(l => /refunded/.test(l.payer) && /overpaid/.test(l.payer)), JSON.stringify(rentGroup?.lines.map(l => l.payer)));
    T.check('so the income total falls by exactly what went back', afterRefund.totalIncome === 90000, `${afterRefund.totalIncome}`);

    /* ================================================================
     * Choosing what goes on the statement
     *
     * The same period is two legitimately different documents. Ro, 2026-09-01:
     * maintenance should not be itemised on the copy that goes to the strata
     * corporation but should be internally, and short-stay rental has no place
     * on the council's statement while the office needs to see it.
     * ================================================================ */

    const council = operatingStatement(db.payments, db.expenses, db.units, 'JMD', FROM, TO, {
      income: { Maintenance: 'total', Booking: 'excluded' }
    });

    const councilContributions = council.income.find(g => g.label === 'Maintenance contributions');
    T.check('a class shown as a total still appears, with its figure', councilContributions?.total === 40000, `${councilContributions?.total}`);
    T.check('but names nobody', councilContributions?.lines.length === 0 && councilContributions?.itemised === false, `${councilContributions?.lines.length} line(s)`);
    T.check(
      'while the same class itemised internally still names every proprietor',
      jmd.income.find(g => g.label === 'Maintenance contributions')?.lines.length === 2,
      'the internal statement lost its detail'
    );
    T.check('collapsing a class does not change what it totals', councilContributions?.total === contributions?.total, `${councilContributions?.total} vs ${contributions?.total}`);
    T.check('nor the statement total', council.totalIncome === jmd.totalIncome, `${council.totalIncome} vs ${jmd.totalIncome}`);

    /* --- excluding a class removes its money and says so --- */

    const usdCouncil = operatingStatement(db.payments, db.expenses, db.units, 'USD', FROM, TO, {
      income: { Booking: 'excluded' }
    });
    T.check('an excluded class is gone from the statement', !usdCouncil.income.some(g => g.label === 'Short-stay bookings'), JSON.stringify(usdCouncil.income.map(g => g.label)));
    T.check(
      'its money leaves the total rather than lingering in it',
      usdCouncil.totalIncome === 200,
      `${usdCouncil.totalIncome} (1100 less the 900 booking)`
    );
    T.check(
      'and the statement declares what was left off, with the amount',
      usdCouncil.excludedIncome.some(e => e.label === 'Short-stay bookings' && e.total === 900),
      JSON.stringify(usdCouncil.excludedIncome)
    );
    T.check('so the surplus moves by exactly what was excluded', usdCouncil.surplus === -60, `${usdCouncil.surplus} (200 - 260)`);

    /* --- expenditure can be chosen the same way --- */

    const noVillaWork = operatingStatement(db.payments, db.expenses, db.units, 'JMD', FROM, TO, {
      expenditure: { Maintenance: 'excluded', Payroll: 'total' }
    });
    T.check('an expenditure class can be excluded too', !noVillaWork.expenditure.some(g => g.label === 'Maintenance'), JSON.stringify(noVillaWork.expenditure.map(g => g.label)));
    T.check('and it is declared with its amount', noVillaWork.excludedExpenditure.some(e => e.label === 'Maintenance' && e.total === 7800), JSON.stringify(noVillaWork.excludedExpenditure));
    T.check('the expenditure total drops by exactly that', noVillaWork.totalExpenditure === 68700, `${noVillaWork.totalExpenditure} (76500 - 7800)`);
    T.check(
      'a class shown as a total keeps its figure but drops its names',
      noVillaWork.expenditure.find(g => g.label === 'Payroll')?.total === 34500 &&
        noVillaWork.expenditure.find(g => g.label === 'Payroll')?.lines.length === 0,
      JSON.stringify(noVillaWork.expenditure.find(g => g.label === 'Payroll'))
    );

    /* --- the default is the whole statement --- */

    T.check(
      'passing no options gives everything, itemised',
      jmd.income.every(g => g.itemised) && jmd.expenditure.every(g => g.itemised) && jmd.excludedIncome.length === 0,
      'the default hid something'
    );
    T.check(
      'and a class nobody chose still appears rather than vanishing',
      operatingStatement(db.payments, db.expenses, db.units, 'JMD', FROM, TO, { income: { Rent: 'total' } }).income.some(
        g => g.label === 'Maintenance contributions' && g.itemised
      ),
      'an unmentioned class was dropped'
    );

    /* ---------------- a quiet period says so ---------------- */

    const quiet = operatingStatement(db.payments, db.expenses, db.units, 'JMD', '2026-01-01', '2026-01-31');
    T.check('a period with no activity reports itself as empty', quiet.empty === true && quiet.totalIncome === 0 && quiet.totalExpenditure === 0, JSON.stringify([quiet.empty, quiet.totalIncome]));
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
