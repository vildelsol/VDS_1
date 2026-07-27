/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An account that has never been billed must never read as "settled".
 *
 * Setting a rent figure on a unit does not create a debt — a debt exists only once
 * the month is posted. The ledger used to render any account with a zero balance
 * as a green "Settled", so a villa configured with rent that had never been billed
 * looked fully collected, and a payment taken against it silently became a credit
 * on an account that appeared to owe nothing. Both are covered here.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Billed vs. never-billed accounts';

/** Mirrors accountBalance() in src/lib/finance.ts, so the API and the UI must agree. */
function statusOf(db, unitId, category) {
  const unit = db.units.find(u => u.id === unitId);
  const currency = category === 'Maintenance' ? unit.maintCurrency || unit.currency : unit.currency;
  const charged = db.charges
    .filter(c => c.unitId === unitId && c.category === category && c.status === 'open' && c.currency === currency)
    .reduce((a, c) => a + c.amount, 0);
  const paid = db.payments
    .filter(p => p.unitId === unitId && p.category === category && p.status === 'completed' && p.currency === currency)
    .reduce((a, p) => a + p.amount, 0);
  const balance = charged - paid;
  const amount = category === 'Maintenance' ? unit.monthlyMaintenance : unit.monthlyRent;
  const billable = category === 'Rent' ? unit.status === 'long-term' && amount > 0 : unit.status !== 'unavailable' && amount > 0;
  const status =
    balance > 0 ? 'in-arrears' : balance < 0 ? 'credit' : charged > 0 ? 'settled' : billable ? 'not-billed' : 'inactive';
  return { charged, paid, balance, status };
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'BillTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'BillTest-1234!', 'BillNew-9876!');

    // --- configure a villa, bill nothing ---
    await makeLongTermUnit(c);
    let db = (await c.get('/api/db')).body;
    T.check('configuring rent raises no charge on its own', db.charges.length === 0, `${db.charges.length} charges`);

    let rent = statusOf(db, 'unit-1', 'Rent');
    let maint = statusOf(db, 'unit-1', 'Maintenance');
    T.check('a configured but unbilled rent account is "not-billed", not "settled"', rent.status === 'not-billed', `status=${rent.status}`);
    T.check('the same for maintenance', maint.status === 'not-billed', `status=${maint.status}`);
    T.check('and it genuinely owes nothing yet', rent.balance === 0 && rent.charged === 0);

    // --- a payment against it is refused rather than silently becoming a credit ---
    const blind = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash'
    });
    T.check('taking rent on an unbilled account is refused', blind.status === 400, `status ${blind.status}`);
    T.check('and the refusal explains why', /nothing has been billed/i.test(String(blind.body?.error)), String(blind.body?.error).slice(0, 70));
    db = (await c.get('/api/db')).body;
    T.check('nothing was recorded by the refused payment', db.payments.length === 0, `${db.payments.length} payments`);

    // --- it can still be forced through deliberately ---
    const forced = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash',
      confirmNoOpenCharge: true
    });
    T.check('it can still be recorded deliberately as a credit', forced.status === 200, `status ${forced.status}`);

    // Recording is only an expectation. Until it is confirmed as received it must
    // move nothing at all — that is the whole point of the two steps.
    db = (await c.get('/api/db')).body;
    rent = statusOf(db, 'unit-1', 'Rent');
    T.check('an unconfirmed payment moves nothing on the account', rent.paid === 0 && rent.status === 'not-billed', `paid=${rent.paid} status=${rent.status}`);

    await c.post(`/api/payments/${forced.body.payment.id}/confirm`, {});
    db = (await c.get('/api/db')).body;
    rent = statusOf(db, 'unit-1', 'Rent');
    T.check('and once confirmed that money shows as a credit, not as settled', rent.status === 'credit', `status=${rent.status}, balance=${rent.balance}`);

    // --- once billed, the same account behaves normally ---
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    db = (await c.get('/api/db')).body;
    rent = statusOf(db, 'unit-1', 'Rent');
    T.check('after posting, the credit is absorbed and the account settles', rent.status === 'settled', `charged=${rent.charged} paid=${rent.paid} status=${rent.status}`);

    // --- an account billed and unpaid is in arrears, and payable ---
    maint = statusOf(db, 'unit-1', 'Maintenance');
    T.check('the unpaid maintenance charge is now in arrears', maint.status === 'in-arrears', `status=${maint.status}, balance=${maint.balance}`);
    const settle = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 10000,
      currency: 'JMD',
      payerName: 'Owner',
      method: 'Cash'
    });
    T.check('paying a billed account needs no override', settle.status === 200, `status ${settle.status}`);

    db = (await c.get('/api/db')).body;
    maint = statusOf(db, 'unit-1', 'Maintenance');
    T.check('the account stays in arrears until the money is confirmed', maint.status === 'in-arrears', `paid=${maint.paid} status=${maint.status}`);

    await c.post(`/api/payments/${settle.body.payment.id}/confirm`, {});
    db = (await c.get('/api/db')).body;
    maint = statusOf(db, 'unit-1', 'Maintenance');
    T.check('and once confirmed it reads as genuinely settled', maint.status === 'settled', `charged=${maint.charged} paid=${maint.paid} status=${maint.status}`);

    // --- a villa with no rent set is "inactive", not "not-billed" ---
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Owner Five', status: 'vacant', monthlyRent: 0, monthlyMaintenance: 0, currency: 'JMD', maintCurrency: 'JMD' });
    db = (await c.get('/api/db')).body;
    T.check('a vacant villa with no amounts set is inactive, not flagged unbilled', statusOf(db, 'unit-5', 'Rent').status === 'inactive', `status=${statusOf(db, 'unit-5', 'Rent').status}`);

    // --- posting is still idempotent, and voided charges do not resurrect the state ---
    const again = await c.post('/api/charges/post-month', { monthString: '2026-07' });
    T.check('re-posting the same month still creates nothing', again.body?.created === 0, `created=${again.body?.created}`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
