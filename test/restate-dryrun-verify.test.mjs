/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two one-time restate passes, verified end to end against the contract in
 * the decision record "Correct legacy data in two ordered passes" (2026-11-12):
 *
 *   - a call without `confirm: true` changes nothing and lists what it would do;
 *   - `confirm: true` applies exactly that list, and money is conserved;
 *   - a second run touches nothing;
 *   - what it cannot recognise is skipped, with a reason;
 *   - hostile `confirm` values never apply;
 *   - the screen's own client-side sets (src/lib/finance.ts run on /api/db, which
 *     is what FinanceHub does) agree with the server's dry run record for record.
 *
 * Legacy data cannot be made through the API (a posted month always carries the
 * split), so, as restate-rent and restate-receipts already do, the file is
 * rewritten between two server runs to look the way the previous release left it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Restate passes: dry run, apply, idempotence, hostile input, screen versus server';

const cents = n => Math.round((Number(n) || 0) * 100);
const sum = (rows, f = x => x.amount) => rows.reduce((a, x) => a + cents(f(x)), 0);
const snap = db => JSON.stringify({ c: db.charges, p: db.payments });

async function bundleFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fin-rv-'));
  const out = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
  return { href: pathToFileURL(out).href, dir };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rv-'));
  const fin = await bundleFinance(projectRoot);
  let srv = await startServer({ port, adminPassword: 'Verify-1234!', projectRoot, dataDir });
  try {
    const finLib = await import(fin.href);
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Verify-1234!', 'VerifyNew-9876!');

    /* ---------------- staff of the other roles ---------------- */
    const staff = {};
    for (const [username, role] of [['mgr', 'MANAGER'], ['fin', 'FINANCE_OFFICER'], ['jr', 'JUNIOR_OFFICER']]) {
      const pw = `Staff-${username}-1234!`;
      await c.post('/api/users', { name: username, username, role, password: pw });
      const cl = makeClient(srv.baseUrl);
      await cl.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
      await cl.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
      staff[role] = cl;
    }

    /* ---------------- the portfolio ---------------- */
    const mk = (id, over) => makeLongTermUnit(c, id, { monthlyRent: 100000, monthlyMaintenance: 20000, tenantName: `T-${id}`, ...over });
    await mk('unit-1'); // ordinary: receipts of several kinds
    await mk('unit-2'); // a 15,000 maintenance receipt: not whole months
    await mk('unit-3'); // a booking-linked maintenance receipt
    await mk('unit-4', { monthlyRent: 1125, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD' }); // USD
    await mk('unit-5', { monthlyRent: 90000 }); // charges at a figure that is neither old nor agreed rent
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });

    // The previous release: whole-rent charges at the old net rent, no split.
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    let raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const ch of raw.charges) {
      if (ch.category === 'Rent' && ch.kind !== 'one-off') {
        const u = raw.units.find(x => x.id === ch.unitId);
        ch.amount = u.id === 'unit-5' ? 65000 : u.monthlyRent - u.monthlyMaintenance;
        delete ch.rentPortion;
        delete ch.maintenancePortion;
      }
    }
    for (const t of raw.tenancies || []) if (t.status === 'active') t.startedOn = '2026-09-01';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'VerifyNew-9876!' }, { captureCookie: true });
    for (const role of Object.keys(staff)) {
      const un = { MANAGER: 'mgr', FINANCE_OFFICER: 'fin', JUNIOR_OFFICER: 'jr' }[role];
      const cl = makeClient(srv.baseUrl);
      await cl.post('/api/auth/login', { username: un, password: `Staff-${un}-1234!x` }, { captureCookie: true });
      staff[role] = cl;
    }

    /* ---------------- hand-keyed receipts, the old way ---------------- */
    const pay = (unitId, category, amount, date, payerName, currency = 'JMD') =>
      recordAndConfirmPayment(c, { unitId, category, amount, currency, payerName, method: 'Cash', date });
    // unit-1: rent 80,000 + a separate 20,000 maintenance each month.
    await pay('unit-1', 'Rent', 80000, '2026-09-07', 'T-unit-1');
    const m1 = (await pay('unit-1', 'Maintenance', 20000, '2026-09-07', 'Owner One')).body.payment; // keyed against the owner
    await pay('unit-1', 'Rent', 80000, '2026-10-07', 'T-unit-1');
    await pay('unit-1', 'Maintenance', 20000, '2026-10-07', 'T-unit-1');
    await pay('unit-1', 'Rent', 80000, '2026-11-05', 'T-unit-1');
    // 2026-11-16: only UNSPENT credit can be refunded, so this receipt overpays by the 5,000 handed back below.
    const mRefPaid = await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Maintenance', amount: 25000, currency: 'JMD', payerName: 'T-unit-1', method: 'Cash', date: '2026-11-05', advancePayment: true });
    const mRef = mRefPaid.body.payment; // refunded below
    const refund = await c.post(`/api/payments/${mRef.id}/refund`, { amount: 5000, reason: 'part refund', method: 'Cash', refundedOn: '2026-11-06' });
    T.check('setup: a part refund on a maintenance receipt was accepted', refund.status === 200, `status ${refund.status}`);
    // unit-2: one 15,000 receipt (not whole months of 20,000).
    await pay('unit-2', 'Maintenance', 15000, '2026-10-07', 'T-unit-2');
    // unit-3: a normal one that will be tagged as booking-linked in the file.
    const mBook = (await pay('unit-3', 'Maintenance', 20000, '2026-10-07', 'T-unit-3')).body.payment;
    // unit-4 (USD): rent 1,000 + 125 maintenance.
    await pay('unit-4', 'Rent', 1000, '2026-09-07', 'T-unit-4', 'USD');
    await pay('unit-4', 'Maintenance', 125, '2026-09-07', 'T-unit-4', 'USD');
    // unit-5: a normal-looking receipt on a villa whose charges are at another figure.
    await pay('unit-5', 'Maintenance', 20000, '2026-10-07', 'T-unit-5');

    // Tag one receipt as generated from a reservation, as a booking deposit would be.
    await srv.stop();
    raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.payments.find(p => p.id === mBook.id).bookingId = 'booking-legacy-1';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'VerifyNew-9876!' }, { captureCookie: true });
    for (const [role, un] of [['MANAGER', 'mgr'], ['FINANCE_OFFICER', 'fin'], ['JUNIOR_OFFICER', 'jr']]) {
      const cl = makeClient(srv.baseUrl);
      await cl.post('/api/auth/login', { username: un, password: `Staff-${un}-1234!x` }, { captureCookie: true });
      staff[role] = cl;
    }

    const getDb = async () => (await c.get('/api/db')).body;
    let db = await getDb();
    const before = snap(db);
    const paidByCurrency = d => ({
      JMD: sum(d.payments.filter(p => p.status === 'completed' && p.currency === 'JMD')),
      USD: sum(d.payments.filter(p => p.status === 'completed' && p.currency === 'USD'))
    });
    const openRent = (d, cur) => sum(d.charges.filter(x => x.category === 'Rent' && x.status === 'open' && x.currency === cur));
    const paid0 = paidByCurrency(db);

    /* ================= ORDER: the receipt pass before the rent pass ================= */
    const early = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    db = await getDb();
    T.check('order: before the rent pass the receipt pass is refused (409) and moves nothing', early.status === 409 && snap(db) === before, JSON.stringify(early.body).slice(0, 160));
    T.check('order: ...and says why', /restating first/i.test(early.body?.error || ''), String(early.body?.error).slice(0, 120));
    const earlyDry = await c.post('/api/payments/restate-maintenance-receipts', {});
    T.check('order: the dry run still lists, and reports how many rent charges are awaiting', earlyDry.status === 200 && earlyDry.body.rentChargesAwaiting > 0, JSON.stringify(earlyDry.body).slice(0, 120));

    /* ================= RENT PASS: dry run ================= */
    const rentDry = await c.post('/api/charges/restate-rent', {});
    db = await getDb();
    T.check('rent dry run: nothing changed (charges and payments identical)', snap(db) === before);
    T.check('rent dry run: confirmed is false and nothing is reported as restated', rentDry.body.confirmed === false && rentDry.body.restated === 0);
    T.check('rent dry run: lists every old charge (4 let villas x 3 months = 12)', rentDry.body.plan.length === 12 && rentDry.body.count === 12, `plan ${rentDry.body.plan.length}`);
    T.check('rent dry run: unit-5 (billed at another figure) is skipped, with a reason', rentDry.body.skipped.length === 3 && rentDry.body.skipped.every(s => s.unit === '5' && s.reason.length > 10), JSON.stringify(rentDry.body.skipped).slice(0, 140));
    T.check('rent dry run: every planned line carries its currency, USD for the USD villa (the dialog prints money with it)', rentDry.body.plan.every(p => p.currency === 'JMD' || p.currency === 'USD') && rentDry.body.plan.some(p => p.currency === 'USD') && rentDry.body.plan.some(p => p.currency === 'JMD'));
    T.check('rent dry run: each planned line shows from and to', rentDry.body.plan.every(p => p.from > 0 && p.to > p.from));
    T.check('FINDING (rent plan names no payer): the rent dry run lists id, unit, period, from, to only', rentDry.body.plan.every(p => p.payer === undefined && p.payerName === undefined));

    // Screen versus server, rent pass.
    const ui = finLib.rentChargesToRestate(db.units, db.charges);
    const uiIds = new Set(ui.restate.map(r => r.charge.id));
    const srvIds = new Set(rentDry.body.plan.map(p => p.id));
    T.check('screen = server (rent): the same 12 charges', uiIds.size === srvIds.size && [...uiIds].every(id => srvIds.has(id)), `ui ${uiIds.size} server ${srvIds.size}`);
    T.check('screen = server (rent): the same skipped charges', ui.skipped.length === rentDry.body.skipped.length && ui.skipped.every(s => rentDry.body.skipped.some(x => x.id === s.charge.id)));

    /* ================= hostile confirm values never apply ================= */
    const hostile = [{ confirm: 'true' }, { confirm: 1 }, { confirm: 'yes' }, { confirm: [true] }, { confirm: { a: 1 } }, {}, { Confirm: true }, { confirm: null }];
    for (const route of ['/api/charges/restate-rent', '/api/payments/restate-maintenance-receipts']) {
      let applied = 0;
      for (const body of hostile) {
        const r = await c.post(route, body);
        if (r.status >= 500) applied += 100;
        if (r.body?.restated > 0 || r.body?.moved > 0) applied++;
      }
      const arr = await c.call('POST', route, []);
      const nul = await c.call('POST', route, null);
      if ((arr.body?.restated || 0) > 0 || (nul.body?.restated || 0) > 0 || arr.status >= 500 || nul.status >= 500) applied += 100;
      T.check(`hostile confirm values never apply: ${route}`, applied === 0 && snap(await getDb()) === before, `${applied}`);
    }

    /* ================= roles ================= */
    for (const role of ['JUNIOR_OFFICER', 'FINANCE_OFFICER']) {
      const r1 = await staff[role].post('/api/charges/restate-rent', { confirm: true });
      const r2 = await staff[role].post('/api/payments/restate-maintenance-receipts', { confirm: true });
      T.check(`${role} is refused on both passes`, r1.status === 403 && r2.status === 403, `${r1.status}/${r2.status}`);
    }
    const anon = makeClient(srv.baseUrl);
    T.check('anonymous is refused on both passes', (await anon.post('/api/charges/restate-rent', { confirm: true })).status === 401 && (await anon.post('/api/payments/restate-maintenance-receipts', { confirm: true })).status === 401);
    T.check('nothing changed after every refusal', snap(await getDb()) === before);
    const finPerms = (await staff.FINANCE_OFFICER.get('/api/db')).body?.currentUser?.permissions || {};
    T.check(
      'FINDING (screen gate vs server gate): a Finance Officer holds postCharges, which shows the banner, but not modifySettledRecords, which the server demands',
      finPerms.postCharges === true && finPerms.modifySettledRecords === false,
      JSON.stringify({ postCharges: finPerms.postCharges, modifySettledRecords: finPerms.modifySettledRecords })
    );

    /* ================= RENT PASS: confirm ================= */
    const jmdOpenBefore = openRent(db, 'JMD');
    const usdOpenBefore = openRent(db, 'USD');
    const planIds = rentDry.body.plan.map(p => p.id);
    const done = await c.post('/api/charges/restate-rent', { confirm: true });
    const after = await getDb();
    T.check('rent confirm: restated exactly the 12 listed', done.status === 200 && done.body.restated === 12 && done.body.plan.map(p => p.id).sort().join() === planIds.slice().sort().join());
    T.check('rent confirm: each old charge is kept as void, with a reason', planIds.every(id => { const o = after.charges.find(x => x.id === id); return o && o.status === 'void' && /Restated/.test(o.voidReason || ''); }));
    T.check('rent confirm: unit-5 charges and all one-off or maintenance charges untouched', after.charges.filter(x => x.unitId === 'unit-5' && x.category === 'Rent').every(x => x.status === 'open' && x.amount === 65000));
    T.check('rent confirm: payments untouched, total received conserved per currency', JSON.stringify(paidByCurrency(after)) === JSON.stringify(paid0));
    const jmdRise = openRent(after, 'JMD') - jmdOpenBefore;
    T.check('rent confirm: JMD owed rises by exactly 9 x 20,000 (3 villas x 3 months of levy)', jmdRise === 9 * 2000000 / 1, String(jmdRise / 100));
    T.check('rent confirm: USD owed rises by exactly 3 x 125', openRent(after, 'USD') - usdOpenBefore === 3 * 12500, String((openRent(after, 'USD') - usdOpenBefore) / 100));
    T.check('rent confirm: every replacement carries a split that adds up', after.charges.filter(x => x.id.includes('-restated')).every(x => cents(x.rentPortion) + cents(x.maintenancePortion) === cents(x.amount)));

    const again = await c.post('/api/charges/restate-rent', { confirm: true });
    const after2 = await getDb();
    T.check('rent pass again: touches nothing (idempotent)', again.body.restated === 0 && again.body.count === 0 && snap(after2) === snap(after));

    /* ================= RECEIPT PASS: dry run ================= */
    const dryBefore = snap(after2);
    const recDry = await c.post('/api/payments/restate-maintenance-receipts', {});
    const afterDry = await getDb();
    T.check('receipt dry run: nothing changed', snap(afterDry) === dryBefore && recDry.body.confirmed === false && recDry.body.moved === 0);
    const plan = recDry.body.plan;
    T.check('receipt dry run: every planned line carries its currency', plan.length > 0 && plan.every(p => p.currency === 'JMD' || p.currency === 'USD'));
    T.check('receipt dry run: names every receipt it would move, with payer, date, amount', plan.length > 0 && plan.every(p => p.id && p.receiptNo && p.date && p.amount > 0 && typeof p.payer === 'string' && p.payer.length > 0), JSON.stringify(plan).slice(0, 200));
    T.check('receipt dry run: the owner-keyed receipt appears WITH its payer (the one case only Ro can judge)', plan.some(p => p.id === m1.id && p.payer === 'Owner One'));
    T.check('receipt dry run: the part-refunded receipt is skipped, with a reason', recDry.body.skipped.some(s => s.id === mRef.id && /refund/.test(s.reason)));
    T.check('receipt dry run: the booking-linked receipt is skipped, with a reason', recDry.body.skipped.some(s => s.id === mBook.id && /reservation|utility/.test(s.reason)));
    T.check('receipt dry run: the 15,000 receipt is skipped as not whole months', recDry.body.skipped.some(s => s.unit === '2' && /whole number/.test(s.reason)));
    T.check('receipt dry run: every skipped receipt carries a readable reason', recDry.body.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 10));

    // Screen versus server, receipt pass (the client reads /api/db, a hand-written projection).
    const uiR = finLib.maintenanceReceiptsToMove(after2.units, after2.charges, after2.payments, after2.tenancies);
    const uiMove = new Set(uiR.move.map(m => m.payment.id));
    const srvMove = new Set(plan.map(p => p.id));
    const onlyUi = [...uiMove].filter(id => !srvMove.has(id));
    const onlySrv = [...srvMove].filter(id => !uiMove.has(id));
    T.check('screen = server (receipts): the same receipts would move', onlyUi.length === 0 && onlySrv.length === 0, `only screen: ${onlyUi.join(',')} only server: ${onlySrv.join(',')}`);
    T.check('screen = server (receipts): the same skipped receipts', uiR.skipped.length === recDry.body.skipped.length && uiR.skipped.every(s => recDry.body.skipped.some(x => x.id === s.payment.id)), `ui ${uiR.skipped.length} server ${recDry.body.skipped.length}`);
    T.check('/api/db carries bookingId and tenancies, so the screen can tell a reservation receipt apart', after2.payments.find(p => p.id === mBook.id)?.bookingId === 'booking-legacy-1' && Array.isArray(after2.tenancies));

    /* ================= RECEIPT PASS: confirm ================= */
    const movePlanIds = plan.map(p => p.id);
    const maintBeforeCount = after2.payments.filter(p => p.category === 'Maintenance' && p.status === 'completed').length;
    const mv = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    const after3 = await getDb();
    T.check('receipt confirm: moved exactly the listed receipts', mv.status === 200 && mv.body.moved === plan.length && mv.body.plan.map(p => p.id).sort().join() === movePlanIds.slice().sort().join());
    T.check('receipt confirm: each moved receipt keeps number, date, amount; category is Rent; origin recorded outside the printed notes', movePlanIds.every(id => { const b = after2.payments.find(x => x.id === id); const a = after3.payments.find(x => x.id === id); return a && a.category === 'Rent' && a.movedFrom === 'Maintenance' && a.receiptNo === b.receiptNo && a.date === b.date && a.amount === b.amount && a.notes === b.notes; }));
    T.check('receipt confirm: total received conserved per currency', JSON.stringify(paidByCurrency(after3)) === JSON.stringify(paid0));
    T.check('receipt confirm: only the listed receipts changed', after3.payments.filter(p => !movePlanIds.includes(p.id)).every(p => JSON.stringify(p) === JSON.stringify(after2.payments.find(x => x.id === p.id))));
    T.check('receipt confirm: maintenance receipts fell by exactly the number moved', after3.payments.filter(p => p.category === 'Maintenance' && p.status === 'completed').length === maintBeforeCount - plan.length);
    const rentOwedAfter = unitId => sum(after3.charges.filter(x => x.unitId === unitId && x.category === 'Rent' && x.status === 'open')) - sum(after3.payments.filter(p => p.unitId === unitId && p.category === 'Rent' && p.status === 'completed'), p => p.amount - (p.refundedAmount || 0));
    T.check('receipt confirm: no tenant was moved into credit', ['unit-1', 'unit-2', 'unit-3', 'unit-4'].every(id => rentOwedAfter(id) >= 0), ['unit-1', 'unit-2', 'unit-3', 'unit-4'].map(id => `${id}:${rentOwedAfter(id) / 100}`).join(' '));
    const mvAgain = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    T.check('receipt pass again: touches nothing (idempotent)', mvAgain.body.moved === 0 && snap(await getDb()) === snap(after3));
    const integ = (await c.get('/api/integrity')).body;
    T.check('the books report no serious fault after both passes', !(integ.findings || []).some(x => x.severity === 'serious'), JSON.stringify((integ.findings || []).slice(0, 2)));

    /* ================= closed periods (a fresh legacy villa, month closed first) ================= */
    {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rv2-'));
      let s2 = await startServer({ port: port + 1, adminPassword: 'Cp-1234!', projectRoot, dataDir: dir2 });
      try {
        let k = makeClient(s2.baseUrl);
        await activateAdmin(k, 'Cp-1234!', 'CpNew-9876!');
        await makeLongTermUnit(k, 'unit-1', { monthlyRent: 100000, monthlyMaintenance: 20000 });
        for (const m of ['2026-09', '2026-10', '2026-11']) await k.post('/api/charges/post-month', { monthString: m });
        await s2.stop();
        const f = path.join(dir2, 'db.json');
        const r2 = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const ch of r2.charges) if (ch.category === 'Rent' && ch.kind !== 'one-off') { ch.amount = 80000; delete ch.rentPortion; delete ch.maintenancePortion; }
        for (const t of r2.tenancies || []) if (t.status === 'active') t.startedOn = '2026-09-01';
        fs.writeFileSync(f, JSON.stringify(r2));
        s2 = await startServer({ port: port + 1, adminPassword: 'x', projectRoot, dataDir: dir2 });
        k = makeClient(s2.baseUrl);
        await k.post('/api/auth/login', { username: 'admin', password: 'CpNew-9876!' }, { captureCookie: true });
        await k.post('/api/periods/close', { through: '2026-10' });
        const pre = snap((await k.get('/api/db')).body);
        const dry2 = await k.post('/api/charges/restate-rent', {});
        T.check('closed month: the dry run lists all 3 charges AND names the 2 in closed months (Sept, Oct) as blocked; the open November one is not', dry2.status === 200 && dry2.body.count === 3 && dry2.body.blockedByClosedMonth.length === 2 && dry2.body.blockedByClosedMonth.every(id => dry2.body.plan.some(x => x.id === id)) && /^\d{4}-\d{2}$/.test(dry2.body.closedThrough || ''), JSON.stringify(dry2.body).slice(0, 140));
        const real = await k.post('/api/charges/restate-rent', { confirm: true });
        const post = snap((await k.get('/api/db')).body);
        T.check('closed month: confirm is refused with 409 and NOTHING is saved (not even November)', real.status === 409 && post === pre, `status ${real.status}`);
        T.check('closed month: the refusal says a closed month no longer matches (the user is told why)', /closed/i.test(real.body?.error || ''), String(real.body?.error).slice(0, 120));
        const mv2 = await k.post('/api/payments/restate-maintenance-receipts', { confirm: true });
        T.check('closed month: the receipt pass is refused while rent charges still await, and changes nothing', mv2.status === 409 && snap((await k.get('/api/db')).body) === pre, `status ${mv2.status}`);
      } finally {
        await s2.stop();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    }

    return T.done();
  } finally {
    await srv.stop();
    fs.rmSync(fin.dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
