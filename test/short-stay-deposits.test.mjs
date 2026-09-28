/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Short-stay deposits, and who is actually coming and going.
 *
 * Ro, 2026-09-28, from the live system: *"for short term rentals also ensure that
 * if a clients deposit has been fully covered from the short term rentals tab,
 * the receipts ledger's status is automatically updated. for eg. full deposits
 * were received from the guests and confirmed under short term bookings however
 * under receipts ldger the status still says awaiting funds, and i do not want
 * their to be a double count of payments after i have manually confirmed before i
 * apply the fix."*
 *
 * And: *"the general dashboard should show the actual departure in the next 14
 * days and not just be a heading based on dates."*
 *
 * The rules, in the property's own terms:
 *
 *   1. A deposit entered on a reservation is money in hand. It reaches the
 *      receipts ledger as received, with a receipt number, without anybody
 *      answering the same question on a second screen.
 *   2. Changing a reservation never puts the same deposit on the ledger twice.
 *   3. A deposit logged before this rule existed is brought onto the ledger in
 *      place — the same receipt, not a second one beside it.
 *   4. A deposit typed in separately, with no tie to the reservation, is the one
 *      shape that does double count. It is found and named, and nothing is
 *      changed without a person deciding.
 *   5. A guest who genuinely pays a different amount is not called a duplicate.
 *   6. Who is arriving and departing comes from the dates. A stay nobody ever
 *      checked in is still a departure when its departure day arrives.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Short-stay deposits and real arrivals and departures';

