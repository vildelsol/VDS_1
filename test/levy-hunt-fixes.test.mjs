/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owner books and the levy: four faults the 2026-11-19 hunt reproduced.
 *
 *   1. The Annual Report divided a part year's cost by twelve and proposed a
 *      levy about four times too low; months before the books began were
 *      credited a contribution and counted as "covered".
 *   2. A refund recorded against an earlier, closed month's rent receipt moved
 *      that month's levy credit into a later month.
 *   3. The out-of-pocket shortfall could exceed the levy actually paid.
 *   4. The Reports presets ran past today, so ageing and receivables counted
 *      days that had not happened.
 *   5. The ISPO statement named the villas it lets from today's status, not
 *      the period's (Ro, 2026-11-20).
 *
 * Pure: bundled source, no server, no clock read except where the rule is about
 * today (4), which asserts against today() itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Annual report part years, refunds against closed months, shortfall cap, report range';

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-levyfix-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `export * as fin from './src/lib/finance'; export * as dates from './src/lib/dates'; export { rangeForPreset } from './src/components/Reports';`,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const villa = (i, over = {}) => ({
  id: `unit-${i}`, number: String(i), ownerName: `Owner ${i}`, ownerEmail: '', ownerPhone: '', tenantName: '', tenantEmail: '', tenantPhone: '',
  status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '',
  rentDueDay: 1, maintDueDay: 1, ...over
});
const expense = (date, amount) => ({
  id: `ex-${date}`, category: 'Security', vendor: 'Armour', description: '', unitId: '', unitNumber: 'General', amount, currency: 'JMD',
  date, dueDate: date, datePaid: date, status: 'paid', paymentMethod: 'Bank Transfer', reference: '', notes: ''
});
let n = 0;
const pay = (unitId, category, amount, date, over = {}) => ({
  id: `p${++n}`, receiptNo: `R${n}`, payerName: 'x', unitId, unitNumber: unitId.replace('unit-', ''), category, amount, currency: 'JMD', date,
  method: 'Bank Transfer', reference: '', notes: '', staffMember: 'test', status: 'completed', ...over
});
const charge = (unitId, category, month, amount, over = {}) => ({
  id: `c-${unitId}-${category}-${month}`, unitId, unitNumber: unitId.replace('unit-', ''), category, periodMonth: month, dueDate: `${month}-01`,
  amount, currency: 'JMD', status: 'open', payerName: 'x', createdAt: `${month}-01T00:00:00Z`, createdBy: 'test', ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await load(projectRoot);
  const { fin, dates } = mod;
  try {
    /* ---------------- 1. annual report over a part year ---------------- */
    // Books begin 2025-09-01; four months of J$100,000 across 10 villas. A past
    // year, so nothing depends on today.
    const units = Array.from({ length: 10 }, (_, i) => villa(i + 1));
    const spend = ['2025-09-15', '2025-10-15', '2025-11-15', '2025-12-15'].map(d => expense(d, 100000));
    const r = fin.annualOwnersReport(units, [], [], spend, 'JMD', 2025, { booksBeginOn: '2025-09-01' });
    T.check('setup: four months on the books', r.monthsRecorded === 4, String(r.monthsRecorded));
    T.check('cost per villa per month is over the months recorded: J$10,000, not a twelfth of four months', r.perUnitMonthly === 10000, String(r.perUnitMonthly));
    T.check('an untouched budget line is the annualised run rate: J$1,200,000 for the year', r.budgetExpenditure === 1200000, String(r.budgetExpenditure));
    T.check('so the contribution needed to cover it is J$10,000 a villa a month', r.feeToCoverBudget === 10000, String(r.feeToCoverBudget));
    T.check('the change in a line against the run rate is nil, not a 200% rise', r.categories.every(c => c.budgetChangePct === 0), JSON.stringify(r.categories.map(c => c.budgetChangePct)));
    T.check('months before the books began are credited no contribution', r.months.slice(0, 8).every(m => m.income === 0), JSON.stringify(r.months.slice(0, 8).map(m => m.income)));
    T.check('and are not counted as covered: 4 recorded months, all covered', r.monthsCovered === 4, String(r.monthsCovered));
    const full = fin.annualOwnersReport(units, [], [], Array.from({ length: 12 }, (_, m) => expense(`2025-${String(m + 1).padStart(2, '0')}-15`, 100000)), 'JMD', 2025);
    T.check('control: a full year still divides by twelve', full.perUnitMonthly === 10000 && full.budgetExpenditure === 1200000 && full.monthsCovered === 12, JSON.stringify([full.perUnitMonthly, full.budgetExpenditure, full.monthsCovered]));

    /* ---------------- 2. refund against an earlier rent receipt ---------------- */
    const let1 = villa(1, { status: 'long-term', ownerName: 'ISPO', tenantName: 'C15 Tenant', monthlyRent: 80000 });
    const months = ['2026-09', '2026-10', '2026-11'];
    const charges = months.flatMap(m => [charge('unit-1', 'Rent', m, 80000, { maintenancePortion: 20000 }), charge('unit-1', 'Maintenance', m, 20000)]);
    const receipts = [
      pay('unit-1', 'Rent', 80000, '2026-09-03', { refundedAmount: 80000, refundedOn: '2026-11-18' }),
      pay('unit-1', 'Rent', 80000, '2026-10-03'),
      pay('unit-1', 'Rent', 80000, '2026-11-03'),
      pay('unit-1', 'Rent', 80000, '2026-11-16')
    ];
    const credits = fin.settledFromRent(charges, receipts, '2026-11-20');
    const inMonth = m => credits.filter(p => p.date.startsWith(m)).reduce((a, p) => a + p.amount, 0);
    T.check('a later refund booked against September’s receipt leaves September’s levy settled in September', inMonth('2026-09') === 20000, JSON.stringify(credits.map(p => [p.date, p.amount])));
    T.check('and every month’s levy is still settled once: J$60,000 in all', credits.reduce((a, p) => a + p.amount, 0) === 60000, JSON.stringify(credits.map(p => [p.date, p.amount])));
    const short = fin.settledFromRent(charges, receipts.slice(0, 3), '2026-11-20');
    T.check('control: with no overpayment to give back, the refund really does leave a month unsettled', short.reduce((a, p) => a + p.amount, 0) === 40000, JSON.stringify(short.map(p => [p.date, p.amount])));

    /* ---------------- 3. shortfall never exceeds the levy paid ---------------- */
    const b6 = villa(6, { status: 'short-term', ownerName: 'ISPO' });
    const sPay = [
      pay('unit-6', 'Booking', 30000, '2026-10-10', { refundedAmount: 10000, refundedOn: '2026-11-05' }),
      pay('unit-6', 'Maintenance', 20000, '2026-11-03')
    ];
    const sf = fin.outOfPocketShortfall([b6], [], [], sPay, 'JMD', '2026-11-01', '2026-11-30');
    const line = sf.lines.find(l => l.unitId === 'unit-6' && l.month === '2026-11');
    T.check('a month whose only booking money was a refund shows it as negative earnings', line?.shortStayReceived === -10000, JSON.stringify(line));
    T.check('but the shortfall is capped at the J$20,000 levy paid, not J$30,000', line?.shortfall === 20000, JSON.stringify(line));

    /* ---------------- 5. ISPO statement names the villas it let in the period ---------------- */
    // Sold to a proprietor on 2026-11-15: still ISPO's in October, not in December.
    const sold = villa(20, { status: 'owner-occupied', ownerName: 'New Owner', ownAccountHistory: [{ from: '2026-11-15', ownAccount: false }] });
    const kept = villa(21, { status: 'vacant', ownerName: 'ISPO' });
    const owned = villa(22, { status: 'owner-occupied', ownerName: 'Always A Proprietor' });
    const names = (s, e) => fin.ispoOperations([], [], [sold, kept, owned], 'JMD', s, e).ownAccountVillas;
    const oct = names('2026-10-01', '2026-10-31');
    T.check('a reprint of October names the villa ISPO let then, though it is sold now', oct.some(v => /20$/.test(v)) && oct.some(v => /21$/.test(v)), JSON.stringify(oct));
    T.check('and never a villa that was always a proprietor’s', !oct.some(v => /22$/.test(v)), JSON.stringify(oct));
    const dec = names('2026-12-01', '2026-12-31');
    T.check('control: December, after the sale, no longer names it', !dec.some(v => /20$/.test(v)) && dec.some(v => /21$/.test(v)), JSON.stringify(dec));

    /* ---------------- 4. report range ends no later than today ---------------- */
    const day = dates.today();
    for (const preset of ['thisMonth', 'last3', 'last6', 'last12', 'ytd', 'lastMonth']) {
      const range = mod.rangeForPreset(preset, { from: day, to: day });
      T.check(`the "${preset}" range ends no later than today`, range.to <= day && range.from <= range.to, JSON.stringify(range));
    }
    const thisMonth = mod.rangeForPreset('thisMonth', { from: day, to: day });
    T.check('"this month" ends today, not at month end', thisMonth.to === day, JSON.stringify(thisMonth));
    const past = mod.rangeForPreset('custom', { from: '2025-01-01', to: '2025-03-31' });
    T.check('control: a custom range wholly in the past is left alone', past.from === '2025-01-01' && past.to === '2025-03-31', JSON.stringify(past));
  } finally {
    cleanup();
  }
  return T.done();
}
