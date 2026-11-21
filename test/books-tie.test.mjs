/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The books tie: every report that states the same money states the same figure.
 *
 * Two defects a QA simulation found on 2026-11-19, both money-wrong:
 *
 *   A. Every Maintenance-category ISPO cost on one of ISPO's own villas was taken
 *      to be the monthly contribution typed in twice, and dropped from ISPO's
 *      book. The expense form defaults to Maintenance, so a genuine J$9,000
 *      repair on A3 vanished from ISPO Operations and the ISPO statement, while
 *      the combined statement still counted it: combined surplus no longer
 *      equalled strata plus ISPO, and the self-check told staff to void a real
 *      bill. The ISPO printout and export also left out the note the screen
 *      carried about what was excluded.
 *   B. The Monthly Owners Report left out every cost tied to a villa as
 *      "recharged to those owners" — including a J$40,000 electricity bill on
 *      ISPO villa A5 that nobody recharges — so it disagreed with the strata
 *      Operating Statement for the same month and the year's monthly reports did
 *      not add up to the Annual Report.
 *
 * In-memory fixtures, bundled straight from src (and server/integrity.ts), so
 * this asserts the code in the working tree rather than a stale dist build.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'The books tie: ISPO costs, the levy duplicate, combined = strata + ISPO, monthly = annual = operating';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-books-tie-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export * as fin from './src/lib/finance';
        export { CurrencyBlock, IspoDocument, ispoSheet } from './src/components/IspoOperations';
        export { MonthlyReportDocument } from './src/components/MonthlyOwnersReport';
        export { checkIntegrity } from './server/integrity';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const textOf = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&rsquo;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const cents = n => Math.round(n * 100);

/* ------------------------------------------------------------------ *
 * The property, shaped like the QA simulation: Sept–Nov 2026, J$ only
 * ------------------------------------------------------------------ */

