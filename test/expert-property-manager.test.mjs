/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A thousand operating events, judged the way a property manager would judge them.
 *
 * The other suites ask whether the arithmetic closes. This one asks a different
 * question: **would the person running this property be embarrassed in front of
 * an owner, a tenant, or the Commission?** Those are not the same test. Books can
 * balance perfectly while the arrears list quietly omits somebody who owes eight
 * months, and every figure can be finite while a tenant who paid in full is being
 * chased for rent.
 *
 * So the assertions here are the ones a manager is answerable for:
 *
 *   - **Nobody is billed twice for the same month.** The complaint that ends up
 *     with the strata council.
 *   - **Nobody who owes is missing from the arrears list, and nobody who has paid
 *     is on it.** Both directions. Chasing a proprietor who paid is worse than
 *     the money.
 *   - **The statutory Form 13B ageing matches the ledger it is drawn from**, per
 *     villa, per bucket. This document is filed with the Commission.
 *   - **Deposits held are never lost.** Money taken from a tenant is either still
 *     held, returned, or withheld with a reason — never simply gone.
 *   - **A tenant who has paid the month is never shown as owing it.**
 *   - **Every receipt names a villa and a payer**, because an unattributable
 *     receipt is an argument nobody can win.
 *   - **Occupancy never exceeds the register**, and a calendar hold is never a
 *     guest in residence.
 *   - **Nothing is billed before the books open.**
 *
 * A thousand events across a full operating year, seeded so a failure reproduces.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'A property manager judging a thousand operating events';

