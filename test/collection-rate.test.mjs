/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Collection rate — what share of what FELL DUE is PAID.
 *
 * Found 2026-11-16: the rate divided cash received in the period by charges due
 * in the period, so arrears recovered and money paid ahead both counted as
 * collection. One prepaying villa could hide three unpaid ones. Expected values
 * below are worked by hand, not taken from the application.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Collection rate is paid-of-due, not cash over billed';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rate-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  return { mod: await import(pathToFileURL(outfile).href), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const charge = (unitId, month, amount = 25000) => ({ id: `c-${unitId}-${month}`, unitId, category: 'Maintenance', status: 'open', currency: 'JMD', amount, periodMonth: month, dueDate: `${month}-01` });
const pay = (id, unitId, date, amount, extra = {}) => ({ id, unitId, category: 'Maintenance', status: 'completed', currency: 'JMD', amount, date, method: 'Cash', ...extra });
const units = ['u1', 'u2', 'u3', 'u4'];
const charges = units.flatMap(u => ['2026-10', '2026-11', '2026-12'].map(m => charge(u, m)));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

export default async function run({ projectRoot }) {
  const T = reporter(title);

  // Wiring guard: no screen may feed cash received into the collection rate again.
  const offenders = sourceFiles(path.join(projectRoot, 'src')).flatMap(f =>
    [...fs.readFileSync(f, 'utf-8').matchAll(/collectionRate\(([^)]*)\)/g)].filter(m => /collected|received/i.test(m[1]) && !/:\s*number/.test(m[1])).map(() => path.relative(projectRoot, f))
  );
  T.check('no screen divides cash received by billed to get a collection rate', offenders.length === 0, offenders.join(', '));
  const { mod, cleanup } = await loadFinance(projectRoot);
  const { settledOfBilled } = mod;
  const F2 = mod;
  try {
    const rate = (payments, from, to, asOf) => settledOfBilled(charges, payments, 'JMD', from, to, asOf);

    // u1 prepays Oct, Nov and Dec on 5 Oct; u2, u3, u4 pay nothing.
    const prepaid = [pay('p1', 'u1', '2026-10-05', 75000)];
    T.check('October: 25,000 of 100,000 due is paid = 25% (the old cash formula said 75%)', rate(prepaid, '2026-10-01', '2026-10-31').rate === 25 && rate(prepaid, '2026-10-01', '2026-10-31').settled === 25000, JSON.stringify(rate(prepaid, '2026-10-01', '2026-10-31')));
    T.check('November: the prepaid villa is paid, three are not = 25% (the old formula said 0%)', rate(prepaid, '2026-11-01', '2026-11-30').rate === 25, JSON.stringify(rate(prepaid, '2026-11-01', '2026-11-30')));
    T.check('one prepaying villa cannot make the headline 100%', rate(prepaid, '2026-10-01', '2026-12-31').rate === 25, String(rate(prepaid, '2026-10-01', '2026-12-31').rate));

    // Nobody prepays; u2 pays 25,000 on 10 Nov, which the ledger applies to October.
    const catchUp = [pay('p2', 'u2', '2026-11-10', 25000)];
    T.check('arrears recovered in November do not count as November collected: 0%', rate(catchUp, '2026-11-01', '2026-11-30').settled === 0 && rate(catchUp, '2026-11-01', '2026-11-30').rate === 0, JSON.stringify(rate(catchUp, '2026-11-01', '2026-11-30')));
    T.check('October as at its own end: 0%', rate(catchUp, '2026-10-01', '2026-10-31').rate === 0);
    T.check('October as at 30 November: u2 has since paid it = 25%', settledOfBilled(charges, catchUp, 'JMD', '2026-10-01', '2026-10-31', '2026-11-30').rate === 25);

    // Never above 100%, however much is paid.
    const flood = units.map((u, i) => pay(`f${i}`, u, '2026-10-02', 1000000));
    T.check('a rate never exceeds 100%', rate(flood, '2026-10-01', '2026-12-31').rate === 100, String(rate(flood, '2026-10-01', '2026-12-31').rate));

    // Everyone pays their own month on time.
    const onTime = units.map((u, i) => pay(`o${i}`, u, '2026-11-03', 25000));
    const octAndNov = rate([...units.map((u, i) => pay(`a${i}`, u, '2026-10-03', 25000)), ...onTime], '2026-10-01', '2026-11-30');
    T.check('control: everyone paying on time is 100% of what fell due in Oct and Nov', octAndNov.rate === 100 && octAndNov.billed === 200000, JSON.stringify(octAndNov));

    // Refunds are netted as at the date asked.
    const refunded = [pay('r1', 'u1', '2026-10-05', 25000, { refundedAmount: 25000, refundedOn: '2026-10-20' })];
    T.check('a refunded receipt is not collection: 0%', rate(refunded, '2026-10-01', '2026-10-31').rate === 0, JSON.stringify(rate(refunded, '2026-10-01', '2026-10-31')));
    T.check('but before the refund went out it was: 25% as at 10 Oct', settledOfBilled(charges, refunded, 'JMD', '2026-10-01', '2026-10-31', '2026-10-10').settled === 25000);

    // Voided and pending money does not count; another currency does not mix.
    const junk = [pay('j1', 'u1', '2026-10-05', 25000, { status: 'pending' }), pay('j2', 'u2', '2026-10-05', 25000, { status: 'reversed' }), pay('j3', 'u3', '2026-10-05', 25000, { currency: 'USD' })];
    T.check('pending, voided and wrong-currency receipts collect nothing', rate(junk, '2026-10-01', '2026-10-31').settled === 0);
    T.check('a period with nothing billed has no rate, not 0%', settledOfBilled([], [], 'JMD', '2026-10-01', '2026-10-31').rate === null);

    /* ---- the combined (corporation + ISPO) view: money moving between the books is not collection (QA, 2026-11-16) ---- */
    {
      const mk = (id, over) => ({ id, ownerName: 'X', ownerEmail: '', ownerPhone: '', tenantName: '', tenantEmail: '', tenantPhone: '', meterNumber: '', notes: '', currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over, number: id });
      const let1 = mk('L1', { status: 'long-term', tenantName: 'T', monthlyRent: 75000, monthlyMaintenance: 20000 });
      const stay = mk('S1', { status: 'short-term', monthlyRent: 0, monthlyMaintenance: 10000 });
      const own = mk('O1', { status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 10000 });
      const U = [let1, stay, own];
      const ch = (id, unitId, category, amount, extra = {}) => ({ id, unitId, unitNumber: unitId, category, periodMonth: '2026-10', dueDate: '2026-10-01', amount, currency: 'JMD', status: 'open', ...extra });
      const chs = [
        ch('r1', 'L1', 'Rent', 75000, { rentPortion: 55000, maintenancePortion: 20000 }),
        ch('m1', 'L1', 'Maintenance', 20000),
        ch('m2', 'S1', 'Maintenance', 10000),
        ch('m3', 'O1', 'Maintenance', 10000)
      ];
      const pay = (id, unitId, category, amount) => ({ id, unitId, unitNumber: unitId, category, status: 'completed', currency: 'JMD', amount, date: '2026-10-05', method: 'Cash' });
      // Everyone real pays in full: the tenant pays 75,000 rent; ISPO hands the corporation the short-stay villa's levy; the owner pays 10,000.
      const allPaid = [pay('p1', 'L1', 'Rent', 75000), pay('p2', 'S1', 'Maintenance', 10000), pay('p3', 'O1', 'Maintenance', 10000)];
      const full = mod.combinedSettledOfBilled(chs, allPaid, U, 'JMD', '2026-10-01', '2026-10-31');
      T.check('combined: tenant paid rent incl. levy, ISPO paid its levy, owner paid: everything real is paid = 100%', full.rate === 100, JSON.stringify(full));
      const ownerUnpaid = [pay('p1', 'L1', 'Rent', 75000), pay('p2', 'S1', 'Maintenance', 10000)];
      const half = mod.combinedSettledOfBilled(chs, ownerUnpaid, U, 'JMD', '2026-10-01', '2026-10-31');
      T.check('combined: the owner has not paid their 10,000 of 85,000 collectable: 88.24%', half.billed === 85000 && half.settled === 75000 && half.rate === 88.24, JSON.stringify(half));
      const tenantUnpaid = [pay('p2', 'S1', 'Maintenance', 10000), pay('p3', 'O1', 'Maintenance', 10000)];
      const t0 = mod.combinedSettledOfBilled(chs, tenantUnpaid, U, 'JMD', '2026-10-01', '2026-10-31');
      T.check('combined: the tenant has paid nothing: 10,000 of 85,000 = 11.76%', t0.rate === 11.76, JSON.stringify(t0));
    }
  } finally {
    cleanup();
  }
  return T.done();
}
