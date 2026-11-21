/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Short-stay money defects found by the stay hunt, 2026-11-20.
 *
 *   1. A part-refunded deposit receipt was rewritten by any later edit (500 less
 *      200 refunded became 300 less 200), losing the refund twice.
 *   2. Cancelling voided a deposit really received, erasing a forfeited deposit
 *      from income. Now the cancel says refund, or void if entered by mistake (Ro, 2026-11-20).
 *   3. Calendar sync (open to juniors) cancelled stays carrying money and moved
 *      completed stays.
 *   4. A stay's currency or villa could change after receipts were linked.
 *   5. Observations dropped guest debts from earlier stays and read "owed at" with
 *      receipts dated after it.
 *   6. Money held for guests (overpaid, cancelled) appeared in no observation.
 *   7. A stay could go complimentary with a pending receipt, then take the money.
 *   8. The reservations report counted closed dates and whole stays across months.
 *   9. An 'Other' feed imported reservations as closed dates.
 *  10. Receipts for overpaid and cancelled stays said "paid in full".
 *  11. A junior could move an upcoming stay into the past, making it settled.
 *
 * Each refusal is paired with a positive control, so a guard that merely broke
 * everything cannot pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Stay hunt fixes: refunds, cancels, feeds, currency, observations, reports';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stayhunt-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { GuestStayReceipt, ReservationsReport } from './src/components/Bookings';
        export { buildStayReceiptEmail } from './src/lib/email';
        export { stayMoney, receiptStanding, isClosedDates } from './src/lib/stays';
        export { observationsFor } from './src/lib/observations';
        export { collectedInPeriod } from './src/lib/finance';
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
  return { mod, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const textOf = html =>
  html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ymd = day => day.replace(/-/g, '');

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, dir, cleanup } = await loadModules(projectRoot);
  const { React, renderToStaticMarkup, GuestStayReceipt, ReservationsReport, buildStayReceiptEmail, stayMoney, receiptStanding, isClosedDates, observationsFor, collectedInPeriod } = mod;
  const h = React.createElement;
  const feedDir = path.join(dir, 'feeds');
  fs.mkdirSync(feedDir);
  const TODAY = localToday();
  const srv = await startServer({
    port,
    adminPassword: 'Hunt-1234!',
    projectRoot,
    // Quoted, because the project folder has spaces in its path ("River Oaks"),
    // which split an unquoted --require. Forward slashes, because NODE_OPTIONS
    // treats a backslash inside quotes as an escape: on Windows CI
    // D:\a\VDS_1\test\feed-stub.cjs became D:aVDS_1test... (v1.16.21 build).
    env: { NODE_OPTIONS: `--require "${path.join(projectRoot, 'test', 'feed-stub.cjs').replace(/\\/g, '/')}"`, VDS_TEST_FEED_DIR: feedDir }
  });
  const setup = [];
  const must = (what, r) => {
    if (!r || r.status >= 400) setup.push(`${what}: ${r?.status} ${JSON.stringify(r?.body).slice(0, 200)}`);
    return r;
  };

  try {
    const a = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(a, 'Hunt-1234!', 'HuntNew-9876!');
    const shortLet = (number, currency) => ({ number, ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency, maintCurrency: 'JMD', maintDueDay: 1 });
    for (const [id, num, cur] of [['unit-1', 'A1', 'USD'], ['unit-2', 'A3', 'USD'], ['unit-3', 'A4', 'JMD'], ['unit-4', 'B6', 'USD'], ['unit-5', 'C14', 'USD'], ['unit-6', 'C16', 'JMD'], ['unit-7', 'D1', 'USD'], ['unit-8', 'D2', 'USD']]) {
      must(`villa ${num}`, await a.put(`/api/units/${id}`, shortLet(num, cur)));
    }
    await a.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    must('junior password', await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' }));

    const book = async b => must(`book ${b.guestName}`, await a.post('/api/bookings', { source: 'Direct', ...b }))?.body?.booking;
    const pay = async p => must(`pay ${p.payerName}`, await a.post('/api/payments', { category: 'Booking', method: 'Cash', receivedNow: true, ...p }))?.body?.payment;
    const db = async () => (await a.get('/api/db')).body;
    const deposit = (d, b) => d.payments.find(p => p.bookingId === b.id);
    const obs = (d, currency, from, to) =>
      observationsFor({ units: d.units, tenancies: d.tenancies, bookings: d.bookings, charges: d.charges, payments: d.payments, expenses: d.expenses, utilities: d.utilities, currency, from, to, book: 'ispo' });
    const owedLines = list => list.filter(o => /is owed at/.test(o.text)).flatMap(o => o.details || []).join(' | ');

    /* ================= 1. a part refund survives later edits ================= */
    const g1 = await book({ unitId: 'unit-1', guestName: 'Gina Partial', checkIn: addDays(TODAY, 11), checkOut: addDays(TODAY, 15), currency: 'USD', amount: 1000, depositPaid: 500, depositReceivedOn: addDays(TODAY, -18) });
    let d = await db();
    must('part refund', await a.post(`/api/payments/${deposit(d, g1).id}/refund`, { amount: 200, refundedOn: addDays(TODAY, -15), reason: 'Part refund agreed', method: 'Cash' }));
    const e1 = await a.put(`/api/bookings/${g1.id}`, { guestPhone: '876-555-0101', editReason: 'Add guest phone number' });
    d = await db();
    let r1 = deposit(d, g1);
    T.check('1: an edit after a part refund leaves the receipt at 500 with 200 refunded', e1.status === 200 && r1.amount === 500 && r1.refundedAmount === 200, `${e1.status} ${JSON.stringify({ a: r1.amount, r: r1.refundedAmount })}`);
    T.check('1: the stay still reads 300 paid, 700 due', stayMoney(d.bookings.find(b => b.id === g1.id), d.payments).paid === 300 && stayMoney(d.bookings.find(b => b.id === g1.id), d.payments).balance === 700);
    const e1b = await a.put(`/api/bookings/${g1.id}`, { guestName: 'Gina Partial-Smith', editReason: 'Name spelled wrong' });
    d = await db();
    r1 = deposit(d, g1);
    T.check('1: and a second edit still does not touch it', e1b.status === 200 && r1.amount === 500 && r1.refundedAmount === 200, JSON.stringify({ a: r1.amount, r: r1.refundedAmount }));
    const g1c = await book({ unitId: 'unit-2', guestName: 'Control Reprice', checkIn: addDays(TODAY, 11), checkOut: addDays(TODAY, 15), currency: 'USD', amount: 1000, depositPaid: 400, depositReceivedOn: addDays(TODAY, -18) });
    const e1c = await a.put(`/api/bookings/${g1c.id}`, { depositPaid: 450, editReason: 'Deposit was really 450' });
    d = await db();
    T.check('1 control: a deposit really changed on an unrefunded receipt still re-prices it', e1c.status === 200 && deposit(d, g1c).amount === 450, `${e1c.status} ${deposit(d, g1c)?.amount}`);

    /* ================= 2. cancelling with a deposit received asks what happened ================= */
    const mkCancel = (unitId, guestName, start) =>
      book({ unitId, guestName, checkIn: addDays(TODAY, start), checkOut: addDays(TODAY, start + 3), currency: 'USD', amount: 1200, depositPaid: 400, depositReceivedOn: addDays(TODAY, -3) });
    const keepStay = await mkCancel('unit-4', 'Jack Forfeit', 30);
    const bare = await a.put(`/api/bookings/${keepStay.id}`, { status: 'cancelled', editReason: 'Guest no-show, deposit forfeited' });
    d = await db();
    T.check('2: a cancel with a deposit received and no outcome is refused, with a code', bare.status === 400 && bare.body?.code === 'deposit-outcome-required' && /refund it to the guest, or void the receipt if the deposit was entered by mistake/.test(bare.body?.error || ''), `${bare.status} ${JSON.stringify(bare.body).slice(0, 200)}`);
    T.check('2: and the stay and receipt are untouched', d.bookings.find(b => b.id === keepStay.id).status === 'confirmed' && deposit(d, keepStay).status === 'completed');
    const bogus = await a.put(`/api/bookings/${keepStay.id}`, { status: 'cancelled', depositOutcome: 'lose', editReason: 'Guest no-show, deposit forfeited' });
    T.check('2: an unknown outcome is refused too', bogus.status === 400 && bogus.body?.code === 'deposit-outcome-required', String(bogus.status));
    // Ro, 2026-11-20: no deposit is kept as a cancellation fee. "keep" is refused like any unknown outcome.
    const kept = await a.put(`/api/bookings/${keepStay.id}`, { status: 'cancelled', depositOutcome: 'keep', editReason: 'Guest no-show, deposit forfeited' });
    d = await db();
    T.check('2: keeping a deposit as a cancellation fee is not an option', kept.status === 400 && kept.body?.code === 'deposit-outcome-required' && d.bookings.find(b => b.id === keepStay.id).status === 'confirmed', `${kept.status} ${kept.body?.code}`);
    const keptB = d.bookings.find(b => b.id === keepStay.id);
    T.check('2: and the receipt stays received, untouched', deposit(d, keepStay).status === 'completed' && !keptB.depositOutcome, JSON.stringify(keptB.depositOutcome));

    const refundStay = await mkCancel('unit-4', 'Rita Refund', 40);
    const refunded = await a.put(`/api/bookings/${refundStay.id}`, { status: 'cancelled', depositOutcome: 'refund', editReason: 'Guest cancelled in time' });
    d = await db();
    const rr = deposit(d, refundStay);
    T.check('2 refund: the receipt stands, refunded in full, never voided', refunded.status === 200 && rr.status === 'completed' && rr.refundedAmount === 400 && rr.refundedOn === TODAY, `${refunded.status} ${JSON.stringify(rr && { s: rr.status, r: rr.refundedAmount })}`);
    T.check('2 refund: nothing is held for the guest afterwards', stayMoney(d.bookings.find(b => b.id === refundStay.id), d.payments).paid === 0);
    T.check('2 refund: audited', d.auditLogs.some(x => x.recordId === rr.id && /Cancelled stay: refunded USD 400/.test(x.action)));
    const voidStay = await mkCancel('unit-4', 'Val Mistake', 50);
    const voided = await a.put(`/api/bookings/${voidStay.id}`, { status: 'cancelled', depositOutcome: 'void', editReason: 'Deposit entered by mistake' });
    d = await db();
    T.check('2 void: only when chosen, the receipt is voided', voided.status === 200 && deposit(d, voidStay).status === 'reversed', `${voided.status} ${deposit(d, voidStay)?.status}`);
    const noDep = await book({ unitId: 'unit-4', guestName: 'No Deposit', checkIn: addDays(TODAY, 60), checkOut: addDays(TODAY, 62), currency: 'USD', amount: 500 });
    const plainCancel = await a.put(`/api/bookings/${noDep.id}`, { status: 'cancelled', editReason: 'Guest cancelled' });
    T.check('2 control: a stay with no money held cancels without being asked', plainCancel.status === 200, `${plainCancel.status} ${plainCancel.body?.error}`);
    d = await db();
    const noDepB = d.bookings.find(b => b.id === noDep.id);
    const noDepReceipt = textOf(renderToStaticMarkup(h(GuestStayReceipt, { booking: noDepB, payments: d.payments, unit: undefined, generatedBy: 'Desk', onClose: () => {} })));
    T.check('10: a cancelled stay with no money is never PAID IN FULL', noDepB.status === 'cancelled' && !/PAID IN FULL/i.test(noDepReceipt) && /Cancelled/.test(noDepReceipt), noDepReceipt.slice(0, 400));

    /* ================= 4. currency and villa are fixed once receipts are linked ================= */
    const hal = await book({ unitId: 'unit-2', guestName: 'Hal Currency', checkIn: addDays(TODAY, 20), checkOut: addDays(TODAY, 23), currency: 'USD', amount: 600 });
    await pay({ unitId: 'unit-2', amount: 400, currency: 'USD', date: addDays(TODAY, -2), payerName: 'Hal', forBookingId: hal.id });
    const toJmd = await a.put(`/api/bookings/${hal.id}`, { currency: 'JMD', amount: 90000, editReason: 'Guest will pay in JMD' });
    T.check('4: currency cannot change once a receipt is linked', toJmd.status === 400 && toJmd.body?.code === 'stay-has-receipts', `${toJmd.status} ${JSON.stringify(toJmd.body).slice(0, 200)}`);
    const move = await a.put(`/api/bookings/${hal.id}`, { unitId: 'unit-5', editReason: 'Moved guest to C14' });
    T.check('4: nor the villa', move.status === 400 && move.body?.code === 'stay-has-receipts', `${move.status} ${move.body?.error}`);
    const pendingHal = await book({ unitId: 'unit-5', guestName: 'Pending Pat', checkIn: addDays(TODAY, 20), checkOut: addDays(TODAY, 23), currency: 'USD', amount: 600 });
    must('pending receipt', await a.post('/api/payments', { unitId: 'unit-5', category: 'Booking', amount: 100, currency: 'USD', date: TODAY, method: 'Cheque', payerName: 'Pat', forBookingId: pendingHal.id }));
    const movePending = await a.put(`/api/bookings/${pendingHal.id}`, { currency: 'JMD', amount: 90000, editReason: 'Guest will pay in JMD' });
    T.check('4: a pending receipt holds them too', movePending.status === 400 && movePending.body?.code === 'stay-has-receipts', String(movePending.status));
    const free = await book({ unitId: 'unit-7', guestName: 'Free Mover', checkIn: addDays(TODAY, 20), checkOut: addDays(TODAY, 23), currency: 'USD', amount: 600 });
    const freeMove = await a.put(`/api/bookings/${free.id}`, { currency: 'JMD', amount: 90000, unitId: 'unit-8', editReason: 'Moved and repriced' });
    T.check('4 control: a stay with no receipts can change currency and villa', freeMove.status === 200 && freeMove.body?.booking?.currency === 'JMD' && freeMove.body?.booking?.unitId === 'unit-8', `${freeMove.status} ${freeMove.body?.error}`);
    const usdReceipt = { id: 'p-x', status: 'completed', amount: 400, currency: 'USD', date: TODAY, forBookingId: 'b-x' };
    T.check('4: stayMoney never counts a receipt in another currency', stayMoney({ id: 'b-x', amount: 90000, status: 'confirmed', currency: 'JMD' }, [usdReceipt]).paid === 0);
    T.check('4 control: and counts one in the stay currency', stayMoney({ id: 'b-x', amount: 600, status: 'confirmed', currency: 'USD' }, [usdReceipt]).paid === 400);

    /* ================= 7. complimentary and pending money ================= */
    const ivy = await book({ unitId: 'unit-3', guestName: 'Ivy Comp', checkIn: addDays(TODAY, 50), checkOut: addDays(TODAY, 52), currency: 'JMD', amount: 30000 });
    const pend = must('pending JMD', await a.post('/api/payments', { unitId: 'unit-3', category: 'Booking', amount: 30000, currency: 'JMD', date: TODAY, method: 'Cheque', payerName: 'Ivy', forBookingId: ivy.id }))?.body?.payment;
    const comp = await a.put(`/api/bookings/${ivy.id}`, { complimentary: true, complimentaryReason: 'Owner says free', amount: 0, editReason: 'Owner says free' });
    T.check('7: a stay with a pending receipt cannot be marked complimentary', comp.status === 400 && /already been received/.test(comp.body?.error || ''), `${comp.status} ${comp.body?.error}`);
    const conf = await a.post(`/api/payments/${pend?.id}/confirm`, {});
    d = await db();
    const ivyB = d.bookings.find(b => b.id === ivy.id);
    T.check('7: a complimentary stay never ends up holding money', !(ivyB.complimentary && stayMoney(ivyB, d.payments).received > 0), JSON.stringify({ comp: ivyB.complimentary, conf: conf.status }));
    T.check('7 control: confirming it on a paying stay works', ivyB.complimentary || conf.status === 200, `${conf.status} ${conf.body?.error}`);

    /* ================= 11. a junior cannot make a stay settled by moving it ================= */
    const perms = (await db()).settings.rolePermissions.JUNIOR_OFFICER;
    must('grant junior editBookings', await a.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms, editBookings: true, modifySettledRecords: false } } }));
    const up = await book({ unitId: 'unit-7', guestName: 'Upcoming Una', checkIn: addDays(TODAY, 40), checkOut: addDays(TODAY, 42), currency: 'USD', amount: 500 });
    const past = await jr.put(`/api/bookings/${up.id}`, { checkIn: addDays(TODAY, -6), checkOut: addDays(TODAY, -4), editReason: 'Moved to past' });
    T.check('11: a junior cannot move an upcoming stay onto dates already over', past.status === 403 && past.body?.code === 'completed-stay-locked', `${past.status} ${past.body?.error}`);
    const onToday = await jr.put(`/api/bookings/${up.id}`, { checkIn: addDays(TODAY, -2), checkOut: TODAY, editReason: 'Leaves today' });
    T.check('11: nor onto a departure today (completed on the day)', onToday.status === 403, String(onToday.status));
    const later = await jr.put(`/api/bookings/${up.id}`, { checkIn: addDays(TODAY, 44), checkOut: addDays(TODAY, 46), editReason: 'Guest moved dates' });
    T.check('11 control: a junior may still move it to other future dates', later.status === 200, `${later.status} ${later.body?.error}`);
    const adminPast = await a.put(`/api/bookings/${up.id}`, { checkIn: addDays(TODAY, -6), checkOut: addDays(TODAY, -4), editReason: 'Entered late, stay happened' });
    T.check('11 control: a role that may modify settled records can', adminPast.status === 200, `${adminPast.status} ${adminPast.body?.error}`);

    /* ================= 5 + 6. observations ================= */
    const leo = await book({ unitId: 'unit-6', guestName: 'Leo Owes', checkIn: addDays(TODAY, -70), checkOut: addDays(TODAY, -65), currency: 'JMD', amount: 100000, depositPaid: 25000, depositReceivedOn: addDays(TODAY, -75) });
    const soon = await book({ unitId: 'unit-6', guestName: 'Sam Soon', checkIn: addDays(TODAY, 5), checkOut: addDays(TODAY, 8), currency: 'JMD', amount: 40000 });
    d = await db();
    const recent = obs(d, 'JMD', addDays(TODAY, -30), TODAY);
    T.check('5: a guest debt from a stay before the period is still owed at its end', /Leo Owes.*J\$75,000\.00 of J\$100,000\.00 unpaid/.test(owedLines(recent)), owedLines(recent));
    T.check('5: a stay not yet begun is not owed yet (payable on arrival)', !/Sam Soon/.test(owedLines(recent)) && !!soon);
    await pay({ unitId: 'unit-6', amount: 75000, currency: 'JMD', date: addDays(TODAY, -5), payerName: 'Leo', forBookingId: leo.id });
    d = await db();
    const atStay = obs(d, 'JMD', addDays(TODAY, -80), addDays(TODAY, -60));
    T.check('5: owed at the end of an earlier period ignores money received after it', /Leo Owes.*J\$75,000\.00 of J\$100,000\.00 unpaid/.test(owedLines(atStay)), owedLines(atStay));
    const settled = obs(d, 'JMD', addDays(TODAY, -30), TODAY);
    T.check('5 control: once paid, it is no longer owed at a later date', !/Leo Owes/.test(owedLines(settled)), owedLines(settled));

    const kim = await book({ unitId: 'unit-5', guestName: 'Kim Held', checkIn: addDays(TODAY, 70), checkOut: addDays(TODAY, 73), currency: 'USD', amount: 900 });
    await pay({ unitId: 'unit-5', amount: 450, currency: 'USD', date: addDays(TODAY, -1), payerName: 'Kim', forBookingId: kim.id });
    must('cancel Kim', await a.put(`/api/bookings/${kim.id}`, { status: 'cancelled', editReason: 'Guest cancelled' }));
    const over = await book({ unitId: 'unit-8', guestName: 'Olly Over', checkIn: addDays(TODAY, -10), checkOut: addDays(TODAY, -8), currency: 'USD', amount: 300 });
    await pay({ unitId: 'unit-8', amount: 400, currency: 'USD', date: addDays(TODAY, -9), payerName: 'Olly', forBookingId: over.id });
    d = await db();
    const usd = obs(d, 'USD', addDays(TODAY, -30), TODAY);
    const all = usd.map(o => `${o.text} ${(o.details || []).join(' ')}`).join(' | ');
    const heldLines = usd.flatMap(o => o.details || []).filter(l => /held beyond the stay price/.test(l)).join(' | ');
    T.check('6: money held on a cancelled stay is listed to refund or apply', /Held for guests: refund or apply/.test(all) && /Kim Held, .*\$450\.00 held beyond the stay price on a cancelled stay\. Refund it/.test(heldLines), heldLines || all.slice(0, 400));
    T.check('6: so is an overpayment on a live stay', /Olly Over, .*\$100\.00 held beyond the stay price\. Refund it/.test(heldLines), heldLines);
    T.check('6: and none of it is counted as owed to us', !/Kim Held|Olly Over/.test(owedLines(usd)), owedLines(usd));
    const leakObs = usd.find(o => /where money leaked/.test(o.text));
    T.check('6: nor counted as money leaked (a liability, not a loss)', !!leakObs && leakObs.atRisk < 1000, JSON.stringify({ atRisk: leakObs?.atRisk }));
    T.check('6 control: an overpaid stay is not listed when nothing is over', !/Gina Partial/.test(heldLines));

    /* ================= 10. receipts for overpaid and cancelled stays ================= */
    const overB = d.bookings.find(b => b.id === over.id);
    const overM = stayMoney(overB, d.payments);
    T.check('10: an overpaid stay stands as overpaid, not paid', receiptStanding({ amount: 300, balanceDue: 0, overpaid: 100 }) === 'overpaid' && receiptStanding({ amount: 300, balanceDue: 0, status: 'cancelled' }) === 'cancelled');
    T.check('10 control: a stay paid exactly is still paid', receiptStanding({ amount: 300, balanceDue: 0, overpaid: 0 }) === 'paid');
    const overReceipt = textOf(renderToStaticMarkup(h(GuestStayReceipt, { booking: overB, payments: d.payments, unit: d.units.find(u => u.id === 'unit-8'), generatedBy: 'Desk', onClose: () => {} })));
    T.check('10: the printed receipt of an overpaid stay says what is owed back, never PAID IN FULL', !/PAID IN FULL/i.test(overReceipt) && /Overpaid, owed back to guest USD \$100\.00/.test(overReceipt), overReceipt.slice(0, 500));
    const overMail = buildStayReceiptEmail(overB, undefined, overM).body;
    T.check('10: and so does the email', /owed back to you/.test(overMail) && /\$100\.00/.test(overMail), overMail);
    const kimB = d.bookings.find(b => b.id === kim.id);
    const kimReceipt = textOf(renderToStaticMarkup(h(GuestStayReceipt, { booking: kimB, payments: d.payments, unit: undefined, generatedBy: 'Desk', onClose: () => {} })));
    T.check('10: a cancelled stay renders cancelled, with the money owed back', !/PAID IN FULL/i.test(kimReceipt) && /Reservation Cancelled/.test(kimReceipt) && /Owed back to guest USD \$450\.00/.test(kimReceipt), kimReceipt.slice(0, 500));
    const kimMail = buildStayReceiptEmail(kimB, undefined, stayMoney(kimB, d.payments)).body;
    T.check('10: and its email says cancelled', /has been cancelled/.test(kimMail) && /Owed back to you : USD \$450\.00/.test(kimMail), kimMail);
    const g1B = d.bookings.find(b => b.id === g1.id);
    const g1Mail = buildStayReceiptEmail(g1B, undefined, stayMoney(g1B, d.payments)).body;
    T.check('10 control: a stay with a balance still reads payable on arrival', /payable on arrival/.test(g1Mail) && !/owed back/.test(g1Mail), g1Mail);

    /* ================= 3 + 9. calendar sync never changes a stay carrying money ================= */
    const ev = (uid, s, e, summary, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${ymd(s)}\r\nDTEND;VALUE=DATE:${ymd(e)}\r\nSUMMARY:${summary}\r\n${extra}END:VEVENT\r\n`;
    const cal = evs => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${evs.join('')}END:VCALENDAR\r\n`;
    const D = n => addDays(TODAY, n);
    const v1 = [
      ev('u-dep', D(90), D(94), 'Reserved'),
      ev('u-paid', D(100), D(104), 'Reserved'),
      ev('u-done', D(-40), D(-36), 'Reserved'),
      ev('u-free', D(110), D(113), 'Reserved'),
      ev('u-move', D(120), D(123), 'Reserved')
    ];
    fs.writeFileSync(path.join(feedDir, 'a1.ics'), cal(v1));
    fs.writeFileSync(path.join(feedDir, 'other.ics'), cal([ev('o-res', D(90), D(93), 'Reserved - Pat VRBO'), ev('o-blk', D(95), D(97), 'Not available')]));
    const f1 = must('feed a1', await a.post('/api/ical/feeds', { unitId: 'unit-1', url: 'https://cal.feed-stub.test/a1.ics', source: 'Airbnb' }))?.body?.feed;
    const f2 = must('feed other', await a.post('/api/ical/feeds', { unitId: 'unit-2', url: 'https://cal.feed-stub.test/other.ics', source: 'Other' }))?.body?.feed;
    const s1 = await jr.post('/api/ical/sync', {});
    T.check('3 setup: a junior officer runs the first sync', s1.status === 200 && (s1.body?.results || []).every(r => r.ok), JSON.stringify(s1.body).slice(0, 300));
    d = await db();
    const byUid = u => d.bookings.find(b => b.externalUid === u);
    T.check("9: an 'Other' feed's reservation is a guest, not closed dates", byUid('o-res') && !isClosedDates(byUid('o-res')) && byUid('o-res').guestName === 'Pat VRBO', JSON.stringify(byUid('o-res') && { s: byUid('o-res').source }));
    T.check("9 control: an 'Other' feed's block is still closed dates", byUid('o-blk') && isClosedDates(byUid('o-blk')), byUid('o-blk')?.source);
    const price = (u, body) => a.put(`/api/bookings/${byUid(u).id}`, { editReason: 'Enter the stay value', ...body });
    must('price u-dep', await price('u-dep', { amount: 800, depositPaid: 200, depositReceivedOn: D(-1), guestName: 'Ned Air' }));
    must('price u-paid', await price('u-paid', { amount: 500, guestName: 'Ola Air' }));
    await pay({ unitId: 'unit-1', amount: 500, currency: 'USD', date: D(-1), payerName: 'Ola', forBookingId: byUid('u-paid').id });
    fs.writeFileSync(
      path.join(feedDir, 'a1.ics'),
      cal([
        ev('u-dep', D(90), D(94), 'Reserved', 'STATUS:CANCELLED\r\n'),
        ev('u-paid', D(101), D(105), 'Reserved'),
        ev('u-done', D(-40), D(-36), 'Reserved', 'STATUS:CANCELLED\r\n'),
        ev('u-free', D(110), D(113), 'Reserved', 'STATUS:CANCELLED\r\n'),
        ev('u-move', D(121), D(124), 'Reserved')
      ])
    );
    const s2 = await jr.post('/api/ical/sync', { feedId: f1?.id });
    const res2 = s2.body?.results?.[0] || {};
    d = await db();
    T.check('3: a stay with a deposit is not cancelled by the feed', byUid('u-dep').status === 'confirmed' && deposit(d, byUid('u-dep'))?.status === 'completed', `${byUid('u-dep').status} ${deposit(d, byUid('u-dep'))?.status}`);
    T.check('3: a stay with a linked payment is not moved by the feed', byUid('u-paid').checkIn === D(100) && byUid('u-paid').checkOut === D(104), `${byUid('u-paid').checkIn}`);
    T.check('3: a completed stay is not cancelled by the feed', byUid('u-done').status === 'confirmed', byUid('u-done').status);
    T.check('3: each is reported as a conflict for a person', (res2.conflicts || []).filter(m => /Ned Air.*has money recorded|Ola Air.*has money recorded|completed stay, a settled record/.test(m)).length === 3 && (res2.conflicts || []).length === 3, JSON.stringify(res2.conflicts));
    T.check('3 control: a stay with no money is still cancelled in place', byUid('u-free').status === 'cancelled', byUid('u-free').status);
    T.check('3 control: and one with no money still follows new dates', byUid('u-move').checkIn === D(121) && byUid('u-move').checkOut === D(124), byUid('u-move').checkIn);
    void f2;

    /* ================= 8. the reservations report ================= */
    const bk = o => ({ id: o.id, unitId: 'unit-1', unitNumber: 'A1', guestName: o.g, guestEmail: '', guestPhone: '', checkIn: o.i, checkOut: o.o, currency: 'USD', amount: o.amt || 0, depositPaid: 0, balanceDue: 0, status: 'confirmed', source: o.src || 'Direct', ...o.x });
    const fixture = [
      bk({ id: 'r1', g: 'Real Guest', i: '2026-11-10', o: '2026-11-12', amt: 400 }),
      bk({ id: 'r2', g: 'Airbnb (Not available)', i: '2026-11-01', o: '2026-11-08', src: 'Blocked' }),
      bk({ id: 'r3', g: 'Span Guest', i: '2026-11-29', o: '2026-12-04', amt: 1000 }),
      bk({ id: 'r4', g: 'Comp Guest', i: '2026-11-20', o: '2026-11-23', x: { complimentary: true, complimentaryReason: 'Owner family' } })
    ];
    const report = textOf(renderToStaticMarkup(h(ReservationsReport, { bookings: fixture, payments: [], from: '2026-11-01', to: '2026-11-30', generatedBy: 'Desk', onClose: () => {} })));
    const totals = report.slice(report.indexOf('USD totals'));
    T.check('8: closed dates and nights outside the period are not sold (2 + 2 nights)', /Nights sold in the period 4 /.test(totals), totals.slice(0, 400));
    T.check('8: complimentary nights are shown on their own, not as sold', /Complimentary nights in the period \(not sold\) 3 /.test(totals), totals.slice(0, 400));
    T.check('8: a stay spanning the month is prorated by its nights, and says so', /prorated by night\) \$800\.00/.test(totals) && /Full value of these stays \$1,400\.00/.test(totals), totals.slice(0, 400));
    const inside = textOf(renderToStaticMarkup(h(ReservationsReport, { bookings: [fixture[0]], payments: [], from: '2026-11-01', to: '2026-11-30', generatedBy: 'Desk', onClose: () => {} })));
    T.check('8 control: a stay wholly inside the period counts in full, unlabelled', /Nights sold in the period 2 Stay value \$400\.00/.test(inside), inside.slice(inside.indexOf('USD totals'), inside.indexOf('USD totals') + 200));

    for (const s of setup) T.check('setup', false, s);
    T.check('setup completed without a refusal', setup.length === 0, setup.join(' || '));
    {
      const ui = (await import('node:fs')).readFileSync((await import('node:path')).join(projectRoot, 'src', 'components', 'Bookings.tsx'), 'utf8');
      T.check("2 default: cancelling a stay with a deposit preselects 'refund' (Ro, 2026-11-20)", /useState<'' \| 'refund' \| 'void'>\('refund'\)/.test(ui));
      T.check('2 default: the cancel dialog offers refund, or void if entered by mistake, and no other choice', /<option value="refund">/.test(ui) && /<option value="void">/.test(ui) && !/<option value="keep">/.test(ui));
    }
  } finally {
    await srv.stop();
    cleanup();
  }
  return T.done();
}