async function loadLib(projectRoot, relative, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outfile = path.join(dir, 'mod.mjs');
  await build({
    entryPoints: [path.join(projectRoot, relative)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function addDaysTo(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async function run({ port, projectRoot }) {
  /*
   * A data directory this test owns, because it stops the server part-way through
   * and starts it again on the same database — see rule 3.
   */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stays-data-'));
  let srv = await startServer({ port, adminPassword: 'Stays-1234!', projectRoot, dataDir });
  const T = reporter(title);
  const fin = await loadLib(projectRoot, path.join('src', 'lib', 'finance.ts'), 'vds-dep-');
  const stays = await loadLib(projectRoot, path.join('src', 'lib', 'stays.ts'), 'vds-stay-');
  const { bookingDepositFindings } = fin.mod;
  const { stayPhase, isClosedDates, arrivalsWithin, departuresWithin } = stays.mod;

  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Stays-1234!', 'StaysNew-9876!');

    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Villaggio Del Sol',
      status: 'short-term',
      currency: 'USD',
      maintCurrency: 'USD',
      monthlyRent: 0,
      monthlyMaintenance: 200,
      maintDueDay: 1
    });

    const today = new Date().toISOString().slice(0, 10);

    /* ================================================================
     * Rule 1 — a deposit entered is money in hand
     * ================================================================ */

    const made = await c.post('/api/bookings', {
      unitId: 'unit-1',
      guestName: 'Guest One',
      checkIn: addDaysTo(today, 20),
      checkOut: addDaysTo(today, 25),
      amount: 1000,
      depositPaid: 400,
      currency: 'USD',
      source: 'Direct'
    });
    T.check('the reservation was taken', made.status === 200, String(made.body?.error));
    const bookingId = made.body.booking.id;

    let db = (await c.get('/api/db')).body;
    const deposit = db.payments.find(p => p.bookingId === bookingId);

    T.check('entering a deposit puts a receipt on the ledger', !!deposit, 'no receipt was raised');
    T.check(
      'and it reads as received, not as awaiting funds — the person entering it was the person who took the money',
      deposit?.status === 'completed',
      String(deposit?.status)
    );
    T.check('with a receipt number, so it can be given to the guest', /^REC-\d{4}-\d{4}$/.test(String(deposit?.receiptNo)), String(deposit?.receiptNo));
    T.check('for the amount that was entered', deposit?.amount === 400 && deposit?.currency === 'USD', `${deposit?.amount} ${deposit?.currency}`);
    T.check('and it is recorded as a booking receipt, which is ISPO’s income', deposit?.category === 'Booking', String(deposit?.category));

    /* ================================================================
     * Rule 2 — never twice for the same reservation
     * ================================================================ */

    await c.put(`/api/bookings/${bookingId}`, { depositPaid: 500, amount: 1000 });
    await c.put(`/api/bookings/${bookingId}`, { guestName: 'Guest One Renamed', amount: 1000, depositPaid: 500 });
    db = (await c.get('/api/db')).body;
    const forBooking = db.payments.filter(p => p.bookingId === bookingId && p.status !== 'reversed');

    T.check('changing the reservation twice leaves exactly one live receipt against it', forBooking.length === 1, `${forBooking.length} live receipts`);
    T.check('and it follows the deposit that was entered', forBooking[0]?.amount === 500, String(forBooking[0]?.amount));

    /* ================================================================
     * Rule 3 — one logged before the rule changed is brought on in place
     * ================================================================ */

    /*
     * The state Ro is looking at right now, made properly rather than simulated:
     * the server is stopped, the deposit receipt on disk is put back into the
     * shape an older version left it — `pending`, with no receipt number — and the
     * server is started again on that database.
     *
     * No route can un-receive a receipt, which is correct, so this is the only
     * honest way to cover the upgrade path. It is the path the HP actually takes.
     */
    await srv.stop();
    {
      const file = path.join(dataDir, 'db.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      const row = disk.payments.find(p => p.bookingId === bookingId && p.status !== 'reversed');
      row.status = 'pending';
      row.receiptNo = '';
      delete row.receivedBy;
      delete row.receivedAt;
      fs.writeFileSync(file, JSON.stringify(disk, null, 2));
    }
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'StaysNew-9876!' }, { captureCookie: true });

    db = (await c.get('/api/db')).body;
    const older = db.payments.find(p => p.bookingId === bookingId && p.status !== 'reversed');
    T.check(
      'the older shape is genuinely in place before the check — a deposit awaiting funds, with no receipt number',
      older?.status === 'pending' && !older.receiptNo,
      `${older?.status} / ${older?.receiptNo}`
    );

    await c.put(`/api/bookings/${bookingId}`, { amount: 1000, depositPaid: 500 });
    db = (await c.get('/api/db')).body;
    const brought = db.payments.filter(p => p.bookingId === bookingId && p.status !== 'reversed');

    T.check(
      'a deposit left awaiting funds by an older version is brought onto the ledger as received',
      brought.length === 1 && brought[0].status === 'completed',
      `${brought.length} live, status ${brought[0]?.status}`
    );
    T.check(
      'in place — the same receipt, not a second one beside it, so the money is not counted twice',
      brought[0]?.id === older?.id,
      `${brought[0]?.id} vs ${older?.id}`
    );
    T.check('and it is given a receipt number at that point', /^REC-\d{4}-\d{4}$/.test(String(brought[0]?.receiptNo)), String(brought[0]?.receiptNo));

    /* ================================================================
     * Rule 4 — a deposit typed in separately is the real double count
     * ================================================================ */

    const separate = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Booking',
      amount: 500,
      currency: 'USD',
      payerName: 'Guest One Renamed',
      method: 'Cash',
      date: today,
      receivedNow: true
    });
    T.check('a deposit can still be typed straight into the ledger, as it always could', separate.status === 200, String(separate.body?.error));

    db = (await c.get('/api/db')).body;
    const findings = bookingDepositFindings(db.bookings, db.payments);

    T.check(
      'the same deposit entered twice is found — once on the reservation, once on the ledger',
      findings.length === 1 && findings[0].booking.id === bookingId,
      JSON.stringify(findings.map(f => f.booking.id))
    );
    T.check(
      'and the loose receipt is named, so a person can decide which one is real',
      findings[0]?.unlinked.length === 1 && findings[0].unlinked[0].id === separate.body.payment.id,
      JSON.stringify(findings[0]?.unlinked.map(p => p.id))
    );
    T.check(
      'the reservation’s own receipt is not mistaken for the duplicate',
      findings[0]?.linked?.bookingId === bookingId,
      String(findings[0]?.linked?.id)
    );

    /*
     * Nothing was changed by the finding. This is the assertion that makes
     * "nothing is done without a person deciding" a fact rather than a promise.
     */
    T.check(
      'and finding it changed nothing — both receipts are still live and the money is still on the ledger twice',
      db.payments.filter(p => p.category === 'Booking' && p.status === 'completed').length === 2,
      JSON.stringify(db.payments.filter(p => p.category === 'Booking').map(p => p.status))
    );

    /* ---------------- voiding the duplicate clears the finding ---------------- */

    await c.post(`/api/payments/${separate.body.payment.id}/reverse`, {
      reversalReason: 'Duplicate of the deposit entered on the reservation.'
    });
    db = (await c.get('/api/db')).body;
    T.check(
      'voiding the loose receipt clears the finding, because there is nothing left to decide',
      bookingDepositFindings(db.bookings, db.payments).length === 0,
      JSON.stringify(bookingDepositFindings(db.bookings, db.payments).map(f => f.booking.id))
    );

    /* ================================================================
     * Rule 5 — a different amount is a different payment
     * ================================================================ */

    const other = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Booking',
      amount: 123,
      currency: 'USD',
      payerName: 'Guest One Renamed',
      method: 'Cash',
      date: today,
      receivedNow: true
    });
    T.check('a further, genuinely different booking payment is recorded', other.status === 200, String(other.body?.error));
    db = (await c.get('/api/db')).body;
    T.check(
      'a payment of a different amount is not called a duplicate of the deposit',
      bookingDepositFindings(db.bookings, db.payments).length === 0,
      JSON.stringify(bookingDepositFindings(db.bookings, db.payments))
    );

    /* ================================================================
     * Rule 7 — a refunded deposit receipt is never re-priced
     * ================================================================ */

    /*
     * Found by `test/reports-2000.test.mjs`, not by eye, and it is a real
     * misstatement of money. A deposit is receipted, the guest is refunded some
     * of it, and the reservation is then edited to a different deposit: the
     * receipt's amount was overwritten while the refund recorded against it
     * stayed, so the receipt netted to something that was not what the property
     * held — and, where the new deposit was smaller, netted **negative**. Every
     * figure built on "amount less refunds" carried it: booking income on ISPO's
     * book, the operating statement, and deposits held on the dashboard.
     */
    {
      const stay = await c.post('/api/bookings', {
        unitId: 'unit-1',
        guestName: 'Guest Two',
        checkIn: addDaysTo(today, 40),
        checkOut: addDaysTo(today, 44),
        amount: 1000,
        depositPaid: 600,
        currency: 'USD',
        source: 'Direct'
      });
      T.check('a second reservation was taken, with a deposit on it', stay.status === 200, String(stay.body?.error));
      const stayId = stay.body.booking.id;

      let live = (await c.get('/api/db')).body.payments.find(p => p.bookingId === stayId && p.status !== 'reversed');
      const refund = await c.post(`/api/payments/${live.id}/refund`, {
        amount: 250,
        reason: 'Guest shortened the stay.',
        refundedOn: today
      });
      T.check('part of the deposit is refunded to the guest', refund.status === 200, String(refund.body?.error));

      let state = (await c.get('/api/db')).body;
      let booking = state.bookings.find(b => b.id === stayId);
      live = state.payments.find(p => p.id === live.id);
      T.check(
        'the reservation now holds what is left, and the receipt keeps the figure the guest was handed',
        booking.depositPaid === 350 && live.amount === 600 && live.refundedAmount === 250,
        `holds ${booking.depositPaid}, receipt ${live.amount} less ${live.refundedAmount}`
      );

      const rewrite = await c.put(`/api/bookings/${stayId}`, { amount: 1000, depositPaid: 900, guestName: 'Guest Two' });
      T.check('re-typing the deposit on a refunded reservation is refused', rewrite.status === 400, String(rewrite.status));
      T.check(
        'and refused with a code, so a screen can say which record to make instead',
        rewrite.body?.code === 'deposit-receipt-already-refunded',
        String(rewrite.body?.code)
      );
      T.check(
        'the refusal says what to do rather than only saying no',
        /payment/i.test(String(rewrite.body?.error)) && /refund/i.test(String(rewrite.body?.error)),
        String(rewrite.body?.error)
      );

      state = (await c.get('/api/db')).body;
      booking = state.bookings.find(b => b.id === stayId);
      live = state.payments.find(p => p.id === live.id);
      T.check(
        'and nothing moved — the whole change was rolled back, not half applied',
        booking.depositPaid === 350 && live.amount === 600 && live.refundedAmount === 250,
        `holds ${booking.depositPaid}, receipt ${live.amount} less ${live.refundedAmount}`
      );
      T.check(
        'so the receipt still nets to exactly what the reservation says is held',
        live.amount - live.refundedAmount === booking.depositPaid,
        `${live.amount} - ${live.refundedAmount} vs ${booking.depositPaid}`
      );

      const harmless = await c.put(`/api/bookings/${stayId}`, { amount: 1000, depositPaid: 350, guestName: 'Guest Two Renamed' });
      T.check(
        'an edit that leaves the deposit alone is still allowed, so the guard blocks only the thing that is wrong',
        harmless.status === 200,
        String(harmless.body?.error)
      );
    }

    /* ================================================================
     * Rule 8 — arrivals and departures come from the dates
     * ================================================================ */

    /*
     * The rule the dashboard now uses, asserted here on the same helper the
     * dashboard calls. Before this, departures were filtered on
     * `status === 'checked-in'` and arrivals on `status === 'confirmed'` — and
     * nobody checks a guest in or out of an imported stay, so the departures
     * panel was empty whatever was in the calendar, and a stay went on being
     * called an arrival after the guest had left.
     */
    const inResidence = { checkIn: addDaysTo(today, -2), checkOut: addDaysTo(today, 3), status: 'confirmed' };
    const arrivingSoon = { checkIn: addDaysTo(today, 4), checkOut: addDaysTo(today, 9), status: 'confirmed' };
    const longGone = { checkIn: addDaysTo(today, -30), checkOut: addDaysTo(today, -20), status: 'confirmed' };

    T.check(
      'a guest who arrived two days ago and leaves in three is a departure in the next 14 days, though nobody checked them in',
      stayPhase(inResidence, today) === 'in-stay',
      stayPhase(inResidence, today)
    );
    T.check('and is not counted as an arrival, because they are already here', stayPhase(inResidence, today) !== 'upcoming');
    T.check('a guest arriving in four days is an arrival', stayPhase(arrivingSoon, today) === 'upcoming', stayPhase(arrivingSoon, today));
    T.check(
      'a stay that ended last month is neither, though its recorded status still says confirmed',
      stayPhase(longGone, today) === 'completed',
      stayPhase(longGone, today)
    );
    T.check(
      'and dates Airbnb has simply closed are not a guest, so they are not a movement either',
      isClosedDates({ source: 'Unavailable' }) && isClosedDates({ source: 'Blocked' }) && !isClosedDates({ source: 'Direct' }),
      'closed dates were treated as a guest'
    );

    /*
     * The lists the dashboard actually renders, asserted on the same functions it
     * calls. The rules were moved out of the screen for this reason:
     * `react-dom/server` can render a screen but cannot reach a rule written
     * inside one.
     */
    {
      const horizon = addDaysTo(today, 14);
      const calendar = [
        { id: 'in-residence', source: 'Airbnb', ...inResidence },
        { id: 'arriving', source: 'Airbnb', ...arrivingSoon },
        { id: 'gone', source: 'Airbnb', ...longGone },
        { id: 'far-off', source: 'Direct', checkIn: addDaysTo(today, 40), checkOut: addDaysTo(today, 45), status: 'confirmed' },
        { id: 'blocked', source: 'Blocked', checkIn: addDaysTo(today, 1), checkOut: addDaysTo(today, 2), status: 'confirmed' },
        { id: 'cancelled', source: 'Direct', checkIn: addDaysTo(today, 2), checkOut: addDaysTo(today, 3), status: 'cancelled' }
      ];

      const arriving = arrivalsWithin(calendar, today, horizon).map(b => b.id);
      const leaving = departuresWithin(calendar, today, horizon).map(b => b.id);

      T.check(
        'the departures panel is not empty when somebody is due to leave — the fault Ro found',
        leaving.length > 0,
        'no departures were found at all'
      );
      T.check('and it names the guest in residence whose stay ends inside the window', leaving.includes('in-residence'), JSON.stringify(leaving));
      T.check('the guest arriving in four days is on it too, because they leave inside the window as well', leaving.includes('arriving'), JSON.stringify(leaving));
      T.check('a stay that ended last month is on neither list', !leaving.includes('gone') && !arriving.includes('gone'), JSON.stringify({ arriving, leaving }));
      T.check('a stay beyond the window is on neither list', !leaving.includes('far-off') && !arriving.includes('far-off'), JSON.stringify({ arriving, leaving }));
      T.check('blocked dates are on neither list', !leaving.includes('blocked') && !arriving.includes('blocked'), JSON.stringify({ arriving, leaving }));
      T.check('a cancelled reservation is on neither list', !leaving.includes('cancelled') && !arriving.includes('cancelled'), JSON.stringify({ arriving, leaving }));
      T.check('arrivals name the guest who has not come yet, and not the one already here', arriving.includes('arriving') && !arriving.includes('in-residence'), JSON.stringify(arriving));
      T.check('and both lists read in date order', JSON.stringify(leaving) === JSON.stringify(['in-residence', 'arriving']), JSON.stringify(leaving));
    }

    return T.done();
  } finally {
    fin.cleanup();
    stays.cleanup();
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
