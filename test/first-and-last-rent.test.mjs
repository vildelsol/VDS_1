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
