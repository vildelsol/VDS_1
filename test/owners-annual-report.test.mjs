/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The owners' annual report — the AGM document, not the Commission's return.
 *
 * The arithmetic here is the argument put to a meeting of proprietors and then
 * sent on to the Commission of Strata Corporations, so the figures have to
 * reconcile with each other on their face. The 2026 report circulated at this
 * property had to carry a corrections log because percentages were printed
 * beside figures that did not produce them; these tests exist so that cannot
 * happen again.
 *
 * The model under test, in the property's own vocabulary (Ro, 2026-08-16):
 *   - "maintenance collected" is the contribution × villas, taken at full value
 *     because a proprietor is obliged by law to pay;
 *   - "billed" is what the property was invoiced — its expenditure;
 *   - the gap between them is the shortfall the document exists to size;
 *   - and there are two levers on it: raise the contribution, or cut the spend.
 *
 * Uses the real `src/lib/finance.ts` rather than a copy of its rules.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = "Owners' annual report (AGM)";

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-agm-'));
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

const YEAR = 2026;

/** Sixteen villas, each assessed the same contribution — the property's shape. */
function villas(fee = 20000, count = 16, over = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `unit-${i + 1}`,
    number: String(i + 1),
    ownerName: `Owner ${i + 1}`,
    ownerEmail: '',
    ownerPhone: '',
    tenantName: '',
    tenantEmail: '',
    tenantPhone: '',
    status: 'owner-occupied',
    monthlyRent: 0,
    monthlyMaintenance: fee,
    currency: 'JMD',
    maintCurrency: 'JMD',
    meterNumber: '',
    notes: '',
    ...over
  }));
}

const expense = (over = {}) => ({
  id: `ex-${Math.random().toString(16).slice(2)}`,
  category: 'Security',
  vendor: 'Armour',
  description: '',
  unitId: '',
  unitNumber: 'General',
  amount: 1000,
  currency: 'JMD',
  date: `${YEAR}-01-15`,
  dueDate: `${YEAR}-01-15`,
  datePaid: `${YEAR}-01-15`,
  status: 'paid',
  paymentMethod: 'Bank Transfer',
  reference: '',
  notes: '',
  ...over
});