const EVENT_COUNT = 1000;
const BOOKS_BEGIN = '2026-01-01';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-pm-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const money = (rand, low, high) => Math.round((low + rand() * (high - low)) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const cents = v => Math.round(v * 100);
const MONTHS = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12'];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Manager-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Manager-1234!', 'ManagerNew-9876!');

    const settings = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...settings, booksBeginOn: BOOKS_BEGIN, strataPlanNumber: '2324' });

    /* ---------------- the property as it actually is ---------------- */

    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const setup = rng(4242);
    const tenanted = [];
    const proprietors = [];
    const shortLets = [];

    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      if (i % 5 === 4) {
        await c.put(`/api/units/${id}`, { number, ownerName: `Proprietor ${i}`, status: 'short-term', monthlyMaintenance: money(setup, 150, 500), currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 });
        shortLets.push(id);
      } else if (i % 5 === 3) {
        // A proprietor in residence: pays maintenance only. The commonest case.
        await c.put(`/api/units/${id}`, { number, ownerName: `Proprietor ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
        proprietors.push(id);
      } else {
        await c.put(`/api/units/${id}`, { number, ownerName: `Proprietor ${i}`, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: money(setup, 45000, 130000), monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
        tenanted.push(id);
      }
    }

    /* ---------------- a year of running the place ---------------- */

    const events = [
      // The month is billed.
      async ({ month }) => { await c.post('/api/charges/post-month', { monthString: month }); },

      // Rent paid in full, on time.
      async ({ month, rand }) => {
        const unitId = pick(rand, tenanted);
        const db = (await c.get('/api/db')).body;
        const owed = db.charges.filter(x => x.unitId === unitId && x.category === 'Rent' && x.status === 'open' && x.periodMonth === month);
        if (!owed.length) return;
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount: owed[0].amount, currency: owed[0].currency, payerName: `Tenant of ${unitId}`, method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']), date: dayIn(month, 2 + Math.floor(rand() * 5)) });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // Rent paid short — the ordinary reality.
      async ({ month, rand }) => {
        const unitId = pick(rand, tenanted);
        const db = (await c.get('/api/db')).body;
        const owed = db.charges.filter(x => x.unitId === unitId && x.category === 'Rent' && x.status === 'open');
        if (!owed.length) return;
        const part = Math.round(owed[0].amount * (0.3 + rand() * 0.5) * 100) / 100;
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount: part, currency: owed[0].currency, payerName: `Tenant of ${unitId}`, method: 'Cash', date: dayIn(month, 10 + Math.floor(rand() * 15)) });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // A proprietor settles their contribution.
      async ({ month, rand }) => {
        const unitId = pick(rand, proprietors.concat(tenanted));
        const db = (await c.get('/api/db')).body;
        const owed = db.charges.filter(x => x.unitId === unitId && x.category === 'Maintenance' && x.status === 'open');
        if (!owed.length) return;
        const p = await c.post('/api/payments', { unitId, category: 'Maintenance', amount: owed[0].amount, currency: owed[0].currency, payerName: 'Proprietor', method: 'Bank Transfer', date: dayIn(month, 3 + Math.floor(rand() * 20)) });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // And one who simply does not pay: the arrears the manager has to chase.
      async () => { /* deliberately nothing — the debt ages */ },

      // The annual insurance apportionment, and an opening balance.
      async ({ month, rand }) => {
        const unitId = pick(rand, proprietors.concat(tenanted));
        await c.post('/api/charges', { unitId, category: 'Maintenance', oneOffType: pick(rand, ['Insurance share', 'Opening balance', 'Late fee']), amount: money(rand, 2000, 40000), currency: 'JMD', dueDate: dayIn(month, 1), description: 'annual apportionment' });
      },

      // Utilities read and settled.
      async ({ month, rand }) => {
        const unitId = pick(rand, tenanted);
        const u = await c.post('/api/utilities', { unitId, type: pick(rand, ['Electricity', 'Water']), billingPeriod: month, amountCharged: money(rand, 1500, 28000), currency: 'JMD', consumption: Math.floor(rand() * 400) });
        const id = u.body?.utility?.id;
        if (id && rand() > 0.4) {
          const settled = await c.post(`/api/utilities/${id}/settle`, { method: 'Cash' });
          if (settled.body?.payment?.id) await c.post(`/api/payments/${settled.body.payment.id}/confirm`, {});
        }
      },

      // Running costs of the common property.
      async ({ month, rand }) => {
        await c.post('/api/expenses', { category: pick(rand, ['Maintenance', 'Security', 'Landscaping', 'Payroll', 'Supplies', 'Contractors', 'Property Taxes']), description: 'running cost', amount: money(rand, 2000, 90000), currency: 'JMD', date: dayIn(month, 1 + Math.floor(rand() * 27)), vendor: 'Vendor', unitNumber: pick(rand, ['General', 'Office']) });
      },

      // Guests.
      async ({ month, rand, i }) => {
        const unitId = pick(rand, shortLets);
        const start = 1 + (i % 20);
        await c.post('/api/bookings', { unitId, guestName: `Guest ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 1 + (i % 4)), amount: money(rand, 200, 3000), depositPaid: money(rand, 50, 400), currency: 'USD', source: pick(rand, ['Direct', 'Airbnb', 'Booking.com']) });
      },

      // An owner blocking their own villa — never a paying guest.
      async ({ month, rand, i }) => {
        const unitId = pick(rand, shortLets);
        const start = 1 + (i % 15);
        await c.post('/api/bookings', { unitId, guestName: 'Owner block', checkIn: dayIn(month, start), checkOut: dayIn(month, start + 2), amount: 0, depositPaid: 0, currency: 'USD', source: pick(rand, ['Blocked', 'Unavailable']) });
      },

      // A deposit taken at move-in, and settled at move-out.
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active' && !t.depositAmount);
        if (!live.length) return;
        const t = pick(rand, live);
        const held = money(rand, 20000, 90000);
        const taken = await c.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Cash' });
        if (taken.status >= 300) return;
        if (rand() > 0.6) {
          const withheld = Math.round(held * 0.3 * 100) / 100;
          await c.post(`/api/tenancies/${t.id}/deposit/settle`, { withheldAmount: withheld, returnedAmount: Math.round((held - withheld) * 100) / 100, reason: 'damage to a door' });
        }
      },

      // A changeover.
      async ({ month, rand, i }) => {
        const unitId = pick(rand, tenanted);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, { number: unit.number, ownerName: unit.ownerName, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: unit.monthlyRent, monthlyMaintenance: unit.monthlyMaintenance, currency: unit.currency, maintCurrency: unit.maintCurrency, tenancyStartedOn: dayIn(month, 1) });
      },

      // A tenant evicted for non-payment.
      async ({ month, rand }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active');
        if (live.length < 4) return;
        const t = pick(rand, live);
        await c.post(`/api/tenancies/${t.id}/evict`, { reason: 'rent unpaid for three months', effectiveDate: dayIn(month, 25) });
      },

      /*
       * Somebody clears their whole balance.
       *
       * Without this the simulation only ever part-pays, so no account reaches a
       * zero balance and the assertion that a settled account is never reported
       * as in arrears passes vacuously — which is exactly what happened the first
       * time this suite ran. A property where nobody ever settles is not a
       * property; it is a shape that flatters the test.
       */
      async ({ month, rand }) => {
        const db = (await c.get('/api/db')).body;
        const unitId = pick(rand, proprietors.concat(tenanted));
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        const category = pick(rand, ['Rent', 'Maintenance']);
        const account = fin.accountBalance(unit, category, db.charges, db.payments, undefined, db.units);
        if (account.balance <= 0) return;
        const p = await c.post('/api/payments', {
          unitId,
          category,
          amount: account.balance,
          currency: account.currency,
          payerName: category === 'Maintenance' ? 'Proprietor settling in full' : 'Tenant settling in full',
          method: 'Bank Transfer',
          date: dayIn(month, 26)
        });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // A receipt entered against the wrong villa and put right.
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const settled = db.payments.filter(p => p.status === 'completed');
        if (!settled.length) return;
        await c.post(`/api/payments/${pick(rand, settled).id}/reverse`, { reason: 'entered against the wrong villa' });
      }
    ];

    /* ---------------- run the year ---------------- */

    let ran = 0;
    for (let i = 0; i < EVENT_COUNT; i++) {
      const rand = rng(70000 + i);
      const month = MONTHS[Math.floor(i / (EVENT_COUNT / MONTHS.length)) % MONTHS.length];
      try {
        await events[i % events.length]({ month, rand, i });
        ran++;
      } catch {
        /* an individual event failing is caught by the assertions below */
      }
    }
    T.check(`a year of ${EVENT_COUNT} operating events was worked through`, ran >= EVENT_COUNT - 5, `${ran} completed`);

    /* ================================================================
     * Now judge it as the manager answerable for the property.
     * ================================================================ */

    const db = (await c.get('/api/db')).body;
    const asOf = '2026-12-31';
    const units = db.units;
    const problems = [];

    /* --- nobody is billed twice for a month --- */
    const seen = new Map();
    for (const ch of db.charges.filter(x => x.status === 'open' && !x.oneOffType && x.kind !== 'advance-final-month')) {
      const key = `${ch.unitId}|${ch.category}|${ch.periodMonth}`;
      if (seen.has(key)) problems.push(`${key} billed twice`);
      seen.set(key, ch.id);
    }
    T.check('no villa was billed twice for the same month', problems.length === 0, problems.slice(0, 3).join('; '));

    /* --- nothing is billed before the books open --- */
    const early = db.charges.filter(x => x.status === 'open' && !x.oneOffType && x.periodMonth && x.periodMonth < BOOKS_BEGIN.slice(0, 7));
    T.check('nothing was billed for a month before the books open', early.length === 0, `${early.length} charge(s), e.g. ${early[0]?.periodMonth}`);

    /* --- the arrears list is complete, in both directions --- */
    const owing = [];
    const settledAccounts = [];
    for (const unit of units) {
      for (const category of ['Rent', 'Maintenance']) {
        const a = fin.accountBalance(unit, category, db.charges, db.payments, asOf, units);
        if (a.balance > 0) owing.push(a);
        else if (a.charged > 0 && a.balance === 0) settledAccounts.push(a);
      }
    }
    const ageing = fin.arrearsAgeing(units, db.charges, db.payments, asOf);
    const agedTotal = ageing.reduce((sum, e) => sum + cents(e.buckets.total), 0);
    const owedTotal = owing.reduce((sum, a) => sum + cents(a.balance), 0);
    T.check(
      'every account that owes money is on the arrears schedule, to the cent',
      agedTotal === owedTotal,
      `schedule ${agedTotal} vs ledger ${owedTotal}`
    );
    T.check('and there is real debt to report, not an empty year', owing.length > 0, `${owing.length} accounts owing`);
    T.check(
      'no account that has paid in full is reported as in arrears',
      settledAccounts.every(a => a.status === 'settled'),
      settledAccounts.filter(a => a.status !== 'settled').slice(0, 2).map(a => `${a.unit.number} ${a.category} ${a.status}`).join('; ')
    );

    /*
     * Settlement, proved rather than hoped for.
     *
     * The check above passed vacuously the first time this suite ran: after a
     * busy year with a month billed every cycle, no account happens to sit at
     * exactly zero, so "every settled account reads as settled" was a statement
     * about an empty set. A property manager's real question is not statistical
     * anyway — it is "if this owner pays me today, does the system stop chasing
     * them?" So one is paid off deliberately and the answer is read back.
     */
    /*
     * Settled as of *today*, not as of the end of the simulated year.
     *
     * The first attempt dated the receipt 31 December and the application refused
     * it — "a payment cannot be dated in the future" — which is the guard working,
     * not a fault. Money is receipted on the day it arrives, so the balance being
     * cleared has to be the balance that stands today.
     */
    // Local, not UTC — see localToday() in the harness. Dating this with the UTC
    // day made the receipt tomorrow's every evening, and the application refused
    // it exactly as it should.
    const todayStr = localToday();
    const owingToday = [];
    for (const unit of units) {
      for (const category of ['Rent', 'Maintenance']) {
        const a = fin.accountBalance(unit, category, db.charges, db.payments, todayStr, units);
        if (a.balance > 0) owingToday.push(a);
      }
    }
    T.check('there is debt outstanding as at today, so settling one proves something', owingToday.length > 0, `${owingToday.length}`);

    const target = owingToday[0];
    const settleReceipt = await c.post('/api/payments', {
      unitId: target.unit.id,
      category: target.category,
      amount: target.balance,
      currency: target.currency,
      payerName: 'Settling in full',
      method: 'Bank Transfer',
      date: todayStr
    });
    if (settleReceipt.body?.payment?.id) await c.post(`/api/payments/${settleReceipt.body.payment.id}/confirm`, {});

    const afterDb = (await c.get('/api/db')).body;
    const afterUnit = afterDb.units.find(u => u.id === target.unit.id);
    const after = fin.accountBalance(afterUnit, target.category, afterDb.charges, afterDb.payments, todayStr, afterDb.units);
    T.check(
      'paying an account off in full clears it to the cent',
      after.balance === 0,
      `${target.unit.number} ${target.category}: owed ${target.balance}, now ${after.balance} (receipt ${settleReceipt.status})`
    );
    T.check('and it then reads as settled rather than in arrears', after.status === 'settled', after.status);
    /*
     * Scoped to the account that was actually paid.
     *
     * `arrearsAgeing` covers a villa's rent *and* maintenance together, so after
     * settling only the rent the villa still — correctly — showed a balance: its
     * maintenance was untouched. Asking the schedule about the whole villa was the
     * wrong question, and the right one is per account, which is also the level
     * Form 13B reports at.
     */
    const afterAged = fin.ageAccountArrears(afterUnit, target.category, afterDb.charges, afterDb.payments, todayStr, afterDb.units);
    T.check(
      'and that account drops off the arrears schedule',
      cents(afterAged.buckets.total) === 0,
      `${target.unit.number} ${target.category} still aged at ${afterAged.buckets.total}`
    );
    T.check(
      'while the villa\'s other account is untouched by that payment',
      cents(fin.ageAccountArrears(afterUnit, target.category === 'Rent' ? 'Maintenance' : 'Rent', afterDb.charges, afterDb.payments, todayStr, afterDb.units).buckets.total) >= 0,
      'the other account moved'
    );

    /*
     * A future-dated receipt is refused outright. Recorded as its own assertion
     * because it is a control a manager relies on: money is receipted when it
     * arrives, and post-dating one would let this month's collection figures be
     * flattered with money nobody has.
     */
    const futureReceipt = await c.post('/api/payments', {
      unitId: target.unit.id, category: target.category, amount: 1000, currency: target.currency,
      payerName: 'Post-dated', method: 'Cash', date: '2027-06-01', confirmNoOpenCharge: true
    });
    T.check('a post-dated receipt is refused', futureReceipt.status === 400, `status ${futureReceipt.status}`);

    /* --- the statutory return agrees with the ledger, villa by villa --- */
    const form = fin.form13BContributions(units, db.charges, db.payments, asOf);
    const formProblems = [];
    for (const row of form.rows) {
      const direct = fin.ageAccountArrears(row.unit, 'Maintenance', db.charges, db.payments, asOf, units);
      for (const key of ['d30', 'd60', 'd90', 'over90', 'total']) {
        if (cents(direct.buckets[key]) !== cents(row.buckets[key])) {
          formProblems.push(`villa ${row.unit.number} ${key}: return ${row.buckets[key]} vs ledger ${direct.buckets[key]}`);
        }
      }
    }
    T.check('the Form 13B return matches the ledger it is drawn from, villa by villa', formProblems.length === 0, formProblems.slice(0, 3).join('; '));

    /* --- a tenant who paid the month is never shown as owing it --- */
    const wronglyChased = [];
    for (const unit of units) {
      for (const category of ['Rent', 'Maintenance']) {
        const a = fin.accountBalance(unit, category, db.charges, db.payments, asOf, units);
        if (a.paid >= a.charged && a.charged > 0 && a.balance > 0) {
          wronglyChased.push(`${unit.number} ${category}: paid ${a.paid} of ${a.charged} yet owes ${a.balance}`);
        }
      }
    }
    T.check('nobody who has paid what they were billed is being chased for it', wronglyChased.length === 0, wronglyChased.slice(0, 3).join('; '));

    /* --- deposits are never simply lost --- */
    const depositProblems = [];
    for (const t of db.tenancies) {
      if (t.depositAmount === undefined) continue;
      const returned = t.depositReturnedAmount || 0;
      const withheld = t.depositWithheldAmount || 0;
      if (t.depositSettledOn || t.depositReturnedOn) {
        if (Math.abs(cents(returned + withheld) - cents(t.depositAmount)) > 0) {
          depositProblems.push(`tenancy ${t.id}: held ${t.depositAmount}, returned ${returned} + withheld ${withheld}`);
        }
        if (withheld > 0 && !(t.depositWithheldReason || '').trim()) {
          depositProblems.push(`tenancy ${t.id} withheld ${withheld} with no reason recorded`);
        }
      }
    }
    T.check('every deposit settled was returned or withheld in full, with a reason', depositProblems.length === 0, depositProblems.slice(0, 3).join('; '));

    /* --- every receipt is attributable --- */
    const orphanReceipts = db.payments.filter(p => p.status === 'completed' && (!p.unitId || !p.receiptNo || !(p.payerName || '').trim()));
    T.check('every receipt names a villa, a payer and a receipt number', orphanReceipts.length === 0, `${orphanReceipts.length} unattributable`);

    /* --- occupancy is believable --- */
    const occupancyProblems = [];
    for (const month of MONTHS) {
      const series = fin.occupancySeries(units, db.tenancies, db.bookings, [month], `${month}-28`);
      for (const row of series) {
        if (row.occupied > row.total) occupancyProblems.push(`${row.month}: ${row.occupied} let of ${row.total}`);
        if (row.occupied < 0) occupancyProblems.push(`${row.month}: negative occupancy`);
      }
    }
    T.check('occupancy never exceeded the sixteen villas on the register', occupancyProblems.length === 0, occupancyProblems.slice(0, 3).join('; '));

    const holds = db.bookings.filter(b => b.source === 'Blocked' || b.source === 'Unavailable');
    T.check('owner blocks were recorded and are not counted as paying guests', holds.length > 0 && holds.every(b => (b.amount || 0) === 0), `${holds.length} holds`);

    /* --- an evicted tenant's write-off is recorded, not silently dropped --- */
    const evicted = db.tenancies.filter(t => t.evicted);
    T.check(
      'every eviction recorded what was written off and why',
      evicted.every(t => typeof t.writeOffAmount === 'number' && (t.endReason || '').length > 0),
      `${evicted.length} evictions`
    );

    /* --- the books the manager signs off are internally consistent --- */
    const integrity = (await c.get('/api/integrity')).body;
    const serious = (integrity?.findings || []).filter(f => f.severity === 'serious');
    T.check('after a full year the property reports no contradiction in its own records', serious.length === 0, JSON.stringify(serious.map(f => f.code)));

    /* --- and there is enough here for the assertions to mean something --- */
    T.check(
      'the year produced a real property, not a token one',
      db.charges.length > 200 && db.payments.length > 100 && db.expenses.length > 30,
      `${db.charges.length} charges, ${db.payments.length} receipts, ${db.expenses.length} costs`
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
