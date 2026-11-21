/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a short stay has been paid, and when its deposit arrived.
 *
 * QA simulation, 2026-11-19, two money-wrong defects:
 *
 *   1. Stays paid in full showed as owing. The Dashboard read "Balance
 *      outstanding $3,610 / J$72,000" where $300 was true, and the bookings
 *      list, the reservations report and the guest receipt said the same,
 *      because every one of them read the reservation's own `depositPaid` and
 *      `balanceDue`. The balance a guest pays on arrival is its own receipt, and
 *      `POST /api/payments` could not say which stay it was for; a J$2,000
 *      refund on a C16 stay changed nothing either.
 *      Now: a Booking receipt may name its stay (`forBookingId`, same villa and
 *      currency, checked by the server), and every screen reads `stayMoney` —
 *      the stay's receipts, completed only, net of refunds. A receipt tied to no
 *      stay is counted on its own line, never dropped.
 *   2. A reservation's deposit receipt was dated the day it was typed and could
 *      not be corrected: a 25-28 September stay's deposit was November cash.
 *      Now the date received is entered (not future, not a closed month) and
 *      the receipt's date and method can be corrected under the same guards as
 *      any other receipt.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Short stays: paid from the receipts, deposits dated when received';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stays-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as Dashboard } from './src/components/Dashboard';
        export { default as Bookings, GuestStayReceipt, ReservationsReport } from './src/components/Bookings';
        export { buildStayReceiptEmail } from './src/lib/email';
        export { stayMoney, stayTotals } from './src/lib/stays';
        export * as fin from './src/lib/finance';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const textOf = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Stays-1234!', projectRoot });
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { React, renderToStaticMarkup, Dashboard, GuestStayReceipt, ReservationsReport, buildStayReceiptEmail, stayMoney, stayTotals, fin } = mod;
  const h = React.createElement;
  const setupFailures = [];
  const must = (what, r) => {
    if (!r || r.status >= 400) setupFailures.push(`${what}: ${r?.status} ${JSON.stringify(r?.body)}`);
    return r;
  };

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Stays-1234!', 'StaysNew-9876!');
    must('books begin', await c.post('/api/settings', { booksBeginOn: '2026-09-01' }));
    const shortLet = (number, currency) => ({ number, ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency, maintCurrency: 'JMD', maintDueDay: 1 });
    must('A1', await c.put('/api/units/unit-1', shortLet('A1', 'USD')));
    must('B2', await c.put('/api/units/unit-2', shortLet('B2', 'USD')));
    must('C16', await c.put('/api/units/unit-16', shortLet('C16', 'JMD')));

    const book = b => c.post('/api/bookings', { source: 'Direct', depositMethod: 'Cash', guestEmail: '', guestPhone: '', ...b });
    const receipt = (unitId, amount, currency, date, extra = {}) =>
      c.post('/api/payments', { unitId, category: 'Booking', amount, currency, date, method: 'Cash', payerName: extra.payerName || 'Guest', receivedNow: true, ...extra });
    const db = async () => (await c.get('/api/db')).body;

    /* ================= defect 2: the deposit is dated when it was received ================= */
    const a = must('A1 Sept stay with a deposit taken on 5 Sept', await book({ unitId: 'unit-1', guestName: 'Guest Sept', checkIn: '2026-09-10', checkOut: '2026-09-15', amount: 750, currency: 'USD', depositPaid: 300, depositReceivedOn: '2026-09-05' }));
    const aId = a.body?.booking?.id;
    let d = await db();
    const aDeposit = d.payments.find(p => p.bookingId === aId);
    T.check('the deposit receipt is dated the day the money was received, not the day it was typed', aDeposit?.date === '2026-09-05', aDeposit?.date);
    T.check('and the reservation records that day', d.bookings.find(b => b.id === aId)?.depositReceivedOn === '2026-09-05');

    const future = await book({ unitId: 'unit-2', guestName: 'Too Early', checkIn: '2026-12-10', checkOut: '2026-12-12', amount: 200, currency: 'USD', depositPaid: 50, depositReceivedOn: '2099-01-01' });
    T.check('a deposit dated in the future is refused, with the reason', future.status === 400 && future.body?.error === 'The date the deposit was received cannot be in the future.', JSON.stringify(future.body));

    // A deposit entered without a date is dated today, as before, and can then be corrected.
    const late = must('A1 late-entered 25-28 Sept stay', await book({ unitId: 'unit-1', guestName: 'Guest Late Entry', checkIn: '2026-09-25', checkOut: '2026-09-28', amount: 450, currency: 'USD', depositPaid: 450 }));
    const lateId = late.body?.booking?.id;
    d = await db();
    let lateDeposit = d.payments.find(p => p.bookingId === lateId);
    T.check('a deposit given no date is dated today (local), as it always was', lateDeposit?.date === localToday(), lateDeposit?.date);

    // Correction path 1: the receipt itself. Date and method may change; amount may not.
    const amountEdit = await c.put(`/api/payments/${lateDeposit.id}`, { reason: 'corrected in test', amount: 400 });
    T.check(
      "the deposit receipt's amount still follows the reservation, and the refusal says where to change it",
      amountEdit.status === 400 &&
        amountEdit.body?.error ===
          "This receipt is the reservation's own deposit. Its amount, currency, villa and guest follow the reservation: change them there. The date received, method, reference and notes can be corrected here.",
      JSON.stringify(amountEdit.body)
    );
    const futureEdit = await c.put(`/api/payments/${lateDeposit.id}`, { reason: 'corrected in test', date: '2099-01-01' });
    T.check('a deposit receipt cannot be corrected into the future', futureEdit.status === 400 && futureEdit.body?.error === 'A payment cannot be dated in the future.', JSON.stringify(futureEdit.body));
    const dateEdit = await c.put(`/api/payments/${lateDeposit.id}`, { reason: 'corrected in test', ...lateDeposit, date: '2026-09-25', method: 'Bank Transfer' });
    T.check('the deposit receipt can be corrected to the day it arrived (the whole form sent back unchanged otherwise)', dateEdit.status === 200 && dateEdit.body?.payment?.date === '2026-09-25', JSON.stringify(dateEdit.body));
    d = await db();
    const lateBooking = d.bookings.find(b => b.id === lateId);
    T.check('the reservation follows the corrected receipt, so its next save does not put the old date back', lateBooking?.depositReceivedOn === '2026-09-25' && lateBooking?.depositMethod === 'Bank Transfer', JSON.stringify(lateBooking));
    must('save the reservation again (a phone number)', await c.put(`/api/bookings/${lateId}`, { editReason: 'Test correction', guestPhone: '555-0101' }));
    d = await db();
    lateDeposit = d.payments.find(p => p.bookingId === lateId);
    T.check('a later reservation save leaves the corrected date alone', lateDeposit?.date === '2026-09-25' && lateDeposit?.method === 'Bank Transfer', JSON.stringify(lateDeposit));
    const sepCash = fin.collectedInPeriod(d.payments, 'USD', '2026-09-01', '2026-09-30').booking;
    const novCash = fin.collectedInPeriod(d.payments, 'USD', '2026-11-01', '2026-11-30').booking;
    T.check('the 25-28 September deposit is September cash, not November', sepCash === 750 && novCash === 0, `Sep ${sepCash}, Nov ${novCash}`);

    // Correction path 2: the reservation.
    must('B2 Oct stay, deposit entered today', await book({ unitId: 'unit-2', guestName: 'Guest Oct', checkIn: '2026-10-03', checkOut: '2026-10-06', amount: 300, currency: 'USD', depositPaid: 100 }));
    d = await db();
    const octStay = d.bookings.find(b => b.guestName === 'Guest Oct');
    must('re-date the deposit on the reservation', await c.put(`/api/bookings/${octStay.id}`, { editReason: 'Test correction', depositReceivedOn: '2026-10-01' }));
    d = await db();
    T.check('re-dating the deposit on the reservation moves its receipt', d.payments.find(p => p.bookingId === octStay.id)?.date === '2026-10-01');

    /* ================= defect 1: a stay is paid by its receipts ================= */
    const balance = await receipt('unit-1', 450, 'USD', '2026-09-10', { payerName: 'Guest Sept', forBookingId: aId });
    T.check('a balance receipt can name its stay', balance.status === 200 && balance.body?.payment?.forBookingId === aId, JSON.stringify(balance.body));
    T.check('and it is NOT the deposit receipt (bookingId stays the deposit link alone)', !balance.body?.payment?.bookingId);

    // C16: J$10,000 stay, paid in full on arrival, J$2,000 refunded in November.
    must('C16 stay', await book({ unitId: 'unit-16', guestName: 'Guest C16', checkIn: '2026-10-25', checkOut: '2026-10-28', amount: 10000, currency: 'JMD', depositPaid: 0 }));
    d = await db();
    const c16 = d.bookings.find(b => b.guestName === 'Guest C16');
    const c16pay = must('C16 paid on arrival', await receipt('unit-16', 10000, 'JMD', '2026-10-25', { payerName: 'Guest C16', forBookingId: c16.id }));
    must('C16 refund', await c.post(`/api/payments/${c16pay.body?.payment?.id}/refund`, { amount: 2000, refundedOn: '2026-11-03', method: 'Cash', reason: 'Early departure' }));

    // A receipt from before a receipt could name its stay.
    must('an old unlinked booking receipt on B2', await receipt('unit-2', 100, 'USD', '2026-10-04', { payerName: 'Guest Oct' }));

    // Refusals, pinned.
    const wrongVilla = await receipt('unit-2', 10, 'USD', '2026-10-04', { forBookingId: aId });
    T.check('a receipt cannot pay toward a stay at another villa', wrongVilla.status === 400 && wrongVilla.body?.error === 'That reservation is at A1, not B2. A receipt can only pay toward a stay at the same villa.', JSON.stringify(wrongVilla.body));
    const wrongCurrency = await receipt('unit-1', 10, 'JMD', '2026-10-04', { forBookingId: aId });
    T.check('nor in another currency', wrongCurrency.status === 400 && wrongCurrency.body?.error === 'That reservation is priced in USD and this receipt is in JMD. A receipt can only pay toward a stay in the same currency.', JSON.stringify(wrongCurrency.body));
    const notBooking = await c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 10, currency: 'USD', date: '2026-10-04', method: 'Cash', payerName: 'X', receivedNow: true, forBookingId: aId });
    T.check('only a Booking receipt can name a stay', notBooking.status === 400 && notBooking.body?.error === 'Only a Booking receipt can be linked to a reservation.', JSON.stringify(notBooking.body));
    const ghost = await receipt('unit-1', 10, 'USD', '2026-10-04', { forBookingId: 'b-nope' });
    T.check('nor a stay that does not exist', ghost.status === 400 && ghost.body?.error === 'That reservation was not found. Choose the stay this payment was for.', JSON.stringify(ghost.body));
    must('a stay that is then cancelled', await book({ unitId: 'unit-2', guestName: 'Guest Cancelled', checkIn: '2026-12-20', checkOut: '2026-12-22', amount: 100, currency: 'USD', depositPaid: 0 }));
    d = await db();
    const cancelled = d.bookings.find(b => b.guestName === 'Guest Cancelled');
    must('cancel it', await c.put(`/api/bookings/${cancelled.id}`, { editReason: 'Test correction', status: 'cancelled' }));
    const toCancelled = await receipt('unit-2', 10, 'USD', '2026-10-04', { forBookingId: cancelled.id });
    T.check('nor a cancelled stay', toCancelled.status === 400 && toCancelled.body?.error === 'That reservation has been cancelled. Link the receipt to the stay it actually paid for.', JSON.stringify(toCancelled.body));

    // Linking an old receipt to its stay through the correction path.
    d = await db();
    const old = d.payments.find(p => p.category === 'Booking' && p.unitId === 'unit-2' && p.amount === 100 && !p.bookingId && !p.forBookingId);
    T.check('setup completed without a refused call', setupFailures.length === 0, setupFailures.join(' | '));

    const S = d.payments;
    const aMoney = stayMoney(d.bookings.find(b => b.id === aId), S);
    T.check('A1 Sept stay: deposit 300 + balance 450 = paid 750, nothing owing', aMoney.paid === 750 && aMoney.balance === 0, JSON.stringify({ paid: aMoney.paid, balance: aMoney.balance }));
    const c16Money = stayMoney(d.bookings.find(b => b.id === c16.id), S);
    T.check('C16: J$10,000 received, J$2,000 refunded = J$8,000 paid, J$2,000 to collect', c16Money.received === 10000 && c16Money.refunded === 2000 && c16Money.paid === 8000 && c16Money.balance === 2000, JSON.stringify({ r: c16Money.received, f: c16Money.refunded, p: c16Money.paid, b: c16Money.balance }));
    const octMoney = stayMoney(octStay, S);
    T.check('B2 Oct stay before linking: deposit 100 only, 200 owing', octMoney.paid === 100 && octMoney.balance === 200);

    let totals = stayTotals(d.bookings.filter(b => b.status !== 'cancelled'), S, d.bookings);
    T.check('the unlinked receipt is counted on its own line, not dropped', totals.USD.unlinked === 100 && totals.USD.unlinkedReceipts.length === 1, JSON.stringify(totals.USD.unlinked));

    const common = { units: d.units, charges: d.charges, payments: S, settings: d.settings, session: d.currentUser, bookings: d.bookings, tenancies: d.tenancies, expenses: d.expenses };
    let dash = textOf(renderToStaticMarkup(h(Dashboard, { ...common, onRecordPayment: async () => ({}), onNavigateToTab: () => {} })));
    const outstanding = dash.match(/Balance outstanding (\S+) USD (\S+) JMD/) || [];
    // USD live stays: A1 Sept 0, A1 late 0, B2 Oct 200; JMD: C16 2,000.
    T.check('Dashboard balance outstanding is read from the receipts: $200 and J$2,000', outstanding[1] === '$200.00' && outstanding[2] === 'J$2,000.00', outstanding[0]);
    const paidLine = dash.match(/Paid toward stays (\S+) USD (\S+) JMD/) || [];
    T.check('Dashboard paid toward stays: $1,300 (750 + 450 + 100) and J$8,000 net of the refund', paidLine[1] === '$1,300.00' && paidLine[2] === 'J$8,000.00', paidLine[0]);
    T.check('the unlinked receipt is visible on the Dashboard, not dropped', /Plus \$100\.00 USD on 1 booking receipt not linked to a reservation/.test(dash), dash.slice(dash.indexOf('Paid toward'), dash.indexOf('Paid toward') + 300));

    // Now link it through the receipt correction.
    const link = await c.put(`/api/payments/${old.id}`, { reason: 'corrected in test', forBookingId: octStay.id });
    T.check('an old receipt can be linked to its stay through the correction path', link.status === 200 && link.body?.payment?.forBookingId === octStay.id, JSON.stringify(link.body));
    const badLink = await c.put(`/api/payments/${old.id}`, { reason: 'corrected in test', forBookingId: aId });
    T.check('and the correction path checks the villa too', badLink.status === 400 && badLink.body?.error === 'That reservation is at A1, not B2. A receipt can only pay toward a stay at the same villa.', JSON.stringify(badLink.body));
    d = await db();
    totals = stayTotals(d.bookings.filter(b => b.status !== 'cancelled'), d.payments, d.bookings);
    T.check('once linked, it reduces that stay and leaves the unlinked line', totals.USD.unlinked === 0 && totals.USD.outstanding === 100, JSON.stringify({ u: totals.USD.unlinked, o: totals.USD.outstanding }));
    dash = textOf(renderToStaticMarkup(h(Dashboard, { ...common, payments: d.payments, bookings: d.bookings, onRecordPayment: async () => ({}), onNavigateToTab: () => {} })));
    T.check('and the Dashboard follows: $100 outstanding, no unlinked line', /Balance outstanding \$100\.00 USD/.test(dash) && !/not linked to a reservation/.test(dash));

    // Voiding a balance receipt puts the balance back, and leaves the deposit alone.
    const bal = d.payments.find(p => p.forBookingId === aId);
    must('void the A1 balance receipt', await c.post(`/api/payments/${bal.id}/reverse`, { reversalReason: 'Entered against the wrong stay' }));
    d = await db();
    const aAfter = d.bookings.find(b => b.id === aId);
    T.check('voiding a balance receipt does not touch the reservation deposit', aAfter.depositPaid === 300 && d.payments.find(p => p.bookingId === aId)?.status === 'completed');
    T.check('and the stay owes the 450 again (only completed receipts count)', stayMoney(aAfter, d.payments).balance === 450);

    // The guest receipt, the e-mailed copy and the reservations report read the same figure.
    const c16b = d.bookings.find(b => b.id === c16.id);
    const guest = textOf(renderToStaticMarkup(h(GuestStayReceipt, { booking: c16b, payments: d.payments, unit: { id: 'unit-16', number: 'C16' }, generatedBy: 'Desk', onClose: () => {} })));
    T.check('guest receipt: C16 paid J$8,000, J$2,000 due on arrival', /J\$8,000\.00/.test(guest) && /Balance due on arrival JMD J\$2,000\.00/.test(guest) && !/PAID IN FULL/i.test(guest), guest.slice(guest.indexOf('Stay total'), guest.indexOf('Stay total') + 160));
    const mail = buildStayReceiptEmail(c16b, { id: 'unit-16', number: 'C16' }, stayMoney(c16b, d.payments)).body;
    T.check('the e-mailed receipt says the same', /Paid {9}: JMD J\$8,000\.00/.test(mail) && /Balance due {2}: JMD J\$2,000\.00/.test(mail), mail);
    const report = textOf(renderToStaticMarkup(h(ReservationsReport, { bookings: d.bookings, payments: d.payments, from: '2026-10-01', to: '2026-10-31', generatedBy: 'Desk', onClose: () => {} })));
    T.check('reservations report: C16 row paid J$8,000, balance J$2,000', /Guest C16 .*?J\$10,000\.00 J\$8,000\.00 J\$2,000\.00/.test(report), report.slice(report.indexOf('Guest C16'), report.indexOf('Guest C16') + 160));

    /* ================= closed months: the deposit date cannot reach into one ================= */
    const close = await c.post('/api/periods/close', { through: '2026-09', confirmWithFaults: true });
    T.check('September closes', close.status === 200, JSON.stringify(close.body));
    const intoClosed = await book({ unitId: 'unit-2', guestName: 'Too Late', checkIn: '2026-12-01', checkOut: '2026-12-03', amount: 200, currency: 'USD', depositPaid: 50, depositReceivedOn: '2026-09-20' });
    T.check(
      'a new deposit dated in a closed month is refused, in words',
      intoClosed.status === 400 && intoClosed.body?.error === 'The deposit receipt would be dated 2026-09-20, in a month that has been closed (books closed through 2026-09). Reopen the period first, with a reason.',
      JSON.stringify(intoClosed.body)
    );
    const outOfClosed = await c.put(`/api/bookings/${aId}`, { editReason: 'Test correction', depositReceivedOn: '2026-10-01' });
    T.check(
      'and a deposit in a closed month cannot be re-dated out of it through the reservation',
      outOfClosed.status === 400 && outOfClosed.body?.error === 'The deposit receipt would be dated 2026-09-05, in a month that has been closed (books closed through 2026-09). Reopen the period first, with a reason.',
      JSON.stringify(outOfClosed.body)
    );
    const octDep = (await db()).payments.find(p => p.bookingId === octStay.id);
    const viaReceipt = await c.put(`/api/payments/${octDep.id}`, { reason: 'corrected in test', date: '2026-09-30' });
    T.check('nor moved into one through the receipt (the closed-period guard)', viaReceipt.status === 409 && /(Money dated in or before 2026-09, a month that has been closed, no longer matches what was closed|would change money dated in or before 2026-09, a month that has been closed)/.test(viaReceipt.body?.error || ''), JSON.stringify(viaReceipt.body));
    d = await db();
    T.check('nothing moved', d.payments.find(p => p.bookingId === aId)?.date === '2026-09-05' && d.payments.find(p => p.id === octDep.id)?.date === '2026-10-01');
  } finally {
    await srv.stop();
    cleanup();
  }
  return T.done();
}
