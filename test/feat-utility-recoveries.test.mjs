/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utility recoveries are a pass-through, not income.
 *
 * Ro, 2026-11-18: utility payments recovered from villas (owner-occupied villas
 * and anyone else billed for utilities) are excluded from income on every screen
 * and shown as a reduction of the utility cost, with the recovered amount named:
 * net utility cost = utility expense - recoveries.
 *
 * Before this, the Reports summary and the charts dropped recoveries only for an
 * `ownerBilledUnitIds` set (owner-occupied plus short-term villas) while the
 * combined Operating Statement counted every recovery as "Utilities recovered"
 * income, and no screen netted anything from the utility cost. This file seeds
 * utility costs on both books and recoveries in both currencies, including a
 * voided, a pending, a partly refunded and a refunded-next-month recovery, and
 * asserts that every screen's income excludes them and every screen's utility
 * cost is the same net figure.
 *
 * Pure: in-memory fixtures with fixed dates, no server and no clock.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Utility recoveries are a pass-through, netted from the utility cost';

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-utilrec-'));
  const out = {};
  for (const [name, file] of [['F', 'finance.ts'], ['P', 'projection.ts']]) {
    const outfile = path.join(dir, `${name}.mjs`);
    await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', file)], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
    out[name] = await import(pathToFileURL(outfile).href);
  }
  return { ...out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const C = x => Math.round((x || 0) * 100);
const FROM = '2026-10-01';
const TO = '2026-10-31';

function unit(id, number, status, currency, monthlyMaintenance, extra = {}) {
  return { id, number, status, currency, maintCurrency: currency, monthlyMaintenance, monthlyRent: 0, ownerName: `Owner ${number}`, tenantName: '', ...extra };
}
function cost(id, category, amount, currency, datePaid, fund, unitId = '', unitNumber = '', status = 'paid') {
  return { id, category, vendor: `Vendor ${id}`, description: id, unitId, unitNumber: unitNumber || (unitId ? '' : 'General'), amount, currency, date: datePaid, datePaid: status === 'paid' ? datePaid : undefined, dueDate: datePaid, status, reference: id, notes: '', fund };
}
function receipt(id, category, unitId, unitNumber, amount, currency, date, extra = {}) {
  return { id, receiptNo: `R-${id}`, payerName: `Payer ${id}`, unitId, unitNumber, category, amount, currency, date, method: 'Cash', reference: '', notes: '', staffMember: 'test', status: 'completed', ...extra };
}

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { F, P, cleanup } = await load(projectRoot);
  try {
    const units = [
      unit('u-a2', 'A2', 'owner-occupied', 'JMD', 20000),
      unit('u-s1', 'S1', 'short-term', 'JMD', 20000),
      unit('u-r1', 'R1', 'long-term', 'JMD', 20000, { monthlyRent: 75000, tenantName: 'Tenant R1' }),
      unit('u-u1', 'U1', 'owner-occupied', 'USD', 300)
    ];
    const expenses = [
      cost('e-jps', 'Utilities', 50000, 'JMD', '2026-10-05', 'strata'),
      cost('e-r1', 'Utilities', 20000, 'JMD', '2026-10-03', 'ispo', 'u-r1', 'R1'),
      cost('e-guard', 'Security', 30000, 'JMD', '2026-10-06', 'strata'),
      cost('e-usd', 'Utilities', 400, 'USD', '2026-10-04', 'strata', 'u-u1', 'U1'),
      cost('e-pending', 'Utilities', 9999, 'JMD', '2026-10-25', 'strata', '', '', 'pending')
    ];
    const payments = [
      // income
      receipt('m-a2', 'Maintenance', 'u-a2', 'A2', 20000, 'JMD', '2026-10-01'),
      receipt('rent-r1', 'Rent', 'u-r1', 'R1', 75000, 'JMD', '2026-10-01'),
      receipt('book-s1', 'Booking', 'u-s1', 'S1', 30000, 'JMD', '2026-10-08'),
      receipt('m-u1', 'Maintenance', 'u-u1', 'U1', 300, 'USD', '2026-10-02'),
      // utility recoveries
      receipt('ut-a2', 'Utility', 'u-a2', 'A2', 6000, 'JMD', '2026-10-10'),
      receipt('ut-s1', 'Utility', 'u-s1', 'S1', 4000, 'JMD', '2026-10-12'),
      receipt('ut-r1', 'Utility', 'u-r1', 'R1', 5000, 'JMD', '2026-10-15'),
      receipt('ut-void', 'Utility', 'u-a2', 'A2', 7000, 'JMD', '2026-10-16', { status: 'reversed' }),
      receipt('ut-part', 'Utility', 'u-a2', 'A2', 3000, 'JMD', '2026-10-18', { refundedAmount: 1000, refundedOn: '2026-10-20' }),
      receipt('ut-sep', 'Utility', 'u-a2', 'A2', 2500, 'JMD', '2026-09-28', { refundedAmount: 2500, refundedOn: '2026-10-02' }),
      receipt('ut-usd', 'Utility', 'u-u1', 'U1', 150, 'USD', '2026-10-11'),
      receipt('ut-pend', 'Utility', 'u-u1', 'U1', 50, 'USD', '2026-10-13', { status: 'pending' })
    ];
    const charges = [];

    // The expected figures, worked by hand from the fixture above.
    //  JMD strata recoveries: 6,000 (A2) + 4,000 (S1, no bill of its own, so the corporation's)
    //    + 2,000 (3,000 less 1,000 refunded) - 2,500 (September receipt refunded in October) = 9,500
    //  JMD ISPO recoveries: 5,000 (R1, whose bill ISPO paid). The void counts for nothing.
    //  USD strata: 150; the pending 50 counts for nothing.
    const EXPECT = {
      JMD: {
        everything: { cost: 70000, rec: 14500, income: 125000 },
        strata: { cost: 50000, rec: 9500, income: 20000 },
        ispo: { cost: 20000, rec: 5000, income: 105000 }
      },
      USD: {
        everything: { cost: 400, rec: 150, income: 300 },
        strata: { cost: 400, rec: 150, income: 300 },
        ispo: { cost: 0, rec: 0, income: 0 }
      }
    };
    const BOOKS = ['everything', 'strata', 'ispo'];

    /* ---------- the one derivation ---------- */
    for (const cur of ['JMD', 'USD']) {
      for (const book of BOOKS) {
        const e = EXPECT[cur][book];
        const r = F.utilityRecoveries(payments, expenses, cur, FROM, TO, book);
        T.check(`${cur} ${book}: utilityRecoveries names ${e.rec} recovered against ${e.cost} paid, net ${e.cost - e.rec}`,
          C(r.recovered) === C(e.rec) && C(r.utilityCost) === C(e.cost) && C(r.netUtilityCost) === C(e.cost - e.rec),
          JSON.stringify(r));
      }
      const s = F.utilityRecoveries(payments, expenses, cur, FROM, TO, 'strata');
      const i = F.utilityRecoveries(payments, expenses, cur, FROM, TO, 'ispo');
      const all = F.utilityRecoveries(payments, expenses, cur, FROM, TO, 'everything');
      T.check(`${cur}: each recovered dollar is on exactly one book (strata + ISPO = everything)`, C(s.recovered) + C(i.recovered) === C(all.recovered));
    }
    const once = F.withUtilityRecoveries(expenses, payments);
    const twice = F.withUtilityRecoveries(once, payments);
    T.check('netting twice adds nothing (a screen that nets and then calls a statement counts each dollar once)',
      twice.length === once.length && C(F.expensesInPeriod(twice, 'JMD', FROM, TO)) === C(F.expensesInPeriod(once, 'JMD', FROM, TO)));
    T.check('the voided and pending recoveries produce no row', !once.some(e => /ut-void|ut-pend/.test(e.id)));
    T.check('the recovery on the ISPO villa whose utilities ISPO paid is on ISPO\'s book',
      once.find(e => e.id === `${F.UTILITY_RECOVERY_ID_PREFIX}ut-r1`)?.fund === 'ispo');
    T.check('no recovery row ever mixes currencies', once.filter(F.isUtilityRecoveryRow).every(e => payments.find(p => e.id.includes(p.id) && p.category === 'Utility')?.currency === e.currency));

    for (const cur of ['JMD', 'USD']) {
      const net = book => C(EXPECT[cur][book].cost - EXPECT[cur][book].rec);
      const combined = F.consolidateEverything(charges, payments, units);

      /* ---------- Operating Statement, every book ---------- */
      for (const book of BOOKS) {
        const op = F.operatingStatement(payments, expenses, units, cur, FROM, TO, { book });
        const util = op.expenditure.find(g => g.label === 'Utilities');
        T.check(`${cur} ${book} Operating Statement: no utility receipt is income`,
          !op.income.some(g => /utilit/i.test(g.label) || g.lines.some(l => /^ut-/.test(l.id))));
        T.check(`${cur} ${book} Operating Statement: income is ${EXPECT[cur][book].income}`, C(op.totalIncome) === C(EXPECT[cur][book].income), `${op.totalIncome}`);
        T.check(`${cur} ${book} Operating Statement: Utilities expenditure is the net cost`, C(util?.total ?? 0) === net(book), `${util?.total}`);
        T.check(`${cur} ${book} Operating Statement: the recovery is named`, C(op.utilityRecovered) === C(EXPECT[cur][book].rec), `${op.utilityRecovered}`);
        T.check(`${cur} ${book} Operating Statement: the two books still add to the total`, C(op.strataExpenditure) + C(op.ispoExpenditure) === C(op.totalExpenditure));
      }

      /* ---------- Operational Reports summary and series (Reports.tsx), every book ---------- */
      const netted = F.withUtilityRecoveries(expenses, payments);
      for (const book of BOOKS) {
        const bookPayments = F.paymentsInBook(book === 'everything' ? combined.payments : payments, book);
        const collected = F.collectedInPeriod(bookPayments, cur, FROM, TO);
        const costs = F.expensesForBook(netted, units, book, cur);
        const util = F.expenseBreakdown(costs, cur, FROM, TO).find(b => b.category === 'Utilities');
        const op = F.operatingStatement(payments, expenses, units, cur, FROM, TO, { book });
        T.check(`${cur} ${book} Reports summary: received is income only`, C(collected.total) === C(EXPECT[cur][book].income), `${collected.total}`);
        T.check(`${cur} ${book} Reports summary: Utilities by category is the net cost`, C(util?.amount ?? 0) === net(book), `${util?.amount}`);
        T.check(`${cur} ${book} Reports summary: spent equals the Operating Statement expenditure`,
          C(F.expensesInPeriod(costs, cur, FROM, TO)) + C(book === 'ispo' ? op.internalTransfer : 0) === C(op.totalExpenditure));
      }

      /* ---------- Charts & Snapshots and the Board Pack (combined / strata) ---------- */
      const chartReceived = C(F.collectedInPeriod(combined.payments, cur, FROM, TO).total);
      const chartUtil = F.categoriesWithSpend(F.expenseBreakdown(netted, cur, FROM, TO)).find(b => b.category === 'Utilities');
      T.check(`${cur} Charts: received is income only`, chartReceived === C(EXPECT[cur].everything.income), `${chartReceived}`);
      T.check(`${cur} Charts: Utilities is the net cost`, C(chartUtil?.amount ?? 0) === net('everything'));
      const packUtil = F.expenseBreakdown(F.strataExpenses(netted), cur, FROM, TO).find(b => b.category === 'Utilities');
      T.check(`${cur} Board Pack: Utilities is the corporation's net cost`, C(packUtil?.amount ?? 0) === net('strata'));

      /* ---------- Dashboard ledger and health ---------- */
      const dashCollected = F.collectedInPeriod(combined.payments, cur, FROM, TO);
      T.check(`${cur} Dashboard: received excludes recoveries, which are still named`, C(dashCollected.total) === C(EXPECT[cur].everything.income) && C(dashCollected.utility) === C(EXPECT[cur].everything.rec));
      const health = F.operationalHealth(units, charges, payments, expenses, cur, FROM, TO);
      const healthGross = F.operationalHealth(units, charges, payments.filter(p => p.category !== 'Utility'), expenses, cur, FROM, TO);
      T.check(`${cur} Dashboard health: grades on the net cost (recoveries change the cost side, not income)`,
        JSON.stringify(health) !== JSON.stringify(healthGross) || EXPECT[cur].everything.rec === 0);

      /* ---------- ISPO Operations agrees with ISPO's book ---------- */
      const ispo = F.ispoOperations(expenses, payments, units, cur, FROM, TO);
      const ispoUtil = ispo.groups.find(g => g.category === 'Utilities');
      T.check(`${cur} ISPO Operations: Utilities is ISPO's net cost`, C(ispoUtil?.total ?? 0) === net('ispo'), `${ispoUtil?.total}`);
      T.check(`${cur} ISPO Operations: income is rent and bookings only`, C(ispo.totalIncome) === C(EXPECT[cur].ispo.income));

      /* ---------- Financial Projections ---------- */
      const proj = P.buildProjection(cur, units, charges, payments, expenses, { from: FROM, to: TO, months: 1 }, 3);
      const strataNetAll = C(F.expensesInPeriod(F.strataExpenses(netted), cur, FROM, TO));
      T.check(`${cur} Projections: expenditure is the corporation's costs with its utility net`, C(proj.expensesPaid) === strataNetAll, `${proj.expensesPaid}`);

      /* ---------- Annual Report ---------- */
      const ar = F.annualOwnersReport(units, charges, payments, expenses, cur, 2026, {});
      const opYear = F.operatingStatement(payments, expenses, units, cur, '2026-01-01', '2026-12-31', { book: 'strata' });
      /*
       * Changed 2026-11-21 (owner's rule): the Annual Report presents COMMON costs, so a utility bill tied to a villa and
       * the recoveries of utility from villas are that villa owner's own cost and are left out of it. It still ties to the
       * strata Operating Statement (the corporation's cash record) less exactly those rows.
       */
      const yearVillaUtility = F.strataExpenses(F.withUtilityRecoveries(expenses, payments))
        .filter(e => F.isVillaUtilityCost(e) && e.status === 'paid' && e.currency === cur && (e.datePaid || e.date) >= '2026-01-01' && (e.datePaid || e.date) <= '2026-12-31')
        .reduce((a, e) => a + C(e.amount), 0);
      T.check(`${cur} Annual Report: expenditure equals the strata Operating Statement for the year less villa utilities and their recoveries`, C(ar.expenditure) === C(opYear.totalExpenditure) - yearVillaUtility, `${ar.expenditure} vs ${opYear.totalExpenditure} - ${yearVillaUtility}`);
    }
    // September's 2,500 recovery refunded in October nets to nothing over the year.
    const arJ = F.annualOwnersReport(units, charges, payments, expenses, 'JMD', 2026, {});
    // Changed 2026-11-21: recoveries from villas are the villa owners' own side (not netted from common costs), so the Annual Report reads the gross 80,000.
    T.check('JMD Annual Report: 80,000 of common costs; the 12,000 recovered from villas is not netted from them', C(arJ.expenditure) === C(80000), `${arJ.expenditure}`);

    /* ---------- Owners Statements: a utility receipt never counts as levy paid ---------- */
    const st = F.ownerStatements(units, charges, payments, expenses, [], FROM, TO).find(s => s.unit.id === 'u-a2' && s.currency === 'JMD');
    T.check('Owner statement A2: levy paid is the maintenance receipt only', !!st && C(st.maintenancePaid) === C(20000), st && `${st.maintenancePaid}`);

    /* ---------- positive controls: the assertions above can fail ---------- */
    const gross = F.operatingStatement(payments.filter(p => p.category !== 'Utility'), expenses, units, 'JMD', FROM, TO, { book: 'everything' });
    T.check('control: with the recoveries removed the Utilities group reads the gross 70,000, so the net check is not vacuous',
      C(gross.expenditure.find(g => g.label === 'Utilities')?.total) === C(70000));
    T.check('control: the fixture has recoveries on both books and in both currencies',
      EXPECT.JMD.strata.rec > 0 && EXPECT.JMD.ispo.rec > 0 && EXPECT.USD.strata.rec > 0);

    /* ---------- source guards: every screen goes through the one derivation ---------- */
    const src = f => fs.readFileSync(path.join(projectRoot, 'src', f), 'utf8');
    for (const f of ['components/Reports.tsx', 'components/Charts.tsx', 'components/Dashboard.tsx', 'components/BoardPack.tsx']) {
      T.check(`${f} nets its costs through withUtilityRecoveries`, src(f).includes('withUtilityRecoveries('));
    }
    const all = fs.readdirSync(path.join(projectRoot, 'src', 'components')).map(f => `components/${f}`).concat(['lib/finance.ts', 'lib/projection.ts']);
    T.check('no screen keeps a villa set for utility recoveries (ownerBilledUnitIds is retired)',
      all.every(f => !/ownerBilledUnitIds\(/.test(src(f))));
    T.check('the Operating Statement screen offers no "Utilities recovered" income class',
      !/category: 'Utility'/.test(src('components/OperatingStatement.tsx')));
  } finally {
    cleanup();
  }
  return T.done();
}