const charge = (over = {}) => ({
  id: `chg-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  periodMonth: `${YEAR}-01`,
  dueDate: `${YEAR}-01-01`,
  amount: 20000,
  currency: 'JMD',
  status: 'open',
  payerName: 'Owner 1',
  createdAt: '',
  createdBy: 'test',
  ...over
});

const payment = (over = {}) => ({
  id: `p-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  amount: 20000,
  currency: 'JMD',
  date: `${YEAR}-01-10`,
  status: 'completed',
  payerName: 'Owner 1',
  method: 'Cash',
  receiptNo: 'R1',
  ...over
});

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  const { annualOwnersReport } = mod;

  try {
    /* ------------------------------------------------------------------ *
     * Storing the written part — it has to come back out again
     *
     * The narrative is the one thing in this document that is typed rather
     * than computed, so it exists nowhere else. A live bug: the report saved
     * to disk and was audited correctly, but `/api/db` did not return
     * `annualReports`, so every word came straight back as blank on the next
     * load and the printed document had no narrative in it. Every unit test
     * above passed throughout — the arithmetic was never the problem. This
     * round-trip is what catches it.
     * ------------------------------------------------------------------ */
    {
      const srv = await startServer({ port, adminPassword: 'Agm-Report-1234!', projectRoot });
      try {
        const c = makeClient(srv.baseUrl);
        await activateAdmin(c, 'Agm-Report-1234!', 'Reporter-Pass-1!');

        const saved = await c.put('/api/annual-reports/2026', {
          currency: 'JMD',
          narrative: { executiveSummary: 'The committee held the contribution as long as it could.', risks: 'Reserves are depleted.' },
          budgetByCategory: { Security: 2000000 },
          proposedFee: 30000,
          meetingDate: '2026-11-20'
        });
        T.check('a report can be saved', saved.status === 200, JSON.stringify(saved.body).slice(0, 160));

        const db = await c.get('/api/db');
        T.check('and the application is given it back', Array.isArray(db.body.annualReports), typeof db.body.annualReports);

        // Guarded throughout: when the round trip is broken there is no record
        // here at all, and a test that throws reports worse than one that fails.
        const back = (db.body.annualReports || []).find(r => r.year === 2026) || null;
        const seen = String(JSON.stringify(back)).slice(0, 200);
        T.check('the written sections survive the round trip', !!back && (back.narrative?.executiveSummary || '').startsWith('The committee held'), seen);
        T.check('every section does, not just the first', !!back && back.narrative?.risks === 'Reserves are depleted.', seen);
        T.check('the budget survives it', !!back && back.budgetByCategory?.Security === 2000000, seen);
        T.check('so do the proposal and the meeting date', !!back && back.proposedFee === 30000 && back.meetingDate === '2026-11-20', seen);
        T.check('and it records who last touched it', !!back && !!back.updatedBy && !!back.updatedAt, seen);

        // Editing one section must not wipe the others.
        await c.put('/api/annual-reports/2026', { narrative: { risks: 'Reserves are gone entirely.' } });
        const db2 = await c.get('/api/db');
        const merged = (db2.body.annualReports || []).find(r => r.year === 2026) || null;
        T.check('editing one section leaves the rest standing', !!merged && (merged.narrative?.executiveSummary || '').startsWith('The committee held'), String(JSON.stringify(merged?.narrative)).slice(0, 200));
        T.check('and applies the change that was made', !!merged && merged.narrative?.risks === 'Reserves are gone entirely.');
        T.check('a year is stored once, not appended to', (db2.body.annualReports || []).filter(r => r.year === 2026).length === 1);

        // A budget line cleared falls back to the actual, so it must be removable.
        await c.put('/api/annual-reports/2026', { budgetByCategory: { Security: null } });
        const db3 = await c.get('/api/db');
        const cleared = (db3.body.annualReports || []).find(r => r.year === 2026) || null;
        T.check('a budget line can be cleared back to the run-rate', !!cleared && cleared.budgetByCategory?.Security === undefined, String(JSON.stringify(cleared?.budgetByCategory)));

        // Zero is a real budget figure — it is how a service is cut.
        await c.put('/api/annual-reports/2026', { budgetByCategory: { Security: 0 } });
        const db4 = await c.get('/api/db');
        const zeroed = (db4.body.annualReports || []).find(r => r.year === 2026) || null;
        T.check('and a line can be budgeted at zero, which is how a service is cut', !!zeroed && zeroed.budgetByCategory?.Security === 0, String(JSON.stringify(zeroed?.budgetByCategory)));

        /* --- two people preparing the same report at once --- */

        // Everything else in this application settles a 20-way race to exactly
        // one action. This record is written by one person in practice, but
        // "in practice" is not a guarantee: a stored year must never be
        // duplicated, and a losing write must not leave a half-merged document
        // that is neither person's wording.
        const racers = Array.from({ length: 20 }, (_, n) =>
          c.put('/api/annual-reports/2031', {
            currency: 'JMD',
            narrative: { executiveSummary: `Draft from officer ${n}.` },
            proposedFee: 20000 + n
          })
        );
        const settled = await Promise.all(racers);
        T.check('every concurrent write was answered', settled.every(r => r.status === 200), settled.map(r => r.status).join(','));

        const raced = (await c.get('/api/db')).body.annualReports || [];
        const forYear = raced.filter(r => r.year === 2031);
        T.check('a twenty-way race leaves exactly one report for the year', forYear.length === 1, `${forYear.length} records`);

        // Whichever won, the document must be one person's — the summary and the
        // fee must come from the same write, not be stitched from two.
        const winner = forYear[0];
        const officer = /officer (\d+)/.exec(winner?.narrative?.executiveSummary || '');
        T.check(
          'and it is one officer’s document, not two stitched together',
          !!officer && winner.proposedFee === 20000 + Number(officer[1]),
          `summary said officer ${officer && officer[1]} but the fee was ${winner?.proposedFee}`
        );

        const bad = await c.put('/api/annual-reports/1200', {});
        T.check('an impossible year is refused', bad.status >= 400, String(bad.status));

        T.check('the whole thing left an audit entry', (db4.body.auditLogs || []).some(a => /annual report/i.test(a.action || '')));
      } finally {
        await srv.stop();
      }
    }

    /* ------------------------------------------------------------------ *
     * The shape of the argument: cost per unit against the contribution
     * ------------------------------------------------------------------ */

    // 16 villas at $20,000. Expenditure of $4,800,000 across the year.
    const spendEvenly = (total, year = YEAR) =>
      Array.from({ length: 12 }, (_, m) =>
        expense({
          amount: total / 12,
          date: `${year}-${String(m + 1).padStart(2, '0')}-15`,
          datePaid: `${year}-${String(m + 1).padStart(2, '0')}-15`
        })
      );

    {
      const r = annualOwnersReport(villas(20000), [], [], spendEvenly(4800000), 'JMD', YEAR);

      T.check('every contributing villa is counted', r.contributingUnits === 16, String(r.contributingUnits));
      T.check('the year’s expenditure is the sum of what was paid', r.expenditure === 4800000, String(r.expenditure));
      T.check('cost per villa for the year divides the expenditure', r.perUnitAnnual === 300000, String(r.perUnitAnnual));
      T.check('cost per villa per month is a twelfth of that', r.perUnitMonthly === 25000, String(r.perUnitMonthly));
      T.check('the contribution is read off the villas', r.feeBilled === 20000, String(r.feeBilled));

      // The headline: $20,000 billed against $25,000 of cost.
      T.check(
        'the monthly position per villa is the contribution less the cost',
        r.monthlyPositionPerUnit === -5000,
        String(r.monthlyPositionPerUnit)
      );
      T.check(
        'and the community position is that across every villa for the year',
        r.annualCommunityPosition === -5000 * 16 * 12,
        String(r.annualCommunityPosition)
      );
      T.check(
        'contributions raised is the fee times villas times twelve',
        r.contributionsAnnual === 20000 * 16 * 12,
        String(r.contributionsAnnual)
      );

      // The invariant that makes the document defensible on its face, and it
      // has to hold *exactly* — this is the subtraction a proprietor does to
      // check the headline figure. It once did not: the community position was
      // the rounded per-villa figure scaled back up, which re-inflated the
      // rounding into real money. Caught by the 400-scenario reporting audit.
      T.check(
        'the shortfall reconciles exactly: contributions raised − expenditure = the community position',
        round(r.contributionsAnnual - r.expenditure) === r.annualCommunityPosition,
        `${r.contributionsAnnual} - ${r.expenditure} = ${round(r.contributionsAnnual - r.expenditure)}, stated ${r.annualCommunityPosition}`
      );
    }

    /* ------------------------------------------------------------------ *
     * The two levers
     * ------------------------------------------------------------------ */

    {
      // Budget the coming year 10% above this one.
      const r = annualOwnersReport(villas(20000), [], [], spendEvenly(4800000), 'JMD', YEAR, {
        budgetByCategory: { Security: 5280000 }
      });

      T.check('the budget total is what was keyed in', r.budgetExpenditure === 5280000, String(r.budgetExpenditure));
      T.check('the budget change is stated against the actual', r.budgetChangePct === 10, String(r.budgetChangePct));

      // Lever 1 — raise the contribution.
      T.check(
        'the contribution needed is the budget divided by villas and months',
        Math.abs(r.feeToCoverBudget - 5280000 / 16 / 12) < 0.01,
        String(r.feeToCoverBudget)
      );
      // It has to actually cover the budget. Rounded down — which a plain
      // round-to-cent does half the time — the report would state a shortfall
      // against the very fee it had just recommended.
      T.check(
        'and it genuinely covers it rather than falling a few dollars short',
        r.feeToCoverBudget * 16 * 12 >= r.budgetExpenditure,
        `${r.feeToCoverBudget} x 192 = ${r.feeToCoverBudget * 192} vs budget ${r.budgetExpenditure}`
      );
      T.check(
        'with no proposal on the table the report proposes the requirement itself',
        r.proposedFee === r.feeToCoverBudget,
        String(r.proposedFee)
      );
      T.check('so it holds nothing back as reserve', r.reservePerUnitMonthly === 0, String(r.reservePerUnitMonthly));

      // Lever 2 — cut the spend to fit the present contribution.
      T.check(
        'the expenditure ceiling is what the current contribution raises',
        r.expenditureCeiling === 20000 * 16 * 12,
        String(r.expenditureCeiling)
      );
      T.check(
        'and the reduction required is the budget less that ceiling',
        r.reductionRequired === 5280000 - 3840000,
        String(r.reductionRequired)
      );
      T.check(
        'a category big enough to close the gap on its own is identified',
        r.cutsThatWouldClose.some(c => c.category === 'Security' && c.closesGap),
        JSON.stringify(r.cutsThatWouldClose)
      );
    }

    {
      // A proposal above the requirement funds a reserve — the 2027 argument.
      const r = annualOwnersReport(villas(20000), [], [], spendEvenly(4800000), 'JMD', YEAR, {
        budgetByCategory: { Security: 5235169 },
        proposedFee: 30000
      });
      const requirement = round(5235169 / 16 / 12);

      T.check('the proposed fee is the one put to the meeting', r.proposedFee === 30000, String(r.proposedFee));
      T.check(
        'the reserve per villa is the proposal less the requirement',
        r.reservePerUnitMonthly === round(30000 - requirement),
        `${r.reservePerUnitMonthly} vs ${round(30000 - requirement)}`
      );
      // Exactly, not nearly. This is the allocation table an owner adds up with a
      // pen: it printed 4,843,030.00 + 916,968.96 against a total of
      // 5,760,000.00 and was 1.04 short, because the reserve was the rounded
      // per-villa figure multiplied back up rather than the residual.
      T.check(
        'the allocation column adds up exactly: budget + reserve = proposed contributions',
        r.budgetExpenditure + r.reserveAnnual === r.proposedAnnualCommunity,
        `${r.budgetExpenditure} + ${r.reserveAnnual} = ${r.budgetExpenditure + r.reserveAnnual}, stated ${r.proposedAnnualCommunity}`
      );
      T.check(
        'the reserve share is stated as a share of the contribution',
        r.reserveShare !== null && r.reserveShare > 0 && r.reserveShare < 100,
        String(r.reserveShare)
      );
      // Property-based: whatever the budget, the recommended fee never leaves
      // the community short of it, and the allocation column always adds up.
      {
        let worstShort = 0;
        let columnBreaks = 0;
        let positionBreaks = 0;
        for (let i = 0; i < 400; i++) {
          const total = 100000 + i * 13337;
          const p = annualOwnersReport(villas(20000), [], [], spendEvenly(4800000), 'JMD', YEAR, {
            budgetByCategory: { Security: total }
          });
          const raised = round(p.feeToCoverBudget * 16 * 12);
          worstShort = Math.min(worstShort, round(raised - p.budgetExpenditure));
          if (p.budgetExpenditure + p.reserveAnnual !== p.proposedAnnualCommunity) columnBreaks++;
          if (round(p.contributionsAnnual - p.expenditure) !== p.annualCommunityPosition) positionBreaks++;
        }
        T.check('across four hundred budgets the recommended fee never under-covers', worstShort >= 0, `worst was ${worstShort}`);
        T.check('and the allocation column adds up in every one of them', columnBreaks === 0, `${columnBreaks} did not`);
        T.check('and the headline shortfall reconciles in every one of them', positionBreaks === 0, `${positionBreaks} did not`);
      }

      T.check(
        'a proposal that under-collects reports a negative reserve rather than zero',
        annualOwnersReport(villas(20000), [], [], spendEvenly(4800000), 'JMD', YEAR, {
          budgetByCategory: { Security: 5235169 },
          proposedFee: 20000
        }).reservePerUnitMonthly < 0
      );
    }

    /* ------------------------------------------------------------------ *
     * Categories
     * ------------------------------------------------------------------ */

    {
      const expenses = [
        expense({ category: 'Payroll', amount: 1720000, date: `${YEAR}-03-01`, datePaid: `${YEAR}-03-01` }),
        expense({ category: 'Security', amount: 1960000, date: `${YEAR}-03-01`, datePaid: `${YEAR}-03-01` }),
        expense({ category: 'Utilities', amount: 700000, date: `${YEAR}-03-01`, datePaid: `${YEAR}-03-01` }),
        // Prior year, for the year-over-year column.
        expense({ category: 'Payroll', amount: 1351000, date: `${YEAR - 1}-03-01`, datePaid: `${YEAR - 1}-03-01` }),
        expense({ category: 'Security', amount: 2144000, date: `${YEAR - 1}-03-01`, datePaid: `${YEAR - 1}-03-01` })
      ];
      const r = annualOwnersReport(villas(20000), [], [], expenses, 'JMD', YEAR);

      const payroll = r.categories.find(c => c.category === 'Payroll');
      const security = r.categories.find(c => c.category === 'Security');
      const utilities = r.categories.find(c => c.category === 'Utilities');

      T.check('a category carries both years', payroll.actual === 1720000 && payroll.prior === 1351000);
      T.check('the year-over-year change is computed, not typed', payroll.priorChangePct === 27.31, String(payroll.priorChangePct));
      T.check('a category that fell reports a fall', security.priorChangePct < 0, String(security.priorChangePct));
      T.check(
        'a category with no prior year reports no change rather than an infinite one',
        utilities.priorChangePct === null,
        String(utilities.priorChangePct)
      );
      T.check(
        'an untouched budget line holds this year’s actual, never zero',
        payroll.budget === payroll.actual,
        String(payroll.budget)
      );
      T.check(
        'category budgets sum to the budget total',
        Math.abs(r.categories.reduce((s, c) => s + c.budget, 0) - r.budgetExpenditure) < 0.01
      );
      T.check(
        'category shares sum to a hundred per cent',
        Math.abs(r.categories.reduce((s, c) => s + c.budgetShare, 0) - 100) < 0.1,
        String(r.categories.reduce((s, c) => s + c.budgetShare, 0))
      );
      T.check('the biggest line comes first, so a cut is obvious', r.categories[0].category === 'Security');
      T.check(
        'and the actuals sum to the year’s expenditure',
        Math.abs(r.categories.reduce((s, c) => s + c.actual, 0) - r.expenditure) < 0.01
      );
    }

    /* ------------------------------------------------------------------ *
     * The month-by-month cash shape
     * ------------------------------------------------------------------ */

    {
      const expenses = [
        ...spendEvenly(4800000),
        // One heavy month on top.
        expense({ amount: 200000, date: `${YEAR}-11-20`, datePaid: `${YEAR}-11-20` })
      ];
      const r = annualOwnersReport(villas(20000), [], [], expenses, 'JMD', YEAR);

      T.check('every month of the year is reported', r.months.length === 12, String(r.months.length));
      T.check(
        'the monthly income is the contribution, not a guess',
        r.months.every(m => m.income === 20000 * 16),
        JSON.stringify(r.months[0])
      );
      T.check(
        'each month’s shortfall is its cost less its contribution',
        r.months.every(m => Math.abs(m.shortfall - (m.expenditure - m.income)) < 0.01)
      );
      T.check(
        'the monthly expenditure sums to the year’s',
        Math.abs(r.months.reduce((s, m) => s + m.expenditure, 0) - r.expenditure) < 0.01
      );
      T.check(
        'a month that cost more than it raised is named',
        r.monthsOver.includes(`${YEAR}-11`),
        JSON.stringify(r.monthsOver)
      );
      T.check(
        'and months covered plus months over is the whole year',
        r.monthsCovered + r.monthsOver.length === 12,
        `${r.monthsCovered} + ${r.monthsOver.length}`
      );
    }

    /* ------------------------------------------------------------------ *
     * The rules this document inherits from the rest of the ledger
     * ------------------------------------------------------------------ */

    {
      // A pending bill is a liability, not expenditure. It goes to Form 13C.
      const r = annualOwnersReport(
        villas(20000),
        [],
        [],
        [
          expense({ amount: 100000, status: 'paid' }),
          expense({ amount: 999999, status: 'pending', datePaid: undefined })
        ],
        'JMD',
        YEAR
      );
      T.check('a pending bill is not counted as money spent', r.expenditure === 100000, String(r.expenditure));
      // The category lines are collected separately from the total, so the rule
      // has to hold in both places or the breakdown contradicts its own sum.
      // Found by mutation testing: removing the filter from the category walk
      // left every assertion above still passing.
      T.check(
        'and it is absent from the category breakdown too, not just the total',
        r.categories.reduce((s, c) => s + c.actual, 0) === 100000,
        JSON.stringify(r.categories)
      );
      T.check(
        'so the breakdown always reconciles to the expenditure it breaks down',
        Math.abs(r.categories.reduce((s, c) => s + c.actual, 0) - r.expenditure) < 0.01
      );
    }

    {
      // Currencies never combine.
      const r = annualOwnersReport(
        villas(20000),
        [],
        [],
        [expense({ amount: 100000, currency: 'JMD' }), expense({ amount: 500, currency: 'USD' })],
        'JMD',
        YEAR
      );
      T.check('a USD cost never lands in the JMD report', r.expenditure === 100000, String(r.expenditure));

      const usd = annualOwnersReport(
        villas(20000),
        [],
        [],
        [expense({ amount: 100000, currency: 'JMD' }), expense({ amount: 500, currency: 'USD' })],
        'USD',
        YEAR
      );
      T.check('and the USD report sees only the USD cost', usd.expenditure === 500, String(usd.expenditure));
      T.check(
        'a currency no villa is assessed in reports no contributing villas',
        usd.contributingUnits === 0,
        String(usd.contributingUnits)
      );
    }

    {
      // Only the report year.
      const r = annualOwnersReport(
        villas(20000),
        [],
        [],
        [
          expense({ amount: 100000, date: `${YEAR}-06-01`, datePaid: `${YEAR}-06-01` }),
          expense({ amount: 777000, date: `${YEAR - 1}-06-01`, datePaid: `${YEAR - 1}-06-01` }),
          expense({ amount: 888000, date: `${YEAR + 1}-06-01`, datePaid: `${YEAR + 1}-06-01` })
        ],
        'JMD',
        YEAR
      );
      T.check('the year is the year', r.expenditure === 100000, String(r.expenditure));
      T.check('the prior year is reported separately', r.priorExpenditure === 777000, String(r.priorExpenditure));
      T.check('and next year is not counted at all', r.expenditure !== 888000);
    }

    {
      // Contributions received are context, and never move the gap. This is the
      // one that pins Ro's decision: owners must pay by law, so the income line
      // is the assessment at full value however little of it actually arrived.
      const charges = Array.from({ length: 16 }, (_, i) =>
        charge({ unitId: `unit-${i + 1}`, unitNumber: String(i + 1) })
      );
      const paid = [payment({ amount: 20000 })];
      const withMoney = annualOwnersReport(villas(20000), charges, paid, spendEvenly(4800000), 'JMD', YEAR);
      const without = annualOwnersReport(villas(20000), charges, [], spendEvenly(4800000), 'JMD', YEAR);

      T.check('what actually came in is reported', withMoney.received === 20000, String(withMoney.received));
      T.check('and the collection rate with it', withMoney.collectionRatePct !== null, String(withMoney.collectionRatePct));
      T.check(
        'but arrears do not shrink the income line — a proprietor is obliged to pay',
        withMoney.contributionsAnnual === without.contributionsAnnual,
        `${withMoney.contributionsAnnual} vs ${without.contributionsAnnual}`
      );
      T.check(
        'and they do not move the shortfall either',
        withMoney.annualCommunityPosition === without.annualCommunityPosition
      );
    }

    /* ------------------------------------------------------------------ *
     * Nothing here may divide by zero or invent a figure
     * ------------------------------------------------------------------ */

    {
      const empty = annualOwnersReport([], [], [], [], 'JMD', YEAR);
      const finite = v => typeof v === 'number' && Number.isFinite(v);
      T.check(
        'an empty property reports zeroes rather than NaN',
        finite(empty.perUnitAnnual) &&
          finite(empty.perUnitMonthly) &&
          finite(empty.annualCommunityPosition) &&
          finite(empty.feeToCoverBudget) &&
          finite(empty.reductionRequired),
        JSON.stringify(empty).slice(0, 200)
      );
      T.check('and states no contributing villas', empty.contributingUnits === 0);
      T.check('and no percentage it cannot compute', empty.expenditureChangePct === null);
      T.check('and still lays out twelve months', empty.months.length === 12);
    }

    {
      // A villa with no contribution set is not a contributor, and must not be
      // counted in the divisor — doing so would understate the cost per villa.
      const mixed = [...villas(20000, 8), ...villas(0, 8).map((u, i) => ({ ...u, id: `x-${i}`, number: `x${i}` }))];
      const r = annualOwnersReport(mixed, [], [], spendEvenly(4800000), 'JMD', YEAR);
      T.check('only villas actually assessed count', r.contributingUnits === 8, String(r.contributingUnits));
      T.check('so the cost per villa reflects the eight', r.perUnitAnnual === 600000, String(r.perUnitAnnual));
    }

    return T.done();
  } finally {
    cleanup();
  }
}

function round(v) {
  return Math.round(v * 100) / 100;
}
