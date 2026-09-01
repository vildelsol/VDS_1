/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mistakes, and putting them right.
 *
 * Every other suite here drives the application the way it is meant to go. This
 * one drives it the way an office actually does: a name typed wrong and corrected
 * a minute later, a rent figure keyed with a digit missing, a tenant entered
 * against the wrong villa, a charge raised that should never have existed.
 *
 * It exists because of a real failure. Migrating the property's records out of
 * Excel, a long-standing tenant was entered with their true move-in date and the
 * application billed them first and last month's rent — two months of debt, dated
 * years before the books even begin. Correcting the mistyped name then made it
 * worse: the correction closes one tenancy and opens another, so a *second*
 * advance was raised beside the first, one of them in the name of a tenant who
 * never existed. Every one of the 1,087 checks that existed passed throughout,
 * because each feature was doing exactly what it had been built to do. Nothing had
 * ever asked what happens when the two meet.
 *
 * The rule these checks are written to: **a correction must leave the books as
 * though the mistake had not been made.** Not "close enough" — no orphaned charge,
 * no invented date, no debt that nobody owes.
 *
 * A note on the dates below. A move-in date cannot be in the future, so a books-
 * begin date in the future would make *every* enterable date fall outside the
 * books and half of these checks vacuous — they would pass without ever exercising
 * the billing path. The books-begin dates here are therefore deliberately in the
 * past relative to the suite's run date, so that both sides of the rule are
 * genuinely reached. `PRE` is before the books, `IN` is inside them.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Mistakes and corrections';

const RENT = 80000;
const MAINT = 25000;

/** Books-begin used for most of the suite. In the past, so both sides are reachable. */
const BOOKS = '2026-07-01';
/** A move-in wholly before the books. */
const PRE = '2026-06-30';
/** A move-in inside the books, and in the past so it is accepted. */
const IN = '2026-07-01';
const IN_LATER = '2026-07-15';

/**
 * The month the clock is actually in.
 *
 * A move-out spends the advance on `monthOf(endedOn)`, and `endedOn` is today —
 * so the month the final charge falls in is whatever month the test is run in,
 * not a month written down when the test was authored. This was literally
 * '2026-08' and passed every day of August 2026 and failed on 1 September, when
 * the advance correctly landed on September and the August charge stayed open.
 * The application was right and the test was reading a stopped clock.
 */
