/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cancelling a reservation, and unblocking closed dates (Ro, 2026-11-26):
 * "once a reservation has been booked, there was no way to cancel them and
 * remove them from the list, unblock calendar dates".
 *
 *   1. Server, end to end: a cancel needs a reason and a word on the deposit;
 *      once cancelled, the deposit is refunded, the dates take a new booking, and
 *      the record is kept, not deleted. Unblocking an owner hold frees its dates.
 *   2. Screen: every stay still on carries a Cancel (or Unblock) button for a role
 *      that may cancel; a cancelled stay leaves the list and is found under the
 *      "Cancelled" filter; its nights read free on the calendar; the cancel form
 *      asks only the reason and the deposit, and says the dates are freed.
 *
 * Each refusal has a positive control, so a guard that broke everything cannot pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Cancel a reservation, unblock dates, and free the calendar';

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-cancel-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as Bookings, BookingForm } from './src/components/Bookings';
        export { remember, forgetScreenState } from './src/lib/screenState';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  return { mod: await import(pathToFileURL(outfile).href), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod: M, cleanup } = await load(projectRoot);
  const RealDate = Date;
  const TODAY = localToday();
  const srv = await startServer({ port, adminPassword: 'Cancel-1234!', projectRoot });
  const setup = [];
  const must = (what, r) => { if (!r || r.status >= 400) setup.push(`${what}: ${r?.status} ${JSON.stringify(r?.body).slice(0, 200)}`); return r; };
  try {
    /* ================= 1. server, end to end ================= */
    const a = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(a, 'Cancel-1234!', 'CancelNew-9876!');
    must('villa A1', await a.put('/api/units/unit-1', { number: 'A1', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1 }));
    must('villa A3', await a.put('/api/units/unit-2', { number: 'A3', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1 }));
    const stay = { unitId: 'unit-1', source: 'Direct', checkIn: addDays(TODAY, 20), checkOut: addDays(TODAY, 24), currency: 'USD' };
    const ann = must('book Ann', await a.post('/api/bookings', { ...stay, guestName: 'Ann Cancel', amount: 1000, depositPaid: 300, depositReceivedOn: addDays(TODAY, -2) }))?.body?.booking;

    const clashBefore = await a.post('/api/bookings', { ...stay, guestName: 'Second Guest', amount: 900 });
    T.check('control: while Ann is booked, the same dates are refused', clashBefore.status >= 400, String(clashBefore.status));

    const noReason = await a.put(`/api/bookings/${ann.id}`, { status: 'cancelled', depositOutcome: 'refund' });
    T.check('a cancel with no reason is refused', noReason.status === 400, String(noReason.status));
    let d = (await a.get('/api/db')).body;
    T.check('and leaves the stay on', d.bookings.find(b => b.id === ann.id)?.status === 'confirmed');

    const cancel = await a.put(`/api/bookings/${ann.id}`, { status: 'cancelled', depositOutcome: 'refund', editReason: 'Guest cancelled by phone' });
    T.check('a cancel with a reason is accepted', cancel.status === 200, `${cancel.status} ${JSON.stringify(cancel.body).slice(0, 200)}`);
    d = (await a.get('/api/db')).body;
    const kept = d.bookings.find(b => b.id === ann.id);
    T.check('the reservation is kept on record, marked cancelled, not deleted', kept?.status === 'cancelled');
    const receipt = d.payments.find(p => p.bookingId === ann.id);
    T.check('the US$300 deposit is refunded on its receipt, not erased', receipt?.amount === 300 && receipt?.refundedAmount === 300, JSON.stringify({ a: receipt?.amount, r: receipt?.refundedAmount }));
    const auditText = JSON.stringify(d.auditLogs || []);
    T.check('the cancel and its reason are on the audit trail', auditText.includes('Cancelled reservation. Reason: Guest cancelled by phone'), auditText.slice(-300));

    const rebook = await a.post('/api/bookings', { ...stay, guestName: 'Second Guest', amount: 900 });
    T.check('the freed dates take a new booking', rebook.status < 400, `${rebook.status} ${JSON.stringify(rebook.body).slice(0, 160)}`);
    const reinstate = await a.put(`/api/bookings/${ann.id}`, { status: 'confirmed', editReason: 'Changed mind' });
    T.check('a cancelled reservation cannot be reinstated over the new one', reinstate.status === 400, String(reinstate.status));

    const hold = { unitId: 'unit-2', source: 'Blocked', guestName: 'Owner hold', checkIn: addDays(TODAY, 10), checkOut: addDays(TODAY, 13), currency: 'USD', amount: 0 };
    const block = must('block A3', await a.post('/api/bookings', hold))?.body?.booking;
    const intoBlock = await a.post('/api/bookings', { ...hold, source: 'Direct', guestName: 'Blocked Out', amount: 500 });
    T.check('control: blocked dates refuse a guest', intoBlock.status >= 400, String(intoBlock.status));
    must('unblock A3', await a.put(`/api/bookings/${block.id}`, { status: 'cancelled', editReason: 'Owner no longer needs it' }));
    const afterUnblock = await a.post('/api/bookings', { ...hold, source: 'Direct', guestName: 'Now Booked', amount: 500 });
    T.check('unblocked dates take a guest', afterUnblock.status < 400, `${afterUnblock.status} ${JSON.stringify(afterUnblock.body).slice(0, 160)}`);
    T.check('setup calls all succeeded', setup.length === 0, setup.join(' | '));

    /* ================= 2. the screen ================= */
    globalThis.Date = class extends RealDate {
      constructor(...x) { x.length ? super(...x) : super('2026-11-26T12:00:00'); }
      static now() { return new RealDate('2026-11-26T12:00:00').getTime(); }
    };
    const unit = (id, number) => ({ id, number, ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD' });
    const units = [unit('u1', 'A1'), unit('u2', 'A3'), unit('u3', 'A4')];
    const bk = (id, unitId, guestName, checkIn, checkOut, extra = {}) =>
      ({ id, unitId, unitNumber: units.find(u => u.id === unitId).number, guestName, guestEmail: '', guestPhone: '', checkIn, checkOut, source: 'Direct', status: 'confirmed', currency: 'USD', amount: 800, depositPaid: 0, balanceDue: 800, ...extra });
    const bookings = [
      bk('b1', 'u1', 'Ann Upcoming', '2026-12-05', '2026-12-09', { depositPaid: 200, balanceDue: 600 }),
      bk('b2', 'u2', 'Owner hold', '2026-12-10', '2026-12-14', { source: 'Blocked', amount: 0, balanceDue: 0 }),
      bk('b3', 'u3', 'Zed Gone', '2026-12-15', '2026-12-18', { status: 'cancelled' }),
      bk('b4', 'u1', 'Old Completed', '2026-11-02', '2026-11-05')
    ];
    const allPerms = { addBookings: true, editBookings: true, cancelBookings: true, recordPayments: true, reversePayments: true, modifySettledRecords: true };
    const session = perms => ({ id: 'x', name: 'Tester', username: 't', email: '', position: '', role: 'ADMINISTRATOR', mustChangePassword: false, permissions: perms });
    const noop = async () => ({});
    const screen = (view, filter, perms = allPerms, month = '2026-12', list = bookings) => {
      M.forgetScreenState();
      M.remember('bookings.view', view);
      M.remember('bookings.month', month);
      M.remember('bookings.listAllMonths', true);
      if (filter) M.remember('bookings.listFilter', filter);
      return M.renderToStaticMarkup(M.React.createElement(M.Bookings, { units, bookings: list, payments: [], settings: { icalFeeds: [] }, session: session(perms), onAddBooking: noop, onUpdateBooking: noop, onSyncCalendars: noop, onHoldDamageDeposit: noop, onSettleDamageDeposit: noop }));
    };

    const listHtml = screen('list', 'all');
    const listText = text(listHtml);
    T.check('list: an upcoming stay has a Cancel button', listHtml.includes('aria-label="Cancel the reservation for Ann Upcoming"'));
    T.check('list: an owner hold has an Unblock button', /aria-label="Unblock [^"]+"/.test(listHtml) && listText.includes('Unblock'));
    T.check('list: a cancelled stay has left the list', !listText.includes('Zed Gone'));
    T.check('control: the stays still on are listed', listText.includes('Ann Upcoming') && listText.includes('Owner hold') && listText.includes('Old Completed'));
    T.check('list: a completed stay, a settled record, has no Cancel button', !listHtml.includes('Cancel the reservation for Old Completed'));
    const cancelledList = text(screen('list', 'cancelled'));
    T.check('the "Cancelled" filter still finds the cancelled stay, kept on record', cancelledList.includes('Zed Gone') && !cancelledList.includes('Ann Upcoming'));
    T.check('and offers no Cancel button on it', !screen('list', 'cancelled').includes('Cancel the reservation for Zed Gone'));
    const noPerm = screen('list', 'all', { ...allPerms, cancelBookings: false });
    T.check('a role without permission to cancel sees no Cancel or Unblock button', !/aria-label="(Cancel the reservation|Unblock)/.test(noPerm) && text(noPerm).includes('Ann Upcoming'));

    const cal = text(screen('calendar', null));
    T.check('calendar: the cancelled stay\'s nights read free', /A4 on 2026-12-15: free/.test(cal) && /A4 on 2026-12-17: free/.test(cal), cal.match(/A4 on 2026-12-15: [^ ]+/)?.[0]);
    T.check('control: a stay still on fills its nights', /A1 on 2026-12-05: Ann Upcoming/.test(cal) && /A3 on 2026-12-10: Owner hold/.test(cal));
    const calAfter = text(screen('calendar', null, allPerms, '2026-12', bookings.map(b => (b.id === 'b2' ? { ...b, status: 'cancelled' } : b))));
    T.check('calendar: an unblocked hold frees its nights', /A3 on 2026-12-10: free/.test(calAfter) && /A3 on 2026-12-13: free/.test(calAfter));

    const form = (b, extra = {}) => text(M.renderToStaticMarkup(M.React.createElement(M.BookingForm, { mode: 'edit', units, bookings, booking: b, canCancel: true, onClose: () => {}, onSubmit: noop, ...extra })));
    const fc = form(bookings[0], { startCancelling: true });
    T.check('cancel form: titled for the guest, with a confirm and a keep button', fc.includes('Cancel reservation: Ann Upcoming') && fc.includes('Cancel this reservation') && fc.includes('Keep the reservation'));
    T.check('cancel form: asks for the reason and what happens to the deposit received', fc.includes('Reason for cancelling') && fc.includes('The deposit received on this stay'));
    T.check('cancel form: says the nights are freed and the record kept', fc.includes('are freed on the calendar and can be booked again') && fc.includes('kept on record'));
    T.check('cancel form: no guest fields to change by accident', !fc.includes('Guest email') && !fc.includes('Guest phone'));
    const fu = form(bookings[1], { startCancelling: true });
    T.check('unblock form: speaks of unblocking dates, not a guest', fu.includes('Unblock these dates') && fu.includes('Keep them blocked') && !fu.includes('The deposit received'));
    const fe = form(bookings[0]);
    T.check('edit form: offers "Cancel reservation" and its close button no longer says "Cancel"', fe.includes('Cancel reservation') && fe.includes('Close') && fe.includes('Guest email'));
    const fn = form(bookings[0], { canCancel: false });
    T.check('control: edit form without permission offers no cancel', !fn.includes('Cancel reservation') && fn.includes('Guest email'));
  } finally {
    globalThis.Date = RealDate;
    M.forgetScreenState();
    await srv.stop();
    cleanup();
  }
  return T.done();
}
