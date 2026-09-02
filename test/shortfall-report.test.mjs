/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The out-of-pocket shortfall — what VDS funded on the villas it lets.
 *
 * Designed 2026-09-02, built on Ro's yes. The funding model is not in the
 * ledger: on the villas VDS lets on its own account the maintenance
 * contribution is paid out of the rent that villa collects, so a month with no
 * tenant is a month VDS finds the money elsewhere. The books bill a vacant
 * villa correctly and have never known that the rent was what paid it.
 *
 * Four things were specified and every one of them is asserted here:
 *
 *   1. **A tick box decides which villas are VDS's own**, not a name match.
 *      `ownerName` is free text and matching on it drops a villa silently the
 *      day somebody types "Villaggio Del Sol Ltd." instead of "VDS" — and a
 *      dropped villa understates the one figure the report exists to state.
 *   2. **Cash basis**, earnings counted when received and the contribution when
 *      paid, so the figure is money that actually moved.
 *
 *   2b. **Short-stay income funds the contribution too.** Ro, reading the first
 *      cut: *"when a unit is vacant or under short term/airbnb Villaggio still
 *      has to cover that cost"*. A villa that earned US$900 on Airbnb in a month
 *      its contribution was US$200 cost VDS nothing, and the earlier engine —
 *      which offset rent alone and carried booking receipts as a memo — said it
 *      cost US$200. That overstated the shortfall on exactly the villas the
 *      report exists to judge, so earnings are now rent plus short stay.
 *   3. **The months that cost money are named**, not counted. A total with no
 *      list behind it is not actionable.
 *   4. **The currencies never meet.** A villa taking rent in one currency and
 *      billed its contribution in another gets no shortfall at all — it is
 *      named instead, because a subtraction across two moneys invents a figure.
 *
 * The printed document is rendered and asked what it shows, for the reason
 * every printed document in this application now is: until 2026-09-02 not one
 * of them was covered by anything, which is how a maintenance receipt went
 * missing from a record that looked complete.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Out-of-pocket shortfall on the villas VDS lets';

const FROM = '2026-01-01';
const TO = '2026-06-30';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-shortfall-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as ShortfallScreen, ShortfallDocument } from './src/components/ShortfallReport';
        export { default as OwnerStatements } from './src/components/OwnerStatements';
        export * as fin from './src/lib/finance';
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

