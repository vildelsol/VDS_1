/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Refundable security deposits.
 *
 * A deposit is the tenant's money the property is holding, not the property's
 * money. The single most important property to prove is a negative one: that
 * holding it changes no balance, no arrears figure and no income anywhere. The
 * rest is that it adds up on the way back out, because a deposit that half
 * disappears is what ends up in front of a tribunal.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Security deposits';

const RENT = 60000;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Dep-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Dep-1234!', 'DepNew-9876!');

    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Owner',
      tenantName: 'Deposit Tenant',
      status: 'long-term',
      monthlyRent: RENT,
      monthlyMaintenance: 0,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });

    let db = (await c.get('/api/db')).body;
    const ten = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await c.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-03-01' });

    const snapshot = async () => {
      const d = (await c.get('/api/db')).body;
      const charged = d.charges.filter(x => x.unitId === 'unit-1' && x.status === 'open').reduce((a, x) => a + x.amount, 0);
      const paid = d.payments.filter(x => x.unitId === 'unit-1' && x.status === 'completed').reduce((a, x) => a + x.amount, 0);
      return { charged, paid, balance: charged - paid, payments: d.payments.length, charges: d.charges.length };
    };

    const beforeDeposit = await snapshot();

    // --- taking a deposit ---
    const taken = await c.post(`/api/tenancies/${ten.id}/deposit`, { amount: 120000, receivedOn: '2026-03-01' });
    T.check('a deposit can be recorded against the tenancy', taken.status === 200, `status ${taken.status}`);
    T.check('the amount held is recorded', taken.body?.tenancy?.depositAmount === 120000);
    T.check('with the date it was taken', taken.body?.tenancy?.depositReceivedOn === '2026-03-01');

    // --- the point of the whole design: it moves nothing financial ---
    const afterDeposit = await snapshot();
    T.check('holding a deposit raises no charge', afterDeposit.charges === beforeDeposit.charges, `${beforeDeposit.charges} -> ${afterDeposit.charges}`);
    T.check('and records no payment', afterDeposit.payments === beforeDeposit.payments, `${beforeDeposit.payments} -> ${afterDeposit.payments}`);
    T.check('so it does not touch the balance', afterDeposit.balance === beforeDeposit.balance, `${beforeDeposit.balance} -> ${afterDeposit.balance}`);
    T.check('and cannot appear as money collected', afterDeposit.paid === beforeDeposit.paid, `${beforeDeposit.paid} -> ${afterDeposit.paid}`);

    // --- validation ---
    T.check('a deposit of zero is refused', (await c.post(`/api/tenancies/${ten.id}/deposit`, { amount: 0 })).status === 400);
    T.check('a future-dated deposit is refused', (await c.post(`/api/tenancies/${ten.id}/deposit`, { amount: 1000, receivedOn: '2099-01-01' })).status === 400);

    // --- reconciling: the parts must add up to what was held ---
    const mismatch = await c.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 50000, withheldAmount: 20000 });
    T.check('a reconciliation that does not add up is refused', mismatch.status === 400, String(mismatch.body?.error).slice(0, 90));

    const noReason = await c.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 100000, withheldAmount: 20000 });
    T.check('withholding money without a reason is refused', noReason.status === 400, String(noReason.body?.error).slice(0, 80));

    // --- a valid reconciliation ---
    const settled = await c.post(`/api/tenancies/${ten.id}/deposit/settle`, {
      returnedAmount: 100000,
      withheldAmount: 20000,
      withheldReason: 'Broken interior door and deep clean.',
      settledOn: '2026-06-02'
    });
    T.check('the deposit can be reconciled', settled.status === 200, `status ${settled.status}`);
    T.check('recording what went back', settled.body?.tenancy?.depositReturnedAmount === 100000);
    T.check('and what was kept', settled.body?.tenancy?.depositWithheldAmount === 20000);
    T.check('with the reason it was kept', /door/i.test(settled.body?.tenancy?.depositWithheldReason || ''));
    T.check('and the date it was settled', settled.body?.tenancy?.depositReturnedOn === '2026-06-02');

    // --- withholding is still not income ---
    const afterSettle = await snapshot();
    T.check(
      'keeping part of a deposit does not invent income',
      afterSettle.paid === beforeDeposit.paid,
      `${beforeDeposit.paid} -> ${afterSettle.paid}`
    );
    T.check('nor a charge', afterSettle.charges === beforeDeposit.charges, `${beforeDeposit.charges} -> ${afterSettle.charges}`);

    // --- it cannot be settled twice, or quietly re-taken ---
    const twice = await c.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 120000, withheldAmount: 0 });
    T.check('a deposit cannot be reconciled twice', twice.status === 400, `status ${twice.status}`);
    const retake = await c.post(`/api/tenancies/${ten.id}/deposit`, { amount: 5000 });
    T.check('and a returned deposit cannot be overwritten', retake.status === 400, `status ${retake.status}`);

    // --- returning the whole deposit needs no reason ---
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'Owner Two',
      tenantName: 'Clean Tenant',
      status: 'long-term',
      monthlyRent: RENT,
      monthlyMaintenance: 0,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });
    db = (await c.get('/api/db')).body;
    const ten2 = db.tenancies.find(t => t.unitId === 'unit-2' && t.status === 'active');
    await c.post(`/api/tenancies/${ten2.id}/deposit`, { amount: 80000 });
    const full = await c.post(`/api/tenancies/${ten2.id}/deposit/settle`, { returnedAmount: 80000, withheldAmount: 0 });
    T.check('returning a deposit in full needs no reason', full.status === 200, `status ${full.status}`);

    // --- every step is on the record ---
    db = (await c.get('/api/db')).body;
    T.check(
      'taking and reconciling a deposit are both audited',
      db.auditLogs.some(a => /security deposit/i.test(a.action)) && db.auditLogs.some(a => /reconciled the deposit/i.test(a.action)),
      db.auditLogs.filter(a => /deposit/i.test(a.action)).length + ' deposit entries'
    );
  } finally {
    await srv.stop();
  }
  return T.done();
}
