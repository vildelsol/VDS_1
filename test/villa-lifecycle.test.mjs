/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A villa's whole life, as a state machine (Ro, 2026-11-12: "the entire
 * application needs to be looked at as a whole state machine, an ecosystem").
 *
 * A villa has three things that change independently and interact:
 *   - what it is for: long-term, short-term, owner-occupied, unavailable
 *   - who lives in it: a tenancy, opened and closed
 *   - who owns it: an ownership, closed by a sale and reopened under a new name
 *
 * Rather than test the transitions somebody happened to think of, this walks a
 * villa through every state, sells it mid-life, re-lets it, and after EVERY SINGLE
 * transition recomputes the same set of ecosystem invariants from the raw ledger.
 * A transition is only correct if the whole property is still coherent after it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = "A villa's whole life, checked after every transition";

const C = n => Math.round((Number(n) || 0) * 100);

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-life-'));
  const outfile = path.join(outdir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-life-db-'));
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Life-1234!', projectRoot, dataDir });
  const breaches = [];

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Life-1234!', 'LifeNew-9876!');

    /**
     * The ecosystem invariants. Every one is recomputed from the raw ledger, and
     * every one must hold after every transition, not just at the end.
     */
    const check = async label => {
      const db = (await c.get('/api/db')).body;
      const derived = F.settledFromRent(db.charges, db.payments);
      const bad = [];
      const say = m => bad.push(`${label}: ${m}`);

      for (const u of db.units) {
        const ten = db.tenancies.filter(t => t.unitId === u.id);
        const own = (db.ownerships || []).filter(o => o.unitId === u.id);
        if (ten.filter(t => t.status === 'active').length > 1) say(`${u.number} has two tenants at once`);
        if (own.filter(o => o.status === 'active').length > 1) say(`${u.number} has two proprietors at once`);
        if (u.status !== 'long-term' && ten.some(t => t.status === 'active')) say(`${u.number} is ${u.status} but still has a sitting tenant`);

        // Rent is only ever billed to a villa that is let.
        for (const ch of db.charges.filter(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'open' && x.kind === undefined)) {
          const during = ten.some(t => ch.periodMonth >= t.startedOn.slice(0, 7) && (!t.endedOn || ch.periodMonth <= t.endedOn.slice(0, 7)));
          if (!during) say(`${u.number} is billed rent for ${ch.periodMonth} with no tenancy covering it`);
        }

        // A sale leaves the seller's debt with the seller.
        const sold = own.filter(o => o.status === 'ended' && o.endedOn);
        for (const prior of sold) {
          for (const ch of db.charges.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'open')) {
            const beforeSale = ch.periodMonth < prior.endedOn.slice(0, 7);
            if (beforeSale && ch.payerName && ch.payerName === u.ownerName && u.ownerName !== prior.ownerName) {
              say(`${u.number}: ${ch.periodMonth} levy from before the sale was moved onto the new proprietor`);
            }
          }
          // And the new proprietor's levy is never settled out of the old tenant's money.
          const after = db.charges.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'open' && x.periodMonth >= prior.endedOn.slice(0, 7));
          const afterOwed = after.reduce((a, x) => a + C(x.amount), 0);
          const rentMonths = new Set(db.charges.filter(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'open').map(x => x.periodMonth));
          const creditedAfter = after.filter(x => !rentMonths.has(x.periodMonth)).reduce((a, x) => a + C(x.amount), 0);
          if (afterOwed > 0 && creditedAfter > 0) {
            // Any month with a levy but no rent charge must still be fully owed.
            const credit = derived.filter(d => d.unitId === u.id).reduce((a, d) => a + C(d.amount), 0);
            const fundable = db.charges.filter(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'open').reduce((a, x) => a + C(x.maintenancePortion || 0), 0);
            if (credit > fundable) say(`${u.number}: ${credit} settled from rent against only ${fundable} of levy inside the rent`);
          }
        }

        for (const cur of ['JMD', 'USD']) {
          const charged = db.charges.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'open' && x.currency === cur).reduce((a, x) => a + C(x.amount), 0);
          const cash = db.payments.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'completed' && x.currency === cur).reduce((a, x) => a + C(x.amount) - C(x.refundedAmount || 0), 0);
          const cred = derived.filter(x => x.unitId === u.id && x.currency === cur).reduce((a, x) => a + C(x.amount), 0);
          if (cash <= charged && cash + cred > charged) say(`${u.number} ${cur}: levy settled ${cash + cred} beyond ${charged} charged`);
          const rentIn = db.payments.filter(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'completed' && x.currency === cur).reduce((a, x) => a + C(x.amount) - C(x.refundedAmount || 0), 0);
          if (cred > rentIn) say(`${u.number} ${cur}: ${cred} settled from rent that never arrived`);
        }
      }

      // Nothing a tenant reads ever mentions maintenance.
      for (const p of db.payments) {
        if (/maintenance/i.test(`${p.notes || ''} ${p.reference || ''}`) && p.category === 'Rent') say(`receipt ${p.receiptNo} would print the word maintenance to a tenant`);
      }
      // Derived credits are never stored.
      if (db.payments.some(p => p.derived)) say('a derived credit was written to the database');
      // Both corrections are always idempotent, at every point in the villa's life.
      if ((await c.post('/api/charges/restate-rent', { confirm: true })).body.restated > 0) say('restate-rent was not settled');
      const mv = (await c.post('/api/payments/restate-maintenance-receipts', { confirm: true })).body;
      if (mv.moved > 0) say(`the receipt move was not settled: ${JSON.stringify(mv.plan)}`);
      if ((await c.get('/api/integrity')).status !== 200) say('the integrity check failed');

      breaches.push(...bad);
      return bad.length === 0;
    };

    /*
     * Every one of these must actually happen. An earlier draft pinned the
     * villa's life to months that turned out to be in the FUTURE relative to the
     * clock: the application correctly refuses to post a future month or take a
     * payment dated ahead of today, so half the life silently did nothing while
     * the test still passed. Refusals are now failures.
     */
    const must = async (what, res) => { if (res.status >= 400) breaches.push(`${what} was refused: ${JSON.stringify(res.body).slice(0, 120)}`); return res; };
    const postMonth = m => must(`posting ${m}`, c.post('/api/charges/post-month', { monthString: m }));
    const put = (over) => c.put('/api/units/unit-1', {
      number: '1', ownerName: 'First Owner', tenantName: '', status: 'owner-occupied',
      monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 7, maintDueDay: 1, ...over
    });
    const pay = async (cat, amt, date, who) => must(`${who}'s ${cat} payment of ${amt} on ${date}`,
      await recordAndConfirmPayment(c, { unitId: 'unit-1', category: cat, amount: amt, currency: 'JMD', payerName: who, method: 'Cash', date }));

    /* ---- the life, one transition at a time ---- */
    const steps = [];
    const step = async (what, fn) => { await fn(); steps.push(what); T.check(`${what} — the property is still coherent`, await check(what)); };

    await step('a villa is on the books, owner-occupied', async () => {
      await put({});
      await postMonth('2026-01');
      await pay('Maintenance', 20000, '2026-01-02', 'First Owner');
    });

    await step('it is let: the tenant is billed one rent figure', async () => {
      await put({ status: 'long-term', tenantName: 'First Tenant', monthlyRent: 100000, tenantChangeIntent: 'changeover' });
      await postMonth('2026-02');
    });

    await step("the tenant pays, and the levy settles itself out of the rent", async () => {
      await pay('Rent', 100000, '2026-02-07', 'First Tenant');
      const db = (await c.get('/api/db')).body;
      const cred = F.settledFromRent(db.charges, db.payments);
      if (cred.reduce((a, x) => a + C(x.amount), 0) !== C(20000)) breaches.push('July levy was not settled from the rent');
    });

    await step('the tenant leaves owing a month, and the villa goes back to its owner', async () => {
      await postMonth('2026-03');
      await put({ status: 'owner-occupied', tenantName: '', tenantChangeIntent: 'moved-out' });
    });

    await step('the owner pays the levy themselves again', async () => {
      await postMonth('2026-04');
      await pay('Maintenance', 20000, '2026-04-02', 'First Owner');
    });

    await step('it is put up for short stays', async () => {
      await put({ status: 'short-term', monthlyRent: 0 });
      await postMonth('2026-05');
    });

    await step('IT IS SOLD, and the new proprietor takes it over', async () => {
      await put({ status: 'owner-occupied', ownerName: 'Second Owner', ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-06-01' });
      await postMonth('2026-06');
    });

    await step("the OLD tenant finally pays their arrears, long after the sale", async () => {
      await pay('Rent', 100000, '2026-06-20', 'First Tenant');
      const db = (await c.get('/api/db')).body;
      const nov = db.charges.find(x => x.category === 'Maintenance' && x.periodMonth === '2026-06' && x.status === 'open');
      const cred = F.settledFromRent(db.charges, db.payments);
      const after = cred.filter(x => x.date >= '2026-06-01').reduce((a, x) => a + C(x.amount), 0);
      // August's rent was owed; its levy is August's, and may settle. November's
      // levy belongs to the new proprietor and must not be touched by this money.
      const novOwed = F.accountBalance(db.units.find(u => u.id === 'unit-1'), 'Maintenance', db.charges, db.payments.concat(cred), '2026-07-31', db.units);
      if (nov && novOwed.balance < 20000) breaches.push(`the new proprietor's November levy was settled out of the old tenant's rent (balance ${novOwed.balance})`);
      if (after > C(20000)) breaches.push(`too much was settled from one month's arrears: ${after}`);
    });

    await step('it is let again, to a new tenant, under the new proprietor', async () => {
      await put({ status: 'long-term', tenantName: 'Second Tenant', ownerName: 'Second Owner', monthlyRent: 100000, tenantChangeIntent: 'changeover' });
      await postMonth('2026-07');
      await pay('Rent', 100000, '2026-07-07', 'Second Tenant');
    });

    await step('and taken off the market altogether', async () => {
      await put({ status: 'unavailable', tenantName: '', ownerName: 'Second Owner', tenantChangeIntent: 'moved-out' });
    });

    T.check(`the villa was walked through ${steps.length} transitions of its life`, steps.length === 10, String(steps.length));
    T.check('no invariant was breached at any point in that life', breaches.length === 0, breaches.slice(0, 4).join(' | '));

    /* ---- the thing the sale rules exist to protect ---- */
    const db = (await c.get('/api/db')).body;
    const own = (db.ownerships || []).filter(o => o.unitId === 'unit-1');
    T.check('the sale closed one ownership and opened another', own.filter(o => o.status === 'ended').length === 1 && own.filter(o => o.status === 'active').length === 1, JSON.stringify(own.map(o => [o.ownerName, o.status])));
    const preSale = db.charges.filter(x => x.unitId === 'unit-1' && x.category === 'Maintenance' && x.periodMonth < '2026-06' && x.status === 'open');
    T.check("every levy from before the sale still stands in the seller's name, not the buyer's",
      preSale.every(x => x.payerName !== 'Second Owner'), JSON.stringify(preSale.map(x => [x.periodMonth, x.payerName])));
    const hist = db.tenancies.filter(t => t.unitId === 'unit-1');
    T.check('every tenancy in the villa\'s history is closed, and none is left open behind the next',
      hist.length === 2 && hist.every(t => t.status === 'ended' && t.endedOn), JSON.stringify(hist.map(t => [t.tenantName, t.status, t.endedOn || '-'])));
    /*
     * A tenancy opened by a bare status change carries no move-in date on purpose,
     * and Ro's ruling (2026-11-12) is that the date is an administrative field
     * which must not change what the system does. So the receipt move reads the
     * villa's own rent history instead and works regardless.
     */
    await put({ status: 'long-term', tenantName: 'Third Tenant', ownerName: 'Second Owner', monthlyRent: 100000, tenantChangeIntent: 'changeover' });
    await postMonth('2026-08');
    await pay('Rent', 80000, '2026-08-07', 'Third Tenant');
    await pay('Maintenance', 20000, '2026-08-07', 'Third Tenant');
    const undated = (await c.post('/api/payments/restate-maintenance-receipts', {})).body;
    const live = (await c.get('/api/db')).body.tenancies.find(t => t.status === 'active');
    T.check('that tenancy really does have no move-in date, as the register intends', live && !live.startedOn, JSON.stringify(live && live.startedOn));
    T.check('and the receipt move still works, taking the new tenant\'s levy out of their rent',
      undated.count === 1 && undated.plan[0].payer === 'Third Tenant', JSON.stringify(undated).slice(0, 240));
    T.check("while the earlier proprietors' own levy payments stay where they are",
      !undated.plan.some(x => /Owner/.test(x.payer || '')), JSON.stringify(undated.plan));
    /* ---- the warning that the missing date is costing a safeguard ---- */
    const live2 = (await c.get('/api/db')).body;
    const warned = F.tenanciesMissingMoveInDate(live2.units, live2.tenancies);
    T.check('a sitting tenant with no move-in date is reported, because that silently disables the unbilled-months alarm',
      warned.length === 1 && warned[0].unit.id === 'unit-1', JSON.stringify(warned.map(w => [w.unit.number, w.tenancy.tenantName])));
    T.check('and the alarm really is off for that villa, which is why the warning has to exist',
      F.unbilledOccupancy(live2.units, live2.tenancies, live2.charges, '2026-09-30').every(r => r.unit.id !== 'unit-1'));
    const dated = live2.tenancies.map(t => (t.status === 'active' ? { ...t, startedOn: '2026-08-01' } : t));
    T.check('once a date is set the warning clears', F.tenanciesMissingMoveInDate(live2.units, dated).length === 0);
    T.check('a villa that is not let is never warned about', F.tenanciesMissingMoveInDate(live2.units.map(u => ({ ...u, status: 'owner-occupied' })), live2.tenancies).length === 0);
    T.check('server healthy at the end of the villa\'s life', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('the villa lived its whole life without an unhandled error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
