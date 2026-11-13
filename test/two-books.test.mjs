/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two books: the corporation's money and ISPO's money.
 *
 * Ro, 2026-09-03: *"Ispo, the company that owns VDS is the company who collects
 * the Rent payments, there are certain expenses, such as Cell phone bills,
 * company vehicle expenses and insurance and other expenses that are paid from
 * the rental income. This has not yet been accounted for … the current posted
 * months are expenses incurred by the strata (VDS) from which the maintenance
 * payments are supposed to cover. The other expenses i mentioned are supposed to
 * come from the Rental Income for Ispo."*
 *
 * And, on the same day: *"ensure there's no double counting anywhere."*
 *
 * Before this existed every cost was the corporation's, so ISPO's phone bill was
 * on the proprietors' monthly report and — through `feeToCoverBudget` — inside
 * the maintenance contribution the annual report puts to the meeting. The rules
 * asserted here, in the property's own terms rather than the code's:
 *
 *   1. What Ro listed as the corporation's stays the corporation's. The office,
 *      property electricity, grounds staff, pool, painting. Nothing moves.
 *   2. ISPO's costs are not the proprietors' business: off the monthly report,
 *      off the annual report, off Form 13C, off owner statements.
 *   3. And they no longer inflate the contribution put to the meeting.
 *   4. **Every cost is in exactly one book.** strata + ISPO = the whole, in every
 *      period and both currencies. This is the arithmetic guarantee against
 *      double counting: it fails if anything is counted twice *or* lost.
 *   5. The contribution ISPO pays on its own villas is the same money on two
 *      sides. It is named as a transfer and counted once on each, never twice on
 *      one.
 *   6. ISPO Operations and the shortfall report answer the same question about
 *      the same villas, so they are made to agree.
 *   7. A record written before the two books existed is the corporation's.
 *   8. A monthly cost carries its book onto everything it raises, every month.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'The two books — strata and ISPO';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-books-'));
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

