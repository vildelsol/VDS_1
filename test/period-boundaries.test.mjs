/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Period boundaries — the test the suite lacked.
 *
 * ~3,200 tests passed while owner statements ignored money received BEFORE their
 * period, because every fixture kept a charge and its payment in the same month
 * and every statement check used one wide window. This test slices time: random
 * receipts on ANY day of the month (28th to 31st, leap February included), paid
 * ahead, late, in part, refunded, and then checks, month by month:
 *
 *  1. slicing into months and summing equals one wide window (no cliff at a
 *     boundary): billed, received, and cash collected;
 *  2. what a statement says is owing at each month end equals the ledger balance at
 *     that month end, worked here from the raw rows by an independent oracle, never
 *     from the application's own balance function;
 *  3. a receipt dated on the last day of a month lands in that month, and one dated
 *     on the 1st lands in the next.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Period boundaries: months sum to the whole, statements tie to the ledger';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-periods-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  return { mod: await import(pathToFileURL(outfile).href), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const pad = n => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const cents = v => Math.round(v * 100);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2027-10 .. 2028-04: crosses a year end and the leap February of 2028.
const MONTHS = ['2027-10', '2027-11', '2027-12', '2028-01', '2028-02', '2028-03', '2028-04'];
const monthBounds = m => {
  const [y, mo] = m.split('-').map(Number);
  return { from: `${m}-01`, to: `${m}-${pad(lastDay(y, mo))}` };
};

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod: F, cleanup } = await loadFinance(projectRoot);
  try {
    const unit = (id, n) => ({
      id, number: String(n), ownerName: `Owner ${n}`, ownerEmail: '', ownerPhone: '', tenantName: '', tenantEmail: '', tenantPhone: '', status: 'owner-occupied',
      monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '', rentDueDay: 1, maintDueDay: 1
    });
    const units = [unit('u1', 1), unit('u2', 2), unit('u3', 3)];

    /* ---- the leap-year and month-end edges, worked by hand ---- */
    {
      const u = units[0];
      const charges = MONTHS.map(m => ({ id: `c-${m}`, unitId: 'u1', unitNumber: '1', category: 'Maintenance', periodMonth: m, dueDate: `${m}-01`, amount: 20000, currency: 'JMD', status: 'open', payerName: 'Owner 1' }));
      const p = (id, date, amount) => ({ id, unitId: 'u1', unitNumber: '1', category: 'Maintenance', status: 'completed', currency: 'JMD', amount, date, method: 'Cash', payerName: 'Owner 1' });
      const payments = [p('a', '2028-02-29', 20000), p('b', '2028-03-01', 20000), p('c', '2027-12-31', 20000), p('d', '2028-01-01', 20000)];
      const st = (from, to) => F.ownerStatement(u, units, charges, payments, [], [], 'JMD', from, to);
      T.check('leap day: a receipt on 29 Feb 2028 is in February', st('2028-02-01', '2028-02-29').maintenancePaid === 20000);
      T.check('and not in March', st('2028-03-01', '2028-03-31').maintenancePaid === 20000 && st('2028-03-01', '2028-03-31').maintenancePaid !== 40000);
      T.check('31 Dec 2027 is the last day of the old year, 1 Jan 2028 the first of the new', st('2027-12-01', '2027-12-31').maintenancePaid === 20000 && st('2028-01-01', '2028-01-31').maintenancePaid === 20000);
      T.check('a year-end statement splits cleanly at the boundary', F.collectedInPeriod(payments, 'JMD', '2027-12-31', '2027-12-31').maintenance === 20000 && F.collectedInPeriod(payments, 'JMD', '2028-01-01', '2028-01-01').maintenance === 20000);
    }

    /* ---- random: slicing time must not change the answer ---- */
    const SCENARIOS = 400;
    let sliceBad = 0, tieBad = 0, checked = 0;
    const examples = [];
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const rand = rng(seed * 7919);
      const charges = [];
      for (const u of units) for (const m of MONTHS) charges.push({ id: `c-${u.id}-${m}`, unitId: u.id, unitNumber: u.number, category: 'Maintenance', periodMonth: m, dueDate: `${m}-01`, amount: 20000, currency: 'JMD', status: 'open', payerName: u.ownerName });
      const payments = [];
      const count = 3 + Math.floor(rand() * 14);
      for (let i = 0; i < count; i++) {
        const u = units[Math.floor(rand() * units.length)];
        const m = MONTHS[Math.floor(rand() * MONTHS.length)];
        const [y, mo] = m.split('-').map(Number);
        const day = 1 + Math.floor(rand() * lastDay(y, mo)); // any real day, 29 to 31 included
        const amount = [5000, 10000, 20000, 20000, 40000, 60000, 100000][Math.floor(rand() * 7)];
        const pay = { id: `p${seed}-${i}`, unitId: u.id, unitNumber: u.number, category: 'Maintenance', status: 'completed', currency: 'JMD', amount, date: `${m}-${pad(day)}`, method: 'Cash', payerName: u.ownerName };
        if (rand() < 0.12) {
          const rm = MONTHS[Math.min(MONTHS.length - 1, MONTHS.indexOf(m) + Math.floor(rand() * 2))];
          const [ry, rmo] = rm.split('-').map(Number);
          const rday = Math.min(lastDay(ry, rmo), 1 + Math.floor(rand() * 31));
          const refundedOn = `${rm}-${pad(rday)}`;
          if (refundedOn >= pay.date) { pay.refundedAmount = Math.round(amount * [0.25, 0.5, 1][Math.floor(rand() * 3)]); pay.refundedOn = refundedOn; }
        }
        payments.push(pay);
      }
      const wideFrom = '2027-10-01';
      const wideTo = '2028-04-30';
      for (const u of units) {
        const wide = F.ownerStatement(u, units, charges, payments, [], [], 'JMD', wideFrom, wideTo);
        const slices = MONTHS.map(m => { const b = monthBounds(m); return F.ownerStatement(u, units, charges, payments, [], [], 'JMD', b.from, b.to); });
        const sum = f => slices.reduce((a, s) => a + cents(s[f]), 0);
        checked++;
        if (sum('maintenanceBilled') !== cents(wide.maintenanceBilled) || sum('maintenancePaid') !== cents(wide.maintenancePaid)) {
          sliceBad++;
          if (examples.length < 3) examples.push(`seed ${seed} ${u.id}: months sum billed ${sum('maintenanceBilled')} paid ${sum('maintenancePaid')} vs wide ${cents(wide.maintenanceBilled)} / ${cents(wide.maintenancePaid)}`);
        }
        // cash collected by the same slicing
        const cashMonths = MONTHS.reduce((a, m) => { const b = monthBounds(m); return a + cents(F.collectedInPeriod(payments.filter(x => x.unitId === u.id), 'JMD', b.from, b.to).maintenance); }, 0);
        const cashWide = cents(F.collectedInPeriod(payments.filter(x => x.unitId === u.id), 'JMD', wideFrom, wideTo).maintenance);
        if (cashMonths !== cashWide) { sliceBad++; if (examples.length < 3) examples.push(`seed ${seed} ${u.id}: cash by month ${cashMonths} vs wide ${cashWide}`); }

        // the independent oracle: the ledger balance at each month end, from raw rows
        for (const m of MONTHS) {
          const b = monthBounds(m);
          const charged = charges.filter(c => c.unitId === u.id && c.dueDate <= b.to).reduce((a, c) => a + cents(c.amount), 0);
          const received = payments.filter(p => p.unitId === u.id && p.date <= b.to).reduce((a, p) => a + cents(p.amount) - (p.refundedOn && p.refundedOn <= b.to ? cents(p.refundedAmount || 0) : 0), 0);
          const oracle = charged - received;
          const stmt = F.ownerStatement(u, units, charges, payments, [], [], 'JMD', '1900-01-01', b.to);
          if (cents(stmt.maintenanceOwed) !== oracle) {
            tieBad++;
            if (examples.length < 3) examples.push(`seed ${seed} ${u.id} ${m}: statement owing ${cents(stmt.maintenanceOwed)} vs ledger ${oracle}`);
          }
        }
      }
    }
    T.check(`${checked} villa-histories: the months add up to the whole (billed, received, cash)`, sliceBad === 0, examples.join(' | '));
    T.check(`every statement's owing at every month end equals the independently worked ledger balance (${checked * MONTHS.length} checks)`, tieBad === 0, examples.join(' | '));
  } finally {
    cleanup();
  }
  return T.done();
}
