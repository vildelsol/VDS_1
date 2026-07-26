/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The money ledger: payment validation, unique receipts, and the duplicate-ID
 * bugs where a record derived from a voided parent could no longer be voided.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Ledger, receipts & void integrity';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'LedgerTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'LedgerTest-1234!', 'LedgerNew-9876!');
    await makeLongTermUnit(c);

    const rent = extra => ({ unitId: 'unit-1', category: 'Rent', amount: 50000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', ...extra });

    // --- payment validation ---
    T.check('a negative payment is refused', (await c.post('/api/payments', rent({ amount: -5 }))).status === 400);
    T.check('a future-dated payment is refused', (await c.post('/api/payments', rent({ date: '2099-01-01' }))).status === 400);
    T.check('an implausibly large payment is refused', (await c.post('/api/payments', rent({ amount: 1e12 }))).status === 400);
    T.check('a currency mismatch warns before recording', (await c.post('/api/payments', rent({ currency: 'USD' }))).status === 400);

    // --- receipt numbers are unique under a burst ---
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => c.post('/api/payments', rent({ amount: 100 + i }))));
    const receipts = burst.map(b => b.body?.payment?.receiptNo).filter(Boolean);
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
    await c.post(`/api/payments/${rec1.id}/reverse`, { reversalReason: 'wrong method recorded' });
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
    T.check('restoring the deposit issues a new receipt', deps.some(p => p.id !== dep1.id && p.status === 'completed'));
    T.check('exactly one live deposit receipt exists', deps.filter(p => p.status === 'completed').length === 1);

    // --- settled-record rules ---
    T.check('a voided receipt cannot be edited', (await c.put(`/api/payments/${dep1.id}`, { amount: 999 })).status === 400);
    T.check('a receipt cannot be voided twice', (await c.post(`/api/payments/${dep1.id}/reverse`, { reversalReason: 'double void attempt' })).status === 400);
  } finally {
    await srv.stop();
  }
  return T.done();
}
