/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The reservations list, filtered by month and by villa.
 *
 * Ro, 2026-11-19: the detailed list showed every reservation ever made and grew
 * for ever. It now opens on one month and can be narrowed to one villa, with a
 * "Showing N of M" line so nothing drops out of sight without saying so.
 *
 * **The rule asserted here.** A stay belongs to a month when a *night* of it
 * falls in that month. The check-out day is the morning the guest leaves, not a
 * night stayed, so a stay of 28 Oct to 1 Nov is an October stay only; one of
 * 31 Oct to 2 Nov sleeps the night of 1 November and is in both. The printed
 * reservations report uses the same rule and states the villa it covers.
 *
 * Every month is pinned through `remember()`; nothing here reads the clock.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Reservations list filtered by month and villa';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bookings-filter-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as Bookings, ReservationsReport } from './src/components/Bookings';
        export { stayOverlapsDays, stayOverlapsMonth, filterReservations } from './src/lib/bookingFilter';
        export { remember, forgetScreenState } from './src/lib/screenState';
        export { default as React } from 'react';
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
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const unit = (id, number, status) => ({ id, number, status, ownerName: 'Owner', tenantName: '', monthlyRent: 0, monthlyMaintenance: 0 });
const stay = (id, unitId, unitNumber, guestName, checkIn, checkOut) => ({
  id,
  unitId,
  unitNumber,
  guestName,
  guestEmail: '',
  guestPhone: '',
  checkIn,
  checkOut,
  source: 'Direct',
  amount: 500,
  currency: 'USD',
  depositPaid: 100,
  balanceDue: 400,
  status: 'confirmed',
  notes: ''
});

