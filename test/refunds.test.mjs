/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Refunds — money that really arrived and really went back.
 *
 * The distinction this whole feature exists for: **voiding is not refunding.**
 * Voiding a receipt says the money never arrived and erases the event. A refund
 * says it did arrive, the receipt is still a true record of that, and afterwards
 * some or all of it was handed back. Before this existed the only control was
 * void, so every refund destroyed the evidence that the property had ever held
 * the money.
 *
 * What has to hold:
 *
 *  - The receipt stays `completed` and keeps its receipt number.
 *  - Every derived figure nets the refund off — so a refunded rent payment puts
 *    the tenant back into arrears, which is the point.
 *  - The refund lands in the period the money *left*, not the period it arrived.
 *    Netting it into the original month would silently restate a month already
 *    reported on.
 *  - A receipt cannot be both refunded and voided, in either order.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Refunds';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Refund-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Refund-1234!', 'RefundNew-9876!');
    await makeLongTermUnit(c, 'unit-1');
    await c.post('/api/charges/post-month', { monthString: '2026-07' });

    const balanceOf = async (category = 'Rent') => {
      const db = await c.get('/api/db');
      const charges = db.body.charges.filter(x => x.unitId === 'unit-1' && x.category === category && x.status === 'open');
      const payments = db.body.payments.filter(x => x.unitId === 'unit-1' && x.category === category && x.status === 'completed');
      const charged = charges.reduce((t, x) => t + x.amount, 0);
      const paid = payments.reduce((t, x) => t + x.amount - (x.refundedAmount || 0), 0);
      return Math.round((charged - paid) * 100) / 100;
    };

    /* ---------------- the receipt survives ---------------- */

    const paid = await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      payerName: 'Tenant',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      date: '2026-07-05',
      method: 'Cash'
    });
    const receiptNo = paid.body.payment.receiptNo;
    T.check('a rent payment can be received', paid.status === 200 && !!receiptNo, String(paid.body?.error || ''));
    T.check('and it settles the account', (await balanceOf()) === 0);

    const refunded = await c.post(`/api/payments/${paid.body.payment.id}/refund`, {
      amount: 50000,
      refundedOn: '2026-07-20',
      method: 'Bank Transfer',
      reason: 'Tenant paid twice; the second payment was returned.'
    });
    T.check('it can be refunded', refunded.status === 200, String(refunded.body?.error || ''));
    T.check('the receipt is still completed', refunded.body?.payment?.status === 'completed');
    T.check('and keeps its receipt number', refunded.body?.payment?.receiptNo === receiptNo);
    T.check('the refund records who, when and why',
      !!refunded.body?.payment?.refundedBy &&
      refunded.body?.payment?.refundedOn === '2026-07-20' &&
      !!refunded.body?.payment?.refundReason
    );
    T.check('the money is no longer with the property', (await balanceOf()) === 50000);

    /* ---------------- you cannot do both ---------------- */

    const voidAfterRefund = await c.post(`/api/payments/${paid.body.payment.id}/reverse`, {
      reversalReason: 'Trying to void something already refunded'
    });
    T.check('a refunded receipt cannot then be voided', voidAfterRefund.status === 400);

    const refundTwice = await c.post(`/api/payments/${paid.body.payment.id}/refund`, {
      amount: 100,
      reason: 'Trying to refund twice'
    });
    T.check('and cannot be refunded twice', refundTwice.status === 400);

    const voided = await recordAndConfirmPayment(c, {
      unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 1000,
      currency: 'JMD', date: '2026-07-06', method: 'Cash'
    });
    await c.post(`/api/payments/${voided.body.payment.id}/reverse`, { reversalReason: 'Entered against the wrong villa' });
    const refundAfterVoid = await c.post(`/api/payments/${voided.body.payment.id}/refund`, {
      amount: 1000,
      reason: 'Trying to refund a voided receipt'
    });
    T.check('a voided receipt cannot be refunded', refundAfterVoid.status === 400);

    /* ---------------- what is refusable ---------------- */

    const expected = await c.post('/api/payments', {
      unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 5000,
      currency: 'JMD', date: '2026-07-07', method: 'Cheque'
    });
    const refundPending = await c.post(`/api/payments/${expected.body.payment.id}/refund`, {
      amount: 5000,
      reason: 'Trying to refund money never received'
    });
    T.check('money that has not been received cannot be refunded', refundPending.status === 400);

    const partialTarget = await recordAndConfirmPayment(c, {
      unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 20000,
      currency: 'JMD', date: '2026-07-08', method: 'Cash'
    });
    const tooMuch = await c.post(`/api/payments/${partialTarget.body.payment.id}/refund`, {
      amount: 30000,
      reason: 'Trying to refund more than was taken'
    });
    T.check('more than the receipt cannot be refunded', tooMuch.status === 400);

    const backdated = await c.post(`/api/payments/${partialTarget.body.payment.id}/refund`, {
      amount: 5000,
      refundedOn: '2026-07-01',
      reason: 'Trying to refund before the payment'
    });
    T.check('a refund cannot predate the payment it refunds', backdated.status === 400);

    const noReason = await c.post(`/api/payments/${partialTarget.body.payment.id}/refund`, { amount: 5000 });
    T.check('a refund without a reason is refused', noReason.status === 400);

    // Same rule as a payment: money that has not moved yet is an intention.
    const futureDated = await c.post(`/api/payments/${partialTarget.body.payment.id}/refund`, {
      amount: 5000,
      refundedOn: '2099-01-01',
      reason: 'Trying to post-date a refund'
    });
    T.check('a refund cannot be dated in the future', futureDated.status === 400);

    /* ---------------- partial ---------------- */

    const before = await balanceOf();
    const partial = await c.post(`/api/payments/${partialTarget.body.payment.id}/refund`, {
      amount: 5000,
      refundedOn: '2026-07-25',
      method: 'Cash',
      reason: 'Overpaid by five thousand; the difference was returned.'
    });
    T.check('a partial refund is allowed', partial.status === 200, String(partial.body?.error || ''));
    T.check('and only the refunded part comes off', (await balanceOf()) === Math.round((before + 5000) * 100) / 100);
    T.check('the receipt still shows its full original amount', partial.body?.payment?.amount === 20000);

    /* ---------------- it lands in the period the money left ---------------- */

    const reports = await c.get('/api/db');
    const augustPayment = await recordAndConfirmPayment(c, {
      unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 8000,
      currency: 'JMD', date: '2026-07-28', method: 'Cash'
    });
    const laterRefund = await c.post(`/api/payments/${augustPayment.body.payment.id}/refund`, {
      amount: 8000,
      refundedOn: '2026-08-04',
      method: 'Bank Transfer',
      reason: 'Returned the following month.'
    });
    T.check('a refund can fall in a later month than the receipt', laterRefund.status === 200, String(laterRefund.body?.error || ''));
    T.check(
      'and is dated by when the money went back',
      laterRefund.body?.payment?.date === '2026-07-28' && laterRefund.body?.payment?.refundedOn === '2026-08-04'
    );
    T.check('the ledger snapshot still loads', Array.isArray(reports.body.payments));

    /* ---------------- linked records stay honest ---------------- */

    await c.put('/api/units/unit-2', {
      number: '2', ownerName: 'Owner', status: 'short-term',
      monthlyRent: 0, monthlyMaintenance: 0, currency: 'USD', maintCurrency: 'USD'
    });
    const booking = await c.post('/api/bookings', {
      unitId: 'unit-2', guestName: 'Guest', checkIn: '2026-09-01', checkOut: '2026-09-05',
      amount: 1000, depositPaid: 400, currency: 'USD', source: 'Direct'
    });
    const dbAfterBooking = await c.get('/api/db');
    const depositReceipt = dbAfterBooking.body.payments.find(p => p.bookingId === booking.body.booking.id);
    if (depositReceipt) {
      if (depositReceipt.status === 'pending') await c.post(`/api/payments/${depositReceipt.id}/confirm`, {});
      const bookingRefund = await c.post(`/api/payments/${depositReceipt.id}/refund`, {
        amount: 400,
        method: 'Bank Transfer',
        reason: 'Guest cancelled inside the free window.'
      });
      T.check('a booking deposit can be refunded', bookingRefund.status === 200, String(bookingRefund.body?.error || ''));
      const after = await c.get('/api/db');
      const b = after.body.bookings.find(x => x.id === booking.body.booking.id);
      T.check('and the stay is no longer part-paid for it', b?.depositPaid === 0);
      T.check('with the balance due put back', b?.balanceDue === 1000);
    } else {
      T.check('a booking deposit raises a receipt to refund', false, 'no linked receipt found');
    }

    /* ---------------- permission ---------------- */

    await c.post('/api/users', {
      name: 'Junior Officer', username: 'junior', email: 'junior@example.com',
      position: 'Officer', role: 'JUNIOR_OFFICER', password: 'JuniorPass-1234!'
    });
    const jc = makeClient(srv.baseUrl);
    await jc.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-1234!' }, { captureCookie: true });
    await jc.post('/api/auth/change-password', { currentPassword: 'JuniorPass-1234!', newPassword: 'JuniorNew-9876!' });

    const juniorPayment = await recordAndConfirmPayment(c, {
      unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 700,
      currency: 'JMD', date: '2026-08-05', method: 'Cash'
    });
    if (!juniorPayment.body?.payment) {
      T.check('a payment could be recorded for the permission check', false, JSON.stringify(juniorPayment.body));
    }
    const juniorRefund = await jc.post(`/api/payments/${juniorPayment.body?.payment?.id}/refund`, {
      amount: 700,
      reason: 'A junior officer should not be able to do this'
    });
    T.check('refunding needs the payment-reversal permission', juniorRefund.status === 403);

    /* ---------------- on the audit trail ---------------- */

    const finalDb = await c.get('/api/db');
    const refundAudits = finalDb.body.auditLogs.filter(a => /Refunded/.test(a.action));
    T.check('every refund is on the audit trail', refundAudits.length >= 4, `saw ${refundAudits.length}`);
    T.check('and the reason is carried in it', refundAudits.some(a => /paid twice/i.test(a.action)));
  } finally {
    await srv.stop();
  }
  return T.done();
}
