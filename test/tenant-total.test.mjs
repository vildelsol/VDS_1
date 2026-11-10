/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The agreed rent is the one figure the tenant pays; maintenance comes out of it
 * (Ro, 2026-11-10).
 *
 * J$75,000 agreed rent, of which J$20,000 is maintenance and J$55,000 is ISPO's.
 * The levy rise to J$27,000 on 1 January 2027 changes the split, never the total.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment, localToday } from './harness.mjs';

export const title = "Agreed rent with maintenance taken out of it";

const openOf = (db, unitId, category) => db.charges.filter(c => c.unitId === unitId && c.category === category && c.status === 'open');
const sum = rows => Math.round(rows.reduce((a, x) => a + x.amount, 0) * 100) / 100;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'TenantTotal-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'TenantTotal-1234!', 'TenantNew-9876!');

    // --- the headline case: 55,000 + 20,000 ---
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000 });
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    await c.post('/api/charges/post-month', { monthString: '2026-08' });
    let db = (await c.get('/api/db')).body;
    let rent = openOf(db, 'unit-1', 'Rent');
    let maint = openOf(db, 'unit-1', 'Maintenance');
    T.check('two months posted, one Rent line each', rent.length === 2, `${rent.length}`);
    T.check('each Rent line is 75,000', rent.every(x => x.amount === 75000), rent.map(x => x.amount).join(','));
    T.check('split recorded as 55,000 + 20,000', rent.every(x => x.rentPortion === 55000 && x.maintenancePortion === 20000));
    T.check('portions always add to the amount', rent.every(x => Math.round((x.rentPortion + x.maintenancePortion) * 100) === Math.round(x.amount * 100)));
    T.check('the corporation maintenance charge is still raised separately at 20,000', maint.length === 2 && maint.every(x => x.amount === 20000), maint.map(x => x.amount).join(','));
    T.check('the maintenance charge carries no rent split', maint.every(x => x.rentPortion === undefined));
    T.check('the register still stores agreed rent 75,000 and levy 20,000', db.units.find(u => u.id === 'unit-1').monthlyRent === 75000 && db.units.find(u => u.id === 'unit-1').monthlyMaintenance === 20000);

    // --- re-posting never duplicates or restates ---
    const before = sum(openOf(db, 'unit-1', 'Rent'));
    await c.post('/api/charges/post-month', { monthString: '2026-08' });
    db = (await c.get('/api/db')).body;
    T.check('re-posting a month adds nothing', openOf(db, 'unit-1', 'Rent').length === 2 && sum(openOf(db, 'unit-1', 'Rent')) === before);

    // --- paying the 75,000 settles the month; a 55,000 payment does not ---
    const pay = amount => ({ unitId: 'unit-1', category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: localToday() });
    await recordAndConfirmPayment(c, pay(55000));
    db = (await c.get('/api/db')).body;
    const paid = db.payments.filter(p => p.unitId === 'unit-1' && p.category === 'Rent' && p.status === 'completed').reduce((a, p) => a + p.amount, 0);
    T.check('a 55,000 payment leaves 95,000 of the 150,000 owing', 150000 - paid === 95000, String(150000 - paid));
    await recordAndConfirmPayment(c, pay(95000));
    db = (await c.get('/api/db')).body;
    const paid2 = db.payments.filter(p => p.unitId === 'unit-1' && p.category === 'Rent' && p.status === 'completed').reduce((a, p) => a + p.amount, 0);
    T.check('paying 75,000 a month clears the account exactly', sum(openOf(db, 'unit-1', 'Rent')) - paid2 === 0, `${sum(openOf(db, 'unit-1', 'Rent'))} vs ${paid2}`);

    // --- the 1 January 2027 rise to 27,000: edit the register, then post ---
    const edit = (over) => c.put('/api/units/unit-1', {
      number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term',
      monthlyRent: 75000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD',
      rentDueDay: 1, maintDueDay: 1, ...over
    });
    const res = await edit({ monthlyMaintenance: 27000 });
    T.check('the register accepts the new levy', res.status === 200, `${res.status}`);
    db = (await c.get('/api/db')).body;
    T.check('already-posted months are untouched by the rise', openOf(db, 'unit-1', 'Rent').every(x => x.amount === 75000) && openOf(db, 'unit-1', 'Maintenance').every(x => x.amount === 20000));
    T.check('the change is audited', db.auditLogs.some(a => /maintenance fee changed/.test(a.action)));
    await c.post('/api/charges/post-month', { monthString: '2026-09' });
    db = (await c.get('/api/db')).body;
    const sep = db.charges.filter(x => x.unitId === 'unit-1' && x.periodMonth === '2026-09' && x.status === 'open');
    const sepRent = sep.find(x => x.category === 'Rent');
    const sepMaint = sep.find(x => x.category === 'Maintenance');
    T.check('after the rise the tenant still pays 75,000; ISPO share falls to 48,000', sepRent?.amount === 75000 && sepRent.rentPortion === 48000 && sepRent.maintenancePortion === 27000, JSON.stringify(sepRent));
    T.check('and the maintenance charge is 27,000', sepMaint?.amount === 27000);
    T.check('the maintenance taken from the rent equals the maintenance charge', sepRent.maintenancePortion === sepMaint.amount && sepRent.amount === sepRent.rentPortion + sepMaint.amount);

    // --- robustness: bad levy values are refused and change nothing ---
    for (const bad of [-1, 'abc', 1e15]) {
      const r = await edit({ monthlyMaintenance: bad });
      T.check(`levy ${JSON.stringify(bad)} refused`, r.status === 400, `${r.status}`);
    }
    db = (await c.get('/api/db')).body;
    T.check('a refused edit leaves the levy at 27,000', db.units.find(u => u.id === 'unit-1').monthlyMaintenance === 27000);

    // --- zero levy: nothing is taken out ---
    await makeLongTermUnit(c, 'unit-2', { monthlyRent: 60000, monthlyMaintenance: 0 });
    // --- different currencies are never combined: no share taken ---
    await makeLongTermUnit(c, 'unit-3', { monthlyRent: 60000, monthlyMaintenance: 125, maintCurrency: 'USD' });
    // --- levy larger than the rent: the share can never exceed the rent ---
    await makeLongTermUnit(c, 'unit-8', { monthlyRent: 15000, monthlyMaintenance: 27000, tenantName: 'Small' });
    // --- no rent, levy only: nothing for a tenant to pay ---
    await makeLongTermUnit(c, 'unit-4', { monthlyRent: 0, monthlyMaintenance: 20000 });
    await c.post('/api/charges/post-month', { monthString: '2026-10' });
    db = (await c.get('/api/db')).body;
    const r2 = openOf(db, 'unit-2', 'Rent');
    const r3 = openOf(db, 'unit-3', 'Rent');
    T.check('zero levy: rent line is the rent', r2.length === 1 && r2[0].amount === 60000 && !r2[0].maintenancePortion);
    T.check('JMD rent + USD levy: rent line is rent only', r3.length === 1 && r3[0].amount === 60000 && r3[0].currency === 'JMD');
    T.check('JMD rent + USD levy: levy still billed in USD on the maintenance account', openOf(db, 'unit-3', 'Maintenance').some(x => x.currency === 'USD' && x.amount === 125));
    T.check('no rent: no tenant rent charge', openOf(db, 'unit-4', 'Rent').length === 0);
    const r8 = openOf(db, 'unit-8', 'Rent');
    T.check('a levy bigger than the rent takes at most the whole rent', r8.length === 1 && r8[0].amount === 15000 && r8[0].maintenancePortion === 15000 && r8[0].rentPortion === 0, JSON.stringify(r8));

    // --- owner-occupied / short-term units get the new levy on the maintenance account only ---
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Owner Five', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 27000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.post('/api/charges/post-month', { monthString: '2026-10' });
    db = (await c.get('/api/db')).body;
    T.check('an owner unit is billed 27,000 maintenance and no rent', openOf(db, 'unit-5', 'Maintenance').some(x => x.amount === 27000) && openOf(db, 'unit-5', 'Rent').length === 0);

    // --- first and last month at the combined total ---
    await c.put('/api/units/unit-6', { number: '6', ownerName: 'Owner Six', tenantName: 'New Tenant', status: 'long-term', monthlyRent: 75000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    db = (await c.get('/api/db')).body;
    const ten = db.tenancies.find(t => t.unitId === 'unit-6' && t.status === 'active');
    await c.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-10-01' });
    db = (await c.get('/api/db')).body;
    const fl = openOf(db, 'unit-6', 'Rent');
    T.check('first and last are two charges of 75,000', fl.length === 2 && fl.every(x => x.amount === 75000), fl.map(x => x.amount).join(','));
    T.check('and both carry the split 55,000 / 20,000', fl.every(x => x.rentPortion === 55000 && x.maintenancePortion === 20000));

    // --- data integrity: every open rent charge splits exactly; integrity check stays clean ---
    const allRent = db.charges.filter(x => x.category === 'Rent' && x.rentPortion !== undefined);
    T.check('every split rent charge adds up to its amount', allRent.every(x => Math.round((x.rentPortion + (x.maintenancePortion || 0)) * 100) === Math.round(x.amount * 100)));
    const health = await c.get('/api/health');
    T.check('server healthy after all of the above', health.status === 200);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
  }
  return T.done();
}
