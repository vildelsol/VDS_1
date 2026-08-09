/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The same debt must not be banked twice.
 *
 * Two officers work the same arrears list, or one person has the hub open in two
 * tabs. Both see "Villa 1 owes J$50,000", both press "Receive payment", and the
 * money was only ever handed over once. The idempotency key does not help: these
 * are two different actions with two different keys, not one action retried. Each
 * request used to be validated against a world in which the other had not
 * happened, so both were accepted and the villa ended up showing a credit for
 * money nobody ever received.
 *
 * The check has to be made against the ledger as it stands at the moment of the
 * write, which is the only version of it that is true.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, confirmPayment } from './harness.mjs';

export const title = 'Double-recorded payments';

const CODE = 'account-already-settled';

/** Last month, so charges can legitimately be posted for it. */
function lastMonth() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Double-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Double-1234!', 'DoubleNew-9876!');
    const month = lastMonth();

    await makeLongTermUnit(c); // rent 50000 JMD, maintenance 10000 JMD
    await c.post('/api/charges/post-month', { monthString: month });

    const rent = (over = {}) => ({
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash',
      receivedNow: true,
      ...over
    });

    /* ---------------- the plain case: two people, one debt ---------------- */

    const first = await c.post('/api/payments', rent());
    T.check('the first officer banks the rent', first.status === 200, String(first.body?.error || ''));

    const second = await c.post('/api/payments', rent());
    T.check('the second is refused rather than doubling it', second.status === 400, `status ${second.status}`);
    T.check('the refusal is machine-readable, so the screen can offer a way through', second.body?.code === CODE, String(second.body?.code));
    T.check(
      'and it says who took the money, so it can be checked with them',
      /System Administrator/.test(String(second.body?.error)) && /REC-/.test(String(second.body?.error)),
      String(second.body?.error).slice(0, 140)
    );

    let db = (await c.get('/api/db')).body;
    T.check('only one receipt exists', db.payments.filter(p => p.status === 'completed').length === 1, `${db.payments.length}`);

    /* ---------------- it is a refusal, not a wall ---------------- */

    const deliberate = await c.post('/api/payments', rent({ confirmAlreadySettled: true }));
    T.check('a genuine advance payment still goes through when confirmed', deliberate.status === 200, String(deliberate.body?.error || ''));
    db = (await c.get('/api/db')).body;
    T.check('and it lands as a credit on the account', db.payments.filter(p => p.status === 'completed').length === 2);

    /* ---------------- partial payments still work ---------------- */

    // Maintenance: 10,000 billed, nothing paid. Two part-payments that together
    // settle it must both be accepted; only a third is too much.
    const maint = (over = {}) => ({
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 4000,
      currency: 'JMD',
      payerName: 'Owner',
      method: 'Cash',
      receivedNow: true,
      ...over
    });
    T.check('a part payment is accepted', (await c.post('/api/payments', maint())).status === 200);
    T.check('and so is the rest of it', (await c.post('/api/payments', maint({ amount: 6000 }))).status === 200);
    const overshoot = await c.post('/api/payments', maint({ amount: 1 }));
    T.check('but a penny more than is owed is questioned', overshoot.status === 400, `status ${overshoot.status}`);

    // Paying more than the balance in one go is the fat-finger case: an extra
    // zero on an amount is caught by exactly the same guard.
    await c.post('/api/charges/post-month', { monthString: month });
    const typo = await c.post('/api/payments', rent({ amount: 500000, confirmAlreadySettled: false }));
    T.check('an amount far larger than the balance is questioned too', typo.status === 400, `status ${typo.status}`);

    /* ---------------- the expected-cheque path ---------------- */

    // Both officers log an expected cheque for the same month, which is harmless
    // — neither counts for anything. The damage happens when both are confirmed.
    const unitTwo = await makeLongTermUnit(c, 'unit-2', { number: '2', monthlyRent: 30000, monthlyMaintenance: 0 });
    T.check('a second villa is configured', unitTwo.status === 200, String(unitTwo.body?.error || ''));
    await c.post('/api/charges/post-month', { monthString: month });

    const expected = (over = {}) => ({
      unitId: 'unit-2',
      category: 'Rent',
      amount: 30000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cheque',
      ...over
    });
    const chequeA = await c.post('/api/payments', expected());
    const chequeB = await c.post('/api/payments', expected());
    T.check('two expected cheques can both be logged', chequeA.status === 200 && chequeB.status === 200);

    const confirmA = await confirmPayment(c, chequeA.body.payment.id);
    T.check('confirming the first is fine', confirmA.status === 200, String(confirmA.body?.error || ''));
    const confirmB = await confirmPayment(c, chequeB.body.payment.id);
    T.check('confirming the second is refused — that is where the money doubles', confirmB.status === 400, `status ${confirmB.status}`);
    T.check('and it carries the same code', confirmB.body?.code === CODE, String(confirmB.body?.code));

    const forced = await confirmPayment(c, chequeB.body.payment.id, { confirmAlreadySettled: true });
    T.check('a confirmation can still be forced deliberately', forced.status === 200, String(forced.body?.error || ''));

    /* ---------------- utility bills ---------------- */

    // The bill stays "unpaid" until its receipt is confirmed, so the status check
    // alone never caught a second person settling it in the meantime.
    const reading = await c.post('/api/utilities', {
      unitId: 'unit-1',
      billingPeriod: month,
      previousReading: 100,
      currentReading: 250,
      amountCharged: 9000,
      currency: 'JMD'
    });
    T.check('a utility reading is recorded', reading.status === 200, String(reading.body?.error || ''));
    const utilityId = (await c.get('/api/db')).body.utilities[0].id;

    const settleA = await c.post(`/api/utilities/${utilityId}/settle`, { method: 'Cash' });
    T.check('the bill can be settled once', settleA.status === 200, String(settleA.body?.error || ''));
    const settleB = await c.post(`/api/utilities/${utilityId}/settle`, { method: 'Cash' });
    T.check(
      'a second settlement of the same bill is refused while the first is unconfirmed',
      settleB.status === 400,
      `status ${settleB.status}`
    );
    T.check(
      'and it points at the entry already waiting rather than raising another',
      /awaiting/i.test(String(settleB.body?.error)),
      String(settleB.body?.error).slice(0, 120)
    );

    db = (await c.get('/api/db')).body;
    T.check('only one receipt exists for that bill', db.payments.filter(p => p.utilityId === utilityId).length === 1);

    /* ---------------- genuinely simultaneous ---------------- */

    // The real shape of the bug: not one request after another, but both in
    // flight at once. The write path is serialised by the transaction, so exactly
    // one must win.
    const villa3 = await makeLongTermUnit(c, 'unit-3', { number: '3', monthlyRent: 70000, monthlyMaintenance: 0 });
    T.check('a third villa is configured', villa3.status === 200, String(villa3.body?.error || ''));
    await c.post('/api/charges/post-month', { monthString: month });

    const race = { unitId: 'unit-3', category: 'Rent', amount: 70000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', receivedNow: true };
    const results = await Promise.all([c.post('/api/payments', race), c.post('/api/payments', race)]);
    const accepted = results.filter(r => r.status === 200).length;
    T.check('exactly one of two simultaneous receipts is accepted', accepted === 1, `${accepted} accepted`);

    db = (await c.get('/api/db')).body;
    const villa3Payments = db.payments.filter(p => p.unitId === 'unit-3' && p.status === 'completed');
    T.check('the villa was credited once, not twice', villa3Payments.length === 1, `${villa3Payments.length} receipts`);
    T.check(
      'and the loser left nothing behind — not even a pending entry',
      db.payments.filter(p => p.unitId === 'unit-3').length === 1,
      `${db.payments.filter(p => p.unitId === 'unit-3').length} entries`
    );

    /* ---------------- a retry is still a safe no-op ---------------- */

    // The guard must not break the thing that was already right: the same action
    // resent after a dropped reply is one action, and stays one.
    const key = 'test-retry-key-0001';
    const villa4 = await makeLongTermUnit(c, 'unit-4', { number: '4', monthlyRent: 40000, monthlyMaintenance: 0 });
    T.check('a fourth villa is configured', villa4.status === 200, String(villa4.body?.error || ''));
    await c.post('/api/charges/post-month', { monthString: month });

    const retryBody = { unitId: 'unit-4', category: 'Rent', amount: 40000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', receivedNow: true };
    const sent = await c.post('/api/payments', retryBody, { headers: { 'Idempotency-Key': key } });
    const resent = await c.post('/api/payments', retryBody, { headers: { 'Idempotency-Key': key } });
    T.check('a retried request is replayed, not refused', sent.status === 200 && resent.status === 200, `${sent.status}/${resent.status}`);
    T.check(
      'and it produced one receipt, not two',
      (await c.get('/api/db')).body.payments.filter(p => p.unitId === 'unit-4').length === 1
    );
  } finally {
    await srv.stop();
  }

  return T.done();
}