const UNITS = [unit('u1', '1', 'short-term'), unit('u2', '2', 'short-term'), unit('u3', '3', 'long-term')];
const BOOKINGS = [
  stay('a', 'u1', '1', 'Alpha Span', '2026-10-25', '2026-12-25'), // Oct, Nov, Dec
  stay('b', 'u1', '1', 'Bravo Leaves', '2026-10-28', '2026-11-01'), // Oct only: 1 Nov is departure
  stay('c', 'u2', '2', 'Charlie Crosses', '2026-10-31', '2026-11-02'), // Oct and Nov
  stay('d', 'u2', '2', 'Delta Later', '2026-12-10', '2026-12-12'), // Dec only
  stay('e', 'u2', '2', 'Echo Lastnight', '2026-11-30', '2026-12-01') // Nov only: 1 Dec is departure
];
const GUESTS = ['Alpha Span', 'Bravo Leaves', 'Charlie Crosses', 'Delta Later', 'Echo Lastnight'];

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { React, renderToStaticMarkup, Bookings, ReservationsReport, stayOverlapsDays, stayOverlapsMonth, filterReservations, remember, forgetScreenState } = mod;

  try {
    /* ---------------- the predicate ---------------- */
    const span = { checkIn: '2026-10-25', checkOut: '2026-12-25' };
    for (const m of ['2026-10', '2026-11', '2026-12']) {
      T.check(`a stay of 25 Oct to 25 Dec is in ${m}`, stayOverlapsMonth(span, m) === true);
    }
    T.check('…and not in September', stayOverlapsMonth(span, '2026-09') === false);
    T.check('…and not in January', stayOverlapsMonth(span, '2027-01') === false);

    const leavesFirst = { checkIn: '2026-10-28', checkOut: '2026-11-01' };
    T.check('a stay checking out on 1 Nov is in October', stayOverlapsMonth(leavesFirst, '2026-10') === true);
    T.check('a stay checking out on 1 Nov is NOT in November: the departure day is not a night', stayOverlapsMonth(leavesFirst, '2026-11') === false);
    T.check('a stay sleeping the night of 1 Nov is in November', stayOverlapsMonth({ checkIn: '2026-10-31', checkOut: '2026-11-02' }, '2026-11') === true);
    T.check('a stay arriving on the last day of a month is in that month', stayOverlapsMonth({ checkIn: '2026-11-30', checkOut: '2026-12-01' }, '2026-11') === true);
    T.check('…and not in the next', stayOverlapsMonth({ checkIn: '2026-11-30', checkOut: '2026-12-01' }, '2026-12') === false);
    T.check('a stay arriving on the 1st is in that month', stayOverlapsMonth({ checkIn: '2026-12-01', checkOut: '2026-12-03' }, '2026-12') === true);
    T.check('February in a non-leap year ends on the 28th', stayOverlapsMonth({ checkIn: '2027-02-28', checkOut: '2027-03-02' }, '2027-02') === true);
    T.check('a day range is inclusive of its last day', stayOverlapsDays({ checkIn: '2026-11-15', checkOut: '2026-11-16' }, '2026-11-01', '2026-11-15') === true);
    T.check('a missing date never matches', stayOverlapsMonth({ checkIn: '', checkOut: '2026-11-03' }, '2026-11') === false);

    const ids = rows => rows.map(r => r.id).sort().join(',');
    T.check('filter: November keeps a, c, e', ids(filterReservations(BOOKINGS, { month: '2026-11', unitId: '' })) === 'a,c,e', ids(filterReservations(BOOKINGS, { month: '2026-11', unitId: '' })));
    T.check('filter: November at villa 2 keeps c, e', ids(filterReservations(BOOKINGS, { month: '2026-11', unitId: 'u2' })) === 'c,e');
    T.check('filter: all months at villa 1 keeps a, b', ids(filterReservations(BOOKINGS, { month: null, unitId: 'u1' })) === 'a,b');
    T.check('filter: all months, all villas keeps everything', filterReservations(BOOKINGS, { month: null, unitId: '' }).length === BOOKINGS.length);

    /* ---------------- the rendered list ---------------- */
    const session = { id: 's', name: 'Desk', username: 'desk', email: '', position: '', role: 'ADMINISTRATOR', mustChangePassword: false, permissions: {} };
    const settings = { icalFeeds: [] };
    const noop = async () => ({});
    let lastHtml = '';
    const renderList = state => {
      forgetScreenState();
      remember('bookings.view', 'list');
      for (const [k, v] of Object.entries(state)) remember(k, v);
      const html = renderToStaticMarkup(
        React.createElement(Bookings, {
          units: UNITS,
          bookings: BOOKINGS,
          settings,
          session,
          onAddBooking: noop,
          onUpdateBooking: noop,
          onSyncCalendars: async () => ({ results: [] }),
          onHoldDamageDeposit: noop,
          onSettleDamageDeposit: noop
        })
      );
      lastHtml = html;
      return textOf(html);
    };
    /*
     * Only the list's table body counts as "shown". The overlap warning above the
     * list deliberately names clashing stays from every month (Alpha and Bravo
     * share nights in October), so searching the whole page would see them.
     */
    const tableOf = text => {
      const m = text.match(/Receipt (.*)$/);
      return m ? m[1] : '';
    };
    const shown = text => GUESTS.filter(g => tableOf(text).includes(g)).join(',');
    const shownIn = text => GUESTS.filter(g => text.includes(g)).join(',');

    const nov = renderList({ 'bookings.month': '2026-11' });
    T.check('November list shows Alpha, Charlie, Echo only', shown(nov) === 'Alpha Span,Charlie Crosses,Echo Lastnight', shown(nov));
    T.check('November list says "Showing 3 of 5 reservations"', /Showing 3 of 5 reservations/.test(nov), nov.match(/Showing[^·]*/)?.[0]);
    T.check('the count line names the filter', /Showing 3 of 5 reservations · November 2026, all villas/.test(nov));

    const oct = renderList({ 'bookings.month': '2026-10' });
    T.check('October list shows Alpha, Bravo, Charlie', shown(oct) === 'Alpha Span,Bravo Leaves,Charlie Crosses', shown(oct));

    const novV2 = renderList({ 'bookings.month': '2026-11', 'bookings.listUnitId': 'u2' });
    T.check('November at villa 2 shows Charlie and Echo', shown(novV2) === 'Charlie Crosses,Echo Lastnight', shown(novV2));
    T.check('…and says "Showing 2 of 5"', /Showing 2 of 5 reservations/.test(novV2));

    const allV1 = renderList({ 'bookings.month': '2026-11', 'bookings.listAllMonths': true, 'bookings.listUnitId': 'u1' });
    T.check('all months at villa 1 shows Alpha and Bravo', shown(allV1) === 'Alpha Span,Bravo Leaves', shown(allV1));
    T.check('…and the month label reads "All months"', /All months/.test(allV1));

    const all = renderList({ 'bookings.month': '2026-11', 'bookings.listAllMonths': true });
    T.check('all months, all villas shows every reservation', shown(all) === GUESTS.join(','), shown(all));
    T.check('…"Showing 5 of 5"', /Showing 5 of 5 reservations/.test(all));

    renderList({ 'bookings.month': '2026-11' });
    const html = lastHtml;
    T.check('the villa select offers villas 1 and 2', html.includes('<option value="u1">Villa Unit 1</option>') && html.includes('<option value="u2">Villa Unit 2</option>'));
    // Villa 3 is a long-term let with no stays: it is not a short-let villa.
    T.check('the villa select does not offer a long-term villa with no stays', !html.includes('Villa Unit 3'));

    const stale = renderList({ 'bookings.month': '2026-11', 'bookings.listUnitId': 'gone' });
    T.check('a remembered villa that no longer exists falls back to all villas', /Showing 3 of 5 reservations/.test(stale));

    const empty = renderList({ 'bookings.month': '2027-06' });
    T.check('an empty month shows the empty state', /No reservations match these filters/.test(empty));
    T.check('…and still says how many are on record', /Showing 0 of 5 reservations/.test(empty) && /5 reservations are on record/.test(empty));
    T.check('…and lists nobody', shown(empty) === '');

    /* ---------------- the printout ---------------- */
    const print = (from, to, u) =>
      textOf(renderToStaticMarkup(React.createElement(ReservationsReport, { bookings: BOOKINGS, from, to, unit: u, generatedBy: 'Desk', onClose: () => {} })));
    const novPrint = print('2026-11-01', '2026-11-30', undefined);
    T.check('November printout uses the same rule as the list', shownIn(novPrint) === 'Alpha Span,Charlie Crosses,Echo Lastnight', shownIn(novPrint));
    T.check('…and states "All villas"', /All villas/.test(novPrint));
    const v2Print = print('2026-11-01', '2026-11-30', UNITS[1]);
    T.check('villa 2 printout lists only villa 2', shownIn(v2Print) === 'Charlie Crosses,Echo Lastnight', shownIn(v2Print));
    T.check('…and states the villa', /Period 1 Nov 2026 to 30 Nov 2026 · Villa Unit 2/.test(v2Print), v2Print.match(/Period[^C]{0,60}/)?.[0]);
    T.check('…and its totals follow the filter (2 stays x US$500)', /1,000\.00/.test(v2Print) && !/1,500\.00/.test(v2Print));
  } finally {
    forgetScreenState();
    cleanup();
  }

  return T.done();
}
