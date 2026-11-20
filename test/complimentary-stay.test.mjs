/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Complimentary stays: free on purpose, with a reason, junior officers included.
 *
 * Ro, 2026-11-19: the Wedding Stay, Marlon and an A4 stay carried no value
 * because they were complimentary, and the system flagged them as missing a
 * price. A complimentary stay is J$0 by design: it needs a reason, takes no
 * money, records who marked it, and a junior officer (who may create
 * reservations) may mark one. Positive controls throughout, so a refusal can
 * never pass for a rule that is merely broken.
 */

import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Complimentary stays: a reason, no money, junior officers allowed';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Comp-1234!', projectRoot });
  try {
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'Comp-1234!', 'CompNew-9876!');
    const unit = await admin.put('/api/units/unit-2', {
      number: 'B2', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1
    });
    T.check('setup: a short-let villa', unit.status === 200, String(unit.status));

    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    const stay = over => ({ unitId: 'unit-2', guestName: 'Wedding Party', checkIn: '2027-01-10', checkOut: '2027-01-13', currency: 'JMD', source: 'Direct', amount: 0, ...over });

    const noReason = await jr.post('/api/bookings', stay({ complimentary: true }));
    T.check('a complimentary stay without a reason is refused', noReason.status === 400 && /why this stay is complimentary/.test(noReason.body?.error || ''), `${noReason.status} ${noReason.body?.error}`);
    const priced = await jr.post('/api/bookings', stay({ complimentary: true, complimentaryReason: 'Wedding party, owner guests', amount: 500 }));
    T.check('a complimentary stay with a price is refused, not quietly zeroed', priced.status === 400 && /must be 0/.test(priced.body?.error || ''), `${priced.status} ${priced.body?.error}`);

    const made = await jr.post('/api/bookings', stay({ complimentary: true, complimentaryReason: 'Wedding party, owner guests' }));
    const comp = made.body?.booking;
    T.check('a junior officer can create a complimentary stay with a reason', made.status === 200 && comp?.complimentary === true, `${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    T.check('the reason and who marked it are kept', comp?.complimentaryReason === 'Wedding party, owner guests' && comp?.complimentaryBy === 'Junior Jo', JSON.stringify(comp));
    const audit = (await admin.get('/api/db')).body.auditLogs || [];
    T.check('the creation is on the audit trail', audit.some(a => a.recordId === comp?.id && /Created reservation/.test(a.action)));

    // No money is taken against a complimentary stay.
    const link = await recordAndConfirmPayment(admin, {
      unitId: 'unit-2', category: 'Booking', amount: 5000, currency: 'JMD', payerName: 'Guest', method: 'Cash', date: '2026-11-10', forBookingId: comp?.id, confirmNoOpenCharge: true
    });
    T.check('a receipt cannot be linked to a complimentary stay', link.status === 400 && /complimentary/.test(link.body?.error || ''), `${link.status} ${link.body?.error}`);

    // A paid stay cannot be turned complimentary while its money stands.
    const paid = (await admin.post('/api/bookings', stay({ guestName: 'Paying Guest', checkIn: '2027-02-10', checkOut: '2027-02-12', amount: 10000, depositPaid: 5000, depositReceivedOn: '2026-11-10' }))).body?.booking;
    T.check('setup: a paid stay with a deposit', !!paid?.id, JSON.stringify(paid).slice(0, 200));
    const flip = await admin.put(`/api/bookings/${paid.id}`, { editReason: 'Owner says it is free', complimentary: true, complimentaryReason: 'Owner says it is free', amount: 0, depositPaid: 0 });
    T.check('a stay that has taken money cannot be marked complimentary', flip.status === 400 && /already been received/.test(flip.body?.error || ''), `${flip.status} ${flip.body?.error}`);

    // Control: an unpaid stay can be marked complimentary later, by whoever may edit it.
    const plain = (await admin.post('/api/bookings', stay({ guestName: 'Marlon', checkIn: '2027-03-10', checkOut: '2027-03-12' }))).body?.booking;
    const later = await admin.put(`/api/bookings/${plain.id}`, { editReason: 'It was complimentary all along', complimentary: true, complimentaryReason: 'Family guest of the owner' });
    T.check('control: an unpaid stay can be marked complimentary afterwards', later.status === 200 && later.body?.booking?.complimentaryBy, `${later.status} ${JSON.stringify(later.body).slice(0, 200)}`);
    const unmark = await admin.put(`/api/bookings/${plain.id}`, { editReason: 'Guest is paying after all', complimentary: false, amount: 4000 });
    T.check('unmarking it clears the reason and who marked it', unmark.status === 200 && !unmark.body?.booking?.complimentary && !unmark.body?.booking?.complimentaryReason && !unmark.body?.booking?.complimentaryBy, JSON.stringify(unmark.body?.booking));
  } finally {
    await srv.stop();
  }
  return T.done();
}