function lastMonth() {
  const now = new Date();
  const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Books-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const {
    operationsStatement,
    operatingStatement,
    ispoOperations,
    annualOwnersReport,
    monthlyOwnersReport,
    ownerStatements,
    outOfPocketShortfall,
    form13CDebts,
    expensesInPeriod,
    strataExpenses,
    ispoExpenses
  } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Books-1234!', 'BooksNew-9876!');

    const month = lastMonth();
    const from = `${month}-01`;
    const to = `${month}-28`;
    const year = Number(month.substring(0, 4));

    /*
     * Villa 1 is VDS's and let. Villa 2 belongs to a proprietor, which the
     * register records as `owner-occupied` — Ro, 2026-11-12: owners are
     * responsible for their own tenants and rental payments, so the corporation
     * bills a proprietor's villa maintenance only and never its rent. That
     * status is what `isOwnAccount` reads, so it is what keeps villa 2's
     * contribution out of the transfer between the books.
     */
    await makeLongTermUnit(c, 'unit-1', { ownerName: 'Villaggio Del Sol' });
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'A Proprietor',
      status: 'owner-occupied',
      monthlyRent: 0,
      monthlyMaintenance: 10000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });

    await c.post('/api/charges/post-month', { monthString: month });

    /* ================================================================
     * The money, entered exactly as the office would enter it
     * ================================================================ */

    // Contributions from both villas — including VDS paying its own, which Ro
    // confirmed on 2026-09-02 the system does and should.
    for (const unitId of ['unit-1', 'unit-2']) {
      await recordAndConfirmPayment(c, {
        unitId,
        category: 'Maintenance',
        amount: 10000,
        currency: 'JMD',
        payerName: unitId === 'unit-1' ? 'Villaggio Del Sol' : 'A Proprietor',
        method: 'Bank Transfer',
        date: `${month}-04`
      });
    }

    // Rent on the villa VDS lets. ISPO's income.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Bank Transfer',
      date: `${month}-03`
    });

    /* ---------------- the corporation's costs ---------------- */

    const strataCosts = [
      { category: 'Security', vendor: 'Guardsman Ltd', amount: 96000, unitNumber: 'General' },
      { category: 'Landscaping', vendor: 'Grounds Crew', amount: 30000, unitNumber: 'General' },
      { category: 'Utilities', vendor: 'JPS — common property', amount: 42000, unitNumber: 'General' },
      // The office, which Ro named explicitly as the corporation's.
      { category: 'Supplies', vendor: 'Office Supplies Ltd', amount: 8000, unitNumber: 'Office' }
    ];
    for (const cost of strataCosts) {
      const r = await c.post('/api/expenses', {
        ...cost,
        currency: 'JMD',
        status: 'paid',
        date: `${month}-10`,
        datePaid: `${month}-10`
      });
      if (r.status !== 200) T.check(`strata cost ${cost.vendor} recorded`, false, String(r.body?.error));
    }

    /* ---------------- ISPO's own costs ---------------- */

    const ispoCosts = [
      { category: 'Utilities', vendor: 'Digicel', description: 'Company cell phones', amount: 18000 },
      { category: 'Other', vendor: 'Vehicle Servicing', description: 'Company vehicle', amount: 34000 },
      { category: 'Other', vendor: 'Insurance Co', description: 'Company vehicle insurance', amount: 12000 }
    ];
    for (const cost of ispoCosts) {
      const r = await c.post('/api/expenses', {
        ...cost,
        unitNumber: 'General',
        currency: 'JMD',
        fund: 'ispo',
        status: 'paid',
        date: `${month}-12`,
        datePaid: `${month}-12`
      });
      if (r.status !== 200) T.check(`ISPO cost ${cost.vendor} recorded`, false, String(r.body?.error));
    }

    let db = (await c.get('/api/db')).body;

    const STRATA_TOTAL = 96000 + 30000 + 42000 + 8000; // 176,000
    const ISPO_TOTAL = 18000 + 34000 + 12000; //  64,000

    T.check(
      'the costs went in as entered',
      db.expenses.length === 7,
      `${db.expenses.length} expenses`
    );
    T.check(
      'and a cost marked as paid from rental income says so on the record',
      db.expenses.filter(e => e.fund === 'ispo').length === 3,
      JSON.stringify(db.expenses.map(e => ({ v: e.vendor, f: e.fund })))
    );

    /* ================================================================
     * Rule 7 — absent means the corporation's
     * ================================================================ */

    T.check(
      'a cost entered without naming a book is the corporation’s',
      db.expenses.filter(e => e.vendor === 'Guardsman Ltd').every(e => e.fund === 'strata'),
      String(db.expenses.find(e => e.vendor === 'Guardsman Ltd')?.fund)
    );
    T.check(
      'and the split helpers agree with the records',
      strataExpenses(db.expenses).length === 4 && ispoExpenses(db.expenses).length === 3,
      `${strataExpenses(db.expenses).length} strata, ${ispoExpenses(db.expenses).length} ISPO`
    );

    /* ================================================================
     * Rule 1 — what Ro listed as the corporation's is still counted
     * ================================================================ */

    const ops = operationsStatement(db.expenses, db.payments, 'JMD', from, to);
    T.check(
      'the proprietors’ monthly report still counts security, grounds, common electricity and the office',
      ops.costsPaid === STRATA_TOTAL,
      `${ops.costsPaid}, expected ${STRATA_TOTAL}`
    );
    T.check(
      'the office is on it by name, because Ro said the office is the corporation’s',
      ops.groups.some(g => g.lines.some(l => l.vendor === 'Office Supplies Ltd')),
      JSON.stringify(ops.groups.map(g => g.category))
    );

    /* ================================================================
     * Rule 2 — ISPO's costs are not the proprietors' business
     * ================================================================ */

    T.check(
      'the cell phone is NOT on the proprietors’ monthly report',
      !ops.groups.some(g => g.lines.some(l => l.vendor === 'Digicel')),
      'Digicel reached the owners’ statement'
    );
    T.check(
      'nor is the company vehicle, or its insurance',
      !ops.groups.some(g => g.lines.some(l => l.vendor === 'Vehicle Servicing' || l.vendor === 'Insurance Co')),
      'a vehicle cost reached the owners’ statement'
    );

    const monthly = monthlyOwnersReport(db.units, db.charges, db.payments, db.expenses, 'JMD', month);
    T.check(
      'the report circulated to owners totals the corporation’s costs only',
      monthly.costsPaid === STRATA_TOTAL,
      `${monthly.costsPaid}, expected ${STRATA_TOTAL}`
    );

    const annual = annualOwnersReport(db.units, db.charges, db.payments, db.expenses, 'JMD', year, {});
    T.check(
      'the annual report’s expenditure is the corporation’s costs only',
      annual.expenditure === STRATA_TOTAL,
      `${annual.expenditure}, expected ${STRATA_TOTAL}`
    );
    T.check(
      'and no ISPO category appears in its category table',
      !annual.categories.some(r => r.actual > 0 && r.category === 'Other'),
      JSON.stringify(annual.categories.map(r => ({ c: r.category, a: r.actual })))
    );

    /* ================================================================
     * Rule 3 — and it no longer inflates the contribution put to the AGM
     * ================================================================ */

    /*
     * The whole point, in one figure. The contribution the annual report asks the
     * meeting to approve is the budget divided by the villas and the months. Any
     * ISPO cost inside that budget is a bill for the company's vehicle sent to
     * sixteen proprietors, in the one number they actually vote on.
     */
    const withoutIspo = annualOwnersReport(
      db.units,
      db.charges,
      db.payments,
      strataExpenses(db.expenses),
      'JMD',
      year,
      {}
    );
    T.check(
      'the contribution put to the meeting is computed from the corporation’s costs alone',
      annual.feeToCoverBudget === withoutIspo.feeToCoverBudget,
      `${annual.feeToCoverBudget} vs ${withoutIspo.feeToCoverBudget}`
    );

    const asIfEverythingWereStrata = annualOwnersReport(
      db.units,
      db.charges,
      db.payments,
      db.expenses.map(e => ({ ...e, fund: 'strata' })),
      'JMD',
      year,
      {}
    );
    T.check(
      'and that is a real difference, not a coincidence — the old behaviour asked for more',
      asIfEverythingWereStrata.feeToCoverBudget > annual.feeToCoverBudget,
      `old ${asIfEverythingWereStrata.feeToCoverBudget}, now ${annual.feeToCoverBudget}`
    );

    /* ---------------- the statutory return ---------------- */

    const unpaidIspo = await c.post('/api/expenses', {
      category: 'Other',
      vendor: 'Tyre Shop',
      description: 'Company vehicle tyres',
      unitNumber: 'General',
      amount: 25000,
      currency: 'JMD',
      fund: 'ispo',
      status: 'pending',
      date: `${month}-14`,
      dueDate: `${month}-14`
    });
    T.check('an unpaid ISPO bill is recorded', unpaidIspo.status === 200, String(unpaidIspo.body?.error || ''));
    db = (await c.get('/api/db')).body;

    const form13c = form13CDebts(db.expenses, `${month}-28`);
    T.check(
      'ISPO’s unpaid bill is NOT declared as a debt of the body corporate',
      !form13c.rows.some(r => r.buckets.total === 25000),
      JSON.stringify(form13c.rows)
    );
    T.check(
      'the Commission’s return is not simply empty either — it still carries the corporation’s own',
      form13CDebts(
        [
          ...db.expenses,
          {
            id: 'strata-unpaid',
            category: 'Security',
            vendor: 'Guardsman Ltd',
            description: '',
            unitId: '',
            unitNumber: 'General',
            amount: 5000,
            currency: 'JMD',
            date: `${month}-14`,
            dueDate: `${month}-14`,
            status: 'pending',
            reference: '',
            notes: ''
          }
        ],
        `${month}-28`
      ).rows.length === 1,
      'the corporation’s own unpaid bill did not reach Form 13C'
    );

    /* ---------------- owner statements ---------------- */

    const villaCost = await c.post('/api/expenses', {
      category: 'Maintenance',
      vendor: 'Ocho Plumbing',
      description: 'Work on the proprietor’s villa',
      unitId: 'unit-2',
      amount: 15000,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-16`,
      datePaid: `${month}-16`
    });
    T.check('work recharged to a proprietor is recorded', villaCost.status === 200, String(villaCost.body?.error || ''));

    const ispoVillaCost = await c.post('/api/expenses', {
      category: 'Contractors',
      vendor: 'Handyman',
      description: 'ISPO’s own villa, ISPO’s own money',
      unitId: 'unit-1',
      amount: 9000,
      currency: 'JMD',
      fund: 'ispo',
      status: 'paid',
      date: `${month}-17`,
      datePaid: `${month}-17`
    });
    T.check('a cost ISPO paid on its own villa is recorded', ispoVillaCost.status === 200, String(ispoVillaCost.body?.error || ''));

    db = (await c.get('/api/db')).body;
    const statements = ownerStatements(db.units, db.charges, db.payments, db.expenses, db.utilities, from, to);
    const villa2 = statements.find(s => s.unit.number === '2' && s.currency === 'JMD');
    const villa1 = statements.find(s => s.unit.number === '1' && s.currency === 'JMD');

    T.check(
      'a proprietor is still shown work the corporation did on their villa',
      villa2?.expenses === 15000,
      String(villa2?.expenses)
    );
    T.check(
      'but a cost ISPO paid on its own villa is charged to nobody',
      villa1?.expenses === 0,
      String(villa1?.expenses)
    );

    /* ================================================================
     * The projection is the corporation's too
     * ================================================================ */

    /*
     * `Projections` states at the head of its own file that rent and booking
     * income are excluded "because they belong to individual proprietors, not to
     * the corporation". A projection that excludes ISPO's income while counting
     * ISPO's costs would invent a deficit for the fund out of money that was
     * never the fund's — and it would do it on a page that explains what it
     * leaves out, which is worse.
     *
     * The screen computes this through `expensesInPeriod(strataExpenses(...))`.
     * The rule asserted here is the property's, not the function's: the
     * corporation's projected outgoings are the corporation's costs.
     */
    const projectedOutgoings = expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to);
    T.check(
      'the corporation’s cash projection counts the corporation’s costs',
      projectedOutgoings === STRATA_TOTAL + 15000,
      `${projectedOutgoings}, expected ${STRATA_TOTAL + 15000}`
    );
    T.check(
      'and not the phone bill, the vehicle or its insurance',
      projectedOutgoings !== expensesInPeriod(db.expenses, 'JMD', from, to),
      'the projection counted ISPO’s costs against the fund’s contributions'
    );

    /* ================================================================
     * Rule 4 — every cost is in exactly one book
     * ================================================================ */

    /*
     * The arithmetic guarantee, and the direct answer to "ensure there's no
     * double counting anywhere". If a cost were counted in both books the sum
     * would exceed the whole; if one fell between them it would fall short.
     * Checked over several periods and both currencies, because a rule that only
     * holds for the month somebody happened to test is not a rule.
     */
    const periods = [
      [from, to],
      [`${year}-01-01`, `${year}-12-31`],
      [from, `${month}-15`]
    ];
    let identityHolds = true;
    const identityDetail = [];
    for (const [s0, e0] of periods) {
      for (const currency of ['JMD', 'USD']) {
        const whole = expensesInPeriod(db.expenses, currency, s0, e0);
        const a = expensesInPeriod(strataExpenses(db.expenses), currency, s0, e0);
        const b = expensesInPeriod(ispoExpenses(db.expenses), currency, s0, e0);
        if (Math.abs(whole - (a + b)) > 0.005) {
          identityHolds = false;
          identityDetail.push(`${currency} ${s0}..${e0}: ${a} + ${b} != ${whole}`);
        }
      }
    }
    T.check('every cost is in exactly one book — the two always sum to the whole', identityHolds, identityDetail.join('; '));
    T.check(
      'and the books are not trivially satisfied by one of them being empty',
      expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to) > 0 &&
        expensesInPeriod(ispoExpenses(db.expenses), 'JMD', from, to) > 0,
      'one of the two books had nothing in it'
    );

    /* ---------------- the combined statement states the same split ---------------- */

    const op = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to);
    T.check(
      'the combined statement is still combined — Ro’s all-in view keeps everything',
      op.totalExpenditure === op.strataExpenditure + op.ispoExpenditure,
      `${op.strataExpenditure} + ${op.ispoExpenditure} != ${op.totalExpenditure}`
    );
    T.check(
      'and it names how much of itself is ISPO’s',
      op.ispoExpenditure === ISPO_TOTAL + 9000,
      `${op.ispoExpenditure}, expected ${ISPO_TOTAL + 9000}`
    );
    T.check(
      'while the corporation’s side of it matches the owners’ statement exactly',
      op.strataExpenditure === STRATA_TOTAL + 15000,
      `${op.strataExpenditure}, expected ${STRATA_TOTAL + 15000}`
    );

    /* ================================================================
     * Rule 5 — the contribution ISPO pays is counted once on each side
     * ================================================================ */

    T.check(
      'the transfer between the two books is named on the combined statement',
      op.internalTransfer === 10000,
      `${op.internalTransfer}, expected the 10,000 VDS paid on its own villa`
    );
    T.check(
      'and it is not the proprietor’s contribution — only the one VDS paid itself',
      op.internalTransfer !== 20000,
      'the transfer swept up a proprietor’s contribution'
    );

    const ispo = ispoOperations(db.expenses, db.payments, db.units, 'JMD', from, to);
    T.check(
      'ISPO’s statement counts that contribution as a cost of letting, once',
      ispo.maintenanceOnOwnVillas === 10000,
      `${ispo.maintenanceOnOwnVillas}`
    );
    T.check(
      'and ISPO’s own costs do not include it a second time',
      ispo.ownCostsPaid === ISPO_TOTAL + 9000,
      `${ispo.ownCostsPaid}, expected ${ISPO_TOTAL + 9000}`
    );
    T.check(
      'so ISPO’s total costs are its own plus that one contribution, and nothing counted twice',
      ispo.totalCosts === ISPO_TOTAL + 9000 + 10000,
      `${ispo.totalCosts}`
    );
    T.check(
      'the corporation still counts the same contribution as income, which is correct — it received it',
      ops.maintenanceCollected === 20000,
      `${ops.maintenanceCollected}`
    );

    /* ---------------- the shape that would double count ---------------- */

    const alsoAsCost = await c.post('/api/expenses', {
      category: 'Maintenance',
      vendor: 'Villaggio Del Sol',
      description: 'Contribution on our own villa',
      unitId: 'unit-1',
      amount: 10000,
      currency: 'JMD',
      fund: 'ispo',
      status: 'paid',
      date: `${month}-05`,
      datePaid: `${month}-05`
    });
    T.check('the contribution can be typed into the register as well', alsoAsCost.status === 200);

    const check = await c.get('/api/integrity');
    const findings = check.body?.findings || [];
    T.check(
      'and when it is, the application says so rather than counting it twice in silence',
      findings.some(f => f.code === 'contribution-entered-as-a-cost'),
      JSON.stringify(findings.map(f => f.code))
    );

    /*
     * Detecting it is not enough — Ro asked for no double counting anywhere, and
     * a warning nobody reads is still a wrong figure on a statement. So the
     * statement is immune to the shape as well as watchful for it: the cost row
     * is left out of ISPO's own costs, because the contribution it duplicates is
     * already counted from its receipt.
     *
     * This assertion is here because mutation testing found its absence. Making
     * the statement count that row as well produced no failure at all, which
     * meant the double-count guarantee was a claim rather than a test.
     */
    db = (await c.get('/api/db')).body;
    const withDupe = ispoOperations(db.expenses, db.payments, db.units, 'JMD', from, to);
    T.check(
      'a contribution typed into the register as well is NOT counted a second time',
      withDupe.maintenanceOnOwnVillas === 10000 && withDupe.ownCostsPaid === ISPO_TOTAL + 9000,
      `maintenance ${withDupe.maintenanceOnOwnVillas}, own costs ${withDupe.ownCostsPaid}`
    );
    T.check(
      'so the total is unmoved by it',
      withDupe.totalCosts === ISPO_TOTAL + 9000 + 10000,
      `${withDupe.totalCosts}, expected ${ISPO_TOTAL + 9000 + 10000}`
    );
    T.check(
      'and the row it left out is named rather than silently dropped',
      withDupe.excludedAsContributionCount === 1 && withDupe.excludedAsContribution === 10000,
      JSON.stringify({ n: withDupe.excludedAsContributionCount, amount: withDupe.excludedAsContribution })
    );

    // Taken back out, so the rest of the file measures a clean set of books.
    db = (await c.get('/api/db')).body;
    const dupe = db.expenses.find(e => e.description === 'Contribution on our own villa');
    await c.post(`/api/expenses/${dupe.id}/void`, {
      reason: 'Already receipted — would be counted twice',
      confirmSettled: true
    });
    db = (await c.get('/api/db')).body;
    T.check(
      'taking it back clears the finding',
      !((await c.get('/api/integrity')).body?.findings || []).some(f => f.code === 'contribution-entered-as-a-cost'),
      'the finding survived the void'
    );

    /* ================================================================
     * Rule 6 — ISPO Operations and the shortfall report must agree
     * ================================================================ */

    const shortfall = outOfPocketShortfall(db.units, db.tenancies, db.bookings, db.payments, 'JMD', from, to);
    const ispoNow = ispoOperations(db.expenses, db.payments, db.units, 'JMD', from, to);
    T.check(
      'the two reports agree on what the own-account villas paid in contributions',
      shortfall.totalMaintenancePaid === ispoNow.maintenanceOnOwnVillas,
      `shortfall ${shortfall.totalMaintenancePaid} vs ISPO statement ${ispoNow.maintenanceOnOwnVillas}`
    );
    T.check(
      'and on what they earned in rent',
      shortfall.totalRentReceived === ispoNow.rentReceived,
      `shortfall ${shortfall.totalRentReceived} vs ISPO statement ${ispoNow.rentReceived}`
    );
    T.check(
      'and neither of those is zero, so the agreement means something',
      shortfall.totalMaintenancePaid > 0 && shortfall.totalRentReceived > 0,
      JSON.stringify({ maint: shortfall.totalMaintenancePaid, rent: shortfall.totalRentReceived })
    );

    /* ================================================================
     * Rule 8 — a monthly cost carries its book, every month
     * ================================================================ */

    const phoneTemplate = await c.post('/api/recurring-expenses', {
      category: 'Utilities',
      vendor: 'Digicel monthly',
      unitNumber: 'General',
      amount: 18000,
      currency: 'JMD',
      fund: 'ispo',
      dueDay: 10
    });
    T.check('a monthly cost can be set up against ISPO', phoneTemplate.body?.template?.fund === 'ispo', String(phoneTemplate.body?.error || ''));

    const payrollTemplate = await c.post('/api/recurring-expenses', {
      category: 'Payroll',
      vendor: 'Grounds staff',
      unitNumber: 'General',
      amount: 60000,
      currency: 'JMD',
      dueDay: 28
    });
    T.check('and one set up without saying is the corporation’s', payrollTemplate.body?.template?.fund === 'strata');

    const posted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: phoneTemplate.body.template.id }, { recurringId: payrollTemplate.body.template.id }]
    });
    T.check('the month posts both', posted.body?.created === 2, String(posted.body?.error || posted.body?.created));

    db = (await c.get('/api/db')).body;
    T.check(
      'and each raised cost landed in the book its template named',
      db.expenses.find(e => e.vendor === 'Digicel monthly')?.fund === 'ispo' &&
        db.expenses.find(e => e.vendor === 'Grounds staff')?.fund === 'strata',
      JSON.stringify(db.expenses.filter(e => e.periodMonth === month).map(e => ({ v: e.vendor, f: e.fund })))
    );

    /*
     * The run raised a cost into each book. The identity from rule 4 must still
     * hold afterwards — this is the check that a month posted the ordinary way
     * cannot break the separation.
     */
    const whole = expensesInPeriod(db.expenses, 'JMD', from, to);
    const both =
      expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to) +
      expensesInPeriod(ispoExpenses(db.expenses), 'JMD', from, to);
    T.check('and posting a month leaves the two books still summing to the whole', Math.abs(whole - both) < 0.005, `${both} vs ${whole}`);

    /* ---------------- a taken-back cost is in neither book ---------------- */

    const toVoid = db.expenses.find(e => e.vendor === 'Digicel monthly');
    await c.post(`/api/expenses/${toVoid.id}/void`, { reason: 'Posted against the wrong month' });
    db = (await c.get('/api/db')).body;
    const afterVoid = ispoOperations(db.expenses, db.payments, db.units, 'JMD', from, to);
    T.check(
      'a cost taken back is counted by neither book',
      !afterVoid.groups.some(g => g.lines.some(l => l.vendor === 'Digicel monthly')) &&
        !afterVoid.unpaidLines.some(l => l.vendor === 'Digicel monthly'),
      'a voided ISPO cost was still on the statement'
    );
    T.check(
      'and the identity survives that too',
      Math.abs(
        expensesInPeriod(db.expenses, 'JMD', from, to) -
          (expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to) +
            expensesInPeriod(ispoExpenses(db.expenses), 'JMD', from, to))
      ) < 0.005,
      'the books stopped summing to the whole after a void'
    );

    /* ================================================================
     * Who may see the ISPO statement
     * ================================================================ */

    /*
     * Ro, 2026-09-03: *"Every role unless withdrawn is the best option."* Asserted
     * on the server, because that is where the default lives and where a database
     * written before the permission existed gets merged.
     *
     * This also guards the fault found beside it: `Reports.tsx` used to wrap the
     * shortfall report in `session.role === 'ADMINISTRATOR'` while the component
     * itself implemented "every role unless withdrawn", so the permission could
     * never grant anything to anybody — a guard that could not fire, counted as
     * coverage. The outer wrapper is gone; these assertions are what stops it
     * coming back.
     */
    await c.post('/api/users', { name: 'Junior Jo', username: 'junior2', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior2', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    const jrPerms = (await jr.get('/api/db')).body?.currentUser?.permissions;
    T.check('the junior is signed in', (await jr.get('/api/db')).body?.currentUser?.role === 'JUNIOR_OFFICER');
    T.check(
      'every role sees the ISPO statement by default, as Ro asked',
      jrPerms?.viewIspoOperations === true,
      JSON.stringify({ ispo: jrPerms?.viewIspoOperations, shortfall: jrPerms?.viewShortfall })
    );
    T.check('and the shortfall report, by the same rule', jrPerms?.viewShortfall === true, String(jrPerms?.viewShortfall));

    const withdrawn = await c.post('/api/settings', {
      rolePermissions: { JUNIOR_OFFICER: { ...jrPerms, viewIspoOperations: false } }
    });
    T.check('it can be withdrawn in Settings', withdrawn.body?.settings?.rolePermissions?.JUNIOR_OFFICER?.viewIspoOperations === false, String(withdrawn.body?.error || ''));
    T.check(
      'and the withdrawal reaches the junior with no re-login',
      (await jr.get('/api/db')).body?.currentUser?.permissions?.viewIspoOperations === false,
      'the change did not reach the session'
    );
    T.check(
      'while the shortfall report is untouched by it — they are separate switches',
      (await jr.get('/api/db')).body?.currentUser?.permissions?.viewShortfall === true,
      'withdrawing one took the other away'
    );

    /* ---------------- what the books are not allowed to be ---------------- */

    T.check(
      'a cost cannot be filed under a book that does not exist',
      (
        await c.post('/api/expenses', {
          category: 'Other',
          vendor: 'Nobody',
          unitNumber: 'General',
          amount: 100,
          currency: 'JMD',
          fund: 'someone-elses-money',
          status: 'paid',
          date: `${month}-20`,
          datePaid: `${month}-20`
        })
      ).status === 400,
      'an unknown book was accepted'
    );
    /* ================================================================
     * The upgrade path — a database written before any of this existed
     * ================================================================ */

    /*
     * The rule "absent means granted" only ever fires on a **real upgrade**: a
     * `db.json` written before the field existed, whose stored role permissions
     * carry no value for it. A fresh database never exercises it, because its
     * defaults already contain the key.
     *
     * Which is exactly how it went untested. Deleting the merge line in
     * `server/db.ts` broke nothing at all, because every test until now started
     * from a fresh database. This is the HP's actual upgrade path — the machine
     * has a `db.json` that predates both the shortfall report and the two books —
     * and if the absence were read as a denial, the whole team would lose these
     * screens on the next restart with nobody having changed a setting.
     *
     * So: take a real database, strip the keys the way an older version would
     * have left them, restart on it, and read them back.
     */
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-upgrade-'));
    let upgraded = null;
    try {
      const seed = await startServer({ port: port + 4000, adminPassword: 'Old-1234!', projectRoot, dataDir: oldDir });
      const seedClient = makeClient(seed.baseUrl);
      await activateAdmin(seedClient, 'Old-1234!', 'OldNew-9876!');
      await seed.stop();

      const dbPath = path.join(oldDir, 'db.json');
      const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      for (const role of Object.keys(raw.settings.rolePermissions || {})) {
        delete raw.settings.rolePermissions[role].viewIspoOperations;
        delete raw.settings.rolePermissions[role].viewShortfall;
        delete raw.settings.rolePermissions[role].recordPayments;
      }
      fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));
      T.check(
        'a database was written in the shape an older version would have left it',
        raw.settings.rolePermissions.JUNIOR_OFFICER.viewIspoOperations === undefined,
        'the fixture still carried the field'
      );

      upgraded = await startServer({ port: port + 4001, adminPassword: 'Old-1234!', projectRoot, dataDir: oldDir });
      const after = makeClient(upgraded.baseUrl);
      await after.post('/api/auth/login', { username: 'admin', password: 'OldNew-9876!' }, { captureCookie: true });
      const perms = (await after.get('/api/db')).body?.settings?.rolePermissions?.JUNIOR_OFFICER;

      T.check(
        'upgrading an older database does not take the ISPO statement away from the team',
        perms?.viewIspoOperations === true,
        JSON.stringify(perms)
      );
      T.check(
        'nor the shortfall report',
        perms?.viewShortfall === true,
        JSON.stringify(perms)
      );
      T.check(
        'nor the till, which follows the same rule and for the same reason',
        perms?.recordPayments === true,
        JSON.stringify(perms)
      );
    } finally {
      if (upgraded) await upgraded.stop();
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
