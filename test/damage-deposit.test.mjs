/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The refundable damage deposit on a short stay.
 *
 * Two things have to hold, and they pull in opposite directions.
 *
 * It is **optional**. Most stays take no deposit, and a booking, a check-out and
 * a guest receipt must all work exactly as they did when none is held. Nothing
 * may start requiring one.
 *
 * And it is **not income**. It is the guest's money the property is holding and
 * owes back, so it must raise no receipt, appear in no collection figure, and
 * never reach a proprietor's statement — which is the whole difference between
 * this and `depositPaid`, the part-payment toward the stay that sits beside it on
 * the same record.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Guest damage deposits';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Damage-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Damage-1234!', 'DamageNew-9876!');

    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'Owner',
      status: 'short-term',
      monthlyRent: 0,
      monthlyMaintenance: 18000,
      currency: 'USD',
      maintCurrency: 'JMD'
    });

    const makeBooking = (over = {}) =>
      c.post('/api/bookings', {
        unitId: 'unit-2',
        guestName: 'Guest',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
        amount: 1200,
        depositPaid: 400,
        currency: 'USD',
        source: 'Direct',
        ...over
      });

    /* ---------------- it stays optional ---------------- */

    const plain = await makeBooking({ guestName: 'No Deposit Guest' });
    T.check('a stay can be booked without one', plain.status === 200, String(plain.body?.error || ''));
    T.check('and nothing is held on it', plain.body?.booking?.damageDepositAmount === undefined);

    const checkedOut = await c.put(`/api/bookings/${plain.body.booking.id}`, { status: 'checked-out' });
    T.check('the guest checks out with no deposit and nothing objects', checkedOut.status === 200, String(checkedOut.body?.error || ''));

    const settleNone = await c.post(`/api/bookings/${plain.body.booking.id}/damage-deposit/settle`, { withheldAmount: 0 });
    T.check('reconciling one that was never taken is refused clearly', settleNone.status === 400, `status ${settleNone.status}`);

    /* ---------------- holding one ---------------- */

    const withDeposit = await makeBooking({ guestName: 'Deposit Guest', checkIn: '2026-04-01', checkOut: '2026-04-06' });
    const id = withDeposit.body.booking.id;

    const held = await c.post(`/api/bookings/${id}/damage-deposit`, { amount: 500, currency: 'USD', receivedOn: '2026-04-01' });
    T.check('a deposit can be held against a stay', held.status === 200, String(held.body?.error || ''));
    T.check('the amount is recorded', held.body?.booking?.damageDepositAmount === 500);
    T.check('and it has not been reconciled yet', held.body?.booking?.damageDepositReturnedOn === undefined);

    // The critical separation: this money is held, not earned.
    let db = (await c.get('/api/db')).body;
    const bookingPayments = db.payments.filter(p => p.category === 'Booking' && p.status !== 'reversed');
    T.check(
      'holding it raises no receipt — it is not income',
      bookingPayments.every(p => p.amount !== 500),
      bookingPayments.map(p => `${p.category} ${p.amount}`).join(',')
    );
    T.check(
      'and the reservation deposit is untouched beside it',
      db.bookings.find(b => b.id === id).depositPaid === 400,
      String(db.bookings.find(b => b.id === id).depositPaid)
    );

    const future = await c.post(`/api/bookings/${id}/damage-deposit`, { amount: 100, receivedOn: '2099-01-01' });
    T.check('one cannot be dated in the future', future.status === 400, `status ${future.status}`);

    const zero = await c.post(`/api/bookings/${id}/damage-deposit`, { amount: 0 });
    T.check('nor held for nothing', zero.status === 400, `status ${zero.status}`);

    /* ---------------- reconciling it ---------------- */

    const mismatched = await c.post(`/api/bookings/${id}/damage-deposit/settle`, {
      withheldAmount: 100,
      returnedAmount: 100,
      withheldReason: 'Broken shutter in the second bedroom',
      settledOn: '2026-04-06'
    });
    T.check('returned and withheld that do not add up are refused', mismatched.status === 400, `status ${mismatched.status}`);
    T.check(
      'and the refusal says what they should add up to',
      /500/.test(String(mismatched.body?.error)),
      String(mismatched.body?.error).slice(0, 120)
    );

    const unexplained = await c.post(`/api/bookings/${id}/damage-deposit/settle`, {
      withheldAmount: 100,
      returnedAmount: 400,
      withheldReason: '',
      settledOn: '2026-04-06'
    });
    T.check('keeping money without a reason is refused', unexplained.status === 400, `status ${unexplained.status}`);

    const done = await c.post(`/api/bookings/${id}/damage-deposit/settle`, {
      withheldAmount: 100,
      returnedAmount: 400,
      withheldReason: 'Broken shutter in the second bedroom',
      settledOn: '2026-04-06'
    });
    T.check('a reconciliation that balances and explains itself goes through', done.status === 200, String(done.body?.error || ''));
    T.check('what went back is recorded', done.body?.booking?.damageDepositReturnedAmount === 400);
    T.check('what was kept is recorded', done.body?.booking?.damageDepositWithheldAmount === 100);
    T.check(
      'and the reason is kept with it',
      /shutter/i.test(String(done.body?.booking?.damageDepositWithheldReason)),
      String(done.body?.booking?.damageDepositWithheldReason)
    );

    // Withholding is still not income — the property recovers a real cost as an
    // expense, not by quietly booking the guest's money as revenue.
    db = (await c.get('/api/db')).body;
    T.check(
      'keeping part of it still raises no receipt',
      db.payments.filter(p => p.amount === 100 && p.category === 'Booking').length === 0
    );

    const twice = await c.post(`/api/bookings/${id}/damage-deposit/settle`, { withheldAmount: 0, returnedAmount: 500 });
    T.check('it cannot be reconciled a second time', twice.status === 400, `status ${twice.status}`);

    const reHold = await c.post(`/api/bookings/${id}/damage-deposit`, { amount: 200 });
    T.check('nor can a new one be held on a settled stay', reHold.status === 400, `status ${reHold.status}`);

    /* ---------------- returning it all ---------------- */

    const clean = await makeBooking({ guestName: 'Clean Guest', checkIn: '2026-05-01', checkOut: '2026-05-04' });
    const cleanId = clean.body.booking.id;
    await c.post(`/api/bookings/${cleanId}/damage-deposit`, { amount: 300, currency: 'USD', receivedOn: '2026-05-01' });

    const allBack = await c.post(`/api/bookings/${cleanId}/damage-deposit/settle`, { withheldAmount: 0, settledOn: '2026-05-04' });
    T.check('returning all of it needs no reason', allBack.status === 200, String(allBack.body?.error || ''));
    T.check('and returns the whole amount by default', allBack.body?.booking?.damageDepositReturnedAmount === 300, String(allBack.body?.booking?.damageDepositReturnedAmount));

    /* ---------------- editing the reservation does not lose it ---------------- */

    const stillHeld = await makeBooking({ guestName: 'Edited Guest', checkIn: '2026-06-01', checkOut: '2026-06-04' });
    const editId = stillHeld.body.booking.id;
    await c.post(`/api/bookings/${editId}/damage-deposit`, { amount: 250, currency: 'USD', receivedOn: '2026-06-01' });

    const edited = await c.put(`/api/bookings/${editId}`, { amount: 1500, guestName: 'Edited Guest', status: 'checked-in' });
    T.check('the reservation can still be edited', edited.status === 200, String(edited.body?.error || ''));
    T.check(
      'and editing it does not lose the deposit being held',
      edited.body?.booking?.damageDepositAmount === 250,
      String(edited.body?.booking?.damageDepositAmount)
    );

    /* ---------------- the audit trail ---------------- */

    db = (await c.get('/api/db')).body;
    T.check(
      'holding and reconciling are both on the audit trail',
      db.auditLogs.some(l => /Holding a .* damage deposit/i.test(l.action)) &&
        db.auditLogs.some(l => /Reconciled the damage deposit/i.test(l.action)),
      db.auditLogs
        .map(l => l.action)
        .filter(a => /damage/i.test(a))
        .join(' | ')
    );
  } finally {
    await srv.stop();
  }

  return T.done();
}
