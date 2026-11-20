/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A completed stay is a settled record, and every change to a reservation says why.
 *
 * Ro, 2026-11-19: "a stay that has been completed should not be able to be
 * edited by a junior. and a reason for any edit must be given". Asserted with a
 * junior officer who HAS been granted reservation editing, so the refusal is
 * the completed-stay rule and not the ordinary permission, and with positive
 * controls so a refusal can never pass for a rule that is merely broken.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Completed stays are locked to juniors; every reservation edit needs a reason';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Stay-1234!', projectRoot });
  try {
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'Stay-1234!', 'StayNew-9876!');
    const unit = await admin.put('/api/units/unit-2', {
      number: 'B2', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1
    });
    T.check('setup: a short-let villa', unit.status === 200, String(unit.status));

    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    const perms = (await admin.get('/api/db')).body.settings.rolePermissions.JUNIOR_OFFICER;
    const granted = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms, addBookings: true, editBookings: true, modifySettledRecords: false } } });
    T.check('setup: the junior may edit reservations but not settled records', granted.status === 200, String(granted.status));

    const book = async body => (await admin.post('/api/bookings', { unitId: 'unit-2', currency: 'USD', source: 'Direct', amount: 300, ...body })).body?.booking;
    const done = await book({ guestName: 'Past Guest', checkIn: '2026-10-03', checkOut: '2026-10-06' });
    const ahead = await book({ guestName: 'Future Guest', checkIn: '2027-02-03', checkOut: '2027-02-06' });
    T.check('setup: one completed stay and one upcoming', !!done?.id && !!ahead?.id, JSON.stringify([done?.id, ahead?.id]));

    const lockedEdit = await jr.put(`/api/bookings/${done.id}`, { editReason: 'Guest asked for a new receipt name', guestName: 'Changed' });
    T.check(
      'a junior cannot edit a completed stay, even with a reason',
      lockedEdit.status === 403 && lockedEdit.body?.code === 'completed-stay-locked',
      `${lockedEdit.status} ${JSON.stringify(lockedEdit.body)}`
    );
    const lockedCancel = await jr.put(`/api/bookings/${done.id}`, { editReason: 'Cancel it after the fact', status: 'cancelled' });
    T.check('nor cancel one', lockedCancel.status === 403, String(lockedCancel.status));
    const still = (await admin.get('/api/db')).body.bookings.find(b => b.id === done.id);
    T.check('and the completed stay is exactly as it was', still.guestName === 'Past Guest' && still.status !== 'cancelled', JSON.stringify(still));

    const noReason = await jr.put(`/api/bookings/${ahead.id}`, { guestPhone: '555-0101' });
    T.check(
      'an edit with no reason is refused',
      noReason.status === 400 && noReason.body?.code === 'edit-reason-required',
      `${noReason.status} ${JSON.stringify(noReason.body)}`
    );
    const shortReason = await jr.put(`/api/bookings/${ahead.id}`, { editReason: ' ok ', guestPhone: '555-0101' });
    T.check('a reason of under five characters is refused', shortReason.status === 400, String(shortReason.status));

    // Positive controls: the rules refuse what they should, not everything.
    const fine = await jr.put(`/api/bookings/${ahead.id}`, { editReason: 'Guest gave a new phone number', guestPhone: '555-0101' });
    T.check('control: the junior can edit an upcoming stay with a reason', fine.status === 200, `${fine.status} ${JSON.stringify(fine.body).slice(0, 200)}`);
    const senior = await admin.put(`/api/bookings/${done.id}`, { editReason: 'Correcting the guest’s surname', guestName: 'Past Guest-Smith' });
    T.check('control: an administrator can correct a completed stay with a reason', senior.status === 200, `${senior.status} ${JSON.stringify(senior.body).slice(0, 200)}`);

    const audit = (await admin.get('/api/db')).body.auditLogs || [];
    T.check(
      'the reason is written to the audit trail with the change',
      audit.some(a => a.recordId === done.id && /Reason: Correcting the guest’s surname/.test(a.action)) &&
        audit.some(a => a.recordId === ahead.id && /Reason: Guest gave a new phone number/.test(a.action)),
      JSON.stringify(audit.filter(a => a.recordType === 'Booking').map(a => a.action))
    );
  } finally {
    await srv.stop();
  }
  return T.done();
}
