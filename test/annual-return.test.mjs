/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The annual return to the Commission of Strata Corporations — Forms 13B and 13C.
 *
 * Both are ageing schedules with the same four columns: 30 / 60 / 90 / 90-and-over.
 * 13B ages what proprietors owe the corporation, keyed by **strata lot number**
 * rather than the villa label people use day to day. 13C ages what the
 * corporation owes third parties, which is what a pending expense is.
 *
 * The invariant that matters more than any single figure: **the buckets must add
 * up to the balance.** `accountBalance` lists a part-paid charge in
 * `unpaidCharges` in full — right for showing which months are open, wrong here,
 * because summing those would report more owing than the account actually owes.
 * A return that does not agree with its own balance is worse than no return.
 *
 * Uses the real `src/lib/finance.ts` rather than a copy of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Annual return (Forms 13B & 13C)';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-return-'));
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

/** A fixed year end, so ageing is arithmetic rather than a moving target. */
const AS_OF = '2026-03-31';

/** A due date exactly `days` before the year end. */
function due(days) {
  const d = new Date(Date.UTC(2026, 2, 31));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const villa = (over = {}) => ({
  id: 'unit-1',
  number: '1',
  ownerName: 'Owner',
  ownerEmail: '',
  ownerPhone: '',
  tenantName: '',
  tenantEmail: '',
  tenantPhone: '',
  status: 'owner-occupied',
  monthlyRent: 0,
  monthlyMaintenance: 10000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  meterNumber: '',
  notes: '',
  ...over
});

const charge = (over = {}) => ({
  id: `chg-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  periodMonth: '2026-01',
  dueDate: due(15),
  amount: 10000,
  currency: 'JMD',
  status: 'open',
  payerName: 'Owner',
  createdAt: '',
  createdBy: 'test',
  ...over
});

const payment = (over = {}) => ({
  id: `p-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  amount: 10000,
  currency: 'JMD',
  date: due(10),
  status: 'completed',
  payerName: 'Owner',
  method: 'Cash',
  receiptNo: 'R1',
  ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  try {
    /* ---------------- 13B: the columns are the form's ---------------- */

    const units = [villa({ id: 'unit-1', number: '1', strataLotNumber: 'SP2724-1' })];
    const aged = mod.form13BContributions(
      units,
      [
        charge({ dueDate: due(10), amount: 1000 }), // within 30
        charge({ dueDate: due(45), amount: 2000 }), // 31–60
        charge({ dueDate: due(75), amount: 3000 }), // 61–90
        charge({ dueDate: due(200), amount: 4000 }) // over 90
      ],
      [],
      AS_OF
    );
    const row = aged.rows[0];
    T.check('a debt inside 30 days lands in the first column', row.buckets.d30 === 1000, String(row.buckets.d30));
    T.check('31 to 60 days lands in the second', row.buckets.d60 === 2000, String(row.buckets.d60));
    T.check('61 to 90 days lands in the third', row.buckets.d90 === 3000, String(row.buckets.d90));
    T.check('over 90 days lands in the column the Commission reads', row.buckets.over90 === 4000, String(row.buckets.over90));
    T.check('and the row totals what is owed', row.buckets.total === 10000, String(row.buckets.total));

    // The boundaries themselves, which is where an ageing schedule usually lies.
    const edges = mod.form13BContributions(
      units,
      [charge({ dueDate: due(30), amount: 100 }), charge({ dueDate: due(31), amount: 200 }), charge({ dueDate: due(90), amount: 300 }), charge({ dueDate: due(91), amount: 400 })],
      [],
      AS_OF
    ).rows[0].buckets;
    T.check('day 30 is still the 30-day column', edges.d30 === 100, String(edges.d30));
    T.check('day 31 has moved on', edges.d60 === 200, String(edges.d60));
    T.check('day 90 is still the 90-day column', edges.d90 === 300, String(edges.d90));
    T.check('day 91 is over 90', edges.over90 === 400, String(edges.over90));

    /* ---------------- the invariant ---------------- */

    // Two months owed, one and a half months paid. The half-covered charge must
    // contribute only its remainder, or the return overstates the debt.
    const partial = mod.form13BContributions(
      units,
      [charge({ dueDate: due(120), amount: 10000 }), charge({ dueDate: due(20), amount: 10000 })],
      [payment({ amount: 15000, date: due(5) })],
      AS_OF
    );
    T.check(
      'a part-paid charge contributes only what is left of it',
      partial.rows[0].buckets.total === 5000,
      String(partial.rows[0].buckets.total)
    );
    T.check(
      'and the remainder ages to the newer charge, the older one being settled first',
      partial.rows[0].buckets.d30 === 5000 && partial.rows[0].buckets.over90 === 0,
      `d30=${partial.rows[0].buckets.d30} over90=${partial.rows[0].buckets.over90}`
    );

    const settled = mod.form13BContributions(units, [charge({ amount: 10000 })], [payment({ amount: 10000 })], AS_OF);
    T.check('a lot that owes nothing does not appear on the form', settled.rows.length === 0, `${settled.rows.length} rows`);

    const credit = mod.form13BContributions(units, [charge({ amount: 10000 })], [payment({ amount: 15000 })], AS_OF);
    T.check('nor does one in credit', credit.rows.length === 0, `${credit.rows.length} rows`);

    /* ---------------- it is keyed by strata lot ---------------- */

    T.check('the row is keyed by the strata lot number', row.strataLot === 'SP2724-1', row.strataLot);
    T.check('and does not claim the number was assumed', row.lotNumberAssumed === false);

    const noLot = mod.form13BContributions([villa({ id: 'unit-1', number: '7' })], [charge({ amount: 5000 })], [], AS_OF).rows[0];
    T.check('a lot with no strata number falls back to the villa label', noLot.strataLot === '7', noLot.strataLot);
    T.check('and says so, so it can be corrected before filing', noLot.lotNumberAssumed === true);

    /* ---------------- currencies are not added together ---------------- */

    const mixed = mod.form13BContributions(
      [
        villa({ id: 'unit-1', number: '1', strataLotNumber: 'A', maintCurrency: 'JMD' }),
        villa({ id: 'unit-2', number: '2', strataLotNumber: 'B', maintCurrency: 'USD' })
      ],
      [
        charge({ unitId: 'unit-1', unitNumber: '1', amount: 10000, currency: 'JMD' }),
        charge({ unitId: 'unit-2', unitNumber: '2', amount: 130, currency: 'USD' })
      ],
      [],
      AS_OF
    );
    T.check('each lot is reported in the currency it is billed in', mixed.rows.length === 2);
    T.check(
      'and the totals are stated per currency rather than summed into a fiction',
      mixed.totalsByCurrency.length === 2 &&
        mixed.totalsByCurrency.find(t => t.currency === 'JMD').buckets.total === 10000 &&
        mixed.totalsByCurrency.find(t => t.currency === 'USD').buckets.total === 130,
      JSON.stringify(mixed.totalsByCurrency.map(t => [t.currency, t.buckets.total]))
    );

    /* ---------------- 13C: what the corporation owes ---------------- */

    const expense = (over = {}) => ({
      id: `ex-${Math.random().toString(16).slice(2)}`,
      category: 'Utilities',
      vendor: 'JPS',
      description: '',
      unitId: '',
      unitNumber: 'General',
      amount: 5000,
      currency: 'JMD',
      date: due(20),
      dueDate: due(20),
      status: 'pending',
      reference: '',
      notes: '',
      ...over
    });

    const debts = mod.form13CDebts(
      [
        expense({ category: 'Utilities', amount: 5000, dueDate: due(20) }),
        expense({ category: 'Property Taxes', amount: 8000, dueDate: due(100) }),
        expense({ category: 'Security', amount: 96000, dueDate: due(45) }),
        expense({ category: 'Security', amount: 1000, status: 'paid', dueDate: due(45) })
      ],
      AS_OF
    );
    T.check('only unpaid costs are listed as debts', debts.totalsByCurrency[0].buckets.total === 109000, String(debts.totalsByCurrency[0].buckets.total));
    T.check(
      'a cost already settled is not a debt',
      !debts.rows.some(r => r.buckets.total === 1000),
      debts.rows.map(r => `${r.description}:${r.buckets.total}`).join(',')
    );
    T.check(
      "utilities are labelled the way the form words it",
      debts.rows.some(r => r.description === 'Light / Water'),
      debts.rows.map(r => r.description).join(',')
    );
    T.check(
      'property tax too',
      debts.rows.some(r => r.description === 'Property Tax'),
      debts.rows.map(r => r.description).join(',')
    );
    T.check(
      'a cost the form does not name keeps its own description rather than being hidden in Other',
      debts.rows.some(r => r.description === 'Security'),
      debts.rows.map(r => r.description).join(',')
    );
    T.check(
      'and each is aged from when it fell due',
      debts.rows.find(r => r.description === 'Security').buckets.d60 === 96000,
      JSON.stringify(debts.rows.find(r => r.description === 'Security').buckets)
    );

    const future = mod.form13CDebts([expense({ dueDate: '2026-06-01', date: '2026-06-01' })], AS_OF);
    T.check('a cost not yet due at the year end is not an outstanding debt', future.rows.length === 0, `${future.rows.length} rows`);
  } finally {
    cleanup();
  }

  return T.done();
}