function fixture() {
  const unit = (id, number, status, over = {}) => ({
    id,
    number,
    status,
    ownerName: status === 'owner-occupied' ? `Proprietor ${number}` : 'ISPO',
    tenantName: '',
    monthlyRent: 0,
    monthlyMaintenance: 20000,
    currency: 'JMD',
    maintCurrency: 'JMD',
    maintDueDay: 1,
    ...over
  });
  const units = [
    unit('unit-1', 'A1', 'short-term', { currency: 'USD' }),
    unit('unit-3', 'A3', 'short-term', { currency: 'USD' }),
    unit('unit-5', 'A5', 'long-term', { monthlyRent: 75000, tenantName: 'Tenant A5' }),
    unit('unit-7', 'B7', 'owner-occupied'),
    unit('unit-8', 'B8', 'owner-occupied')
  ];
  let p = 0;
  const pay = (unitId, category, amount, date, extra = {}) => ({
    id: `pay-${++p}`,
    unitId,
    unitNumber: units.find(u => u.id === unitId).number,
    category,
    amount,
    currency: 'JMD',
    date,
    status: 'completed',
    payerName: 'Payer',
    method: 'Cash',
    receiptNo: `R${p}`,
    ...extra
  });
  const payments = [];
  for (const m of ['09', '10', '11']) {
    // ISPO pays the corporation the contribution on each of its own villas.
    for (const id of ['unit-1', 'unit-3', 'unit-5']) payments.push(pay(id, 'Maintenance', 20000, `2026-${m}-08`, { payerName: 'ISPO' }));
    for (const id of ['unit-7', 'unit-8']) payments.push(pay(id, 'Maintenance', 20000, `2026-${m}-05`));
  }
  payments.push(pay('unit-5', 'Rent', 75000, '2026-09-03'), pay('unit-5', 'Rent', 75000, '2026-11-03'));
  payments.push(pay('unit-3', 'Booking', 62000, '2026-10-05'));
  // A5's tenant reimburses J$8,000 of the electricity: pass-through, never income.
  payments.push(pay('unit-5', 'Utility', 8000, '2026-10-28', { payerName: 'Tenant A5' }));

  let e = 0;
  const cost = over => ({
    id: `exp-${++e}`,
    vendor: 'Supplier',
    description: '',
    unitId: '',
    unitNumber: 'General',
    currency: 'JMD',
    status: 'paid',
    reference: '',
    notes: '',
    paymentMethod: 'Bank Transfer',
    ...over,
    datePaid: over.datePaid || over.date
  });
  const expenses = [
    cost({ category: 'Security', vendor: 'Guardsman', amount: 96000, date: '2026-09-10' }),
    cost({ category: 'Security', vendor: 'Guardsman', amount: 96000, date: '2026-10-10' }),
    // Strata paid A5's electricity; no recharge to anyone exists.
    cost({ category: 'Utilities', vendor: 'JPS', amount: 40000, unitId: 'unit-5', unitNumber: 'A5', date: '2026-10-20', description: 'JPS bill A5' }),
    cost({ category: 'Contractors', vendor: 'Plumber', amount: 7800, unitId: 'unit-7', unitNumber: 'B7', date: '2026-10-14', description: 'Burst pipe B7' }),
    cost({ category: 'Other', vendor: 'Digicel', amount: 18000, fund: 'ispo', date: '2026-10-05', description: 'Company phones' }),
    // The genuine repair, under the form's default category.
    cost({ category: 'Maintenance', vendor: 'Handyman', amount: 9000, fund: 'ispo', unitId: 'unit-3', unitNumber: 'A3', date: '2026-10-18', description: 'A3 repair' }),
    // The contribution typed into the register as well: the one real duplicate.
    cost({ category: 'Maintenance', vendor: 'Villaggio Del Sol', amount: 20000, fund: 'ispo', unitId: 'unit-1', unitNumber: 'A1', date: '2026-10-08', description: 'Strata contribution A1 October' }),
    cost({ category: 'Contractors', vendor: 'Electrician', amount: 22000, date: '2026-11-04' })
  ];
  return { units, payments, expenses, charges: [] };
}

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin: F, React, renderToStaticMarkup, CurrencyBlock, IspoDocument, ispoSheet, MonthlyReportDocument, checkIntegrity } = mod;
  try {
    const { units, payments, expenses, charges } = fixture();
    const OCT = ['2026-10-01', '2026-10-31'];
    const RANGE = ['2026-09-01', '2026-11-30'];

    /* ================================================================
     * A. A repair under Maintenance is ISPO's cost; only the levy duplicate is not
     * ================================================================ */

    const io = F.ispoOperations(expenses, payments, units, 'JMD', ...OCT);
    const ispoLines = io.groups.flatMap(g => g.lines);
    T.check(
      'a Maintenance-category repair on an ISPO villa is on ISPO Operations',
      ispoLines.some(l => l.id === 'exp-6' && l.amount === 9000),
      JSON.stringify(ispoLines.map(l => l.id))
    );
    T.check('so ISPO’s own costs are the phones and the repair', io.ownCostsPaid === 27000, String(io.ownCostsPaid));
    const opIspo = F.operatingStatement(payments, expenses, units, 'JMD', ...OCT, { book: 'ispo' });
    T.check(
      'and on the ISPO Operating Statement',
      opIspo.expenditure.some(g => g.lines.some(l => l.id === 'exp-6')),
      JSON.stringify(opIspo.expenditure.map(g => g.label))
    );
    T.check(
      'the contribution typed in as a cost is still left out, exactly once',
      io.excludedAsContributionCount === 1 && io.excludedAsContribution === 20000 && !ispoLines.some(l => l.id === 'exp-7'),
      JSON.stringify([io.excludedAsContributionCount, io.excludedAsContribution])
    );
    const opExcluded = opIspo.excludedExpenditure.filter(x => /Contributions typed into the cost register/.test(x.label));
    T.check(
      'and the ISPO Operating Statement names the same exclusion, the same amount',
      opExcluded.length === 1 && opExcluded[0].total === 20000,
      JSON.stringify(opIspo.excludedExpenditure)
    );

    // The rule needs all of its evidence, not one piece of it.
    const own = F.ownAccountUnitIds(units);
    const probe = over => F.isContributionCountedFromReceipts({ ...expenses[6], ...over }, own, units);
    T.check('positive control: the duplicate itself is recognised', probe({}) === true);
    T.check('two months of the contribution in one row is recognised', probe({ amount: 40000 }) === true);
    T.check('a repair for exactly one levy, by a handyman, is not the contribution', probe({ vendor: 'Handyman', description: 'A1 repair' }) === false);
    T.check('a row naming the contribution for an amount that is not a whole levy is not', probe({ amount: 15000 }) === false);
    T.check('nor a strata-fund row', probe({ fund: undefined }) === false);
    T.check('nor one on a proprietor’s villa', probe({ unitId: 'unit-7', unitNumber: 'B7' }) === false);
    T.check('nor one in the other currency', probe({ currency: 'USD' }) === false);

    /* ---- stated identically on the screen, the printout and the export ---- */

    const note = F.contributionExclusionNote(io);
    T.check('the exclusion has a note', !!note && /J\$20,000\.00/.test(note.heading), JSON.stringify(note));
    const screen = textOf(renderToStaticMarkup(React.createElement(CurrencyBlock, { statement: io })));
    const printed = textOf(
      renderToStaticMarkup(React.createElement(IspoDocument, { statements: [io], month: '2026-10', generatedBy: 'Test', onClose: () => {} }))
    );
    const sheet = ispoSheet(io, { month: '2026-10', generatedBy: 'Test', planNumber: '' });
    const exported = sheet.rows.flat().map(c => (c && c.value != null ? String(c.value) : '')).join(' ');
    const said = where => where.includes(note.heading) && where.includes(note.body);
    T.check('the screen carries the note, word for word', said(screen), screen.slice(0, 300));
    T.check('the printout carries the same note, word for word', said(printed), 'the printed ISPO statement omits what it left out');
    T.check('the export carries the same note, word for word', said(exported), 'the ISPO export omits what it left out');
    T.check(
      'and all three carry the repair as a cost',
      [screen, printed, exported].every(t => t.includes('A3 repair')),
      'the repair is missing from the printout or the export'
    );

    /* ---- the self-check flags the duplicate and not the repair ---- */

    const integrity = checkIntegrity({
      units,
      payments,
      expenses,
      charges,
      utilities: [],
      bookings: [],
      tenancies: [],
      recurringExpenses: [],
      workOrders: [],
      users: [],
      audit: [],
      settings: { booksBeginOn: '2026-09-01' }
    });
    const flagged = (integrity.findings || []).find(f => f.code === 'contribution-entered-as-a-cost');
    const flaggedText = JSON.stringify(flagged || {});
    T.check('the self-check flags the real duplicate', /exp-7/.test(flaggedText), flaggedText);
    T.check('and never tells staff to void the real repair', !/exp-6/.test(flaggedText), flaggedText);

    /* ================================================================
     * The three books reconcile: combined = strata + ISPO
     * ================================================================ */

    for (const [name, [a, b]] of [['October', OCT], ['September to November', RANGE]]) {
      const st = book => F.operatingStatement(payments, expenses, units, 'JMD', a, b, { book });
      const combined = st('everything');
      const sum = cents(st('strata').surplus) + cents(st('ispo').surplus);
      T.check(`${name}: combined surplus = strata + ISPO`, cents(combined.surplus) === sum, `${combined.surplus} vs ${sum / 100}`);
      T.check(
        `${name}: the combined book names the duplicate it left out`,
        combined.excludedExpenditure.some(x => /Contributions typed into the cost register/.test(x.label) && x.total === 20000),
        JSON.stringify(combined.excludedExpenditure)
      );
    }
    T.check(
      'October, the figures the QA simulation would now show: combined surplus equals the two books',
      F.operatingStatement(payments, expenses, units, 'JMD', ...OCT, { book: 'everything' }).surplus === -60800,
      String(F.operatingStatement(payments, expenses, units, 'JMD', ...OCT, { book: 'everything' }).surplus)
    );

    /* ================================================================
     * B. Monthly report = Operating Statement; monthly reports add up to the year
     * ================================================================ */

    const monthly = F.monthlyOwnersReport(units, charges, payments, expenses, 'JMD', '2026-10');
    const opStrata = F.operatingStatement(payments, expenses, units, 'JMD', ...OCT, { book: 'strata' });
    /*
     * Changed 2026-11-21 (owner's rule): a utility bill tied to a villa, and its recovery, is that villa owner's own
     * cost and is not a common cost, so the Monthly Report leaves it out. The strata Operating Statement is the
     * corporation's cash record and still carries it. The two differ by exactly the A5 electricity, net of the
     * J$8,000 recovered (J$40,000 - J$8,000 = J$32,000), and by nothing else.
     */
    const A5_VILLA_UTILITY_NET = 32000;
    T.check(
      'October: monthly report costs = strata Operating Statement expenditure less the A5 villa utility (net J$32,000)',
      monthly.costsPaid === opStrata.totalExpenditure - A5_VILLA_UTILITY_NET,
      `${monthly.costsPaid} vs ${opStrata.totalExpenditure} - ${A5_VILLA_UTILITY_NET}`
    );
    T.check('October: and the surplus differs by that same J$32,000', monthly.surplus === opStrata.surplus + A5_VILLA_UTILITY_NET, `${monthly.surplus} vs ${opStrata.surplus}`);
    T.check(
      'October: contributions = the Operating Statement’s contributions line',
      monthly.contributionsReceived === (opStrata.income.find(g => g.label === 'Maintenance contributions')?.total ?? 0),
      String(monthly.contributionsReceived)
    );
    T.check(
      'the A5 electricity and the J$8,000 recovered from it are not common costs: no Utilities line is left',
      !monthly.categories.some(g => g.label === 'Utilities'),
      JSON.stringify(monthly.categories)
    );
    T.check(
      'the villa share stated inside the costs is the B7 repair alone: J$7,800 over 1 item',
      monthly.onIndividualVillas === 7800 && monthly.onIndividualVillasCount === 1,
      JSON.stringify([monthly.onIndividualVillas, monthly.onIndividualVillasCount])
    );
    T.check(
      'the categories add up to the costs',
      monthly.categories.reduce((t, g) => t + cents(g.total), 0) === cents(monthly.costsPaid),
      JSON.stringify(monthly.categories)
    );

    const annual = F.annualOwnersReport(units, charges, payments, expenses, 'JMD', 2026, { booksBeginOn: '2026-09-01' });
    const sumMonthly = ['2026-09', '2026-10', '2026-11', '2026-12']
      .map(m => F.monthlyOwnersReport(units, charges, payments, expenses, 'JMD', m).costsPaid)
      .reduce((t, v) => t + cents(v), 0);
    T.check('September to December: the monthly reports add up to the Annual Report', sumMonthly === cents(annual.expenditure), `${sumMonthly / 100} vs ${annual.expenditure}`);

    const monthlyPrinted = textOf(
      renderToStaticMarkup(
        React.createElement(MonthlyReportDocument, {
          reports: [monthly],
          period: 'October 2026',
          settings: { strataPlanNumber: '', fxRateJmdPerUsd: 155 },
          generatedBy: 'Test'
        })
      )
    );
    T.check('the printed monthly report claims no recharge', !/recharg/i.test(monthlyPrinted), 'a recharge that does not exist is claimed');
    T.check(
      'and states the villa share in the shared wording',
      monthlyPrinted.includes(F.individualVillasNote(monthly)),
      monthlyPrinted.slice(0, 400)
    );
  } finally {
    cleanup();
  }
  return T.done();
}
