/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reading a real platform calendar.
 *
 * These payloads are shaped like the ones Airbnb, Booking.com and VRBO actually
 * export: all-day events with an exclusive checkout date, folded description
 * lines, escaped commas, and summaries that say "Reserved" or "Airbnb (Not
 * available)" rather than naming anybody.
 *
 * What matters here is the difference between a night that is sold and a night
 * that is free. Read a checkout date as inclusive and every villa looks busy a
 * day longer than it is; miss a block and you double-book a villa the owner is
 * staying in.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reporter } from './harness.mjs';

export const title = 'Reading a platform calendar';

async function loadIcal(projectRoot) {
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ical-'));
  const outfile = path.join(dir, 'ical.mjs');
  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'server/ical.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(`file://${outfile}`);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Airbnb's real export shape: no guest name, a folded description, CRLF endings. */
const AIRBNB = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Airbnb Inc//Hosting Calendar 1.0.0//EN',
  'CALSCALE:GREGORIAN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20260720',
  'DTSTART;VALUE=DATE:20260715',
  'UID:1234567890abcdef@airbnb.com',
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details',
  ' /HMABCD1234\\nPhone Number (Last 4 Digits): 1234',
  'SUMMARY:Reserved',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20260805',
  'DTSTART;VALUE=DATE:20260801',
  'UID:blocked-owner-stay@airbnb.com',
  'SUMMARY:Airbnb (Not available)',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

/** Booking.com names the guest and uses CLOSED for owner blocks. */
const BOOKING = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Booking.com//Calendar//EN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260901',
  'DTEND;VALUE=DATE:20260904',
  'UID:booking-9988@booking.com',
  'SUMMARY:Reserved - Marcus O\\, Brien',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260910',
  'DTEND;VALUE=DATE:20260912',
  'UID:closed-9989@booking.com',
  'SUMMARY:CLOSED - Not available',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadIcal(projectRoot);
  try {
    const { parseICal, classifyEvent } = mod;

    /* ---------------------------------------------------------------- *
     * Airbnb
     * ---------------------------------------------------------------- */

    const air = parseICal(AIRBNB);
    T.check('both Airbnb entries are read', air.length === 2, `got ${air.length}`);

    const stay = air.find(e => e.uid === '1234567890abcdef@airbnb.com');
    T.check('the stay starts on the arrival day', stay?.start === '2026-07-15', stay?.start);
    T.check('and ends on the checkout day, exclusive — five nights, not six', stay?.end === '2026-07-20', stay?.end);
    T.check('a folded description line is rejoined', /HMABCD1234/.test(stay?.description || ''), stay?.description);
    T.check('an escaped newline becomes a real one', (stay?.description || '').includes('\n'));

    const airClass = classifyEvent(stay);
    T.check('a bare "Reserved" is a paying stay', airClass.isReservation === true);
    T.check('and is named as an external guest, since Airbnb sends no name', airClass.guestName === 'External guest', airClass.guestName);

    const block = air.find(e => e.uid === 'blocked-owner-stay@airbnb.com');
    T.check('"Airbnb (Not available)" is a block, not a booking', classifyEvent(block).isReservation === false);

    /*
     * Re-syncing a stay already imported. Ro, 2026-09-16, found imported stays
     * carry no guest; the booking form tells staff to type the guest in and
     * promises a re-sync will not overwrite it. It did — every Sync put the name
     * back to "External guest".
     */
    const { feedDateChange } = mod;
    const typedIn = { guestName: 'Marcia Brown', checkIn: '2026-07-15', checkOut: '2026-07-20', amount: 900 };
    T.check(
      'a re-sync with the same dates changes nothing, so the guest name typed in stays',
      feedDateChange(typedIn, stay) === null
    );
    const moved = feedDateChange(typedIn, { ...stay, end: '2026-07-22' });
    T.check('when the guest changes dates on Airbnb, the new dates come through', moved?.checkOut === '2026-07-22' && moved?.checkIn === '2026-07-15', JSON.stringify(moved));
    T.check(
      'and the change carries dates only — nothing in it can replace a name, a value or a note',
      !!moved && Object.keys(moved).sort().join(',') === 'checkIn,checkOut',
      JSON.stringify(moved)
    );
    {
      // The function is only a promise if the sync uses it. The sync cannot be
      // driven from a test — the address guard refuses a local feed, rightly —
      // so this one reads the source, and says so.
      const serverSrc = fs.readFileSync(path.join(projectRoot, 'server.ts'), 'utf8');
      const syncBody = serverSrc.slice(serverSrc.indexOf('async function syncFeed'), serverSrc.indexOf("app.post(\n  '/api/ical/sync'"));
      T.check('the sync decides an update with that rule (source check)', syncBody.length > 0 && /feedDateChange\(existing, event\)/.test(syncBody));
      T.check('and never assigns a name to a stay it already holds (source check)', syncBody.length > 0 && !/existing\.guestName\s*=/.test(syncBody));
    }

    /* ---------------------------------------------------------------- *
     * Booking.com
     * ---------------------------------------------------------------- */

    const bk = parseICal(BOOKING);
    T.check('both Booking.com entries are read', bk.length === 2, `got ${bk.length}`);
    const named = bk.find(e => e.uid === 'booking-9988@booking.com');
    const namedClass = classifyEvent(named);
    T.check('a named reservation keeps the guest', namedClass.isReservation === true && namedClass.guestName === 'Marcus O, Brien', namedClass.guestName);
    T.check('an escaped comma in a name is unescaped', !namedClass.guestName.includes('\\'));
    T.check('"CLOSED - Not available" is a block', classifyEvent(bk.find(e => e.uid === 'closed-9989@booking.com')).isReservation === false);

    /* ---------------------------------------------------------------- *
     * The shapes that used to be dropped or misread
     * ---------------------------------------------------------------- */

    const withDuration = parseICal(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dur-1@vrbo.com', 'DTSTART;VALUE=DATE:20261001', 'DURATION:P3D', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    );
    T.check('an event given as a duration rather than an end date is still read', withDuration.length === 1, `got ${withDuration.length}`);
    T.check('and the checkout lands three nights later', withDuration[0]?.end === '2026-10-04', withDuration[0]?.end);

    const weekLong = parseICal(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dur-2@vrbo.com', 'DTSTART;VALUE=DATE:20261001', 'DURATION:P1W', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    );
    T.check('a week-long duration is read as seven nights', weekLong[0]?.end === '2026-10-08', weekLong[0]?.end);

    const cancelled = parseICal(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:cx-1@booking.com', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261105', 'SUMMARY:Reserved - Jane', 'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    );
    T.check('a cancelled entry is read but flagged as cancelled', cancelled.length === 1 && cancelled[0].cancelled === true);
    const live = parseICal(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:ok-1@booking.com', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261105', 'SUMMARY:Reserved', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    T.check('a confirmed entry is not flagged as cancelled', live[0]?.cancelled === false);

    /* ---------------------------------------------------------------- *
     * Rubbish must not become a reservation
     * ---------------------------------------------------------------- */

    T.check('an empty document yields nothing', parseICal('').length === 0);
    T.check('a document that is not a calendar yields nothing', parseICal('hello world').length === 0);
    T.check('an event with no UID is dropped', parseICal(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20260102', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')).length === 0);
    T.check('an event with no dates is dropped', parseICal(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x@y', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')).length === 0);
    T.check('an unterminated event is dropped rather than half-read', parseICal(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x@y', 'DTSTART;VALUE=DATE:20260101'].join('\r\n')).length === 0);
    T.check('a nonsense date is not invented into a stay', parseICal(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x@y', 'DTSTART;VALUE=DATE:notadate', 'DTEND;VALUE=DATE:20260102', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')).length === 0);

    // A UTC checkout time must land on the property's day, not the following one.
    const utcNight = parseICal(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:tz-1@x', 'DTSTART:20260715T140000Z', 'DTEND:20260720T030000Z', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    );
    T.check('a 03:00Z checkout is the evening before in Jamaica, not the next day', utcNight[0]?.end === '2026-07-19', utcNight[0]?.end);

    /* ---------------------------------------------------------------- *
     * A stay that has gone from the feed
     * ---------------------------------------------------------------- */

    const { planWithdrawals } = mod;
    const booking = over => ({
      id: 'b1',
      unitId: 'unit-1',
      status: 'confirmed',
      guestName: 'External guest',
      checkIn: '2026-07-15',
      checkOut: '2026-07-20',
      amount: 0,
      depositPaid: 0,
      externalUid: 'uid-1',
      externalFeedId: 'feed-1',
      ...over
    });
    // The fixture stay is 15–20 July; judged from 1 July it is still to come, as
    // these checks were written to assume.
    const plan = (bookings, seen, paid = [], day = '2026-07-01') => planWithdrawals(bookings, new Set(paid), new Set(seen), 'feed-1', 'unit-1', 'Airbnb', day);

    T.check('a stay still in the feed is left alone', plan([booking()], ['uid-1']).cancelIds.length === 0);

    const gone = plan([booking()], []);
    T.check('a stay that has gone from the feed is cancelled', gone.cancelIds.length === 1 && gone.cancelIds[0] === 'b1');
    T.check('and it is not reported as a conflict, because no money was involved', gone.conflicts.length === 0);

    T.check('a stay already cancelled is not cancelled again', plan([booking({ status: 'cancelled' })], []).cancelIds.length === 0);
    T.check("a booking somebody typed in by hand is never touched", plan([booking({ externalFeedId: undefined, externalUid: undefined })], []).cancelIds.length === 0);
    T.check('a booking from a different feed is left to that feed', plan([booking({ externalFeedId: 'feed-2' })], []).cancelIds.length === 0);
    T.check('a booking on another villa is left alone', plan([booking({ unitId: 'unit-9' })], []).cancelIds.length === 0);

    // Money changes it from a silent edit into a conversation.
    const withDeposit = plan([booking({ depositPaid: 300 })], []);
    T.check('a stay with a deposit is not silently cancelled', withDeposit.cancelIds.length === 0);
    T.check('it is raised for a person to settle', withDeposit.conflicts.length === 1 && /settle the deposit/.test(withDeposit.conflicts[0]));

    const withValue = plan([booking({ amount: 1200 })], []);
    T.check('a stay carrying a value is raised rather than cancelled', withValue.cancelIds.length === 0 && withValue.conflicts.length === 1);

    const withReceipt = plan([booking()], [], ['b1']);
    T.check('a stay with a receipt against it is raised rather than cancelled', withReceipt.cancelIds.length === 0 && withReceipt.conflicts.length === 1);

    // Several villas and feeds at once, as a real property has.
    const many = planWithdrawals(
      [booking({ id: 'keep', externalUid: 'uid-1' }), booking({ id: 'drop', externalUid: 'uid-2' }), booking({ id: 'other-unit', unitId: 'unit-2', externalUid: 'uid-3' })],
      new Set(),
      new Set(['uid-1']),
      'feed-1',
      'unit-1',
      'Airbnb',
      '2026-07-01'
    );
    T.check('only the withdrawn stay on the right villa is cancelled', many.cancelIds.length === 1 && many.cancelIds[0] === 'drop', many.cancelIds.join(','));

    /*
     * Ro, 2026-09-16: "once the date has passed, the system will do what?" A
     * finished stay must come through a later sync untouched, whatever the feed
     * has stopped listing.
     */
    const afterwards = plan([booking()], [], [], '2026-09-16');
    T.check('a stay that has already ended is never called cancelled when it drops out of the feed', afterwards.cancelIds.length === 0, afterwards.cancelIds.join(','));
    T.check('nor raised as a problem, since there is nothing to settle', afterwards.conflicts.length === 0, afterwards.conflicts.join(' | '));
    const settledAfterwards = plan([booking({ amount: 1200, depositPaid: 1200 })], [], ['b1'], '2026-09-16');
    T.check('a finished stay with money on it is not raised every sync either', settledAfterwards.cancelIds.length === 0 && settledAfterwards.conflicts.length === 0);
    T.check('the departure day counts as ended', plan([booking()], [], [], '2026-07-20').cancelIds.length === 0 && plan([booking()], [], [], '2026-07-20').conflicts.length === 0);

    const midStay = plan([booking()], [], [], '2026-07-17');
    T.check('a stay under way is never cancelled silently, even with no money on it', midStay.cancelIds.length === 0);
    T.check('it is raised for a person to check on the platform instead', midStay.conflicts.length === 1 && /under way/.test(midStay.conflicts[0]), midStay.conflicts.join(' | '));
    T.check('and a stay still to come is withdrawn exactly as before', plan([booking()], [], [], '2026-07-14').cancelIds.length === 1);

    return T.done();
  } finally {
    cleanup();
  }
}
