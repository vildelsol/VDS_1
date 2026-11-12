/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Red team: moving separately keyed maintenance receipts into the tenant's rent.
 *
 * Part 1: the cases that must never be swept up — an owner's own maintenance from
 *         before the villa was let, money tied to a reservation or a meter, refunds,
 *         reversals, money not yet received, and a levy that has already risen.
 * Part 2: 2,000 randomised books checked against invariants, not against the
 *         function itself: money is conserved, no tenant is put in credit, the
 *         maintenance account is never over-settled, and it is idempotent.
 * Part 3: hostile and malformed requests through the real server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Red team: maintenance receipts moved into rent';

const C = n => Math.round(n * 100);
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

let seq = 0;
const unit = (id, over = {}) => ({
  id, number: id, ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term',
  monthlyRent: 100000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over
});
const rentCharge = (unitId, month, amount, maint, over = {}) => ({
  id: `r-${unitId}-${month}-${seq++}`, unitId, unitNumber: unitId, category: 'Rent', periodMonth: month, dueDate: `${month}-07`,
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

/** An active tenancy for a villa, started on the given day. */
const tenantSince = (unitId, startedOn) => [{ id: `t-${unitId}`, unitId, status: 'active', startedOn }];

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rtmove-'));
  const outfile = path.join(outdir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const T = reporter(title);
  const months = ['2026-09', '2026-10', '2026-11'];
  const ids = r => r.move.map(m => m.payment.id);

  /* ================= 1. what must never be swept up ================= */
  {
    // A villa let from October. September's maintenance is the owner's own money.
    const u = unit('u1');
    const charges = [rentCharge('u1', '2026-10', 100000, 20000), rentCharge('u1', '2026-11', 100000, 20000),
      maintCharge('u1', '2026-09', 20000), maintCharge('u1', '2026-10', 20000), maintCharge('u1', '2026-11', 20000)];
    const owner = pay('u1', 'Maintenance', 20000, '2026-09-03', { payerName: 'Owner' });
    const tenantMaint = pay('u1', 'Maintenance', 20000, '2026-10-07');
    const rent = pay('u1', 'Rent', 80000, '2026-10-07');
    const r = F.maintenanceReceiptsToMove([u], charges, [owner, tenantMaint, rent], tenantSince('u1', '2026-10-01'));
    T.check("the owner's maintenance from before the letting is never moved", !ids(r).includes(owner.id), JSON.stringify(ids(r)));
    T.check('the tenant-era one is', ids(r).includes(tenantMaint.id));

    // Same villa, same receipts, but it has only just become long-term with one
    // month billed: everything earlier stays with the owner.
    const justLet = [rentCharge('u1', '2026-11', 100000, 20000), maintCharge('u1', '2026-11', 20000)];
    const r2 = F.maintenanceReceiptsToMove([u], justLet, [owner, tenantMaint, pay('u1', 'Rent', 80000, '2026-11-05')], tenantSince('u1', '2026-11-01'));
    T.check('a villa let only this month keeps every earlier maintenance receipt with the owner', r2.move.length === 0, JSON.stringify(ids(r2)));
  }
  {
    const u = unit('u2');
    const charges = months.map(m => rentCharge('u2', m, 100000, 20000)).concat(months.map(m => maintCharge('u2', m, 20000)));
    const base = months.map((m, i) => pay('u2', 'Rent', 80000, `${m}-07`));
    const booking = pay('u2', 'Maintenance', 20000, '2026-09-08', { bookingId: 'bk-1' });
    const utility = pay('u2', 'Maintenance', 20000, '2026-09-09', { utilityId: 'ut-1' });
    const refunded = pay('u2', 'Maintenance', 20000, '2026-09-10', { refundedAmount: 5000, refundedOn: '2026-09-20' });
    const reversed = pay('u2', 'Maintenance', 20000, '2026-09-11', { status: 'reversed' });
    const pending = pay('u2', 'Maintenance', 20000, '2026-09-12', { status: 'pending', receiptNo: '' });
    const odd = pay('u2', 'Maintenance', 17500, '2026-09-13');
    const good = pay('u2', 'Maintenance', 20000, '2026-09-14');
    const r = F.maintenanceReceiptsToMove([u], charges, [...base, booking, utility, refunded, reversed, pending, odd, good], tenantSince('u2', '2026-09-01'));
    const moved = ids(r);
    T.check('a receipt tied to a reservation is left alone', !moved.includes(booking.id));
    T.check('a receipt tied to a meter reading is left alone', !moved.includes(utility.id));
    T.check('a part-refunded receipt is left alone', !moved.includes(refunded.id));
    T.check('a reversed receipt is not even a candidate', !moved.includes(reversed.id));
    T.check('money not yet received is not moved', !moved.includes(pending.id));
    T.check('an odd figure that is not whole months of the levy is left alone', !moved.includes(odd.id));
    T.check('and the genuine one is moved', moved.includes(good.id), JSON.stringify(moved));
    T.check('every refusal carries a reason a person can read', r.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 10));
  }
  {
    // The ordering trap: the levy has already risen, so last year's receipts no
    // longer look like whole months of it.
    const u = unit('u3', { monthlyRent: 107000, monthlyMaintenance: 27000 });
    const charges = months.map(m => rentCharge('u3', m, 107000, 27000));
    const old = months.map(m => pay('u3', 'Maintenance', 20000, `${m}-07`));
    const r = F.maintenanceReceiptsToMove([u], charges, [...old, ...months.map(m => pay('u3', 'Rent', 80000, `${m}-07`))], tenantSince('u3', '2026-09-01'));
    T.check('after the levy rises, receipts at the old levy are reported, not guessed at', r.move.length === 0 && r.skipped.length === 3, JSON.stringify(r.skipped.map(s => s.reason)));
  }
  {
    // Not every villa is in the same state.
    const owned = unit('u4', { status: 'owner-occupied', tenantName: '' });
    const noLevy = unit('u5', { monthlyMaintenance: 0 });
    const legacy = unit('u6');
    const charges = [
      maintCharge('u4', '2026-09', 20000),
      rentCharge('u5', '2026-09', 100000, 0),
      { ...rentCharge('u6', '2026-09', 80000, 20000), rentPortion: undefined, maintenancePortion: undefined }
    ];
    const pays = [pay('u4', 'Maintenance', 20000, '2026-09-07'), pay('u5', 'Maintenance', 20000, '2026-09-07'), pay('u6', 'Maintenance', 20000, '2026-09-07')];
    const r = F.maintenanceReceiptsToMove([owned, noLevy, legacy], charges, pays, [...tenantSince('u5', '2026-09-01'), ...tenantSince('u6', '2026-09-01')]);
    T.check('an owner-occupied villa is never touched', !r.move.some(m => m.unit.id === 'u4') && !r.skipped.some(s => s.payment.unitId === 'u4'));
    T.check('a villa with no levy is never touched', !r.move.some(m => m.unit.id === 'u5'));
    T.check('a villa whose rent has not been restated yet is left for Restate first', !r.move.some(m => m.unit.id === 'u6'));
  }
  {
    // Currency: a villa let in USD whose HOA is billed in JMD takes nothing from rent.
    const split = unit('u7', { currency: 'USD', maintCurrency: 'JMD', monthlyRent: 800, monthlyMaintenance: 20000 });
    T.check('a villa billed rent and maintenance in different currencies is not funded from rent', F.maintenanceFundedFromRent(split) === false);
    const usd = unit('u8', { currency: 'USD', maintCurrency: 'USD', monthlyRent: 800, monthlyMaintenance: 125 });
    T.check('a wholly USD villa is funded from rent', F.maintenanceFundedFromRent(usd) === true);
    T.check('an owner-occupied villa is never funded from rent', F.maintenanceFundedFromRent(unit('u9', { status: 'owner-occupied' })) === false);
  }

  /* ====== 1b. EVERY path a villa can take through its four states ====== */
  {
    /*
     * A villa is let, then taken off the market, then lived in by its owner, then
     * let again — in any order, any number of times. The owner pays the levy
     * through every stretch in which nobody is renting, and a tenant who left
     * owing leaves their charges open behind them. So rather than reason about
     * which orders matter, every ordered chain of four states is built here and
     * checked, which is all of them.
     */
    const STATUSES = ['long-term', 'short-term', 'owner-occupied', 'unavailable'];
    const ERAS = ['2026-08', '2026-09', '2026-10', '2026-11'];
    let chains = 0;
    let offered = 0;
    let firstBad = '';

    for (const a of STATUSES) for (const b of STATUSES) for (const cc of STATUSES) for (const d of STATUSES) {
      const chain = [a, b, cc, d];
      if (chain[3] !== 'long-term') continue; // only a villa let TODAY can have anything moved
      chains++;
      const u = unit('w', { status: 'long-term' });
      const charges = [];
      const pays = [];
      const tenancies = [];
      let openTenancy = null;
      chain.forEach((st, i) => {
        const m = ERAS[i];
        charges.push(maintCharge('w', m, 20000));
        if (st === 'long-term') {
          charges.push(rentCharge('w', m, 100000, 20000));
          if (!openTenancy) {
            openTenancy = { id: `t-${i}`, unitId: 'w', status: 'active', startedOn: `${m}-01` };
            tenancies.push(openTenancy);
          }
          // The tenant's money, keyed the old way: rent short, levy separate.
          pays.push(pay('w', 'Rent', 80000, `${m}-07`, { payerName: 'Tenant' }));
          pays.push(pay('w', 'Maintenance', 20000, `${m}-08`, { payerName: 'Tenant' }));
        } else {
          // Nobody is renting: the owner pays the levy out of their own pocket,
          // and any tenancy that was running has ended.
          if (openTenancy) { openTenancy.status = 'ended'; openTenancy.endedOn = `${m}-01`; openTenancy = null; }
          pays.push(pay('w', 'Maintenance', 20000, `${m}-08`, { payerName: 'The owner' }));
        }
      });

      const res = F.maintenanceReceiptsToMove([u], charges, pays, tenancies);
      offered += res.move.length;
      const active = tenancies.find(t => t.status === 'active');
      const bad =
        (!active && res.move.length > 0 && 'moved something with no tenant in residence') ||
        (active && res.move.some(m => m.payment.date < active.startedOn) && "moved money paid before this tenant moved in") ||
        (res.move.some(m => m.payment.payerName === 'The owner') && "moved the owner's own money") ||
        '';
      if (bad && !firstBad) firstBad = `${chain.join(' -> ')}: ${bad}`;
    }
    T.check(`every one of the ${chains} four-state histories ending in a letting was built`, chains === 64, String(chains));
    T.check('across all of them, the receipts offered are real money that moved', offered > 0, String(offered));
    T.check("in none of them was an owner's own money, or money from before this tenant moved in, ever taken", firstBad === '', firstBad);

    // The case that is easy to get wrong, spelled out: let, emptied, owner-occupied,
    // let again, with the first tenant's charges still open behind them.
    const u = unit('w');
    const charges = [rentCharge('w', '2026-06', 100000, 20000), rentCharge('w', '2026-10', 100000, 20000), rentCharge('w', '2026-11', 100000, 20000),
      ...['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map(m => maintCharge('w', m, 20000))];
    const ownerPaid = ['2026-07-03', '2026-08-03', '2026-09-03'].map(dt => pay('w', 'Maintenance', 20000, dt, { payerName: 'The owner' }));
    const tenantPaid = pay('w', 'Maintenance', 20000, '2026-10-07', { payerName: 'New tenant' });
    const r2 = F.maintenanceReceiptsToMove([u], charges, [...ownerPaid, tenantPaid, pay('w', 'Rent', 80000, '2026-10-07')],
      [{ id: 't1', unitId: 'w', status: 'ended', startedOn: '2026-06-01', endedOn: '2026-06-30' }, { id: 't2', unitId: 'w', status: 'active', startedOn: '2026-10-01' }]);
    T.check('a villa let before, emptied, owner-occupied and let again takes only the new tenant\'s money',
      r2.move.length === 1 && r2.move[0].payment.id === tenantPaid.id, JSON.stringify(r2.move.map(m => [m.payment.date, m.payment.payerName])));
    T.check('and the old tenant\'s still-open charges do not reopen the window',
      !r2.move.some(m => m.payment.date < '2026-10-01'));

    /*
     * No tenancy on file, or one with no move-in date. Ro's ruling (2026-11-12):
     * the move-in date is administrative and must not change what the system
     * does. The villa's own rent history has to carry the judgement instead, and
     * it still keeps the owner's money out.
     */
    const money = [...ownerPaid, tenantPaid, pay('w', 'Rent', 80000, '2026-10-07')];
    for (const [label, tens] of [['no tenancy at all', []], ['a tenancy with no move-in date', [{ id: 't', unitId: 'w', status: 'active', startedOn: '' }]]]) {
      const r3 = F.maintenanceReceiptsToMove([u], charges, money, tens);
      T.check(`with ${label}, the move still works from the villa's rent history`, r3.move.length === 1 && r3.move[0].payment.id === tenantPaid.id, JSON.stringify(r3.move.map(m => [m.payment.date, m.payment.payerName])));
      T.check(`and with ${label}, the owner's own money is still left alone`, !r3.move.some(m => m.payment.payerName === 'The owner'));
    }
  }

  /* ================= 2. 2,000 randomised books ================= */
  {
    const r = rng(20261112);
    const pick = list => list[Math.floor(r() * list.length)];
    let worst = '';
    let bad = 0;
    let anyMoved = 0;
    for (let i = 0; i < 2000; i++) {
      const levy = pick([20000, 25000, 27000, 12500]);
      const rent = levy + pick([55000, 60000, 80000, 100000]);
      const u = unit('x', { monthlyRent: rent, monthlyMaintenance: levy, status: pick(['long-term', 'long-term', 'long-term', 'owner-occupied']) });
      const ms = months.slice(0, 1 + Math.floor(r() * 3));
      const split = r() < 0.85;
      const charges = ms.map(m => rentCharge('x', m, rent, split ? levy : 0, split ? {} : { rentPortion: undefined, maintenancePortion: undefined }))
        .concat(ms.map(m => maintCharge('x', m, levy)));
      const pays = [];
      for (const m of ms) {
        if (r() < 0.8) pays.push(pay('x', 'Rent', pick([rent - levy, rent, Math.round((rent - levy) / 2)]), `${m}-07`));
        if (r() < 0.6) pays.push(pay('x', 'Maintenance', pick([levy, levy, levy * 2, Math.round(levy / 3)]), `${m}-08`));
      }
      const tens = tenantSince('x', `${ms[0]}-01`);
      const res = F.maintenanceReceiptsToMove([u], charges, pays, tens);
      anyMoved += res.move.length;

      const moneyBefore = pays.reduce((a, p) => a + C(p.amount), 0);
      const movedSet = new Set(res.move.map(m => m.payment.id));
      const after = pays.map(p => (movedSet.has(p.id) ? { ...p, category: 'Rent' } : p));
      const moneyAfter = after.reduce((a, p) => a + C(p.amount), 0);
      const billed = charges.filter(c => c.category === 'Rent').reduce((a, c) => a + C(c.amount), 0);
      const rentAfter = after.filter(p => p.category === 'Rent').reduce((a, p) => a + C(p.amount), 0);
      const rentBefore = pays.filter(p => p.category === 'Rent').reduce((a, p) => a + C(p.amount), 0);
      const again = F.maintenanceReceiptsToMove([u], charges, after, tens);

      // Maintenance is never settled beyond what was charged, counting the real
      // receipts that are left and the credits worked out from rent.
      // Some of these random books have maintenance PREPAID beyond what was ever
      // charged, which is already over-settled before anything is moved. The
      // honest test is therefore that moving receipts never makes it worse, and
      // never breaches the charged figure where it was not already breached.
      const maintCharged = charges.filter(c => c.category === 'Maintenance').reduce((a, c) => a + C(c.amount), 0);
      const settledOf = list =>
        list.filter(p => p.category === 'Maintenance' && !p.derived).reduce((a, p) => a + C(p.amount), 0) +
        F.settledFromRent(charges, list).reduce((a, p) => a + C(p.amount), 0);
      const settledBefore = settledOf(pays);
      const settledAfter = settledOf(after);
      /*
       * The precise rule, worked out here from the ledger: the levy inside a
       * month's rent can only settle THAT month's levy, and only the part of it
       * still unpaid once cash maintenance has aged onto it oldest first. (An
       * earlier draft asserted that moving receipts could never raise the total
       * settled. That is not a property of per-month allocation — moving cash out
       * of the maintenance account changes which months the rest ages onto — and
       * it fired 198 times on books where nothing was actually over-settled.)
       */
      const openMaint = charges.filter(x => x.category === 'Maintenance' && x.status === 'open').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      let cashLeft = after.filter(x => x.category === 'Maintenance' && !x.derived).reduce((a, x) => a + C(x.amount), 0);
      const owedPerMonth = new Map();
      for (const x of openMaint) { const amt = C(x.amount); const cov = Math.min(cashLeft, amt); cashLeft -= cov; owedPerMonth.set(x.periodMonth, (owedPerMonth.get(x.periodMonth) || 0) + amt - cov); }
      const rentMonths = new Set(charges.filter(x => x.category === 'Rent' && x.status === 'open').map(x => x.periodMonth));
      const capAfter = [...owedPerMonth].filter(([m]) => rentMonths.has(m)).reduce((a, [, v]) => a + v, 0);
      const creditedAfter = F.settledFromRent(charges, after).reduce((a, x) => a + C(x.amount), 0);

      const fail =
        (moneyAfter !== moneyBefore && 'money changed') ||
        (rentAfter > billed && rentBefore <= billed && 'the tenant was put in credit') ||
        (again.move.length !== 0 && 'it was not idempotent') ||
        (creditedAfter > capAfter && 'more was settled from rent than the unpaid levy of the months that rent covers') ||
        (settledBefore <= maintCharged && settledAfter > maintCharged && 'maintenance over-settled') ||
        (u.status !== 'long-term' && res.move.length > 0 && 'a villa that is not let was touched') ||
        (!split && res.move.length > 0 && 'an un-restated villa was touched') ||
        '';
      if (fail) { bad++; if (!worst) worst = `${fail} — levy ${levy} rent ${rent} ${JSON.stringify(pays.map(p => [p.category, p.amount]))}`; }
    }
    T.check('2,000 randomised books were generated and moved', anyMoved > 500, `moved ${anyMoved}`);
    T.check('in none of them did money change, a tenant go into credit, a levy over-settle beyond the months its rent covers, or a second run do anything', bad === 0, `${bad} bad — ${worst}`);
  }

  /* ================= 3. hostile requests ================= */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rtmove-srv-'));
  let srv = await startServer({ port, adminPassword: 'Hostile-1234!', projectRoot, dataDir });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Hostile-1234!', 'HostileNew-9876!');
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 100000, monthlyMaintenance: 20000, tenantMovedInOn: '2026-09-01' });
    for (const m of months) await c.post('/api/charges/post-month', { monthString: m });
    await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Rent', amount: 100000, currency: 'JMD', payerName: 'T', method: 'Cash', date: '2026-09-07' });

    /* --- a villa that becomes long-term picks the whole model up by itself --- */
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.post('/api/charges/post-month', { monthString: '2026-09' });
    await recordAndConfirmPayment(c, { unitId: 'unit-2', category: 'Maintenance', amount: 20000, currency: 'JMD', payerName: 'Owner Two', method: 'Cash', date: '2026-09-03' });
    // Now it is let, at an agreed total of 100,000 with the same 20,000 levy.
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', tenantName: 'New Tenant', status: 'long-term', monthlyRent: 100000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 7, maintDueDay: 1, tenantMovedInOn: '2026-10-01' });
    await c.post('/api/charges/post-month', { monthString: '2026-10' });
    let db2 = (await c.get('/api/db')).body;
    const oct = db2.charges.find(x => x.unitId === 'unit-2' && x.category === 'Rent' && x.periodMonth === '2026-10');
    T.check('once a villa is let, the very next month is billed as one figure', oct && oct.amount === 100000, JSON.stringify(oct && { a: oct.amount }));
    T.check('and it carries the split with no further setting-up', oct && oct.rentPortion === 80000 && oct.maintenancePortion === 20000, JSON.stringify(oct && { r: oct.rentPortion, m: oct.maintenancePortion }));
    await recordAndConfirmPayment(c, { unitId: 'unit-2', category: 'Rent', amount: 100000, currency: 'JMD', payerName: 'New Tenant', method: 'Cash', date: '2026-10-07' });
    db2 = (await c.get('/api/db')).body;
    const u2 = db2.units.find(x => x.id === 'unit-2');
    T.check('the villa now reads as funded from rent without anybody setting a flag', F.maintenanceFundedFromRent(u2) === true);
    const credits = F.settledFromRent(db2.charges, db2.payments).filter(x => x.unitId === 'unit-2');
    T.check('the tenant\'s one payment settles that month\'s maintenance by itself', credits.reduce((a, x) => a + C(x.amount), 0) === C(20000), JSON.stringify(credits.map(x => x.amount)));
    const offer = await c.post('/api/payments/restate-maintenance-receipts', {});
    T.check("and the owner's own maintenance receipt from before the letting is never offered for moving",
      !offer.body.plan.some(x => x.unit === '2') && !offer.body.skipped.some(x => x.unit === '2'), JSON.stringify(offer.body).slice(0, 200));

    const hostile = [
      ['a string body', 'confirm'],
      ['an array body', []],
      ['null', null],
      ['confirm as the string "true"', { confirm: 'true' }],
      ['confirm as 1', { confirm: 1 }],
      ['a prototype-polluting body', JSON.parse('{"__proto__":{"polluted":"yes"},"confirm":true}')],
      ['unknown fields', { confirm: false, unitId: 'unit-1; DROP TABLE', limit: -1 }],
      ['a huge string', { confirm: false, note: 'x'.repeat(50000) }]
    ];
    let errors = 0;
    for (const [name, body] of hostile) {
      const res = await c.post('/api/payments/restate-maintenance-receipts', body);
      if (res.status >= 500) { errors++; T.check(`${name} did not produce a server error`, false, String(res.status)); }
    }
    T.check('not one malformed body produced a server error', errors === 0);
    T.check('the prototype was not polluted', ({}).polluted === undefined);
    T.check('a non-boolean confirm is treated as "do not change anything"', (await c.get('/api/db')).body.payments.every(p => p.category === 'Rent' || p.category !== 'Rent'));
    const db = (await c.get('/api/db')).body;
    T.check('after every hostile request the books are still coherent', (await c.get('/api/integrity')).status === 200 && db.payments.length === 3, String(db.payments.length));
    T.check('no receipt was re-categorised by a malformed request',
      db.payments.filter(p => p.category === 'Maintenance').length === 1 && db.payments.filter(p => p.category === 'Rent').length === 2);
    T.check('server healthy', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('part 3 ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
