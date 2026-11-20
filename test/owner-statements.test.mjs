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
    const statements = ownerStatements(db.units, db.charges, db.payments, db.expenses, db.utilities, period.from, period.to);
    const find = (unitId, currency) => statements.find(s => s.unit.id === unitId && s.currency === currency);

    const villa1 = find('unit-1', 'JMD');
    T.check('the long-term villa produces a statement', !!villa1);
    T.check('rent collected for the owner is stated', villa1?.rentCollected === 50000, `${villa1?.rentCollected}`);
    T.check('the unconfirmed cheque is excluded', villa1?.collected === 50000, `collected ${villa1?.collected}`);
    T.check('maintenance billed is deducted', villa1?.maintenanceBilled === 10000, `${villa1?.maintenanceBilled}`);
    T.check('only the villa\'s own paid expense is charged to it', villa1?.expenses === 8000, `${villa1?.expenses}`);
    T.check(
      'net is what the proprietor owes the corporation: maintenance billed plus expenses, never offset by the rent they collect',
      villa1?.net === -18000,
      `net ${villa1?.net} (expected -10000 - 8000: rent is the proprietor's own and does not pass through the corporation)`
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
    /*
     * Hunt, 2026-11-19: guest income is the letting party's own and is never on
     * an owner statement (`net` does not use it). A USD statement holding only
     * that income printed as all $0, "18 statements" for 16 villas. The JMD
     * levy statement is the one this villa owes on; no empty USD one is made.
     */
    T.check('a villa earning USD guest income and assessed in JMD yields only its JMD levy statement', !villa2Usd && !!villa2Jmd, `USD ${!!villa2Usd}, JMD ${!!villa2Jmd}`);
    T.check(
      'the USD income is not credited against the JMD statement',
      villa2Jmd?.collected === 0,
      `collected ${villa2Jmd?.collected}`
    );

    /* --- a proprietor who pays their own contribution owes nothing ---
     *
     * This is the fault real data found on 2026-09-01, and this suite used to
     * assert it: the expectation here read `net === -12000` for a villa whose
     * owner had paid the whole 12,000 in the period. Because the corporation
     * collects no rent for a proprietor, `collected` is nil and the net was
     * simply minus everything billed — so a proprietor who had settled in full
     * was shown, on screen and on the printed statement, "Due from <name>" for
     * the entire contribution, directly beside a line saying the money had been
     * received. The statement contradicted itself and the wrong figure is the
     * one an owner would have paid twice.
     */
    T.check(
      'maintenance the owner paid themselves is disclosed',
      villa2Jmd?.maintenancePaid === 12000,
      `${villa2Jmd?.maintenancePaid}`
    );
    T.check(
      'a contribution billed and paid in the period nets to nothing owed',
      villa2Jmd?.net === 0,
      `net ${villa2Jmd?.net} (billed 12000, paid 12000 — expected 0, not -12000)`
    );
    T.check(
      'and that villa then owes nothing at period end',
      villa2Jmd?.maintenanceOutstanding === 0,
      `${villa2Jmd?.maintenanceOutstanding}`
    );
    T.check(
      'a contribution billed and left unpaid is still owed in full',
      villa1?.maintenanceBilled === 10000 && villa1?.maintenancePaid === 0,
      `billed ${villa1?.maintenanceBilled}, paid ${villa1?.maintenancePaid}`
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
    T.check('the owner holds both villas', alba?.statements.length === 2 && new Set(alba.statements.map(x => x.unit.id)).size === 2, `${alba?.statements.length} statements`);
    T.check(
      'the net position is totalled per currency and never across',
      alba?.netByCurrency.find(r => r.currency === 'JMD')?.net === -18000 &&
        (alba?.netByCurrency.find(r => r.currency === 'USD')?.net ?? 0) === 0,
      JSON.stringify(alba?.netByCurrency)
    );

    /* ---------------- the period is a real boundary ---------------- */

    const earlier = ownerStatement(
      db.units.find(u => u.id === 'unit-1'),
      db.units,
      db.charges,
      db.payments,
      db.expenses,
      db.utilities,
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

    /* ---------------- money received before the period counts ---------------- */

    // Haresh Shivnani, 2026-11-16: October receipts covered November in advance. The
    // maintenance ledger said Settled; the owner statement said J$20,000 due.
    {
      const u = db.units.find(x => x.id === 'unit-1');
      const mk = (id, month, due) => ({ ...db.charges.find(ch => ch.unitId === 'unit-1' && ch.category === 'Maintenance'), id, amount: 20000, periodMonth: month, dueDate: due, status: 'open', currency: 'JMD' });
      const pay = (id, date, amount) => ({ ...db.payments.find(p => p.unitId === 'unit-1' && p.status === 'completed'), id, date, amount, category: 'Maintenance', status: 'completed', currency: 'JMD', refundedOn: undefined, refundedAmount: undefined });
      const charges = [mk('adv-1', '2026-10', '2026-10-01'), mk('adv-2', '2026-11', '2026-11-01')];
      const stmt = (payments, from, to) => ownerStatement(u, db.units, charges, payments, [], [], 'JMD', from, to);

      const prepaid = stmt([pay('adv-p1', '2026-10-27', 40000)], '2026-11-01', '2026-11-30');
      T.check('November paid in October is not stated as owing', prepaid.net === 0, `net ${prepaid.net}`);
      T.check('and the statement says so, as paid before the period', prepaid.maintenancePaidInAdvance === 20000, `${prepaid.maintenancePaidInAdvance}`);
      const unpaid = stmt([pay('adv-p2', '2026-10-27', 20000)], '2026-11-01', '2026-11-30');
      T.check('control: November with nothing covering it is still owing in full', unpaid.net === -20000 && unpaid.maintenancePaidInAdvance === 0, `net ${unpaid.net}`);
      const half = stmt([pay('adv-p3', '2026-10-27', 30000)], '2026-11-01', '2026-11-30');
      T.check('control: half covered in advance leaves half owing', half.net === -10000 && half.maintenancePaidInAdvance === 10000, `net ${half.net}, adv ${half.maintenancePaidInAdvance}`);
      const sameMonth = stmt([pay('adv-p4', '2026-11-05', 40000)], '2026-11-01', '2026-11-30');
      T.check('control: paid inside the period still settles it as before', sameMonth.net === 0 && sameMonth.maintenancePaidInAdvance === 0, `net ${sameMonth.net}`);
      const arrears = stmt([pay('adv-p5', '2026-11-05', 20000)], '2026-11-01', '2026-11-30');
      T.check('a receipt in November that paid OCTOBER does not settle November', arrears.net === -20000 && arrears.maintenanceAppliedToEarlier === 20000, `net ${arrears.net}, earlier ${arrears.maintenanceAppliedToEarlier}`);
      const octStmt = stmt([pay('adv-p5', '2026-11-05', 20000)], '2026-10-01', '2026-10-31');
      T.check('and October, as at its own period end, still shows owing (the later receipt does not rewrite it)', octStmt.net === -20000, `net ${octStmt.net}`);
      const sixMonthSplit = ['2026-10', '2026-11'].map(mo => stmt([pay('adv-p6', '2026-10-27', 40000)], mo + '-01', mo + '-' + (mo === '2026-10' ? '31' : '30')));
      T.check('prepaid 2 months: October holds the 20,000 still unspent as a credit, November owes nothing', sixMonthSplit[0].net === 20000 && sixMonthSplit[1].net === 0, JSON.stringify(sixMonthSplit.map(x => x.net)));
    }

    /* ---------------- what the statement SAYS about credit (QA, 2026-11-16) ---------------- */
    {
      const u = db.units.find(x => x.id === 'unit-1');
      const base = db.charges.find(ch => ch.unitId === 'unit-1' && ch.category === 'Maintenance');
      const basePay = db.payments.find(p => p.unitId === 'unit-1' && p.status === 'completed');
      const mkc = (id, month, due, amount = 10000) => ({ ...base, id, amount, periodMonth: month, dueDate: due, status: 'open', currency: 'JMD' });
      const mkp = (id, date, amount, extra = {}) => ({ ...basePay, id, date, amount, category: 'Maintenance', status: 'completed', currency: 'JMD', refundedOn: undefined, refundedAmount: undefined, ...extra });
      const st = (charges, payments, from, to) => ownerStatement(u, db.units, charges, payments, [], [], 'JMD', from, to);

      // 4a: December billed 10,000 and the owner paid 30,000 on 20 Dec. There ARE no earlier months.
      const dec = st([mkc('q1', '2026-12', '2026-12-01')], [mkp('qp1', '2026-12-20', 30000)], '2026-12-01', '2026-12-31');
      T.check('a surplus in the month is credit, not "applied to earlier months"', dec.maintenanceAppliedToEarlier === 0 && dec.maintenanceOwed === -20000, `earlier ${dec.maintenanceAppliedToEarlier}, owed ${dec.maintenanceOwed}`);

      // 4b: a refund in January, nothing billed in January, is not money paid before the period.
      const jan = st([mkc('q2', '2026-12', '2026-12-01')], [mkp('qp2', '2026-12-20', 30000, { refundedAmount: 20000, refundedOn: '2027-01-10' })], '2027-01-01', '2027-01-31');
      T.check('a refund paid out in January does not read as an advance paid before January', jan.maintenancePaidInAdvance === 0, `advance ${jan.maintenancePaidInAdvance}`);

      // 4a, the real case: October unpaid, a November receipt really does pay October.
      const nov = st([mkc('q3', '2026-10', '2026-10-01'), mkc('q4', '2026-11', '2026-11-01')], [mkp('qp3', '2026-11-05', 10000)], '2026-11-01', '2026-11-30');
      T.check('control: a November receipt that pays October is "applied to earlier months" and November still owes', nov.maintenanceAppliedToEarlier === 10000 && nov.maintenanceOwed === 10000, `earlier ${nov.maintenanceAppliedToEarlier}, owed ${nov.maintenanceOwed}`);

      // 4d: one owner, villa 1 holds 30,000 credit and villa 2 owes 10,000. Credit does not pay another villa's debt.
      const credStmt = { ...dec, unit: { ...u, ownerName: 'One Owner' }, net: 30000, currency: 'JMD' };
      const debtStmt = { ...dec, unit: { ...u, id: 'unit-x', ownerName: 'One Owner' }, net: -10000, currency: 'JMD' };
      const grp = groupStatementsByOwner([credStmt, debtStmt])[0];
      T.check('an owner\'s balance owing counts debts only: credit on one villa does not reduce another villa\'s arrears', grp.netByCurrency.find(r => r.currency === 'JMD')?.net === -10000, JSON.stringify(grp.netByCurrency));
      T.check('and the credit held is reported separately', grp.creditByCurrency?.find(r => r.currency === 'JMD')?.credit === 30000, JSON.stringify(grp.creditByCurrency));
    }

    /* ---------------- reversals and voids remove money ---------------- */

    const rentPayment = db.payments.find(p => p.unitId === 'unit-1' && p.status === 'completed');
    await c.post(`/api/payments/${rentPayment.id}/reverse`, { reversalReason: 'Cheque returned unpaid' });
    const maintCharge = db.charges.find(ch => ch.unitId === 'unit-1' && ch.category === 'Maintenance');
    await c.post(`/api/charges/${maintCharge.id}/void`, { reason: 'Billed in error' });

    const after = (await c.get('/api/db')).body;
    const villa1After = ownerStatements(after.units, after.charges, after.payments, after.expenses, after.utilities, period.from, period.to).find(
      s => s.unit.id === 'unit-1' && s.currency === 'JMD'
    );
    T.check('a reversed receipt is no longer collected for the owner', villa1After?.collected === 0, `${villa1After?.collected}`);
    T.check('a voided charge is no longer billed to them', villa1After?.maintenanceBilled === 0, `${villa1After?.maintenanceBilled}`);
    T.check(
      'and the net becomes what the villa cost them',
      villa1After?.net === -8000,
      `net ${villa1After?.net}`
    );

    /* ---------------- metered utilities reach the statement ---------------- */

    /*
     * A meter reading raised against a villa is money that villa owes, but the
     * statement used to show only the *settlement* of one — as a receipt on the
     * collected side. So an owner billed for consumption and yet to pay saw no
     * charge at all, and an owner who had paid saw a credit for a bill that
     * appeared nowhere on the page. The charge is shown now, whether or not it
     * has been settled, and a settled one nets against its own receipt.
     */
    const meterMonth = period.from.slice(0, 7);

    /*
     * Measured as a movement, not against a fixed figure. Earlier steps in this
     * file reverse a receipt and void a charge, so the villa's net by now is
     * whatever those left behind. The claim being tested is that a meter reading
     * moves the net by exactly what it billed — which is true wherever this
     * block sits, and does not silently break when something above it changes.
     */
    const statementFor = (database, unitId, currency) =>
      ownerStatements(database.units, database.charges, database.payments, database.expenses, database.utilities, period.from, period.to).find(
        s => s.unit.id === unitId && s.currency === currency
      );

    const netBeforeReading = statementFor((await c.get('/api/db')).body, 'unit-1', 'JMD')?.net ?? 0;

    const unpaidReading = await c.post('/api/utilities', {
      unitId: 'unit-1',
      billingPeriod: meterMonth,
      previousReading: 100,
      currentReading: 260,
      amountCharged: 7500,
      currency: 'JMD'
    });
    T.check('a meter reading can be billed to a villa', unpaidReading.status === 200, `status ${unpaidReading.status}`);

    const withUtility = (await c.get('/api/db')).body;
    const villa1Utility = statementFor(withUtility, 'unit-1', 'JMD');

    T.check(
      'an unpaid meter reading is billed to the owner on their statement',
      villa1Utility?.utilityBilled === 7500,
      `utilityBilled ${villa1Utility?.utilityBilled}`
    );
    T.check(
      'and is itemised, not merely totalled',
      villa1Utility?.utilityCharges?.length === 1,
      `${villa1Utility?.utilityCharges?.length} reading(s) itemised`
    );
    T.check(
      'and it reduces the net by exactly what was billed',
      villa1Utility?.net === netBeforeReading - 7500,
      `net moved from ${netBeforeReading} to ${villa1Utility?.net}, expected a fall of 7500`
    );
    /*
     * A proprietor's supply is on their own meter in their own name and settled
     * directly with the utility, so the corporation neither pays it nor bills
     * it. The statement must therefore be silent about utilities for them — not
     * merely show a nil. A villa with no reading carries no utility figure at
     * all, which is what lets the page omit the section entirely.
     */
    T.check(
      'a villa with no meter reading is billed nothing for utilities',
      ownerStatements(withUtility.units, withUtility.charges, withUtility.payments, withUtility.expenses, withUtility.utilities, period.from, period.to)
        .filter(s => s.unit.id !== 'unit-1')
        .every(s => s.utilityBilled === 0),
      'a reading leaked onto another villa'
    );

    /*
     * Settling the reading today — after the statement period closed — must not
     * reach back and tidy the charge out of that period. The owner was billed in
     * the period and had not paid by the end of it, and a statement that quietly
     * rewrites itself when a later payment lands is one nobody can reconcile
     * against the copy they were sent.
     *
     * The receipt belongs to the period it was actually received in, which is a
     * different statement.
     */
    const settled = await c.post(`/api/utilities/${unpaidReading.body?.utility?.id}/settle`, { method: 'Cash' });
    if (settled.body?.payment?.id) await c.post(`/api/payments/${settled.body.payment.id}/confirm`, {});
    const afterSettle = statementFor((await c.get('/api/db')).body, 'unit-1', 'JMD');
    T.check(
      'settling a reading leaves the charge standing on the period it was billed in',
      afterSettle?.utilityBilled === 7500,
      `utilityBilled ${afterSettle?.utilityBilled}`
    );
    T.check(
      'and a payment made after the period does not retroactively change that period',
      afterSettle?.net === netBeforeReading - 7500,
      `net ${afterSettle?.net}, expected to stay at ${netBeforeReading - 7500}`
    );

    /* ---------------- one supply is billed once ---------------- */

    /*
     * A metered villa produces two records for the same electricity: the
     * supplier's invoice the corporation pays, and the reading it bills the
     * owner from. Both landing on the statement would charge the owner twice for
     * one supply, and that error does not stay on the page — it flows into the
     * net, into arrears, and into every figure derived from them.
     *
     * The reading bills the owner. The invoice is the corporation's cost.
     */
    const beforeInvoice = statementFor((await c.get('/api/db')).body, 'unit-1', 'JMD');
    const netBeforeInvoice = beforeInvoice?.net ?? 0;
    const beforeInvoiceExpenses = beforeInvoice?.expenses ?? 0;

    await c.post(
      '/api/expenses',
      expense({ unitId: 'unit-1', category: 'Utilities', vendor: 'Jamaica Public Service', amount: 7500, description: 'JPS invoice for the metered period' })
    );

    const afterInvoice = statementFor((await c.get('/api/db')).body, 'unit-1', 'JMD');
    T.check(
      "the supplier's utility invoice does not bill the owner a second time",
      afterInvoice?.net === netBeforeInvoice,
      `net moved from ${netBeforeInvoice} to ${afterInvoice?.net} — the same supply was charged twice`
    );
    T.check(
      'and it is kept out of what was recharged to the villa',
      afterInvoice?.expenses === beforeInvoiceExpenses,
      `expenses ${afterInvoice?.expenses}, expected to stay at ${beforeInvoiceExpenses}`
    );

    // A cost with no second record still reaches the owner, so the exclusion is
    // narrow rather than a blanket refusal to recharge anything.
    await c.post('/api/expenses', expense({ unitId: 'unit-1', category: 'Maintenance', vendor: 'A. Locksmith', amount: 2500, description: 'Replace front door lock' }));
    const afterLocksmith = statementFor((await c.get('/api/db')).body, 'unit-1', 'JMD');
    T.check(
      'an ordinary cost charged to the villa still reaches the owner',
      afterLocksmith?.expenses === beforeInvoiceExpenses + 2500,
      `expenses ${afterLocksmith?.expenses}, expected ${beforeInvoiceExpenses + 2500}`
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