/** Strip tags so the printed document can be searched for what it actually says. */
const textOf = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Shortfall-1234!', projectRoot });
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, React, renderToStaticMarkup, ShortfallDocument, ShortfallScreen, OwnerStatements } = mod;
  const { outOfPocketShortfall } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Shortfall-1234!', 'ShortfallNew-9876!');
    /*
     * Settings are read from /api/db and written with POST /api/settings. There
     * is no GET or PUT on that path — several suites carry a copied
     * `c.put('/api/settings', …)` that has always 404'd in silence.
     */
    await c.post('/api/settings', { booksBeginOn: '2026-01-01' });

    /* ================================================================
     * The register: which villas are VDS's own
     * ================================================================ */

    // Villa 1 — VDS's own. Let from January, tenant leaves at the end of April.
    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Villaggio Del Sol',
      tenantName: 'Long Term Tenant',
      tenantChangeIntent: 'changeover',
      tenantMovedInOn: '2026-01-01',
      status: 'long-term',
      monthlyRent: 60000,
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1,
      letOnOwnAccount: true
    });

    // Villa 2 — somebody else's villa, deliberately not ticked.
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'A Private Proprietor',
      tenantName: 'Their Tenant',
      tenantChangeIntent: 'changeover',
      tenantMovedInOn: '2026-01-01',
      status: 'long-term',
      monthlyRent: 75000,
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });

    // Villa 3 — VDS's own, in US dollars, standing empty but for one short stay.
    // Listed for short stays, because only such a villa can take a guest.
    await c.put('/api/units/unit-3', {
      number: '3',
      ownerName: 'Villaggio Del Sol Ltd.',
      status: 'short-term',
      monthlyRent: 0,
      monthlyMaintenance: 200,
      currency: 'USD',
      maintCurrency: 'USD',
      maintDueDay: 1,
      letOnOwnAccount: true
    });

    // Villa 4 — VDS's own, but rent in JMD and the contribution billed in USD.
    await c.put('/api/units/unit-4', {
      number: '4',
      ownerName: 'VDS',
      status: 'vacant',
      monthlyRent: 40000,
      monthlyMaintenance: 150,
      currency: 'JMD',
      maintCurrency: 'USD',
      maintDueDay: 1,
      letOnOwnAccount: true
    });

    let db = (await c.get('/api/db')).body;
    const flagged = db.units.filter(u => u.letOnOwnAccount === true).map(u => u.number);
    T.check('the tick box saves against the villa', flagged.join(',') === '1,3,4', flagged.join(','));
    T.check(
      'and every other villa is left alone — absent means no, never a guess from the owner name',
      db.units.filter(u => u.letOnOwnAccount !== true).length === 13,
      `${db.units.filter(u => u.letOnOwnAccount !== true).length} villa(s) not flagged`
    );

    /* --- the flag survives an edit that says nothing about it --- */
    await c.put('/api/units/unit-1', { number: '1', ownerName: 'Villaggio Del Sol', notes: 'Gate remote replaced.' });
    db = (await c.get('/api/db')).body;
    T.check(
      'an unrelated edit that omits the field does not clear it',
      db.units.find(u => u.id === 'unit-1').letOnOwnAccount === true,
      String(db.units.find(u => u.id === 'unit-1').letOnOwnAccount)
    );

    /* --- only a genuine boolean turns it on --- */
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Someone Else', letOnOwnAccount: 'yes' });
    db = (await c.get('/api/db')).body;
    T.check(
      'a string is not a tick — only a real boolean sets the flag',
      db.units.find(u => u.id === 'unit-5').letOnOwnAccount !== true,
      String(db.units.find(u => u.id === 'unit-5').letOnOwnAccount)
    );

    /* --- and it can be unticked --- */
    await c.put('/api/units/unit-1', { number: '1', ownerName: 'Villaggio Del Sol', letOnOwnAccount: false });
    db = (await c.get('/api/db')).body;
    T.check('it can be unticked again', db.units.find(u => u.id === 'unit-1').letOnOwnAccount === false);
    await c.put('/api/units/unit-1', { number: '1', ownerName: 'Villaggio Del Sol', letOnOwnAccount: true });

    const audits = (await c.get('/api/db')).body.auditLogs.filter(a => /own account/i.test(a.action));
    T.check('and both directions are written to the audit trail', audits.length >= 2, `${audits.length} entr(ies)`);

    /* ================================================================
     * Occupancy, and the money
     * ================================================================ */

    // The books are posted for every month in the period first: a receipt is
    // only accepted against an account that owes something, which is the
    // application working as intended rather than something to route around.
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      await c.post('/api/charges/post-month', { monthString: month });
    }

    // The tenant leaves at the end of April: May and June are empty months.
    db = (await c.get('/api/db')).body;
    const tenancy = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await c.put(`/api/tenancies/${tenancy.id}`, { endedOn: '2026-04-30', endReason: 'Lease ended; keys returned.' });

    // A three-night stay in Villa 3 in March that comfortably covered the
    // contribution, and a cheap two-night stay in April that did not. The second
    // is the case Ro raised: let, and still short.
    await c.post('/api/bookings', {
      unitId: 'unit-3',
      unitNumber: '3',
      guestName: 'A Guest',
      checkIn: '2026-03-10',
      checkOut: '2026-03-13',
      source: 'Direct',
      amount: 900,
      currency: 'USD',
      depositPaid: 0,
      status: 'checked-out'
    });
    await c.post('/api/bookings', {
      unitId: 'unit-3',
      unitNumber: '3',
      guestName: 'A Thrifty Guest',
      checkIn: '2026-04-10',
      checkOut: '2026-04-12',
      source: 'Airbnb',
      amount: 50,
      currency: 'USD',
      depositPaid: 0,
      status: 'checked-out'
    });

    const rentDays = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'];
    for (const date of rentDays) {
      await recordAndConfirmPayment(c, {
        unitId: 'unit-1',
        category: 'Rent',
        amount: 60000,
        currency: 'JMD',
        payerName: 'Long Term Tenant',
        method: 'Bank Transfer',
        date,
        confirmNoOpenCharge: true
      });
    }
    for (const date of ['2026-01-06', '2026-02-06', '2026-03-06', '2026-04-06', '2026-05-06', '2026-06-06']) {
      await recordAndConfirmPayment(c, {
        unitId: 'unit-1',
        category: 'Maintenance',
        amount: 20000,
        currency: 'JMD',
        payerName: 'Villaggio Del Sol',
        method: 'Bank Transfer',
        date,
        confirmNoOpenCharge: true
      });
    }

    // Villa 2's money: a villa that is not VDS's own, in the same currency and
    // the same months. Nothing of it may reach this report.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Rent',
      amount: 75000,
      currency: 'JMD',
      payerName: 'Their Tenant',
      method: 'Cash',
      date: '2026-05-05',
      confirmNoOpenCharge: true
    });
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Maintenance',
      amount: 20000,
      currency: 'JMD',
      payerName: 'A Private Proprietor',
      method: 'Cash',
      date: '2026-05-06',
      confirmNoOpenCharge: true
    });

    // Villa 3: the contribution paid every month out of VDS's pocket, plus the
    // short-stay receipt, which is memo only.
    for (const date of ['2026-01-08', '2026-02-08', '2026-03-08', '2026-04-08', '2026-05-08', '2026-06-08']) {
      await recordAndConfirmPayment(c, {
        unitId: 'unit-3',
        category: 'Maintenance',
        amount: 200,
        currency: 'USD',
        payerName: 'Villaggio Del Sol Ltd.',
        method: 'Bank Transfer',
        date,
        confirmNoOpenCharge: true
      });
    }
    await recordAndConfirmPayment(c, {
      unitId: 'unit-3',
      category: 'Booking',
      amount: 900,
      currency: 'USD',
      payerName: 'A Guest',
      method: 'Credit Card',
      date: '2026-03-13',
      confirmNoOpenCharge: true
    });
    await recordAndConfirmPayment(c, {
      unitId: 'unit-3',
      category: 'Booking',
      amount: 50,
      currency: 'USD',
      payerName: 'A Thrifty Guest',
      method: 'Credit Card',
      date: '2026-04-12',
      confirmNoOpenCharge: true
    });

    // Villa 4: rent in one currency, contribution in the other.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-4',
      category: 'Rent',
      amount: 40000,
      currency: 'JMD',
      payerName: 'A Short Tenant',
      method: 'Cash',
      date: '2026-02-12',
      confirmNoOpenCharge: true
    });
    await recordAndConfirmPayment(c, {
      unitId: 'unit-4',
      category: 'Maintenance',
      amount: 150,
      currency: 'USD',
      payerName: 'VDS',
      method: 'Bank Transfer',
      date: '2026-02-13',
      confirmNoOpenCharge: true
    });

    // Entered but never confirmed: money that has not arrived is not money.
    await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 60000,
      currency: 'JMD',
      payerName: 'Long Term Tenant',
      method: 'Cheque',
      date: '2026-05-20',
      confirmNoOpenCharge: true
    });

    db = (await c.get('/api/db')).body;
    const jmd = outOfPocketShortfall(db.units, db.tenancies, db.bookings, db.payments, 'JMD', FROM, TO);
    const usd = outOfPocketShortfall(db.units, db.tenancies, db.bookings, db.payments, 'USD', FROM, TO);

    /* ================================================================
     * Only the villas VDS lets
     * ================================================================ */

    T.check(
      'only villas ticked as let on the corporation’s own account appear',
      jmd.byVilla.map(v => v.villa).join(',') === 'Villa Unit 1',
      jmd.byVilla.map(v => v.villa).join(',')
    );
    T.check(
      'a villa that is not VDS’s own contributes nothing to any figure',
      jmd.totalRentReceived === 240000 && jmd.totalMaintenancePaid === 120000,
      `rent ${jmd.totalRentReceived}, maintenance ${jmd.totalMaintenancePaid}`
    );
    T.check('and none of its money leaks into the shortfall', jmd.totalShortfall === 40000, String(jmd.totalShortfall));
    T.check(
      'money entered but never confirmed counts for nothing',
      jmd.byMonth.find(m => m.month === '2026-05').rentReceived === 0,
      String(jmd.byMonth.find(m => m.month === '2026-05').rentReceived)
    );

    /* ================================================================
     * The shortfall itself
     * ================================================================ */

    const may = jmd.lines.find(l => l.month === '2026-05');
    const jan = jmd.lines.find(l => l.month === '2026-01');
    T.check('a month whose rent covered the contribution funds nothing', jan.shortfall === 0, `${jan.rentReceived} rent vs ${jan.maintenancePaid}`);
    T.check('an empty month is the contribution paid with no rent behind it', may.shortfall === 20000, String(may.shortfall));
    T.check(
      'the shortfall is never negative — a good month is not a credit against a bad one',
      jmd.lines.every(l => l.shortfall >= 0),
      'a line went negative'
    );
    T.check(
      'the total is summed from the villa-months, not taken as the difference of two totals',
      jmd.totalShortfall === jmd.lines.reduce((a, l) => a + l.shortfall, 0) &&
        jmd.totalShortfall !== Math.max(0, jmd.totalMaintenancePaid - jmd.totalRentReceived),
      `${jmd.totalShortfall} vs netted ${Math.max(0, jmd.totalMaintenancePaid - jmd.totalRentReceived)}`
    );

    /* ================================================================
     * Occupied days come from the dated records
     * ================================================================ */

    T.check('a let month counts its days from the tenancy', jan.occupiedDays === 31 && jan.daysCounted === 31, `${jan.occupiedDays}/${jan.daysCounted}`);
    T.check('the month the tenant left is not counted as empty', jmd.lines.find(l => l.month === '2026-04').vacant === false);
    T.check('and the months after it are', may.vacant === true && jmd.lines.find(l => l.month === '2026-06').vacant === true);
    T.check(
      'occupancy is read from dates, not from the villa’s current status',
      jan.occupiedDays > 0,
      'Villa 1 reads as never let, though its tenancy covers January'
    );

    /* ================================================================
     * The headline, and the months named under it
     * ================================================================ */

    T.check('the headline counts the villa-months that cost something', jmd.fundedVillaMonths === 2, String(jmd.fundedVillaMonths));
    T.check('and says how many of them stood empty', jmd.vacantVillaMonths === 2 && jmd.vacantShortfall === 40000, `${jmd.vacantVillaMonths} / ${jmd.vacantShortfall}`);
    T.check(
      'every funded month is named, so the figure can be acted on',
      jmd.fundedMonths.map(v => `${v.villa} ${v.month}`).join(', ') === 'Villa Unit 1 2026-05, Villa Unit 1 2026-06',
      jmd.fundedMonths.map(v => `${v.villa} ${v.month}`).join(', ')
    );
    T.check(
      'the by-month view names which villas were empty',
      jmd.byMonth.find(m => m.month === '2026-06').vacantVillas.join(',') === 'Villa Unit 1',
      jmd.byMonth.find(m => m.month === '2026-06').vacantVillas.join(',')
    );

    /* ================================================================
     * Two views, one engine — they must agree
     * ================================================================ */

    T.check(
      'by villa and by month total to the same shortfall',
      jmd.byVilla.reduce((a, v) => a + v.shortfall, 0) === jmd.byMonth.reduce((a, m) => a + m.shortfall, 0),
      `${jmd.byVilla.reduce((a, v) => a + v.shortfall, 0)} vs ${jmd.byMonth.reduce((a, m) => a + m.shortfall, 0)}`
    );
    T.check(
      'and to the same earnings and contribution',
      jmd.byVilla.reduce((a, v) => a + v.earned, 0) === jmd.totalEarned &&
        jmd.byMonth.reduce((a, m) => a + m.maintenancePaid, 0) === jmd.totalMaintenancePaid,
      'the two views disagree'
    );
    T.check('every month in the period is present, including the quiet ones', jmd.byMonth.length === 6, `${jmd.byMonth.length} month(s)`);

    /* ================================================================
     * The other currency, kept entirely apart
     * ================================================================ */

    T.check('a USD villa does not appear on the JMD report', !jmd.byVilla.some(v => v.villa === 'Villa Unit 3'), jmd.byVilla.map(v => v.villa).join(','));
    T.check('and the JMD villa does not appear on the USD one', !usd.byVilla.some(v => v.villa === 'Villa Unit 1'), usd.byVilla.map(v => v.villa).join(','));
    T.check('the USD shortfall is its own figure', usd.totalShortfall === 950, String(usd.totalShortfall));

    /* --- short-stay income funds the contribution (Ro, 2026-09-02) --- */

    const march = usd.lines.find(l => l.month === '2026-03');
    const april = usd.lines.find(l => l.month === '2026-04');
    T.check(
      'a villa that earned its contribution on short stay cost VDS nothing that month',
      march.shortStayReceived === 900 && march.shortfall === 0,
      JSON.stringify(march)
    );
    T.check('and what it earned is rent plus short stay, stated in its own column', march.earned === 900 && march.rentReceived === 0, JSON.stringify(march));
    T.check(
      'a villa let but earning less than its contribution is short by the difference, not by the whole',
      april.shortStayReceived === 50 && april.maintenancePaid === 200 && april.shortfall === 150,
      JSON.stringify(april)
    );
    T.check('that month is not a vacant month — it was let', april.vacant === false, String(april.vacant));
    T.check(
      'it is still named as a month VDS funded, and named as let rather than empty',
      usd.fundedMonths.some(v => v.month === '2026-04' && v.vacant === false && v.shortfall === 150),
      JSON.stringify(usd.fundedMonths)
    );
    T.check(
      'so the empty-month figure is a subset of the total, and both are stated',
      usd.vacantShortfall === 800 && usd.vacantVillaMonths === 4 && usd.fundedVillaMonths === 5,
      `${usd.vacantShortfall} across ${usd.vacantVillaMonths} of ${usd.fundedVillaMonths}`
    );
    T.check(
      'the short-stay income is not lost from the report — it is a column, not a footnote',
      usd.totalShortStayReceived === 950 && usd.totalEarned === 950,
      `${usd.totalShortStayReceived} / ${usd.totalEarned}`
    );
    T.check(
      'and the contribution paid is unchanged by any of it',
      usd.totalMaintenancePaid === 1200,
      String(usd.totalMaintenancePaid)
    );

    /* ================================================================
     * A villa whose two currencies differ gets no figure at all
     * ================================================================ */

    T.check(
      'a villa taking rent in one currency and billed in another is named, not computed',
      jmd.currencyNotes.some(n => n.villa === 'Villa Unit 4') && usd.currencyNotes.some(n => n.villa === 'Villa Unit 4'),
      JSON.stringify(jmd.currencyNotes)
    );
    T.check(
      'and it is kept out of the rows entirely rather than given half a row',
      !jmd.byVilla.some(v => v.villa === 'Villa Unit 4') && !usd.byVilla.some(v => v.villa === 'Villa Unit 4'),
      'Villa Unit 4 was given a row'
    );
    T.check(
      'its rent does not inflate the totals it has no contribution to sit against',
      jmd.totalRentReceived === 240000,
      String(jmd.totalRentReceived)
    );
    const note = jmd.currencyNotes.find(n => n.villa === 'Villa Unit 4');
    T.check('the note says which currency is which', note.rentCurrency === 'JMD' && note.maintCurrency === 'USD', JSON.stringify(note));

    /* ================================================================
     * Refunds land in the month the money went back out
     * ================================================================ */

    const marchRent = db.payments.find(p => p.unitId === 'unit-1' && p.category === 'Rent' && p.date === '2026-03-05');
    const refunded = await c.post(`/api/payments/${marchRent.id}/refund`, {
      amount: 10000,
      refundedOn: '2026-04-20',
      reason: 'Overpaid rent returned to the tenant.'
    });
    T.check('a rent receipt can be refunded', refunded.status === 200, String(refunded.body?.error || ''));

    const after = outOfPocketShortfall(
      (await c.get('/api/db')).body.units,
      (await c.get('/api/db')).body.tenancies,
      (await c.get('/api/db')).body.bookings,
      (await c.get('/api/db')).body.payments,
      'JMD',
      FROM,
      TO
    );
    T.check(
      'the refund is subtracted in the month it left, not the month it arrived',
      after.byMonth.find(m => m.month === '2026-03').rentReceived === 60000 &&
        after.byMonth.find(m => m.month === '2026-04').rentReceived === 50000,
      `March ${after.byMonth.find(m => m.month === '2026-03').rentReceived}, April ${after.byMonth.find(m => m.month === '2026-04').rentReceived}`
    );
    T.check(
      'and April still covered its contribution, so it still funds nothing',
      after.lines.find(l => l.month === '2026-04').shortfall === 0,
      String(after.lines.find(l => l.month === '2026-04').shortfall)
    );

    /* ================================================================
     * Nothing ticked is a different state from nothing to report
     * ================================================================ */

    const noneUnits = db.units.map(u => ({ ...u, letOnOwnAccount: false }));
    const none = outOfPocketShortfall(noneUnits, db.tenancies, db.bookings, db.payments, 'JMD', FROM, TO);
    T.check('with no villa ticked the report says so, rather than reporting zero', none.noneFlagged === true && none.lines.length === 0);
    T.check('and a report with villas ticked never claims otherwise', jmd.noneFlagged === false);

    /* ================================================================
     * The printed document carries the report
     * ================================================================ */

    const html = renderToStaticMarkup(
      React.createElement(ShortfallDocument, {
        reports: [jmd, usd],
        period: '1 Jan 2026 to 30 Jun 2026',
        generatedBy: 'Test Administrator'
      })
    );
    const text = textOf(html);

    T.check('the printed document renders at all', html.length > 500, `${html.length} characters`);
    T.check(
      'it declares on its face that it is internal and not a strata document',
      /internal/i.test(text) && /not a strata document/i.test(text),
      text.slice(0, 200)
    );
    T.check(
      'it carries the headline sentence',
      /funded J\$40,000\.00 from its own account across 2 villa-months/i.test(text),
      text.slice(0, 400)
    );
    T.check('it names the villas', /Villa Unit 1/.test(text) && /Villa Unit 3/.test(text), 'a villa is missing from the printed report');
    T.check('it names the funded months rather than only counting them', /May 2026/.test(text) && /June 2026/.test(text), 'the funded months are not named');
    T.check(
      'and says of each whether the villa was empty or simply did not earn enough',
      /empty all month/i.test(text) && /earned less than the contribution/i.test(text),
      'the printed list does not distinguish an empty month from a poorly-let one'
    );
    T.check(
      'the printed page states that short stay counts towards the contribution',
      /short-stay receipts/i.test(text) && /Earned/.test(text),
      'the printed report does not explain what Earned means'
    );
    T.check('it shows both views', /By villa/i.test(text) && /By month/i.test(text), 'a view is missing');
    T.check(
      'the short-stay money is on the printed page as a figure, not a footnote',
      /(?<!J)\$900\.00/.test(text) && !/Not counted/i.test(text),
      'the printed report still treats short-stay income as an aside'
    );
    T.check(
      'it names the villa it computed no shortfall for, rather than dropping it silently',
      /No shortfall computed for Villa Unit 4/i.test(text),
      'Villa Unit 4 vanished from the printed report'
    );
    T.check(
      'and it never combines the currencies',
      /Jamaican dollars/.test(text) && /United States dollars/.test(text) && !/J\$950/.test(text),
      'the printed report mixed the currencies'
    );
    /* ================================================================
     * Internal only — administrators, and nothing an owner sees
     * ================================================================ */

    /*
     * Ro, 2026-09-02: "The shortfall is for internal uses only, it should not be
     * reflected in any public facing reports whatsoever, that includes owners.
     * this is just for us as admin."
     */
    const sessionAs = role => ({
      id: 'u1',
      name: 'Test User',
      username: 'test',
      email: 't@example.com',
      position: 'Officer',
      role,
      mustChangePassword: false,
      permissions: {
        recordPayments: true,
        editBookings: true,
        cancelBookings: true,
        addBookings: true,
        editUnits: true,
        reversePayments: true,
        enterUtilities: true,
        recordExpenses: true,
        modifySettledRecords: true,
        postCharges: true
      }
    });

    const screenFor = role =>
      renderToStaticMarkup(
        React.createElement(ShortfallScreen, {
          units: db.units,
          tenancies: db.tenancies,
          bookings: db.bookings,
          payments: db.payments,
          session: sessionAs(role)
        })
      );

    /*
     * "Internal" is internal to the office, not to one login. Ro, when it was
     * first built for administrators alone: "just for us as admin means every
     * staff member who has an account so ensure every role can see it, not just
     * adminstrators. Or make it an access checkbox in the settings."
     */
    for (const role of ['ADMINISTRATOR', 'MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER']) {
      T.check(
        `a ${role.toLowerCase().replace('_', ' ')} with an account sees the report`,
        /Out-of-pocket shortfall/i.test(screenFor(role)),
        'the role saw nothing'
      );
    }

    const withdrawn = role => {
      const user = sessionAs(role);
      return renderToStaticMarkup(
        React.createElement(ShortfallScreen, {
          units: db.units,
          tenancies: db.tenancies,
          bookings: db.bookings,
          payments: db.payments,
          session: { ...user, permissions: { ...user.permissions, viewShortfall: false } }
        })
      );
    };
    T.check('and it can be withdrawn from a role in System Settings', withdrawn('JUNIOR_OFFICER') === '', withdrawn('JUNIOR_OFFICER').slice(0, 120));
    T.check(
      'but an administrator is never gated by it',
      /Out-of-pocket shortfall/i.test(withdrawn('ADMINISTRATOR')),
      'the administrator was locked out of their own application'
    );
    T.check(
      'a session that predates the permission keeps the report — absent is not a denial',
      /Out-of-pocket shortfall/i.test(
        renderToStaticMarkup(
          React.createElement(ShortfallScreen, {
            units: db.units,
            tenancies: db.tenancies,
            bookings: db.bookings,
            payments: db.payments,
            session: { ...sessionAs('JUNIOR_OFFICER'), permissions: {} }
          })
        )
      ),
      'an upgrade would take the report away from the team'
    );

    /* --- the switch: closed until it is asked for --- */

    const closed = textOf(screenFor('MANAGER'));
    T.check('the report is shut when the screen opens', /Closed by default/i.test(closed), closed.slice(0, 200));
    T.check(
      'and no figure is on the page until it is switched on',
      !/Funded by VDS/i.test(closed) && !/villa-month/i.test(closed),
      'the shortfall figures render while the switch is off'
    );
    T.check(
      'the switch says which state it is in',
      /Show report/i.test(closed) && /role="switch"/.test(screenFor('MANAGER')),
      'no switch found'
    );

    /* --- the permission itself --- */

    const rolePerms = (await c.get('/api/db')).body.settings.rolePermissions;
    T.check(
      'every role is granted it by default',
      ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'].every(r => rolePerms[r].viewShortfall === true),
      JSON.stringify(Object.fromEntries(['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'].map(r => [r, rolePerms[r].viewShortfall])))
    );
    const saved = await c.post('/api/settings', {
      rolePermissions: { JUNIOR_OFFICER: { ...rolePerms.JUNIOR_OFFICER, viewShortfall: false } }
    });
    T.check(
      'and it can be withdrawn in System Settings and stored',
      saved.status === 200 && (await c.get('/api/db')).body.settings.rolePermissions.JUNIOR_OFFICER.viewShortfall === false,
      String(saved.body?.error || saved.status)
    );
    await c.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: rolePerms.JUNIOR_OFFICER } });
    T.check(
      'and granted again',
      (await c.get('/api/db')).body.settings.rolePermissions.JUNIOR_OFFICER.viewShortfall === true,
      'the permission could not be restored'
    );

    /*
     * The engine has exactly one caller, and it is this screen. An owner
     * statement, a board pack, an annual report or an operating statement that
     * ever imported it would put VDS's trading position in front of the people
     * it must never reach — so the wiring itself is asserted, not just the
     * output of the documents.
     */
    const sourceFiles = fs
      .readdirSync(path.join(projectRoot, 'src', 'components'))
      .filter(f => f.endsWith('.tsx') && f !== 'ShortfallReport.tsx' && f !== 'Reports.tsx');
    const importers = sourceFiles.filter(f => {
      const text = fs.readFileSync(path.join(projectRoot, 'src', 'components', f), 'utf8');
      return /outOfPocketShortfall|ShortfallDocument|from '\.\/ShortfallReport'/.test(text);
    });
    T.check(
      'no other screen or document in the application touches the shortfall engine',
      importers.length === 0,
      importers.join(', ')
    );

    /*
     * The identifiers, not the English. "Own account" appears in the owner
     * statement's own comments in an unrelated and older sense — proprietors let
     * their villas on their own account — so matching the phrase would fail on
     * prose that has nothing to do with this report. What must never appear in
     * these files is the flag or the engine.
     */
    const ownerFacing = ['OwnerStatements.tsx', 'BoardPack.tsx', 'AnnualReport.tsx', 'OperatingStatement.tsx', 'OperationsStatement.tsx'];
    const leaked = ownerFacing.filter(f => {
      const text = fs.readFileSync(path.join(projectRoot, 'src', 'components', f), 'utf8');
      return /letOnOwnAccount|outOfPocketShortfall|Shortfall(Report|Document)/.test(text);
    });
    T.check(
      'and no owner- or council-facing document reads the own-account flag or the engine',
      leaked.length === 0,
      leaked.join(', ')
    );

    /*
     * Belt and braces on the screen an owner's statement is produced from:
     * rendered from the same live data and searched for this report's language.
     * A figure only reaches an owner through something rendered, so the render
     * is asked directly rather than the data behind it.
     *
     * Note deliberately what is *not* asserted: `OwnerStatement` embeds the whole
     * unit record, so `letOnOwnAccount` travels inside the object exactly as the
     * owner's email, the meter number and the internal notes always have. None of
     * it is printed. Asserting on the JSON would fail on a field nobody can see
     * and would say nothing about what an owner reads.
     */
    const ownerHtml = renderToStaticMarkup(
      React.createElement(OwnerStatements, {
        units: db.units,
        charges: db.charges,
        payments: db.payments,
        expenses: db.expenses || [],
        utilities: db.utilities || [],
        settings: (await c.get('/api/db')).body.settings,
        session: sessionAs('ADMINISTRATOR')
      })
    );
    T.check(
      'the owner statement screen says nothing about the shortfall, even to an administrator',
      !/out-of-pocket|funded by vds|own account/i.test(textOf(ownerHtml)),
      'the owner statement mentions the shortfall'
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
