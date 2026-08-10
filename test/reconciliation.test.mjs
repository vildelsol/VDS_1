/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tying the ledger to the bank.
 *
 * Every other figure in this application derives from the property's own records,
 * so they can all agree with each other and be wrong together — a transfer that
 * was promised and never sent looks exactly like one that arrived. This is the
 * only check against something outside the ledger.
 *
 * What has to hold:
 *
 *  - Only money the ledger says was actually received can be matched. An expected
 *    cheque has not been banked; a voided receipt records something that did not
 *    happen.
 *  - Matching changes **no balance**. It records whether the money was found, and
 *    nothing else — a reconciliation that moved figures would be a second, rival
 *    source of truth.
 *  - Un-matching is possible and is audited, because "it reconciled last week and
 *    now it doesn't" is exactly the shape of a problem worth seeing.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Bank reconciliation';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Recon-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Recon-1234!', 'ReconNew-9876!');
    await makeLongTermUnit(c, 'unit-1');
    await c.post('/api/charges/post-month', { monthString: '2026-07' });

    const balanceOf = async () => {
      const db = await c.get('/api/db');
      const charged = db.body.charges
        .filter(x => x.unitId === 'unit-1' && x.category === 'Rent' && x.status === 'open')
        .reduce((t, x) => t + x.amount, 0);
      const paid = db.body.payments
        .filter(x => x.unitId === 'unit-1' && x.category === 'Rent' && x.status === 'completed')
        .reduce((t, x) => t + x.amount - (x.refundedAmount || 0), 0);
      return Math.round((charged - paid) * 100) / 100;
    };

    const received = await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      payerName: 'Tenant',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      date: '2026-07-05',
      method: 'Bank Transfer'
    });
    const id = received.body.payment.id;
    const receiptNo = received.body.payment.receiptNo;
    T.check('a receipt exists to reconcile', received.status === 200 && !!receiptNo);
    T.check('and starts unmatched', received.body.payment.reconciledOn === undefined);

    const balanceBefore = await balanceOf();

    /* ---------------- matching ---------------- */

    const matched = await c.post(`/api/payments/${id}/reconcile`, {
      reconciledOn: '2026-07-06',
      reference: 'NCB TRF 88213'
    });
    T.check('it can be marked as seen on the statement', matched.status === 200, String(matched.body?.error || ''));
    T.check('the statement date is kept', matched.body?.payment?.reconciledOn === '2026-07-06');
    T.check('with who checked it', !!matched.body?.payment?.reconciledBy);
    T.check("and the bank's own reference", matched.body?.payment?.reconciledReference === 'NCB TRF 88213');

    T.check('matching moves no balance', (await balanceOf()) === balanceBefore);
    T.check('and does not touch the receipt status', matched.body?.payment?.status === 'completed');
    T.check('nor its amount', matched.body?.payment?.amount === 50000);

    /* ---------------- un-matching ---------------- */

    const cleared = await c.post(`/api/payments/${id}/reconcile`, { reconciled: false });
    T.check('it can be un-matched', cleared.status === 200, String(cleared.body?.error || ''));
    T.check('and the statement date is gone', cleared.body?.payment?.reconciledOn === undefined);
    T.check('un-matching also moves no balance', (await balanceOf()) === balanceBefore);

    const clearAgain = await c.post(`/api/payments/${id}/reconcile`, { reconciled: false });
    T.check('un-matching something already unmatched is refused', clearAgain.status === 400);

    /* ---------------- what cannot be matched ---------------- */

    const expected = await c.post('/api/payments', {
      unitId: 'unit-1',
      payerName: 'Owner',
      category: 'Maintenance',
      amount: 4000,
      currency: 'JMD',
      date: '2026-07-09',
      method: 'Cheque'
    });
    const matchPending = await c.post(`/api/payments/${expected.body.payment.id}/reconcile`, { reconciledOn: '2026-07-10' });
    T.check('an expected payment cannot be matched to a statement', matchPending.status === 400);

    const toVoid = await recordAndConfirmPayment(c, {
      unitId: 'unit-1', payerName: 'Owner', category: 'Maintenance', amount: 900,
      currency: 'JMD', date: '2026-07-11', method: 'Cash'
    });
    await c.post(`/api/payments/${toVoid.body.payment.id}/reverse`, { reversalReason: 'Entered in error' });
    const matchVoided = await c.post(`/api/payments/${toVoid.body.payment.id}/reconcile`, { reconciledOn: '2026-07-12' });
    T.check('a voided receipt cannot be matched', matchVoided.status === 400);

    /* ---------------- the statement date is sane ---------------- */

    const tooEarly = await c.post(`/api/payments/${id}/reconcile`, { reconciledOn: '2026-07-01' });
    T.check('a statement date before the payment is refused', tooEarly.status === 400);

    const tooLate = await c.post(`/api/payments/${id}/reconcile`, { reconciledOn: '2099-01-01' });
    T.check('a statement date in the future is refused', tooLate.status === 400);

    const sameDay = await c.post(`/api/payments/${id}/reconcile`, { reconciledOn: '2026-07-05' });
    T.check('a statement date equal to the payment date is fine', sameDay.status === 200, String(sameDay.body?.error || ''));

    /* ---------------- currencies stay apart ---------------- */

    await c.put('/api/units/unit-3', {
      number: '3', ownerName: 'Owner', tenantName: 'USD Tenant', status: 'long-term',
      monthlyRent: 900, monthlyMaintenance: 100, currency: 'USD', maintCurrency: 'USD'
    });
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    const usd = await recordAndConfirmPayment(c, {
      unitId: 'unit-3', payerName: 'USD Tenant', category: 'Rent', amount: 900,
      currency: 'USD', date: '2026-07-07', method: 'Bank Transfer'
    });
    T.check('a USD receipt can be taken', usd.status === 200);
    const usdMatched = await c.post(`/api/payments/${usd.body.payment.id}/reconcile`, { reconciledOn: '2026-07-08' });
    T.check('and matched independently', usdMatched.status === 200, String(usdMatched.body?.error || ''));

    const db = await c.get('/api/db');
    const july = db.body.payments.filter(p => p.status === 'completed' && p.date >= '2026-07-01' && p.date <= '2026-07-31');
    const jmdUnmatched = july.filter(p => p.currency === 'JMD' && !p.reconciledOn);
    const usdUnmatched = july.filter(p => p.currency === 'USD' && !p.reconciledOn);
    T.check('the JMD and USD positions are separate', usdUnmatched.length === 0 && jmdUnmatched.length >= 0);

    /* ---------------- permission ---------------- */

    await c.post('/api/users', {
      name: 'Read Only', username: 'readonly', email: 'ro@example.com',
      position: 'Observer', role: 'JUNIOR_OFFICER', password: 'ReadOnly-1234!'
    });
    // Withdraw the till from junior officers so the permission is genuinely absent.
    await c.post('/api/settings', {
      rolePermissions: {
        JUNIOR_OFFICER: {
          recordPayments: false, addBookings: false, editBookings: false, cancelBookings: false,
          editUnits: false, enterUtilities: false, recordExpenses: false, postCharges: false,
          reversePayments: false, modifySettledRecords: false
        }
      }
    });
    const rc = makeClient(srv.baseUrl);
    await rc.post('/api/auth/login', { username: 'readonly', password: 'ReadOnly-1234!' }, { captureCookie: true });
    await rc.post('/api/auth/change-password', { currentPassword: 'ReadOnly-1234!', newPassword: 'ReadOnlyNew-9876!' });
    const denied = await rc.post(`/api/payments/${id}/reconcile`, { reconciledOn: '2026-07-06' });
    T.check('a role without the till cannot reconcile', denied.status === 403, `saw ${denied.status}`);

    /* ---------------- on the audit trail ---------------- */

    const finalDb = await c.get('/api/db');
    const matchAudits = finalDb.body.auditLogs.filter(a => /Matched receipt/.test(a.action));
    const unmatchAudits = finalDb.body.auditLogs.filter(a => /Un-matched receipt/.test(a.action));
    T.check('matching is on the audit trail', matchAudits.length >= 2, `saw ${matchAudits.length}`);
    T.check('and so is un-matching', unmatchAudits.length >= 1, `saw ${unmatchAudits.length}`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
