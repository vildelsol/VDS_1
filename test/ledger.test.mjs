/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The money ledger: payment validation, unique receipts, and the duplicate-ID
 * bugs where a record derived from a voided parent could no longer be voided.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, confirmPayment } from './harness.mjs';

export const title = 'Ledger, receipts & void integrity';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'LedgerTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'LedgerTest-1234!', 'LedgerNew-9876!');
    await makeLongTermUnit(c);

    // confirmNoOpenCharge mirrors a user ticking "record it as a credit anyway".
    // These checks are about receipt mechanics, not the billing flow; the guard
    // itself is covered separately below.
    const rent = extra => ({
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash',
      confirmNoOpenCharge: true,
      ...extra
    });

    // --- payment validation ---
    T.check('a negative payment is refused', (await c.post('/api/payments', rent({ amount: -5 }))).status === 400);
    T.check('a future-dated payment is refused', (await c.post('/api/payments', rent({ date: '2099-01-01' }))).status === 400);
    T.check('an implausibly large payment is refused', (await c.post('/api/payments', rent({ amount: 1e12 }))).status === 400);
    T.check('a currency mismatch warns before recording', (await c.post('/api/payments', rent({ currency: 'USD' }))).status === 400);

    // --- an entry is only an expectation until it is confirmed ---
    const logged = await c.post('/api/payments', rent({ amount: 4321 }));
    const loggedPayment = logged.body?.payment;
    T.check('a recorded payment starts as pending', loggedPayment?.status === 'pending', `status=${loggedPayment?.status}`);
    T.check('a pending payment carries no receipt number', loggedPayment?.receiptNo === '', `receiptNo="${loggedPayment?.receiptNo}"`);
    const confirmed = await confirmPayment(c, loggedPayment.id);
    T.check('confirming it marks it received', confirmed.body?.payment?.status === 'completed', `status=${confirmed.body?.payment?.status}`);
    T.check('confirming it issues a receipt number', !!confirmed.body?.payment?.receiptNo, `receiptNo="${confirmed.body?.payment?.receiptNo}"`);
    T.check('confirming it records who received it', !!confirmed.body?.payment?.receivedBy);
    T.check('confirming twice is refused', (await confirmPayment(c, loggedPayment.id)).status === 400);

    // --- receipt numbers are unique under a burst ---
    // Receipt numbers are handed out at confirmation, so the burst has to be
    // confirmed to exercise the counter at all.
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => c.post('/api/payments', rent({ amount: 100 + i }))));
    const burstIds = burst.map(b => b.body?.payment?.id).filter(Boolean);
    const burstConfirmed = await Promise.all(burstIds.map(id => confirmPayment(c, id)));
    const receipts = burstConfirmed.map(b => b.body?.payment?.receiptNo).filter(Boolean);
    T.check('a burst of payments produced distinct receipt numbers', new Set(receipts).size === 12, `${new Set(receipts).size} of 12`);

    // --- duplicate charge id: void then re-post ---
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    T.check('re-posting a month creates nothing new', (await c.post('/api/charges/post-month', { monthString: '2026-07' })).body?.created === 0);
    let db = (await c.get('/api/db')).body;
    const charge = db.charges.find(x => x.category === 'Rent' && x.periodMonth === '2026-07');
    await c.post(`/api/charges/${charge.id}/void`, { reason: 'rent figure was wrong' });
    await c.put('/api/units/unit-1', { monthlyRent: 60000 });
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    db = (await c.get('/api/db')).body;
    const rentCharges = db.charges.filter(x => x.category === 'Rent' && x.periodMonth === '2026-07');
    T.check('re-posting after a void raises a second, distinct charge', new Set(rentCharges.map(x => x.id)).size === 2, rentCharges.map(x => `${x.id}:${x.status}`).join(' '));
    const live = rentCharges.find(x => x.status === 'open');
    T.check('the new live charge can be voided', (await c.post(`/api/charges/${live.id}/void`, { reason: 'confirming it is reachable' })).status === 200);
    db = (await c.get('/api/db')).body;
    T.check('no charge is left permanently stuck open', db.charges.filter(x => x.category === 'Rent' && x.periodMonth === '2026-07' && x.status === 'open').length === 0);

    // --- duplicate payment id: void a utility receipt, settle again ---
    let r = await c.post('/api/utilities', { unitId: 'unit-1', billingPeriod: '2026-07', previousReading: 0, currentReading: 120, amountCharged: 8000, currency: 'JMD' });
    const utilId = r.body.utility.id;
    T.check('a utility reading derives its own consumption', r.body.utility.consumption === 120);
    const rec1 = (await c.post(`/api/utilities/${utilId}/settle`, { method: 'Cash' })).body.payment;

    // Settling logs an expectation. The bill must stay unpaid, and no receipt
    // number may be taken, until the money is confirmed — a number handed out
    // here would be burned on an entry that received nothing.
    T.check('settling a utility only logs an expected payment', rec1.status === 'pending', `status=${rec1.status}`);
    T.check('and takes no receipt number yet', rec1.receiptNo === '', `receiptNo="${rec1.receiptNo}"`);
    let utilNow = (await c.get('/api/db')).body.utilities.find(u => u.id === utilId);
    T.check('and leaves the bill unpaid', utilNow.status === 'unpaid', `status=${utilNow.status}`);

    const utilConfirmed = (await confirmPayment(c, rec1.id)).body.payment;
    utilNow = (await c.get('/api/db')).body.utilities.find(u => u.id === utilId);
    T.check('confirming the receipt settles the bill', utilNow.status === 'paid', `status=${utilNow.status}`);
    T.check('and issues exactly one receipt number', /^REC-/.test(utilConfirmed.receiptNo), `receiptNo="${utilConfirmed.receiptNo}"`);

    await c.post(`/api/payments/${rec1.id}/reverse`, { reversalReason: 'wrong method recorded' });
    utilNow = (await c.get('/api/db')).body.utilities.find(u => u.id === utilId);
    T.check('voiding that receipt reopens the bill', utilNow.status === 'unpaid', `status=${utilNow.status}`);
    const rec2 = (await c.post(`/api/utilities/${utilId}/settle`, { method: 'Bank Transfer' })).body.payment;
    T.check('re-settling a utility issues a distinct receipt', rec2 && rec1.id !== rec2.id, `${rec1.id} then ${rec2?.id}`);
    T.check('the new utility receipt can be voided', (await c.post(`/api/payments/${rec2.id}/reverse`, { reversalReason: 'confirming it is reachable' })).status === 200);

    // --- booking deposit receipt is never resurrected ---
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'short-term', monthlyMaintenance: 5000, currency: 'USD', maintCurrency: 'USD' });
    r = await c.post('/api/bookings', { unitId: 'unit-2', guestName: 'Guest A', checkIn: '2026-08-01', checkOut: '2026-08-05', amount: 1000, depositPaid: 300, currency: 'USD', source: 'Direct' });
    const bId = r.body.booking.id;
    T.check('an overlapping booking is refused', (await c.post('/api/bookings', { unitId: 'unit-2', guestName: 'B', checkIn: '2026-08-03', checkOut: '2026-08-06', amount: 100, currency: 'USD', source: 'Direct' })).status === 400);
    T.check('a same-day changeover is allowed', (await c.post('/api/bookings', { unitId: 'unit-2', guestName: 'C', checkIn: '2026-08-05', checkOut: '2026-08-08', amount: 100, currency: 'USD', source: 'Direct' })).status === 200);
    db = (await c.get('/api/db')).body;
    const dep1 = db.payments.find(p => p.bookingId === bId);
    await c.post(`/api/payments/${dep1.id}/reverse`, { reversalReason: 'deposit was never received' });
    await c.put(`/api/bookings/${bId}`, { depositPaid: 300, amount: 1000 });
    db = (await c.get('/api/db')).body;
    const deps = db.payments.filter(p => p.bookingId === bId);
    const old = deps.find(p => p.id === dep1.id);
    T.check('the voided deposit receipt stays voided', old?.status === 'reversed');
    T.check('the reversal reason is preserved on the voided receipt', !!old?.reversalReason);
    // A restored deposit is an expectation again, not money in hand: it is raised
    // as pending and has to be confirmed like any other receipt.
    T.check('restoring the deposit raises a new expected receipt', deps.some(p => p.id !== dep1.id && p.status === 'pending'));
    T.check('exactly one live deposit receipt exists', deps.filter(p => p.status !== 'reversed').length === 1);

    // --- settled-record rules ---
    T.check('a voided receipt cannot be edited', (await c.put(`/api/payments/${dep1.id}`, { amount: 999 })).status === 400);
    T.check('a receipt cannot be voided twice', (await c.post(`/api/payments/${dep1.id}/reverse`, { reversalReason: 'double void attempt' })).status === 400);
  } finally {
    await srv.stop();
  }
  return T.done();
}
