/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maintenance on a rented villa is settled out of the rent (Ro, 2026-11-10).
 *
 * Part 1: worked examples, including the J$75,000 / J$20,000 case.
 * Part 2: 5,000 randomised books checked against invariants and an independent
 *         oracle written here, not against settledFromRent itself.
 * Part 3: red team: refunds, voids, pending money, other currencies, legacy
 *         charges, a hand-entered maintenance receipt, hostile numbers.
 * Part 4: the whole thing through the real server and the real finance library.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Maintenance settled from rent';

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
const C = n => Math.round(n * 100);

let seq = 0;
const rentCharge = (unitId, month, amount, maint, over = {}) => ({
  id: `r-${unitId}-${month}-${seq++}`, unitId, unitNumber: unitId, category: 'Rent', periodMonth: month, dueDate: `${month}-01`,
  amount, rentPortion: amount - maint, maintenancePortion: maint, currency: 'JMD', status: 'open', payerName: 'T', createdAt: '', createdBy: '', ...over
});
const maintCharge = (unitId, month, amount, over = {}) => ({
  id: `m-${unitId}-${month}-${seq++}`, unitId, unitNumber: unitId, category: 'Maintenance', periodMonth: month, dueDate: `${month}-01`,
  amount, currency: 'JMD', status: 'open', payerName: 'O', createdAt: '', createdBy: '', ...over
});
const pay = (unitId, category, amount, date, over = {}) => ({
  id: `p-${unitId}-${date}-${seq++}`, receiptNo: 'R' + seq, payerName: 'P', unitId, unitNumber: unitId, category, amount, currency: 'JMD', date,
  method: 'Cash', reference: '', notes: '', staffMember: 's', status: 'completed', ...over
});

