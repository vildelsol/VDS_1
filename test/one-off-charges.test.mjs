/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-off charges: late fees, recharged repairs, fines, special assessments.
 *
 * These are billed onto an existing account rather than becoming accounts of
 * their own, so the thing to prove is that they behave like any other money owed
 * — they raise the balance, they age into arrears, a payment settles them, and
 * they are voidable — while never disturbing the monthly billing that runs
 * alongside them.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'One-off charges';

const RENT = 60000;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'OneOff-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'OneOff-1234!', 'OneOffNew-9876!');

    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Owner One',
      tenantName: 'Tenant One',
      status: 'long-term',
      monthlyRent: RENT,
      monthlyMaintenance: 12000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });

    const balance = async (unitId, category) => {
      const db = (await c.get('/api/db')).body;
      const charged = db.charges
        .filter(x => x.unitId === unitId && x.category === category && x.status === 'open')
        .reduce((a, x) => a + x.amount, 0);
      const paid = db.payments
        .filter(x => x.unitId === unitId && x.category === category && x.status === 'completed')
        .reduce((a, x) => a + x.amount, 0);
      return charged - paid;
    };

    // --- validation ---
    T.check('a charge with no type is refused', (await c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', amount: 5000 })).status === 400);
    T.check('a negative charge is refused', (await c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: -5000 })).status === 400);
    const wrongCurrency = await c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 5000, currency: 'USD' });
    T.check('a charge in the wrong currency for that account is refused', wrongCurrency.status === 400, String(wrongCurrency.body?.error).slice(0, 80));

    // --- a late fee lands on the tenant's rent account ---
    const before = await balance('unit-1', 'Rent');
    const fee = await c.post('/api/charges', {
      unitId: 'unit-1',
      category: 'Rent',
      oneOffType: 'Late fee',
      amount: 5000,
      dueDate: '2026-07-10',
      description: 'Late payment fee for July'
    });
    T.check('a late fee can be raised', fee.status === 200, `status ${fee.status}`);
    T.check('it is marked as a one-off, not an ordinary month', fee.body?.charge?.kind === 'one-off', fee.body?.charge?.kind);
    T.check('it records what it is for', fee.body?.charge?.oneOffType === 'Late fee');
    T.check('it is billed to the tenant, not the owner', fee.body?.charge?.payerName === 'Tenant One', fee.body?.charge?.payerName);
    T.check('and it raises the rent balance by its amount', (await balance('unit-1', 'Rent')) - before === 5000);

    // --- the trap: a one-off must not make posting think the month is done ---
    // Both carry the same period month. If posting counted the fee as "July is
    // billed", the actual July rent would be skipped silently.
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    let db = (await c.get('/api/db')).body;
    const julyRent = db.charges.filter(
      x => x.unitId === 'unit-1' && x.category === 'Rent' && x.periodMonth === '2026-07' && x.status === 'open' && !x.kind
    );
    T.check('posting the month still raises the actual rent alongside the fee', julyRent.length === 1, `${julyRent.length} monthly rent charges`);
    T.check('so the balance is rent plus the fee', (await balance('unit-1', 'Rent')) === RENT + 5000, String(await balance('unit-1', 'Rent')));

    // --- posting is still idempotent with a one-off present ---
    const again = await c.post('/api/charges/post-month', { monthString: '2026-07' });
    T.check('re-posting that month still creates nothing', again.body?.created === 0, `created=${again.body?.created}`);

    // --- a special assessment goes to the owner's maintenance account ---
    // Measured as a delta: posting the month above also raised the ordinary
    // monthly maintenance fee, which is not what this is testing.
    const maintBefore = await balance('unit-1', 'Maintenance');
    const levy = await c.post('/api/charges', {
      unitId: 'unit-1',
      category: 'Maintenance',
      oneOffType: 'Special assessment',
      amount: 25000,
      dueDate: '2026-07-15',
      description: 'Roof repair levy'
    });
    T.check('a special assessment can be billed to maintenance', levy.status === 200);
    T.check('and is billed to the registered owner', levy.body?.charge?.payerName === 'Owner One', levy.body?.charge?.payerName);
    T.check(
      'raising the maintenance balance, not the rent one',
      (await balance('unit-1', 'Maintenance')) - maintBefore === 25000,
      `delta ${(await balance('unit-1', 'Maintenance')) - maintBefore}`
    );

    // --- it settles like any other money owed ---
    const owed = await balance('unit-1', 'Rent');
    await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: owed,
      currency: 'JMD',
      payerName: 'Tenant One',
      method: 'Cash',
      receivedNow: true
    });
    T.check('paying the account settles the one-off along with the rent', (await balance('unit-1', 'Rent')) === 0, String(await balance('unit-1', 'Rent')));

    // --- and it can be voided like any other charge ---
    const voided = await c.post(`/api/charges/${levy.body.charge.id}/void`, { reason: 'Levy cancelled by the committee' });
    T.check('a one-off charge can be voided', voided.status === 200, `status ${voided.status}`);
    T.check(
      'which removes it from the balance, leaving the ordinary monthly fee',
      (await balance('unit-1', 'Maintenance')) === maintBefore,
      `${await balance('unit-1', 'Maintenance')} vs ${maintBefore}`
    );

    // --- raising one is an audited act ---
    db = (await c.get('/api/db')).body;
    T.check(
      'raising a one-off charge is written to the audit trail',
      db.auditLogs.some(a => /one-off/i.test(a.action)),
      db.auditLogs.slice(-4).map(a => a.action).join(' | ').slice(0, 120)
    );

    /* ---------------- the annual insurance apportionment ---------------- */

    /*
     * A proprietor's share of the insurance premium is one of only two things
     * the corporation collects from them, and it had no home: the charge
     * categories are Rent and Maintenance, and the nearest one-off type was
     * "Special assessment", which means a levy for unbudgeted major works. Using
     * it would have misdescribed the charge on the owner's ledger and in the
     * annual return.
     *
     * It is raised on the maintenance account because it is a contribution to
     * the body corporate: it ages into arrears beside the maintenance it is
     * collected with, and it belongs in the Form 13B outstanding contributions
     * the same way.
     */
    const insurance = await c.post('/api/charges', {
      unitId: 'unit-1',
      category: 'Maintenance',
      oneOffType: 'Insurance share',
      amount: 45000,
      currency: 'JMD',
      dueDate: '2026-04-01',
      description: 'Share of annual insurance premium 2026/27'
    });
    T.check('an insurance share can be raised as its own kind of charge', insurance.status === 200, `status ${insurance.status}`);
    T.check('and is recorded as an insurance share, not a special assessment', insurance.body?.charge?.oneOffType === 'Insurance share', insurance.body?.charge?.oneOffType);
    T.check('and sits on the maintenance account it is collected with', insurance.body?.charge?.category === 'Maintenance', insurance.body?.charge?.category);

    // It must reach the balance the owner is chased for.
    const owing = await balance('unit-1', 'Maintenance');
    T.check('an unpaid insurance share leaves the owner in arrears for it', owing >= 45000, `balance ${owing}`);

    // And a type that is not on the list is still refused.
    const bogus = await c.post('/api/charges', {
      unitId: 'unit-1',
      category: 'Maintenance',
      oneOffType: 'Insurance',
      amount: 1000,
      currency: 'JMD',
      dueDate: '2026-04-01'
    });
    T.check('a charge type that is not on the list is refused', bogus.status !== 200, `status ${bogus.status}`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
