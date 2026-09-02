/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Does the dashboard mean what a person reading it thinks it means?
 *
 * Ro, 2026-09-02, on a database whose books had just begun: *"the dashboard with
 * Occupancy shows 100%, Vacant Villas 0 … Occupancy cannot be 100% because the
 * villas that are not on long term lease are for short term vacation rentals.
 * Currently, they are available not occupied … we did over 5000 tests, why was
 * this missed?"*
 *
 * It was missed because **every test asserted the code's own definition.** The
 * dashboard counted `unit.status`, the simulations counted `unit.status` through
 * the same helper, and the two agreed perfectly — a wrong definition is entirely
 * self-consistent, and consistency is all a suite can check unless somebody
 * writes the meaning down. Nothing in 6,800 audited scenarios ever asked "should
 * a villa nobody is staying in be counted as occupied?", because the rule lived
 * in Ro's head and not in a file. The charts and the board pack had used the
 * dated records all along, so the application even disagreed with itself on one
 * screenful, and no test compared the two.
 *
 * This file writes the meaning down. Every check here is phrased as the property
 * would put it, not as the code does, and each one fails on the old behaviour.
 *
 * The second fault, from the same message: **"+11 vs August 2026"** on a
 * database whose books begin on 1 September. A month entirely before the books
 * began is not a quiet month, it is a month this system has no standing to
 * describe — and comparing to it reports every opening balance as growth.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Occupancy means somebody is in the villa';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-occupancy-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const TODAY = '2026-09-02';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Occupancy-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const { occupancyOn, isOccupied } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Occupancy-1234!', 'OccupancyNew-9876!');
    await c.post('/api/settings', { booksBeginOn: '2026-09-01' });

    /* ================================================================
     * The property Ro was looking at
     * ================================================================ */

    // One villa genuinely let long-term, with a tenant in residence.
    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Owner One',
      tenantName: 'A Real Tenant',
      tenantChangeIntent: 'changeover',
      tenantMovedInOn: '2026-09-01',
      status: 'long-term',
      monthlyRent: 60000,
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });

    // Three villas set up for short-term vacation rental, with nobody in them.
    for (const id of ['unit-2', 'unit-3', 'unit-4']) {
      await c.put(`/api/units/${id}`, {
        number: id.replace('unit-', ''),
        ownerName: 'Owner',
        status: 'short-term',
        monthlyRent: 0,
        monthlyMaintenance: 20000,
        currency: 'USD',
        maintCurrency: 'USD',
        maintDueDay: 1
      });
    }

    // One the owner lives in, and one off the market for repairs.
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Resident Owner', status: 'owner-occupied', monthlyMaintenance: 20000 });
    await c.put('/api/units/unit-6', { number: '6', ownerName: 'Owner Six', status: 'unavailable', monthlyMaintenance: 0 });

    let db = (await c.get('/api/db')).body;
    let occ = occupancyOn(db.units, db.tenancies, db.bookings, TODAY);

    T.check(
      'a villa offered on Airbnb with nobody in it is not occupied',
      occ.occupied === 2,
      `${occ.occupied} occupied — expected the tenanted villa and the owner-occupied one, and neither of the empty short-lets`
    );
    /*
     * The register seeds all sixteen villas that physically exist, so the ten
     * left untouched here are `vacant` and available as well: three empty
     * short-lets plus ten untouched villas.
     */
    T.check('it is available, because it can take a guest tonight', occ.available === 13, `${occ.available} available`);
    T.check(
      'the villa the owner lives in counts as occupied, though it files no tenancy and no booking',
      occ.occupied === 2 && db.units.filter(u => u.status === 'owner-occupied').length === 1,
      JSON.stringify(occ)
    );
    T.check('a villa off the market is neither occupied nor available', occ.unavailable === 1, `${occ.unavailable} unavailable`);
    T.check(
      'and it is left out of the rate, because a villa that cannot be let is not a letting being missed',
      occ.rate === Math.round((2 / 15) * 100),
      `${occ.rate}% against ${occ.occupied} of ${occ.total - occ.unavailable}`
    );
    T.check(
      'so the headline is not 100% on a property that is mostly empty',
      occ.rate !== null && occ.rate < 50,
      `${occ.rate}%`
    );

    /*
     * The old definition, kept as a named comparison so the difference between
     * "how it is let" and "who is in it" cannot quietly close again.
     */
    const byStatus = db.units.filter(isOccupied).length;
    T.check(
      'the letting-mode count and the occupancy count are different questions, and differ here',
      byStatus === 5 && occ.occupied === 2,
      `status says ${byStatus}, residency says ${occ.occupied}`
    );

    /* ================================================================
     * A guest arriving changes it, and leaving changes it back
     * ================================================================ */

    await c.post('/api/bookings', {
      unitId: 'unit-2',
      unitNumber: '2',
      guestName: 'A Guest',
      checkIn: '2026-09-01',
      checkOut: '2026-09-05',
      source: 'Airbnb',
      amount: 800,
      currency: 'USD',
      depositPaid: 0,
      status: 'confirmed'
    });
    db = (await c.get('/api/db')).body;

    T.check(
      'a guest in residence makes the villa occupied for the nights they are there',
      occupancyOn(db.units, db.tenancies, db.bookings, TODAY).occupied === 3,
      String(occupancyOn(db.units, db.tenancies, db.bookings, TODAY).occupied)
    );
    T.check(
      'and it is available again the day they check out',
      occupancyOn(db.units, db.tenancies, db.bookings, '2026-09-05').occupied === 2,
      String(occupancyOn(db.units, db.tenancies, db.bookings, '2026-09-05').occupied)
    );
    T.check(
      'a calendar block is not a guest — it holds the villa, it does not fill it',
      (await (async () => {
        await c.post('/api/bookings', {
          unitId: 'unit-3',
          unitNumber: '3',
          guestName: 'Maintenance hold',
          checkIn: '2026-09-01',
          checkOut: '2026-09-10',
          source: 'Blocked',
          amount: 0,
          currency: 'USD',
          depositPaid: 0,
          status: 'confirmed'
        });
        const after = (await c.get('/api/db')).body;
        return occupancyOn(after.units, after.tenancies, after.bookings, TODAY).occupied;
      })()) === 3,
      'a blocked villa was counted as occupied'
    );

    /* ================================================================
     * An empty register says nothing rather than dividing by zero
     * ================================================================ */

    const empty = occupancyOn([], [], [], TODAY);
    T.check('an empty register has no rate rather than NaN', empty.rate === null && empty.occupied === 0, JSON.stringify(empty));
    const allOff = occupancyOn(
      [{ id: 'u', number: '1', status: 'unavailable', currency: 'JMD' }],
      [],
      [],
      TODAY
    );
    T.check('and neither does a property with nothing lettable', allOff.rate === null, JSON.stringify(allOff));

    /* ================================================================
     * No trend against a month the books do not cover
     * ================================================================ */

    /*
     * The books begin on 1 September. Charges raised for September are real
     * arrears on the 2nd; August is not a better month, it is a month this
     * system has no records for. The rule asserted here is the one the dashboard
     * now applies: a previous month that ends before the books began is not a
     * comparison at all.
     */
    await c.post('/api/charges/post-month', { monthString: '2026-09' });
    db = (await c.get('/api/db')).body;

    const arrearsNow = fin.delinquentAccounts(db.units, db.charges, db.payments, TODAY);
    const arrearsBefore = fin.delinquentAccounts(db.units, db.charges, db.payments, '2026-08-31');
    T.check('September charges are in arrears once their due date has passed', arrearsNow.length > 0, `${arrearsNow.length} account(s)`);
    T.check(
      'and the month before the books began holds nothing at all',
      arrearsBefore.length === 0,
      `${arrearsBefore.length} account(s) in a month with no books`
    );

    const booksBeginOn = db.settings.booksBeginOn;
    const previousEnd = '2026-08-31';
    T.check(
      'so it is not a comparison, and the screen must not present it as a trend',
      booksBeginOn === '2026-09-01' && previousEnd < booksBeginOn,
      `books begin ${booksBeginOn}`
    );
    T.check(
      'the delta it would otherwise report is the whole opening position, invented as growth',
      arrearsNow.length - arrearsBefore.length === arrearsNow.length,
      `+${arrearsNow.length - arrearsBefore.length} would have been shown "vs August 2026"`
    );
    /* ================================================================
     * A guest cannot be booked into a villa that is not a short let
     * ================================================================ */

    /*
     * Ro, 2026-09-02: "if a villa isnt listed in its status as short term rental
     * it should not be listed under short term bookings. Long Term leases and
     * owner occupied should not be listed under short term rental, this is a
     * huge gap."
     *
     * The server refused `unavailable` and `long-term` and allowed everything
     * else — so a guest could be booked into the villa the proprietor lives in,
     * or one simply standing vacant, and nothing anywhere objected.
     */
    const tryBooking = (unitId, number) =>
      c.post('/api/bookings', {
        unitId,
        unitNumber: number,
        guestName: 'A Guest',
        checkIn: '2026-11-01',
        checkOut: '2026-11-04',
        source: 'Direct',
        amount: 600,
        currency: 'USD',
        depositPaid: 0,
        status: 'confirmed'
      });

    const ownerOccupied = await tryBooking('unit-5', '5');
    T.check(
      'a villa the owner lives in cannot take a guest reservation',
      ownerOccupied.status === 400,
      `${ownerOccupied.status} ${ownerOccupied.body?.booking ? '— the booking was created' : ''}`
    );
    T.check(
      'and the refusal says why, and where to change it',
      /own home/i.test(ownerOccupied.body?.error || '') && /Units Register/i.test(ownerOccupied.body?.error || ''),
      ownerOccupied.body?.error
    );

    const vacant = await tryBooking('unit-9', '9');
    T.check('a vacant villa is not on the short-let market either', vacant.status === 400, String(vacant.status));
    T.check(
      'and it is refused for being vacant rather than for some other reason',
      /vacant and not listed/i.test(vacant.body?.error || ''),
      vacant.body?.error
    );

    const longTerm = await tryBooking('unit-1', '1');
    T.check('a long-term let still cannot be booked', longTerm.status === 400, String(longTerm.status));

    const offMarket = await tryBooking('unit-6', '6');
    T.check('nor can a villa off the market', offMarket.status === 400, String(offMarket.status));

    const shortLet = await tryBooking('unit-4', '4');
    T.check('but a villa listed for short stays can', shortLet.status === 200, String(shortLet.body?.error || shortLet.status));

    /*
     * The status can change under a reservation that already exists. The stay
     * happened and its record must survive — what must not happen is a new one.
     */
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner', status: 'long-term', tenantName: 'New Tenant', tenantChangeIntent: 'changeover', monthlyRent: 50000 });
    const after = (await c.get('/api/db')).body;
    T.check(
      'a villa moved to a long-term lease keeps the reservations already on file',
      after.bookings.some(b => b.unitId === 'unit-4'),
      'the existing reservation vanished when the villa changed status'
    );
    const nowRefused = await tryBooking('unit-4', '4');
    T.check('while a new reservation on it is refused', nowRefused.status === 400, String(nowRefused.status));
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