export default async function run({ port, projectRoot }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-settled-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const T = reporter(title);
  const total = list => list.reduce((a, p) => a + C(p.amount), 0);
  const maintBal = (unit, charges, payments, asOf) => F.accountBalance(unit, 'Maintenance', charges, payments, asOf, [unit]);
  const U = id => ({ id, number: id, ownerName: 'O', tenantName: 'T', status: 'long-term', monthlyRent: 55000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });

  /* ================= 1. worked examples ================= */
  {
    const u = U('u1');
    const charges = [rentCharge('u1', '2026-09', 75000, 20000), rentCharge('u1', '2026-10', 75000, 20000), maintCharge('u1', '2026-09', 20000), maintCharge('u1', '2026-10', 20000)];
    T.check('no rent received, nothing is settled', F.settledFromRent(charges, []).length === 0);
    T.check('before: maintenance shows 40,000 owing', maintBal(u, charges, [], '2026-10-31').balance === 40000);

    let pays = [pay('u1', 'Rent', 75000, '2026-09-05')];
    let d = F.settledFromRent(charges, pays);
    T.check('September rent paid in full settles September maintenance: 20,000', d.length === 1 && d[0].amount === 20000 && d[0].date === '2026-09-05' && d[0].derived === true && d[0].category === 'Maintenance', JSON.stringify(d));
    T.check('maintenance account owes 20,000 (October only)', maintBal(u, charges, [...pays, ...d], '2026-10-31').balance === 20000);
    T.check('the stored receipts are not modified', pays.length === 1 && !pays[0].derived);

    pays = [pay('u1', 'Rent', 37500, '2026-09-05')];
    d = F.settledFromRent(charges, pays);
    T.check('half of September paid: half of the maintenance, 10,000', total(d) === 1000000, String(total(d) / 100));
    pays.push(pay('u1', 'Rent', 37500, '2026-09-20'));
    T.check('the other half later completes it: 20,000 in two credits', total(F.settledFromRent(charges, pays)) === 2000000);

    pays = [pay('u1', 'Rent', 150000, '2026-10-02')];
    d = F.settledFromRent(charges, pays);
    T.check('150,000 paid clears both months: 40,000 settled, account at 0', total(d) === 4000000 && maintBal(u, charges, [...pays, ...d], '2026-10-31').balance === 0, String(total(d) / 100));

    pays = [pay('u1', 'Rent', 300000, '2026-10-02')];
    d = F.settledFromRent(charges, pays);
    T.check('paying far ahead never settles more than is owed (40,000)', total(d) === 4000000, String(total(d) / 100));

    pays = [pay('u1', 'Rent', 75000, '2026-09-05'), pay('u1', 'Maintenance', 20000, '2026-09-06')];
    d = F.settledFromRent(charges, pays);
    T.check('rent plus a hand-entered 20,000 maintenance receipt: no double credit', maintBal(u, charges, [...pays, ...d], '2026-10-31').balance >= 0 && total(d) <= 2000000, String(total(d) / 100));
  }

  /* ================= 2. 5,000 randomised books ================= */
  {
    const rand = rng(20261110);
    const pick = a => a[Math.floor(rand() * a.length)];
    let violations = 0;
    const note = (msg, detail) => { violations++; if (violations <= 8) console.log('   !!', msg, detail); };
    for (let n = 0; n < 5000; n++) {
      seq = 0;
      const months = Math.floor(rand() * 8) + 1;
      const rent = pick([45000, 55000, 60000, 65000.5, 120000]);
      const maint = pick([0, 20000, 25000, 27000, 33333.33]);
      const charges = [];
      for (let m = 0; m < months; m++) {
        const month = `2026-${String(m + 1).padStart(2, '0')}`;
        const lm = m >= 6 ? 27000 : maint; // levy rises mid-run
        const total = Math.round((rent + lm) * 100) / 100;
        charges.push(rentCharge('u', month, total, lm));
        if (lm > 0 && rand() < 0.9) charges.push(maintCharge('u', month, lm));
      }
      if (rand() < 0.2) charges[Math.floor(rand() * charges.length)].status = 'void';
      if (rand() < 0.15) charges.push(rentCharge('u', '2026-03', 5000, 0, { kind: 'one-off' }));
      if (rand() < 0.1) charges.push(rentCharge('u', '2025-12', 55000, 0, { rentPortion: undefined, maintenancePortion: undefined })); // legacy
      const payments = [];
      const k = Math.floor(rand() * 10);
      for (let i = 0; i < k; i++) {
        const p = pay('u', pick(['Rent', 'Rent', 'Rent', 'Maintenance']), pick([1000, 20000, 37500, 75000, 82000.25, 150000]), `2026-${String(Math.floor(rand() * 11) + 1).padStart(2, '0')}-${pick(['05', '15', '25'])}`);
        if (rand() < 0.1) p.status = pick(['pending', 'reversed']);
        if (rand() < 0.1) { p.refundedAmount = Math.min(p.amount, pick([500, 5000])); p.refundedOn = '2026-11-30'; }
        if (rand() < 0.05) p.currency = 'USD';
        payments.push(p);
      }
      const snapshot = JSON.stringify([charges, payments]);
      const d = F.settledFromRent(charges, payments);
      if (JSON.stringify([charges, payments]) !== snapshot) note('inputs mutated', n);

      // independent oracle
      const openRent = charges.filter(c => c.category === 'Rent' && c.status === 'open').sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
      const openMaint = charges.filter(c => c.category === 'Maintenance' && c.status === 'open');
      const rentPaid = payments.filter(p => p.category === 'Rent' && p.status === 'completed' && p.currency === 'JMD').reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const maintPaid = payments.filter(p => p.category === 'Maintenance' && p.status === 'completed' && p.currency === 'JMD').reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const maintOwed = Math.max(0, openMaint.reduce((a, c) => a + C(c.amount), 0) - maintPaid);
      const shareAvail = openRent.reduce((a, c) => a + C(c.maintenancePortion || 0), 0);
      let left = rentPaid, exact = 0;
      for (const c of openRent) { const take = Math.min(left, C(c.amount)); if (C(c.amount) > 0) exact += (C(c.maintenancePortion || 0) * take) / C(c.amount); left -= take; }
      const expected = Math.min(Math.round(exact), maintOwed);
      const got = d.reduce((a, p) => a + C(p.amount), 0);
      // cap can bind earlier than the end-state total only through rounding of per-receipt emission, allow 1 cent per receipt
      if (Math.abs(got - expected) > Math.max(1, payments.length)) note('credit differs from oracle', `${n}: got ${got} expected ${expected}`);
      if (got > maintOwed) note('credit exceeds what is owed', `${n}: ${got} > ${maintOwed}`);
      if (got > rentPaid) note('credit exceeds rent received', `${n}`);
      if (got > shareAvail) note('credit exceeds the maintenance inside the rent', `${n}`);
      if (d.some(p => !(p.amount > 0) || !Number.isFinite(p.amount) || C(p.amount) / 100 !== p.amount)) note('bad amount', `${n}`);
      if (d.some(p => p.category !== 'Maintenance' || p.currency !== 'JMD' || p.status !== 'completed' || !p.derived)) note('bad derived record', `${n}`);
      if (new Set(d.map(p => p.id)).size !== d.length) note('duplicate derived ids', `${n}`);
      if (F.settledFromRent(charges, payments).length !== d.length || JSON.stringify(F.settledFromRent(charges, payments)) !== JSON.stringify(d)) note('not deterministic', `${n}`);
      // adding the derived credits as payments must not change a second pass (idempotent when re-fed)
      const again = F.settledFromRent(charges, [...payments, ...d]);
      if (JSON.stringify(again) !== JSON.stringify(d)) note('re-feeding derived credits changed the result', `${n}`);
      // never negative maintenance account because of the credit alone
      const u = U('u');
      const bal = F.accountBalance(u, 'Maintenance', charges, [...payments, ...d], '2026-12-31', [u]).balance;
      const balWithout = F.accountBalance(u, 'Maintenance', charges, payments, '2026-12-31', [u]).balance;
      if (bal < Math.min(0, balWithout) - 0.001) note('credit pushed the account below where it already was', `${n}: ${bal} vs ${balWithout}`);
    }
    T.check('5,000 randomised books: credit matches the oracle, never exceeds what is owed, paid or inside the rent, inputs untouched, deterministic, idempotent', violations === 0, `${violations} violations`);
  }

  /* ================= 3. red team ================= */
  {
    seq = 0;
    const u = U('u');
    const base = [rentCharge('u', '2026-09', 75000, 20000), maintCharge('u', '2026-09', 20000)];
    const paid = pay('u', 'Rent', 75000, '2026-09-05');
    T.check('a refunded rent receipt takes its credit back', total(F.settledFromRent(base, [{ ...paid, refundedAmount: 75000, refundedOn: '2026-09-30' }])) === 0);
    T.check('a partly refunded receipt takes back its share (60,000 left: 16,000)', total(F.settledFromRent(base, [{ ...paid, refundedAmount: 15000, refundedOn: '2026-09-30' }])) === 1600000, String(total(F.settledFromRent(base, [{ ...paid, refundedAmount: 15000, refundedOn: '2026-09-30' }])) / 100));
    T.check('a voided (reversed) receipt gives no credit', F.settledFromRent(base, [{ ...paid, status: 'reversed' }]).length === 0);
    T.check('a pending (not yet received) receipt gives no credit', F.settledFromRent(base, [{ ...paid, status: 'pending' }]).length === 0);
    T.check('a voided rent charge gives no credit', F.settledFromRent([{ ...base[0], status: 'void' }, base[1]], [paid]).length === 0);
    T.check('a voided maintenance charge: nothing to settle', F.settledFromRent([base[0], { ...base[1], status: 'void' }], [paid]).length === 0);
    T.check('rent paid in USD does not settle a JMD maintenance account', F.settledFromRent(base, [{ ...paid, currency: 'USD' }]).length === 0);
    T.check('another villa\'s rent never settles this one', F.settledFromRent(base, [{ ...paid, unitId: 'other' }]).length === 0);
    T.check('a legacy charge with no split gives no credit', F.settledFromRent([rentCharge('u', '2026-09', 75000, 0, { rentPortion: undefined, maintenancePortion: undefined }), base[1]], [paid]).length === 0);
    T.check('a late fee is paid before it can help: 5,000 of 80,000 to a 75,000 charge leaves 70,000 for rent first', total(F.settledFromRent([rentCharge('u', '2026-08', 5000, 0, { kind: 'one-off' }), ...base], [pay('u', 'Rent', 5000, '2026-09-05')])) === 0);
    T.check('hostile amounts (NaN, negative, huge) neither throw nor create credit', (() => {
      try {
        const r = F.settledFromRent(base, [{ ...paid, amount: NaN }, { ...paid, id: 'x2', amount: -5000 }, { ...paid, id: 'x3', amount: 1e15 }]);
        return r.every(p => Number.isFinite(p.amount) && p.amount > 0 && p.amount <= 20000);
      } catch { return false; }
    })());
    T.check('empty and mismatched inputs are safe', F.settledFromRent([], []).length === 0 && F.settledFromRent(base, []).length === 0 && F.settledFromRent([], [paid]).length === 0);
    // a hand-entered maintenance receipt for the full amount plus the rent: the credit yields to it
    const manual = pay('u', 'Maintenance', 20000, '2026-09-06');
    const dd = F.settledFromRent(base, [paid, manual]);
    T.check('with the maintenance already receipted by hand, nothing more is credited', total(dd) === 0);
    // consolidation: derived credit on a funded villa disappears from the combined view, stays in the strata book
    const all = [paid, ...F.settledFromRent(base, [paid])];
    const merged = F.consolidateEverything(base, all);
    T.check('combined view drops the derived maintenance credit (it is a transfer between books)', !merged.payments.some(p => p.derived));
    T.check('strata book keeps it as maintenance received: 20,000', F.collectedInPeriod(F.paymentsInBook(all, 'strata'), 'JMD', '2026-09-01', '2026-09-30').maintenance === 20000);
    T.check('ISPO book does not see it', F.collectedInPeriod(F.paymentsInBook(all, 'ispo'), 'JMD', '2026-09-01', '2026-09-30').maintenance === 0);
  }

  /* ================= 4. through the real server ================= */
  const srv = await startServer({ port, adminPassword: 'Settled-1234!', projectRoot });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Settled-1234!', 'SettledNew-9876!');
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000, tenantName: 'Tenant One' });
    for (const m of ['2026-08', '2026-09', '2026-10']) await c.post('/api/charges/post-month', { monthString: m });
    await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Rent', amount: 150000, currency: 'JMD', payerName: 'Tenant One', method: 'Cash', date: '2026-10-02' });
    const db = (await c.get('/api/db')).body;
    const d = F.settledFromRent(db.charges, db.payments);
    const unit = db.units.find(x => x.id === 'unit-1');
    const rentBal = F.accountBalance(unit, 'Rent', db.charges, db.payments, '2026-10-31', db.units).balance;
    const mBal = F.accountBalance(unit, 'Maintenance', db.charges, [...db.payments, ...d], '2026-10-31', db.units).balance;
    T.check('real data: 150,000 paid on 3 x 75,000 leaves rent 75,000 owing', rentBal === 75000, String(rentBal));
    T.check('and maintenance 40,000 settled, 20,000 owing (the third month)', total(d) === 4000000 && mBal === 20000, `${total(d) / 100} / ${mBal}`);
    T.check('the server stored no derived receipt', !db.payments.some(p => p.derived || /^from-rent/.test(p.id)));
    T.check('the server still sees the maintenance account as 60,000 (it knows nothing of the credit)', F.accountBalance(unit, 'Maintenance', db.charges, db.payments, '2026-10-31', db.units).balance === 60000);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
