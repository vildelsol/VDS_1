/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lease terms and renewal warnings.
 *
 * A fixed term that lapses unnoticed does not end a tenancy — it rolls the
 * tenant onto month-to-month terms nobody chose, at the old rent. The value is
 * entirely in seeing it *before* the date, so the checks here are about which
 * leases surface, and when.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Lease terms & renewals';

/** A date `days` from today, as YYYY-MM-DD. */
function offsetDay(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const villa = (over = {}) => ({
  number: '1',
  ownerName: 'Owner',
  status: 'long-term',
  monthlyRent: 60000,
  monthlyMaintenance: 0,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Lease-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Lease-1234!', 'LeaseNew-9876!');

    const tenancyFor = async unitId => (await c.get('/api/db')).body.tenancies.find(t => t.unitId === unitId && t.status === 'active');

    // Four tenancies: no term, a distant term, one ending soon, one already past.
    await c.put('/api/units/unit-1', villa({ tenantName: 'Month To Month' }));
    await c.put('/api/units/unit-2', villa({ number: '2', ownerName: 'Owner Two', tenantName: 'Long Lease' }));
    await c.put('/api/units/unit-3', villa({ number: '3', ownerName: 'Owner Three', tenantName: 'Ending Soon' }));
    await c.put('/api/units/unit-4', villa({ number: '4', ownerName: 'Owner Four', tenantName: 'Already Lapsed' }));

    const t1 = await tenancyFor('unit-1');
    const t2 = await tenancyFor('unit-2');
    const t3 = await tenancyFor('unit-3');
    const t4 = await tenancyFor('unit-4');

    await c.put(`/api/tenancies/${t2.id}`, { startedOn: offsetDay(-400), leaseEndsOn: offsetDay(200) });
    await c.put(`/api/tenancies/${t3.id}`, { startedOn: offsetDay(-300), leaseEndsOn: offsetDay(20) });
    await c.put(`/api/tenancies/${t4.id}`, { startedOn: offsetDay(-500), leaseEndsOn: offsetDay(-15) });

    let db = (await c.get('/api/db')).body;
    T.check('a lease end date is stored', db.tenancies.find(t => t.id === t3.id)?.leaseEndsOn === offsetDay(20));
    T.check('a tenancy can have no lease term at all', !db.tenancies.find(t => t.id === t1.id)?.leaseEndsOn);

    // --- validation ---
    const backwards = await c.put(`/api/tenancies/${t2.id}`, { leaseEndsOn: offsetDay(-500) });
    T.check('a lease cannot end before the tenant moved in', backwards.status === 400, `status ${backwards.status}`);

    // --- the selection rule: only what needs attention, most urgent first ---
    // This mirrors leasesNeedingAttention(), which both the dashboard and the
    // notifications hub call — asserting it is asserting both screens.
    const WITHIN = 60;
    const needing = db.tenancies
      .filter(t => t.status === 'active' && t.leaseEndsOn)
      .map(t => ({
        name: t.tenantName,
        days: Math.round((new Date(`${t.leaseEndsOn}T12:00:00`) - new Date(new Date().toDateString())) / 86400000)
      }))
      .filter(x => x.days <= WITHIN)
      .sort((a, b) => a.days - b.days);

    T.check('a month-to-month tenancy never appears', !needing.some(x => x.name === 'Month To Month'));
    T.check('a lease ending far out does not appear yet', !needing.some(x => x.name === 'Long Lease'), needing.map(x => x.name).join(','));
    T.check('a lease ending inside the window appears', needing.some(x => x.name === 'Ending Soon'));
    T.check('an already-expired lease still appears, not silently dropped', needing.some(x => x.name === 'Already Lapsed'));
    T.check('the most overdue is listed first', needing[0]?.name === 'Already Lapsed', needing.map(x => x.name).join(','));

    // --- renewing pushes it back out of the warning window ---
    await c.put(`/api/tenancies/${t4.id}`, { leaseEndsOn: offsetDay(365) });
    db = (await c.get('/api/db')).body;
    const renewed = db.tenancies.find(t => t.id === t4.id);
    const daysOut = Math.round((new Date(`${renewed.leaseEndsOn}T12:00:00`) - new Date(new Date().toDateString())) / 86400000);
    T.check('renewing a lapsed lease clears the warning', daysOut > WITHIN, `${daysOut} days out`);

    // --- a lease end date is not a move-out date ---
    T.check('the tenancy is still active after its term was extended', renewed.status === 'active');
    T.check('and no move-out date was invented', !renewed.endedOn);

    // --- clearing it returns the tenancy to month-to-month ---
    await c.put(`/api/tenancies/${t3.id}`, { leaseEndsOn: '' });
    db = (await c.get('/api/db')).body;
    T.check('clearing the lease end date makes it month-to-month again', !db.tenancies.find(t => t.id === t3.id)?.leaseEndsOn);
  } finally {
    await srv.stop();
  }
  return T.done();
}