const currentMonthString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const villa = (over = {}) => ({
  number: '1',
  ownerName: 'A Proprietor',
  status: 'long-term',
  monthlyRent: RENT,
  monthlyMaintenance: MAINT,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

const openRent = (db, unitId) => db.charges.filter(c => c.unitId === unitId && c.category === 'Rent' && c.status === 'open');
const advances = (db, unitId) => openRent(db, unitId).filter(c => c.kind === 'advance-final-month');
const total = (db, unitId) => openRent(db, unitId).reduce((a, x) => a + x.amount, 0);
const activeTenancy = (db, unitId) => db.tenancies.find(t => t.unitId === unitId && t.status === 'active');
const allTenancies = (db, unitId) => db.tenancies.filter(t => t.unitId === unitId);

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'CorrTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'CorrTest-1234!', 'CorrNew-9876!');

    /* ================================================================
     * 1. The migration case that started all this — a tenant of years,
     *    entered with their real move-in date.
     * ================================================================ */

    await c.post('/api/settings', { booksBeginOn: BOOKS });
    let db = (await c.get('/api/db')).body;
    T.check('the books can be told when they begin', db.settings.booksBeginOn === BOOKS, String(db.settings.booksBeginOn));

    await c.put('/api/units/unit-1', villa({ tenantName: 'Long Standing', tenantMovedInOn: '2024-03-15' }));
    db = (await c.get('/api/db')).body;
    T.check('a tenant who moved in years before the books begin is not billed', openRent(db, 'unit-1').length === 0, `${openRent(db, 'unit-1').length} charges raised`);
    T.check('their real move-in date is still recorded', activeTenancy(db, 'unit-1')?.startedOn === '2024-03-15', String(activeTenancy(db, 'unit-1')?.startedOn));
    T.check('and no advance is held against them', advances(db, 'unit-1').length === 0);
    T.check('so the villa owes nothing on the rent account', total(db, 'unit-1') === 0);

    // A bare rename is refused: the server will not guess which act this is.
    const bare = await c.put('/api/units/unit-1', villa({ tenantName: 'Long Standing Corrected', tenantMovedInOn: '2024-03-15' }));
    T.check('changing a tenant name without saying why is refused', bare.status === 400, `status ${bare.status}`);
    T.check('and the refusal carries a code the screen can act on', bare.body?.code === 'tenant-change-intent-required', String(bare.body?.code));
    T.check('the refusal names the tenant already on record', String(bare.body?.error || '').includes('Long Standing'));
    db = (await c.get('/api/db')).body;
    T.check('nothing is changed by a refused rename', activeTenancy(db, 'unit-1')?.tenantName === 'Long Standing');

    await c.put('/api/units/unit-1', villa({ tenantName: 'Long Standing Corrected', tenantMovedInOn: '2024-03-15', tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('correcting the mistyped name still raises nothing', openRent(db, 'unit-1').length === 0, `${openRent(db, 'unit-1').length} charges`);
    T.check('and does not invent an advance', advances(db, 'unit-1').length === 0);
    T.check('the corrected name is the one on the active tenancy', activeTenancy(db, 'unit-1')?.tenantName === 'Long Standing Corrected');
    T.check('a correction renames in place — no phantom tenancy is created', allTenancies(db, 'unit-1').length === 1, `${allTenancies(db, 'unit-1').length} tenancies`);
    T.check('and nothing is closed, because nobody moved out', allTenancies(db, 'unit-1').filter(t => t.status === 'ended').length === 0);
    T.check('the real move-in date survives the correction', activeTenancy(db, 'unit-1')?.startedOn === '2024-03-15');

    /* ================================================================
     * 2. A tenant genuinely starting inside the books must still be
     *    billed — the guard must not swallow real business.
     * ================================================================ */

    await c.put('/api/units/unit-2', villa({ number: '2', tenantName: 'Genuinely New', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    let rent = openRent(db, 'unit-2');
    T.check('a tenant moving in inside the books IS billed first and last', rent.length === 2, `${rent.length} charges`);
    T.check('which is two months of rent', rent.reduce((a, x) => a + x.amount, 0) === RENT * 2);
    T.check('exactly one of which is the advance', advances(db, 'unit-2').length === 1);
    T.check('and both are dated to the month they moved in', rent.every(x => x.periodMonth === IN.slice(0, 7)));

    await c.put('/api/units/unit-3', villa({ number: '3', tenantName: 'Opening Day', tenantMovedInOn: BOOKS }));
    db = (await c.get('/api/db')).body;
    T.check('a move-in on the opening day itself is billed', openRent(db, 'unit-3').length === 2, `${openRent(db, 'unit-3').length} charges`);

    await c.put('/api/units/unit-4', villa({ number: '4', tenantName: 'Mid Opening Month', tenantMovedInOn: IN_LATER }));
    db = (await c.get('/api/db')).body;
    T.check('a move-in later in the opening month is billed', openRent(db, 'unit-4').length === 2, `${openRent(db, 'unit-4').length} charges`);
    T.check('and says on its own face that it is not prorated', openRent(db, 'unit-4').some(x => (x.description || '').includes('not prorated')));

    await c.put('/api/units/unit-5', villa({ number: '5', tenantName: 'Day Before', tenantMovedInOn: PRE }));
    db = (await c.get('/api/db')).body;
    T.check('a move-in the day before the books open is not billed', openRent(db, 'unit-5').length === 0, `${openRent(db, 'unit-5').length} charges`);
    T.check('the boundary is the month, and the month before is outside it', activeTenancy(db, 'unit-5')?.startedOn === PRE);

    /* ================================================================
     * 3. Correcting a name on a tenancy that WAS billed. The advance
     *    must be carried over, never raised a second time.
     * ================================================================ */

    await c.put('/api/units/unit-6', villa({ number: '6', tenantName: 'Typo Nmae', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('the mistyped tenant is billed first and last', openRent(db, 'unit-6').length === 2, `${openRent(db, 'unit-6').length}`);
    const advanceIdBefore = advances(db, 'unit-6')[0]?.id;
    T.check('an advance id is recorded before the correction', !!advanceIdBefore);

    await c.put('/api/units/unit-6', villa({ number: '6', tenantName: 'Typo Name', tenantMovedInOn: IN, tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    rent = openRent(db, 'unit-6');
    T.check('correcting the name does NOT raise a second set of charges', rent.length === 2, `${rent.length} charges after correction`);
    T.check('there is still exactly one advance', advances(db, 'unit-6').length === 1, `${advances(db, 'unit-6').length} advances`);
    T.check('it is the same charge, untouched', advances(db, 'unit-6')[0]?.id === advanceIdBefore);
    T.check('the villa is not billed twice over', total(db, 'unit-6') === RENT * 2, String(total(db, 'unit-6')));
    T.check('every open charge now names the corrected tenant', rent.every(x => x.payerName === 'Typo Name'), rent.map(x => x.payerName).join(' / '));
    T.check('the tenancy keeps its advance', activeTenancy(db, 'unit-6')?.advanceRentChargeId === advanceIdBefore);
    T.check('the correction is written to the audit trail', db.auditLogs.some(a => /Corrected the tenant/.test(a.action)));

    await c.put('/api/units/unit-6', villa({ number: '6', tenantName: 'Typo Name II', tenantMovedInOn: IN, tenantChangeIntent: 'correction' }));
    await c.put('/api/units/unit-6', villa({ number: '6', tenantName: 'Typo Name III', tenantMovedInOn: IN, tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('three corrections in a row still leave two charges', openRent(db, 'unit-6').length === 2, `${openRent(db, 'unit-6').length}`);
    T.check('and still exactly one advance', advances(db, 'unit-6').length === 1);
    T.check('the ledger total is unchanged by any of it', total(db, 'unit-6') === RENT * 2, String(total(db, 'unit-6')));
    T.check('and there is still just the one tenancy, renamed', allTenancies(db, 'unit-6').length === 1, `${allTenancies(db, 'unit-6').length} tenancies`);
    T.check('with the latest correction on it', activeTenancy(db, 'unit-6')?.tenantName === 'Typo Name III');
    T.check('every open charge follows the latest correction', openRent(db, 'unit-6').every(x => x.payerName === 'Typo Name III'));

    /* ================================================================
     * 4. A tenant entered with no move-in date — the register being
     *    filled in. Nothing may be invented.
     * ================================================================ */

    await c.put('/api/units/unit-7', villa({ number: '7', tenantName: 'No Date' }));
    db = (await c.get('/api/db')).body;
    T.check('a tenant with no move-in date is billed nothing', openRent(db, 'unit-7').length === 0, `${openRent(db, 'unit-7').length}`);
    T.check('and no move-in date is invented for them', activeTenancy(db, 'unit-7')?.startedOn === '', JSON.stringify(activeTenancy(db, 'unit-7')?.startedOn));

    /*
     * A known gap, pinned here so it cannot change unnoticed.
     *
     * Correcting the name is indistinguishable from a genuine changeover, so the
     * new tenancy is stamped with today's date. Deriving the answer from the
     * outgoing tenancy was tried and reverted — a real handover very often follows
     * a tenant who had no move-in date either, and suppressing the stamp killed the
     * advance on every genuine changeover in the scenario suite.
     *
     * What stops that stamp becoming money is `booksBeginOn`: the checks below are
     * the two halves of the rule. Inside the books, a correction does bill and has
     * to be voided. Outside them, it bills nothing. During the migration — books
     * opening ahead of today — every correction falls outside, which is what makes
     * data entry safe.
     */
    await c.put('/api/units/unit-7', villa({ number: '7', tenantName: 'No Date Corrected', tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('the corrected name is on the active tenancy', activeTenancy(db, 'unit-7')?.tenantName === 'No Date Corrected');
    T.check('a correction does not stamp a move-in date that was never known', activeTenancy(db, 'unit-7')?.startedOn === '', JSON.stringify(activeTenancy(db, 'unit-7')?.startedOn));
    T.check('and bills nothing at all', openRent(db, 'unit-7').length === 0, `${openRent(db, 'unit-7').length} charges`);
    T.check('with no phantom tenancy left behind', allTenancies(db, 'unit-7').length === 1, `${allTenancies(db, 'unit-7').length}`);

    let ten7 = activeTenancy(db, 'unit-7');
    await c.put(`/api/tenancies/${ten7.id}`, { startedOn: '2023-06-01' });
    db = (await c.get('/api/db')).body;
    T.check('the real move-in date can be set afterwards', activeTenancy(db, 'unit-7')?.startedOn === '2023-06-01');
    T.check('and being before the books, it still bills nothing', openRent(db, 'unit-7').length === 0, `${openRent(db, 'unit-7').length} charges`);

    /* ================================================================
     * 5. The same, but the date supplied later falls inside the books.
     * ================================================================ */

    await c.put('/api/units/unit-8', villa({ number: '8', tenantName: 'Date Later' }));
    db = (await c.get('/api/db')).body;
    let ten8 = activeTenancy(db, 'unit-8');
    await c.put(`/api/tenancies/${ten8.id}`, { startedOn: IN });
    db = (await c.get('/api/db')).body;
    T.check('adding an in-books move-in date later DOES bill first and last', openRent(db, 'unit-8').length === 2, `${openRent(db, 'unit-8').length}`);
    T.check('with one advance', advances(db, 'unit-8').length === 1);

    await c.put(`/api/tenancies/${ten8.id}`, { startedOn: IN_LATER });
    db = (await c.get('/api/db')).body;
    T.check('correcting that date afterwards does not raise a second set', openRent(db, 'unit-8').length === 2, `${openRent(db, 'unit-8').length} charges`);
    T.check('and still exactly one advance', advances(db, 'unit-8').length === 1);
    T.check('the corrected date is stored on the tenancy', activeTenancy(db, 'unit-8')?.startedOn === IN_LATER);

    /* ================================================================
     * 6. A charge raised in error is voided — the correction path.
     * ================================================================ */

    await c.put('/api/units/unit-9', villa({ number: '9', tenantName: 'Void Me', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    const toVoid = openRent(db, 'unit-9');
    T.check('two charges exist to correct', toVoid.length === 2, `${toVoid.length}`);

    const voidRes = await c.post(`/api/charges/${toVoid[0].id}/void`, { reason: 'Raised in error during migration.' });
    T.check('a charge raised in error can be voided', voidRes.status === 200, `status ${voidRes.status}`);
    db = (await c.get('/api/db')).body;
    T.check('voiding removes it from what is owed', openRent(db, 'unit-9').length === 1, `${openRent(db, 'unit-9').length} still open`);
    const voided = db.charges.find(x => x.id === toVoid[0].id);
    T.check('the voided charge is kept, not deleted', !!voided);
    T.check('marked void', voided?.status === 'void', String(voided?.status));
    T.check('carrying the reason it was voided for', (voided?.voidReason || '').includes('error'));
    T.check('and who voided it', !!voided?.voidedBy);
    T.check('voiding is written to the audit trail', db.auditLogs.some(a => a.recordId === toVoid[0].id));

    const shortReason = await c.post(`/api/charges/${toVoid[1].id}/void`, { reason: 'no' });
    T.check('a void without a real reason is refused', shortReason.status >= 400, `status ${shortReason.status}`);
    db = (await c.get('/api/db')).body;
    T.check('and nothing is voided when it is refused', openRent(db, 'unit-9').length === 1, `${openRent(db, 'unit-9').length}`);

    const missing = await c.post('/api/charges/chg-does-not-exist/void', { reason: 'Raised in error entirely.' });
    T.check('voiding a charge that does not exist is refused', missing.status >= 400, `status ${missing.status}`);

    /* ================================================================
     * 7. A rent figure keyed wrong, then corrected.
     * ================================================================ */

    await c.put('/api/units/unit-10', villa({ number: '10', tenantName: 'Wrong Rent', monthlyRent: 8000, tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('the villa is billed at the figure keyed, wrong though it is', openRent(db, 'unit-10').every(x => x.amount === 8000));

    await c.put('/api/units/unit-10', villa({ number: '10', tenantName: 'Wrong Rent', monthlyRent: 80000, tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('correcting the rent does not raise more charges', openRent(db, 'unit-10').length === 2, `${openRent(db, 'unit-10').length}`);
    T.check('charges already raised keep the figure they were raised at', openRent(db, 'unit-10').every(x => x.amount === 8000), 'a raised charge is a record; it is corrected by voiding it');
    T.check('the villa now carries the corrected rent for future months', db.units.find(u => u.id === 'unit-10')?.monthlyRent === 80000);

    const badRent = await c.put('/api/units/unit-10', villa({ number: '10', tenantName: 'Wrong Rent', monthlyRent: '1.500.000', tenantMovedInOn: IN }));
    T.check('a rent figure that is not a number is refused, not reshaped', badRent.status >= 400, `status ${badRent.status}`);
    db = (await c.get('/api/db')).body;
    T.check('and the villa keeps the last good figure', db.units.find(u => u.id === 'unit-10')?.monthlyRent === 80000, String(db.units.find(u => u.id === 'unit-10')?.monthlyRent));

    /* ================================================================
     * 8. A tenant entered against the wrong villa, then moved.
     * ================================================================ */

    await c.put('/api/units/unit-11', villa({ number: '11', tenantName: 'Wrong Villa', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('the tenant is on the wrong villa', activeTenancy(db, 'unit-11')?.tenantName === 'Wrong Villa');
    const wrongVillaCharges = openRent(db, 'unit-11').map(x => x.id);
    T.check('and has been billed there', wrongVillaCharges.length === 2, `${wrongVillaCharges.length}`);

    // Taking them off the wrong villa is a correction, not a departure — so the
    // rent raised there is voided rather than a move-out being recorded.
    await c.put('/api/units/unit-11', villa({ number: '11', status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'correction' }));
    await c.put('/api/units/unit-12', villa({ number: '12', tenantName: 'Wrong Villa', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('the right villa now carries the tenant', activeTenancy(db, 'unit-12')?.tenantName === 'Wrong Villa');
    T.check('and is billed there', openRent(db, 'unit-12').length === 2, `${openRent(db, 'unit-12').length}`);
    T.check('the wrong villa has no active tenancy left', !activeTenancy(db, 'unit-11'));
    T.check('its tenancy record is kept, closed', allTenancies(db, 'unit-11').filter(t => t.status === 'ended').length >= 1);
    T.check('the wrong villa owes nothing', openRent(db, 'unit-11').length === 0, `${openRent(db, 'unit-11').length}`);
    T.check(
      'the charges wrongly raised on it are voided, not deleted',
      wrongVillaCharges.every(id => db.charges.find(x => x.id === id)?.status === 'void'),
      'a charge is a record; removing it silently would hide the mistake'
    );
    T.check('and the right villa is unaffected', openRent(db, 'unit-12').length === 2);
    T.check('the whole mistake is reconstructable from the audit trail', wrongVillaCharges.every(id => db.auditLogs.some(a => a.recordId === id) || db.auditLogs.some(a => /taken back/i.test(a.action))));

    /* ================================================================
     * 9. The books-begin date itself corrected after data is in.
     * ================================================================ */

    await c.post('/api/settings', { booksBeginOn: '2026-08-01' });
    db = (await c.get('/api/db')).body;
    T.check('the books-begin date can be corrected', db.settings.booksBeginOn === '2026-08-01');
    T.check('charges already raised are not retrospectively removed', openRent(db, 'unit-12').length === 2, 'raised charges are records, not derived values');

    await c.put('/api/units/unit-13', villa({ number: '13', tenantName: 'After Correction', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('a move-in now falling before the corrected date is not billed', openRent(db, 'unit-13').length === 0, `${openRent(db, 'unit-13').length}`);

    await c.post('/api/settings', { booksBeginOn: '' });
    db = (await c.get('/api/db')).body;
    T.check('the books-begin date can be cleared entirely', !db.settings.booksBeginOn, String(db.settings.booksBeginOn));
    await c.put('/api/units/unit-14', villa({ number: '14', tenantName: 'No Books Limit', tenantMovedInOn: '2020-01-01' }));
    db = (await c.get('/api/db')).body;
    T.check('with no books-begin date, an old move-in bills as it always did', openRent(db, 'unit-14').length === 2, `${openRent(db, 'unit-14').length}`);
    T.check('so clearing the setting restores the original behaviour exactly', total(db, 'unit-14') === RENT * 2);

    /* ================================================================
     * 10. The point of all of it: a corrected tenancy still spends its
     *     advance exactly once, and is charged the months it occupied.
     * ================================================================ */

    await c.post('/api/settings', { booksBeginOn: BOOKS });
    await c.put('/api/units/unit-15', villa({ number: '15', tenantName: 'Mistyped Leaver', tenantMovedInOn: IN }));
    await c.put('/api/units/unit-15', villa({ number: '15', tenantName: 'Correct Leaver', tenantMovedInOn: IN, tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('after correction the villa holds exactly one advance', advances(db, 'unit-15').length === 1);

    await c.post('/api/charges/post-month', { monthString: '2026-08' });
    db = (await c.get('/api/db')).body;
    const augRent = openRent(db, 'unit-15').filter(x => x.periodMonth === '2026-08' && x.kind !== 'advance-final-month');
    T.check('the following month is billed once', augRent.length === 1, `${augRent.length}`);

    const ten15 = activeTenancy(db, 'unit-15');
    await c.put(`/api/tenancies/${ten15.id}`, { endedOn: '2026-08-20', endReason: 'Moved out.' });
    db = (await c.get('/api/db')).body;
    const augAfter = db.charges.filter(x => x.unitId === 'unit-15' && x.category === 'Rent' && x.periodMonth === '2026-08' && x.status === 'open' && x.kind !== 'advance-final-month');
    T.check('their final month is not charged again — the advance paid for it', augAfter.length === 0, `${augAfter.length} still open`);
    T.check(
      'so a corrected tenancy is charged exactly the months it occupied',
      total(db, 'unit-15') === RENT * 2,
      `${total(db, 'unit-15')} against expected ${RENT * 2}`
    );
    T.check('and the tenancy is closed with a reason', allTenancies(db, 'unit-15').find(t => t.status === 'ended' && t.endedOn === '2026-08-20')?.endReason?.length > 0);

    /* ================================================================
     * 11. The other half of the choice: a genuine changeover must
     *     still do everything it always did.
     * ================================================================ */

    await c.put('/api/units/unit-9', villa({ number: '9', status: 'vacant', tenantName: '', monthlyRent: 0 }));
    await c.put('/api/units/unit-9', villa({ number: '9', tenantName: 'First Occupant', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    const firstOccupantTenancy = activeTenancy(db, 'unit-9')?.id;
    T.check('a first occupant is recorded', !!firstOccupantTenancy);

    await c.put('/api/units/unit-9', villa({ number: '9', tenantName: 'Second Occupant', tenantChangeIntent: 'changeover' }));
    db = (await c.get('/api/db')).body;
    T.check('a changeover closes the outgoing tenancy', db.tenancies.find(t => t.id === firstOccupantTenancy)?.status === 'ended');
    T.check('and keeps it, never deletes it', !!db.tenancies.find(t => t.id === firstOccupantTenancy));
    T.check('recording why it ended', (db.tenancies.find(t => t.id === firstOccupantTenancy)?.endReason || '').length > 0);
    T.check('a new tenancy is opened for the new tenant', activeTenancy(db, 'unit-9')?.tenantName === 'Second Occupant');
    T.check('and it is a different record from the one that closed', activeTenancy(db, 'unit-9')?.id !== firstOccupantTenancy);
    T.check('dated today, because a changeover genuinely starts now', activeTenancy(db, 'unit-9')?.startedOn !== '');
    T.check('the villa still has exactly one active tenancy', allTenancies(db, 'unit-9').filter(t => t.status === 'active').length === 1);

    // A nonsense answer is refused rather than quietly treated as a changeover.
    const nonsense = await c.put('/api/units/unit-12', villa({ number: '12', tenantName: 'Some Other Name', tenantChangeIntent: 'whatever' }));
    T.check('an intent that is neither of the two answers is refused', nonsense.status >= 400, `status ${nonsense.status}`);
    db = (await c.get('/api/db')).body;
    T.check('and nothing is changed by it', activeTenancy(db, 'unit-12')?.tenantName === 'Wrong Villa', String(activeTenancy(db, 'unit-12')?.tenantName));

    // Naming the same person again is not a change at all, so no answer is needed.
    const unchanged = await c.put('/api/units/unit-12', villa({ number: '12', tenantName: 'Wrong Villa', monthlyRent: 90000 }));
    T.check('re-saving a villa without touching the tenant name needs no answer', unchanged.status === 200, `status ${unchanged.status}`);
    db = (await c.get('/api/db')).body;
    T.check('and the edit lands', db.units.find(u => u.id === 'unit-12')?.monthlyRent === 90000);
    T.check('leaving the tenancy alone', allTenancies(db, 'unit-12').filter(t => t.status === 'active').length === 1);

    /* ================================================================
     * 12. Taking the tenant off the villa — the expensive direction.
     *     A move-out spends the advance; a mis-key must not.
     * ================================================================ */

    await c.put('/api/units/unit-3', villa({ number: '3', status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'correction' }));
    await c.put('/api/units/unit-3', villa({ number: '3', tenantName: 'Keyed By Mistake', tenantMovedInOn: IN }));
    db = (await c.get('/api/db')).body;
    T.check('a tenant is on the villa and billed', openRent(db, 'unit-3').length === 2, `${openRent(db, 'unit-3').length}`);

    const removeBare = await c.put('/api/units/unit-3', villa({ number: '3', status: 'vacant', tenantName: '', monthlyRent: 0 }));
    T.check('taking the tenant off without saying why is refused', removeBare.status === 400, `status ${removeBare.status}`);
    T.check('with the same code the screen already knows', removeBare.body?.code === 'tenant-change-intent-required', String(removeBare.body?.code));
    db = (await c.get('/api/db')).body;
    T.check('and nothing is changed by the refusal', !!activeTenancy(db, 'unit-3'));

    await c.put('/api/units/unit-3', villa({ number: '3', status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('taking a mis-keyed entry back leaves nothing owed', openRent(db, 'unit-3').length === 0, `${openRent(db, 'unit-3').length} still open`);
    T.check(
      'the charges it raised are voided, not deleted',
      db.charges.filter(x => x.unitId === 'unit-3' && x.payerName === 'Keyed By Mistake' && x.status === 'void').length === 2,
      `${db.charges.filter(x => x.unitId === 'unit-3' && x.payerName === 'Keyed By Mistake' && x.status === 'void').length}`
    );
    T.check('each voided charge says it was an error', db.charges.filter(x => x.unitId === 'unit-3' && x.payerName === 'Keyed By Mistake' && x.status === 'void').every(x => /error/i.test(x.voidReason || '')));
    const takenBack = allTenancies(db, 'unit-3').find(t => t.status === 'ended');
    T.check('the tenancy is closed as recorded in error', /recorded in error/i.test(takenBack?.endReason || ''), String(takenBack?.endReason));
    T.check('and it does not register as an occupancy that happened', takenBack?.endedOn === takenBack?.startedOn, `${takenBack?.startedOn} -> ${takenBack?.endedOn}`);
    T.check('the advance was not spent, because there was no final month', !takenBack?.advanceRentChargeId);

    // The genuine direction still works exactly as it did.
    await c.put('/api/units/unit-4', villa({ number: '4', status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'correction' }));
    await c.put('/api/units/unit-4', villa({ number: '4', tenantName: 'Real Leaver', tenantMovedInOn: IN }));
    const finalMonth = currentMonthString();
    await c.post('/api/charges/post-month', { monthString: finalMonth });
    db = (await c.get('/api/db')).body;
    T.check('the leaver is billed for the month they leave in', openRent(db, 'unit-4').some(x => x.periodMonth === finalMonth), finalMonth);

    await c.put('/api/units/unit-4', villa({ number: '4', status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'moved-out' }));
    db = (await c.get('/api/db')).body;
    const leaverFinal = db.charges.filter(x => x.unitId === 'unit-4' && x.category === 'Rent' && x.periodMonth === finalMonth && x.status === 'open' && x.kind !== 'advance-final-month');
    T.check('a genuine move-out spends the advance on the final month', leaverFinal.length === 0, `${leaverFinal.length} still open for ${finalMonth}`);
    T.check('and the tenancy is closed and kept', allTenancies(db, 'unit-4').some(t => t.status === 'ended' && !/error/i.test(t.endReason || '')));

    /* ================================================================
     * 13. The proprietor: a corrected spelling is not a sale.
     * ================================================================ */

    db = (await c.get('/api/db')).body;
    T.check('every villa on the register has an open ownership period', db.units.every(u => !u.ownerName.trim() || db.ownerships.some(o => o.unitId === u.id && o.status === 'active')));
    T.check('and ownerships come back from the server at all', Array.isArray(db.ownerships), 'a collection missing from /api/db saves and then returns empty');

    // A villa with no tenant on it, so the owner question is asked on its own.
    await c.put('/api/units/unit-16', villa({ number: '16', ownerName: 'Alba Ried', status: 'vacant', tenantName: '', monthlyRent: 0 }));
    await c.post('/api/charges/post-month', { monthString: '2026-08' });
    db = (await c.get('/api/db')).body;
    const ownerMaint = db.charges.filter(x => x.unitId === 'unit-16' && x.category === 'Maintenance' && x.status === 'open');
    T.check('the proprietor is billed maintenance', ownerMaint.length > 0, `${ownerMaint.length}`);

    const ownerBare = await c.put('/api/units/unit-16', villa({ number: '16', ownerName: 'Alba Reid', status: 'vacant', tenantName: '', monthlyRent: 0 }));
    T.check('changing an owner name without saying why is refused', ownerBare.status === 400, `status ${ownerBare.status}`);
    T.check('with its own code', ownerBare.body?.code === 'owner-change-intent-required', String(ownerBare.body?.code));
    T.check('naming the proprietor already on record', String(ownerBare.body?.error || '').includes('Alba Ried'));

    await c.put('/api/units/unit-16', villa({ number: '16', ownerName: 'Alba Reid', status: 'vacant', tenantName: '', monthlyRent: 0, ownerChangeIntent: 'correction' }));
    db = (await c.get('/api/db')).body;
    T.check('a corrected owner name keeps one ownership period', db.ownerships.filter(o => o.unitId === 'unit-16').length === 1, `${db.ownerships.filter(o => o.unitId === 'unit-16').length}`);
    T.check('still open', db.ownerships.find(o => o.unitId === 'unit-16')?.status === 'active');
    T.check('carrying the corrected spelling', db.ownerships.find(o => o.unitId === 'unit-16')?.ownerName === 'Alba Reid');
    T.check(
      'and the outstanding contribution follows the corrected name',
      db.charges.filter(x => x.unitId === 'unit-16' && x.category === 'Maintenance' && x.status === 'open').every(x => x.payerName === 'Alba Reid'),
      db.charges.filter(x => x.unitId === 'unit-16' && x.category === 'Maintenance' && x.status === 'open').map(x => x.payerName).join(' / ')
    );

    /* ================================================================
     * 14. A sale leaves the seller's arrears with the seller.
     * ================================================================ */

    const arrearsBefore = db.charges.filter(x => x.unitId === 'unit-16' && x.category === 'Maintenance' && x.status === 'open').map(x => x.id);
    await c.put('/api/units/unit-16', villa({ number: '16', ownerName: 'New Proprietor', status: 'vacant', tenantName: '', monthlyRent: 0, ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-08-15' }));
    db = (await c.get('/api/db')).body;
    const periods = db.ownerships.filter(o => o.unitId === 'unit-16');
    T.check('a sale opens a second ownership period', periods.length === 2, `${periods.length}`);
    T.check('the seller’s period is closed', periods.filter(o => o.status === 'ended').length === 1);
    T.check('on the day the villa changed hands', periods.find(o => o.status === 'ended')?.endedOn === '2026-08-15');
    T.check('saying it was sold, and to whom', /sold to New Proprietor/i.test(periods.find(o => o.status === 'ended')?.endReason || ''));
    T.check('the buyer’s period opens on the same day', periods.find(o => o.status === 'active')?.startedOn === '2026-08-15');
    T.check('with exactly one period open', periods.filter(o => o.status === 'active').length === 1);
    T.check(
      'what the seller already owed stays recorded against the seller',
      arrearsBefore.every(id => db.charges.find(x => x.id === id)?.payerName === 'Alba Reid'),
      arrearsBefore.map(id => db.charges.find(x => x.id === id)?.payerName).join(' / ')
    );
    T.check('the sale is written to the audit trail', db.auditLogs.some(a => /sold to New Proprietor/i.test(a.action)));

    // A sale that is not dated falls back to today rather than being refused.
    await c.put('/api/units/unit-11', villa({ number: '11', ownerName: 'Sold Undated', status: 'vacant', tenantName: '', monthlyRent: 0, ownerChangeIntent: 'sale' }));
    db = (await c.get('/api/db')).body;
    T.check('an undated sale still closes and opens a period', db.ownerships.filter(o => o.unitId === 'unit-11').length === 2, `${db.ownerships.filter(o => o.unitId === 'unit-11').length}`);
    T.check('dated today rather than left blank', !!db.ownerships.find(o => o.unitId === 'unit-11' && o.status === 'active')?.startedOn);

    const badOwnerIntent = await c.put('/api/units/unit-11', villa({ number: '11', ownerName: 'Another Name', status: 'vacant', tenantName: '', monthlyRent: 0, ownerChangeIntent: 'nonsense' }));
    T.check('an owner intent that is neither answer is refused', badOwnerIntent.status >= 400, `status ${badOwnerIntent.status}`);
    const futureSale = await c.put('/api/units/unit-11', villa({ number: '11', ownerName: 'Another Name', status: 'vacant', tenantName: '', monthlyRent: 0, ownerChangeIntent: 'sale', ownerAcquiredOn: '2099-01-01' }));
    T.check('a sale dated in the future is refused', futureSale.status >= 400, `status ${futureSale.status}`);

    /* ================================================================
     * 15. After every one of those mistakes, the records still agree
     *     with themselves.
     * ================================================================ */

    const integrity = await c.get('/api/integrity');
    T.check(
      'the application checking its own records finds nothing seriously wrong',
      integrity.status === 200 && (integrity.body.serious || []).length === 0,
      JSON.stringify(integrity.body?.serious || []).slice(0, 300)
    );

    db = (await c.get('/api/db')).body;
    const receiptNos = db.payments.filter(p => p.receiptNo).map(p => p.receiptNo);
    T.check('no receipt number was issued twice', new Set(receiptNos).size === receiptNos.length);
    T.check('no charge carries a non-finite amount', db.charges.every(x => Number.isFinite(x.amount)));
    T.check('no charge carries a negative amount', db.charges.every(x => x.amount >= 0));
    T.check('every charge belongs to a villa on the register', db.charges.every(x => db.units.some(u => u.id === x.unitId)));
    T.check('every tenancy belongs to a villa on the register', db.tenancies.every(t => db.units.some(u => u.id === t.unitId)));
    T.check(
      'no villa holds two open advances for one month',
      db.units.every(u => {
        const byMonth = {};
        for (const ch of db.charges.filter(x => x.unitId === u.id && x.status === 'open' && x.kind === 'advance-final-month')) {
          byMonth[ch.periodMonth] = (byMonth[ch.periodMonth] || 0) + 1;
        }
        return Object.values(byMonth).every(n => n === 1);
      }),
      'this is the duplicate that a mistyped name used to create'
    );
    T.check(
      'no villa holds two open ordinary rent charges for one month',
      db.units.every(u => {
        const byMonth = {};
        for (const ch of db.charges.filter(x => x.unitId === u.id && x.status === 'open' && x.category === 'Rent' && x.kind === undefined)) {
          byMonth[ch.periodMonth] = (byMonth[ch.periodMonth] || 0) + 1;
        }
        return Object.values(byMonth).every(n => n === 1);
      })
    );
    T.check('every voided charge records why', db.charges.filter(x => x.status === 'void').every(x => (x.voidReason || '').length >= 5));
    T.check('every closed tenancy says why it closed', db.tenancies.filter(t => t.status === 'ended').every(t => (t.endReason || '').length > 0));
    T.check('no villa has two active tenancies at once', db.units.every(u => db.tenancies.filter(t => t.unitId === u.id && t.status === 'active').length <= 1));
    T.check('no tenancy ends before it began', db.tenancies.every(t => !t.endedOn || !t.startedOn || t.endedOn >= t.startedOn));
    T.check('every advance a tenancy points at actually exists', db.tenancies.every(t => !t.advanceRentChargeId || db.charges.some(x => x.id === t.advanceRentChargeId)));
    T.check('no two charges share an id', new Set(db.charges.map(x => x.id)).size === db.charges.length);
    T.check('no villa has two open ownership periods at once', db.units.every(u => db.ownerships.filter(o => o.unitId === u.id && o.status === 'active').length <= 1));
    T.check('every ownership period belongs to a villa on the register', db.ownerships.every(o => db.units.some(u => u.id === o.unitId)));
    T.check('every closed ownership period says why it closed', db.ownerships.filter(o => o.status === 'ended').every(o => (o.endReason || '').length > 0));
    T.check('no ownership period ends before it began', db.ownerships.every(o => !o.endedOn || !o.startedOn || o.endedOn >= o.startedOn));
    T.check('no two ownership periods share an id', new Set(db.ownerships.map(o => o.id)).size === db.ownerships.length);
    T.check('the database still reads back cleanly', (await c.get('/api/db')).status === 200);
  } finally {
    await srv.stop();
  }
  return T.done();
}
