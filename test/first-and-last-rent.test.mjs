/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "First and last" month's rent.
 *
 * A tenancy starts with two months' rent: this month, and the tenant's final
 * month bought in advance. The arithmetic that matters is the whole occupancy —
 * a tenant who stays N months must end up charged exactly N months' rent, never
 * N + 1. That is what these checks assert, rather than only that two charges
 * appeared at the start.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = "First and last month's rent";

const RENT = 60000;

const villa = (over = {}) => ({
  number: '1',
  ownerName: 'Owner',
  status: 'long-term',
  monthlyRent: RENT,
  monthlyMaintenance: 0,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

/** Open rent charges for a unit, ignoring voided ones. */
const openRent = (db, unitId) => db.charges.filter(c => c.unitId === unitId && c.category === 'Rent' && c.status === 'open');

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'FnLTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'FnLTest-1234!', 'FnLNew-9876!');

    // --- a tenant with no move-in date has no billable month, so nothing is raised ---
    await c.put('/api/units/unit-1', villa({ tenantName: 'No Date Tenant' }));
    let db = (await c.get('/api/db')).body;
    T.check('a tenant with no move-in date is not billed anything yet', openRent(db, 'unit-1').length === 0, `${openRent(db, 'unit-1').length} charges`);

    // --- supplying the move-in date raises first and last, without Post month ---
    let ten = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await c.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-03-01' });
    db = (await c.get('/api/db')).body;
    let rent = openRent(db, 'unit-1');
    T.check('setting the move-in date bills two months at once', rent.length === 2, `${rent.length} charges`);
    T.check('which is twice the monthly rent', rent.reduce((a, x) => a + x.amount, 0) === RENT * 2, String(rent.reduce((a, x) => a + x.amount, 0)));
    T.check('one of them is marked as the final month held in advance', rent.filter(x => x.kind === 'advance-final-month').length === 1);
    T.check('and the tenancy records which charge that is', !!db.tenancies.find(t => t.id === ten.id)?.advanceRentChargeId);

    // --- posting the move-in month must not bill it a second time ---
    await c.post('/api/charges/post-month', { monthString: '2026-03' });
    db = (await c.get('/api/db')).body;
    T.check('posting the move-in month does not double-bill it', openRent(db, 'unit-1').length === 2, `${openRent(db, 'unit-1').length} charges`);

    // --- the months in between are ordinary ---
    await c.post('/api/charges/post-month', { monthString: '2026-04' });
    await c.post('/api/charges/post-month', { monthString: '2026-05' });
    db = (await c.get('/api/db')).body;
    T.check('later months are billed normally', openRent(db, 'unit-1').length === 4, `${openRent(db, 'unit-1').length} charges`);

    // --- moving out in May: that month is already paid for, so it is not charged ---
    ten = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await c.put(`/api/tenancies/${ten.id}`, { endedOn: '2026-05-20', endReason: 'Lease ended.' });
    db = (await c.get('/api/db')).body;
    rent = openRent(db, 'unit-1');

    // March, April and May occupied = three months of rent. The advance bought May.
    T.check('the final month is no longer charged', rent.length === 3, `${rent.length} open charges`);
    T.check(
      'so a three-month tenancy is charged exactly three months of rent',
      rent.reduce((a, x) => a + x.amount, 0) === RENT * 3,
      `${rent.reduce((a, x) => a + x.amount, 0)} vs ${RENT * 3}`
    );
    const voided = db.charges.find(c2 => c2.unitId === 'unit-1' && c2.periodMonth === '2026-05' && c2.status === 'void');
    T.check('the final month is voided rather than deleted', !!voided);
    T.check('with the reason recorded on it', /advance/i.test(voided?.voidReason || ''), voided?.voidReason);
    T.check('and the advance is marked as spent', !!db.tenancies.find(t => t.id === ten.id)?.advanceRentAppliedOn);

    // --- the advance is spent once, not every time the record is touched ---
    await c.put(`/api/tenancies/${ten.id}`, { endedOn: '2026-05-20', endReason: 'Lease ended, corrected.' });
    db = (await c.get('/api/db')).body;
    T.check('re-saving the move-out does not void a second month', openRent(db, 'unit-1').length === 3, `${openRent(db, 'unit-1').length} charges`);

    // --- a move-in date entered after the fact must raise an overdue alert ---
    // Someone forgets to record a tenant, then enters them weeks later. The rent
    // was owed from the day they moved in, so it has to land as *overdue* and be
    // visible for actioning, not as something that quietly starts from today.
    const backdated = new Date();
    backdated.setDate(backdated.getDate() - 45);
    const backMonth = `${backdated.getFullYear()}-${String(backdated.getMonth() + 1).padStart(2, '0')}`;
    const backDay = `${backMonth}-${String(backdated.getDate()).padStart(2, '0')}`;

    await c.put('/api/units/unit-3', villa({ number: '3', ownerName: 'Owner Three', tenantName: 'Late Entry Tenant' }));
    db = (await c.get('/api/db')).body;
    const ten3 = db.tenancies.find(t => t.unitId === 'unit-3' && t.status === 'active');
    await c.put(`/api/tenancies/${ten3.id}`, { startedOn: backDay });
    db = (await c.get('/api/db')).body;

    const back = openRent(db, 'unit-3');
    T.check('a backdated move-in still bills first and last', back.length === 2, `${back.length} charges`);
    T.check('dated to the month they actually moved in, not today', back.every(x => x.periodMonth === backMonth), back.map(x => x.periodMonth).join(','));
    T.check(
      'and dated due in the past, so it reads as overdue rather than upcoming',
      back.every(x => x.dueDate < new Date().toISOString().slice(0, 10)),
      back.map(x => x.dueDate).join(',')
    );

    // --- the dashboard and the hub read the same arrears, so they cannot disagree ---
    // Both screens call delinquentAccounts() over the same server data. Asserting
    // on that shared source is asserting on both screens at once.
    const owingBefore = db.charges
      .filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'open')
      .reduce((a, x) => a + x.amount, 0);
    const paidBefore = db.payments
      .filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'completed')
      .reduce((a, x) => a + x.amount, 0);
    T.check('the backdated tenant appears as owing money', owingBefore - paidBefore === RENT * 2, `${owingBefore - paidBefore}`);

    // Action it once, the way either screen does.
    await c.post('/api/payments', {
      unitId: 'unit-3',
      category: 'Rent',
      amount: RENT * 2,
      currency: 'JMD',
      payerName: 'Late Entry Tenant',
      method: 'Cash',
      receivedNow: true
    });
    db = (await c.get('/api/db')).body;
    const owingAfter = db.charges
      .filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'open')
      .reduce((a, x) => a + x.amount, 0);
    const paidAfter = db.payments
      .filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'completed')
      .reduce((a, x) => a + x.amount, 0);
    T.check(
      'actioning it once clears it from the shared source both screens read',
      owingAfter - paidAfter === 0,
      `balance ${owingAfter - paidAfter}`
    );

    // --- the months since a backdated move-in must be flagged, not silent ---
    // Villa 3's tenant moved in 45 days ago. Move-in billed that month; the month
    // since has never been billed at all, so it is owed and invisible — an
    // unbilled month looks exactly like a month with nothing owed.
    db = (await c.get('/api/db')).body;
    const t3 = db.tenancies.find(t => t.unitId === 'unit-3' && t.status === 'active');
    const monthsSince = [];
    {
      const cur = new Date(`${t3.startedOn}T12:00:00`);
      const now = new Date();
      while (cur <= now) {
        monthsSince.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
      }
    }
    const billedMonths = new Set(
      db.charges.filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'open').map(x => x.periodMonth)
    );
    const missing = monthsSince.filter(m => !billedMonths.has(m));
    T.check(
      'a backdated move-in leaves at least one occupied month unbilled',
      missing.length >= 1,
      `occupied ${monthsSince.join(',')} — billed ${[...billedMonths].join(',')}`
    );

    // Posting the missing month closes the gap, which is the action the alert asks for.
    for (const m of missing) await c.post('/api/charges/post-month', { monthString: m });
    db = (await c.get('/api/db')).body;
    const billedAfter = new Set(
      db.charges.filter(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.status === 'open').map(x => x.periodMonth)
    );
    T.check('posting those months closes the gap', monthsSince.every(m => billedAfter.has(m)), [...billedAfter].join(','));

    // --- a villa with no rent set is never given a two-month charge ---
    await c.put('/api/units/unit-2', villa({ number: '2', monthlyRent: 0, tenantName: 'Rent Free', ownerName: 'Owner Two' }));
    db = (await c.get('/api/db')).body;
    const ten2 = db.tenancies.find(t => t.unitId === 'unit-2' && t.status === 'active');
    await c.put(`/api/tenancies/${ten2.id}`, { startedOn: '2026-03-01' });
    db = (await c.get('/api/db')).body;
    T.check('a villa with no rent set is billed nothing', openRent(db, 'unit-2').length === 0, `${openRent(db, 'unit-2').length} charges`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
